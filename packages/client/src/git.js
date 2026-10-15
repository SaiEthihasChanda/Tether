// Git integration (DESIGN §12c). No hooks: the daemon watches each repository's git directory
// and decides by content. A change to a "follow" file that matches what git has committed or
// staged came from git and is published; anything else is a local edit and is reverted.
// "keep" files are marked assume-unchanged so git ignores Tether's copy and pulls never refuse.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { isWindows } from './paths.js';

export const GIT_MODES = ['keep', 'follow'];

let gitExe; // cached path of the git executable, or null
/** The git executable: on PATH, or a standard install (Git for Windows, GitHub Desktop). */
export function gitBinary() {
  if (gitExe !== undefined) return gitExe;
  const candidates = ['git'];
  if (isWindows) {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    for (const p of pf) candidates.push(path.join(p, 'Git', 'cmd', 'git.exe'));
    const desktop = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'GitHubDesktop');
    if (desktop && fs.existsSync(desktop)) {
      for (const app of fs.readdirSync(desktop).filter((d) => d.startsWith('app-')).sort().reverse()) {
        candidates.push(path.join(desktop, app, 'resources', 'app', 'git', 'cmd', 'git.exe'));
      }
    }
  } else candidates.push('/usr/bin/git', '/usr/local/bin/git');
  gitExe = candidates.find((c) => spawnSync(c, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0) ?? null;
  return gitExe;
}

/** Test hook: forget the cached git executable. */
export function resetGitBinary(value) {
  gitExe = value;
}

function git(cwd, args) {
  const exe = gitBinary();
  if (!exe) throw new Error('git is not installed');
  return execFileSync(exe, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).replace(/\r?\n$/, '');
}

function gitOk(cwd, args) {
  const exe = gitBinary();
  return !!exe && spawnSync(exe, ['-C', cwd, ...args], { stdio: 'ignore', windowsHide: true }).status === 0;
}

/** The repository containing `p` (existing or not): { root, gitDir } or null. Works without git installed. */
export function findRepo(p) {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  if (gitBinary()) {
    try {
      const [root, gitDir] = git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir']).split(/\r?\n/);
      return { root: path.resolve(root), gitDir: path.resolve(gitDir) };
    } catch {
      return null;
    }
  }
  // No git executable: find .git ourselves (a directory, or a file pointing at the git dir).
  for (let d = dir; ; d = path.dirname(d)) {
    const dot = path.join(d, '.git');
    const st = fs.existsSync(dot) ? fs.statSync(dot) : null;
    if (st?.isDirectory()) return { root: d, gitDir: dot };
    if (st?.isFile()) {
      const m = fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (m) return { root: d, gitDir: path.resolve(d, m[1].trim()) };
    }
    if (path.dirname(d) === d) return null;
  }
}

/** Why git is busy in this repository right now, or null. */
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

const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

export const head = (root) => {
  try {
    return git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  } catch {
    return null; // no commits yet
  }
};

/** Git's blob id for the file's real content (git's conversions such as autocrlf, but not Tether's keep filter). */
export function fileBlob(root, abs) {
  try {
    return git(root, ['-c', 'filter.tether-keep.clean=', 'hash-object', `--path=${rel(root, abs)}`, '--', abs]);
  } catch {
    return null;
  }
}

/** Blob of `abs` in a commit ('HEAD', a sha) or null if the file is not in it. */
export function blobAt(root, rev, abs) {
  try {
    return git(root, ['rev-parse', '--verify', '-q', `${rev}:${rel(root, abs)}`]);
  } catch {
    return null;
  }
}

/** Blob staged in the index for `abs`, or null. */
export function indexBlob(root, abs) {
  try {
    const line = git(root, ['ls-files', '-s', '--', rel(root, abs)]);
    return line ? line.split(/\s+/)[1] : null;
  } catch {
    return null;
  }
}

/**
 * Did git put this content there? Yes if the file now matches what git has committed (HEAD)
 * or staged (index). Returns { fromGit, commit } (commit when it matches HEAD).
 */
export function changeFromGit(root, abs) {
  const blob = fileBlob(root, abs);
  if (!blob) return { fromGit: false };
  const h = head(root);
  if (h && blobAt(root, 'HEAD', abs) === blob) return { fromGit: true, commit: h };
  if (indexBlob(root, abs) === blob) return { fromGit: true, commit: null };
  return { fromGit: false };
}

export const isTracked = (root, abs) => gitOk(root, ['ls-files', '--error-unmatch', '--', rel(root, abs)]);

// keep mode: a local clean filter (in .git/info/attributes, never committed) makes git read a
// kept file as exactly what it already has, so Tether's copy never shows as modified and never
// blocks a pull or checkout. After Tether writes the file it re-stages it (a no-op for the
// content) so git's size/time cache matches; git compares sizes before it runs filters.
const FILTER = 'tether-keep';
const CLEAN = `sh -c 'git cat-file blob ":$1" 2>/dev/null || cat' -- %f`;

function attributesFile(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/attributes']));
}

/** One gitattributes line for a repository-relative path (quoted when it has spaces). */
function attrLine(relPath) {
  const pattern = /[\s"\\]/.test(relPath) ? `"/${relPath.replace(/["\\]/g, '\\$&')}"` : `/${relPath.replace(/[*?[\]!]/g, '\\$&')}`;
  return `${pattern} filter=${FILTER}`;
}

const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l !== '') : []);

/** Turns keep mode's git filter on or off for one file. */
export function setKeep(root, abs, on) {
  if (!gitBinary()) return false;
  try {
    const file = attributesFile(root);
    const line = attrLine(rel(root, abs));
    const lines = readLines(file);
    const has = lines.includes(line);
    if (on) {
      git(root, ['config', `filter.${FILTER}.clean`, CLEAN]);
      git(root, ['config', `filter.${FILTER}.required`, 'false']);
      if (!has) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, [...lines, line].join('\n') + '\n');
      }
      restage(root, abs);
    } else if (has) {
      const rest = lines.filter((l) => l !== line);
      fs.writeFileSync(file, rest.length ? rest.join('\n') + '\n' : '');
    }
    return true;
  } catch {
    return false;
  }
}

export function isKept(root, abs) {
  try {
    return readLines(attributesFile(root)).includes(attrLine(rel(root, abs)));
  } catch {
    return false;
  }
}

/** Refreshes git's cached size/time for a kept file after Tether rewrote it. */
export function restage(root, abs) {
  if (isTracked(root, abs)) gitOk(root, ['add', '--', rel(root, abs)]);
}

/** True if `commit` exists here and is already part of HEAD. */
export const isAncestor = (root, commit) => !!commit && gitOk(root, ['merge-base', '--is-ancestor', commit, 'HEAD']);

/** Files git renamed, added or deleted between two commits: [{ status: 'R'|'A'|'D', from, to }] (absolute paths). */
export function changesBetween(root, from, to) {
  // Commit by commit, so a rename is still recognised when the file's content also changed
  // later (comparing only the two ends would show a delete and an add).
  try {
    const out = git(root, ['-c', 'core.quotePath=false', 'log', '--reverse', '--first-parent', '--format=%x01', '--name-status', '-M', `${from}..${to}`]);
    const renames = new Map(); // original path -> current path
    const added = new Set();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const status = parts[0][0];
      if (status === 'R') {
        const [, oldP, newP] = parts;
        const origin = [...renames.entries()].find(([, cur]) => cur === oldP)?.[0] ?? oldP;
        if (added.delete(oldP)) added.add(newP);
        else renames.set(origin, newP);
      } else if (status === 'A') added.add(parts[1]);
      else if (status === 'D') {
        added.delete(parts[1]);
        for (const [o, cur] of renames) if (cur === parts[1]) renames.delete(o);
      }
    }
    const abs = (p) => path.join(root, ...p.split('/'));
    return [
      ...[...renames].map(([o, n]) => ({ status: 'R', from: abs(o), to: abs(n) })),
      ...[...added].map((p) => ({ status: 'A', from: abs(p), to: abs(p) })),
    ];
  } catch {
    return [];
  }
}

// ---- legacy hooks (0.2.0 installed them; they are no longer needed) ----
const HOOKS = ['post-merge', 'post-checkout', 'post-rewrite'];
const begin = (home) => `# >>> tether (${home.replace(/\\/g, '/')}) >>>`;
const end = (home) => `# <<< tether (${home.replace(/\\/g, '/')}) <<<`;

/** Removes a block written by Tether 0.2.0 from a repository's hooks. */
export function removeHooks(hooksDir, home) {
  for (const hook of HOOKS) {
    const file = path.join(hooksDir, hook);
    if (!fs.existsSync(file)) continue;
    let text = fs.readFileSync(file, 'utf8');
    const b = text.indexOf(begin(home));
    if (b < 0) continue;
    const e = text.indexOf(end(home), b);
    text = (text.slice(0, b) + (e < 0 ? '' : text.slice(e + end(home).length))).replace(/\n{3,}/g, '\n\n');
    if (/^(#!.*\n)?\s*$/.test(text)) fs.rmSync(file);
    else fs.writeFileSync(file, text.replace(/\s*$/, '\n'));
  }
}
