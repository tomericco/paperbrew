import { createMiddleware } from 'hono/factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// issues.ts is tested without Better Auth or a database: requireUser signs in a fixed user (when the
// x-test-user header is present), the pool answers the list, and the transaction client records its statements.
const query = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();
const connect = vi.fn();

vi.mock('../src/config.js', () => ({
  config: { BETTER_AUTH_URL: 'http://localhost:5173' },
}));
vi.mock('../src/routes/library.js', () => ({
  requireUser: createMiddleware<{ Variables: { userId: string } }>(async (c, next) => {
    if (c.req.header('x-test-user') !== 'yes') return c.json({ error: 'unauthorized' }, 401);
    c.set('userId', 'user-1');
    await next();
  }),
}));
vi.mock('../src/db/client.js', () => ({ pool: { query, connect } }));

const { issues } = await import('../src/print/issues.js');

const SIGNED_IN = { headers: { 'x-test-user': 'yes' } };
const ISSUE_ID = '99999999-8888-7777-6666-555555555555';
const reprint = (id: string, headers: Record<string, string> = SIGNED_IN.headers) =>
  issues.request(`/me/issues/${id}/reprint`, { method: 'POST', headers });

const A1 = 'a1111111-1111-1111-1111-111111111111';
const A2 = 'a2222222-2222-2222-2222-222222222222';
const A3 = 'a3333333-3333-3333-3333-333333333333';

/** What the transaction sees: the failed issue (or none) and which of its articles are still free. */
function tx(opts: { failed?: string[] | null; free?: string[] } = {}) {
  const failed = opts.failed === undefined ? [A1, A2, A3] : opts.failed;
  const free = opts.free ?? [A1, A3];
  clientQuery.mockImplementation(async (sql: string) => {
    if (/from issues/.test(sql) && /for update/.test(sql) && !/unnest/.test(sql))
      return failed ? { rows: [{ article_ids: failed }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/unnest/.test(sql)) return { rows: free.map((id) => ({ id })), rowCount: free.length };
    return { rows: [], rowCount: 1 };
  });
}
const sqls = () => clientQuery.mock.calls.map(([sql]) => String(sql));
const indexOf = (re: RegExp) => sqls().findIndex((s) => re.test(s));

beforeEach(() => {
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  connect.mockResolvedValue({ query: clientQuery, release });
  tx();
});
afterEach(() => vi.resetAllMocks());

describe('without a session', () => {
  it('GET /me/issues -> 401 and nothing is read', async () => {
    const res = await issues.request('/me/issues');
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('POST /me/issues/:id/reprint -> 401 and no transaction starts', async () => {
    const res = await reprint(ISSUE_ID, {});
    expect(res.status).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('GET /me/issues', () => {
  it('lists the last 10 issues, newest first, in the documented shape', async () => {
    const created = new Date('2026-11-22T08:00:00Z');
    query.mockResolvedValue({
      rows: [
        { id: 'i2', created_at: created, status: 'failed', article_count: 3, printed_at: null, error: 'out of paper' },
        { id: 'i1', created_at: created, status: 'printed', article_count: 5, printed_at: created, error: null },
      ],
      rowCount: 2,
    });
    const res = await issues.request('/me/issues', SIGNED_IN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issues: [
        { id: 'i2', createdAt: created.toISOString(), status: 'failed', articleCount: 3, printedAt: null, error: 'out of paper' },
        { id: 'i1', createdAt: created.toISOString(), status: 'printed', articleCount: 5, printedAt: created.toISOString(), error: null },
      ],
    });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('cardinality(article_ids)');
    expect(String(sql)).toMatch(/order by created_at desc/);
    expect(String(sql)).toMatch(/limit 10/);
    expect(params).toEqual(['user-1']);
  });
});

describe('POST /me/issues/:id/reprint', () => {
  it('requeues a failed issue without the articles that sit in another open issue', async () => {
    tx({ failed: [A1, A2, A3], free: [A1, A3] });
    const res = await reprint(ISSUE_ID);
    expect(res.status).toBe(204);

    const update = clientQuery.mock.calls.find(([sql]) => /update issues/.test(String(sql)))!;
    const sql = String(update[0]);
    expect(sql).toContain("status = 'queued'");
    expect(sql).toMatch(/claimed_by = null/);
    expect(sql).toMatch(/claimed_at = null/);
    expect(sql).toMatch(/error = null/);
    expect(sql).toMatch(/printed_at = null/);
    expect(update[1]).toEqual([ISSUE_ID, [A1, A3]]);

    expect(sqls()[0]).toBe('begin');
    expect(sqls().at(-1)).toBe('commit');
    expect(sqls()).not.toContain('rollback');
    expect(release).toHaveBeenCalledWith();
  });

  it('the availability read drops articles in another queued or printing issue and archived ones', async () => {
    await reprint(ISSUE_ID);
    const sql = sqls().find((s) => /unnest/.test(s))!;
    expect(sql).toContain('not exists');
    expect(sql).toContain("('queued','printing')");
    expect(sql).toContain('o.id <> $2');
    expect(sql).toContain('archived_at is null');
  });

  it('locks the user row before it reads the issue (the lock createIssue takes)', async () => {
    await reprint(ISSUE_ID);
    const lock = indexOf(/from users where id = \$1 for update/);
    const read = indexOf(/from issues/);
    expect(lock).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(lock);
    expect(clientQuery.mock.calls[lock][1]).toEqual(['user-1']);
  });

  it('only a failed issue of this user can be reprinted: anything else -> 404, nothing updated', async () => {
    tx({ failed: null });
    const res = await reprint(ISSUE_ID);
    expect(res.status).toBe(404);
    const read = clientQuery.mock.calls.find(([sql]) => /from issues/.test(String(sql)))!;
    expect(String(read[0])).toContain("status = 'failed'");
    expect(String(read[0])).toContain('user_id = $2');
    expect(read[1]).toEqual([ISSUE_ID, 'user-1']);
    expect(sqls().some((s) => /update issues/.test(s))).toBe(false);
    expect(sqls()).toContain('rollback');
    expect(sqls()).not.toContain('commit');
    expect(release).toHaveBeenCalledWith();
  });

  it('a printed issue (not failed) -> 404', async () => {
    tx({ failed: null }); // the status = failed filter finds no row for a printed issue
    expect((await reprint(ISSUE_ID)).status).toBe(404);
  });

  it('a non-uuid id -> 404 without touching the database', async () => {
    const res = await reprint('not-a-uuid');
    expect(res.status).toBe(404);
    expect(connect).not.toHaveBeenCalled();
  });

  it('every article already in another open issue or archived -> 409, rolled back, nothing updated', async () => {
    tx({ failed: [A1, A2], free: [] });
    const res = await reprint(ISSUE_ID);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'nothing left to print' });
    expect(sqls().some((s) => /update issues/.test(s))).toBe(false);
    expect(sqls()).toContain('rollback');
    expect(sqls()).not.toContain('commit');
  });

  it('a failing statement rolls back and destroys the connection if the rollback fails too', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (/rollback/.test(sql)) throw new Error('connection gone');
      if (/for update/.test(sql)) throw new Error('boom');
      return { rows: [], rowCount: 0 };
    });
    const res = await reprint(ISSUE_ID);
    expect(res.status).toBe(500);
    expect(release).toHaveBeenCalledWith(true);
  });
});
