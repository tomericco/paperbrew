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

  it('queues gmail_sync jobs in one statement, then drains, and reports both counts', async () => {
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
    expect(await res.json()).toEqual({ ok: true, gmail: 3, ran: 5 });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/insert into jobs/);
    expect(sql).toContain('gmail_connections');
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('not exists');
    expect(drain).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['enqueue', 'drain']);
  });
});

describe('tick()', () => {
  it('returns the number of rows the enqueue statement inserted', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 2, rows: [] }) };
    expect(await tick(db as never)).toEqual({ gmail: 2 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('reports 0 when the driver gives no rowCount', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rowCount: null, rows: [] }) };
    expect(await tick(db as never)).toEqual({ gmail: 0 });
  });
});
