import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestUser, rejects, FIREBASE } from './helpers/server.js';

let srv, owner, editor, viewer, stranger, repo;

before(async () => {
  srv = await startTestServer({ maxFileSize: 1024 });
  owner = await new TestUser(srv.url).signup('owner@example.com');
  editor = await new TestUser(srv.url).signup('editor@example.com');
  viewer = await new TestUser(srv.url).signup('viewer@example.com');
  stranger = await new TestUser(srv.url).signup('stranger@example.com');
  repo = await owner.call('POST', '/repos', { name: 'team-config' });
});
after(() => srv?.stop());

async function manageFile(name, text) {
  const b = await owner.upload(text);
  return (await owner.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'file', name, ...b })).artifact;
}

test('auth: wrong password, refresh, unauthenticated calls', async () => {
  await rejects(new TestUser(srv.url).call('GET', '/repos'), 401);
  const bad = new TestUser(srv.url);
  bad.token = 'not-a-token';
  await rejects(bad.call('GET', '/repos'), 401);
  await rejects(owner.call('POST', '/repos', { name: 'team-config' }), 409);
  if (FIREBASE) {
    // Sign-in itself belongs to Firebase Auth; the server's password endpoints are disabled.
    assert.equal((await new TestUser(srv.url).call('GET', '/config')).auth, 'firebase');
    await rejects(new TestUser(srv.url).call('POST', '/auth/login', { email: 'owner@example.com', password: 'password123' }), 400);
    return;
  }
  await rejects(new TestUser(srv.url).call('POST', '/auth/login', { email: 'owner@example.com', password: 'nope' }), 401);
  const r = await new TestUser(srv.url).call('POST', '/auth/refresh', { refreshToken: owner.refreshToken });
  assert.equal(r.user.email, 'owner@example.com');
});

test('blob uploads are verified and size-limited', async () => {
  await rejects(owner.call('POST', '/blobs/upload', { blobs: [{ sha256: 'a'.repeat(64), size: 5000 }] }), 413);
  const { upload } = await owner.call('POST', '/blobs/upload', { blobs: [{ sha256: 'b'.repeat(64), size: 3 }] });
  const res = await fetch(upload[0].url, { method: 'PUT', body: 'abc' });
  assert.equal(res.status, 400); // content does not match its hash
  const tampered = upload[0].url.replace('size=3', 'size=4');
  assert.equal((await fetch(tampered, { method: 'PUT', body: 'abcd' })).status, 403);
  await rejects(owner.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'file', name: 'x', blob: 'c'.repeat(64), size: 1 }), 400);
});

test('pull, roles, and permission enforcement', async () => {
  const a = await manageFile('lint.json', '{"a":1}\n');
  assert.equal(a.version, 1);
  await rejects(viewer.call('GET', `/artifacts/${a.artifactId}`), 404);
  const p = await viewer.call('POST', '/pull', { shareId: a.shareId });
  assert.equal(p.role, 'viewer');
  assert.equal(await viewer.download(a.artifactId), '{"a":1}\n');
  const b = await viewer.upload('{"a":2}\n');
  await rejects(viewer.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 1, change: b }), 403);
  await rejects(viewer.call('POST', `/artifacts/${a.artifactId}/share`, { rotate: true }), 403);
  await rejects(viewer.call('POST', `/artifacts/${a.artifactId}/rollback`, { toVersion: 1 }), 403);

  await owner.call('POST', `/artifacts/${a.artifactId}/share`, { addEditor: 'editor@example.com' });
  const e = await editor.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 1, change: await editor.upload('{"a":3}\n') });
  assert.equal(e.version, 2);
  await rejects(editor.call('POST', `/artifacts/${a.artifactId}/delete`), 403);
  await rejects(editor.call('POST', `/artifacts/${a.artifactId}/rollback`, { toVersion: 1 }), 403);
});

test('commit is compare-and-set on the base version', async () => {
  const a = await manageFile('cas.txt', 'v1\n');
  await owner.call('POST', `/artifacts/${a.artifactId}/share`, { addEditor: 'editor@example.com' });
  await owner.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 1, change: await owner.upload('owner\n') });
  const err = await rejects(editor.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 1, change: await editor.upload('editor\n') }), 409);
  assert.equal(err.body.current.version, 2);
  // "push" resolution: re-commit on top of the version the user saw
  const r = await editor.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 2, change: await editor.upload('editor\n') });
  assert.equal(r.version, 3);
  const h = await owner.call('GET', `/artifacts/${a.artifactId}/history`);
  assert.deepEqual(h.map((v) => [v.version, v.author]), [[1, 'owner@example.com'], [2, 'owner@example.com'], [3, 'editor@example.com']]);

  // concurrent commits on the same base: exactly one wins
  const results = await Promise.allSettled([
    owner.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 3, change: await owner.upload('race-a\n') }),
    editor.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 3, change: await editor.upload('race-b\n') }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('rollback is forward-only and restores deletes', async () => {
  const a = await manageFile('roll.txt', 'one\n');
  await owner.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 1, change: await owner.upload('two\n') });
  await owner.call('POST', `/artifacts/${a.artifactId}/delete`);
  const r = await owner.call('POST', `/artifacts/${a.artifactId}/rollback`, { toVersion: 1 });
  assert.equal(r.version, 4);
  assert.equal(r.deleted, false);
  assert.equal(await owner.download(a.artifactId), 'one\n');
  const h = await owner.call('GET', `/artifacts/${a.artifactId}/history`);
  assert.deepEqual(h.map((v) => v.type), ['create', 'content', 'delete', 'restore']);
});

test('sync check reports changes, demotion, and rotation', async () => {
  const a = await manageFile('check.txt', 'x\n');
  await viewer.call('POST', '/pull', { shareId: a.shareId });
  await editor.call('POST', '/pull', { shareId: a.shareId });
  await owner.call('POST', `/artifacts/${a.artifactId}/share`, { addEditor: 'editor@example.com', canDelete: true });

  let [r] = (await viewer.call('POST', '/sync/check', { items: [{ artifactId: a.artifactId, version: 1 }] })).results;
  assert.equal(r.status, 'ok');
  assert.equal(r.role, 'viewer');
  await owner.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 1, change: await owner.upload('y\n') });
  [r] = (await viewer.call('POST', '/sync/check', { items: [{ artifactId: a.artifactId, version: 1 }] })).results;
  assert.equal(r.status, 'changed');
  assert.equal(r.state.version, 2);

  // demotion: editor -> viewer
  [r] = (await editor.call('POST', '/sync/check', { items: [{ artifactId: a.artifactId, version: 2 }] })).results;
  assert.deepEqual([r.role, r.canDelete], ['editor', true]);
  await owner.call('POST', `/artifacts/${a.artifactId}/share`, { demote: 'editor@example.com' });
  [r] = (await editor.call('POST', '/sync/check', { items: [{ artifactId: a.artifactId, version: 2 }] })).results;
  assert.equal(r.role, 'viewer');
  await rejects(editor.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 2, change: await editor.upload('z\n') }), 403);

  // rotation revokes link-based access, keeps allowlisted (demoted) users
  const s = await owner.call('POST', `/artifacts/${a.artifactId}/share`, { rotate: true });
  assert.notEqual(s.shareId, a.shareId);
  [r] = (await viewer.call('POST', '/sync/check', { items: [{ artifactId: a.artifactId, version: 2 }] })).results;
  assert.deepEqual([r.status, r.reason], ['gone', 'revoked']);
  [r] = (await editor.call('POST', '/sync/check', { items: [{ artifactId: a.artifactId, version: 2 }] })).results;
  assert.equal(r.status, 'ok');
  await rejects(viewer.call('POST', '/pull', { shareId: a.shareId }), 404);
  assert.equal((await viewer.call('POST', '/pull', { shareId: s.shareId })).role, 'viewer');
});

test('change cursor: an unchanged check is cheap, every kind of change moves it', async () => {
  const a = await manageFile('cursor.txt', 'one\n');
  await viewer.call('POST', '/pull', { shareId: a.shareId });
  const items = (v) => [{ artifactId: a.artifactId, version: v }];
  const check = (u, v, cursor) => u.call('POST', '/sync/check', { items: items(v), cursor });

  // a full check returns the cursor; asking again with it says "unchanged"
  let r = await check(viewer, 1);
  assert.equal(r.results[0].status, 'ok');
  assert.equal(typeof r.cursor, 'number');
  let c = r.cursor;
  assert.deepEqual(await check(viewer, 1, c), { unchanged: true, cursor: c });

  // a push by the owner moves every holder's cursor
  await owner.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 1, change: await owner.upload('two\n') });
  r = await check(viewer, 1, c);
  assert.equal(r.results[0].status, 'changed');
  assert.ok(r.cursor > c);
  c = r.cursor;
  assert.equal((await check(viewer, 2, c)).unchanged, true);

  // so do rollback, sharing changes and deletes
  await owner.call('POST', `/artifacts/${a.artifactId}/rollback`, { toVersion: 1 });
  r = await check(viewer, 2, c);
  assert.equal(r.results[0].state.version, 3);
  c = r.cursor;
  await owner.call('POST', `/artifacts/${a.artifactId}/share`, { addEditor: 'viewer@example.com' });
  r = await check(viewer, 3, c);
  assert.equal(r.results[0].role, 'editor');
  c = r.cursor;
  await owner.call('POST', `/artifacts/${a.artifactId}/share`, { revoke: 'viewer@example.com' });
  r = await check(viewer, 3, c);
  assert.deepEqual([r.results[0].status, r.results[0].reason], ['gone', 'revoked']);

  // a stranger's cursor does not move for changes they cannot see
  const sc = (await stranger.call('POST', '/sync/check', { items: [] })).cursor;
  await owner.call('POST', `/artifacts/${a.artifactId}/delete`);
  assert.equal((await stranger.call('POST', '/sync/check', { items: [], cursor: sc })).unchanged, true);
  const oc = (await owner.call('POST', '/sync/check', { items: items(4) })).cursor;
  assert.equal((await owner.call('POST', '/sync/check', { items: items(4), cursor: oc })).unchanged, true);

  // when the cursor moved, only what changed since it is looked up; files follow their folder
  const p = await manageFile('cursor-p.txt', 'p\n');
  const q = await manageFile('cursor-q.txt', 'q\n');
  const pq = [{ artifactId: p.artifactId, version: 1 }, { artifactId: q.artifactId, version: 1, root: p.artifactId }];
  const pc = (await owner.call('POST', '/sync/check', { items: pq })).cursor;
  await owner.call('POST', `/artifacts/${p.artifactId}/commit`, { baseVersion: 1, change: await owner.upload('p2\n') });
  r = await owner.call('POST', '/sync/check', { items: pq, cursor: pc });
  assert.equal(r.partial, true);
  assert.equal(r.results[0].status, 'changed');
  assert.equal(r.results[1].status, 'ok'); // root changed: checked too
  r = await owner.call('POST', '/sync/check', { items: [pq[0], { artifactId: q.artifactId, version: 1 }], cursor: pc });
  assert.equal(r.results[1], null); // unrelated and unchanged: not looked up
  // a cursor from the future or garbage gets a full answer
  r = await owner.call('POST', '/sync/check', { items: pq, cursor: 1e9 });
  assert.ok(r.results.every(Boolean));

  // realtime items always get a full answer (the check renews their lease)
  const b = await manageFile('cursor-live.txt', 'live\n');
  const bc = (await owner.call('POST', '/sync/check', { items: [{ artifactId: b.artifactId, version: 1 }] })).cursor;
  r = await owner.call('POST', '/sync/check', { items: [{ artifactId: b.artifactId, version: 1, realtime: true }], cursor: bc });
  assert.ok(r.results);
});

test('allowlist visibility', async () => {
  const a = await manageFile('private.txt', 'p\n');
  await owner.call('POST', `/artifacts/${a.artifactId}/share`, { visibility: 'allowlist', allow: ['viewer@example.com'] });
  await rejects(stranger.call('POST', '/pull', { shareId: a.shareId }), 403);
  assert.equal((await viewer.call('POST', '/pull', { shareId: a.shareId })).role, 'viewer');
  await owner.call('POST', `/artifacts/${a.artifactId}/share`, { revoke: 'viewer@example.com' });
  const [r] = (await viewer.call('POST', '/sync/check', { items: [{ artifactId: a.artifactId, version: 1 }] })).results;
  assert.equal(r.status, 'gone');
});

test('folders: layout validation, add, move, delete permission', async () => {
  const f1 = await owner.upload('one\n');
  const f2 = await owner.upload('two\n');
  await rejects(owner.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'folder', name: 'cfg', files: [{ relPath: 'README.md', ...f1 }, { relPath: 'Readme.md', ...f2 }] }), 400);
  await rejects(owner.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'folder', name: 'cfg', files: [{ relPath: 'aux.txt', ...f1 }] }), 400);
  const m = await owner.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'folder', name: 'cfg', files: [{ relPath: 'a.txt', ...f1 }, { relPath: 'sub/b.txt', ...f2 }] });
  const folder = m.artifact;
  const [a, b] = m.children;
  await owner.call('POST', `/artifacts/${folder.artifactId}/share`, { addEditor: 'editor@example.com' });

  const p = await editor.call('POST', '/pull', { shareId: folder.shareId });
  assert.equal(p.children.length, 2);
  assert.equal(p.role, 'editor');

  await rejects(editor.call('POST', `/artifacts/${folder.artifactId}/children`, { relPath: 'c.txt', ...(await editor.upload('c\n')) }), 403);
  const c = await owner.call('POST', `/artifacts/${folder.artifactId}/children`, { relPath: 'c.txt', ...(await owner.upload('c\n')) });
  await rejects(owner.call('POST', `/artifacts/${folder.artifactId}/children`, { relPath: 'C.TXT', ...(await owner.upload('c\n')) }), 400);

  // move within the folder bumps the folder's layout version
  const mv = await editor.call('POST', `/artifacts/${a.artifactId}/commit`, { baseVersion: 1, change: { relPath: 'docs/a.txt' } });
  assert.equal(mv.state.relPath, 'docs/a.txt');
  await rejects(editor.call('POST', `/artifacts/${b.artifactId}/commit`, { baseVersion: 1, change: { relPath: 'C.txt' } }), 400);
  await rejects(editor.call('POST', `/artifacts/${b.artifactId}/commit`, { baseVersion: 1, change: { deleted: true } }), 403);

  const [r] = (await editor.call('POST', '/sync/check', { items: [{ artifactId: folder.artifactId, version: 1 }] })).results;
  assert.equal(r.status, 'changed');
  assert.equal(r.version, 3); // add + move
  assert.deepEqual(r.children.map((k) => k.relPath).sort(), ['c.txt', 'docs/a.txt', 'sub/b.txt']);

  await owner.call('POST', `/artifacts/${folder.artifactId}/share`, { addEditor: 'editor@example.com', canDelete: true });
  const d = await editor.call('POST', `/artifacts/${c.artifactId}/commit`, { baseVersion: 1, change: { deleted: true } });
  assert.equal(d.state.deleted, true);
  await rejects(editor.call('POST', `/artifacts/${a.artifactId}/share`, { rotate: true }), 403);
});

test('repo transfer, purge, and account deletion', async () => {
  const r2 = await owner.call('POST', '/repos', { name: 'to-transfer' });
  const b = await owner.upload('t\n');
  const { artifact } = await owner.call('POST', '/artifacts', { repoId: r2.repoId, kind: 'file', name: 't.txt', ...b });
  await owner.call('POST', `/repos/${r2.repoId}/transfer`, { to: 'editor@example.com' });
  assert.equal((await editor.call('GET', `/artifacts/${artifact.artifactId}`)).role, 'owner');
  assert.equal((await owner.call('GET', `/artifacts/${artifact.artifactId}`)).role, 'editor');
  await rejects(owner.call('GET', `/repos/${r2.repoId}`), 404);

  await viewer.call('POST', '/pull', { shareId: artifact.shareId });
  await editor.call('DELETE', `/repos/${r2.repoId}`);
  const [r] = (await viewer.call('POST', '/sync/check', { items: [{ artifactId: artifact.artifactId, version: 1 }] })).results;
  assert.deepEqual([r.status, r.reason], ['gone', 'purged']);

  const temp = await new TestUser(srv.url).signup('temp@example.com');
  const tr = await temp.call('POST', '/repos', { name: 'mine' });
  const t = (await temp.call('POST', '/artifacts', { repoId: tr.repoId, kind: 'file', name: 'x.txt', ...(await temp.upload('x\n')) })).artifact;
  await viewer.call('POST', '/pull', { shareId: t.shareId });
  await temp.call('DELETE', '/me');
  await rejects(temp.call('GET', '/me'), FIREBASE ? 401 : 404); // Firebase: the auth account is gone too
  const [g] = (await viewer.call('POST', '/sync/check', { items: [{ artifactId: t.artifactId, version: 1 }] })).results;
  assert.equal(g.status, 'gone');
});

test('delta sync: chunk uploads are verified and fetches are limited to readable versions', async () => {
  const { sha256, chunkContent } = await import('../packages/shared/src/index.js');
  const bytes = Buffer.from('x'.repeat(800) + 'chunked content\n'); // this test server caps files at 1 KB
  const parts = chunkContent(bytes);
  const put = (u, list, body) => fetch(`${srv.url}/v1/chunks/put`, {
    method: 'POST',
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/octet-stream', 'x-tether-chunks': list.map((c) => `${c.h}:${c.s}`).join(',') },
    body,
  });
  // a chunk whose bytes do not match its hash is refused
  assert.equal((await put(owner, [{ h: 'a'.repeat(64), s: 3 }], Buffer.from('abc'))).status, 400);
  const { missing } = await owner.call('POST', '/chunks/missing', { hashes: parts.map((c) => c.h) });
  assert.equal(missing.length, new Set(parts.map((c) => c.h)).size);
  // committing before the chunks exist fails
  const manifest = parts.map(({ h, s }) => ({ h, s }));
  await rejects(owner.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'file', name: 'chunked.txt', blob: sha256(bytes), size: bytes.length, chunks: manifest }), 400);
  assert.equal((await put(owner, parts, Buffer.concat(parts.map((c) => c.bytes)))).status, 200);
  assert.deepEqual((await owner.call('POST', '/chunks/missing', { hashes: parts.map((c) => c.h) })).missing, []);
  await rejects(owner.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'file', name: 'chunked.txt', blob: sha256(bytes), size: bytes.length + 1, chunks: manifest }), 400);
  const { artifact } = await owner.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'file', name: 'chunked.txt', blob: sha256(bytes), size: bytes.length, chunks: manifest });
  const fetchChunks = (u, body) => fetch(`${srv.url}/v1/chunks/fetch`, { method: 'POST', headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const got = await fetchChunks(owner, { artifactId: artifact.artifactId, hashes: [parts[0].h] });
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), parts[0].bytes);
  // not shared with the stranger; and a hash outside the manifest is refused even for the owner
  assert.equal((await fetchChunks(stranger, { artifactId: artifact.artifactId, hashes: [parts[0].h] })).status, 404);
  assert.equal((await fetchChunks(owner, { artifactId: artifact.artifactId, hashes: ['b'.repeat(64)] })).status, 403);
  // whole-file readers (console preview, older clients) get the assembled content
  const content = await fetch(`${srv.url}/v1/artifacts/${artifact.artifactId}/content`, { headers: { authorization: `Bearer ${owner.token}` } });
  assert.equal(Buffer.from(await content.arrayBuffer()).toString(), bytes.toString());
  assert.equal(await owner.download(artifact.artifactId), bytes.toString());
});
