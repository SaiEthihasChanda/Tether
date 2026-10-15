// Realtime edit sessions on the server: one holder, leases, expiry, demotion.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestUser, rejects } from './helpers/server.js';

let srv, owner, ed1, ed2, viewer, file;
const TTL = 1500;

before(async () => {
  srv = await startTestServer({ realtimeTtlMs: TTL });
  owner = await new TestUser(srv.url).signup('owner@example.com');
  ed1 = await new TestUser(srv.url).signup('ed1@example.com');
  ed2 = await new TestUser(srv.url).signup('ed2@example.com');
  viewer = await new TestUser(srv.url).signup('viewer@example.com');
  const repo = await owner.call('POST', '/repos', { name: 'rt' });
  file = (await owner.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'file', name: 'live.txt', ...(await owner.upload('v1\n')) })).artifact;
  await owner.call('POST', `/artifacts/${file.artifactId}/share`, { addEditor: 'ed1@example.com' });
  await owner.call('POST', `/artifacts/${file.artifactId}/share`, { addEditor: 'ed2@example.com' });
  await viewer.call('POST', '/pull', { shareId: file.shareId });
});
after(() => srv?.stop());

const rt = (u, action, extra = {}) => u.call('POST', `/artifacts/${file.artifactId}/realtime`, { action, ...extra });
const check = async (u, realtime = false) => (await u.call('POST', '/sync/check', { items: [{ artifactId: file.artifactId, version: 1, realtime }] })).results[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('one realtime holder at a time; viewers cannot hold one', async () => {
  await rejects(rt(viewer, 'start'), 403);
  const r = await rt(ed1, 'start');
  assert.deepEqual([r.realtime.email, r.realtime.mine], ['ed1@example.com', true]);
  const err = await rejects(rt(ed2, 'start'), 409);
  assert.equal(err.body.realtime.email, 'ed1@example.com');
  await rt(ed1, 'start'); // the holder may start again (e.g. a second machine)
});

test('everyone sees the session in their check results', async () => {
  for (const u of [ed2, viewer, owner]) {
    const r = await check(u);
    assert.deepEqual([r.realtime.email, r.realtime.mine], ['ed1@example.com', false]);
  }
  assert.equal((await check(ed1)).realtime.mine, true);
  assert.equal((await owner.call('GET', `/artifacts/${file.artifactId}`)).realtime.email, 'ed1@example.com');
});

test('the holder renews the lease with every check; it expires without them', async () => {
  for (let i = 0; i < 3; i++) {
    await sleep(TTL / 2);
    await check(ed1, true);
  }
  await rejects(rt(ed2, 'start'), 409); // still held after 1.5 x TTL thanks to renewals
  await sleep(TTL + 200);
  assert.equal((await check(viewer)).realtime, null);
  await rt(ed2, 'start'); // expired: someone else may take it
  const lost = await check(ed1, true); // ed1's renewal must not steal it back
  assert.deepEqual([lost.realtime.email, lost.realtime.mine], ['ed2@example.com', false]);
});

test('stop releases; only the owner can force-stop someone else', async () => {
  await rt(ed1, 'stop'); // not the holder: no effect
  assert.equal((await check(viewer)).realtime.email, 'ed2@example.com');
  await rejects(rt(ed1, 'stop', { force: true }), 403);
  await rt(owner, 'stop', { force: true });
  assert.equal((await check(viewer)).realtime, null);
});

test('a demoted holder loses the session', async () => {
  await rt(ed2, 'start');
  await owner.call('POST', `/artifacts/${file.artifactId}/share`, { demote: 'ed2@example.com' });
  assert.equal((await check(viewer)).realtime, null);
  const r = await check(ed2, true); // viewers cannot renew
  assert.equal(r.realtime, null);
  await rt(ed1, 'start');
});
