// Regenerates assets/icon.icns (the app icon): a white sheet of paper on a rounded warm-brown square.
// Needs macOS (uses `sips` and `iconutil`). Run: node apps/mac/scripts/make-app-icon.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const SIZE = 1024;
const SS = 3; // supersampling per axis
const BG = [0x8a, 0x4b, 0x2a];
const PAPER = [0xfb, 0xf6, 0xea];
const FOLD = [0xe0, 0xd2, 0xb8];
const INK = [0x8a, 0x4b, 0x2a];

// Shapes in a 1024 unit square. The icon body follows Apple's template: 824px rounded square (radius ~185) centred.
const body = { x0: 100, y0: 100, x1: 924, y1: 924, r: 185 };
const sheet = [[312, 232], [584, 232], [712, 360], [712, 792], [312, 792]];
const foldTri = [[584, 232], [584, 360], [712, 360]];
const lines = [[[392, 500], [632, 500]], [[392, 590], [632, 590]], [[392, 680], [552, 680]]];
const HALF = 17;

function inRoundRect({ x0, y0, x1, y1, r }, x, y) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return Math.hypot(x - cx, y - cy) <= r;
}
function inPoly(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function distSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// Returns [r,g,b,a] (0..255, a 0 or 255) for one sub-sample.
function sample(x, y) {
  if (!inRoundRect(body, x, y)) return null;
  if (lines.some((l) => distSeg(x, y, l[0], l[1]) <= HALF)) return INK;
  if (inPoly(foldTri, x, y)) return FOLD;
  if (inPoly(sheet, x, y)) return PAPER;
  return BG;
}

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
function png() {
  const stride = SIZE * 4 + 1;
  const raw = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, hit = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) { r += c[0]; g += c[1]; b += c[2]; hit++; }
      }
      const o = y * stride + 1 + x * 4;
      if (hit) {
        raw[o] = Math.round(r / hit); raw[o + 1] = Math.round(g / hit); raw[o + 2] = Math.round(b / hit);
        raw[o + 3] = Math.round((255 * hit) / (SS * SS));
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbrew-icon-'));
const master = path.join(work, 'icon-1024.png');
const iconset = path.join(work, 'icon.iconset');
fs.mkdirSync(iconset);
fs.writeFileSync(master, png());
for (const base of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = base * scale;
    const name = `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`;
    execFileSync('sips', ['-z', String(px), String(px), master, '--out', path.join(iconset, name)], { stdio: 'ignore' });
  }
}
const out = path.join(__dirname, '..', 'assets', 'icon.icns');
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out]);
fs.rmSync(work, { recursive: true, force: true });
console.log('wrote', out);
