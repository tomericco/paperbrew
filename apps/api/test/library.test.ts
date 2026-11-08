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

describe('signed-in user routes without a session', () => {
  const ARTICLE = '/articles/00000000-0000-0000-0000-000000000000';
  const cases: Array<[string, string, RequestInit | undefined]> = [
    ['GET', '/me', undefined],
    ['PUT', '/me/address', { body: JSON.stringify({ token: 'amber-otter' }), headers: { 'content-type': 'application/json' } }],
    ['PUT', '/me/settings', { body: JSON.stringify({ paperLayout: 'booklet' }), headers: { 'content-type': 'application/json' } }],
    ['GET', '/articles', undefined],
    ['GET', '/brew', undefined],
    ['DELETE', ARTICLE, undefined],
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
