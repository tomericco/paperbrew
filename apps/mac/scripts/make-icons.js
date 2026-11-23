// Regenerates every Mac app icon from the Paperbrew logo geometry (apps/web/src/Logo.tsx, public/favicon.svg):
//   assets/icon.icns            Dock/Finder icon: cream mark on a near-black macOS rounded square with a soft shadow
//   assets/IconTemplate.png     menu-bar tray icon, 22x22, pure black on transparent (macOS tints it)
//   assets/IconTemplate@2x.png  the same at 44x44
// Needs macOS (uses `iconutil`) and `sharp`, which is deliberately NOT a dependency of the repo:
//   npm i --no-save sharp            (from the repo root; or install it elsewhere and set NODE_PATH)
//   node apps/mac/scripts/make-icons.js
// Line weights are heavier than the on-screen logo (2.6) so the mark still reads at 16 px and in the menu bar.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

const assets = path.join(__dirname, '..', 'assets');

// The mark on its 64-unit grid. Keep in sync with Logo.tsx. `detail: false` drops the cup rail and gauge, which would clog at tray size.
function mark({ stroke, pour, detail = true }) {
  return `<g fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    ${detail ? '<path d="M20 4h24"/>' : ''}
    <rect x="16" y="8" width="32" height="46" rx="4"/>
    ${detail ? '<circle cx="32" cy="15" r="3.5"/>' : ''}
    <path d="M25 22h14v3a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3z"/>
    <path d="M39 24.5h14"/>
    <path d="M29.5 28h5l-1 3h-3z"/>
    <path stroke-width="${pour}" d="M32 31.5v8.5"/>
    <path d="M23 41h18a9 10.4 0 0 1-18 0z"/>
    <path d="M12 54h40v5H12z"/>
  </g>`;
}
// The mark's bounding box is 40 wide x 55 tall (51 without the rail), centred on x 32 and y `midY`.
const place = (cx, cy, height, units = 55, midY = 31.5) => `translate(${cx} ${cy}) scale(${height / units}) translate(-32 ${-midY})`;

// Heavier strokes at small sizes, where a hairline would vanish.
function weights(px) {
  if (px <= 32) return { stroke: 4.8, pour: 6.2 };
  if (px <= 64) return { stroke: 4.2, pour: 5.4 };
  if (px <= 256) return { stroke: 3.6, pour: 4.8 };
  return { stroke: 3.2, pour: 4.4 };
}

// 1024 design: Apple's template body (824 square, radius 185, centred) plus its drop shadow; the mark is ~64% of the body.
function appIconSvg(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1024 1024">
  <defs><filter id="s" x="-10%" y="-10%" width="120%" height="125%">
    <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/></filter></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#111" filter="url(#s)"/>
  <g color="#F7F3EA" transform="${place(512, 512, 527)}">${mark(weights(px))}</g>
</svg>`;
}

// Tray template: ~18 px of glyph height in a 22 px canvas, pure black.
function trayIconSvg(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 22 22">
  <g color="#000" transform="${place(11, 11, 18, 51, 33.5)}">${mark({ stroke: 3.8, pour: 5, detail: false })}</g>
</svg>`;
}

const render = (svg, file) => sharp(Buffer.from(svg), { density: 72 }).png().toFile(file);

async function main() {
  await render(trayIconSvg(22), path.join(assets, 'IconTemplate.png'));
  await render(trayIconSvg(44), path.join(assets, 'IconTemplate@2x.png'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbrew-icon-'));
  const iconset = path.join(dir, 'icon.iconset');
  fs.mkdirSync(iconset);
  const entries = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];
  for (const [base, scale] of entries) {
    const px = base * scale;
    await render(appIconSvg(px), path.join(iconset, `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('wrote icon.icns, IconTemplate.png, IconTemplate@2x.png');
}
main().catch((e) => { console.error(e); process.exit(1); });
