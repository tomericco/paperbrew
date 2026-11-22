import { Hono } from 'hono';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { enqueue } from '../jobs/queue.js';
import { requireUser, type UserEnv } from '../routes/library.js';
import { gmailAvailable } from './available.js';
import { authUrl, exchangeCode, getProfile, revokeToken } from './client.js';
import { decryptToken, encryptToken } from './crypto.js';
import { signState, verifyState } from './state.js';

export const gmail = new Hono<UserEnv>();

// The web app proxies /api/* to this API with the prefix stripped, so Google redirects to /api/gmail/callback
// and the route below is /gmail/callback (and /me/gmail is reached as /api/me/gmail).
const redirectUri = () => `${config.BETTER_AUTH_URL}/api/gmail/callback`;
const settingsUrl = (outcome: 'connected' | 'error') => `${config.BETTER_AUTH_URL}/app/settings?gmail=${outcome}`;

/** Only logs the message: errors from the token exchange must never put codes or tokens in the logs. */
const messageOf = (err: unknown) => (err instanceof Error ? err.message : 'unknown error');

gmail.use('/gmail/*', requireUser);
gmail.use('/me/gmail', requireUser);

// Connect and callback need the full Gmail config; status and disconnect do not.
gmail.use('/gmail/*', async (c, next) => {
  if (!gmailAvailable(process.env) || !config.GMAIL_TOKEN_KEY) return c.json({ error: 'gmail not configured' }, 503);
  await next();
});

gmail.get('/gmail/connect', (c) => {
  const state = signState(c.get('userId'), config.BETTER_AUTH_SECRET);
  return c.redirect(authUrl(state, redirectUri()), 302);
});

gmail.get('/gmail/callback', async (c) => {
  const fail = () => c.redirect(settingsUrl('error'), 302);
  const userId = c.get('userId');
  const { code, state, error } = c.req.query();

  // `error` is Google's answer when the user clicks Cancel (access_denied).
  if (error || !code || !state) return fail();
  const verified = verifyState(state, config.BETTER_AUTH_SECRET);
  if (!verified || verified.userId !== userId) return fail();

  try {
    const { accessToken, refreshToken } = await exchangeCode(code, redirectUri());
    // Without a refresh token we could not sync later, so there is nothing worth storing.
    if (!refreshToken) return fail();
    // Only mail arriving after this point is considered: the profile's history id is the starting line.
    const profile = await getProfile(accessToken);

    await pool.query(
      `insert into gmail_connections (user_id, google_email, refresh_token_enc, history_id, status, last_error, connected_at, last_synced_at)
       values ($1, $2, $3, $4, 'active', null, now(), null)
       on conflict (user_id) do update set
         google_email = excluded.google_email,
         refresh_token_enc = excluded.refresh_token_enc,
         history_id = excluded.history_id,
         status = 'active',
         last_error = null,
         connected_at = now()`,
      [userId, profile.emailAddress, encryptToken(refreshToken, config.GMAIL_TOKEN_KEY!), profile.historyId],
    );
    await enqueue(pool, 'gmail_sync', { id: userId });
  } catch (err) {
    console.warn('[gmail] connect failed:', messageOf(err));
    return fail();
  }
  return c.redirect(settingsUrl('connected'), 302);
});

gmail.get('/me/gmail', async (c) => {
  const userId = c.get('userId');
  const { rows } = await pool.query<{ google_email: string; status: string; last_synced_at: Date | null }>(
    'select google_email, status, last_synced_at from gmail_connections where user_id = $1',
    [userId],
  );
  const connection = rows[0];
  if (!connection) return c.json({ connected: false });

  const { rows: recent } = await pool.query<{
    from_email: string | null;
    subject: string | null;
    decision: string;
    reason: string | null;
    seen_at: Date;
  }>(
    `select from_email, subject, decision, reason, seen_at
     from gmail_messages where user_id = $1
     order by seen_at desc limit 20`,
    [userId],
  );
  return c.json({
    connected: true,
    email: connection.google_email,
    status: connection.status,
    lastSyncedAt: connection.last_synced_at,
    recent: recent.map((r) => ({
      from: r.from_email,
      subject: r.subject,
      decision: r.decision,
      reason: r.reason,
      seenAt: r.seen_at,
    })),
  });
});

// Leaves gmail_messages and gmail_blocked_senders alone: they are the user's history and rules.
gmail.delete('/me/gmail', async (c) => {
  const { rows } = await pool.query<{ refresh_token_enc: string }>(
    'delete from gmail_connections where user_id = $1 returning refresh_token_enc',
    [c.get('userId')],
  );
  const enc = rows[0]?.refresh_token_enc;
  if (enc && config.GMAIL_TOKEN_KEY) {
    let refreshToken: string | null = null;
    try {
      refreshToken = decryptToken(enc, config.GMAIL_TOKEN_KEY);
    } catch (err) {
      console.warn('[gmail] could not decrypt the token to revoke it:', messageOf(err));
    }
    if (refreshToken) await revokeToken(refreshToken);
  }
  return c.body(null, 204);
});
