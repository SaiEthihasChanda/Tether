// Git integration: managed files inside git repositories, keep vs follow, hooks, notifications.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup } from './helpers/setup.js';
import { eventually } from './helpers/machine.js';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const lf = (s) => s.replace(/\r\n/g, '\n');

let t, owner, ann, viewer, tmp, bare, dev, shareId;
const inst = async (m, end) => (await m.status()).instances.find((i) => i.path.endsWith(end));

/** A developer without Tether commits a new version of cfg.json upstream. */
function upstream(text) {
  git(dev, 'pull', '-q');
  fs.writeFileSync(path.join(dev, 'cfg.json'), text);
  git(dev, 'commit', '-qam', `cfg: ${text.trim()}`);
  git(dev, 'push', '-q');
}

before(async () => {
  t = await setup(['owner', 'ann', 'viewer']);
  ({ owner, ann, viewer } = t);
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tether-gitrepo-')));
  bare = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare]);
  dev = path.join(tmp, 'dev');
  git(tmp, 'clone', '-q', bare, dev);
  fs.writeFileSync(path.join(dev, 'cfg.json'), '{ "v": 1 }\n');
  fs.writeFileSync(path.join(dev, 'README.md'), 'repo\n');
  git(dev, 'add', '.');
  git(dev, 'commit', '-qm', 'init');
  git(dev, 'push', '-q', '-u', 'origin', 'main');
  for (const m of [owner, ann, viewer]) git(m.dir, 'clone', '-q', bare, 'repo');
});
after(async () => {
  await t?.teardown();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('managing a file inside a git repo: the choice is recorded (non-interactive default is keep)', async () => {
  const r = await owner.run(['manage', 'repo/cfg.json', '--repo', 'team', '--git', 'follow']);
  shareId = r.stdout.match(/share ID: (\S+)/)[1];
  assert.equal((await inst(owner, 'cfg.json')).flags.includes('git: follow'), true);
  await owner.run(['share', 'repo/cfg.json', '--editor', 'ann@example.com']);

  const skip = await ann.run(['pull', shareId, 'repo/cfg.json', '--git', 'skip']);
  assert.match(skip.stdout, /not pulled/);
  const def = await viewer.run(['pull', shareId, 'repo/cfg.json']);
  assert.match(def.stdout, /inside the git repository .*Tether will revert git's changes/);
  assert.ok((await inst(viewer, 'cfg.json')).flags.includes('git: keep'));
});

test('viewers cannot choose follow', async () => {
  const r = await viewer.run(['git', 'repo/cfg.json', '--mode', 'follow'], { allowFail: true });
  assert.match(r.stderr, /needs editor access/);
});

test('follow mode installs git hooks for the editor', async () => {
  await ann.run(['pull', shareId, 'repo/cfg.json', '--git', 'follow']);
  const hook = fs.readFileSync(ann.p('repo', '.git', 'hooks', 'post-merge'), 'utf8');
  assert.match(hook, /git-sync --hook post-merge/);
  assert.ok(fs.existsSync(ann.p('repo', '.git', 'hooks', 'post-checkout')));
  assert.ok(fs.existsSync(ann.p('repo', '.git', 'hooks', 'post-rewrite')));
});

test("follow: git pull accepts git's version and publishes it to Tether", async () => {
  upstream('{ "v": 2 }\n');
  git(ann.p('repo'), 'pull', '-q'); // the post-merge hook hands the change to ann's daemon
  await eventually(async () => /published git's version as v2/.test(await ann.log()), { message: 'publish from hook' });
  assert.equal(lf(ann.read('repo/cfg.json')), '{ "v": 2 }\n');
  assert.equal((await inst(ann, 'cfg.json')).mode, 'normal');
  await owner.sync();
  assert.equal(lf(owner.read('repo/cfg.json')), '{ "v": 2 }\n');
  await eventually(() => ann.notifications().some((n) => /Published git's changes/.test(n.title)), { timeout: 6000, message: 'publish notification' });
});

test("keep: git's change is reverted to Tether's version, with a notification", async () => {
  // (If the viewer synced first, Tether's v2 would make git see a local change and refuse the pull.)
  upstream('{ "v": 3 }\n'); // nobody in follow mode pulls this one
  git(viewer.p('repo'), 'pull', '-q');
  assert.equal(lf(viewer.read('repo/cfg.json')), '{ "v": 3 }\n');
  await viewer.sync();
  assert.equal(lf(viewer.read('repo/cfg.json')), '{ "v": 2 }\n');
  await eventually(() => viewer.notifications().some((n) => n.title === 'Tether undid a git change'), { timeout: 6000, message: 'revert notification' });
});

test('nothing is rewritten while git is in the middle of an operation', async () => {
  const lock = viewer.p('repo', '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  viewer.write('repo/cfg.json', 'mid-operation\n');
  await viewer.sync();
  assert.equal(viewer.read('repo/cfg.json'), 'mid-operation\n');
  fs.rmSync(lock);
  await viewer.sync();
  assert.equal(lf(viewer.read('repo/cfg.json')), '{ "v": 2 }\n');
});

test('follow conflict: git and Tether both changed it -> stays in editing, notified', async () => {
  await owner.run(['edit', 'repo/cfg.json']);
  owner.write('repo/cfg.json', '{ "v": "tether" }\n');
  await owner.run(['done', 'repo/cfg.json']); // Tether v3; ann has not synced
  upstream('{ "v": "git" }\n');
  git(ann.p('repo'), 'pull', '-q');
  await eventually(async () => (await inst(ann, 'cfg.json')).mode === 'editing', { message: 'editing after conflict' });
  const s = await inst(ann, 'cfg.json');
  assert.ok(s.flags.some((f) => /git changed this file and Tether has a newer version/.test(f)), s.flags.join());
  assert.equal(lf(ann.read('repo/cfg.json')), '{ "v": "git" }\n'); // git's version kept
  await eventually(() => ann.notifications().some((n) => /Merge conflict \(git and Tether\)/.test(n.title)), { timeout: 6000, message: 'conflict notification' });
  await ann.run(['done', 'repo/cfg.json', '--resolve', 'push']);
  await owner.sync();
  assert.equal(lf(owner.read('repo/cfg.json')), '{ "v": "git" }\n');
});

test('switching to a branch without the file pauses it; switching back picks it up again', async () => {
  const repo = ann.p('repo');
  await ann.sync();
  git(repo, 'switch', '-q', '-c', 'no-cfg');
  git(repo, 'rm', '-q', 'cfg.json');
  git(repo, 'commit', '-qm', 'drop cfg');
  await ann.sync();
  await eventually(async () => (await inst(ann, 'cfg.json'))?.flags.includes('deleted locally'), { message: 'paused while missing' });
  git(repo, 'switch', '-q', 'main'); // post-checkout hook
  await eventually(async () => {
    const s = await inst(ann, 'cfg.json');
    return s && s.mode === 'normal' && !s.flags.includes('deleted locally');
  }, { message: 'picked up again' });
  await ann.sync();
  assert.ok((await inst(ann, 'cfg.json')).flags.includes('git: follow'));
});

test('switching to keep removes the hooks', async () => {
  await ann.run(['git', 'repo/cfg.json', '--mode', 'keep']);
  assert.ok(!fs.existsSync(ann.p('repo', '.git', 'hooks', 'post-merge')));
});
