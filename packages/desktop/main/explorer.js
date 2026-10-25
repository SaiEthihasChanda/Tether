// "Tether" in Windows Explorer's right-click menu, for files and folders: a submenu whose items
// start this app with `--action <verb> <path>`. Per-user registry keys (HKCU), so no admin rights
// are needed; the uninstaller removes the same keys. On Windows 11 classic menu entries appear
// under "Show more options".
import { execFileSync } from 'node:child_process';
import { app } from 'electron';

const ROOTS = ['HKCU\\Software\\Classes\\*\\shell\\Tether', 'HKCU\\Software\\Classes\\Directory\\shell\\Tether'];
export const VERBS = [
  ['10share', 'Share with Tether', 'share'],
  ['20edit', 'Make changes', 'edit'],
  ['30done', 'Done making changes', 'done'],
  ['40stop', 'Stop syncing', 'unmanage'],
  ['50resume', 'Sync again', 'track'],
  ['60show', 'Show in Tether', 'show'],
];

/** The command Explorer runs: the app itself (in development, electron.exe plus the app folder). */
function launcher() {
  return process.defaultApp ? `"${process.execPath}" "${app.getAppPath()}"` : `"${process.execPath}"`;
}

const reg = (args) => execFileSync('reg.exe', args, { stdio: 'pipe', windowsHide: true });

export function registerExplorerMenu() {
  if (process.platform !== 'win32') return;
  const exe = launcher();
  for (const root of ROOTS) {
    reg(['add', root, '/v', 'MUIVerb', '/t', 'REG_SZ', '/d', 'Tether', '/f']);
    reg(['add', root, '/v', 'SubCommands', '/t', 'REG_SZ', '/d', '', '/f']);
    reg(['add', root, '/v', 'Icon', '/t', 'REG_SZ', '/d', `${process.execPath},0`, '/f']);
    for (const [key, label, verb] of VERBS) {
      reg(['add', `${root}\\shell\\${key}`, '/v', 'MUIVerb', '/t', 'REG_SZ', '/d', label, '/f']);
      reg(['add', `${root}\\shell\\${key}\\command`, '/ve', '/t', 'REG_SZ', '/d', `${exe} --action ${verb} "%1"`, '/f']);
    }
  }
}

export function unregisterExplorerMenu() {
  if (process.platform !== 'win32') return;
  for (const root of ROOTS) {
    try {
      reg(['delete', root, '/f']);
    } catch {
      // not there
    }
  }
}

export function explorerMenuInstalled() {
  if (process.platform !== 'win32') return false;
  try {
    reg(['query', ROOTS[0], '/v', 'MUIVerb']);
    return true;
  } catch {
    return false;
  }
}

/** `--action <verb> <path>` from a command line, or null. */
export function parseAction(argv) {
  const i = argv.indexOf('--action');
  if (i < 0 || !argv[i + 1]) return null;
  return { verb: argv[i + 1], path: argv[i + 2] ?? null };
}
