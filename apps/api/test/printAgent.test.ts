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
const renderIssuePdf = vi.fn();
vi.mock('../src/brew/issuePdf.js', () => ({ renderIssuePdf }));
vi.mock('../src/db/client.js', () => ({
  pool: { query, connect },
  isUniqueViolation: (err: unknown) => (err as { code?: string })?.code === '23505',
}));

const { agent } = await import('../src/print/agent.js');
const { sha256 } = await import('../src/print/secrets.js');
const { BusyError } = await import('../src/brew/lifecycle.js');

const DEVICE_ID = '11111111-2222-3333-4444-555555555555';
const ISSUE_ID = '99999999-8888-7777-6666-555555555555';
const AUTH = { authorization: 'Bearer device-token' };
const post = (path: string, body?: unknown, headers: Record<string, string> = AUTH) =>
  agent.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const get = (path: string, headers: Record<string, string> = AUTH) => agent.request(path, { headers });

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
    ['GET', `/agent/issues/${ISSUE_ID}/pdf`],
  ])('%s %s -> 401 and nothing is claimed or changed', async (_m, path) => {
    query.mockResolvedValue({ rows: [], rowCount: 0 }); // the token lookup finds no live device
    const res = _m === 'GET' ? await get(path) : await post(path, { ok: true });
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
    expect(String(issue[0])).toMatch(/set status = 'printed', printed_at = now\(\), error = null/);
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

  it('ok also accepts an issue the stale sweep failed as \'timed out\' (late report): same conditional update, same archive', async () => {
    withIssue(true);

    const res = await post(`/agent/issues/${ISSUE_ID}/result`, { ok: true });

    expect(res.status).toBe(204);
    const issue = clientQuery.mock.calls.find(([s]) => stateSql.test(String(s)))!;
    const s = String(issue[0]).replace(/\s+/g, ' ');
    expect(s).toMatch(/where id = \$1 and claimed_by = \$2 and user_id = \$3 and \(status = 'printing' or \(status = 'failed' and error = 'timed out'\)\)/);
    expect(s).toMatch(/error = null/);
    expect(issue[1]).toEqual([ISSUE_ID, DEVICE_ID, 'user-9']);
    const archive = clientQuery.mock.calls.find(([s2]) => archiveSql.test(String(s2)))!;
    expect(String(archive[0])).toMatch(/archive_reason = 'printed', rollover_count = 0/);
    expect(String(archive[0])).toMatch(/archived_at is null/);
    expect(archive[1]).toEqual([['a1', 'a2'], 'user-9']);
    expect(sqls().at(-1)).toBe('commit');
  });

  it('ok on a failed issue that did not time out (or any other non-matching issue) is 404 and archives nothing', async () => {
    withIssue(false); // the conditional update matches no row: e.g. failed with the printer's own error
    const res = await post(`/agent/issues/${ISSUE_ID}/result`, { ok: true });
    expect(res.status).toBe(404);
    expect(sqls().some((s) => archiveSql.test(s))).toBe(false);
    expect(sqls()).toContain('rollback');
    expect(sqls()).not.toContain('commit');
  });

  it('a second late report is 404 (the first one already made it printed)', async () => {
    let first = true;
    clientQuery.mockImplementation(async (sql: string) => {
      if (stateSql.test(sql)) {
        const found = first;
        first = false;
        return found ? { rows: [{ article_ids: ['a1'] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });
    expect((await post(`/agent/issues/${ISSUE_ID}/result`, { ok: true })).status).toBe(204);
    expect((await post(`/agent/issues/${ISSUE_ID}/result`, { ok: true })).status).toBe(404);
  });

  it('not ok never revives a timed-out issue: its update still requires status = \'printing\'', async () => {
    withIssue(false);
    const res = await post(`/agent/issues/${ISSUE_ID}/result`, { ok: false, error: 'jam' });
    expect(res.status).toBe(404);
    const issue = clientQuery.mock.calls.find(([s]) => stateSql.test(String(s)))!;
    expect(String(issue[0])).toMatch(/set status = 'failed'/);
    expect(String(issue[0])).toMatch(/status = 'printing'/);
    expect(String(issue[0])).not.toMatch(/timed out/);
  });

  it('error text is cut by code points, not UTF-16 units (no split emoji)', async () => {
    withIssue(true);
    await post(`/agent/issues/${ISSUE_ID}/result`, { ok: false, error: '\u{1F5A8}'.repeat(600) });
    const issue = clientQuery.mock.calls.find(([s]) => stateSql.test(String(s)))!;
    const stored = issue[1][3] as string;
    expect(Array.from(stored)).toHaveLength(500);
    expect(stored).toBe('\u{1F5A8}'.repeat(500));
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

describe('GET /agent/issues/:id/pdf', () => {
  const issueSql = /from issues/;
  const articlesSql = /from articles/;
  const printedSql = /update issues set status = 'printed'/;
  const ARTICLE = {
    id: 'a1',
    title: 'T',
    author: 'A',
    site_name: 'S',
    source_url: 'https://example.com/x',
    reading_minutes: 4,
    content_html: '<p>hi</p>',
  };
  const pdfStream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF-fake'));
        controller.close();
      },
    });

  /** The issue lookup finds `issue` (or nothing); the articles query answers `articles`. */
  function withIssue(issue: { layout: 'flat' | 'booklet'; article_ids: string[] } | null, articles: unknown[] = [ARTICLE]) {
    pool((sql) => {
      if (issueSql.test(sql) && !articlesSql.test(sql)) return issue ? { rows: [issue], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (articlesSql.test(sql)) return { rows: articles, rowCount: articles.length };
      return { rows: [], rowCount: 1 };
    });
  }
  const find = (re: RegExp) => query.mock.calls.find(([s]) => re.test(String(s)) && !/print_devices/.test(String(s)));

  it('renders the device\'s printing issue: 200 application/pdf, articles in issue order', async () => {
    withIssue({ layout: 'booklet', article_ids: ['a2', 'a1'] });
    renderIssuePdf.mockResolvedValue(pdfStream());

    const res = await get(`/agent/issues/${ISSUE_ID}/pdf`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="paperbrew-\d{4}-\d{2}-\d{2}-booklet\.pdf"$/);
    expect(await res.text()).toBe('%PDF-fake');

    const issue = find(/from issues/)!;
    expect(String(issue[0])).toMatch(/status = 'printing'/);
    expect(String(issue[0])).toMatch(/claimed_by = \$2/);
    expect(String(issue[0])).toMatch(/user_id = \$3/);
    expect(issue[1]).toEqual([ISSUE_ID, DEVICE_ID, 'user-9']);

    const arts = find(/from articles/)!;
    const s = String(arts[0]);
    expect(s).toMatch(/id = any\(\$1\)/);
    expect(s).toMatch(/user_id = \$2/);
    expect(s).toMatch(/archived_at is null/);
    expect(s).toMatch(/status = 'ready'/);
    expect(s).toMatch(/order by array_position\(\$1::uuid\[\], id\)/);
    expect(arts[1]).toEqual([['a2', 'a1'], 'user-9']);

    expect(renderIssuePdf).toHaveBeenCalledTimes(1);
    const [articles, layout, date] = renderIssuePdf.mock.calls[0];
    expect(articles).toEqual([
      { title: 'T', author: 'A', siteName: 'S', sourceUrl: 'https://example.com/x', readingMinutes: 4, contentHtml: '<p>hi</p>' },
    ]);
    expect(layout).toBe('booklet');
    expect(date).toBeInstanceOf(Date);
    expect(find(printedSql)).toBeUndefined();
  });

  it('every article archived since queuing -> 204 and the issue is marked printed', async () => {
    withIssue({ layout: 'flat', article_ids: ['a1'] }, []);

    const res = await get(`/agent/issues/${ISSUE_ID}/pdf`);

    expect(res.status).toBe(204);
    expect(renderIssuePdf).not.toHaveBeenCalled();
    const printed = find(printedSql)!;
    expect(String(printed[0])).toMatch(/status = 'printing'/);
    expect(String(printed[0])).toMatch(/claimed_by = \$2/);
    expect(printed[1]).toEqual([ISSUE_ID, DEVICE_ID]);
  });

  it('BusyError -> 503 with Retry-After: 30 and the issue stays printing', async () => {
    withIssue({ layout: 'flat', article_ids: ['a1'] });
    renderIssuePdf.mockRejectedValue(new BusyError());

    const res = await get(`/agent/issues/${ISSUE_ID}/pdf`);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(claims()).toHaveLength(0);
  });

  it('another render failure -> 500 and the issue is not modified', async () => {
    withIssue({ layout: 'flat', article_ids: ['a1'] });
    renderIssuePdf.mockRejectedValue(new Error('chromium died'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await get(`/agent/issues/${ISSUE_ID}/pdf`);

    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(claims()).toHaveLength(0);
    log.mockRestore();
  });

  it('another device\'s issue, or one that is not printing -> 404 and no articles are read', async () => {
    withIssue(null);

    const res = await get(`/agent/issues/${ISSUE_ID}/pdf`);

    expect(res.status).toBe(404);
    expect(find(/from articles/)).toBeUndefined();
    expect(renderIssuePdf).not.toHaveBeenCalled();
    expect(claims()).toHaveLength(0);
  });

  it('a non-uuid id is 404 without querying issues', async () => {
    withIssue({ layout: 'flat', article_ids: [] });
    const res = await get('/agent/issues/not-a-uuid/pdf');
    expect(res.status).toBe(404);
    expect(find(/from issues/)).toBeUndefined();
  });
});

describe('POST /agent/pair is not behind the device token', () => {
  it('reaches its handler without a token: bad body -> 400, not 401', async () => {
    const { devices } = await import('../src/print/devices.js');
    const res = await devices.request('/agent/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('the agent router does not claim it either: it is unknown there (404), never 401', async () => {
    const res = await agent.request('/agent/pair', { method: 'POST', body: JSON.stringify({ code: 'ABCD2345' }) });
    expect(res.status).toBe(404);
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
