import { config } from '../config.js';
import { isUniqueViolation, pool } from '../db/client.js';
import { cleanUrl } from '../links/clean.js';
import { extractArticle } from '../extract/readable.js';
import { FetchError, fetchHtml } from '../fetch/safeFetch.js';

/** Fetch a saved link, extract the readable article, and fill in the row. Throws FetchError to retry. */
export async function fetchArticle(articleId: string, isLastAttempt: boolean): Promise<void> {
  const { rows } = await pool.query<{ user_id: string; source_url: string; status: string }>(
    'select user_id, source_url, status from articles where id = $1',
    [articleId],
  );
  const row = rows[0];
  if (!row || row.status === 'ready') return;

  try {
    const page = await fetchHtml(row.source_url, {
      timeoutMs: config.FETCH_TIMEOUT_MS,
      maxBytes: config.FETCH_MAX_BYTES,
    });
    const a = extractArticle(page.html, page.finalUrl);
    if (!a) throw new FetchError("Couldn't find an article on this page", false);

    const canonical = cleanUrl(a.canonicalUrl ?? page.finalUrl) ?? row.source_url;
    try {
      await pool.query(
        `update articles set canonical_url = $2, title = $3, author = $4, site_name = $5, excerpt = $6,
           content_html = $7, text_content = $8, word_count = $9, reading_minutes = $10,
           lead_image_url = $11, published_at = $12, status = 'ready', error = null, updated_at = now()
         where id = $1`,
        [articleId, canonical, a.title, a.author, a.siteName ?? new URL(page.finalUrl).hostname, a.excerpt,
         a.contentHtml, a.textContent, a.wordCount, a.readingMinutes, a.leadImageUrl, a.publishedAt],
      );
    } catch (err) {
      // Same article already saved under its canonical URL (e.g. sent once via a tracking link): drop the duplicate.
      if (isUniqueViolation(err)) {
        await pool.query('delete from articles where id = $1', [articleId]);
        return;
      }
      throw err;
    }
  } catch (err) {
    const retryable = err instanceof FetchError ? err.retryable : true;
    if (!retryable || isLastAttempt) {
      await pool.query(
        `update articles set status = 'failed', error = $2, updated_at = now() where id = $1`,
        [articleId, (err as Error).message.slice(0, 500)],
      );
      return;
    }
    throw err;
  }
}
