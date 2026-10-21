// Push channel (Firebase servers): the daemon listens to its own change feed document, so it asks
// the server about its files only when something it holds changed, instead of on a timer. The
// server hands out a custom token for this (POST /v1/feed/token); the Firebase SDK signs in with it
// and keeps its own session. Servers without a push channel answer 404 and the daemon keeps polling.
import { ApiError } from './api.js';

const RETRY_MS = 5 * 60 * 1000;

export class FeedListener {
  /** onChange(seq) is called with the feed counter on every snapshot from the server. */
  constructor({ api, log, onChange }) {
    this.api = api;
    this.log = log;
    this.onChange = onChange;
    this.live = false; // true while snapshots come from the server (not the SDK's cache)
    this.unsupported = false;
    this.session = 0;
  }

  async start() {
    if (this.unsupported || this.unsub || this.starting) return;
    this.starting = true;
    const session = ++this.session;
    try {
      const t = await this.api.call('POST', '/feed/token');
      const [{ initializeApp }, A, F] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')]);
      if (session !== this.session) return; // stopped meanwhile
      this.app = initializeApp(t.firebase, `tether-feed-${session}-${Date.now()}`);
      const auth = A.getAuth(this.app);
      const db = F.getFirestore(this.app);
      if (t.emulators?.auth) A.connectAuthEmulator(auth, `http://${t.emulators.auth}`, { disableWarnings: true });
      if (t.emulators?.firestore) {
        const [host, port] = t.emulators.firestore.split(':');
        F.connectFirestoreEmulator(db, host, Number(port));
      }
      await A.signInWithCustomToken(auth, t.customToken);
      if (session !== this.session) return this.dispose();
      this.unsub = F.onSnapshot(F.doc(db, 'feeds', t.uid), { includeMetadataChanges: true }, (snap) => {
        const wasLive = this.live;
        this.live = !snap.metadata.fromCache;
        if (this.live && !wasLive) this.log('push channel connected');
        if (this.live) this.onChange(snap.get('seq') ?? 0);
      }, (e) => this.fail(e, session));
    } catch (e) {
      this.fail(e, session);
    } finally {
      this.starting = false;
    }
  }

  fail(e, session) {
    if (session !== this.session) return;
    if (e instanceof ApiError && e.status === 404) {
      this.unsupported = true; // a server without a push channel: polling only
      this.stop();
      return;
    }
    this.log(`push channel unavailable (${e.message}); polling until it reconnects`);
    this.stop();
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.start(), RETRY_MS);
    this.retry.unref?.();
  }

  stop() {
    this.session++;
    clearTimeout(this.retry);
    this.unsub?.();
    this.unsub = null;
    if (this.live) this.log('push channel closed');
    this.live = false;
    this.dispose();
  }

  dispose() {
    const app = this.app;
    this.app = null;
    if (app) import('firebase/app').then(({ deleteApp }) => deleteApp(app)).catch(() => {});
  }

  /** After a login, logout or server change: start over (or stay off when signed out). */
  restart() {
    this.unsupported = false;
    this.stop();
    this.start();
  }
}
