// Managed files inside git repositories (DESIGN §12c): keep vs follow, decided by content,
// driven by watching the git directory (no hooks). Covers the scenario list A1-E4.
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

let t, owner, ann, ben, viewer, tmp, bare, dev, cfgId;
const inst = async (m, end) => (await m.status()).instances.find((i) => i.path.replace(/\\/g, '/').endsWith(end));
const clean = (m) => git(m.p('repo'), 'status', '--porcelain') === '';

/** A developer without Tether commits upstream. */
function upstream(file, text, msg = `${file}: ${text.trim()}`) {
  git(dev, 'pull', '-q');
  fs.mkdirSync(path.dirname(path.join(dev, file)), { recursive: true });
  fs.writeFileSync(path.join(dev, file), text);
  git(dev, 'add', '.');
  git(dev, 'commit', '-qm', msg);
  git(dev, 'push', '-q');
}

before(async () => {
  t = await setup(['owner', 'ann', 'ben', 'viewer']);
  ({ owner, ann, ben, viewer } = t);
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tether-gitrepo-')));
  bare = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare]);
  dev = path.join(tmp, 'dev');
  git(tmp, 'clone', '-q', '-c', 'core.autocrlf=false', bare, dev);
  fs.writeFileSync(path.join(dev, 'cfg.json'), '{ "v": 1 }\n');
  fs.writeFileSync(path.join(dev, 'README.md'), 'repo\n');
  fs.mkdirSync(path.join(dev, 'conf'));
  fs.writeFileSync(path.join(dev, 'conf', 'a.txt'), 'a\n');
  git(dev, 'add', '.');
  git(dev, 'commit', '-qm', 'init');
  git(dev, 'push', '-q', '-u', 'origin', 'main');
  // core.autocrlf must be set during the clone, or the checkout already converted line endings.
  for (const m of [owner, ann, ben, viewer]) git(m.dir, 'clone', '-q', '-c', 'core.autocrlf=false', bare, 'repo');
});
after(async () => {
  await t?.teardown();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('A1/A2: the git choice is recorded; non-interactive default is keep; viewers cannot follow', async () => {
  const r = await owner.run(['manage', 'repo/cfg.json', '--repo', 'team', '--git', 'follow']);
  cfgId = r.stdout.match(/share ID: (\S+)/)[1];
  for (const e of ['ann', 'ben']) await owner.run(['share', 'repo/cfg.json', '--editor', `${e}@example.com`]);
  assert.match((await ann.run(['pull', cfgId, 'repo/cfg.json', '--git', 'skip'])).stdout, /not pulled/);
  await ann.run(['pull', cfgId, 'repo/cfg.json', '--git', 'follow']);
  await ben.run(['pull', cfgId, 'repo/cfg.json', '--git', 'follow']);
  const def = await viewer.run(['pull', cfgId, 'repo/cfg.json']);
  assert.match(def.stdout, /inside the git repository .*Tether will revert git's changes/);
  assert.ok((await inst(viewer, 'repo/cfg.json')).flags.includes('git: keep'));
  const no = await viewer.run(['git', 'repo/cfg.json', '--mode', 'follow'], { allowFail: true });
  assert.match(no.stderr, /needs editor access/);
});

test('E3: nothing is written into the repositories (no hooks)', () => {
  for (const m of [owner, ann, ben, viewer]) {
    const hooks = fs.readdirSync(m.p('repo', '.git', 'hooks'));
    assert.ok(hooks.every((h) => h.endsWith('.sample')), hooks.join());
    assert.ok(clean(m), m.name);
  }
});

test("B1 + D1/D2: one editor's git pull publishes; teammates wait for their own pull, then adopt it", async () => {
  upstream('cfg.json', '{ "v": 2 }\n');
  git(ann.p('repo'), 'pull', '-q'); // no hook: ann's daemon notices through the .git watcher
  await eventually(async () => /published git's version as v2/.test(await ann.log()), { message: 'publish' });
  await eventually(() => ann.notifications().some((n) => /Published git's changes/.test(n.title)), { timeout: 6000, message: 'notified' });

  await ben.sync(); // Tether has v2 from commit X; ben's checkout does not have X yet
  const b = await inst(ben, 'repo/cfg.json');
  assert.ok(b.flags.includes('newer version arrives with your next git pull'), b.flags.join());
  assert.equal(lf(ben.read('repo/cfg.json')), '{ "v": 1 }\n'); // untouched, so...
  git(ben.p('repo'), 'pull', '-q'); // ...git can pull
  await ben.sync();
  const b2 = await inst(ben, 'repo/cfg.json');
  assert.equal(b2.mode, 'normal');
  assert.ok(!b2.flags.some((f) => /conflict|waiting|arrives/.test(f)), b2.flags.join());
  assert.match(await ben.log(), /already on Tether \(v2\)/);
  assert.ok(clean(ben));
});

test('C1/D3 keep: Tether updates do not block git pulls, and git status stays clean', async () => {
  await viewer.sync(); // receives Tether v2
  assert.equal(lf(viewer.read('repo/cfg.json')), '{ "v": 2 }\n');
  assert.ok(clean(viewer));
  upstream('cfg.json', '{ "v": 3 }\n'); // nobody publishes this one
  git(viewer.p('repo'), 'pull', '-q'); // not refused
  await viewer.sync();
  assert.equal(lf(viewer.read('repo/cfg.json')), '{ "v": 2 }\n'); // Tether's version stays
  assert.ok(clean(viewer));
  viewer.write('repo/cfg.json', 'hand edit\n');
  await viewer.sync();
  assert.equal(lf(viewer.read('repo/cfg.json')), '{ "v": 2 }\n');
});

test('B15: nothing is rewritten while git is in the middle of an operation', async () => {
  const lock = viewer.p('repo', '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  viewer.write('repo/cfg.json', 'mid-operation\n');
  await viewer.sync();
  assert.equal(viewer.read('repo/cfg.json'), 'mid-operation\n');
  fs.rmSync(lock);
  await viewer.sync();
  assert.equal(lf(viewer.read('repo/cfg.json')), '{ "v": 2 }\n');
});

test('follow: a manual edit is still reverted (only git content is published)', async () => {
  git(ann.p('repo'), 'pull', '-q'); // gets v3 from git -> published
  await eventually(async () => /published git's version as v3/.test(await ann.log()), { message: 'v3 published' });
  ann.write('repo/cfg.json', 'typed by hand\n');
  await ann.sync();
  assert.equal(lf(ann.read('repo/cfg.json')), '{ "v": 3 }\n');
  assert.doesNotMatch(await ann.log(), /published git's version as v4/);
});

test('B7: git reset --hard and git restore are published (no hook needed)', async () => {
  git(ann.p('repo'), 'reset', '-q', '--hard', 'HEAD~1');
  await eventually(async () => /published git's version as v4/.test(await ann.log()), { message: 'reset published' });
  // Follow-mode clients wait for their own git pull (the owner has not pulled); keep-mode clients take it now.
  await viewer.sync();
  assert.equal(lf(viewer.read('repo/cfg.json')), '{ "v": 2 }\n');
  await owner.sync();
  const o = await inst(owner, 'repo/cfg.json');
  assert.ok(o.flags.includes('newer version arrives with your next git pull'), o.flags.join());
  git(ann.p('repo'), 'reset', '-q', '--hard', 'origin/main');
  await eventually(async () => /published git's version as v5/.test(await ann.log()), { message: 'reset back published' });
});

test('B9: cherry-pick is published', async () => {
  upstream('cfg.json', '{ "v": "picked" }\n');
  const sha = git(dev, 'rev-parse', 'HEAD').trim();
  git(ann.p('repo'), 'fetch', '-q');
  git(ann.p('repo'), 'cherry-pick', sha);
  await eventually(async () => /published git's version as v6/.test(await ann.log()), { message: 'cherry-pick published' });
  git(ann.p('repo'), 'reset', '-q', '--hard', 'origin/main'); // same content as the pick
});

test('C3: git and Tether both changed it -> stays in editing, notified', async () => {
  git(owner.p('repo'), 'pull', '-q'); // the owner catches up through git first
  await owner.sync();
  // ann must not see Tether's version before her pull (with push it would arrive within a second)
  await ann.ipc('shutdown');
  await new Promise((r) => setTimeout(r, 500));
  // A Tether-side edit made from a copy outside git (e.g. someone without the repository).
  await owner.run(['pull', cfgId, 'plain/cfg.json']);
  await owner.run(['edit', 'plain/cfg.json']);
  owner.write('plain/cfg.json', '{ "v": "tether" }\n');
  await owner.run(['done', 'plain/cfg.json']);
  // The owner's follow-mode clone takes it as an overlay git does not see: no dirty tree.
  await owner.sync();
  assert.equal(lf(owner.read('repo/cfg.json')), '{ "v": "tether" }\n');
  assert.ok((await inst(owner, 'repo/cfg.json')).flags.includes('Tether-only version (hidden from git)'));
  assert.ok(clean(owner));
  upstream('cfg.json', '{ "v": "git" }\n');
  git(ann.p('repo'), 'pull', '-q');
  await ann.start();
  await ann.sync();
  await eventually(async () => (await inst(ann, 'repo/cfg.json')).mode === 'editing', { message: 'editing after conflict' });
  assert.equal(lf(ann.read('repo/cfg.json')), '{ "v": "git" }\n');
  await eventually(() => ann.notifications().some((n) => /Merge conflict \(git and Tether\)/.test(n.title)), { timeout: 6000, message: 'conflict notification' });
  await ann.run(['done', 'repo/cfg.json', '--resolve', 'push']);
});

test('B10: a rename made in git is followed (follow and keep)', async () => {
  git(dev, 'pull', '-q');
  git(dev, 'mv', 'cfg.json', 'config.json');
  git(dev, 'commit', '-qm', 'rename');
  git(dev, 'push', '-q');
  git(ann.p('repo'), 'pull', '-q');
  await eventually(async () => !!(await inst(ann, 'repo/config.json')), { message: 'follow rename' });
  assert.equal((await inst(ann, 'repo/config.json')).mode, 'normal');
  git(viewer.p('repo'), 'pull', '-q');
  await viewer.sync();
  await eventually(async () => !!(await inst(viewer, 'repo/config.json')), { message: 'keep rename' });
  assert.ok(!viewer.exists('repo/cfg.json')); // the old path is not recreated
  assert.ok(clean(viewer));
});

test('B5: a branch without the file pauses it (keep and follow); switching back picks it up', async () => {
  for (const m of [ann, viewer]) {
    const repo = m.p('repo');
    await m.sync();
    git(repo, 'switch', '-q', '-c', 'no-cfg');
    git(repo, 'rm', '-q', 'config.json');
    git(repo, 'commit', '-qm', 'drop');
    await m.sync();
    await eventually(async () => (await inst(m, 'repo/config.json'))?.flags.includes('deleted locally'), { message: `${m.name} paused` });
    git(repo, 'switch', '-q', 'main');
    await eventually(async () => {
      const s = await inst(m, 'repo/config.json');
      return s && s.mode === 'normal' && !s.flags.includes('deleted locally');
    }, { message: `${m.name} picked up` });
  }
});

test('B11: a file git adds to a follow-mode folder is published by the owner and arrives through git for others', async () => {
  git(owner.p('repo'), 'pull', '-q');
  const r = await owner.run(['manage', 'repo/conf', '--repo', 'team', '--git', 'follow']);
  const confId = r.stdout.match(/share ID: (\S+)/)[1];
  await owner.run(['share', 'repo/conf', '--editor', 'ben@example.com']);
  git(ben.p('repo'), 'pull', '-q');
  await ben.run(['pull', confId, 'repo/conf', '--git', 'follow']);

  upstream('conf/b.txt', 'b\n');
  git(owner.p('repo'), 'pull', '-q');
  await eventually(async () => !!(await inst(owner, 'repo/conf/b.txt')), { message: 'owner added b.txt' });

  await ben.sync();
  assert.equal(ben.exists('repo/conf/b.txt'), false); // waits for git...
  git(ben.p('repo'), 'pull', '-q'); // ...so this is not blocked by an untracked file
  await ben.sync();
  await eventually(async () => (await inst(ben, 'repo/conf/b.txt'))?.mode === 'normal', { message: 'ben has b.txt managed' });
});

test('A4: pulling where git already has a different version', async () => {
  owner.write('outside/readme-template.md', '# from Tether\n');
  const id = (await owner.run(['manage', 'outside/readme-template.md', '--repo', 'team'])).stdout.match(/share ID: (\S+)/)[1];
  await owner.run(['share', 'outside/readme-template.md', '--editor', 'ben@example.com']);
  // keep: Tether's version replaces git's (git still has it), and git stays clean
  const k = await viewer.run(['pull', id, 'repo/README.md', '--git', 'keep']);
  assert.match(k.stdout, /replaced git's version with Tether's/);
  assert.equal(lf(viewer.read('repo/README.md')), '# from Tether\n');
  assert.ok(clean(viewer));
  // follow: git's version is kept, in editing mode
  const f = await ben.run(['pull', id, 'repo/README.md', '--git', 'follow']);
  assert.match(f.stdout, /kept git's version/);
  assert.equal(lf(ben.read('repo/README.md')), 'repo\n');
  assert.equal((await inst(ben, 'repo/README.md')).mode, 'editing');
  // uncommitted git changes are never overwritten
  ann.write('repo/README.md', 'uncommitted\n');
  const no = await ann.run(['pull', id, 'repo/README.md', '--git', 'keep'], { allowFail: true });
  assert.match(no.stderr, /uncommitted git changes/);
});

test('A5: a managed file that ends up inside a new git repository switches to keep', async () => {
  owner.write('later/notes.txt', 'n\n');
  await owner.run(['manage', 'later/notes.txt', '--repo', 'team']);
  git(owner.p('later'), 'init', '-q');
  await owner.ipc('shutdown'); // detection runs at startup and hourly
  await new Promise((r) => setTimeout(r, 500));
  await owner.start();
  await eventually(async () => (await inst(owner, 'later/notes.txt'))?.flags.includes('git: keep'), { message: 'keep after git init' });
  await eventually(() => owner.notifications().some((n) => /now in a git repository/.test(n.title)), { timeout: 6000, message: 'notified' });
});
