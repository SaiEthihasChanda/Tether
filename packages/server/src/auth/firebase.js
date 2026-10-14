// Firebase Auth. Users sign up and sign in with the Firebase SDK (console) or the Identity
// Toolkit REST API (CLI); the server only verifies ID tokens. For the CLI browser login the
// server exchanges a one-time code for a Firebase custom token.
import { newToken } from '@tether/shared';
import { badRequest, unauthorized } from '../errors.js';

const CLI_CODE_TTL = 120 * 1000;

export class FirebaseAuth {
  constructor(store, adminAuth, { apiKey, projectId, authDomain, emulatorHost }) {
    this.store = store;
    this.adminAuth = adminAuth;
    this.config = { auth: 'firebase', apiKey, projectId, authDomain, ...(emulatorHost ? { emulatorHost } : {}) };
    this.known = new Set(); // uids with a users doc, per instance
  }

  publicConfig() {
    return this.config;
  }

  /** Verifies a Firebase ID token and makes sure the user has a Tether profile. */
  async verify(token) {
    if (!token) throw unauthorized();
    let decoded;
    try {
      decoded = await this.adminAuth.verifyIdToken(token);
    } catch {
      throw unauthorized('invalid or expired token');
    }
    if (!this.known.has(decoded.uid)) {
      if (!(await this.store.userById(decoded.uid))) {
        // ID tokens outlive account deletion; only create a profile for a user that exists.
        await this.adminAuth.getUser(decoded.uid).catch(() => {
          throw unauthorized('account no longer exists');
        });
        const email = String(decoded.email ?? '').toLowerCase();
        try {
          await this.store.createUser({ _id: decoded.uid, email, displayName: decoded.name || email.split('@')[0], createdAt: new Date() });
        } catch (e) {
          if (e.code !== 6 && e.code !== 'already-exists') throw e; // created concurrently
        }
      }
      this.known.add(decoded.uid);
    }
    return decoded.uid;
  }

  unsupported() {
    throw badRequest('this server uses Firebase Auth; sign in with the Firebase SDK');
  }
  signup() {
    this.unsupported();
  }
  login() {
    this.unsupported();
  }
  refresh() {
    this.unsupported();
  }
  logout() {}

  async cliCode(uid) {
    const code = newToken();
    await this.store.putCliCode({ _id: code, uid, expiresAt: new Date(Date.now() + CLI_CODE_TTL) });
    return code;
  }

  /** Returns a custom token; the CLI signs in with it and keeps the Firebase refresh token. */
  async exchangeCliCode(code) {
    const c = await this.store.takeCliCode(String(code || ''));
    if (!c) throw unauthorized('login code expired, try again');
    const user = await this.store.userById(c.uid);
    return { customToken: await this.adminAuth.createCustomToken(c.uid), user: { uid: c.uid, email: user?.email, displayName: user?.displayName } };
  }

  async deleteUser(uid) {
    await this.adminAuth.deleteUser(uid).catch((e) => {
      if (e.code !== 'auth/user-not-found') throw e;
    });
    this.known.delete(uid);
  }
}
