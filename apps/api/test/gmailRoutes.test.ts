import { createMiddleware } from 'hono/factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// routes.ts is tested without Better Auth, Google or a database: requireUser signs in a fixed user
// (when the x-test-user header is present), the pool records its queries, and the Gmail client is a stub.
const query = vi.fn();
const enqueue = vi.fn();
const authUrl = vi.fn();
const exchangeCode = vi.fn();
const getProfile = vi.fn();
const revokeToken = vi.fn();

class GmailAuthError extends Error {}

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'test-secret-test-secret-test-secret-1234';

vi.mock('../src/config.js', () => ({
  config: { BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'http://localhost:5173', GMAIL_TOKEN_KEY: TEST_KEY },
}));
vi.mock('../src/routes/library.js', () => ({
  requireUser: createMiddleware<{ Variables: { userId: string } }>(async (c, next) => {
    if (c.req.header('x-test-user') !== 'yes') return c.json({ error: 'unauthorized' }, 401);
    c.set('userId', 'user-1');
    await next();
  }),
}));
vi.mock('../src/db/client.js', () => ({ pool: { query } }));
vi.mock('../src/jobs/queue.js', () => ({ enqueue }));
vi.mock('../src/gmail/client.js', () => ({ authUrl, exchangeCode, getProfile, revokeToken, GmailAuthError }));

const { gmail } = await import('../src/gmail/routes.js');
const { signState, verifyState } = await import('../src/gmail/state.js');
const { encryptToken, decryptToken } = await import('../src/gmail/crypto.js');

const WEB = 'http://localhost:5173';
const REDIRECT_URI = `${WEB}/api/gmail/callback`;
const SIGNED_IN = { headers: { 'x-test-user': 'yes' } };
const upserts = () => query.mock.calls.filter(([sql]) => /insert into gmail_connections/.test(String(sql)));

beforeEach(() => {
  vi.stubEnv('GMAIL_TOKEN_KEY', TEST_KEY);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  authUrl.mockImplementation((state: string) => `https://accounts.example/auth?state=${encodeURIComponent(state)}`);
  exchangeCode.mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  getProfile.mockResolvedValue({ emailAddress: 'me@gmail.com', historyId: '4242' });
  revokeToken.mockResolvedValue(undefined);
  enqueue.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('without a session', () => {
  it.each([
    ['GET', '/gmail/connect'],
    ['GET', '/gmail/callback?code=c&state=s'],
    ['GET', '/me/gmail'],
    ['DELETE', '/me/gmail'],
  ])('%s %s -> 401', async (method, path) => {
    const res = await gmail.request(path, { method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /gmail/connect', () => {
  it('redirects to Google with a state signed for this user', async () => {
    const res = await gmail.request('/gmail/connect', SIGNED_IN);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://accounts.example/auth');
    expect(verifyState(location.searchParams.get('state')!, SECRET)).toEqual({ userId: 'user-1' });
    expect(authUrl).toHaveBeenCalledWith(expect.any(String), REDIRECT_URI);
  });

  it('answers 503 when Gmail is not configured', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    const res = await gmail.request('/gmail/connect', SIGNED_IN);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'gmail not configured' });
    expect(authUrl).not.toHaveBeenCalled();
  });
});

describe('GET /gmail/callback', () => {
  const call = (qs: string) => gmail.request(`/gmail/callback${qs}`, SIGNED_IN);
  const good = () => `?code=the-code&state=${encodeURIComponent(signState('user-1', SECRET))}`;
  const expectError = (res: Response) => {
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${WEB}/app/settings?gmail=error`);
  };

  it('stores the encrypted refresh token and the profile history id, enqueues a sync and redirects', async () => {
    const res = await call(good());

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${WEB}/app/settings?gmail=connected`);
    expect(exchangeCode).toHaveBeenCalledWith('the-code', REDIRECT_URI);
    expect(getProfile).toHaveBeenCalledWith('access-1');

    expect(upserts()).toHaveLength(1);
    const [sql, params] = upserts()[0] as [string, unknown[]];
    expect(sql).toMatch(/on conflict \(user_id\) do update/);
    expect(sql).toMatch(/status\s*=\s*'active'/);
    expect(sql).toMatch(/last_error\s*=\s*null/);
    const [userId, email, enc, historyId] = params as string[];
    expect([userId, email, historyId]).toEqual(['user-1', 'me@gmail.com', '4242']);
    expect(enc).not.toContain('refresh-1');
    expect(decryptToken(enc, TEST_KEY)).toBe('refresh-1');
    expect(params.join(' ')).not.toContain('access-1');

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), 'gmail_sync', { id: 'user-1' });
  });

  it('keeps the token and code out of the redirect', async () => {
    const res = await call(good());
    const location = res.headers.get('location')!;
    expect(location).not.toMatch(/refresh-1|access-1|the-code/);
  });

  it('redirects with an error when the user cancels at Google', async () => {
    expectError(await call('?error=access_denied'));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(upserts()).toHaveLength(0);
  });

  it.each([['no params', ''], ['no code', `?state=${encodeURIComponent(signState('user-1', SECRET))}`], ['no state', '?code=c']])(
    'redirects with an error on %s',
    async (_name, qs) => {
      expectError(await call(qs));
      expect(upserts()).toHaveLength(0);
    },
  );

  it('rejects a state with a bad signature', async () => {
    expectError(await call('?code=c&state=user-1.9999999999999.bogus'));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(upserts()).toHaveLength(0);
  });

  it('rejects an expired state', async () => {
    const old = signState('user-1', SECRET, new Date(Date.now() - 60 * 60_000));
    expectError(await call(`?code=c&state=${encodeURIComponent(old)}`));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(upserts()).toHaveLength(0);
  });

  it('rejects a state signed for a different user than the session', async () => {
    const other = signState('user-2', SECRET);
    expectError(await call(`?code=c&state=${encodeURIComponent(other)}`));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(upserts()).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('stores nothing when Google returns no refresh token', async () => {
    exchangeCode.mockResolvedValue({ accessToken: 'access-1', refreshToken: null });
    expectError(await call(good()));
    expect(getProfile).not.toHaveBeenCalled();
    expect(upserts()).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('redirects with an error and logs only the message when the code exchange fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exchangeCode.mockRejectedValue(new GmailAuthError('Google rejected the grant'));
    expectError(await call(good()));
    expect(upserts()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('Google rejected the grant');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/the-code|refresh-1/);
  });

  it('redirects with an error when the profile lookup fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getProfile.mockRejectedValue(new Error('Gmail profile request returned 500'));
    expectError(await call(good()));
    expect(upserts()).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers 503 when Gmail is not configured', async () => {
    vi.stubEnv('GMAIL_TOKEN_KEY', '');
    const res = await call(good());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'gmail not configured' });
    expect(exchangeCode).not.toHaveBeenCalled();
  });
});

describe('GET /me/gmail', () => {
  it('says not connected when there is no connection row', async () => {
    const res = await gmail.request('/me/gmail', SIGNED_IN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it('works even when Gmail is not configured', async () => {
    vi.stubEnv('GMAIL_TOKEN_KEY', '');
    const res = await gmail.request('/me/gmail', SIGNED_IN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it('returns the connection and the 20 most recent decisions', async () => {
    const synced = new Date('2026-11-20T10:00:00Z');
    const seen = new Date('2026-11-20T09:00:00Z');
    query.mockImplementation(async (sql: string) => {
      if (/from gmail_connections/.test(sql)) {
        return { rows: [{ google_email: 'me@gmail.com', status: 'active', last_synced_at: synced }] };
      }
      if (/from gmail_messages/.test(sql)) {
        return {
          rows: [{ from_email: 'a@news.com', subject: 'Hello', decision: 'editorial', reason: 'long text', seen_at: seen }],
        };
      }
      return { rows: [] };
    });

    const res = await gmail.request('/me/gmail', SIGNED_IN);

    expect(await res.json()).toEqual({
      connected: true,
      email: 'me@gmail.com',
      status: 'active',
      lastSyncedAt: synced.toISOString(),
      recent: [{ from: 'a@news.com', subject: 'Hello', decision: 'editorial', reason: 'long text', seenAt: seen.toISOString() }],
    });
    const recentCall = query.mock.calls.find(([sql]) => /from gmail_messages/.test(String(sql)))!;
    expect(String(recentCall[0])).toMatch(/order by seen_at desc/);
    expect(String(recentCall[0])).toMatch(/limit 20/);
    expect(recentCall[1]).toEqual(['user-1']);
  });
});

describe('DELETE /me/gmail', () => {
  const rowDeleted = (enc: string | null) =>
    query.mockImplementation(async (sql: string) => {
      if (/delete from gmail_connections/.test(sql)) {
        return enc === null ? { rows: [], rowCount: 0 } : { rows: [{ refresh_token_enc: enc }], rowCount: 1 };
      }
      return { rows: [] };
    });

  it('revokes the refresh token at Google and deletes the connection only', async () => {
    rowDeleted(encryptToken('refresh-1', TEST_KEY));

    const res = await gmail.request('/me/gmail', { method: 'DELETE', ...SIGNED_IN });

    expect(res.status).toBe(204);
    expect(revokeToken).toHaveBeenCalledWith('refresh-1');
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toMatch(/delete from gmail_connections where user_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['user-1']);
  });

  it('still deletes the row when the token cannot be decrypted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rowDeleted('v1.garbage');

    const res = await gmail.request('/me/gmail', { method: 'DELETE', ...SIGNED_IN });

    expect(res.status).toBe(204);
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it('answers 204 when there was no connection', async () => {
    rowDeleted(null);

    const res = await gmail.request('/me/gmail', { method: 'DELETE', ...SIGNED_IN });

    expect(res.status).toBe(204);
    expect(revokeToken).not.toHaveBeenCalled();
  });
});
