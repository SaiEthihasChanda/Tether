// Phase 3: roles, demotion, rotation, allowlist, delete for everyone, repo purge.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, manage } from './helpers/setup.js';

let t, owner, ed, viewer, outsider;

before(async () => {
  t = await setup(['owner', 'ed', 'viewer', 'outsider']);
  ({ owner, ed, viewer, outsider } = t);
});
after(() => t?.teardown());

const inst = async (m, name) => (await m.status()).instances.find((i) => i.path.endsWith(name));
const lf = (s) => s.replace(/\r\n/g, '\n');

test('share shows and changes settings; only the owner can change them', async () => {
  owner.write('s.txt', 'shared\n');
  const id = await manage(owner, 's.txt');
  const s = await owner.run(['share', 's.txt', '--editor', 'ed@example.com', '--can-delete']);
  assert.match(s.stdout, /editors: +ed@example.com \(can delete\)/);
  assert.match(s.stdout, new RegExp(`share ID: +${id}`));
  await ed.run(['pull', id]);
  const r = await ed.run(['share', 's.txt', '--rotate-id'], { allowFail: true });
  assert.match(r.stderr, /only the owner/);
  const unknown = await owner.run(['share', 's.txt', '--editor', 'nobody@example.com'], { allowFail: true });
  assert.match(unknown.stderr, /no Tether user/);
});

test('demotion ends an edit session and reverts local work', async () => {
  owner.write('d.txt', 'original\n');
  const id = await manage(owner, 'd.txt');
  await owner.run(['share', 'd.txt', '--editor', 'ed@example.com']);
  await ed.run(['pull', id]);
  assert.equal((await inst(ed, 'd.txt')).role, 'editor');
  await ed.run(['edit', 'd.txt']);
  ed.write('d.txt', 'unpushed work\n');
  await owner.run(['share', 'd.txt', '--demote', 'ed@example.com']);
  await ed.sync();
  const s = await inst(ed, 'd.txt');
  assert.deepEqual([s.mode, s.role], ['normal', 'viewer']);
  assert.equal(lf(ed.read('d.txt')), 'original\n');
  assert.match(await ed.log(), /you are now a viewer/);
});

test('rotating the share ID orphans link-only users but keeps editors', async () => {
  owner.write('r.txt', 'rotate me\n');
  const id = await manage(owner, 'r.txt');
  await owner.run(['share', 'r.txt', '--editor', 'ed@example.com']);
  await ed.run(['pull', id]);
  await viewer.run(['pull', id]);
  const s = await owner.run(['share', 'r.txt', '--rotate-id']);
  const newId = s.stdout.match(/share ID: +(\S+)/)[1];
  assert.notEqual(newId, id);
  await viewer.sync();
  await ed.sync();
  const v = await inst(viewer, 'r.txt');
  assert.equal(v.mode, 'orphaned');
  assert.ok(v.flags.includes('revoked'));
  assert.equal(lf(viewer.read('r.txt')), 'rotate me\n'); // the file stays
  viewer.write('r.txt', 'mine now\n');
  await viewer.sync();
  assert.equal(viewer.read('r.txt'), 'mine now\n');
  assert.equal((await inst(ed, 'r.txt')).mode, 'normal');
  const old = await outsider.run(['pull', id], { allowFail: true });
  assert.match(old.stderr, /no artifact with that share ID/);
  await outsider.run(['pull', newId]);
});

test('allowlist visibility blocks other users even with the share ID', async () => {
  owner.write('p.txt', 'private\n');
  const id = await manage(owner, 'p.txt');
  await owner.run(['share', 'p.txt', '--visibility', 'allowlist', '--allow', 'viewer@example.com']);
  const r = await outsider.run(['pull', id], { allowFail: true });
  assert.match(r.stderr, /allowlist/);
  await viewer.run(['pull', id]);
  await owner.run(['share', 'p.txt', '--revoke', 'viewer@example.com']);
  await viewer.sync();
  assert.equal((await inst(viewer, 'p.txt')).mode, 'orphaned');
});

test('delete for everyone orphans copies; the owner can restore with rollback', async () => {
  owner.write('x.txt', 'to delete\n');
  const id = await manage(owner, 'x.txt');
  await viewer.run(['pull', id]);
  const no = await viewer.run(['delete', 'x.txt', '--yes'], { allowFail: true });
  assert.match(no.stderr, /delete permission/);
  await owner.run(['delete', 'x.txt', '--yes']);
  await viewer.sync();
  await owner.sync();
  assert.equal((await inst(viewer, 'x.txt')).mode, 'orphaned');
  assert.equal(viewer.exists('x.txt'), true);
  await owner.run(['rollback', 'x.txt', '--to', '1']);
  const h = (await owner.run(['history', 'x.txt'])).stdout;
  assert.match(h, /v3 .*restore \(to v1\)/);
  await outsider.run(['pull', id]);
  assert.equal(lf(outsider.read('x.txt')), 'to delete\n');
});

test('owner rollback reaches everyone as an incoming change', async () => {
  owner.write('rb.txt', 'v1\n');
  const id = await manage(owner, 'rb.txt');
  await viewer.run(['pull', id]);
  await owner.run(['edit', 'rb.txt']);
  owner.write('rb.txt', 'v2 bad\n');
  await owner.run(['done', 'rb.txt']);
  await viewer.sync();
  assert.equal(lf(viewer.read('rb.txt')), 'v2 bad\n');
  const r = await viewer.run(['rollback', 'rb.txt', '--to', '1'], { allowFail: true });
  assert.match(r.stderr, /only the owner/);
  await owner.run(['rollback', 'rb.txt', '--to', '1']);
  await viewer.sync();
  await owner.sync();
  assert.equal(lf(viewer.read('rb.txt')), 'v1\n');
  assert.equal(lf(owner.read('rb.txt')), 'v1\n');
});

test('repo transfer and repo delete', async () => {
  await owner.run(['repo', 'create', 'temp']);
  owner.write('t.txt', 'temp\n');
  const r = await owner.run(['manage', 't.txt', '--repo', 'temp']);
  const id = r.stdout.match(/share ID: (\S+)/)[1];
  await viewer.run(['pull', id]);
  const show = await owner.run(['repo', 'show', 'temp']);
  assert.match(show.stdout, new RegExp(`t.txt +share ${id}`));
  await owner.run(['repo', 'transfer', 'temp', '--to', 'ed@example.com']);
  assert.match((await ed.run(['repo', 'list'])).stdout, /temp/);
  await owner.sync();
  assert.equal((await inst(owner, 't.txt')).role, 'editor');
  const del = await owner.run(['repo', 'delete', 'temp', '--yes'], { allowFail: true });
  assert.match(del.stderr, /no repo "temp"/);
  await ed.run(['repo', 'delete', 'temp', '--yes']);
  await viewer.sync();
  await owner.sync();
  for (const m of [viewer, owner]) {
    const s = await inst(m, 't.txt');
    assert.equal(s.mode, 'orphaned');
    assert.ok(m.exists('t.txt'));
  }
});

test('repo eol rules apply to new files', async () => {
  await owner.run(['repo', 'eol', 'team', '*.cfg', 'crlf']);
  owner.write('rules.cfg', 'a\nb\n');
  const id = await manage(owner, 'rules.cfg');
  owner.write('script.sh', 'echo hi\n');
  const sh = await manage(owner, 'script.sh');
  await viewer.run(['pull', id]);
  await viewer.run(['pull', sh]);
  assert.equal(viewer.read('rules.cfg'), 'a\r\nb\r\n');
  assert.equal(viewer.read('script.sh'), 'echo hi\n'); // .sh is always LF, even on Windows
});
