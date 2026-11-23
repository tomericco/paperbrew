import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable so each test can set or clear CRON_SECRET.
const cfg = vi.hoisted(() => ({
  DATABASE_URL: 'postgres://localhost:5432/test',
  INBOUND_ADDRESS: '{token}@save.example.com',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234',
  BETTER_AUTH_URL: 'http://localhost:5173',
  INBOUND_WEBHOOK_USER: 'user',
  INBOUND_WEBHOOK_PASSWORD: 'password-password-1',
  REQUIRE_KNOWN_SENDER: false,
  FETCH_TIMEOUT_MS: 1000,
  FETCH_MAX_BYTES: 1000,
  PORT: 8787,
  CRON_SECRET: 'cron-secret-cron-secret' as string | undefined,
}));
vi.mock('../src/config.js', () => ({ config: cfg }));
// No job may actually run.
vi.mock('../src/jobs/runner.js', () => ({ drain: vi.fn() }));

const { app } = await import('../src/app.js');
const { pool } = await import('../src/db/client.js');
const { drain } = await import('../src/jobs/runner.js');
const { tick } = await import('../src/cron/tick.js');

const BEARER = { authorization: 'Bearer cron-secret-cron-secret' };

beforeEach(() => {
  cfg.CRON_SECRET = 'cron-secret-cron-secret';
  vi.mocked(drain).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('GET /cron/tick', () => {
  it('without the bearer -> 401, nothing runs', async () => {
    const query = vi.spyOn(pool, 'query');
    const res = await app.request('/cron/tick');
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it('with the wrong bearer -> 401', async () => {
    const query = vi.spyOn(pool, 'query');
    const res = await app.request('/cron/tick', { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it('answers 401 for any bearer when CRON_SECRET is not configured', async () => {
    cfg.CRON_SECRET = undefined;
    const query = vi.spyOn(pool, 'query');
    const res = await app.request('/cron/tick', { headers: { authorization: 'Bearer undefined' } });
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });

  it('queues gmail_sync and create_issue jobs, then drains, and reports the counts', async () => {
    const order: string[] = [];
    const query = vi.spyOn(pool, 'query').mockImplementation((async () => {
      order.push('enqueue');
      return { rowCount: 3, rows: [] };
    }) as never);
    vi.mocked(drain).mockImplementation(async () => {
      order.push('drain');
      return 5;
    });

    const res = await app.request('/cron/tick', { headers: BEARER });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, gmail: 3, brews: 0, ran: 5 });
    expect(query).toHaveBeenCalledTimes(2);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/insert into jobs/);
    expect(sql).toContain('gmail_connections');
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('not exists');
    expect(drain).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['enqueue', 'enqueue', 'drain']);
  });
});

describe('tick()', () => {
  // Monday 2026-11-23 08:30 UTC; the 07:00 UTC Monday slot is open.
  const NOW = new Date('2026-11-23T08:30:00Z');
  const due = (id: string, over: Record<string, unknown> = {}) => ({
    id, brew_days: [1], brew_hour: 7, brew_timezone: 'UTC', last_brew_at: null, ...over,
  });

  function fakeDb(users: Record<string, unknown>[] = [], gmailCount: number | null = 2) {
    const query = vi.fn(async (sql: string) => {
      if (/from users/.test(sql)) return { rows: users, rowCount: users.length };
      if (/insert into jobs/.test(sql) && sql.includes('gmail_sync')) return { rowCount: gmailCount, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    return { query };
  }
  const brewInserts = (db: { query: ReturnType<typeof vi.fn> }) =>
    db.query.mock.calls.filter((c) => /insert into jobs/.test(String(c[0])) && (c[1] as unknown[] | undefined)?.[0] === 'create_issue');

  it('returns the number of gmail rows inserted and the brews queued', async () => {
    const db = fakeDb([due('u1'), due('u2')]);
    expect(await tick(db as never, NOW)).toEqual({ gmail: 2, brews: 2 });
  });

  it('reports 0 gmail when the driver gives no rowCount', async () => {
    const db = fakeDb([], null);
    expect(await tick(db as never, NOW)).toEqual({ gmail: 0, brews: 0 });
  });

  it('loads enabled users without an undone create_issue job and queues only the due ones', async () => {
    const db = fakeDb([
      due('u-due'),
      due('u-wrong-day', { brew_days: [2] }),
      due('u-done', { last_brew_at: new Date('2026-11-23T07:10:00Z') }),
      due('u-stale', { brew_days: [1], brew_hour: 1 }),
    ]);
    expect(await tick(db as never, NOW)).toEqual({ gmail: 2, brews: 1 });

    const select = db.query.mock.calls.map((c) => String(c[0])).find((s) => /from users/.test(s))!;
    expect(select).toContain('brew_enabled');
    expect(select).toContain('create_issue');
    expect(select).toContain('done_at is null');
    expect(select).toContain('not exists');
    const ins = brewInserts(db);
    expect(ins).toHaveLength(1);
    expect(ins[0][1]).toEqual(['create_issue', { id: 'u-due' }]);
  });
});
