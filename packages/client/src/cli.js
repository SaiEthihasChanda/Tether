// tether: the command-line interface (DESIGN §11). Every command is sent to tetherd over IPC;
// the CLI itself never touches the network or the local database.
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { Command, Option } from 'commander';
import { ipcEndpoint } from './paths.js';
import { call, IpcError } from './ipc.js';
import { spawnDaemon, install, uninstall, installed } from './autostart.js';

const endpoint = () => ipcEndpoint();

async function daemon(method, params = {}) {
  try {
    return await call(endpoint(), method, params);
  } catch (e) {
    if (!(e instanceof IpcError) || e.code !== 'ENODAEMON') throw e;
  }
  spawnDaemon();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      await call(endpoint(), 'ping', {}, 2000);
      return await call(endpoint(), method, params);
    } catch (e) {
      if (!(e instanceof IpcError) || e.code !== 'ENODAEMON') throw e;
    }
  }
  throw new Error('could not start the Tether daemon; see `tether daemon status`');
}

const out = (s = '') => process.stdout.write(s + '\n');
const json = (v) => out(JSON.stringify(v, null, 2));
/** An artifact reference: an artifact ID, or a path resolved against the caller's folder. */
const artifactRef = (r) => (/^a_[a-z0-9]+$/.test(r) ? r : path.resolve(r));

async function ask(question, valid) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const a = (await rl.question(question)).trim().toLowerCase();
      const hit = valid.find((v) => v === a || v[0] === a);
      if (hit) return hit;
      out(`  choose one of: ${valid.join(', ')}`);
    }
  } finally {
    rl.close();
  }
}

const DESCRIBE = {
  push: 'push your version (the server version stays in history)',
  accept: 'accept the server version (discard local changes)',
  'keep-both': 'keep your copy as an unmanaged file and accept the server version',
  diff: 'show the diff',
  cancel: 'leave it as it is for now',
  delete: 'delete it for everyone',
  stop: 'just stop managing it locally',
};

/** Shared flow for `done` and `track`: plan, ask per item, apply. */
async function resolveFlow(p, from, opts) {
  const target = path.resolve(p ?? '.');
  const plan = await daemon('plan', { path: target, from });
  const choices = {};
  for (const item of plan.items.filter((i) => i.options)) {
    const where = item.relPath ?? item.path;
    if (opts.resolve) {
      if (!item.options.includes(opts.resolve)) throw new Error(`${where}: "${opts.resolve}" is not possible here (options: ${item.options.filter((o) => o !== 'diff').join(', ')})`);
      choices[item.instanceId] = opts.resolve;
      continue;
    }
    if (!process.stdin.isTTY) throw new Error(`${where} needs a decision; rerun with --resolve <${item.options.filter((o) => o !== 'diff').join('|')}>`);
    out();
    out(`${item.path}`);
    out(`  local: ${item.change}${item.incoming ? `; server has a newer version (v${item.serverVersion})` : ''}${item.role === 'viewer' ? '; you are a viewer, so you cannot push' : ''}`);
    for (const o of item.options) out(`  [${o[0]}] ${o.padEnd(10)} ${DESCRIBE[o]}`);
    for (;;) {
      const choice = await ask('  > ', item.options);
      if (choice !== 'diff') {
        choices[item.instanceId] = choice;
        break;
      }
      out((await daemon('diff', { instanceId: item.instanceId })).text || '  (no content difference)');
    }
  }
  const { results } = await daemon('resolve', { path: target, from, items: plan.items, choices });
  for (const r of results) {
    const extra = r.error ? `  ERROR: ${r.error}` : r.version ? `  -> v${r.version}` : r.keptAs ? `  (your copy: ${r.keptAs})` : r.released ? `  (left at ${r.released})` : '';
    out(`${r.action.padEnd(9)} ${r.path}${extra}`);
  }
  if (results.some((r) => r.error)) process.exitCode = 1;
}

function printStatus(s, verbose) {
  out(`server: ${s.server}  user: ${s.user ? s.user.email : '(not signed in)'}${s.offline ? `  OFFLINE: ${s.offline}` : ''}`);
  if (!s.instances.length) return out('nothing managed yet');
  const folders = new Map(s.instances.filter((i) => i.kind === 'folder').map((i) => [i.instanceId, i]));
  for (const i of s.instances) {
    if (i.folderInstanceId && folders.has(i.folderInstanceId) && !verbose && i.mode === folders.get(i.folderInstanceId).mode && !i.flags.length) continue;
    const indent = i.folderInstanceId ? '  ' : '';
    const label = i.kind === 'folder' ? i.path + path.sep : i.folderInstanceId ? i.relPath : i.path;
    out(`${i.mode.padEnd(9)} ${(i.role ?? '').padEnd(6)} v${String(i.version).padEnd(4)} ${indent}${label}${i.flags.length ? `  [${i.flags.join('; ')}]` : ''}${verbose ? `  (${i.instanceId})` : ''}`);
  }
}

/** Command that opens a URL in the default browser. Not `cmd /c start`: cmd splits URLs at `&`. */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

function openBrowser(url) {
  const [cmd, args] = browserCommand(url);
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    // printed below anyway
  }
}

export async function main(argv) {
  const program = new Command('tether').description('Keep files in sync with a central source of truth, wherever they live.').version('0.1.0');
  program.showHelpAfterError();

  program.command('login').description('sign in (opens the browser)')
    .option('--email <email>', 'sign in with email and password instead (local development)')
    .option('--password <password>')
    .option('--signup', 'create the account (with --email)')
    .action(async (o) => {
      if (o.email) {
        const u = await daemon('login.password', { email: o.email, password: o.password, signup: !!o.signup });
        return out(`signed in as ${u.email}`);
      }
      const { url, state } = await daemon('login.start');
      out(`Opening ${url}`);
      out('If the browser does not open, copy the link above.');
      openBrowser(url);
      const u = await daemon('login.wait', { state });
      out(`signed in as ${u.email}`);
    });
  program.command('logout').description('sign out on this machine').action(async () => {
    await daemon('logout');
    out('signed out');
  });
  program.command('whoami').description('show the signed-in account').action(async () => {
    const u = await daemon('whoami');
    out(`${u.email} (${u.uid})`);
  });

  const repo = program.command('repo').description('manage repositories');
  repo.command('create <name>').action(async (name) => {
    const r = await daemon('repo.create', { name });
    out(`created repo ${r.name} (${r.repoId})`);
  });
  repo.command('list').action(async () => {
    const list = await daemon('repo.list');
    if (!list.length) out('no repos yet');
    for (const r of list) out(`${r.name.padEnd(24)} ${r.repoId}`);
  });
  repo.command('show <repo>').description('artifacts and share IDs in a repo').action(async (ref) => {
    const r = await daemon('repo.show', { ref });
    out(`${r.name} (${r.repoId})  eol rules: ${JSON.stringify(r.eolDefaults)}`);
    for (const a of r.artifacts) {
      out(`  ${a.kind.padEnd(6)} ${a.name.padEnd(28)} share ${a.shareId}  v${a.version}  ${a.artifactId}${a.deleted ? '  [deleted]' : ''}${a.kind === 'folder' ? `  (${a.fileCount} files)` : ''}`);
    }
  });
  repo.command('delete <repo>').description('permanently delete a repo on the server (local copies are kept)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (ref, o) => {
      if (!o.yes) {
        if (!process.stdin.isTTY) throw new Error('confirm with --yes');
        if ((await ask(`Permanently delete repo "${ref}" and its history for everyone? [y/n] `, ['yes', 'no'])) !== 'yes') return;
      }
      const r = await daemon('repo.delete', { ref });
      out(`deleted; ${r.purgedArtifacts} artifacts purged. Everyone's local copies stay on disk, untracked.`);
    });
  repo.command('transfer <repo>').requiredOption('--to <email>').action(async (ref, o) => {
    const r = await daemon('repo.transfer', { ref, to: o.to });
    out(`transferred ${r.name} to ${o.to}; you stay on as an editor`);
  });
  repo.command('eol <repo> <glob> <mode>').description('line-ending rule for new files: auto|lf|crlf|binary|unset').action(async (ref, glob, mode) => {
    const r = await daemon('repo.eol', { ref, glob, mode });
    out(`eol rules: ${JSON.stringify(r.eolDefaults)}`);
  });

  program.command('manage <path>').description('upload a file or folder into a repo; you become its owner')
    .requiredOption('--repo <repo>')
    .addOption(new Option('--eol <mode>').choices(['auto', 'lf', 'crlf', 'binary']))
    .action(async (p, o) => {
      const r = await daemon('manage', { path: path.resolve(p), repo: o.repo, eol: o.eol });
      out(`managing ${r.path} (${r.kind}${r.kind === 'folder' ? `, ${r.files} files` : ''})`);
      if (r.skippedSymlinks?.length) out(`skipped symlinks: ${r.skippedSymlinks.join(', ')}`);
      out(`share ID: ${r.shareId}`);
    });
  program.command('add <path>').description('add a new file inside a managed folder (owner only)').action(async (p) => {
    const r = await daemon('add', { path: path.resolve(p) });
    out(`added ${r.relPath} to ${r.folder}`);
  });
  program.command('pull <shareId> [dest]').description('get a managed copy').action(async (shareId, dest) => {
    const r = await daemon('pull', { shareId, dest, cwd: process.cwd() });
    out(`pulled ${r.path} (${r.kind}${r.kind === 'folder' ? `, ${r.files} files` : ''}, v${r.version}) as ${r.role}`);
  });
  program.command('status [path]').description('modes, pending changes, problems')
    .option('-v, --verbose', 'show every file and instance IDs')
    .option('--json')
    .action(async (p, o) => {
      const s = await daemon('status', { path: p ? path.resolve(p) : undefined });
      if (o.json) return json(s);
      printStatus(s, o.verbose);
    });

  program.command('edit <path>').description('start editing: local changes are kept until `tether done`').action(async (p) => {
    const r = await daemon('edit', { path: path.resolve(p) });
    out(r.changed.length ? `editing ${r.changed.length} file(s); run \`tether done ${p}\` to finish` : 'nothing to change (already editing?)');
  });
  program.command('done [path]').description('finish editing: push changes and resolve conflicts')
    .addOption(new Option('--resolve <choice>', 'answer every question with this choice').choices(['push', 'accept', 'keep-both', 'cancel', 'delete', 'stop']))
    .action((p, o) => resolveFlow(p, 'editing', o));
  program.command('unmanage <path>').description('stop syncing (location is still followed)').action(async (p) => {
    const r = await daemon('unmanage', { path: path.resolve(p) });
    out(`unmanaged ${r.changed.length} file(s)`);
  });
  program.command('track [path]').description('resume syncing unmanaged files')
    .addOption(new Option('--resolve <choice>', 'answer every question with this choice').choices(['push', 'accept', 'keep-both', 'cancel']))
    .action((p, o) => resolveFlow(p, 'unmanaged', o));
  program.command('locate <instance>').description('re-link a lost instance')
    .option('--in <dir...>', 'folders to search by content')
    .option('--file <path>', 'link to this file directly')
    .option('-y, --yes', 'link the only match without asking')
    .action(async (id, o) => {
      if (o.file) return out(`linked to ${(await daemon('locate', { instanceId: id, file: path.resolve(o.file) })).linked}`);
      const { candidates } = await daemon('locate', { instanceId: id, dirs: (o.in ?? []).map((d) => path.resolve(d)) });
      if (!candidates.length) return out('no file with matching content found');
      candidates.forEach((c, n) => out(`  ${n + 1}. ${c}`));
      if (candidates.length === 1 && (o.yes || (process.stdin.isTTY && (await ask('link it? [y/n] ', ['yes', 'no'])) === 'yes'))) {
        out(`linked to ${(await daemon('locate', { instanceId: id, file: candidates[0] })).linked}`);
      } else out('run again with --file <path> to choose');
    });

  program.command('diff <path>').description('server version vs your local file').action(async (p) => {
    const r = await daemon('diff', { path: path.resolve(p) });
    out(r.text || 'no differences');
  });
  program.command('history <artifact>').description('versions of a path or artifact ID').action(async (ref) => {
    for (const v of await daemon('history', { ref: artifactRef(ref) })) {
      const what = v.type + (v.rolledBackTo ? ` (to v${v.rolledBackTo})` : '') + (v.relPath && v.type !== 'content' ? ` ${v.relPath}` : '');
      out(`v${String(v.version).padEnd(4)} ${new Date(v.createdAt).toLocaleString().padEnd(22)} ${v.author.padEnd(26)} ${what}`);
    }
  });
  program.command('rollback <artifact>').description('restore an earlier version (owner)').requiredOption('--to <version>').action(async (ref, o) => {
    const r = await daemon('rollback', { ref: artifactRef(ref), toVersion: Number(o.to) });
    out(`rolled back; now v${r.version}`);
  });
  program.command('delete <artifact>').description('delete for everyone (owner, or editor with delete permission)')
    .option('-y, --yes')
    .action(async (ref, o) => {
      if (!o.yes) {
        if (!process.stdin.isTTY) throw new Error('confirm with --yes');
        if ((await ask(`Delete ${ref} for everyone? Local copies are kept but stop syncing. [y/n] `, ['yes', 'no'])) !== 'yes') return;
      }
      await daemon('delete', { ref: artifactRef(ref) });
      out('deleted (the owner can restore it with `tether rollback`)');
    });
  program.command('info <artifact>').description('server details of a path or artifact ID').action(async (ref) => json(await daemon('info', { ref: artifactRef(ref) })));

  program.command('share <artifact>').description('show or change sharing (owner)')
    .option('--editor <email>', 'make someone an editor')
    .option('--can-delete', 'with --editor: allow deleting for everyone')
    .option('--demote <email>', 'turn an editor into a viewer')
    .option('--revoke <email>', 'remove someone')
    .addOption(new Option('--visibility <v>').choices(['link', 'allowlist']))
    .option('--allow <email...>', 'add people to the allowlist')
    .option('--rotate-id', 'issue a new share ID; link-only users lose access')
    .action(async (ref, o) => {
      let op = null;
      if (o.editor) op = { addEditor: o.editor, canDelete: !!o.canDelete };
      else if (o.demote) op = { demote: o.demote };
      else if (o.revoke) op = { revoke: o.revoke };
      else if (o.visibility) op = { visibility: o.visibility, allow: o.allow };
      else if (o.allow) op = { allow: o.allow };
      else if (o.rotateId) op = { rotate: true };
      const s = await daemon('share', { ref: artifactRef(ref), op });
      out(`share ID:   ${s.shareId}`);
      out(`visibility: ${s.visibility}`);
      out(`editors:    ${s.editors.map((e) => e.email + (e.canDelete ? ' (can delete)' : '')).join(', ') || '-'}`);
      out(`allowlist:  ${s.allowlist.map((e) => e.email).join(', ') || '-'}`);
    });

  const d = program.command('daemon').description('control the background daemon');
  d.command('start').action(async () => {
    const r = await daemon('ping');
    out(`tetherd running (pid ${r.pid}, tracker ${r.tracker})`);
  });
  d.command('stop').action(async () => {
    try {
      await call(endpoint(), 'shutdown');
      out('tetherd stopped');
    } catch (e) {
      if (e.code === 'ENODAEMON') out('tetherd is not running');
      else throw e;
    }
  });
  d.command('status').action(async () => {
    try {
      const r = await call(endpoint(), 'ping', {}, 3000);
      out(`running: pid ${r.pid}, version ${r.version}, tracker ${r.tracker}, server ${r.server}, state ${r.home}`);
    } catch {
      out('not running');
    }
    out(`start at login: ${installed() ? 'yes' : 'no'}`);
  });
  d.command('install').description('start the daemon at login').action(async () => {
    const r = install();
    out(`installed (${r.method})`);
    await daemon('ping');
  });
  d.command('uninstall').description('stop starting the daemon at login').action(() => {
    uninstall();
    out('removed from login startup');
  });

  program.command('sync').description('run a sync pass now').action(async () => {
    const r = await daemon('sync');
    out(r.offline ? `offline: ${r.offline}` : 'synced');
  });
  program.command('log').description('recent daemon activity').option('-n <lines>', 'lines', '30').action(async (o) => {
    for (const l of await daemon('log', { lines: Number(o.n) })) out(l);
  });
  const cfg = program.command('config').description('client settings: server, consoleUrl, tickSeconds, graceMs, scanRoots');
  cfg.command('get [key]').action(async (key) => json(await daemon('config.get', { key })));
  cfg.command('set <key> <value>').action(async (key, value) => json(await daemon('config.set', { key, value })));

  await program.parseAsync(argv);
}
