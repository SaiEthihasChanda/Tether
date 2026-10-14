// Local email/password auth (stands in for Firebase Auth).
// Access tokens are HMAC-signed and short-lived; refresh tokens are random and stored hashed.
import crypto from 'node:crypto';
import { newToken } from '@tether/shared';
import { badRequest, unauthorized, conflict } from '../errors.js';

const ACCESS_TTL = 60 * 60; // seconds
const CLI_CODE_TTL = 120 * 1000; // ms

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

export class LocalAuth {
  constructor(store, secret) {
    this.store = store;
    this.secret = secret;
  }

  publicConfig() {
    return { auth: 'local' };
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  accessToken(uid) {
    const payload = Buffer.from(JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** Returns the uid for a valid access token, or throws 401. */
  verify(token) {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) throw unauthorized();
    const expected = this.sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw unauthorized('invalid token');
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (exp < Date.now() / 1000) throw unauthorized('token expired');
    return uid;
  }

  async issue(user) {
    const refreshToken = newToken();
    await this.store.createSession({ _id: hashToken(refreshToken), uid: user._id, createdAt: new Date() });
    return { accessToken: this.accessToken(user._id), refreshToken, user: publicUser(user) };
  }

  async signup({ email, password, displayName }) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('a valid email is required');
    if (!password || password.length < 8) throw badRequest('password must be at least 8 characters');
    if (await this.store.userByEmail(email)) throw conflict('an account with that email already exists');
    const user = {
      _id: 'u_' + crypto.randomBytes(10).toString('hex'),
      email,
      displayName: displayName || email.split('@')[0],
      passwordHash: hashPassword(password),
      createdAt: new Date(),
    };
    await this.store.createUser(user);
    return this.issue(user);
  }

  async login({ email, password }) {
    const user = await this.store.userByEmail(String(email || '').trim().toLowerCase());
    if (!user || !checkPassword(String(password || ''), user.passwordHash)) throw unauthorized('wrong email or password');
    return this.issue(user);
  }

  async refresh(refreshToken) {
    const s = await this.store.sessionByHash(hashToken(String(refreshToken || '')));
    if (!s) throw unauthorized('session expired, run `tether login`');
    const user = await this.store.userById(s.uid);
    if (!user) throw unauthorized('account no longer exists');
    return { accessToken: this.accessToken(user._id), user: publicUser(user) };
  }

  logout(refreshToken) {
    return this.store.deleteSession(hashToken(String(refreshToken || '')));
  }

  /** One-time code the console hands to the CLI's localhost redirect. */
  async cliCode(uid) {
    const code = newToken();
    await this.store.putCliCode({ _id: code, uid, expiresAt: new Date(Date.now() + CLI_CODE_TTL) });
    return code;
  }

  async exchangeCliCode(code) {
    const c = await this.store.takeCliCode(String(code || ''));
    if (!c) throw unauthorized('login code expired, try again');
    const user = await this.store.userById(c.uid);
    if (!user) throw unauthorized();
    return this.issue(user);
  }
}

export const publicUser = (u) => ({ uid: u._id, email: u.email, displayName: u.displayName });
