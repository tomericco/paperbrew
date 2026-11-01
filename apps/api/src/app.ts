import { waitUntil } from '@vercel/functions';
import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db/client.js';
import { enqueue } from './jobs/queue.js';
import { drain } from './jobs/runner.js';
import { normalizePostmark } from './inbound/postmark.js';
import { normalizeCloudmailin } from './inbound/cloudmailin.js';
import type { InboundEmail } from './inbound/types.js';
import { addressTokens } from './inbound/address.js';
import { auth } from './auth/auth.js';
import { enabledProviders } from './auth/providers.js';
import { library } from './routes/library.js';
import { brew } from './brew/route.js';

export const app = new Hono();

// Stays well inside Vercel Hobby's 300 s function limit.
const DRAIN = { budgetMs: 50_000, concurrency: 4 };

app.get('/health', async (c) => {
  await pool.query('select 1');
  return c.json({ ok: true });
});

// Better Auth keeps its /api/auth prefix through both proxies (see apps/web vercel.json and vite.config.ts).
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Which sign-in buttons the web app should show.
app.get('/providers', (c) => c.json({ providers: enabledProviders(process.env) }));

// Signed-in user API: /me, /me/address, /articles.
app.route('/', library);

// GET /brew: the signed-in user's magazine as a PDF.
app.route('/', brew);

const webhookAuth = basicAuth({ username: config.INBOUND_WEBHOOK_USER, password: config.INBOUND_WEBHOOK_PASSWORD });

app.post('/webhooks/postmark/inbound', webhookAuth, async (c) => {
  let email;
  try {
    email = normalizePostmark(await c.req.json());
  } catch (err) {
    // Malformed payloads won't fix themselves on retry: acknowledge and log.
    console.warn('[inbound] rejected postmark payload', err instanceof ZodError ? err.issues : err);
    return c.json({ ok: true, ignored: 'malformed' });
  }
  return handleInbound(c, email);
});

app.post('/webhooks/cloudmailin/inbound', webhookAuth, async (c) => {
  let body: unknown;
  let email;
  try {
    body = await c.req.json();
    email = normalizeCloudmailin(body);
  } catch (err) {
    // Log the shape (top-level keys, no values) so a real payload that doesn't fit is visible in logs.
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : typeof body;
    console.warn('[inbound] rejected cloudmailin payload', err instanceof ZodError ? err.issues : err, { keys });
    return c.json({ ok: true, ignored: 'malformed' });
  }
  return handleInbound(c, email);
});

/** Shared by every provider: token -> user -> known sender -> store -> enqueue -> drain after the response. */
async function handleInbound(c: Context, email: InboundEmail) {
  const tokens = addressTokens(email.recipients, config.INBOUND_ADDRESS);
  if (!tokens.length) return c.json({ ok: true, ignored: 'no_paperbrew_recipient' });

  const { rows: users } = await pool.query<{ user_id: string; account_email: string | null }>(
    `select a.user_id, u.email as account_email
     from inbound_addresses a join users u on u.id = a.user_id
     where a.token = any($1) and a.disabled_at is null
     limit 1`,
    [tokens],
  );
  const user = users[0];
  if (!user) return c.json({ ok: true, ignored: 'unknown_address' });

  // A user without an account email (null) can only be matched through sender_aliases.
  if (config.REQUIRE_KNOWN_SENDER && email.from !== user.account_email?.toLowerCase()) {
    const { rowCount } = await pool.query(
      'select 1 from sender_aliases where user_id = $1 and lower(email) = $2 and verified_at is not null',
      [user.user_id, email.from],
    );
    if (!rowCount) return c.json({ ok: true, ignored: 'unknown_sender' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{ id: string }>(
      `insert into inbound_emails (user_id, provider, provider_message_id, message_id, from_email, subject, payload)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (provider, provider_message_id) do nothing
       returning id`,
      [user.user_id, email.provider, email.providerMessageId, email.messageId, email.from, email.subject, email],
    );
    if (rows[0]) await enqueue(client, 'process_email', { id: rows[0].id });
    await client.query('commit');
    // On Vercel there is no long-lived worker: run jobs after the response is sent.
    // Anything left over is picked up by the daily cron.
    if (rows[0] && process.env.VERCEL) {
      waitUntil(drain(DRAIN).catch((err) => console.error('[inbound] drain failed', err)));
    }
    return c.json({ ok: true, duplicate: !rows[0] });
  } catch (err) {
    await client.query('rollback');
    throw err; // 500 -> the provider retries
  } finally {
    client.release();
  }
}

app.get('/cron/run-jobs', async (c) => {
  // Vercel cron sends `Authorization: Bearer $CRON_SECRET`.
  const secret = config.CRON_SECRET;
  if (!secret || c.req.header('authorization') !== `Bearer ${secret}`) return c.json({ ok: false }, 401);
  const ran = await drain(DRAIN);
  return c.json({ ok: true, ran });
});
