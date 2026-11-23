// Regenerates assets/IconTemplate.png (22x22) and IconTemplate@2x.png (44x44): a black sheet-of-paper glyph on
// transparent, which macOS tints as a template image. Run: node apps/mac/scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SS = 8; // supersampling per axis, for smooth edges
const HALF_STROKE = 0.75;

// Shapes in a 22x22 unit square.
const outline = [[5, 2], [13, 2], [17, 6], [17, 20], [5, 20]];
const fold = [[13, 2], [13, 6], [17, 6]];
const lines = [[[8, 10], [14, 10]], [[8, 13], [14, 13]], [[8, 16], [12, 16]]];

function distSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const nearPath = (px, py, pts, closed) => {
  let d = Infinity;
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) d = Math.min(d, distSeg(px, py, pts[i], pts[(i + 1) % pts.length]));
  return d <= HALF_STROKE;
};
const covered = (x, y) =>
  nearPath(x, y, outline, true) || nearPath(x, y, fold, false) || lines.some((l) => nearPath(x, y, l, false));

function crc32(buf) {
  let c, crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const scale = size / 22;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        if (covered((x + (sx + 0.5) / SS) / scale, (y + (sy + 0.5) / SS) / scale)) hit++;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = raw[o + 1] = raw[o + 2] = 0;
      raw[o + 3] = Math.round((255 * hit) / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'IconTemplate.png'), png(22));
fs.writeFileSync(path.join(out, 'IconTemplate@2x.png'), png(44));
