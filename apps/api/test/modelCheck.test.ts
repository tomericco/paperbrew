import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
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
  CRON_SECRET: 'cron-secret-cron-secret' as string | undefined,
}));
const zeroShot = vi.hoisted(() => vi.fn());
vi.mock('../src/config.js', () => ({ config: cfg }));
vi.mock('../src/jobs/runner.js', () => ({ drain: vi.fn() }));
vi.mock('../src/gmail/model.js', () => ({ MODEL_ID: 'test/model', zeroShot }));

const { app } = await import('../src/app.js');

const BEARER = { authorization: 'Bearer cron-secret-cron-secret' };

beforeEach(() => {
  zeroShot.mockReset();
});

describe('GET /cron/model-check', () => {
  it('without the bearer -> 401 and the model is not touched', async () => {
    const res = await app.request('/cron/model-check');
    expect(res.status).toBe(401);
    expect(zeroShot).not.toHaveBeenCalled();
  });

  it('reports the top label when the model loads', async () => {
    zeroShot.mockResolvedValue({ labels: ['a sales promotion or discount'], scores: [0.9] });
    const res = await app.request('/cron/model-check', { headers: BEARER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, model: 'test/model', top: 'a sales promotion or discount' });
  });

  it('answers 500 with the message only (no stack, no secret) when the model fails to load', async () => {
    zeroShot.mockRejectedValue(new Error('model load timed out after 60s'));
    const res = await app.request('/cron/model-check', { headers: BEARER });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'model load timed out after 60s' });
    expect(JSON.stringify(body)).not.toContain('cron-secret');
    expect(JSON.stringify(body)).not.toContain(' at ');
  });
});
