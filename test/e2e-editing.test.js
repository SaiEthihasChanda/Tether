// Phase 2: editing mode, `done` with base-version conflicts, unmanage/track, diff.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, manage } from './helpers/setup.js';

let t, owner, ed, viewer;

before(async () => {
  t = await setup(['owner', 'ed', 'viewer']);
  ({ owner, ed, viewer } = t);
});
after(() => t?.teardown());

async function shared(name, text) {
  owner.write(name, text);
  const id = await manage(owner, name);
  await owner.run(['share', name, '--editor', 'ed@example.com']);
  await ed.run(['pull', id]);
  await viewer.run(['pull', id]);
  return id;
}

const inst = async (m, name) => (await m.status()).instances.find((i) => i.path.endsWith(name));
const lf = (s) => s.replace(/\r\n/g, '\n');

test('editing keeps local changes and records incoming as pending; done applies it', async () => {
  await shared('a.txt', 'v1\n');
  await viewer.run(['edit', 'a.txt']);
  await owner.run(['edit', 'a.txt']);
  owner.write('a.txt', 'v2\n');
  await owner.run(['done', 'a.txt']);
  await viewer.sync();
  assert.equal(lf(viewer.read('a.txt')), 'v1\n');
  const s = await inst(viewer, 'a.txt');
  assert.equal(s.mode, 'editing');
  assert.ok(s.flags.includes('incoming v2'), s.flags.join());
  const d = await viewer.run(['done', 'a.txt']);
  assert.match(d.stdout, /accept/);
  assert.equal(lf(viewer.read('a.txt')), 'v2\n');
  assert.equal((await inst(viewer, 'a.txt')).mode, 'normal');
});

test('done with no changes and nothing incoming is clean', async () => {
  await ed.sync();
  await ed.run(['edit', 'a.txt']);
  const d = await ed.run(['done', 'a.txt']);
  assert.match(d.stdout, /clean/);
});

test('conflict: push overwrites, and the overwritten version stays in history', async () => {
  await shared('b.txt', 'base\n');
  await owner.run(['edit', 'b.txt']);
  await ed.run(['edit', 'b.txt']);
  owner.write('b.txt', 'owner change\n');
  ed.write('b.txt', 'editor change\n');
  await owner.run(['done', 'b.txt']);
  const noTty = await ed.run(['done', 'b.txt'], { allowFail: true });
  assert.notEqual(noTty.code, 0);
  assert.match(noTty.stderr, /needs a decision; rerun with --resolve <push\|accept\|keep-both\|cancel>/);
  assert.equal((await inst(ed, 'b.txt')).mode, 'editing');
  const r = await ed.run(['done', 'b.txt', '--resolve', 'push']);
  assert.match(r.stdout, /push .* -> v3/);
  await owner.sync();
  assert.equal(lf(owner.read('b.txt')), 'editor change\n');
  const h = (await owner.run(['history', 'b.txt'])).stdout;
  assert.match(h, /v2 .*owner@example.com/);
  assert.match(h, /v3 .*ed@example.com/);
});

test('conflict: accept discards local changes', async () => {
  await owner.run(['edit', 'b.txt']);
  await ed.run(['edit', 'b.txt']);
  owner.write('b.txt', 'owner wins\n');
  ed.write('b.txt', 'editor loses\n');
  await owner.run(['done', 'b.txt']);
  await ed.run(['done', 'b.txt', '--resolve', 'accept']);
  assert.equal(lf(ed.read('b.txt')), 'owner wins\n');
});

test('conflict: keep both saves an unmanaged local copy', async () => {
  await owner.run(['edit', 'b.txt']);
  await ed.run(['edit', 'b.txt']);
  owner.write('b.txt', 'owner again\n');
  ed.write('b.txt', 'editor work\n');
  await owner.run(['done', 'b.txt']);
  const r = await ed.run(['done', 'b.txt', '--resolve', 'keep-both']);
  assert.match(r.stdout, /b \(local copy\)\.txt/);
  assert.equal(lf(ed.read('b.txt')), 'owner again\n');
  assert.equal(ed.read('b (local copy).txt'), 'editor work\n');
  ed.write('b (local copy).txt', 'still mine\n');
  await ed.sync();
  assert.equal(ed.read('b (local copy).txt'), 'still mine\n');
});

test('viewers can edit locally but never push', async () => {
  await viewer.run(['edit', 'b.txt']);
  viewer.write('b.txt', 'viewer edit\n');
  const r = await viewer.run(['done', 'b.txt', '--resolve', 'push'], { allowFail: true });
  assert.match(r.stderr, /"push" is not possible here \(options: accept, keep-both, cancel\)/);
  await viewer.run(['done', 'b.txt', '--resolve', 'cancel']);
  assert.equal((await inst(viewer, 'b.txt')).mode, 'editing');
  await viewer.run(['done', 'b.txt', '--resolve', 'keep-both']);
  assert.equal(lf(viewer.read('b.txt')), 'owner again\n');
  assert.equal(viewer.read('b (local copy).txt'), 'viewer edit\n');
});

test('a line-ending-only change is not a change', async () => {
  await ed.run(['edit', 'a.txt']);
  ed.write('a.txt', lf(ed.read('a.txt')).replace(/\n/g, '\r\n'));
  fs.writeFileSync(ed.p('a.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(ed.p('a.txt'))]));
  const r = await ed.run(['done', 'a.txt']);
  assert.match(r.stdout, /clean/);
});

test('unmanage keeps changes and ignores incoming; track resolves divergence', async () => {
  await shared('c.txt', 'one\n');
  await viewer.run(['unmanage', 'c.txt']);
  viewer.write('c.txt', 'my version\n');
  await owner.run(['edit', 'c.txt']);
  owner.write('c.txt', 'two\n');
  await owner.run(['done', 'c.txt']);
  await viewer.sync();
  assert.equal(viewer.read('c.txt'), 'my version\n');
  assert.equal((await inst(viewer, 'c.txt')).mode, 'unmanaged');

  // moves are still followed while unmanaged
  fs.renameSync(viewer.p('c.txt'), viewer.p('c-moved.txt'));
  await viewer.sync();
  assert.equal((await inst(viewer, 'c-moved.txt')).mode, 'unmanaged');

  const r = await viewer.run(['track', 'c-moved.txt'], { allowFail: true });
  assert.match(r.stderr, /needs a decision/);
  await viewer.run(['track', 'c-moved.txt', '--resolve', 'accept']);
  assert.equal(lf(viewer.read('c-moved.txt')), 'two\n');
  assert.equal((await inst(viewer, 'c-moved.txt')).mode, 'normal');
});

test('track never pushes implicitly, even for an editor', async () => {
  await ed.run(['unmanage', 'c.txt']);
  ed.write('c.txt', 'editor offline work\n');
  const r = await ed.run(['track', 'c.txt'], { allowFail: true });
  assert.match(r.stderr, /needs a decision; rerun with --resolve <push\|accept\|keep-both\|cancel>/);
  await ed.run(['track', 'c.txt', '--resolve', 'push']);
  await owner.sync();
  assert.equal(lf(owner.read('c.txt')), 'editor offline work\n');
});

test('track with no local changes simply catches up', async () => {
  await viewer.run(['unmanage', 'c-moved.txt']);
  await viewer.sync();
  await viewer.run(['track', 'c-moved.txt']);
  assert.equal(lf(viewer.read('c-moved.txt')), 'editor offline work\n');
});

test('diff shows server vs local', async () => {
  await ed.run(['edit', 'c.txt']);
  ed.write('c.txt', 'editor offline work\nmore\n');
  const d = await ed.run(['diff', 'c.txt']);
  assert.match(d.stdout, /\(server v\d+\)/);
  assert.match(d.stdout, /^\+more$/m);
  await ed.run(['done', 'c.txt']);
});

test('edit on an unmanaged file points to track', async () => {
  await viewer.run(['unmanage', 'c-moved.txt']);
  const r = await viewer.run(['edit', 'c-moved.txt'], { allowFail: true });
  assert.match(r.stderr, /use `tether track` first/);
  await viewer.run(['track', 'c-moved.txt']);
});
