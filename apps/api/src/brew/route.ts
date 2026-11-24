import { Hono } from 'hono';
import { pool } from '../db/client.js';
import { requireUser, type UserEnv } from '../routes/library.js';
import { BusyError } from './lifecycle.js';
import { renderIssuePdf } from './issuePdf.js';
import type { PaperLayout } from './layout.js';
import { toPaperLook } from './look.js';
import type { BrewArticle } from './render.js';

const MAX_ARTICLES = 50;

/** GET /brew: the signed-in user's ready articles as a printable PDF magazine. */
export const brew = new Hono<UserEnv>();
brew.use('/brew', requireUser);

brew.get('/brew', async (c) => {
  const { rows } = await pool.query<{
    id: string;
    title: string | null;
    author: string | null;
    site_name: string | null;
    source_url: string | null;
    reading_minutes: number | null;
    content_html: string | null;
  }>(
    `select id, title, author, site_name, source_url, reading_minutes, content_html
     from articles
     where user_id = $1 and status = 'ready' and archived_at is null
     order by created_at asc
     limit ${MAX_ARTICLES}`,
    [c.get('userId')],
  );

  const { rows: users } = await pool.query<{ paper_layout: string | null; paper_look: string | null }>(
    'select paper_layout, paper_look from users where id = $1',
    [c.get('userId')],
  );
  const layout: PaperLayout = users[0]?.paper_layout === 'booklet' ? 'booklet' : 'flat';
  const look = toPaperLook(users[0]?.paper_look);

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
    pdf = await renderIssuePdf(articles, layout, date, look);
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
    // What went into this issue, in brew order, so the web app can archive exactly these.
    'x-brew-article-ids': rows.map((r) => r.id).join(','),
  });
});
