import { waitUntil } from '@vercel/functions';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db/client.js';
import { enqueue } from './jobs/queue.js';
import { drain } from './jobs/runner.js';
import { normalizePostmark } from './inbound/postmark.js';
import { addressTokens } from './inbound/recipients.js';

export const app = new Hono();

// Stays well inside Vercel Hobby's 300 s function limit.
const DRAIN = { budgetMs: 50_000, concurrency: 4 };

app.get('/health', async (c) => {
  await pool.query('select 1');
  return c.json({ ok: true });
});

app.post(
  '/webhooks/postmark/inbound',
  basicAuth({ username: config.POSTMARK_WEBHOOK_USER, password: config.POSTMARK_WEBHOOK_PASSWORD }),
  async (c) => {
    let email;
    try {
      email = normalizePostmark(await c.req.json());
    } catch (err) {
      // Malformed payloads won't fix themselves on retry: acknowledge and log.
      console.warn('[inbound] rejected payload', err instanceof ZodError ? err.issues : err);
      return c.json({ ok: true, ignored: 'malformed' });
    }

    const tokens = addressTokens(email.recipients, config.INBOUND_DOMAIN);
    if (!tokens.length) return c.json({ ok: true, ignored: 'no_paperbrew_recipient' });

    const { rows: users } = await pool.query<{ user_id: string; account_email: string }>(
      `select a.user_id, u.email as account_email
       from inbound_addresses a join users u on u.id = a.user_id
       where a.token = any($1) and a.disabled_at is null
       limit 1`,
      [tokens],
    );
    const user = users[0];
    if (!user) return c.json({ ok: true, ignored: 'unknown_address' });

    if (config.REQUIRE_KNOWN_SENDER && email.from !== user.account_email.toLowerCase()) {
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
      throw err; // 500 -> Postmark retries
    } finally {
      client.release();
    }
  },
);

app.get('/cron/run-jobs', async (c) => {
  // Vercel cron sends `Authorization: Bearer $CRON_SECRET`.
  const secret = config.CRON_SECRET;
  if (!secret || c.req.header('authorization') !== `Bearer ${secret}`) return c.json({ ok: false }, 401);
  const ran = await drain(DRAIN);
  return c.json({ ok: true, ran });
});
