import { pool } from '../db/client.js';
import { isBrewDue } from './schedule.js';
import { planIssue, ROLLOVER_LIMIT, type Candidate } from './pick.js';

interface UserRow {
  brew_enabled: boolean;
  brew_days: number[];
  brew_hour: number;
  brew_timezone: string;
  brew_budget_minutes: number;
  paper_layout: 'flat' | 'booklet';
  last_brew_at: Date | null;
}

// Ready, unarchived articles that are not already in an open issue. Pending articles never qualify.
const CANDIDATES_SQL = `
  select a.id, a.reading_minutes, a.rollover_count
  from articles a
  where a.user_id = $1 and a.status = 'ready' and a.archived_at is null
    and not exists (
      select 1 from issues i
      where i.user_id = a.user_id and i.status in ('queued','printing') and a.id = any(i.article_ids)
    )
  order by a.created_at asc`;

/**
 * Queue an issue for the user if a brew slot is due and they have a paired Mac. One transaction; the row lock on the user makes
 * a double tick or a retry a no-op, because the first run moves last_brew_at past the slot.
 */
export async function createIssue(userId: string, now: Date = new Date()): Promise<{ issueId: string | null }> {
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query('begin');
    const { rows: users } = await client.query<UserRow>(
      `select brew_enabled, brew_days, brew_hour, brew_timezone, brew_budget_minutes, paper_layout, last_brew_at
       from users where id = $1 for update`,
      [userId],
    );
    const u = users[0];
    const schedule = u && { days: u.brew_days, hour: u.brew_hour, timezone: u.brew_timezone };
    if (!u || !u.brew_enabled || !schedule || !isBrewDue(schedule, u.last_brew_at, now)) {
      await client.query('commit');
      return { issueId: null };
    }

    // Nothing can print without a paired Mac. Leave articles and last_brew_at alone, so pairing within the
    // brew window still brews this slot on the next tick.
    const { rows: device } = await client.query<{ has_device: boolean }>(
      `select exists (
         select 1 from print_devices d where d.user_id = $1 and d.revoked_at is null
       ) as has_device`,
      [userId],
    );
    if (!device[0]?.has_device) {
      await client.query('commit');
      return { issueId: null };
    }

    const { rows } = await client.query<{ id: string; reading_minutes: number | null; rollover_count: number }>(
      CANDIDATES_SQL,
      [userId],
    );
    const candidates: Candidate[] = rows.map((r) => ({
      id: r.id,
      readingMinutes: r.reading_minutes,
      rolloverCount: r.rollover_count,
    }));
    const { picked, rolledOver, skipped } = planIssue(candidates, u.brew_budget_minutes);

    let issueId: string | null = null;
    if (picked.length > 0) {
      const ins = await client.query<{ id: string }>(
        'insert into issues (user_id, layout, article_ids) values ($1, $2, $3) returning id',
        [userId, u.paper_layout, picked],
      );
      issueId = ins.rows[0].id;
    }
    if (rolledOver.length > 0) {
      await client.query('update articles set rollover_count = rollover_count + 1 where id = any($1::uuid[]) and archived_at is null', [
        rolledOver,
      ]);
    }
    if (skipped.length > 0) {
      await client.query(
        `update articles set archived_at = now(), archive_reason = 'skipped', rollover_count = ${ROLLOVER_LIMIT}
         where id = any($1::uuid[]) and archived_at is null`,
        [skipped],
      );
    }
    await client.query('update users set last_brew_at = $1 where id = $2', [now, userId]);
    await client.query('commit');
    return { issueId };
  } catch (err) {
    // A failed rollback must not hide the original error; a connection that could not roll back is destroyed.
    rollbackFailed = !(await client.query('rollback').then(() => true, () => false));
    throw err;
  } finally {
    if (rollbackFailed) client.release(true);
    else client.release();
  }
}
