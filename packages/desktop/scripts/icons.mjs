// Draws Tether's icon (two linked rings, white on a teal rounded square) at every size Windows
// needs and writes assets/icon.png, assets/tray.png and build/icon.ico. Pure Node: an
// anti-aliased signed-distance rasterizer, PNG via zlib, ICO holding PNG images.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEAL = [11, 127, 114];

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const s = size / 32; // design grid: 32 x 32
  const r = 6.6 * s, w = 3.0 * s; // ring radius and stroke width
  const rings = [[11.6 * s, 16 * s], [20.4 * s, 16 * s]];
  const corner = 7 * s, half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // rounded square: distance outside the box (negative inside)
      const qx = Math.abs(cx - half) - (half - corner), qy = Math.abs(cy - half) - (half - corner);
      const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
      const bg = Math.min(1, Math.max(0, 0.5 - box));
      let ring = 0;
      for (const [rx, ry] of rings) ring = Math.max(ring, Math.min(1, Math.max(0, w / 2 - Math.abs(Math.hypot(cx - rx, cy - ry) - r) + 0.5)));
      const i = (y * size + x) * 4;
      const a = bg;
      px[i] = Math.round(TEAL[0] * (1 - ring) + 255 * ring);
      px[i + 1] = Math.round(TEAL[1] * (1 - ring) + 255 * ring);
      px[i + 2] = Math.round(TEAL[2] * (1 - ring) + 255 * ring);
      px[i + 3] = Math.round(255 * a);
    }
  }
  return png(size, px);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function ico(images) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dir = images.map(([size, data]) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12); offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images.map(([, d]) => d)]);
}

fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), render(256));
fs.writeFileSync(path.join(root, 'assets', 'tray.png'), render(32));
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, render(s)])));
console.log('icons written');
