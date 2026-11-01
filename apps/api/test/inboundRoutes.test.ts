import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudmailinForwardedFixture, forwardedNewsletterFixture } from './helpers.js';

// app.ts loads Better Auth, the DB pool and config at import time. Nothing below reaches the database:
// the one lookup that would is stubbed.
vi.mock('../src/config.js', () => ({
  config: {
    DATABASE_URL: 'postgres://localhost:5432/test',
    INBOUND_ADDRESS: '4fcb639be7306607cef6+{token}@cloudmailin.net',
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
const { pool } = await import('../src/db/client.js');

const CLOUDMAILIN = '/webhooks/cloudmailin/inbound';
const POSTMARK = '/webhooks/postmark/inbound';
const AUTH = `Basic ${Buffer.from('user:password-password-1').toString('base64')}`;

function post(path: string, body: unknown, auth?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

afterEach(() => vi.restoreAllMocks());

describe('inbound webhooks', () => {
  it.each([CLOUDMAILIN, POSTMARK])('POST %s without auth -> 401', async (path) => {
    const res = await post(path, {});
    expect(res.status).toBe(401);
  });

  it.each([CLOUDMAILIN, POSTMARK])('POST %s with the wrong password -> 401', async (path) => {
    const res = await post(path, {}, `Basic ${Buffer.from('user:wrong-password-xx').toString('base64')}`);
    expect(res.status).toBe(401);
  });

  it('acknowledges a malformed CloudMailin payload and logs its top-level keys, not values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(CLOUDMAILIN, { headers: { subject: 'secret subject' }, plain: 'x' }, AUTH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'malformed' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('headers');
    expect(logged).toContain('plain');
    expect(logged).toContain('envelope'); // the zod issue path
    expect(logged).not.toContain('secret subject');
  });

  it('ignores a CloudMailin email with no Paperbrew recipient', async () => {
    const body = cloudmailinForwardedFixture();
    body.envelope.to = 'someone@cloudmailin.net';
    body.envelope.recipients = ['someone@cloudmailin.net'];
    body.headers.to = 'someone@cloudmailin.net';
    const res = await post(CLOUDMAILIN, body, AUTH);
    expect(await res.json()).toEqual({ ok: true, ignored: 'no_paperbrew_recipient' });
  });

  it('looks up the CloudMailin token and ignores an unknown address', async () => {
    const query = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] } as never);
    const res = await post(CLOUDMAILIN, cloudmailinForwardedFixture(), AUTH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'unknown_address' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([['amber-otter-lantern']]);
  });

  it('still accepts Postmark on the same credentials', async () => {
    // The Postmark fixture is addressed to save.example.com, which this config doesn't route.
    const res = await post(POSTMARK, forwardedNewsletterFixture(), AUTH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'no_paperbrew_recipient' });
  });
});
