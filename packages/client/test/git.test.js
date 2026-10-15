import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRepo, gitBusy, installHooks, removeHooks, hooksInstalled } from '../src/git.js';

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tether-git-')));

test('findRepo locates the repository around a path, even a missing file', () => {
  const dir = tmp();
  assert.equal(findRepo(path.join(dir, 'x.txt')), null);
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, 'sub'));
  const r = findRepo(path.join(dir, 'sub', 'not-yet.txt'));
  assert.equal(r.root.toLowerCase(), dir.toLowerCase());
  assert.equal(r.gitDir.toLowerCase(), path.join(dir, '.git').toLowerCase());
  assert.equal(r.hooksDir.toLowerCase(), path.join(dir, '.git', 'hooks').toLowerCase());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gitBusy reports running operations', () => {
  const gitDir = tmp();
  assert.equal(gitBusy(gitDir), null);
  fs.writeFileSync(path.join(gitDir, 'index.lock'), '');
  assert.equal(gitBusy(gitDir), 'git is running');
  fs.rmSync(path.join(gitDir, 'index.lock'));
  fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), '');
  assert.equal(gitBusy(gitDir), 'merge in progress');
  fs.rmSync(gitDir, { recursive: true });
});

test('hooks keep existing content and hold one block per profile', () => {
  const hooks = tmp();
  fs.writeFileSync(path.join(hooks, 'post-merge'), '#!/bin/sh\necho existing hook\n');
  installHooks(hooks, { home: 'C:\\homes\\a', node: 'C:\\node\\node.exe', cli: 'C:\\t\\tether.js' });
  installHooks(hooks, { home: 'C:\\homes\\a', node: 'C:\\node\\node.exe', cli: 'C:\\t\\tether.js' }); // idempotent
  installHooks(hooks, { home: 'C:\\homes\\b', node: 'C:\\node\\node.exe', cli: 'C:\\t\\tether.js' });
  const text = fs.readFileSync(path.join(hooks, 'post-merge'), 'utf8');
  assert.match(text, /echo existing hook/);
  assert.equal(text.match(/>>> tether \(C:\/homes\/a\)/g).length, 1);
  assert.match(text, /TETHER_HOME='C:\/homes\/b' 'C:\/node\/node.exe' 'C:\/t\/tether.js' git-sync --hook post-merge/);
  assert.ok(hooksInstalled(hooks, 'C:\\homes\\a'));
  removeHooks(hooks, 'C:\\homes\\a');
  removeHooks(hooks, 'C:\\homes\\b');
  assert.equal(fs.readFileSync(path.join(hooks, 'post-merge'), 'utf8').trim(), '#!/bin/sh\necho existing hook');
  assert.ok(!fs.existsSync(path.join(hooks, 'post-checkout'))); // created by us, removed when empty
  fs.rmSync(hooks, { recursive: true });
});
