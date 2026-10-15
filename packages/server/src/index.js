import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TetherService } from './service.js';
import { createApp } from './app.js';
import { createLocalBackend, createFirebaseBackend } from './backends.js';

export const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Starts the Tether server as a standalone HTTP server.
 * opts: { port, host, backend: 'local' | 'firebase', maxFileSize, consoleDir, publicUrl,
 *         // local:    mongoUrl, dbName, dataDir, secret
 *         // firebase: firebase: { projectId, apiKey, authDomain, storageBucket, blobs? } }
 */
export async function startServer(opts = {}) {
  const dataDir = opts.dataDir ?? path.resolve('.tether-dev/server');
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const host = opts.host ?? '127.0.0.1';
  const backend = opts.backend === 'firebase'
    ? await createFirebaseBackend({ firebase: opts.firebase, maxFileSize })
    : await createLocalBackend({ ...opts, dataDir, maxFileSize });

  const service = new TetherService({ store: backend.store, blobs: backend.blobs, maxFileSize, realtimeTtlMs: opts.realtimeTtlMs });
  const consoleDir = opts.consoleDir === undefined ? path.resolve(here, '../../console/dist') : opts.consoleDir;
  const app = createApp({ service, auth: backend.auth, consoleDir, maxFileSize });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(opts.port ?? 8787, host, () => resolve(s));
    s.on('error', reject);
  });
  const url = opts.publicUrl ?? `http://${host}:${server.address().port}`;
  if (backend.blobs.publicUrl !== undefined) backend.blobs.publicUrl = url;
  return {
    url,
    service,
    store: backend.store,
    async close() {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await backend.close();
    },
  };
}
