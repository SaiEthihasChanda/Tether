// Content-addressed blobs in Cloud Storage: blobs/{sha256}.
// Clients upload straight to Storage with short-lived signed URLs that are create-only
// (x-goog-if-generation-match: 0) and size-capped. Because Storage does not check sha256,
// a blob is verified (downloaded and hashed) the first time an artifact references it.
import { sha256 } from '@tether/shared';

export class GcsBlobStore {
  constructor(bucket, { maxFileSize, ttlSeconds = 600 }) {
    this.receive = false; // uploads go to Storage, not through the API
    this.bucket = bucket;
    this.maxFileSize = maxFileSize;
    this.ttl = ttlSeconds;
  }

  file(sha) {
    return this.bucket.file(`blobs/${sha}`);
  }

  async has(sha) {
    const [exists] = await this.file(sha).exists();
    return exists;
  }

  /** Size of a verified blob, or null if it is missing or its content does not match its name. */
  async size(sha) {
    const f = this.file(sha);
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

  async read(sha) {
    const [bytes] = await this.file(sha).download();
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
    const [url] = await this.file(sha).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + this.ttl * 1000 });
    return url;
  }
}
