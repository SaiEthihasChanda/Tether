// HTTP client for the Tether API. Only the daemon uses it; the CLI never talks to the network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256 } from '@tether/shared';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

export class OfflineError extends Error {}

const FIREBASE_ERRORS = {
  EMAIL_EXISTS: 'an account with that email already exists',
  INVALID_LOGIN_CREDENTIALS: 'wrong email or password',
  INVALID_PASSWORD: 'wrong email or password',
  EMAIL_NOT_FOUND: 'wrong email or password',
  USER_DISABLED: 'this account has been disabled',
  TOKEN_EXPIRED: 'session expired, run `tether login`',
  INVALID_REFRESH_TOKEN: 'session expired, run `tether login`',
  USER_NOT_FOUND: 'account no longer exists, run `tether login`',
  INVALID_EMAIL: 'a valid email is required',
};

function firebaseMessage(code = '') {
  const key = code.split(':')[0].split(' ')[0].trim();
  if (key.startsWith('WEAK_PASSWORD')) return 'password must be at least 6 characters';
  if (key.startsWith('TOO_MANY_ATTEMPTS')) return 'too many attempts; try again later';
  return FIREBASE_ERRORS[key] ?? `sign-in failed (${code || 'unknown error'})`;
}

export class Api {
  constructor({ config, credentials }) {
    this.config = config;
    this.credentials = credentials;
    this.accessToken = null;
  }

  get base() {
    return this.config.get('server').replace(/\/$/, '');
  }

  async raw(method, p, body, token) {
    let res;
    try {
      res = await fetch(this.base + '/v1' + p, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new OfflineError(`cannot reach the Tether server at ${this.base} (${e.cause?.code ?? e.message})`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, json.error);
    return json;
  }

  /** The server's auth setup: { auth: 'local' } or { auth: 'firebase', apiKey, emulatorHost? }. */
  async serverConfig() {
    if (this.cfg?.base === this.base) return this.cfg.value;
    const value = await this.raw('GET', '/config');
    this.cfg = { base: this.base, value };
    return value;
  }

  /** Google endpoints (or the Auth emulator) for Firebase sign-in. */
  googleUrl(service, method, cfg) {
    const root = cfg.emulatorHost ? `http://${cfg.emulatorHost}/${service}.googleapis.com/v1` : `https://${service}.googleapis.com/v1`;
    return `${root}/${method}?key=${encodeURIComponent(cfg.apiKey)}`;
  }

  async google(service, method, body, form = false) {
    const cfg = await this.serverConfig();
    let res;
    try {
      res = await fetch(this.googleUrl(service, method, cfg), {
        method: 'POST',
        headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new OfflineError(`cannot reach Firebase Auth (${e.cause?.code ?? e.message})`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status === 400 ? 401 : res.status, { code: 'unauthorized', message: firebaseMessage(json.error?.message) });
    return json;
  }

  async token() {
    if (this.accessToken && (!this.accessExp || Date.now() < this.accessExp)) return this.accessToken;
    const creds = await this.credentials.load();
    if (!creds?.refreshToken) throw new ApiError(401, { code: 'unauthorized', message: 'not signed in, run `tether login`' });
    if (creds.firebase) {
      const r = await this.google('securetoken', 'token', { grant_type: 'refresh_token', refresh_token: creds.refreshToken }, true);
      this.accessToken = r.id_token;
      this.accessExp = Date.now() + (Number(r.expires_in) - 120) * 1000;
      return this.accessToken;
    }
    const r = await this.raw('POST', '/auth/refresh', { refreshToken: creds.refreshToken });
    this.accessToken = r.accessToken;
    this.accessExp = null;
    return this.accessToken;
  }

  /** Email + password sign-in (or sign-up) against whichever auth system the server uses. */
  async passwordLogin({ email, password, signup }) {
    const cfg = await this.serverConfig();
    if (cfg.auth !== 'firebase') return this.signedIn(await this.raw('POST', signup ? '/auth/signup' : '/auth/login', { email, password }));
    const r = await this.google('identitytoolkit', signup ? 'accounts:signUp' : 'accounts:signInWithPassword', { email, password, returnSecureToken: true });
    return this.firebaseSignedIn(r.idToken, r.refreshToken, r.expiresIn);
  }

  /** Completes the browser login: the console's one-time code becomes a session. */
  async exchangeCliCode(code) {
    const r = await this.raw('POST', '/auth/cli-exchange', { code });
    if (!r.customToken) return this.signedIn(r);
    const t = await this.google('identitytoolkit', 'accounts:signInWithCustomToken', { token: r.customToken, returnSecureToken: true });
    return this.firebaseSignedIn(t.idToken, t.refreshToken, t.expiresIn);
  }

  async firebaseSignedIn(idToken, refreshToken, expiresIn) {
    this.accessToken = idToken;
    this.accessExp = Date.now() + (Number(expiresIn) - 120) * 1000;
    const user = await this.raw('GET', '/me', undefined, idToken);
    await this.credentials.save({ firebase: true, refreshToken, user, server: this.base });
    return user;
  }

  /** Authenticated call; refreshes the access token once on 401. */
  async call(method, p, body) {
    try {
      return await this.raw(method, p, body, await this.token());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && this.accessToken) {
        this.accessToken = null;
        return this.raw(method, p, body, await this.token());
      }
      throw e;
    }
  }

  async signedIn(tokens) {
    await this.credentials.save({ refreshToken: tokens.refreshToken, user: tokens.user, server: this.base });
    this.accessToken = tokens.accessToken;
    this.accessExp = null;
    return tokens.user;
  }

  async logout() {
    const creds = await this.credentials.load();
    if (creds?.refreshToken && !creds.firebase) await this.raw('POST', '/auth/logout', { refreshToken: creds.refreshToken }).catch(() => {});
    this.credentials.clear();
    this.accessToken = null;
  }

  /** Uploads canonical blobs the server doesn't have yet. blobs: [{ sha256, bytes }] */
  async uploadBlobs(blobs) {
    const unique = [...new Map(blobs.map((b) => [b.sha256, b])).values()];
    if (!unique.length) return;
    const { upload } = await this.call('POST', '/blobs/upload', { blobs: unique.map((b) => ({ sha256: b.sha256, size: b.bytes.length })) });
    const bySha = new Map(unique.map((b) => [b.sha256, b]));
    for (const u of upload) {
      const res = await fetch(u.url, { method: 'PUT', headers: u.headers ?? {}, body: bySha.get(u.sha256).bytes });
      // 412: someone uploaded the same content first (uploads are create-only).
      if (!res.ok && res.status !== 412) throw new ApiError(res.status, { message: `upload failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}` });
    }
  }

  /** Downloads blobs for [{ artifactId, version? }] into the cache; skips blobs already cached. */
  async fetchBlobs(cache, items) {
    if (!items.length) return [];
    const { downloads } = await this.call('POST', '/blobs/download', { items });
    for (const d of downloads) {
      if (cache.has(d.sha256)) continue;
      const res = await fetch(d.url);
      if (!res.ok) throw new ApiError(res.status, { message: `download failed (${res.status})` });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (sha256(bytes) !== d.sha256) throw new Error('downloaded content does not match its hash');
      cache.put(d.sha256, bytes);
    }
    return downloads;
  }
}

/** Local cache of canonical blobs, so reverts work offline (DESIGN §6.1). */
export class BlobCache {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(sha) {
    return path.join(this.dir, sha.slice(0, 2), sha);
  }

  has(sha) {
    return !!sha && fs.existsSync(this.file(sha));
  }

  get(sha) {
    return fs.readFileSync(this.file(sha));
  }

  put(sha, bytes) {
    const f = this.file(sha);
    if (fs.existsSync(f)) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, f);
  }
}
