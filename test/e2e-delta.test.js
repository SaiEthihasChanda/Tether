// Delta sync: only changed chunks travel, in both directions; older whole-file clients still work.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, manage } from './helpers/setup.js';
import { TestUser } from './helpers/server.js';
import { eventually } from './helpers/machine.js';

let t, owner, ed, viewer, id;
const lf = (s) => s.replace(/\r\n/g, '\n');

/** About 2 MB of text: numbered lines of pseudo-random words. */
function bigText() {
  let x = 42;
  const lines = [];
  for (let i = 0; i < 40000; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    lines.push(`line ${i}: ${x.toString(36)} ${(x >> 7).toString(36)} lorem ipsum dolor sit amet`);
  }
  return lines.join('\n') + '\n';
}

const chunkCount = (logOrOut, verb) => {
  const m = [...logOrOut.matchAll(new RegExp(`${verb} (\\d+) of (\\d+) chunks?`, 'g'))].at(-1);
  return m ? { moved: Number(m[1]), total: Number(m[2]) } : null;
};

before(async () => {
  t = await setup(['owner', 'ed', 'viewer']);
  ({ owner, ed, viewer } = t);
  owner.write('big.txt', bigText());
  id = await manage(owner, 'big.txt');
  await owner.run(['share', 'big.txt', '--editor', 'ed@example.com']);
  await ed.run(['pull', id]);
  await viewer.run(['pull', id]);
});
after(() => t?.teardown());

test('a small edit pushes only the chunks around it', async () => {
  await owner.run(['edit', 'big.txt']);
  const text = lf(owner.read('big.txt'));
  const mid = text.indexOf('line 20000:');
  owner.write('big.txt', text.slice(0, mid) + 'line 20000: EDITED BY THE OWNER\n' + text.slice(text.indexOf('\n', mid) + 1));
  const r = await owner.run(['done', 'big.txt']);
  const c = chunkCount(r.stdout, 'sent');
  assert.ok(c, r.stdout);
  assert.ok(c.total > 100, `expected many chunks, got ${c.total}`);
  assert.ok(c.moved <= 3, `sent ${c.moved} of ${c.total} chunks`);
});

test('receivers download only the changed chunks and end up byte-identical', async () => {
  await viewer.sync();
  const c = chunkCount(await viewer.log(), 'received');
  assert.ok(c && c.moved <= 3 && c.total > 100, JSON.stringify(c));
  assert.equal(lf(viewer.read('big.txt')), lf(owner.read('big.txt')));
  assert.match(viewer.read('big.txt'), /line 20000: EDITED BY THE OWNER/);
});

test('live edits are pushed as deltas too', async () => {
  await ed.sync();
  await ed.run(['edit', 'big.txt', '--realtime']);
  const text = lf(ed.read('big.txt'));
  ed.write('big.txt', text.replace('line 30000:', 'line 30000: LIVE'));
  await eventually(async () => /pushed v3 \(realtime; sent \d+ of \d+ chunks/.test(await ed.log()), { timeout: 10000, message: 'live delta push' });
  const c = chunkCount(await ed.log(), 'sent');
  assert.ok(c.moved <= 3, JSON.stringify(c));
  await ed.run(['done', 'big.txt']);
  await owner.sync();
  assert.match(owner.read('big.txt'), /line 30000: LIVE/);
});

test('history and rollback work with chunked versions', async () => {
  await owner.run(['rollback', 'big.txt', '--to', '1']);
  await viewer.sync();
  assert.equal(lf(viewer.read('big.txt')), bigText());
});

test('older whole-file clients and delta clients interoperate', async () => {
  const old = await new TestUser(t.srv.url).signup('old@example.com');
  await owner.run(['share', 'big.txt', '--editor', 'old@example.com']);
  await old.call('POST', '/pull', { shareId: id });
  // an old client downloads whole files: the server assembles chunked content for it
  assert.equal(await old.download((await old.call('POST', '/pull', { shareId: id })).artifact.artifactId), bigText());
  // an old client pushes a whole file (no chunk list); delta clients still receive it
  const { artifact } = await old.call('GET', `/artifacts/${(await old.call('POST', '/pull', { shareId: id })).artifact.artifactId}`);
  const up = await old.upload('replaced by an old client\n');
  await old.call('POST', `/artifacts/${artifact.artifactId}/commit`, { baseVersion: artifact.version, change: up });
  await viewer.sync();
  assert.equal(lf(viewer.read('big.txt')), 'replaced by an old client\n');
});
