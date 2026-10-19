// Content-addressed blobs in Cloud Storage: blobs/{sha256}.
// Clients upload straight to Storage with short-lived signed URLs that are create-only
// (x-goog-if-generation-match: 0) and size-capped. Because Storage does not check sha256,
// a blob is verified (downloaded and hashed) the first time an artifact references it.
import { sha256 } from '@tether/shared';

export class GcsBlobStore {
  /**
   * bucket: where new content is written (same region as the API, for low latency).
   * legacy: an older bucket that is still read from (content written before the move).
   */
  constructor(bucket, { maxFileSize, ttlSeconds = 600, legacy = null }) {
    this.receive = false; // uploads go to Storage, not through the API
    this.bucket = bucket;
    this.legacy = legacy;
    this.maxFileSize = maxFileSize;
    this.ttl = ttlSeconds;
    this.known = new Set(); // hashes known to exist in the primary bucket (per instance)
  }

  file(sha) {
    return this.bucket.file(`blobs/${sha}`);
  }

  remember(sha) {
    if (this.known.size > 200000) this.known.clear();
    this.known.add(sha);
  }

  /** The file holding `sha`: the primary bucket, else the legacy one, else null. */
  async locate(sha) {
    if (this.known.has(sha)) return this.file(sha);
    const [inPrimary] = await this.file(sha).exists();
    if (inPrimary) {
      this.remember(sha);
      return this.file(sha);
    }
    if (this.legacy) {
      const old = this.legacy.file(`blobs/${sha}`);
      const [inLegacy] = await old.exists();
      if (inLegacy) {
        // Move it next to the API for next time (server-side copy, in the background).
        old.copy(this.file(sha), { preconditionOpts: { ifGenerationMatch: 0 } }).then(() => this.remember(sha), () => {});
        return old;
      }
    }
    return null;
  }

  async has(sha) {
    return !!(await this.locate(sha));
  }

  /** In the primary bucket? (Chunk checks use this: anything only in the legacy bucket is re-uploaded once.) */
  async hasHere(sha) {
    if (this.known.has(sha)) return true;
    const [exists] = await this.file(sha).exists();
    if (exists) this.remember(sha);
    return exists;
  }

  /** Size of a verified blob, or null if it is missing or its content does not match its name. */
  async size(sha) {
    const f = await this.locate(sha);
    if (!f) return null;
    let meta;
    try {
      [meta] = await f.getMetadata();
    } catch (e) {
      if (e.code === 404) return null;
      throw e;
    }
    const size = Number(meta.size);
    if (meta.metadata?.sha256 === sha) return size;
    if (size > this.maxFileSize) {
      await f.delete({ ignoreNotFound: true });
      return null;
    }
    const [bytes] = await f.download();
    if (sha256(bytes) !== sha) {
      await f.delete({ ignoreNotFound: true });
      return null;
    }
    await f.setMetadata({ metadata: { sha256: sha } });
    return size;
  }

  /** Stores bytes already verified by the caller (chunks); create-only. */
  async put(sha, bytes) {
    try {
      await this.file(sha).save(bytes, { resumable: false, contentType: 'application/octet-stream', metadata: { metadata: { sha256: sha } }, preconditionOpts: { ifGenerationMatch: 0 } });
    } catch (e) {
      if (e.code !== 412) throw e; // already stored
    }
    this.remember(sha);
  }

  async read(sha) {
    const f = await this.locate(sha);
    if (!f) throw Object.assign(new Error(`content ${sha.slice(0, 12)} not found`), { code: 404 });
    const [bytes] = await f.download();
    return bytes;
  }

  async uploadTarget(sha, size) {
    const headers = { 'x-goog-if-generation-match': '0', 'x-goog-content-length-range': `0,${Math.min(size, this.maxFileSize)}` };
    const [url] = await this.file(sha).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + this.ttl * 1000,
      extensionHeaders: headers,
    });
    return { url, headers };
  }

  async downloadUrl(sha) {
    const f = (await this.locate(sha)) ?? this.file(sha);
    const [url] = await f.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + this.ttl * 1000 });
    return url;
  }
}
