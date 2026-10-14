// Starts an isolated Tether server on a random port backed by an in-memory MongoDB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { startServer } from '../../packages/server/src/index.js';
import { sha256 } from '../../packages/shared/src/index.js';

export async function startTestServer(opts = {}) {
  const mongo = await MongoMemoryServer.create();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-srv-'));
  const server = await startServer({ port: 0, mongoUrl: mongo.getUri(), dbName: 'test', dataDir, consoleDir: null, ...opts });
  return {
    ...server,
    async stop() {
      await server.close();
      await mongo.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Minimal API client for server tests. */
export class TestUser {
  constructor(url) {
    this.url = url;
  }

  async signup(email, password = 'password123') {
    const r = await this.call('POST', '/auth/signup', { email, password });
    this.token = r.accessToken;
    this.refreshToken = r.refreshToken;
    this.uid = r.user.uid;
    this.email = email;
    return this;
  }

  async call(method, p, body) {
    const res = await fetch(this.url + '/v1' + p, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = res.status === 204 ? {} : await res.json();
    if (!res.ok) {
      const e = new Error(json.error?.message ?? res.statusText);
      e.status = res.status;
      e.body = json.error;
      throw e;
    }
    return json;
  }

  /** Uploads content, returning { blob, size }. */
  async upload(text) {
    const bytes = Buffer.from(text);
    const sha = sha256(bytes);
    const { upload } = await this.call('POST', '/blobs/upload', { blobs: [{ sha256: sha, size: bytes.length }] });
    for (const u of upload) {
      const res = await fetch(u.url, { method: 'PUT', body: bytes });
      if (!res.ok) throw new Error('upload failed ' + res.status);
    }
    return { blob: sha, size: bytes.length };
  }

  async download(artifactId, version) {
    const { downloads } = await this.call('POST', '/blobs/download', { items: [{ artifactId, version }] });
    const res = await fetch(downloads[0].url);
    return Buffer.from(await res.arrayBuffer()).toString();
  }
}

export async function rejects(promise, status) {
  try {
    await promise;
  } catch (e) {
    if (e.status !== status) throw new Error(`expected HTTP ${status}, got ${e.status}: ${e.message}`);
    return e;
  }
  throw new Error(`expected HTTP ${status}, but the call succeeded`);
}
