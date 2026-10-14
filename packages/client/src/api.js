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

  async token() {
    if (this.accessToken) return this.accessToken;
    const creds = await this.credentials.load();
    if (!creds?.refreshToken) throw new ApiError(401, { code: 'unauthorized', message: 'not signed in, run `tether login`' });
    const r = await this.raw('POST', '/auth/refresh', { refreshToken: creds.refreshToken });
    this.accessToken = r.accessToken;
    return this.accessToken;
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
    return tokens.user;
  }

  async logout() {
    const creds = await this.credentials.load();
    if (creds?.refreshToken) await this.raw('POST', '/auth/logout', { refreshToken: creds.refreshToken }).catch(() => {});
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
      const res = await fetch(u.url, { method: 'PUT', body: bySha.get(u.sha256).bytes });
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error);
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
