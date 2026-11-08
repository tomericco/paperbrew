import { PDFDocument } from 'pdf-lib';
import type { Direction } from './direction.js';

/** One physical A4 sheet. Each pair is [left, right]; values are 0-based page indices, or null for a blank. */
export type Sheet = {
  front: [number | null, number | null];
  back: [number | null, number | null];
};

const A4_WIDTH = 841.89;
const A4_HEIGHT = 595.28;
const HALF = A4_WIDTH / 2;

/** Saddle-stitch order: which page sits on which half of each sheet side. */
export function bookletSheets(pageCount: number, direction: Direction): Sheet[] {
  const n = Math.ceil(pageCount / 4) * 4;
  const pick = (i: number): number | null => (i < pageCount ? i : null);
  const pair = (left: number, right: number): [number | null, number | null] =>
    direction === 'ltr' ? [pick(left), pick(right)] : [pick(right), pick(left)];

  const sheets: Sheet[] = [];
  for (let s = 0; s < n / 4; s++) {
    sheets.push({
      front: pair(n - 1 - 2 * s, 2 * s),
      back: pair(2 * s + 1, n - 2 - 2 * s),
    });
  }
  return sheets;
}

/** Places A5 pages two-up on A4 landscape sheets in booklet order (front, back, front, back...). */
export async function imposeBooklet(a5Pdf: Uint8Array, direction: Direction): Promise<Uint8Array> {
  const src = await PDFDocument.load(a5Pdf);
  const out = await PDFDocument.create();
  const embedded = await out.embedPages(src.getPages());

  for (const sheet of bookletSheets(embedded.length, direction)) {
    for (const side of [sheet.front, sheet.back]) {
      const page = out.addPage([A4_WIDTH, A4_HEIGHT]);
      side.forEach((index, position) => {
        if (index === null) return;
        const { width, height } = embedded[index];
        page.drawPage(embedded[index], {
          x: position * HALF + (HALF - width) / 2,
          y: (A4_HEIGHT - height) / 2,
        });
      });
    }
  }
  return out.save();
}
