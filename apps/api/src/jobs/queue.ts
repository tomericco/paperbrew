import type pg from 'pg';

export type JobType = 'process_email' | 'fetch_article';
export interface Job {
  id: number;
  type: JobType;
  payload: { id: string };
  attempts: number;
  max_attempts: number;
}

type Db = pg.Pool | pg.PoolClient;

export async function enqueue(db: Db, type: JobType, payload: { id: string }): Promise<void> {
  await db.query('insert into jobs (type, payload) values ($1, $2)', [type, payload]);
}

/** Claim one due job. Locks older than 10 minutes are treated as crashed workers and reclaimed. */
export async function claim(db: pg.Pool): Promise<Job | null> {
  const { rows } = await db.query<Job>(
    `update jobs set locked_at = now(), attempts = attempts + 1
     where id = (
       select id from jobs
       where done_at is null and run_at <= now()
         and (locked_at is null or locked_at < now() - interval '10 minutes')
       order by run_at
       for update skip locked
       limit 1
     )
     returning id, type, payload, attempts, max_attempts`,
  );
  return rows[0] ?? null;
}

export async function complete(db: pg.Pool, id: number): Promise<void> {
  await db.query('update jobs set done_at = now(), locked_at = null where id = $1', [id]);
}

/** Retry with exponential backoff (1, 2, 4, 8… minutes) or give up. Returns true if it will retry. */
export async function fail(db: pg.Pool, job: Job, error: string, retryable: boolean): Promise<boolean> {
  const retry = retryable && job.attempts < job.max_attempts;
  await db.query(
    `update jobs set locked_at = null, last_error = $2,
       run_at = case when $3 then now() + make_interval(mins => power(2, attempts - 1)::int) else run_at end,
       done_at = case when $3 then null else now() end
     where id = $1`,
    [job.id, error.slice(0, 2000), retry],
  );
  return retry;
}
