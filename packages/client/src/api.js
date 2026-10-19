// HTTP client for the Tether API. Only the daemon uses it; the CLI never talks to the network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256, chunkContent } from '@tether/shared';

const PUT_BATCH_BYTES = 1024 * 1024;
const PUT_PARALLEL = 4; // batches in flight at once
const PUT_BATCH_CHUNKS = 100; // the chunk list travels in a header
const FETCH_BATCH_BYTES = 1024 * 1024;
const FETCH_PARALLEL = 4; // fetches in flight at once
const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Human summary of a delta transfer, e.g. "sent 2 of 540 chunks, 17 KB". */
export const describeTransfer = (t, verb) => (t ? `${verb} ${t.moved} of ${t.total} chunk${t.total === 1 ? '' : 's'}, ${kb(t.bytes)}` : '');

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
    this.manifests = new Map(); // content sha -> chunk list, from the last upload of that content
    this.transfers = new Map(); // content sha -> { moved, total, bytes } of the last transfer
  }

  /** Authenticated POST with a binary body or a binary response; refreshes the token once on 401. */
  async binary(p, { json, body, headers = {} }) {
    const send = async (token) => {
      let res;
      try {
        res = await fetch(this.base + '/v1' + p, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': json ? 'application/json' : 'application/octet-stream', ...headers },
          body: json ? JSON.stringify(json) : body,
          signal: AbortSignal.timeout(180000),
        });
      } catch (e) {
        throw new OfflineError(`cannot reach the Tether server at ${this.base} (${e.cause?.code ?? e.message})`);
      }
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error);
      return Buffer.from(await res.arrayBuffer());
    };
    try {
      return await send(await this.token());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && this.accessToken) {
        this.accessToken = null;
        return send(await this.token());
      }
      throw e;
    }
  }

  /** The chunk list to commit for content uploaded by uploadBlobs (undefined on old servers). */
  manifestFor(sha) {
    return this.manifests.get(sha);
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

  /**
   * Uploads content as chunks (delta sync): every file is split into content-defined chunks and
   * only the chunks the server does not have are sent. blobs: [{ sha256, bytes }] (canonical).
   * Afterwards manifestFor(sha) gives each file's chunk list for the commit.
   */
  async uploadBlobs(blobs, { artifactId } = {}) {
    const files = [...new Map(blobs.map((b) => [b.sha256, b])).values()];
    if (!files.length) return;
    const all = new Map(); // chunk hash -> bytes
    for (const f of files) {
      const parts = chunkContent(f.bytes);
      this.manifests.set(f.sha256, parts.map(({ h, s }) => ({ h, s })));
      for (const c of parts) all.set(c.h, c.bytes);
    }
    let missing;
    try {
      ({ missing } = await this.call('POST', '/chunks/missing', { hashes: [...all.keys()], artifactId }));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      for (const f of files) this.manifests.delete(f.sha256); // server without delta sync
      return this.uploadWhole(files);
    }
    const batches = [];
    let batch = [];
    let size = 0;
    for (const h of missing) {
      const bytes = all.get(h);
      if (batch.length && (batch.length >= PUT_BATCH_CHUNKS || size + bytes.length > PUT_BATCH_BYTES)) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push({ h, bytes });
      size += bytes.length;
    }
    if (batch.length) batches.push(batch);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PUT_PARALLEL, batches.length) }, async () => {
      while (next < batches.length) {
        const b = batches[next++];
        await this.binary('/chunks/put', { body: Buffer.concat(b.map((c) => c.bytes)), headers: { 'x-tether-chunks': b.map((c) => `${c.h}:${c.bytes.length}`).join(',') } });
      }
    }));
    const sent = new Set(missing);
    for (const f of files) {
      const m = this.manifests.get(f.sha256);
      const moved = m.filter((c) => sent.has(c.h));
      this.transfers.set(f.sha256, { moved: moved.length, total: m.length, bytes: moved.reduce((a, c) => a + c.s, 0) });
    }
  }

  /** Whole-file upload through signed URLs, for servers without delta sync. */
  async uploadWhole(unique) {
    const { upload } = await this.call('POST', '/blobs/upload', { blobs: unique.map((b) => ({ sha256: b.sha256, size: b.bytes.length })) });
    const bySha = new Map(unique.map((b) => [b.sha256, b]));
    for (const u of upload) {
      const res = await fetch(u.url, { method: 'PUT', headers: u.headers ?? {}, body: bySha.get(u.sha256).bytes });
      // 412: someone uploaded the same content first (uploads are create-only).
      if (!res.ok && res.status !== 412) throw new ApiError(res.status, { message: `upload failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}` });
    }
  }

  /**
   * Downloads content into the cache, by chunks (delta sync). items: [{ artifactId, version, sha,
   * base? }] where base is content already cached (usually the version on disk): its chunks are
   * reused, so only chunks that changed are downloaded.
   */
  async fetchBlobs(cache, items) {
    const need = [...new Map(items.filter((i) => !i.sha || !cache.has(i.sha)).map((i) => [`${i.artifactId}@${i.version}`, i])).values()];
    if (!need.length) return;
    let manifests;
    try {
      ({ manifests } = await this.call('POST', '/chunks/manifest', { items: need.map(({ artifactId, version }) => ({ artifactId, version })) }));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      return this.fetchWhole(cache, need); // server without delta sync
    }
    for (const [k, m] of manifests.entries()) {
      if (cache.has(m.blob)) continue;
      const local = new Map();
      const base = need[k].base;
      if (base && cache.has(base)) for (const c of chunkContent(cache.get(base))) local.set(c.h, c.bytes);
      const size = new Map(m.chunks.map((c) => [c.h, c.s]));
      const want = [...size.keys()].filter((h) => !local.has(h));
      let bytesIn = 0;
      const batches = [];
      for (let i = 0; i < want.length; ) {
        const batch = [];
        let total = 0;
        while (i < want.length && (!batch.length || total + size.get(want[i]) <= FETCH_BATCH_BYTES)) {
          batch.push(want[i]);
          total += size.get(want[i++]);
        }
        batches.push(batch);
        bytesIn += total;
      }
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, batches.length) }, async () => {
        while (next < batches.length) {
          const batch = batches[next++];
          const buf = await this.binary('/chunks/fetch', { json: { artifactId: m.artifactId, version: m.version, hashes: batch } });
          let off = 0;
          for (const h of batch) {
            const bytes = buf.subarray(off, off + size.get(h));
            off += size.get(h);
            if (sha256(bytes) !== h) throw new Error('downloaded chunk does not match its hash');
            local.set(h, Buffer.from(bytes));
          }
        }
      }));
      const content = Buffer.concat(m.chunks.map((c) => local.get(c.h)));
      if (sha256(content) !== m.blob) throw new Error('downloaded content does not match its hash');
      cache.put(m.blob, content);
      this.transfers.set(m.blob, { moved: want.length, total: size.size, bytes: bytesIn });
    }
  }

  /** Whole-file downloads through signed URLs, for servers without delta sync. */
  async fetchWhole(cache, items) {
    const { downloads } = await this.call('POST', '/blobs/download', { items: items.map(({ artifactId, version }) => ({ artifactId, version })) });
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
