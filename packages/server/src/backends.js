// Backend wiring. "local": MongoDB + filesystem blobs + local auth (development, tests).
// "firebase": Firestore + Cloud Storage + Firebase Auth (production, Cloud Functions).
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { FsBlobStore } from './blobs/fs.js';
import { LocalAuth } from './auth/local.js';

/** Loads the local signing secret from the data dir, creating it on first run. */
export function loadSecret(dataDir) {
  const f = path.join(dataDir, 'secret');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(f, 'utf8').trim();
}

export async function createLocalBackend({ mongoUrl, dbName, dataDir, secret, maxFileSize }) {
  const { MongoStore } = await import('./store/mongo.js');
  const store = await MongoStore.connect(mongoUrl ?? 'mongodb://127.0.0.1:27017', dbName ?? 'tether');
  secret ??= loadSecret(dataDir);
  const blobs = new FsBlobStore(path.join(dataDir, 'blobs'), { secret, publicUrl: '' });
  return { store, blobs, auth: new LocalAuth(store, secret), close: () => store.close() };
}

/**
 * firebase: { projectId, apiKey, authDomain, storageBucket, appName?, blobs? }
 * Credentials come from the environment (Cloud Functions runtime, or the emulators via
 * FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST). `blobs` overrides Cloud Storage
 * (tests use the local blob store because the Storage emulator cannot sign URLs).
 */
export async function createFirebaseBackend({ firebase, maxFileSize }) {
  const { initializeApp, deleteApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
  const { FirestoreStore } = await import('./store/firestore.js');
  const { FirebaseAuth } = await import('./auth/firebase.js');
  const app = initializeApp({ projectId: firebase.projectId, storageBucket: firebase.storageBucket }, firebase.appName ?? `tether-${crypto.randomUUID()}`);
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  const store = new FirestoreStore(db);
  let blobs = firebase.blobs;
  if (!blobs) {
    const { getStorage } = await import('firebase-admin/storage');
    const { GcsBlobStore } = await import('./blobs/gcs.js');
    const storage = getStorage(app);
    // New content goes to the data bucket next to the API; the default bucket stays readable.
    blobs = firebase.dataBucket
      ? new GcsBlobStore(storage.bucket(firebase.dataBucket), { maxFileSize, legacy: storage.bucket() })
      : new GcsBlobStore(storage.bucket(), { maxFileSize });
  }
  const auth = new FirebaseAuth(store, getAuth(app), { ...firebase, emulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST });
  return { store, blobs, auth, close: () => deleteApp(app) };
}
