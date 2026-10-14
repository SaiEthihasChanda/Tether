import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MongoStore } from './store/mongo.js';
import { FsBlobStore } from './blobs/fs.js';
import { LocalAuth } from './auth/local.js';
import { TetherService } from './service.js';
import { createApp } from './app.js';

export const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));

/** Loads the server signing secret from the data dir, creating it on first run. */
function loadSecret(dataDir) {
  const f = path.join(dataDir, 'secret');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(f, 'utf8').trim();
}

/**
 * Starts the Tether server.
 * opts: { port, host, mongoUrl, dbName, dataDir, secret, maxFileSize, consoleDir, publicUrl }
 */
export async function startServer(opts = {}) {
  const dataDir = opts.dataDir ?? path.resolve('.tether-dev/server');
  const secret = opts.secret ?? loadSecret(dataDir);
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const store = await MongoStore.connect(opts.mongoUrl ?? 'mongodb://127.0.0.1:27017', opts.dbName ?? 'tether');
  const host = opts.host ?? '127.0.0.1';

  const blobs = new FsBlobStore(path.join(dataDir, 'blobs'), { secret, publicUrl: '' });
  const service = new TetherService({ store, blobs, maxFileSize });
  const auth = new LocalAuth(store, secret);
  const consoleDir = opts.consoleDir === undefined ? path.resolve(here, '../../console/dist') : opts.consoleDir;
  const app = createApp({ service, auth, consoleDir, maxFileSize });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port ?? 8787, host, () => resolve(s));
    s.on('error', reject);
  });
  const url = opts.publicUrl ?? `http://${host}:${server.address().port}`;
  blobs.publicUrl = url;
  return {
    url,
    service,
    store,
    async close() {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await store.close();
    },
  };
}
