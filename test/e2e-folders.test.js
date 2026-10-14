// Phase 4: folder artifacts (layout sync, moves in/out, deletes, add, delete permission).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, manage } from './helpers/setup.js';
import { eventually } from './helpers/machine.js';

let t, owner, ed, viewer, id;

before(async () => {
  t = await setup(['owner', 'ed', 'viewer']);
  ({ owner, ed, viewer } = t);
  owner.write('kit/README.md', '# kit\n');
  owner.write('kit/src/a.txt', 'a\n');
  owner.write('kit/src/b.txt', 'b\n');
  owner.write('kit/bin/logo.bin', '\u0000\u0001\r\n\u0002');
  id = await manage(owner, 'kit');
  await owner.run(['share', 'kit', '--editor', 'ed@example.com']);
  await ed.run(['pull', id]);
  await viewer.run(['pull', id]);
});
after(() => t?.teardown());

const lf = (s) => s.replace(/\r\n/g, '\n');
const child = async (m, rel) => (await m.status()).instances.find((i) => i.relPath === rel);

test('manage rejects layouts that cannot exist on both platforms', async () => {
  owner.write('bad/Readme.md', 'x');
  owner.write('bad/README.md.txt', 'x');
  fs.mkdirSync(owner.p('bad2'));
  owner.write('bad2/x.txt', 'x');
  owner.write('bad2/X.TXT.d/y', 'y');
  const r = await owner.run(['manage', 'bad2/x.txt', '--repo', 'team']); // single files are fine
  assert.match(r.stdout, /managing/);
  const inside = await owner.run(['manage', 'kit/src', '--repo', 'team'], { allowFail: true });
  assert.match(inside.stderr, /inside the managed folder/);
});

test('pull reproduces the layout; binary files are byte-exact', async () => {
  assert.equal(lf(viewer.read('kit/src/a.txt')), 'a\n');
  assert.deepEqual(fs.readFileSync(viewer.p('kit/bin/logo.bin')), fs.readFileSync(owner.p('kit/bin/logo.bin')));
  const s = await viewer.status();
  assert.equal(s.instances.filter((i) => i.folderInstanceId).length, 4);
});

test('normal mode: a move inside the folder is reverted', async () => {
  fs.renameSync(viewer.p('kit/src/a.txt'), viewer.p('kit/a-renamed.txt'));
  await viewer.sync();
  assert.ok(viewer.exists('kit/src/a.txt'));
  assert.ok(!viewer.exists('kit/a-renamed.txt'));
  assert.match(await viewer.log(), /move reverted to src\/a.txt/);
});

test('normal mode: a case-only rename is reverted', async () => {
  fs.renameSync(viewer.p('kit/README.md'), viewer.p('kit/readme.md'));
  await viewer.sync();
  assert.deepEqual(fs.readdirSync(viewer.p('kit')).sort(), ['README.md', 'bin', 'src']);
});

test('normal mode: a file moved out stays as an ordinary file and the folder is restored', async () => {
  fs.renameSync(viewer.p('kit/src/b.txt'), viewer.p('b-took-it.txt'));
  await viewer.sync();
  assert.ok(viewer.exists('kit/src/b.txt'));
  assert.equal(lf(viewer.read('b-took-it.txt')), 'b\n');
  viewer.write('b-took-it.txt', 'free now\n');
  await viewer.sync();
  assert.equal(viewer.read('b-took-it.txt'), 'free now\n');
  assert.equal((await child(viewer, 'src/b.txt')).mode, 'normal');
});

test('new files inside a managed folder are ignored', async () => {
  viewer.write('kit/src/notes.txt', 'mine\n');
  await viewer.sync();
  assert.equal(viewer.read('kit/src/notes.txt'), 'mine\n');
  assert.equal(await child(viewer, 'src/notes.txt'), undefined);
});

test('a deleted file stops being managed; track restores it', async () => {
  fs.rmSync(viewer.p('kit/README.md'));
  await viewer.sync();
  await eventually(async () => (await child(viewer, 'README.md'))?.flags.includes('deleted locally'), { message: 'README detached' });
  await viewer.sync();
  assert.ok(!viewer.exists('kit/README.md'));
  await viewer.run(['track', 'kit']);
  assert.equal(lf(viewer.read('kit/README.md')), '# kit\n');
  assert.equal((await child(viewer, 'README.md')).mode, 'normal');
});

test('owner adds a file; it appears for everyone', async () => {
  owner.write('kit/src/c.txt', 'c\n');
  const notOwner = ed.write('kit/src/c2.txt', 'c2\n');
  await owner.run(['add', 'kit/src/c.txt']);
  const r = await ed.run(['add', 'kit/src/c2.txt'], { allowFail: true });
  assert.match(r.stderr, /only the owner/);
  await viewer.sync();
  assert.equal(lf(viewer.read('kit/src/c.txt')), 'c\n');
  assert.equal((await child(viewer, 'src/c.txt')).mode, 'normal');
  void notOwner;
});

test('editor: moves and edits inside the folder are pushed on done', async () => {
  await ed.run(['edit', 'kit']);
  fs.mkdirSync(ed.p('kit/docs'));
  fs.renameSync(ed.p('kit/src/a.txt'), ed.p('kit/docs/a.md'));
  ed.write('kit/docs/a.md', 'a, now in docs\n');
  await ed.sync();
  assert.ok(ed.exists('kit/docs/a.md')); // editing: nothing reverted
  const d = await ed.run(['done', 'kit']);
  assert.match(d.stdout, /push .*a\.md/);
  await viewer.sync();
  assert.equal(lf(viewer.read('kit/docs/a.md')), 'a, now in docs\n');
  assert.ok(!viewer.exists('kit/src/a.txt'));
  assert.equal((await child(viewer, 'docs/a.md')).mode, 'normal');
});

test('editor without delete permission: moving a file out only unmanages it locally', async () => {
  await ed.run(['edit', 'kit']);
  fs.renameSync(ed.p('kit/src/c.txt'), ed.p('c-out.txt'));
  const d = await ed.run(['done', 'kit']);
  assert.match(d.stdout, /stop .*\(left at .*c-out.txt\)/);
  assert.ok(ed.exists('kit/src/c.txt'));
  assert.ok(ed.exists('c-out.txt'));
  await viewer.sync();
  assert.ok(viewer.exists('kit/src/c.txt'));
});

test('editor without delete permission: a deleted file is only unmanaged locally', async () => {
  await ed.run(['edit', 'kit']);
  fs.rmSync(ed.p('kit/src/c.txt'));
  await ed.sync();
  await eventually(async () => (await child(ed, 'src/c.txt'))?.flags.includes('deleted locally'), { message: 'detached while editing' });
  const d = await ed.run(['done', 'kit']);
  assert.match(d.stdout, /stop/);
  await viewer.sync();
  assert.ok(viewer.exists('kit/src/c.txt'));
});

test('editor with delete permission: delete for everyone (files stay on other disks)', async () => {
  await owner.run(['share', 'kit', '--editor', 'ed@example.com', '--can-delete']);
  await ed.run(['track', 'kit']); // restore c.txt first
  await ed.sync();
  await ed.run(['edit', 'kit']);
  fs.rmSync(ed.p('kit/src/c.txt'));
  await ed.sync();
  await eventually(async () => (await child(ed, 'src/c.txt'))?.flags.includes('deleted locally'), { message: 'detached' });
  const ask = await ed.run(['done', 'kit'], { allowFail: true });
  assert.match(ask.stderr, /--resolve <delete\|stop>/);
  await ed.run(['done', 'kit', '--resolve', 'delete']);
  await viewer.sync();
  const v = await child(viewer, 'src/c.txt');
  assert.equal(v.mode, 'orphaned');
  assert.ok(viewer.exists('kit/src/c.txt'));
  const h = (await owner.run(['history', 'kit'])).stdout;
  assert.match(h, /delete src\/c.txt/);
});

test('moving the whole folder keeps everything tracked', async () => {
  fs.renameSync(viewer.p('kit'), viewer.p('kit-moved'));
  viewer.write('kit-moved/docs/a.md', 'tamper\n');
  await viewer.sync();
  assert.equal(lf(viewer.read('kit-moved/docs/a.md')), 'a, now in docs\n');
  await owner.run(['edit', 'kit']);
  owner.write('kit/README.md', '# kit v2\n');
  await owner.run(['done', 'kit']);
  await viewer.sync();
  assert.equal(lf(viewer.read('kit-moved/README.md')), '# kit v2\n');
});

test('deleting the whole folder for everyone orphans all copies', async () => {
  await owner.run(['delete', 'kit', '--yes']);
  await viewer.sync();
  const s = await viewer.status();
  assert.ok(s.instances.every((i) => i.mode === 'orphaned'));
  assert.ok(viewer.exists('kit-moved/README.md'));
});
