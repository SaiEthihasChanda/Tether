// Local file operations used by the sync engine.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalize, sha256, detectStyle, renderForLocal } from '@tether/shared';
import { isWindows } from './paths.js';

export const platformEol = isWindows ? 'crlf' : 'lf';

export class LockedError extends Error {}

export const samePath = (a, b) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);

/** True if `child` is `dir` itself or inside it. */
export function isUnder(child, dir) {
  const rel = path.relative(dir, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Real on-disk path with the true letter case. */
export function canonicalPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Reads a local file: { bytes, canonical, hash, style, size, mtimeMs } or null if missing. */
export function readLocal(p, eolMode) {
  let bytes, st;
  try {
    bytes = fs.readFileSync(p);
    st = fs.statSync(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
    if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw new LockedError(`${p} is locked by another program`);
    throw e;
  }
  const canonical = canonicalize(bytes, eolMode).bytes;
  return { bytes, canonical, hash: sha256(canonical), style: detectStyle(bytes), size: st.size, mtimeMs: st.mtimeMs };
}

/**
 * Writes canonical content to `p` in place (truncate + write) so the file keeps its ID
 * (DESIGN §5.5). Line endings and BOM come from `style` (the copy's recorded style), else
 * from the existing file; fresh files use the platform default.
 * Returns { size, mtimeMs, eolStyle, hasBom }.
 */
export function writeLocal(p, canonical, eolMode, { exec = false, style = null } = {}) {
  let existing = null;
  try {
    existing = fs.readFileSync(p);
  } catch (e) {
    if (e.code !== 'ENOENT') throw toLocked(e, p);
  }
  const useStyle = style ?? (existing ? detectStyle(existing) : null);
  const bytes = renderForLocal(canonical, eolMode, useStyle, platformEol);
  try {
    if (existing) {
      const fd = fs.openSync(p, 'r+');
      try {
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, bytes, 0, bytes.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, bytes, { flag: 'wx' });
    }
    if (!isWindows) fs.chmodSync(p, exec ? 0o755 : fs.statSync(p).mode & ~0o111 & 0o777);
  } catch (e) {
    throw toLocked(e, p);
  }
  const st = fs.statSync(p);
  const written = detectStyle(bytes);
  return { size: st.size, mtimeMs: st.mtimeMs, eolStyle: written.eol ?? useStyle?.eol ?? null, hasBom: written.bom };
}

/** Style fields to record for a local file read with readLocal. */
export const styleOf = (local) => ({ eolStyle: local.style.eol, hasBom: local.style.bom });

function toLocked(e, p) {
  if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return new LockedError(`${p} is locked or read-only; will retry`);
  return e;
}

/** "name (local copy).ext", numbered if taken (DESIGN §13 Q7: next to the original). */
export function keepBothName(p) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${stem} (local copy${n > 1 ? ' ' + n : ''})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** Moves `from` to `to`, creating parent folders. Rename keeps the file ID. */
export function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

/** Removes empty folders from `dir` up to (not including) `stopAt`. */
export function pruneEmptyDirs(dir, stopAt) {
  while (isUnder(dir, stopAt) && !samePath(dir, stopAt)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** All regular files under `root`, as { abs, rel (posix) }; symlinks are reported separately. */
export function walkFiles(root) {
  const files = [];
  const symlinks = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isSymbolicLink()) symlinks.push(rel);
      else if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) files.push({ abs, rel });
    }
  }
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), symlinks };
}
