// Cloud Functions entry point: the whole API as one HTTPS function ("api"), reached through
// Firebase Hosting rewrites (/v1/**). Bundled into firebase/functions/lib by `npm run build:functions`.
import { onRequest } from 'firebase-functions/https';
import { TetherService } from './service.js';
import { createApp } from './app.js';
import { createFirebaseBackend } from './backends.js';
import { firebaseProject } from './firebase-project.js';

const MAX_FILE_SIZE = Number(process.env.TETHER_MAX_FILE_SIZE ?? 10 * 1024 * 1024);

let appPromise;
function getApp() {
  appPromise ??= createFirebaseBackend({ firebase: { ...firebaseProject, appName: 'tether' }, maxFileSize: MAX_FILE_SIZE }).then((b) =>
    createApp({ service: new TetherService({ store: b.store, blobs: b.blobs, maxFileSize: MAX_FILE_SIZE }), auth: b.auth, consoleDir: null, maxFileSize: MAX_FILE_SIZE }),
  );
  return appPromise;
}

export const api = onRequest(
  { region: 'asia-south1', memory: '512MiB', timeoutSeconds: 120, maxInstances: 10, concurrency: 40 },
  async (req, res) => (await getApp())(req, res),
);
