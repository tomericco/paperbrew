import { describe, expect, it, vi } from 'vitest';

// app.ts loads Better Auth, the DB pool and config at import time. Requests below carry no cookie,
// so getSession answers null and no query reaches the database.
vi.mock('../src/config.js', () => ({
  config: {
    DATABASE_URL: 'postgres://localhost:5432/test',
    INBOUND_ADDRESS: '{token}@save.example.com',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234',
    BETTER_AUTH_URL: 'http://localhost:5173',
    POSTMARK_WEBHOOK_USER: 'user',
    POSTMARK_WEBHOOK_PASSWORD: 'password-password-1',
    REQUIRE_KNOWN_SENDER: false,
    FETCH_TIMEOUT_MS: 1000,
    FETCH_MAX_BYTES: 1000,
    PORT: 8787,
  },
}));

const { app } = await import('../src/app.js');

describe('signed-in user routes without a session', () => {
  const ARTICLE = '/articles/00000000-0000-0000-0000-000000000000';
  const cases: Array<[string, string, RequestInit | undefined]> = [
    ['GET', '/me', undefined],
    ['PUT', '/me/address', { body: JSON.stringify({ token: 'amber-otter' }), headers: { 'content-type': 'application/json' } }],
    ['GET', '/articles', undefined],
    ['DELETE', ARTICLE, undefined],
  ];

  it.each(cases)('%s %s -> 401', async (method, path, init) => {
    const res = await app.request(path, { method, ...init });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });
});
