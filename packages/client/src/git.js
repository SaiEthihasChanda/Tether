// Git integration: find the repository around a managed file, tell when git is in the middle
// of an operation, and install the hooks that hand git's changes to Tether ("follow" mode).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Per-file git modes (DESIGN §12c):
//   keep   - Tether stays the mirror; git's changes to the file are reverted.
//   follow - after pull/merge/checkout/switch/rebase, git's version is pushed to Tether (editors only).
export const GIT_MODES = ['keep', 'follow'];

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
}

/** The git repository containing `p` (a file or folder, existing or not): { root, gitDir, hooksDir } or null. */
export function findRepo(p) {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  try {
    const [root, gitDir, hooks] = git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'hooks']).split(/\r?\n/);
    return { root: path.resolve(root), gitDir: path.resolve(gitDir), hooksDir: path.resolve(dir, hooks) };
  } catch {
    return null; // not a repository, or git is not installed
  }
}

/** Why git is busy in this repository right now (an operation is rewriting files), or null. */
export function gitBusy(gitDir) {
  if (!gitDir) return null;
  const has = (f) => fs.existsSync(path.join(gitDir, f));
  if (has('index.lock')) return 'git is running';
  if (has('MERGE_HEAD')) return 'merge in progress';
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase in progress';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick in progress';
  if (has('REVERT_HEAD')) return 'revert in progress';
  return null;
}

export const HOOKS = ['post-merge', 'post-checkout', 'post-rewrite'];

const quote = (s) => `'${s.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
const begin = (home) => `# >>> tether (${home.replace(/\\/g, '/')}) >>>`;
const end = (home) => `# <<< tether (${home.replace(/\\/g, '/')}) <<<`;

/**
 * Adds a block to each hook that tells this Tether profile (home) that git just changed files.
 * Existing hook content is kept; one block per profile, so several profiles can follow one repo.
 */
export function installHooks(hooksDir, { home, node, cli }) {
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const hook of HOOKS) {
    const file = path.join(hooksDir, hook);
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '#!/bin/sh\n';
    text = stripBlock(text, home);
    const block = [
      begin(home),
      '# Lets Tether pick up files git changed (follow mode). Remove with `tether git <path> --mode keep`.',
      `TETHER_HOME=${quote(home)} ${quote(node)} ${quote(cli)} git-sync --hook ${hook} --repo "$(pwd)" >/dev/null 2>&1 || true`,
      end(home),
    ].join('\n');
    fs.writeFileSync(file, `${text.replace(/\s*$/, '')}\n\n${block}\n`);
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      // Windows: Git for Windows runs hooks regardless of mode
    }
  }
}

/** Removes this profile's block from the hooks; deletes hook files that become empty. */
export function removeHooks(hooksDir, home) {
  for (const hook of HOOKS) {
    const file = path.join(hooksDir, hook);
    if (!fs.existsSync(file)) continue;
    const text = stripBlock(fs.readFileSync(file, 'utf8'), home);
    if (/^(#!.*\n)?\s*$/.test(text)) fs.rmSync(file);
    else fs.writeFileSync(file, text.replace(/\s*$/, '\n'));
  }
}

export function hooksInstalled(hooksDir, home) {
  return HOOKS.every((h) => {
    const f = path.join(hooksDir, h);
    return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(begin(home));
  });
}

function stripBlock(text, home) {
  const b = text.indexOf(begin(home));
  if (b < 0) return text;
  const e = text.indexOf(end(home), b);
  return (text.slice(0, b) + (e < 0 ? '' : text.slice(e + end(home).length))).replace(/\n{3,}/g, '\n\n');
}
