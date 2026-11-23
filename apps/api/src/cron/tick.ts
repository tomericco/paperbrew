import type pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { enqueue } from '../jobs/queue.js';
import { isBrewDue } from '../schedule/schedule.js';

/**
 * The enqueue step of the hourly tick. Returns how many jobs each step queued so the route can report them;
 * later steps (stale sweep) add a field here. It does not run jobs: the route drains afterwards.
 */
export async function tick(
  db: pg.Pool | pg.PoolClient = pool,
  now: Date = new Date(),
): Promise<{ gmail: number; brews: number }> {
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

  // Scheduled issues stay off until the print agent exists (AUTOBREW_ENABLED), so nothing piles up queued.
  if (!config.AUTOBREW_ENABLED) return { gmail: rowCount ?? 0, brews: 0 };

  // One create_issue per enabled user whose slot is open, unless one is already waiting or running.
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
  return { gmail: rowCount ?? 0, brews };
}
