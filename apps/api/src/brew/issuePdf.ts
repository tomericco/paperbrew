import { htmlToPdf } from './pdf.js';
import { imposeBooklet } from './booklet.js';
import type { PaperLayout } from './layout.js';
import type { PaperLook } from './look.js';
import { magazineDirection, renderMagazine, type BrewArticle } from './render.js';

/**
 * Renders articles into a printable PDF stream: flat A4 pages, or A5 pages imposed two-up on A4
 * landscape sheets for a booklet. Shared by GET /brew and the print agent's PDF route.
 * Throws BusyError (from brew/lifecycle.ts) when no browser slot frees up in time.
 */
export async function renderIssuePdf(
  articles: BrewArticle[],
  layout: PaperLayout,
  date: Date,
  look: PaperLook = 'broadsheet',
): Promise<ReadableStream<Uint8Array>> {
  let pdf = await htmlToPdf(renderMagazine({ date, articles, layout, look }));
  if (layout === 'booklet') {
    // Read to the end: that is what releases the browser slot.
    // Imposition runs after the htmlToPdf stream is drained (slot already released) on purpose: keeps Chromium's slot short; it is ~1 s of CPU.
    const a5 = new Uint8Array(await new Response(pdf).arrayBuffer());
    const sheets = await imposeBooklet(a5, magazineDirection(articles));
    pdf = new ReadableStream({
      start(controller) {
        controller.enqueue(sheets);
        controller.close();
      },
    });
  }
  return pdf;
}
