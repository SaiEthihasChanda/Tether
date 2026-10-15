// Production smoke test: two real clients against the deployed Firebase backend.
// Usage: node test/prod-smoke.mjs [serverUrl]   (creates temporary accounts and deletes them)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Machine, eventually } from './helpers/machine.js';

const SERVER = process.argv[2] ?? 'https://tether-b10cf.web.app';
const tag = Date.now().toString(36);
const accounts = { owner: `smoke-owner-${tag}@example.com`, bob: `smoke-bob-${tag}@example.com` };
const PASSWORD = `Smoke-${tag}-pw!`;
const lf = (s) => s.replace(/\r\n/g, '\n');
const step = (s) => console.log(`- ${s}`);

const owner = await new Machine(SERVER, 'prod-owner').start();
const bob = await new Machine(SERVER, 'prod-bob').start();
try {
  await owner.run(['login', '--email', accounts.owner, '--password', PASSWORD, '--signup']);
  await bob.run(['login', '--email', accounts.bob, '--password', PASSWORD, '--signup']);
  step('signed up two Firebase accounts through the CLI');

  await owner.run(['repo', 'create', 'smoke']);
  owner.write('cfg.txt', 'v1\n');
  owner.write('kit/a.txt', 'a\n');
  owner.write('kit/sub/b.bin', '\u0000binary\r\n');
  const fileId = (await owner.run(['manage', 'cfg.txt', '--repo', 'smoke'])).stdout.match(/share ID: (\S+)/)[1];
  const kitId = (await owner.run(['manage', 'kit', '--repo', 'smoke'])).stdout.match(/share ID: (\S+)/)[1];
  step('uploaded a file and a folder (signed Cloud Storage URLs)');

  await bob.run(['pull', fileId]);
  await bob.run(['pull', kitId]);
  assert.equal(lf(bob.read('cfg.txt')), 'v1\n');
  assert.deepEqual(fs.readFileSync(bob.p('kit/sub/b.bin')), fs.readFileSync(owner.p('kit/sub/b.bin')));
  step('pulled both on the second client; binary content is byte-exact');

  bob.write('cfg.txt', 'tampered\n');
  await bob.sync();
  assert.equal(lf(bob.read('cfg.txt')), 'v1\n');
  step('local edit reverted');

  await owner.run(['edit', 'cfg.txt']);
  owner.write('cfg.txt', 'v2\n');
  assert.match((await owner.run(['done', 'cfg.txt'])).stdout, /-> v2/);
  await bob.sync();
  assert.equal(lf(bob.read('cfg.txt')), 'v2\n');
  step('owner edit pushed and received');

  await owner.run(['share', 'cfg.txt', '--editor', accounts.bob]);
  await bob.sync();
  await owner.run(['edit', 'cfg.txt']);
  await bob.run(['edit', 'cfg.txt']);
  owner.write('cfg.txt', 'owner\n');
  bob.write('cfg.txt', 'bob\n');
  await owner.run(['done', 'cfg.txt']);
  await bob.run(['done', 'cfg.txt', '--resolve', 'keep-both']);
  assert.equal(lf(bob.read('cfg.txt')), 'owner\n');
  assert.equal(bob.read('cfg (local copy).txt'), 'bob\n');
  step('conflict detected by the Firestore transaction; keep-both worked');

  const h = (await owner.run(['history', 'cfg.txt'])).stdout;
  assert.match(h, /v3 /);
  await owner.run(['rollback', 'cfg.txt', '--to', '1']);
  await bob.sync();
  assert.equal(lf(bob.read('cfg.txt')), 'v1\n');
  step('history and rollback');

  await bob.sync();
  await bob.run(['edit', 'cfg.txt', '--realtime']);
  const refused = await owner.run(['edit', 'cfg.txt', '--realtime'], { allowFail: true });
  assert.match(refused.stderr, /already being edited in realtime/);
  bob.write('cfg.txt', 'live from bob\n');
  await eventually(async () => /pushed v\d+ \(realtime\)/.test(await bob.log()), { timeout: 15000, message: 'live push' });
  await owner.sync();
  assert.equal(lf(owner.read('cfg.txt')), 'live from bob\n');
  await bob.run(['done', 'cfg.txt']);
  step('realtime: live push without done; second live editor refused');

  await owner.run(['share', 'cfg.txt', '--demote', accounts.bob]);
  await owner.run(['share', 'kit', '--rotate-id']);
  await bob.sync();
  const st = (await bob.status()).instances;
  assert.equal(st.find((i) => i.path.endsWith('cfg.txt')).role, 'viewer');
  assert.ok(st.filter((i) => i.path.includes('kit')).every((i) => i.mode === 'orphaned'));
  step('demotion and share-ID rotation');

  const t0 = Date.now();
  await bob.sync();
  step(`one idle sync round trip: ${Date.now() - t0} ms`);

  await owner.run(['repo', 'delete', 'smoke', '--yes']);
  await bob.sync();
  await eventually(async () => (await bob.status()).instances.every((i) => i.mode === 'orphaned'), { message: 'orphaned after purge' });
  step('repo purge orphaned every copy (files kept on disk)');
} finally {
  // Delete the temporary accounts (Firebase Auth user + Tether profile).
  const { apiKey } = await (await fetch(`${SERVER}/v1/config`)).json();
  for (const email of Object.values(accounts)) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    }).then((x) => x.json());
    if (!r.idToken) continue;
    const del = await fetch(`${SERVER}/v1/me`, { method: 'DELETE', headers: { authorization: `Bearer ${r.idToken}` } });
    console.log(`- deleted ${email}: HTTP ${del.status}`);
  }
  await owner.stop();
  await bob.stop();
}
console.log('production smoke test passed');
