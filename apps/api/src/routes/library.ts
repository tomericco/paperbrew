import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { auth } from '../auth/auth.js';
import { provisionUser } from '../auth/provision.js';
import { PAPER_LAYOUTS, type PaperLayout } from '../brew/layout.js';
import { config } from '../config.js';
import { isUniqueViolation, pool } from '../db/client.js';
import { gmailAvailable } from '../gmail/available.js';
import { senderEmail } from '../gmail/rules.js';
import { formatAddress, normalizeToken } from '../inbound/address.js';
import { isBrewDue, nextBrewAt } from '../schedule/schedule.js';

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
  return c.json({
    ...addressOf(row.token),
    email: row.email,
    paperLayout: row.paper_layout,
    gmailAvailable: gmailAvailable(process.env),
    scheduleAvailable: config.AUTOBREW_ENABLED,
  });
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

const validTimezone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
};

const BUDGET_MINUTES = [30, 45, 60, 90];

const SettingsBody = z
  .object({
    paperLayout: z.enum(PAPER_LAYOUTS),
    brewEnabled: z.boolean(),
    brewDays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((days) => new Set(days).size === days.length),
    brewHour: z.number().int().min(0).max(23),
    brewTimezone: z.string().refine(validTimezone),
    brewBudgetMinutes: z.number().refine((n) => BUDGET_MINUTES.includes(n)),
  })
  .partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined));

const SETTINGS_ERROR =
  'Send at least one of paperLayout (flat or booklet), brewEnabled, brewDays (0-6), brewHour (0-23), brewTimezone (IANA) or brewBudgetMinutes (30, 45, 60 or 90)';

type SettingsRow = {
  paper_layout: PaperLayout;
  brew_enabled: boolean;
  brew_days: number[];
  brew_hour: number;
  brew_timezone: string;
  brew_budget_minutes: number;
};

library.put('/me/settings', async (c) => {
  const body = SettingsBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: SETTINGS_ERROR }, 400);
  const b = body.data;

  // Only the provided keys are set; every value goes in as a parameter.
  const columns: Array<[string, unknown]> = [];
  if (b.paperLayout !== undefined) columns.push(['paper_layout', b.paperLayout]);
  if (b.brewEnabled !== undefined) columns.push(['brew_enabled', b.brewEnabled]);
  if (b.brewDays !== undefined) columns.push(['brew_days', [...b.brewDays].sort((x, y) => x - y)]);
  if (b.brewHour !== undefined) columns.push(['brew_hour', b.brewHour]);
  if (b.brewTimezone !== undefined) columns.push(['brew_timezone', b.brewTimezone]);
  if (b.brewBudgetMinutes !== undefined) columns.push(['brew_budget_minutes', b.brewBudgetMinutes]);

  const sets = columns.map(([column], i) => `${column} = $${i + 1}`).join(', ');
  const { rows } = await pool.query<SettingsRow>(
    `update users set ${sets} where id = $${columns.length + 1} returning paper_layout, brew_enabled, brew_days, brew_hour, brew_timezone, brew_budget_minutes`,
    [...columns.map(([, value]) => value), c.get('userId')],
  );
  const row = rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({
    paperLayout: row.paper_layout,
    brewEnabled: row.brew_enabled,
    brewDays: row.brew_days,
    brewHour: row.brew_hour,
    brewTimezone: row.brew_timezone,
    brewBudgetMinutes: row.brew_budget_minutes,
  });
});

library.get('/me/schedule', async (c) => {
  const { rows } = await pool.query<Omit<SettingsRow, 'paper_layout'> & { last_brew_at: Date | null }>(
    'select brew_enabled, brew_days, brew_hour, brew_timezone, brew_budget_minutes, last_brew_at from users where id = $1',
    [c.get('userId')],
  );
  const row = rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  const schedule = { days: row.brew_days, hour: row.brew_hour, timezone: row.brew_timezone };
  const now = new Date();
  const next = row.brew_enabled ? nextBrewAt(schedule, now) : null;
  // An open slot the next tick will brew for, so the page does not say "next week" while one is about to fire.
  const brewDue = row.brew_enabled && isBrewDue(schedule, row.last_brew_at ?? null, now);
  return c.json({
    enabled: row.brew_enabled,
    days: row.brew_days,
    hour: row.brew_hour,
    timezone: row.brew_timezone,
    budgetMinutes: row.brew_budget_minutes,
    nextBrewAt: next ? next.toISOString() : null,
    brewDue,
  });
});

type ArticleRow = {
  id: string;
  title: string | null;
  site_name: string | null;
  source_url: string | null;
  status: string;
  word_count: number | null;
  added_via: string;
  created_at: Date;
  archived_at?: Date;
  archive_reason?: 'printed' | 'skipped' | null;
};

const toArticle = (r: ArticleRow) => ({
  id: r.id,
  title: r.title,
  siteName: r.site_name,
  sourceUrl: r.source_url,
  status: r.status,
  wordCount: r.word_count,
  addedVia: r.added_via,
  createdAt: r.created_at,
});

library.get('/articles', async (c) => {
  const userId = c.get('userId');
  if (c.req.query('archived') === '1') {
    const { rows } = await pool.query<ArticleRow & { archived_at: Date }>(
      `select id, title, site_name, source_url, status, word_count, added_via, created_at, archived_at, archive_reason
       from articles
       where user_id = $1 and archived_at is not null
       order by archived_at desc, created_at asc
       limit 500`,
      [userId],
    );
    return c.json({ articles: rows.map((r) => ({ ...toArticle(r), archivedAt: r.archived_at, archiveReason: r.archive_reason ?? null })) });
  }
  const { rows } = await pool.query<ArticleRow>(
    `select id, title, site_name, source_url, status, word_count, added_via, created_at
     from articles
     where user_id = $1 and archived_at is null
     order by created_at desc
     limit 200`,
    [userId],
  );
  return c.json({ articles: rows.map(toArticle) });
});

const ArchiveBody = z.object({ ids: z.array(z.string().regex(UUID_RE)).min(1).max(50) });

library.post('/articles/archive', async (c) => {
  const body = ArchiveBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'ids must be 1 to 50 article ids' }, 400);
  const ids = [...new Set(body.data.ids)];
  const { rows, rowCount } = await pool.query<{ archived_at: Date }>(
    `update articles set archived_at = now()
     where user_id = $1 and id = any($2::uuid[]) and archived_at is null
     returning archived_at`,
    [c.get('userId'), ids],
  );
  const archivedAt = rows[0]?.archived_at ?? new Date();
  return c.json({ archived: rowCount ?? 0, archivedAt });
});

library.post('/articles/:id/unarchive', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const { rowCount } = await pool.query(
    'update articles set archived_at = null, rollover_count = 0, archive_reason = null where id = $1 and user_id = $2 and archived_at is not null',
    [id, c.get('userId')],
  );
  if (!rowCount) return c.json({ error: 'not found' }, 404);
  return c.body(null, 204);
});

library.delete('/articles/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const userId = c.get('userId');

  // "Also skip future emails from this sender": only for a Gmail article, and only when asked.
  if (c.req.query('blockSender') === '1') {
    const { rows } = await pool.query<{ from_email: string | null }>(
      `select m.from_email
       from articles a
       join gmail_messages m on m.user_id = a.user_id and m.gmail_message_id = a.gmail_message_id
       where a.id = $1 and a.user_id = $2 and a.added_via = 'gmail'`,
      [id, userId],
    );
    const from = rows[0]?.from_email;
    const email = from ? senderEmail(from) : '';
    if (email) {
      await pool.query(
        'insert into gmail_blocked_senders (user_id, email) values ($1, $2) on conflict do nothing',
        [userId, email],
      );
    }
  }

  const { rowCount } = await pool.query('delete from articles where id = $1 and user_id = $2', [id, userId]);
  if (!rowCount) return c.json({ error: 'not found' }, 404);
  return c.body(null, 204);
});
