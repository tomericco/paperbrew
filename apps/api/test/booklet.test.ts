import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { bookletSheets, imposeBooklet } from '../src/brew/booklet.js';

describe('bookletSheets', () => {
  it('orders 8 pages left-to-right', () => {
    expect(bookletSheets(8, 'ltr')).toEqual([
      { front: [7, 0], back: [1, 6] },
      { front: [5, 2], back: [3, 4] },
    ]);
  });

  it('orders 8 pages right-to-left', () => {
    expect(bookletSheets(8, 'rtl')).toEqual([
      { front: [0, 7], back: [6, 1] },
      { front: [2, 5], back: [4, 3] },
    ]);
  });

  it('pads a single page with blanks', () => {
    expect(bookletSheets(1, 'ltr')).toEqual([{ front: [null, 0], back: [null, null] }]);
  });

  it('turns padding indices into null', () => {
    expect(bookletSheets(7, 'ltr')[0].front).toEqual([null, 0]);
  });

  it('returns no sheets for zero pages', () => {
    expect(bookletSheets(0, 'ltr')).toEqual([]);
  });

  for (const direction of ['ltr', 'rtl'] as const) {
    it(`places every page exactly once (${direction})`, () => {
      for (const n of [1, 4, 5, 7, 8, 9, 50]) {
        const sheets = bookletSheets(n, direction);
        expect(sheets).toHaveLength(Math.ceil(n / 4));
        const placed = sheets
          .flatMap((s) => [...s.front, ...s.back])
          .filter((p): p is number => p !== null)
          .sort((a, b) => a - b);
        expect(placed).toEqual(Array.from({ length: n }, (_, i) => i));
      }
    });
  }
});

describe('imposeBooklet', () => {
  it('puts A5 pages two-up on A4 landscape sheets', async () => {
    const src = await PDFDocument.create();
    for (let i = 0; i < 5; i++) {
      // pdf-lib refuses to embed a page with no content stream, so draw something.
      src.addPage([419.53, 595.28]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    }
    const out = await PDFDocument.load(await imposeBooklet(await src.save(), 'ltr'));

    const pages = out.getPages();
    expect(pages).toHaveLength(4);
    for (const page of pages) {
      const { width, height } = page.getSize();
      expect(Math.abs(width - 841.89)).toBeLessThan(0.01);
      expect(Math.abs(height - 595.28)).toBeLessThan(0.01);
    }
  });
});
