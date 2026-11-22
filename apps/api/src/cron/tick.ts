import type pg from 'pg';
import { pool } from '../db/client.js';

/**
 * The enqueue step of the hourly tick. Returns how many jobs each step queued so the route can report them;
 * later steps (brews, stale sweep) add a field here. It does not run jobs: the route drains afterwards.
 */
export async function tick(db: pg.Pool | pg.PoolClient = pool): Promise<{ gmail: number }> {
  // One gmail_sync per active connection, unless that user already has one waiting or running.
  const { rowCount } = await db.query(
    `insert into jobs (type, payload)
     select 'gmail_sync', jsonb_build_object('id', c.user_id)
     from gmail_connections c
     where c.status = 'active'
       and not exists (
         select 1 from jobs j
         where j.type = 'gmail_sync' and j.done_at is null and j.payload->>'id' = c.user_id::text
       )`,
  );
  return { gmail: rowCount ?? 0 };
}
