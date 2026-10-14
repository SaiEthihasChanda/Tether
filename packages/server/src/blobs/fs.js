// Content-addressed blob store on the local filesystem (stands in for Cloud Storage).
// Transfers use short-lived HMAC-signed URLs served by this server.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class FsBlobStore {
  constructor(dir, { secret, publicUrl, ttlSeconds = 600 }) {
    this.dir = dir;
    this.secret = secret;
    this.publicUrl = publicUrl;
    this.ttl = ttlSeconds;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(sha) {
    return path.join(this.dir, sha.slice(0, 2), sha);
  }

  has(sha) {
    return fs.existsSync(this.file(sha));
  }

  size(sha) {
    try {
      return fs.statSync(this.file(sha)).size;
    } catch {
      return null;
    }
  }

  async put(sha, bytes) {
    const dest = this.file(sha);
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fs.promises.writeFile(tmp, bytes);
    await fs.promises.rename(tmp, dest);
  }

  read(sha) {
    return fs.promises.readFile(this.file(sha));
  }

  sign(op, sha, size, exp) {
    return crypto.createHmac('sha256', this.secret).update(`${op}|${sha}|${size}|${exp}`).digest('base64url');
  }

  async uploadTarget(sha, size) {
    return { url: this.signedUrl('put', sha, size), headers: {} };
  }

  async downloadUrl(sha) {
    return this.signedUrl('get', sha);
  }

  signedUrl(op, sha, size = 0) {
    const exp = Math.floor(Date.now() / 1000) + this.ttl;
    const sig = this.sign(op, sha, size, exp);
    return `${this.publicUrl}/blobs/${sha}?op=${op}&size=${size}&exp=${exp}&sig=${sig}`;
  }

  verify(op, sha, query) {
    const exp = Number(query.exp);
    if (query.op !== op || !exp || exp < Date.now() / 1000) return false;
    const expected = this.sign(op, sha, Number(query.size) || 0, exp);
    const got = String(query.sig || '');
    return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  }
}
