// HTTP API. Every mutation goes through TetherService, mirroring the planned
// Cloud Functions layer (clients never write to the database or blob store directly).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, badRequest, notFound } from './errors.js';

export function createApp({ service, auth, consoleDir, maxFileSize }) {
  const app = express();
  app.disable('x-powered-by');

  // Blob transfer endpoints for the local blob store (Cloud Storage serves its own signed URLs).
  if (service.blobs.receive !== false) app.put('/blobs/:sha', express.raw({ type: () => true, limit: maxFileSize + 1024 }), async (req, res) => {
    await service.receiveBlob(req.params.sha, req.query, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    res.status(204).end();
  });
  if (service.blobs.receive !== false) app.get('/blobs/:sha', async (req, res) => {
    if (!service.blobs.verify('get', req.params.sha, req.query)) throw new HttpError(403, 'forbidden', 'download URL invalid or expired');
    res.type('application/octet-stream').send(await service.blobs.read(req.params.sha));
  });

  const api = express.Router();
  api.use(express.json({ limit: '5mb' }));

  // public client configuration: which auth system to use
  api.get('/config', (_req, res) => res.json({ ...auth.publicConfig(), maxFileSize }));

  // auth
  api.post('/auth/signup', async (req, res) => res.json(await auth.signup(req.body)));
  api.post('/auth/login', async (req, res) => res.json(await auth.login(req.body)));
  api.post('/auth/refresh', async (req, res) => res.json(await auth.refresh(req.body.refreshToken)));
  api.post('/auth/logout', async (req, res) => {
    await auth.logout(req.body.refreshToken);
    res.json({ ok: true });
  });
  api.post('/auth/cli-exchange', async (req, res) => res.json(await auth.exchangeCliCode(req.body.code)));

  // everything below requires a signed-in user
  api.use(async (req, _res, next) => {
    const h = req.get('authorization') || '';
    req.uid = await auth.verify(h.startsWith('Bearer ') ? h.slice(7) : '');
    next();
  });

  api.post('/auth/cli-code', async (req, res) => res.json({ code: await auth.cliCode(req.uid) }));
  // usage: daemons report the copies they hold; owners see them and can stop syncing them
  api.post('/instances/report', async (req, res) => res.json(await service.reportInstances(req.uid, req.body)));
  api.get('/artifacts/:id/usage', async (req, res) => res.json(await service.usage(req.uid, req.params.id)));
  api.post('/artifacts/:id/unmanage', async (req, res) => res.json(await service.unmanageFor(req.uid, req.params.id, req.body)));
  // push: daemons listen to their own change feed document (Firebase backends only)
  api.post('/feed/token', async (req, res) => {
    if (!auth.feedToken) throw notFound('this server has no push channel; clients poll');
    res.json({ uid: req.uid, ...(await auth.feedToken(req.uid)) });
  });
  api.get('/me', async (req, res) => res.json(await service.me(req.uid)));
  api.delete('/me', async (req, res) => {
    await service.deleteAccount(req.uid);
    await auth.deleteUser?.(req.uid);
    res.json({ ok: true });
  });
  api.get('/shared', async (req, res) => res.json(await service.sharedWithMe(req.uid)));

  // repos
  api.get('/repos', async (req, res) => res.json(await service.listRepos(req.uid)));
  api.post('/repos', async (req, res) => res.json(await service.createRepo(req.uid, req.body)));
  api.get('/repos/:id', async (req, res) => res.json(await service.getRepo(req.uid, req.params.id)));
  api.patch('/repos/:id', async (req, res) => res.json(await service.updateRepo(req.uid, req.params.id, req.body)));
  api.delete('/repos/:id', async (req, res) => res.json(await service.deleteRepo(req.uid, req.params.id)));
  api.post('/repos/:id/transfer', async (req, res) => res.json(await service.transferRepo(req.uid, req.params.id, req.body.to)));

  // chunks (delta sync)
  api.post('/chunks/missing', async (req, res) => res.json({ missing: await service.chunksMissing(req.uid, req.body.hashes, req.body.artifactId) }));
  api.post('/chunks/put', express.raw({ type: 'application/octet-stream', limit: 16 * 1024 * 1024 }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : (req.rawBody ?? Buffer.alloc(0));
    const entries = String(req.get('x-tether-chunks') || '').split(',').filter(Boolean).map((e) => {
      const [h, s] = e.split(':');
      return { h, s: Number(s) };
    });
    res.json(await service.putChunks(entries, body));
  });
  api.post('/chunks/manifest', async (req, res) => res.json({ manifests: await service.manifests(req.uid, req.body.items) }));
  api.post('/chunks/fetch', async (req, res) => {
    res.set('content-type', 'application/octet-stream');
    res.send(await service.fetchChunks(req.uid, req.body));
  });

  // blobs
  api.post('/blobs/upload', async (req, res) => res.json({ upload: await service.blobsToUpload(req.body.blobs) }));
  api.post('/blobs/download', async (req, res) => res.json({ downloads: await service.downloadUrls(req.uid, req.body.items) }));

  // artifacts
  api.post('/artifacts', async (req, res) => res.json(await service.manage(req.uid, req.body)));
  api.post('/pull', async (req, res) => res.json(await service.pull(req.uid, req.body.shareId, { peek: !!req.body.peek })));
  api.post('/sync/check', async (req, res) => res.json(await service.checkSince(req.uid, req.body.items, req.body.cursor)));
  api.get('/artifacts/:id', async (req, res) => res.json(await service.getArtifact(req.uid, req.params.id)));
  api.post('/artifacts/:id/children', async (req, res) => res.json(await service.addChild(req.uid, req.params.id, req.body)));
  api.post('/artifacts/:id/commit', async (req, res) => res.json(await service.commit(req.uid, req.params.id, req.body)));
  api.post('/artifacts/:id/delete', async (req, res) => res.json(await service.deleteArtifact(req.uid, req.params.id)));
  api.post('/artifacts/:id/restore', async (req, res) => res.json(await service.restoreFolder(req.uid, req.params.id)));
  api.post('/artifacts/:id/realtime', async (req, res) => {
    const { action, force } = req.body;
    if (action === 'start') return res.json(await service.startRealtime(req.uid, req.params.id));
    if (action === 'stop') return res.json(await service.stopRealtime(req.uid, req.params.id, { force: !!force }));
    throw badRequest('action must be start or stop');
  });
  api.post('/artifacts/:id/rollback', async (req, res) => {
    if (req.body.toVersion === undefined) throw badRequest('toVersion required');
    res.json(await service.rollback(req.uid, req.params.id, req.body.toVersion));
  });
  api.get('/artifacts/:id/content', async (req, res) => {
    const { name, bytes } = await service.content(req.uid, req.params.id, req.query.version);
    res.set('content-type', 'application/octet-stream');
    res.set('content-disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.set('cache-control', 'private, max-age=60');
    res.send(bytes);
  });
  api.get('/artifacts/:id/history', async (req, res) => res.json(await service.history(req.uid, req.params.id)));
  api.get('/artifacts/:id/sharing', async (req, res) => res.json(await service.sharing(req.uid, req.params.id)));
  api.post('/artifacts/:id/share', async (req, res) => res.json(await service.share(req.uid, req.params.id, req.body)));

  app.use('/v1', api);

  // Web console (built React app), with SPA fallback.
  if (consoleDir && fs.existsSync(path.join(consoleDir, 'index.html'))) {
    app.use(express.static(consoleDir));
    app.get(/^(?!\/v1\/|\/blobs\/).*/, (_req, res) => res.sendFile(path.join(consoleDir, 'index.html')));
  }

  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `no route ${req.method} ${req.path}` } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'request too large' } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_request', message: 'invalid JSON' } });
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'internal error' } });
  });
  return app;
}
