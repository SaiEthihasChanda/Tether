// Desktop notifications (captured to a file in tests): grouping, event types, settings.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, manage } from './helpers/setup.js';
import { eventually, sleep } from './helpers/machine.js';

let t, owner, ed, viewer, ids;
const last = (m) => m.notifications().at(-1);

before(async () => {
  t = await setup(['owner', 'ed', 'viewer']);
  ({ owner, ed, viewer } = t);
  ids = [];
  for (const n of ['a.txt', 'b.txt', 'c.txt']) {
    owner.write(n, `${n}\n`);
    ids.push(await manage(owner, n));
  }
  for (const id of ids) await viewer.run(['pull', id]);
  await owner.run(['share', 'a.txt', '--editor', 'ed@example.com']);
  await ed.run(['pull', ids[0]]);
});
after(() => t?.teardown());

test('a burst of reverts becomes one notification that links to the console', async () => {
  for (const n of ['a.txt', 'b.txt', 'c.txt']) viewer.write(n, 'tampered\n');
  await viewer.sync();
  await eventually(() => viewer.notifications().length === 1, { timeout: 6000, message: 'one grouped notification' });
  const n = last(viewer);
  assert.match(n.title, /^Tether undid your change \(\+2 more\)$/);
  assert.match(n.body, /tether edit/);
  assert.equal(n.level, 'info');
  assert.match(n.url, /^http:\/\/127\.0\.0\.1:\d+$/); // several files: the console home
});

test('access revoked is a warning that names the file', async () => {
  await owner.run(['share', 'c.txt', '--rotate-id']);
  await viewer.sync();
  await eventually(() => last(viewer)?.title === 'No longer synced', { timeout: 6000, message: 'revoked notification' });
  assert.match(last(viewer).body, /c\.txt: access revoked/);
  assert.equal(last(viewer).level, 'warn');
});

test('losing a live session is reported to the live editor', async () => {
  await ed.run(['edit', 'a.txt', '--realtime']);
  await owner.run(['share', 'a.txt', '--demote', 'ed@example.com']);
  await ed.sync();
  await eventually(() => ed.notifications().some((n) => n.title === 'You are now a viewer' || n.title === 'Live editing stopped'), { timeout: 6000, message: 'demotion notice' });
});

test('notifications can be limited to errors, or turned off', async () => {
  await viewer.run(['config', 'set', 'notifications', 'errors']);
  const before = viewer.notifications().length;
  viewer.write('a.txt', 'tampered again\n');
  await viewer.sync();
  await sleep(4000);
  assert.equal(viewer.notifications().length, before); // a revert is only "info"
  await viewer.run(['config', 'set', 'notifications', 'off']);
  const bad = await viewer.run(['config', 'set', 'notifications', 'sometimes'], { allowFail: true });
  assert.match(bad.stderr, /all, errors or off/);
});
