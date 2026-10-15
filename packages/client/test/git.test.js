import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRepo, gitBusy, removeHooks, changeFromGit, setKeep, isKept, restage, changesBetween, head, isAncestor, resetGitBinary, gitBinary } from '../src/git.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tether-git-')));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' }).trim();
const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());

function repo() {
  const dir = tmp();
  git(dir, 'init', '-q', '--initial-branch=main');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', '1');
  return dir;
}

test('findRepo works for a missing file, and without git on PATH', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'sub'));
  const r = findRepo(path.join(dir, 'sub', 'not-yet.txt'));
  same(r.root, dir);
  same(r.gitDir, path.join(dir, '.git'));
  resetGitBinary(null); // pretend git is not installed
  try {
    const r2 = findRepo(path.join(dir, 'sub', 'x.txt'));
    same(r2.root, dir);
    same(r2.gitDir, path.join(dir, '.git'));
  } finally {
    resetGitBinary(undefined);
  }
  assert.ok(gitBinary());
  assert.equal(findRepo(tmp()), null);
});

test('worktrees: repository root and their own git dir', () => {
  const dir = repo();
  const wt = path.join(path.dirname(dir), path.basename(dir) + '-wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
  const r = findRepo(path.join(wt, 'f.txt'));
  same(r.root, fs.realpathSync.native(wt));
  assert.match(r.gitDir.replace(/\\/g, '/'), /\.git\/worktrees\//);
  fs.writeFileSync(path.join(r.gitDir, 'index.lock'), '');
  assert.equal(gitBusy(r.gitDir), 'git is running');
  fs.rmSync(path.join(r.gitDir, 'index.lock'));
});

test('gitBusy reports running operations', () => {
  const gitDir = tmp();
  assert.equal(gitBusy(gitDir), null);
  fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), '');
  assert.equal(gitBusy(gitDir), 'merge in progress');
});

test('changeFromGit: committed or staged content came from git, anything else is a local edit', () => {
  const dir = repo();
  const f = path.join(dir, 'f.txt');
  assert.deepEqual(changeFromGit(dir, f), { fromGit: true, commit: head(dir) });
  fs.writeFileSync(f, 'hand edit\n');
  assert.equal(changeFromGit(dir, f).fromGit, false);
  git(dir, 'add', 'f.txt');
  assert.deepEqual(changeFromGit(dir, f), { fromGit: true, commit: null }); // staged
  fs.writeFileSync(f, 'one\r\n');
  git(dir, 'config', 'core.autocrlf', 'true');
  git(dir, 'reset', '-q', '--hard');
  assert.equal(changeFromGit(dir, f).fromGit, true); // git's own line-ending conversion
});

test('keep filter: Tether content looks unchanged to git, and pulls that change the file go through', () => {
  const base = tmp();
  const bare = path.join(base, 'r.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare]);
  const up = path.join(base, 'up');
  git(base, 'clone', '-q', '-c', 'core.autocrlf=false', bare, up);
  fs.writeFileSync(path.join(up, 'f.txt'), 'v1\n');
  fs.writeFileSync(path.join(up, 'my file.txt'), 'spaces\n');
  git(up, 'add', '.');
  git(up, 'commit', '-qm', '1');
  git(up, 'push', '-q', '-u', 'origin', 'main');
  const me = path.join(base, 'me');
  git(base, 'clone', '-q', '-c', 'core.autocrlf=false', bare, me);
  const f = path.join(me, 'f.txt');
  const spaced = path.join(me, 'my file.txt');
  assert.equal(setKeep(me, f, true), true);
  assert.equal(setKeep(me, spaced, true), true);
  assert.ok(isKept(me, f) && isKept(me, spaced));
  for (const [file, text] of [[f, 'tether version, longer than before\n'], [spaced, 'tether\n']]) {
    fs.writeFileSync(file, text);
    restage(me, file); // what Tether does after writing
  }
  assert.equal(git(me, 'status', '--porcelain'), '');
  fs.writeFileSync(path.join(up, 'f.txt'), 'v2 from git\n');
  git(up, 'commit', '-qam', '2');
  git(up, 'push', '-q');
  git(me, 'pull', '-q'); // would be refused without the filter
  assert.equal(git(me, 'show', 'HEAD:f.txt'), 'v2 from git');
  assert.equal(git(me, 'diff', '--cached', '--name-only'), ''); // nothing staged by accident
  setKeep(me, f, false);
  setKeep(me, spaced, false);
  assert.equal(isKept(me, f), false);
  assert.equal(fs.readFileSync(path.join(me, '.git', 'info', 'attributes'), 'utf8'), '');
});

test('renames and additions between commits; ancestry', () => {
  const dir = repo();
  const first = head(dir);
  git(dir, 'mv', 'f.txt', 'g.txt');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', '2');
  const changes = changesBetween(dir, first, head(dir));
  const r = changes.find((c) => c.status === 'R');
  same(r.from, path.join(dir, 'f.txt'));
  same(r.to, path.join(dir, 'g.txt'));
  assert.ok(changes.some((c) => c.status === 'A' && c.to.toLowerCase().endsWith('new.txt')));
  assert.equal(isAncestor(dir, first), true);
  assert.equal(isAncestor(dir, '0'.repeat(40)), false);
});

test('hooks written by 0.2.0 are removed, other hook content kept', () => {
  const hooks = tmp();
  const home = 'C:\\homes\\a';
  fs.writeFileSync(path.join(hooks, 'post-merge'), `#!/bin/sh\necho mine\n\n# >>> tether (C:/homes/a) >>>\nold\n# <<< tether (C:/homes/a) <<<\n`);
  fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\n\n# >>> tether (C:/homes/a) >>>\nold\n# <<< tether (C:/homes/a) <<<\n`);
  removeHooks(hooks, home);
  assert.equal(fs.readFileSync(path.join(hooks, 'post-merge'), 'utf8').trim(), '#!/bin/sh\necho mine');
  assert.ok(!fs.existsSync(path.join(hooks, 'post-checkout')));
});
