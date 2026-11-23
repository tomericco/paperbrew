import { createMiddleware } from 'hono/factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// agent.ts is tested without Better Auth or a database: the pool records its queries, and the
// device lookup in requireDevice answers from `deviceRow`.
const query = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();
const connect = vi.fn();

vi.mock('../src/config.js', () => ({
  config: { BETTER_AUTH_URL: 'http://localhost:5173' },
}));
vi.mock('../src/routes/library.js', () => ({
  requireUser: createMiddleware<{ Variables: { userId: string } }>(async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  }),
}));
vi.mock('../src/db/client.js', () => ({
  pool: { query, connect },
  isUniqueViolation: (err: unknown) => (err as { code?: string })?.code === '23505',
}));

const { agent } = await import('../src/print/agent.js');
const { sha256 } = await import('../src/print/secrets.js');

const DEVICE_ID = '11111111-2222-3333-4444-555555555555';
const ISSUE_ID = '99999999-8888-7777-6666-555555555555';
const AUTH = { authorization: 'Bearer device-token' };
const post = (path: string, body?: unknown, headers: Record<string, string> = AUTH) =>
  agent.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** The device lookup answers for a live token; every other pool query goes to `other`. */
function pool(other: (sql: string, params: unknown[]) => unknown = () => ({ rows: [], rowCount: 0 })) {
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/from print_devices/.test(sql)) return { rows: [{ id: DEVICE_ID, user_id: 'user-9' }], rowCount: 1 };
    if (/update print_devices set last_seen_at/.test(sql)) return { rows: [], rowCount: 1 };
    return other(sql, params);
  });
}
const claims = () => query.mock.calls.filter(([sql]) => /update issues/.test(String(sql)));

beforeEach(() => {
  pool();
  clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  connect.mockResolvedValue({ query: clientQuery, release });
});

afterEach(() => vi.resetAllMocks());

describe('a revoked or unknown token', () => {
  it.each([
    ['POST', '/agent/jobs/claim'],
    ['POST', `/agent/issues/${ISSUE_ID}/result`],
  ])('%s %s -> 401 and nothing is claimed or changed', async (_m, path) => {
    query.mockResolvedValue({ rows: [], rowCount: 0 }); // the token lookup finds no live device
    const res = await post(path, { ok: true });
    expect(res.status).toBe(401);
    expect(claims()).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
  });

  it('no token -> 401', async () => {
    const res = await post('/agent/jobs/claim', undefined, {});
    expect(res.status).toBe(401);
  });
});

describe('POST /agent/jobs/claim', () => {
  it('claims the oldest queued issue of the device\'s user atomically and returns { id, layout }', async () => {
    pool(() => ({ rows: [{ id: ISSUE_ID, layout: 'booklet' }], rowCount: 1 }));

    const res = await post('/agent/jobs/claim');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ISSUE_ID, layout: 'booklet' });
    expect(claims()).toHaveLength(1);
    const [sql, params] = claims()[0];
    const s = String(sql);
    expect(s).toMatch(/for update skip locked/);
    expect(s).toMatch(/status = 'queued'/);
    expect(s).toMatch(/order by created_at asc/);
    expect(s).toMatch(/limit 1/);
    expect(s).toMatch(/set status = 'printing', claimed_by = \$2, claimed_at = now\(\)/);
    expect(s).toMatch(/user_id = \$1/);
    expect(params).toEqual(['user-9', DEVICE_ID]);
  });

  it('answers 204 when nothing is queued', async () => {
    const res = await post('/agent/jobs/claim');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('concurrent claim: the second caller\'s update returns no row -> 204', async () => {
    let taken = false;
    pool(() => {
      const first = !taken;
      taken = true;
      return first ? { rows: [{ id: ISSUE_ID, layout: 'flat' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    });

    const [a, b] = await Promise.all([post('/agent/jobs/claim'), post('/agent/jobs/claim')]);

    expect([a.status, b.status].sort()).toEqual([200, 204]);
  });
});

describe('POST /agent/issues/:id/result', () => {
  const stateSql = /update issues/;
  const archiveSql = /update articles/;

  /** The conditional issue update finds the issue (`found`); the archive succeeds. */
  const withIssue = (found: boolean) =>
    clientQuery.mockImplementation(async (sql: string) => {
      if (stateSql.test(sql)) return found ? { rows: [{ article_ids: ['a1', 'a2'] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
  const sqls = () => clientQuery.mock.calls.map(([s]) => String(s).trim());

  it('ok: marks it printed and archives its unarchived articles in one transaction', async () => {
    withIssue(true);

    const res = await post(`/agent/issues/${ISSUE_ID}/result`, { ok: true });

    expect(res.status).toBe(204);
    const all = sqls();
    expect(all[0]).toBe('begin');
    expect(all.at(-1)).toBe('commit');
    const issue = clientQuery.mock.calls.find(([s]) => stateSql.test(String(s)))!;
    expect(String(issue[0])).toMatch(/set status = 'printed', printed_at = now\(\)/);
    expect(String(issue[0])).toMatch(/status = 'printing'/);
    expect(String(issue[0])).toMatch(/claimed_by = \$2/);
    expect(String(issue[0])).toMatch(/user_id = \$3/);
    expect(String(issue[0])).toMatch(/returning article_ids/);
    expect(issue[1]).toEqual([ISSUE_ID, DEVICE_ID, 'user-9']);
    const archive = clientQuery.mock.calls.find(([s]) => archiveSql.test(String(s)))!;
    expect(String(archive[0])).toMatch(/archived_at = now\(\), archive_reason = 'printed', rollover_count = 0/);
    expect(String(archive[0])).toMatch(/id = any\(\$1\)/);
    expect(String(archive[0])).toMatch(/user_id = \$2 and archived_at is null/);
    expect(archive[1]).toEqual([['a1', 'a2'], 'user-9']);
    expect(all.findIndex((s) => stateSql.test(s))).toBeLessThan(all.findIndex((s) => archiveSql.test(s)));
    expect(release).toHaveBeenCalledWith();
  });

  it('another device\'s issue, a wrong state or a second report is 404 and nothing is archived', async () => {
    withIssue(false);

    const res = await post(`/agent/issues/${ISSUE_ID}/result`, { ok: true });

    expect(res.status).toBe(404);
    const all = sqls();
    expect(all.some((s) => archiveSql.test(s))).toBe(false);
    expect(all).toContain('rollback');
    expect(all).not.toContain('commit');
    expect(release).toHaveBeenCalled();
  });

  it('not ok: marks it failed with the error cut to 500 chars and archives nothing', async () => {
    withIssue(true);

    const res = await post(`/agent/issues/${ISSUE_ID}/result`, { ok: false, error: 'x'.repeat(900) });

    expect(res.status).toBe(204);
    const issue = clientQuery.mock.calls.find(([s]) => stateSql.test(String(s)))!;
    expect(String(issue[0])).toMatch(/set status = 'failed', error = \$4/);
    expect(String(issue[0])).toMatch(/status = 'printing'/);
    expect(issue[1]).toEqual([ISSUE_ID, DEVICE_ID, 'user-9', 'x'.repeat(500)]);
    expect(sqls().some((s) => archiveSql.test(s))).toBe(false);
  });

  it('not ok without an error text stores a default message', async () => {
    withIssue(true);
    await post(`/agent/issues/${ISSUE_ID}/result`, { ok: false });
    const issue = clientQuery.mock.calls.find(([s]) => stateSql.test(String(s)))!;
    expect(typeof issue[1][3]).toBe('string');
    expect(issue[1][3].length).toBeGreaterThan(0);
  });

  it('not ok on an issue that is not this device\'s printing issue is 404', async () => {
    withIssue(false);
    const res = await post(`/agent/issues/${ISSUE_ID}/result`, { ok: false, error: 'jam' });
    expect(res.status).toBe(404);
  });

  it.each([
    ['not an object', 'nope'],
    ['ok missing', {}],
    ['ok not a boolean', { ok: 'yes' }],
    ['error not a string', { ok: false, error: 5 }],
  ])('bad body (%s) -> 400 without touching the issue', async (_l, body) => {
    const res = await post(`/agent/issues/${ISSUE_ID}/result`, body);
    expect(res.status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it('a non-uuid id is 404 without touching the database', async () => {
    const res = await post('/agent/issues/not-a-uuid/result', { ok: true });
    expect(res.status).toBe(404);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows when archiving fails', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (stateSql.test(sql)) return { rows: [{ article_ids: ['a1'] }], rowCount: 1 };
      if (archiveSql.test(sql)) throw new Error('boom');
      return { rows: [], rowCount: 0 };
    });
    const res = await post(`/agent/issues/${ISSUE_ID}/result`, { ok: true });
    expect(res.status).toBe(500);
    expect(sqls()).toContain('rollback');
    expect(sqls()).not.toContain('commit');
    expect(release).toHaveBeenCalledWith();
  });

  it('destroys a connection that could not roll back', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (stateSql.test(sql)) throw new Error('boom');
      if (sql === 'rollback') throw new Error('gone');
      return { rows: [], rowCount: 0 };
    });
    await post(`/agent/issues/${ISSUE_ID}/result`, { ok: true });
    expect(release).toHaveBeenCalledWith(true);
  });
});

describe('token handling', () => {
  it('looks the device up by the hash of the token', async () => {
    pool();
    await post('/agent/jobs/claim');
    const lookup = query.mock.calls.find(([s]) => /from print_devices/.test(String(s)))!;
    expect(lookup[1]).toEqual([sha256('device-token')]);
  });
});
