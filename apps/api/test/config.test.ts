import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE = {
  DATABASE_URL: 'postgres://localhost:5432/test',
  INBOUND_ADDRESS: '{token}@save.example.com',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234',
  BETTER_AUTH_URL: 'http://localhost:5173',
  INBOUND_WEBHOOK_USER: 'user',
  INBOUND_WEBHOOK_PASSWORD: 'password-password-1',
};

async function load(extra: Record<string, string | undefined>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...BASE, AUTOBREW_ENABLED: undefined, ...extra })) {
    if (v === undefined) delete process.env[k];
    else vi.stubEnv(k, v);
  }
  return (await import('../src/config.js')).config;
}

afterEach(() => vi.unstubAllEnvs());

describe('AUTOBREW_ENABLED', () => {
  it('is false when unset', async () => {
    expect((await load({})).AUTOBREW_ENABLED).toBe(false);
  });

  it('parses the string "false" as false', async () => {
    expect((await load({ AUTOBREW_ENABLED: 'false' })).AUTOBREW_ENABLED).toBe(false);
  });

  it('parses "true" as true', async () => {
    expect((await load({ AUTOBREW_ENABLED: 'true' })).AUTOBREW_ENABLED).toBe(true);
  });
});
