// Content-defined chunking (FastCDC-style gear hash) for delta sync. A file is split where its
// content says so, not at fixed offsets, so an edit only changes the chunks around it and
// everything else keeps the same hashes - even when bytes are inserted or removed earlier.
// The parameters and the gear table are part of the format: changing them never breaks
// correctness, but it stops new versions from sharing chunks with old ones.
import { sha256 } from './content.js';

export const CHUNK_MIN = 2 * 1024;
export const CHUNK_AVG = 8 * 1024;
export const CHUNK_MAX = 64 * 1024;
// Before the average size cut points are rare (15 bits), after it common (11 bits). Only the
// high bits are tested: with a shift-by-one gear hash they depend on the last 32 bytes.
const MASK_HARD = 0xfffe0000;
const MASK_EASY = 0xffe00000;

const GEAR = (() => {
  // mulberry32, fixed seed: the table must never change.
  let a = 0x7e7e7e7e;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    t[i] = (x ^ (x >>> 14)) >>> 0;
  }
  return t;
})();

/** Chunk boundaries of `buf` as [{ o: offset, s: size }]. */
export function chunkBoundaries(buf) {
  const out = [];
  const n = buf.length;
  let start = 0;
  while (start < n) {
    if (n - start <= CHUNK_MIN) {
      out.push({ o: start, s: n - start });
      break;
    }
    const end = Math.min(n, start + CHUNK_MAX);
    const normal = Math.min(end, start + CHUNK_AVG);
    let h = 0;
    let cut = end;
    let i = start + CHUNK_MIN;
    for (; i < normal; i++) {
      h = ((h << 1) + GEAR[buf[i]]) >>> 0;
      if ((h & MASK_HARD) === 0) {
        cut = i + 1;
        break;
      }
    }
    if (cut === end) {
      for (; i < end; i++) {
        h = ((h << 1) + GEAR[buf[i]]) >>> 0;
        if ((h & MASK_EASY) === 0) {
          cut = i + 1;
          break;
        }
      }
    }
    out.push({ o: start, s: cut - start });
    start = cut;
  }
  return out;
}

/**
 * A file's chunk list (the "manifest"): [{ h: sha256, s: size }], plus the bytes of each chunk.
 * An empty file has no chunks.
 */
export function chunkContent(buf) {
  return chunkBoundaries(buf).map(({ o, s }) => {
    const bytes = buf.subarray(o, o + s);
    return { h: sha256(bytes), s, bytes };
  });
}

/** Manifest only: [{ h, s }]. */
export const manifestOf = (buf) => chunkContent(buf).map(({ h, s }) => ({ h, s }));
