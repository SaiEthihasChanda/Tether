import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chunkContent, chunkBoundaries, CHUNK_MIN, CHUNK_MAX } from '../src/index.js';

const text = (n, seed = 1) => {
  // pseudo-random words, deterministic
  let x = seed;
  const words = [];
  let len = 0;
  while (len < n) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const w = x.toString(36);
    words.push(w);
    len += w.length + 1;
  }
  return Buffer.from(words.join(' ').slice(0, n));
};

test('chunks cover the file exactly and respect size limits', () => {
  for (const buf of [Buffer.alloc(0), Buffer.from('tiny'), text(CHUNK_MIN + 1), text(300_000), crypto.randomBytes(500_000)]) {
    const parts = chunkBoundaries(buf);
    assert.equal(parts.reduce((a, p) => a + p.s, 0), buf.length);
    parts.forEach((p, i) => {
      assert.ok(p.s <= CHUNK_MAX);
      if (i < parts.length - 1) assert.ok(p.s > CHUNK_MIN);
    });
  }
  assert.deepEqual(chunkContent(Buffer.alloc(0)), []);
});

test('chunking is deterministic', () => {
  const buf = text(200_000);
  assert.deepEqual(chunkContent(buf).map((c) => c.h), chunkContent(Buffer.from(buf)).map((c) => c.h));
});

test('a small edit in the middle changes only a few chunks (insertions shift nothing else)', () => {
  const a = text(1_000_000, 7);
  const mid = 500_000;
  const b = Buffer.concat([a.subarray(0, mid), Buffer.from(' INSERTED A FEW WORDS HERE '), a.subarray(mid)]);
  const ha = new Set(chunkContent(a).map((c) => c.h));
  const cb = chunkContent(b);
  const changed = cb.filter((c) => !ha.has(c.h));
  assert.ok(cb.length > 50, `expected many chunks, got ${cb.length}`);
  assert.ok(changed.length <= 3, `${changed.length} of ${cb.length} chunks changed`);
});
