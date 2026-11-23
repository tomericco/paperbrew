import { config } from '../config.js';
import { pool } from '../db/client.js';
import { extractNewsletter } from '../extract/readable.js';
import { findDuplicateNewsletter } from '../inbound/dedupe.js';
import { cleanSubject, displayName } from '../inbound/plan.js';
import * as realGmail from './client.js';
import { GmailAuthError, HistoryExpiredError } from './client.js';
import { classifyEmail } from './classify.js';
import { decryptToken } from './crypto.js';
import { decodeBody, header, stripNul } from './mime.js';
import { passesBodyRules, passesMetadataRules, senderEmail } from './rules.js';

export const MAX_PER_SYNC = 200;
export const FALLBACK_QUERY = 'newer_than:2d -in:sent -in:chats -in:drafts';

type Decision = 'rule_skip' | 'not_editorial' | 'editorial';
type Deps = {
  gmail?: typeof import('./client.js');
  classify?: typeof classifyEmail;
  /** The runner's final try: a message that still fails is recorded as skipped so the sync can move on. */
  lastAttempt?: boolean;
};
type Stats = { seen: number; saved: number };

const RECORD_SQL = `insert into gmail_messages (user_id, gmail_message_id, decision, reason, from_email, subject)
                    values ($1, $2, $3, $4, $5, $6)
                    on conflict (user_id, gmail_message_id) do nothing`;

function recordParams(userId: string, id: string, decision: Decision, reason: string, from: string | null, subject: string | null) {
  return [userId, id, decision, reason, from, subject];
}

/** A message deleted between listing and fetching comes back as a plain 404 error. */
const isGone = (err: unknown) => err instanceof Error && /\b404\b/.test(err.message);

/** On the last attempt, this many failures in a row mean something systemic: stop rather than skip mail. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Look at the user's new Gmail messages once each and keep the editorial newsletters as articles.
 * A GmailAuthError (revoked access) is handled here: the connection is flagged and the job finishes.
 * Any other error propagates so the runner retries; messages already recorded stay recorded.
 * On the last attempt a message that keeps failing is recorded as skipped ("error") and the sync carries
 * on, so one bad message cannot hold back every later one; after 3 failures in a row the error propagates.
 */
export async function syncGmail(userId: string, deps: Deps = {}): Promise<Stats> {
  const { rows } = await pool.query<{ refresh_token_enc: string; history_id: string }>(
    'select refresh_token_enc, history_id from gmail_connections where user_id = $1',
    [userId],
  );
  const conn = rows[0];
  const stats: Stats = { seen: 0, saved: 0 };
  if (!conn) return stats;
  if (!config.GMAIL_TOKEN_KEY) throw new Error('GMAIL_TOKEN_KEY is not set, so Gmail cannot be synced');
  const refreshToken = decryptToken(conn.refresh_token_enc, config.GMAIL_TOKEN_KEY);

  try {
    await run(
      userId,
      conn.refresh_token_enc,
      refreshToken,
      conn.history_id,
      deps.gmail ?? realGmail,
      deps.classify ?? classifyEmail,
      deps.lastAttempt ?? false,
      stats,
    );
  } catch (err) {
    if (!(err instanceof GmailAuthError)) throw err;
    // Guarded by the token this run started with: a reconnect meanwhile is a new connection, not this one.
    await pool.query(
      `update gmail_connections set status = 'needs_reconnect', last_error = $2
       where user_id = $1 and refresh_token_enc = $3`,
      [userId, err.message, conn.refresh_token_enc],
    );
  }
  return stats;
}

async function run(
  userId: string,
  tokenEnc: string,
  refreshToken: string,
  startHistoryId: string,
  gmail: typeof import('./client.js'),
  classify: typeof classifyEmail,
  lastAttempt: boolean,
  stats: Stats,
): Promise<void> {
  const token = await gmail.refreshAccessToken(refreshToken);

  let ids: string[];
  let nextHistoryId: string;
  try {
    ({ messageIds: ids, historyId: nextHistoryId } = await gmail.listHistory(token, startHistoryId));
  } catch (err) {
    if (!(err instanceof HistoryExpiredError)) throw err;
    // Read the profile first so mail arriving during the scan is picked up by the next sync.
    nextHistoryId = (await gmail.getProfile(token)).historyId;
    ids = await gmail.listMessages(token, FALLBACK_QUERY, MAX_PER_SYNC);
  }

  const { rows: seenRows } = await pool.query<{ gmail_message_id: string }>(
    'select gmail_message_id from gmail_messages where user_id = $1 and gmail_message_id = any($2)',
    [userId, ids],
  );
  const seen = new Set(seenRows.map((r) => r.gmail_message_id));
  const fresh = ids.filter((id) => !seen.has(id));
  const batch = fresh.slice(0, MAX_PER_SYNC);

  const { rows: blockedRows } = await pool.query<{ email: string }>(
    'select email from gmail_blocked_senders where user_id = $1',
    [userId],
  );
  const blocked = new Set(blockedRows.map((r) => r.email));

  let failuresInARow = 0;
  for (const id of batch) {
    stats.seen++;
    try {
      if (await processMessage(userId, token, id, gmail, classify, blocked)) stats.saved++;
      failuresInARow = 0;
    } catch (err) {
      // An auth error is about the connection, not the message: the caller handles it.
      if (!lastAttempt || err instanceof GmailAuthError) throw err;
      if (++failuresInARow >= MAX_CONSECUTIVE_FAILURES) throw err;
      console.warn(`[gmail] skipping message after repeated failures: ${(err as Error).message}`);
      await pool.query(RECORD_SQL, recordParams(userId, id, 'rule_skip', 'error', null, null));
    }
  }

  // Only after every message was recorded; with more left over, the next sync starts from the same
  // history_id and skips what is already recorded. Guarded by the token this run started with, so a run
  // that began before a disconnect and reconnect cannot write an older history_id to the new connection.
  if (fresh.length > MAX_PER_SYNC) {
    await pool.query('update gmail_connections set last_synced_at = now() where user_id = $1 and refresh_token_enc = $2', [
      userId,
      tokenEnc,
    ]);
  } else {
    await pool.query(
      `update gmail_connections set history_id = $2, last_synced_at = now(), last_error = null, status = 'active'
       where user_id = $1 and refresh_token_enc = $3`,
      [userId, nextHistoryId, tokenEnc],
    );
  }
}

/** Returns true when an article was saved. */
async function processMessage(
  userId: string,
  token: string,
  id: string,
  gmail: typeof import('./client.js'),
  classify: typeof classifyEmail,
  blocked: Set<string>,
): Promise<boolean> {
  const skip = (decision: Decision, reason: string, from: string | null, subject: string | null) =>
    pool.query(RECORD_SQL, recordParams(userId, id, decision, reason, from, subject));

  let metaMsg;
  try {
    metaMsg = await gmail.getMessage(token, id, 'metadata');
  } catch (err) {
    if (!isGone(err)) throw err;
    await skip('rule_skip', 'gone', null, null);
    return false;
  }
  const from = stripNul(header(metaMsg, 'from') ?? '');
  const subject = stripNul(header(metaMsg, 'subject') ?? '');
  const fromEmail = senderEmail(from);

  const metaCheck = passesMetadataRules(
    { listUnsubscribe: header(metaMsg, 'list-unsubscribe'), listId: header(metaMsg, 'list-id'), from },
    blocked,
  );
  if (!metaCheck.ok) {
    // Mail that is not a list is none of our business: keep nothing but the fact that it was seen.
    const keep = metaCheck.reason !== 'not-a-list';
    await skip('rule_skip', metaCheck.reason, keep ? fromEmail : null, keep ? subject : null);
    return false;
  }

  let fullMsg;
  try {
    fullMsg = await gmail.getMessage(token, id, 'full');
  } catch (err) {
    if (!isGone(err)) throw err;
    await skip('rule_skip', 'gone', fromEmail, subject);
    return false;
  }
  const decoded = decodeBody(fullMsg.payload);
  const body = { html: stripNul(decoded.html), text: stripNul(decoded.text) };
  const bodyCheck = passesBodyRules(body);
  if (!bodyCheck.ok) {
    await skip('rule_skip', bodyCheck.reason, fromEmail, subject);
    return false;
  }

  const verdict = await classify({ subject, html: body.html, text: body.text });
  if (!verdict.editorial) {
    await skip('not_editorial', verdict.reason, fromEmail, subject);
    return false;
  }

  const title = cleanSubject(subject);
  const messageId = stripNul(header(fullMsg, 'message-id') ?? '').trim() || null;
  if (await findDuplicateNewsletter(pool, userId, { messageId, title }, 'gmail')) {
    await skip('rule_skip', 'duplicate', fromEmail, subject);
    return false;
  }

  const a = extractNewsletter({ html: body.html, text: body.text, title, author: displayName(from) });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const ins = await client.query(
      `insert into articles (user_id, source_type, added_via, title, author, site_name, excerpt, content_html,
         text_content, word_count, reading_minutes, status, gmail_message_id, message_id)
       values ($1, 'email', 'gmail', $2, $3, $4, $5, $6, $7, $8, $9, 'ready', $10, $11)
       on conflict do nothing`,
      [userId, a.title, a.author, a.siteName, a.excerpt, a.contentHtml, a.textContent, a.wordCount,
       a.readingMinutes, id, messageId],
    );
    await client.query(RECORD_SQL, recordParams(userId, id, 'editorial', verdict.reason, fromEmail, subject));
    await client.query('commit');
    return (ins.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
