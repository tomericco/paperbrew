import { config } from '../config.js';
import { pool } from '../db/client.js';
import * as realGmail from './client.js';
import { GmailAuthError } from './client.js';
import { classifyEmail } from './classify.js';
import { decryptToken } from './crypto.js';
import { blockedSenders, flagNeedsReconnect, processMessages, unseenIds, type Deps, type Stats } from './sync.js';

// The one-off starter fetch after a first Gmail connect: a few recent newsletters, so the library is not empty
// on day one. The regular sync only looks at mail arriving after the connect.
export const STARTER_QUERY = 'newer_than:30d -in:sent -in:chats -in:drafts';
export const STARTER_MAX_SCAN = 40;
export const STARTER_TARGET = 3;

/**
 * Save up to STARTER_TARGET editorial newsletters from the last 30 days, looking at no more than
 * STARTER_MAX_SCAN messages, then record `starter_done_at` (also when nothing was found). Does nothing once
 * `starter_done_at` is set. A GmailAuthError flags the connection like syncGmail, records the starter as done
 * and resolves. Other errors propagate so the runner retries; the last attempt records it as done first, so
 * the welcome page never waits on a starter fetch that will not finish.
 */
export async function fetchStarterArticles(userId: string, deps: Deps = {}): Promise<{ scanned: number; saved: number }> {
  const { rows } = await pool.query<{ refresh_token_enc: string; starter_done_at: Date | null }>(
    'select refresh_token_enc, starter_done_at from gmail_connections where user_id = $1',
    [userId],
  );
  const conn = rows[0];
  const stats: Stats = { seen: 0, saved: 0 };
  const result = () => ({ scanned: stats.seen, saved: stats.saved });
  if (!conn || conn.starter_done_at) return result();
  if (!config.GMAIL_TOKEN_KEY) throw new Error('GMAIL_TOKEN_KEY is not set, so Gmail cannot be synced');
  const gmail = deps.gmail ?? realGmail;
  const lastAttempt = deps.lastAttempt ?? false;

  try {
    // Inside the try so a token that cannot be decrypted still marks the starter done on the last attempt.
    const refreshToken = decryptToken(conn.refresh_token_enc, config.GMAIL_TOKEN_KEY);
    const token = await gmail.refreshAccessToken(refreshToken);
    const ids = await unseenIds(userId, await gmail.listMessages(token, STARTER_QUERY, STARTER_MAX_SCAN));
    const blocked = await blockedSenders(userId);
    await processMessages(userId, token, ids, {
      gmail,
      classify: deps.classify ?? classifyEmail,
      blocked,
      lastAttempt,
      stats,
      stopAt: STARTER_TARGET,
    });
  } catch (err) {
    if (err instanceof GmailAuthError) {
      await flagNeedsReconnect(userId, err, conn.refresh_token_enc);
    } else {
      if (lastAttempt) await markDone(userId, conn.refresh_token_enc);
      throw err;
    }
  }
  await markDone(userId, conn.refresh_token_enc);
  return result();
}

/** Guarded by the token the run started with, like the sync: a reconnect meanwhile is a new connection. */
async function markDone(userId: string, tokenEnc: string): Promise<void> {
  await pool.query(
    `update gmail_connections set starter_done_at = coalesce(starter_done_at, now())
     where user_id = $1 and refresh_token_enc = $2`,
    [userId, tokenEnc],
  );
}
