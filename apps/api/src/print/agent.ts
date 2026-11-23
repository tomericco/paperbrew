import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { BusyError } from '../brew/lifecycle.js';
import { renderIssuePdf } from '../brew/issuePdf.js';
import type { PaperLayout } from '../brew/layout.js';
import type { BrewArticle } from '../brew/render.js';
import { requireDevice, type DeviceEnv } from './devices.js';
import { UUID_RE } from '../uuid.js';

const ERROR_MAX = 500;

// `requireDevice` is applied per route, never as `use('/agent/*')`: POST /agent/pair is unauthenticated.
export const agent = new Hono<DeviceEnv>();

// The Mac asks for work. One statement picks the oldest queued issue of the device's user and marks it
// printing; `skip locked` makes two concurrent claims take different rows (or none), never the same.
agent.post('/agent/jobs/claim', requireDevice, async (c) => {
  const { rows } = await pool.query<{ id: string; layout: 'flat' | 'booklet' }>(
    `update issues set status = 'printing', claimed_by = $2, claimed_at = now()
     where status = 'queued' and id = (
       select id from issues
       where user_id = $1 and status = 'queued'
       order by created_at asc
       limit 1
       for update skip locked
     )
     returning id, layout`,
    [c.get('userId'), c.get('deviceId')],
  );
  const issue = rows[0];
  if (!issue) return c.body(null, 204);
  return c.json({ id: issue.id, layout: issue.layout });
});

const ResultBody = z.object({ ok: z.boolean(), error: z.string().optional() });

// The Mac reports how printing went. The state change is conditional on the issue still being this
// device's printing issue, so a double report or another device's id is a 404 and changes nothing.
// One exception: a success that arrives after the stale sweep failed the issue ('timed out') still
// counts, because the paper did print. A failure report (ok: false) never revives a timed-out issue.
agent.post('/agent/issues/:id/result', requireDevice, async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const body = ResultBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'ok (boolean) is required' }, 400);

  const deviceId = c.get('deviceId');
  const userId = c.get('userId');
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query('begin');
    const update = body.data.ok
      ? await client.query<{ article_ids: string[] }>(
          `update issues set status = 'printed', printed_at = now(), error = null
           where id = $1 and claimed_by = $2 and user_id = $3
             and (status = 'printing' or (status = 'failed' and error = 'timed out'))
           returning article_ids`,
          [id, deviceId, userId],
        )
      : await client.query<{ article_ids: string[] }>(
          `update issues set status = 'failed', error = $4
           where id = $1 and status = 'printing' and claimed_by = $2 and user_id = $3
           returning article_ids`,
          [id, deviceId, userId, Array.from(body.data.error?.trim() || 'The printer reported a failure').slice(0, ERROR_MAX).join('')],
        );
    const issue = update.rows[0];
    if (!issue) {
      await client.query('rollback');
      return c.json({ error: 'not found' }, 404);
    }
    if (body.data.ok) {
      await client.query(
        `update articles set archived_at = now(), archive_reason = 'printed', rollover_count = 0
         where id = any($1) and user_id = $2 and archived_at is null`,
        [issue.article_ids, userId],
      );
    }
    await client.query('commit');
    return c.body(null, 204);
  } catch (err) {
    // A failed rollback must not hide the original error; a connection that could not roll back is destroyed.
    rollbackFailed = !(await client.query('rollback').then(() => true, () => false));
    throw err;
  } finally {
    if (rollbackFailed) client.release(true);
    else client.release();
  }
});

// The Mac fetches the issue it claimed as a PDF. The articles are re-read now, so ones archived since
// the issue was queued are left out; if none remain the issue is marked printed and the answer is 204.
// A busy browser is a 503 with Retry-After and the issue stays `printing`, so the same device retries.
agent.get('/agent/issues/:id/pdf', requireDevice, async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const deviceId = c.get('deviceId');
  const userId = c.get('userId');

  const { rows: issues } = await pool.query<{ layout: PaperLayout; article_ids: string[] }>(
    `select layout, article_ids from issues
     where id = $1 and status = 'printing' and claimed_by = $2 and user_id = $3`,
    [id, deviceId, userId],
  );
  const issue = issues[0];
  if (!issue) return c.json({ error: 'not found' }, 404);

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
     where id = any($1) and user_id = $2 and status = 'ready' and archived_at is null
     order by array_position($1::uuid[], id)`,
    [issue.article_ids, userId],
  );

  if (rows.length === 0) {
    await pool.query(
      `update issues set status = 'printed', printed_at = now()
       where id = $1 and status = 'printing' and claimed_by = $2`,
      [id, deviceId],
    );
    return c.body(null, 204);
  }

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
    pdf = await renderIssuePdf(articles, issue.layout, date);
  } catch (err) {
    if (err instanceof BusyError) {
      return c.json({ error: 'Another magazine is brewing. Try again in a minute.' }, 503, { 'retry-after': '30' });
    }
    console.error('[print] render failed', err);
    return c.json({ error: "Couldn't render the issue." }, 500);
  }

  const day = date.toISOString().slice(0, 10); // UTC
  return c.body(pdf, 200, {
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="paperbrew-${day}${issue.layout === 'booklet' ? '-booklet' : ''}.pdf"`,
    'cache-control': 'private, no-store',
  });
});
