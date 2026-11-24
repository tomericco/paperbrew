import { afterEach, describe, expect, it, vi } from 'vitest';

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
    AUTOBREW_ENABLED: false,
  },
}));

const { app } = await import('../src/app.js');
const { auth } = await import('../src/auth/auth.js');
const { pool } = await import('../src/db/client.js');
const { CANDIDATES_SQL } = await import('../src/schedule/createIssue.js');

const cookie = { cookie: 'better-auth.session_token=x' };
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const row = (id: string, reading_minutes: number | null) => ({ id, reading_minutes, rollover_count: 0 });

function setup(candidates: unknown[], budget = 20) {
  vi.spyOn(auth.api, 'getSession').mockResolvedValue({ user: { id: 'auth-1', email: 'a@example.com' }, session: {} } as never);
  return vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
    if (/from users where auth_user_id/.test(sql)) return { rows: [{ id: 'user-1' }] };
    if (sql === CANDIDATES_SQL) return { rows: candidates };
    if (/brew_budget_minutes/.test(sql)) return { rows: [{ brew_budget_minutes: budget }] };
    return { rows: [] };
  }) as never);
}

describe('GET /me/next-issue', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires a session', async () => {
    expect((await app.request('/me/next-issue')).status).toBe(401);
  });

  it('picks the first article only when the second would pass the budget', async () => {
    const query = setup([row(A, 9), row(B, 12), row(C, 15)], 20);
    const res = await app.request('/me/next-issue', { headers: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ids: [A], minutes: 9, budgetMinutes: 20 });
    const candidateCall = query.mock.calls.find(([sql]) => sql === CANDIDATES_SQL)!;
    expect(candidateCall[1]).toEqual(['user-1']);
  });

  it('includes several articles that fit and counts null minutes as 1', async () => {
    setup([row(A, 9), row(B, null), row(C, 10)], 20);
    const res = await app.request('/me/next-issue', { headers: cookie });
    expect(await res.json()).toEqual({ ids: [A, B, C], minutes: 20, budgetMinutes: 20 });
  });

  it('always includes the first article even when it exceeds the budget', async () => {
    setup([row(A, 45), row(B, 5)], 20);
    const res = await app.request('/me/next-issue', { headers: cookie });
    expect(await res.json()).toEqual({ ids: [A], minutes: 45, budgetMinutes: 20 });
  });

  it('returns an empty preview when there are no articles', async () => {
    setup([], 30);
    const res = await app.request('/me/next-issue', { headers: cookie });
    expect(await res.json()).toEqual({ ids: [], minutes: 0, budgetMinutes: 30 });
  });

  it('writes nothing', async () => {
    const query = setup([row(A, 9), row(B, 12)], 10);
    await app.request('/me/next-issue', { headers: cookie });
    for (const [sql] of query.mock.calls) {
      expect(String(sql)).not.toMatch(/\b(insert|update|delete)\b/i);
    }
  });
});
