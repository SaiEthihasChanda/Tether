// `tether edit --realtime`: live pushes, one holder per file, warnings for plain edits.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, manage } from './helpers/setup.js';
import { eventually } from './helpers/machine.js';

let t, owner, ann, ben, viewer;
const lf = (s) => s.replace(/\r\n/g, '\n');
const inst = async (m, name) => (await m.status()).instances.find((i) => i.path.endsWith(name));

before(async () => {
  // ann edits live; her daemon must push on its own (watchers + 3 s realtime cadence).
  t = await setup(['owner', 'ann', 'ben', 'viewer'], { ann: { tickSeconds: 30 }, viewer: { tickSeconds: 30 } });
  ({ owner, ann, ben, viewer } = t);
  owner.write('live.md', 'one\n');
  const id = await manage(owner, 'live.md');
  await owner.run(['share', 'live.md', '--editor', 'ann@example.com']);
  await owner.run(['share', 'live.md', '--editor', 'ben@example.com']);
  for (const m of [ann, ben, viewer]) await m.run(['pull', id]);
});
after(() => t?.teardown());

test('viewers cannot edit in realtime', async () => {
  const r = await viewer.run(['edit', 'live.md', '--realtime'], { allowFail: true });
  assert.match(r.stderr, /needs editor access/);
});

test('realtime pushes every save without `tether done`', async () => {
  const r = await ann.run(['edit', 'live.md', '--realtime']);
  assert.match(r.stdout, /in realtime/);
  assert.ok((await inst(ann, 'live.md')).flags.some((f) => /realtime: your saves are pushed live/.test(f)));
  ann.write('live.md', 'one\ntwo\n');
  // No sync call: ann's daemon pushes by itself after the save.
  await eventually(async () => /pushed v2 \(realtime\)/.test(await ann.log()), { timeout: 8000, message: 'live push' });
  await owner.sync();
  assert.equal(lf(owner.read('live.md')), 'one\ntwo\n');
});

test('a second editor cannot start realtime on the same file', async () => {
  const r = await ben.run(['edit', 'live.md', '--realtime'], { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /already being edited in realtime by ann@example.com/);
  assert.match(r.stderr, /without --realtime, but expect merge conflicts/);
  assert.equal((await inst(ben, 'live.md')).mode, 'normal'); // nothing changed
});

test('a plain edit is allowed, with a merge-conflict warning', async () => {
  const r = await ben.run(['edit', 'live.md']);
  assert.match(r.stdout, /warning: .*live.md is being edited in realtime by ann@example.com/);
  assert.match(r.stdout, /expect merge conflicts/);
  assert.equal((await inst(ben, 'live.md')).mode, 'editing');
});

test('others see the live session and receive changes on the faster cadence', async () => {
  await viewer.sync();
  assert.ok((await inst(viewer, 'live.md')).flags.includes('realtime edits by ann@example.com'));
  ann.write('live.md', 'one\ntwo\nthree\n');
  // viewer is on a 30 s tick; the realtime cadence (3 s) must deliver it without a manual sync.
  await eventually(() => lf(viewer.read('live.md')) === 'one\ntwo\nthree\n', { timeout: 12000, message: 'viewer receives live edit' });
});

test("the plain editor's done conflicts with the live edits", async () => {
  ben.write('live.md', 'ben was here\n');
  const r = await ben.run(['done', 'live.md'], { allowFail: true });
  assert.match(r.stderr, /needs a decision/);
  await ben.run(['done', 'live.md', '--resolve', 'keep-both']);
  assert.equal(lf(ben.read('live.md')), 'one\ntwo\nthree\n');
});

test('if someone pushes over unsent live changes, live pushing pauses until done', async () => {
  await ben.sync();
  await ben.run(['edit', 'live.md']);
  ben.write('live.md', 'ben pushes\n');
  await ben.run(['done', 'live.md']); // v4 from ben while ann is still live
  await ann.ipc('shutdown'); // stop ann's daemon so her next save is not pushed before ben's lands
  await new Promise((r) => setTimeout(r, 500));
  ann.write('live.md', 'ann unsent\n');
  await ann.start();
  await ann.sync();
  const s = await inst(ann, 'live.md');
  assert.ok(s.flags.some((f) => /conflict/.test(f)), s.flags.join());
  assert.equal(ann.read('live.md'), 'ann unsent\n'); // nothing lost
  await ann.run(['done', 'live.md', '--resolve', 'push']);
  await owner.sync();
  assert.equal(lf(owner.read('live.md')), 'ann unsent\n');
});

test('done ends the session; another editor can then go live', async () => {
  assert.equal((await inst(ann, 'live.md')).mode, 'normal');
  await viewer.sync();
  assert.ok(!(await inst(viewer, 'live.md')).flags.some((f) => /realtime/.test(f)));
  await ben.sync();
  await ben.run(['edit', 'live.md', '--realtime']);
  await ben.run(['unmanage', 'live.md']); // unmanage also ends a live session
  await ann.run(['edit', 'live.md', '--realtime']);
  await ann.run(['done', 'live.md']);
});
