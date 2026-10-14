// Phase 5: the portable scan tracker (the no-root Linux fallback), exercised on this machine.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, manage } from './helpers/setup.js';
import { eventually } from './helpers/machine.js';

let t, owner, linux, fileId, folderId;

before(async () => {
  t = await setup(['owner', 'linux'], { linux: { tracker: 'scan' } });
  ({ owner, linux } = t);
  owner.write('f.txt', 'file\n');
  owner.write('dir/x.txt', 'x\n');
  fileId = await manage(owner, 'f.txt');
  folderId = await manage(owner, 'dir');
  await linux.run(['pull', fileId]);
  await linux.run(['pull', folderId]);
});
after(() => t?.teardown());

const lf = (s) => s.replace(/\r\n/g, '\n');

test('the scan tracker is active', async () => {
  const r = await linux.run(['daemon', 'status']);
  assert.match(r.stdout, /tracker scan/);
});

test('moves are found by scanning the configured roots', async () => {
  fs.mkdirSync(linux.p('a', 'b', 'c'), { recursive: true });
  fs.renameSync(linux.p('f.txt'), linux.p('a', 'b', 'c', 'g.txt'));
  linux.write('a/b/c/g.txt', 'tamper\n');
  await linux.sync();
  assert.equal(lf(linux.read('a/b/c/g.txt')), 'file\n');
});

test('atomic saves are re-linked', async () => {
  const p = linux.p('a', 'b', 'c', 'g.txt');
  fs.writeFileSync(p + '.swp', 'atomic\n');
  fs.renameSync(p + '.swp', p);
  await linux.sync();
  assert.equal(lf(linux.read('a/b/c/g.txt')), 'file\n');
});

test('folder moves and layout reverts work', async () => {
  fs.renameSync(linux.p('dir'), linux.p('dir2'));
  fs.renameSync(linux.p('dir2', 'x.txt'), linux.p('dir2', 'y.txt'));
  await linux.sync();
  assert.ok(linux.exists('dir2/x.txt'));
  assert.ok(!linux.exists('dir2/y.txt'));
});

test('deletes are detected after the grace window', async () => {
  fs.rmSync(linux.p('a', 'b', 'c', 'g.txt'));
  await linux.sync();
  await eventually(async () => !(await linux.status()).instances.some((i) => i.path.endsWith('g.txt')), { message: 'forgotten' });
});
