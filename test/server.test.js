import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestUser, rejects } from './helpers/server.js';

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
  await rejects(new TestUser(srv.url).call('POST', '/auth/login', { email: 'owner@example.com', password: 'nope' }), 401);
  await rejects(new TestUser(srv.url).call('GET', '/repos'), 401);
  const r = await new TestUser(srv.url).call('POST', '/auth/refresh', { refreshToken: owner.refreshToken });
  assert.equal(r.user.email, 'owner@example.com');
  await rejects(owner.call('POST', '/repos', { name: 'team-config' }), 409);
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
  await rejects(temp.call('GET', '/me'), 404);
  const [g] = (await viewer.call('POST', '/sync/check', { items: [{ artifactId: t.artifactId, version: 1 }] })).results;
  assert.equal(g.status, 'gone');
});
