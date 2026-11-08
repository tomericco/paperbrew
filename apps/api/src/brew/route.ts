import { Hono } from 'hono';
import { pool } from '../db/client.js';
import { requireUser, type UserEnv } from '../routes/library.js';
import { BusyError } from './lifecycle.js';
import { htmlToPdf } from './pdf.js';
import { imposeBooklet } from './booklet.js';
import type { PaperLayout } from './layout.js';
import { magazineDirection, renderMagazine, type BrewArticle } from './render.js';

const MAX_ARTICLES = 50;

/** GET /brew: the signed-in user's ready articles as a printable PDF magazine. */
export const brew = new Hono<UserEnv>();
brew.use('/brew', requireUser);

brew.get('/brew', async (c) => {
  const { rows } = await pool.query<{
    title: string | null;
    author: string | null;
    site_name: string | null;
    source_url: string | null;
    reading_minutes: number | null;
    content_html: string | null;
  }>(
    `select title, author, site_name, source_url, reading_minutes, content_html
     from articles
     where user_id = $1 and status = 'ready'
     order by created_at asc
     limit ${MAX_ARTICLES}`,
    [c.get('userId')],
  );

  const { rows: users } = await pool.query<{ paper_layout: string | null }>(
    'select paper_layout from users where id = $1',
    [c.get('userId')],
  );
  const layout: PaperLayout = users[0]?.paper_layout === 'booklet' ? 'booklet' : 'flat';

  const articles: BrewArticle[] = rows.map((r) => ({
    title: r.title,
    author: r.author,
    siteName: r.site_name,
    sourceUrl: r.source_url,
    readingMinutes: r.reading_minutes,
    contentHtml: r.content_html,
  }));

  const date = new Date();
  let pdf: ReadableStream<Uint8Array>;
  try {
    pdf = await htmlToPdf(renderMagazine({ date, articles, layout }));
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
  } catch (err) {
    if (err instanceof BusyError) {
      return c.json({ error: 'Another magazine is brewing. Try again in a minute.' }, 503);
    }
    console.error('[brew] render failed', err);
    return c.json({ error: "Couldn't brew the magazine. Try again." }, 500);
  }

  const day = date.toISOString().slice(0, 10); // UTC
  // Streamed (no content-length), so Vercel's 4.5 MB response cap doesn't apply.
  return c.body(pdf, 200, {
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="paperbrew-${day}${layout === 'booklet' ? '-booklet' : ''}.pdf"`,
    'cache-control': 'private, no-store',
  });
});
