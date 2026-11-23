import { Hono } from 'hono';
import { pool } from '../db/client.js';
import { requireUser, type UserEnv } from '../routes/library.js';
import { UUID_RE } from '../uuid.js';

export const issues = new Hono<UserEnv>();
issues.use('/me/issues', requireUser);
issues.use('/me/issues/*', requireUser);

// The user's recent issues for the print history, newest first.
issues.get('/me/issues', async (c) => {
  const { rows } = await pool.query<{
    id: string;
    created_at: Date;
    status: string;
    article_count: number;
    printed_at: Date | null;
    error: string | null;
  }>(
    `select id, created_at, status, cardinality(article_ids) as article_count, printed_at, error
     from issues
     where user_id = $1
     order by created_at desc
     limit 10`,
    [c.get('userId')],
  );
  return c.json({
    issues: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      status: r.status,
      articleCount: r.article_count,
      printedAt: r.printed_at,
      error: r.error,
    })),
  });
});

// The articles of a failed issue that can still be printed: not archived since, and not already in
// another queued or printing issue of the same user. `with ordinality` keeps the issue's article order.
const AVAILABLE_SQL = `
  select a.id
  from unnest($3::uuid[]) with ordinality as t(id, n)
  join articles a on a.id = t.id
  where a.user_id = $1 and a.archived_at is null
    and not exists (
      select 1 from issues o
      where o.user_id = $1 and o.id <> $2 and o.status in ('queued','printing') and a.id = any(o.article_ids)
    )
  order by t.n`;

// Print again: put a failed issue back in the queue. One transaction that first takes the same user-row
// lock createIssue takes, so a reprint and a scheduled brew can't both claim the same articles.
issues.post('/me/issues/:id/reprint', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const userId = c.get('userId');

  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query('begin');
    await client.query('select id from users where id = $1 for update', [userId]);
    const { rows } = await client.query<{ article_ids: string[] }>(
      `select article_ids from issues where id = $1 and user_id = $2 and status = 'failed' for update`,
      [id, userId],
    );
    if (rows.length === 0) {
      await client.query('rollback');
      return c.json({ error: 'not found' }, 404);
    }
    const available = await client.query<{ id: string }>(AVAILABLE_SQL, [userId, id, rows[0].article_ids]);
    if (available.rows.length === 0) {
      await client.query('rollback');
      return c.json({ error: 'nothing left to print' }, 409);
    }
    await client.query(
      `update issues
       set status = 'queued', article_ids = $2, claimed_by = null, claimed_at = null, error = null, printed_at = null
       where id = $1`,
      [id, available.rows.map((r) => r.id)],
    );
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
