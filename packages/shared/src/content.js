// Content normalization (DESIGN §8.1). Text is stored and hashed as LF without BOM;
// each local instance keeps its own line-ending and BOM style when written.
import crypto from 'node:crypto';

export const EOL_MODES = ['auto', 'lf', 'crlf', 'binary'];
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Binary if there is a NUL byte in the first 8 KB, like git. */
export function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Style of an existing local file: { eol: 'lf' | 'crlf' | null, bom: bool }. */
export function detectStyle(buf) {
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let eol = null;
  const i = buf.indexOf(0x0a);
  if (i >= 0) eol = i > 0 && buf[i - 1] === 0x0d ? 'crlf' : 'lf';
  return { eol, bom };
}

/**
 * Canonical bytes for storage and hashing.
 * Returns { bytes, text: bool }. Binary (or eol=binary) content is unchanged.
 */
export function canonicalize(buf, eolMode = 'auto') {
  if (eolMode === 'binary' || isBinary(buf)) return { bytes: buf, text: false };
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  const out = Buffer.allocUnsafe(buf.length - start);
  let j = 0;
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[j++] = buf[i];
  }
  return { bytes: out.subarray(0, j), text: true };
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Hash of the canonical form; a line-ending or BOM difference alone is never a change. */
export function contentHash(buf, eolMode = 'auto') {
  return sha256(canonicalize(buf, eolMode).bytes);
}

/**
 * Bytes to write locally for canonical content.
 * `style` is the existing local file's style (detectStyle) or null for a fresh pull.
 */
export function renderForLocal(canonical, eolMode, style, platformEol) {
  if (eolMode === 'binary' || isBinary(canonical)) return canonical;
  let eol;
  if (eolMode === 'lf' || eolMode === 'crlf') eol = eolMode;
  else eol = style?.eol ?? platformEol;
  let body = canonical;
  if (eol === 'crlf') {
    let count = 0;
    for (const b of canonical) if (b === 0x0a) count++;
    body = Buffer.allocUnsafe(canonical.length + count);
    let j = 0;
    for (const b of canonical) {
      if (b === 0x0a) body[j++] = 0x0d;
      body[j++] = b;
    }
  }
  return style?.bom ? Buffer.concat([BOM, body]) : body;
}

/** Default eol mode for a file name, before repo overrides. */
export function defaultEolFor(name) {
  const lower = name.toLowerCase();
  if (/\.(sh|bash|zsh)$/.test(lower)) return 'lf';
  if (/\.(bat|cmd)$/.test(lower)) return 'crlf';
  return 'auto';
}

/** Minimal glob match for eol rules: `*` within a segment, `**` across segments. */
export function globMatch(glob, relPath) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const target = glob.includes('/') ? relPath : relPath.split('/').pop();
  return new RegExp('^' + re + '$', 'i').test(target);
}

/** Resolve the eol mode for a file given repo rules ({glob: mode}) and an explicit override. */
export function resolveEol(relPath, repoRules = {}, explicit) {
  if (explicit) return explicit;
  for (const [glob, mode] of Object.entries(repoRules)) if (globMatch(glob, relPath)) return mode;
  return defaultEolFor(relPath);
}
