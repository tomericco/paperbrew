import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { auth } from '../auth/auth.js';
import { provisionUser } from '../auth/provision.js';
import { PAPER_LAYOUTS, type PaperLayout } from '../brew/layout.js';
import { config } from '../config.js';
import { isUniqueViolation, pool } from '../db/client.js';
import { formatAddress, normalizeToken } from '../inbound/address.js';

/** Hono env for routes behind `requireUser`: `c.get('userId')` is our `users.id`. */
export type UserEnv = { Variables: { userId: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findUserId(authUserId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string }>('select id from users where auth_user_id = $1', [authUserId]);
  return rows[0]?.id;
}

/**
 * Requires a Better Auth session and resolves it to our `users.id`.
 * If the session is valid but the signup hook never created our row, it is provisioned here.
 */
export const requireUser = createMiddleware<UserEnv>(async (c, next) => {
  // Sessions travel only in a cookie; skip Better Auth (which touches the database even for anonymous requests).
  if (!c.req.header('cookie')) return c.json({ error: 'unauthorized' }, 401);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  let userId = await findUserId(session.user.id);
  if (!userId) {
    await provisionUser({ id: session.user.id, email: session.user.email });
    userId = await findUserId(session.user.id);
  }
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  c.set('userId', userId);
  await next();
});

export const library = new Hono<UserEnv>();
// In Hono, '/me/*' also matches '/me' (and '/articles/*' matches '/articles'), so each guard runs once.
library.use('/me/*', requireUser);
library.use('/articles/*', requireUser);

const addressOf = (token: string) => ({ address: formatAddress(config.INBOUND_ADDRESS, token), token });

library.get('/me', async (c) => {
  const userId = c.get('userId');
  const { rows } = await pool.query<{ token: string; email: string | null; paper_layout: PaperLayout }>(
    `select a.token, u.email, u.paper_layout
     from users u join inbound_addresses a on a.user_id = u.id and a.disabled_at is null
     where u.id = $1
     order by a.created_at desc
     limit 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return c.json({ error: 'no active address' }, 500);
  return c.json({ ...addressOf(row.token), email: row.email, paperLayout: row.paper_layout });
});

const AddressBody = z.object({ token: z.string() });

library.put('/me/address', async (c) => {
  const userId = c.get('userId');
  const body = AddressBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'token is required' }, 400);
  const result = normalizeToken(body.data.token);
  if (!result.ok) return c.json({ error: result.error }, 400);
  const { token } = result;

  const client = await pool.connect();
  try {
    await client.query('begin');
    // Serialize address changes per user so two requests cannot both leave an active row.
    await client.query('select 1 from users where id = $1 for update', [userId]);

    const active = await client.query<{ token: string }>(
      'select token from inbound_addresses where user_id = $1 and disabled_at is null',
      [userId],
    );
    if (active.rows.some((r) => r.token === token)) {
      await client.query('commit');
      return c.json(addressOf(token));
    }

    // One of this user's own released addresses can be taken back.
    const revived = await client.query(
      'update inbound_addresses set disabled_at = null where user_id = $1 and token = $2 and disabled_at is not null',
      [userId, token],
    );
    if (!revived.rowCount) {
      // Tokens are unique across all users, disabled rows included, so a released address is never reassigned.
      await client.query('insert into inbound_addresses (user_id, token) values ($1, $2)', [userId, token]);
    }
    await client.query(
      'update inbound_addresses set disabled_at = now() where user_id = $1 and disabled_at is null and token <> $2',
      [userId, token],
    );
    await client.query('commit');
    return c.json(addressOf(token));
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if (isUniqueViolation(err)) return c.json({ error: 'That address is taken.' }, 409);
    throw err;
  } finally {
    client.release();
  }
});

const SettingsBody = z.object({ paperLayout: z.enum(PAPER_LAYOUTS) });

library.put('/me/settings', async (c) => {
  const body = SettingsBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'paperLayout must be flat or booklet' }, 400);
  await pool.query('update users set paper_layout = $1 where id = $2', [body.data.paperLayout, c.get('userId')]);
  return c.json({ paperLayout: body.data.paperLayout });
});

library.get('/articles', async (c) => {
  const { rows } = await pool.query<{
    id: string;
    title: string | null;
    site_name: string | null;
    source_url: string | null;
    status: string;
    word_count: number | null;
    created_at: Date;
  }>(
    `select id, title, site_name, source_url, status, word_count, created_at
     from articles
     where user_id = $1
     order by created_at desc
     limit 200`,
    [c.get('userId')],
  );
  return c.json({
    articles: rows.map((r) => ({
      id: r.id,
      title: r.title,
      siteName: r.site_name,
      sourceUrl: r.source_url,
      status: r.status,
      wordCount: r.word_count,
      createdAt: r.created_at,
    })),
  });
});

library.delete('/articles/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const { rowCount } = await pool.query('delete from articles where id = $1 and user_id = $2', [id, c.get('userId')]);
  if (!rowCount) return c.json({ error: 'not found' }, 404);
  return c.body(null, 204);
});
