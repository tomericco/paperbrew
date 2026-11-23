import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { requireDevice, type DeviceEnv } from './devices.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_MAX = 500;

// `requireDevice` is applied per route, never as `use('/agent/*')`: POST /agent/pair is unauthenticated.
export const agent = new Hono<DeviceEnv>();

// The Mac asks for work. One statement picks the oldest queued issue of the device's user and marks it
// printing; `skip locked` makes two concurrent claims take different rows (or none), never the same.
agent.post('/agent/jobs/claim', requireDevice, async (c) => {
  const { rows } = await pool.query<{ id: string; layout: 'flat' | 'booklet' }>(
    `update issues set status = 'printing', claimed_by = $2, claimed_at = now()
     where status = 'queued' and id = (
       select id from issues
       where user_id = $1 and status = 'queued'
       order by created_at asc
       limit 1
       for update skip locked
     )
     returning id, layout`,
    [c.get('userId'), c.get('deviceId')],
  );
  const issue = rows[0];
  if (!issue) return c.body(null, 204);
  return c.json({ id: issue.id, layout: issue.layout });
});

const ResultBody = z.object({ ok: z.boolean(), error: z.string().optional() });

// The Mac reports how printing went. The state change is conditional on the issue still being this
// device's printing issue, so a double report or another device's id is a 404 and changes nothing.
agent.post('/agent/issues/:id/result', requireDevice, async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const body = ResultBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'ok (boolean) is required' }, 400);

  const deviceId = c.get('deviceId');
  const userId = c.get('userId');
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query('begin');
    const update = body.data.ok
      ? await client.query<{ article_ids: string[] }>(
          `update issues set status = 'printed', printed_at = now()
           where id = $1 and status = 'printing' and claimed_by = $2 and user_id = $3
           returning article_ids`,
          [id, deviceId, userId],
        )
      : await client.query<{ article_ids: string[] }>(
          `update issues set status = 'failed', error = $4
           where id = $1 and status = 'printing' and claimed_by = $2 and user_id = $3
           returning article_ids`,
          [id, deviceId, userId, (body.data.error?.trim() || 'The printer reported a failure').slice(0, ERROR_MAX)],
        );
    const issue = update.rows[0];
    if (!issue) {
      await client.query('rollback');
      return c.json({ error: 'not found' }, 404);
    }
    if (body.data.ok) {
      await client.query(
        `update articles set archived_at = now(), archive_reason = 'printed', rollover_count = 0
         where id = any($1) and user_id = $2 and archived_at is null`,
        [issue.article_ids, userId],
      );
    }
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
