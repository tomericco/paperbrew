import type pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { enqueue } from '../jobs/queue.js';
import { isBrewDue } from '../schedule/schedule.js';

/**
 * The enqueue step of the hourly tick. Returns how many jobs each step queued so the route can report them;
 * `stale` counts printing issues the Mac never reported on. It does not run jobs: the route drains afterwards.
 */
export async function tick(
  db: pg.Pool | pg.PoolClient = pool,
  now: Date = new Date(),
): Promise<{ gmail: number; brews: number; stale: number }> {
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

  // An issue the Mac claimed but never reported on (asleep, offline, crashed) is failed so it can be printed again.
  // This runs before the AUTOBREW_ENABLED gate: it must work with scheduling off.
  const sweep = await db.query(
    `update issues set status = 'failed', error = 'timed out'
     where status = 'printing' and claimed_at < now() - interval '30 minutes'`,
  );
  const stale = sweep.rowCount ?? 0;

  // Scheduled issues stay off until the print agent exists (AUTOBREW_ENABLED), so nothing piles up queued.
  if (!config.AUTOBREW_ENABLED) return { gmail: rowCount ?? 0, brews: 0, stale };

  // One create_issue per enabled user with a paired Mac whose slot is open, unless one is already waiting or running.
  // Whether the slot is open is decided here in JS; createIssue re-checks it under a row lock.
  const { rows: users } = await db.query<{
    id: string;
    brew_days: number[];
    brew_hour: number;
    brew_timezone: string;
    last_brew_at: Date | null;
  }>(
    `select u.id, u.brew_days, u.brew_hour, u.brew_timezone, u.last_brew_at
     from users u
     where u.brew_enabled
       and exists (
         select 1 from print_devices d where d.user_id = u.id and d.revoked_at is null
       )
       and not exists (
         select 1 from jobs j
         where j.type = 'create_issue' and j.done_at is null and j.payload->>'id' = u.id::text
       )`,
  );
  let brews = 0;
  for (const u of users) {
    const due = isBrewDue({ days: u.brew_days, hour: u.brew_hour, timezone: u.brew_timezone }, u.last_brew_at, now);
    if (!due) continue;
    await enqueue(db, 'create_issue', { id: u.id });
    brews++;
  }
  return { gmail: rowCount ?? 0, brews, stale };
}
