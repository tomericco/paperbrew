import { Hono } from 'hono';
import { pool } from '../db/client.js';
import { requireUser, type UserEnv } from '../routes/library.js';
import { htmlToPdf } from './pdf.js';
import { renderMagazine } from './render.js';

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

  const date = new Date();
  let pdf: Uint8Array;
  try {
    const html = renderMagazine({
      date,
      articles: rows.map((r) => ({
        title: r.title,
        author: r.author,
        siteName: r.site_name,
        sourceUrl: r.source_url,
        readingMinutes: r.reading_minutes,
        contentHtml: r.content_html,
      })),
    });
    pdf = await htmlToPdf(html);
  } catch (err) {
    console.error('[brew] render failed', err);
    return c.json({ error: "Couldn't brew the magazine. Try again." }, 500);
  }

  const day = date.toISOString().slice(0, 10); // UTC
  return c.body(pdf as Uint8Array<ArrayBuffer>, 200, {
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="paperbrew-${day}.pdf"`,
    'cache-control': 'private, no-store',
  });
});
