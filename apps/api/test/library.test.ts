import { afterEach, describe, expect, it, vi } from 'vitest';

// app.ts loads Better Auth, the DB pool and config at import time. Requests below carry no cookie,
// so getSession answers null and no query reaches the database.
vi.mock('../src/config.js', () => ({
  config: {
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
  },
}));

const { app } = await import('../src/app.js');
const { auth } = await import('../src/auth/auth.js');
const { pool } = await import('../src/db/client.js');
const { gmailAvailable } = await import('../src/gmail/available.js');

describe('gmailAvailable', () => {
  const full = { GMAIL_TOKEN_KEY: 'k', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' };

  it('is true when the token key and the Google client pair are all set', () => {
    expect(gmailAvailable(full)).toBe(true);
  });

  it.each(Object.keys(full))('is false when %s is missing or empty', (key) => {
    expect(gmailAvailable({ ...full, [key]: undefined })).toBe(false);
    expect(gmailAvailable({ ...full, [key]: '' })).toBe(false);
  });
});

describe('signed-in user routes without a session', () => {
  const ARTICLE = '/articles/00000000-0000-0000-0000-000000000000';
  const cases: Array<[string, string, RequestInit | undefined]> = [
    ['GET', '/me', undefined],
    ['PUT', '/me/address', { body: JSON.stringify({ token: 'amber-otter' }), headers: { 'content-type': 'application/json' } }],
    ['PUT', '/me/settings', { body: JSON.stringify({ paperLayout: 'booklet' }), headers: { 'content-type': 'application/json' } }],
    ['GET', '/articles', undefined],
    ['GET', '/brew', undefined],
    ['DELETE', ARTICLE, undefined],
    ['POST', '/articles/archive', { body: JSON.stringify({ ids: [ARTICLE.slice(10)] }), headers: { 'content-type': 'application/json' } }],
    ['POST', ARTICLE + '/unarchive', undefined],
  ];

  it.each(cases)('%s %s -> 401', async (method, path, init) => {
    const res = await app.request(path, { method, ...init });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('requireUser', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['/me', '/articles'])('checks the session once on GET %s', async (path) => {
    const getSession = vi
      .spyOn(auth.api, 'getSession')
      .mockResolvedValue({ user: { id: 'auth-1', email: 'a@example.com' }, session: {} } as never);
    const query = vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      if (/from users where auth_user_id/.test(sql)) return { rows: [{ id: 'user-1' }] };
      if (/from users u join inbound_addresses/.test(sql)) return { rows: [{ token: 'amber-otter', email: 'a@example.com' }] };
      return { rows: [] };
    }) as never);

    const res = await app.request(path, { headers: { cookie: 'better-auth.session_token=x' } });

    expect(res.status).toBe(200);
    expect(getSession).toHaveBeenCalledTimes(1);
    const lookups = query.mock.calls.filter(([sql]) => /auth_user_id/.test(String(sql)));
    expect(lookups).toHaveLength(1);
  });
});

describe('paper layout setting', () => {
  afterEach(() => vi.restoreAllMocks());

  const signedIn = () => {
    vi.spyOn(auth.api, 'getSession').mockResolvedValue({
      user: { id: 'auth-1', email: 'a@example.com' },
      session: {},
    } as never);
    return vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      if (/from users where auth_user_id/.test(sql)) return { rows: [{ id: 'user-1' }] };
      if (/from users u join inbound_addresses/.test(sql)) {
        return { rows: [{ token: 'amber-otter', email: 'a@example.com', paper_layout: 'booklet' }] };
      }
      return { rows: [] };
    }) as never);
  };

  const put = (body: unknown) =>
    app.request('/me/settings', {
      method: 'PUT',
      headers: { cookie: 'better-auth.session_token=x', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET /me returns paperLayout', async () => {
    signedIn();
    const res = await app.request('/me', { headers: { cookie: 'better-auth.session_token=x' } });
    expect(res.status).toBe(200);
    expect((await res.json()).paperLayout).toBe('booklet');
  });

  it('GET /me returns gmailAvailable from the environment', async () => {
    const original = { ...process.env };
    try {
      delete process.env.GMAIL_TOKEN_KEY;
      signedIn();
      const off = await app.request('/me', { headers: { cookie: 'better-auth.session_token=x' } });
      expect((await off.json()).gmailAvailable).toBe(false);

      process.env.GMAIL_TOKEN_KEY = 'k';
      process.env.GOOGLE_CLIENT_ID = 'id';
      process.env.GOOGLE_CLIENT_SECRET = 'secret';
      const on = await app.request('/me', { headers: { cookie: 'better-auth.session_token=x' } });
      expect((await on.json()).gmailAvailable).toBe(true);
    } finally {
      process.env = original;
    }
  });

  it('PUT /me/settings saves the layout', async () => {
    const query = signedIn();
    const res = await put({ paperLayout: 'booklet' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paperLayout: 'booklet' });
    const updates = query.mock.calls.filter(([sql]) => /update users set paper_layout = \$1 where id = \$2/.test(String(sql)));
    expect(updates).toHaveLength(1);
    expect(updates[0]![1]).toEqual(['booklet', 'user-1']);
  });

  it.each([{}, { paperLayout: 'a5' }, null])('PUT /me/settings rejects %j', async (body) => {
    const query = signedIn();
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'paperLayout must be flat or booklet' });
    expect(query.mock.calls.filter(([sql]) => /update users/.test(String(sql)))).toHaveLength(0);
  });
});

describe('archiving articles', () => {
  afterEach(() => vi.restoreAllMocks());

  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const cookie = { cookie: 'better-auth.session_token=x' };

  const signedIn = (articleRows: unknown[] = [], rowCount: number | null = articleRows.length) => {
    vi.spyOn(auth.api, 'getSession').mockResolvedValue({
      user: { id: 'auth-1', email: 'a@example.com' },
      session: {},
    } as never);
    return vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      if (/from users where auth_user_id/.test(sql)) return { rows: [{ id: 'user-1' }] };
      if (/articles/.test(sql)) return { rows: articleRows, rowCount };
      return { rows: [] };
    }) as never);
  };

  const articleSql = (query: ReturnType<typeof signedIn>) =>
    query.mock.calls.filter(([sql]) => /articles/.test(String(sql)));

  const post = (body: unknown) =>
    app.request('/articles/archive', {
      method: 'POST',
      headers: { ...cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('GET /articles excludes archived', async () => {
    const query = signedIn();
    const res = await app.request('/articles', { headers: cookie });
    expect(res.status).toBe(200);
    expect(String(articleSql(query)[0]![0])).toContain('archived_at is null');
    expect(articleSql(query)[0]![1]).toEqual(['user-1']);
  });

  it('GET /articles?archived=1 lists archived with archivedAt', async () => {
    const archivedAt = new Date('2026-11-20T10:00:00.000Z');
    const query = signedIn([
      { id: A, title: 'T', site_name: 's', source_url: 'https://x.test', status: 'ready', word_count: 10, created_at: new Date('2026-11-01T00:00:00Z'), archived_at: archivedAt },
    ]);
    const res = await app.request('/articles?archived=1', { headers: cookie });
    expect(res.status).toBe(200);
    const sql = String(articleSql(query)[0]![0]);
    expect(sql).toContain('archived_at is not null');
    expect(sql).toContain('limit 500');
    expect(sql).toMatch(/order by archived_at desc, created_at asc/);
    expect(articleSql(query)[0]![1]).toEqual(['user-1']);
    const { articles } = await res.json();
    expect(articles[0].archivedAt).toBe('2026-11-20T10:00:00.000Z');
    expect(articles[0].id).toBe(A);
  });

  it('archives only own, unarchived rows', async () => {
    const archivedAt = new Date('2026-11-20T10:00:00.000Z');
    const query = signedIn([{ archived_at: archivedAt }, { archived_at: archivedAt }], 2);
    const res = await post({ ids: [A, B, A] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: 2, archivedAt: '2026-11-20T10:00:00.000Z' });
    const update = articleSql(query).find(([sql]) => /update articles/.test(String(sql)))!;
    expect(String(update[0])).toContain('user_id =');
    expect(String(update[0])).toContain('archived_at is null');
    expect(update[1]).toEqual(expect.arrayContaining(['user-1']));
    expect(update[1]).toContainEqual([A, B]);
  });

  it('archives nothing when no row matches', async () => {
    signedIn([], 0);
    const res = await post({ ids: [A] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(0);
    expect(Number.isNaN(Date.parse(body.archivedAt))).toBe(false);
  });

  const tooMany = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  it.each([{ ids: [] }, { ids: ['nope'] }, { ids: tooMany }, undefined])('rejects a bad archive body %#', async (body) => {
    const query = signedIn();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
    expect(articleSql(query)).toHaveLength(0);
  });

  const unarchive = (id: string) => app.request(`/articles/${id}/unarchive`, { method: 'POST', headers: cookie });

  it('unarchive returns 204 when a row was restored', async () => {
    const query = signedIn([], 1);
    const res = await unarchive(A);
    expect(res.status).toBe(204);
    const update = articleSql(query)[0]!;
    expect(String(update[0])).toContain('archived_at = null');
    expect(String(update[0])).toContain('archived_at is not null');
    expect(update[1]).toEqual([A, 'user-1']);
  });

  it('unarchive returns 404 when nothing matched', async () => {
    signedIn([], 0);
    expect((await unarchive(A)).status).toBe(404);
  });

  it('unarchive returns 404 for a non-UUID id without a query', async () => {
    const query = signedIn();
    expect((await unarchive('nope')).status).toBe(404);
    expect(articleSql(query)).toHaveLength(0);
  });
});
