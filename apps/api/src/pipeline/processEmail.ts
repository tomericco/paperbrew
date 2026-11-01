import { pool } from '../db/client.js';
import { enqueue } from '../jobs/queue.js';
import { planEmail } from '../inbound/plan.js';
import type { InboundEmail } from '../inbound/types.js';
import { extractNewsletter } from '../extract/readable.js';

/** Turn one stored inbound email into article rows (links are fetched later by their own jobs). */
export async function processEmail(inboundEmailId: string): Promise<void> {
  const { rows } = await pool.query<{ user_id: string; payload: InboundEmail; status: string }>(
    'select user_id, payload, status from inbound_emails where id = $1',
    [inboundEmailId],
  );
  const row = rows[0];
  if (!row || row.status === 'processed') return;
  const email = row.payload;
  const plan = planEmail(email);

  const client = await pool.connect();
  try {
    await client.query('begin');
    let linksAdded = 0;
    for (const url of plan.urls) {
      const ins = await client.query<{ id: string }>(
        `insert into articles (user_id, source_type, source_url, canonical_url, inbound_email_id, added_via)
         values ($1, 'link', $2, $2, $3, 'email')
         on conflict do nothing
         returning id`,
        [row.user_id, url, inboundEmailId],
      );
      if (ins.rows[0]) {
        linksAdded++;
        await enqueue(client, 'fetch_article', { id: ins.rows[0].id });
      }
    }

    let newsletterSaved = false;
    if (plan.newsletter) {
      const a = extractNewsletter(plan.newsletter);
      const ins = await client.query(
        `insert into articles (user_id, source_type, inbound_email_id, added_via, title, author, site_name,
           excerpt, content_html, text_content, word_count, reading_minutes, status)
         values ($1, 'email', $2, 'email', $3, $4, $5, $6, $7, $8, $9, $10, 'ready')
         on conflict do nothing`,
        [row.user_id, inboundEmailId, a.title, a.author, a.siteName, a.excerpt, a.contentHtml,
         a.textContent, a.wordCount, a.readingMinutes],
      );
      newsletterSaved = (ins.rowCount ?? 0) > 0;
    }

    await client.query(
      `update inbound_emails set status = 'processed', result = $2, error = null where id = $1`,
      [inboundEmailId, { reason: plan.reason, urls: plan.urls, linksAdded, newsletterSaved }],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
