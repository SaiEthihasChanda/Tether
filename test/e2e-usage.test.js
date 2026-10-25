// Usage view: daemons report the copies they hold (device name, state; never paths); the owner
// stops syncing one device's copy without revoking access; that user can track it again.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { setup, manage } from './helpers/setup.js';
import { Machine, eventually } from './helpers/machine.js';

let t, owner, bob, bob2, ownerUid, artifactId;
const lf = (s) => s.replace(/\r\n/g, '\n');
const inst = async (m, end) => (await m.status()).instances.find((i) => i.path.endsWith(end));
const usage = () => t.srv.service.usage(ownerUid, artifactId);

before(async () => {
  t = await setup(['owner', 'bob']);
  ({ owner, bob } = t);
  bob2 = await new Machine(t.srv.url, 'bob2').start(); // Bob's second computer
  await bob2.run(['login', '--email', 'bob@example.com', '--password', 'password123']);
  owner.write('team.cfg', 'one\n');
  const shareId = await manage(owner, 'team.cfg');
  await bob.run(['pull', shareId]);
  await bob2.run(['pull', shareId]);
  ownerUid = (await t.srv.store.userByEmail('owner@example.com'))._id;
  artifactId = (await inst(owner, 'team.cfg')).artifactId;
});
after(async () => {
  await bob2?.stop();
  await t?.teardown();
});

test('devices report their copies; a custom device name replaces the computer name', async () => {
  await bob2.run(['config', 'set', 'devicename', 'Bob work desktop']); // any letter case
  for (const m of [owner, bob, bob2]) await m.sync();
  const u = await eventually(async () => { const x = await usage(); return x.copies === 3 && x; }, { message: 'three copies reported' });
  assert.deepEqual([u.devices, u.accounts.length], [3, 2]);
  const b = u.accounts.find((a) => a.email === 'bob@example.com');
  assert.deepEqual(b.devices.map((d) => d.name).sort(), ['Bob work desktop', os.hostname()].sort());
  assert.ok(b.devices.every((d) => d.copies[0].mode === 'normal' && d.platform === process.platform));
  assert.ok(!JSON.stringify(u).includes(bob.dir) && !JSON.stringify(u).includes(bob2.dir), 'no local paths');
});

test('the owner stops syncing one device: file kept, user notified, other device unaffected', async () => {
  const b = (await usage()).accounts.find((a) => a.email === 'bob@example.com');
  const work = b.devices.find((d) => d.name === 'Bob work desktop');
  await t.srv.service.unmanageFor(ownerUid, artifactId, { instanceIds: work.copies.map((c) => c.instanceId) });
  await bob2.sync();
  assert.equal((await inst(bob2, 'team.cfg')).mode, 'unmanaged');
  await eventually(() => bob2.notifications().some((n) => n.title === 'The owner stopped syncing a file' && /tether track team\.cfg/.test(n.body)), { timeout: 8000, message: 'notification' });
  assert.equal((await inst(bob, 'team.cfg')).mode, 'normal');
  // the confirmation reaches the owner's view
  await eventually(async () => (await usage()).accounts.find((a) => a.email === 'bob@example.com').devices.find((d) => d.name === 'Bob work desktop').copies[0].mode === 'unmanaged', { message: 'unmanaged reported' });

  await owner.run(['edit', 'team.cfg']);
  owner.write('team.cfg', 'two\n');
  await owner.run(['done', 'team.cfg']);
  await bob.sync();
  await bob2.sync();
  assert.equal(lf(bob.read('team.cfg')), 'two\n');
  assert.equal(lf(bob2.read('team.cfg')), 'one\n'); // kept as it was
});

test('access is not revoked: tether track syncs it again', async () => {
  await bob2.run(['track', 'team.cfg']);
  assert.equal(lf(bob2.read('team.cfg')), 'two\n');
  assert.equal((await inst(bob2, 'team.cfg')).mode, 'normal');
  await bob2.sync(); // the request was confirmed, so it is not applied again
  assert.equal((await inst(bob2, 'team.cfg')).mode, 'normal');
});
