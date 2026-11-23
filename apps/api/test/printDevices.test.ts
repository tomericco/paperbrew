import { createMiddleware } from 'hono/factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// devices.ts is tested without Better Auth or a database: requireUser signs in a fixed user (when the
// x-test-user header is present) and the pool records its queries.
const query = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();
const connect = vi.fn();

vi.mock('../src/config.js', () => ({
  config: { BETTER_AUTH_URL: 'http://localhost:5173' },
}));
vi.mock('../src/routes/library.js', () => ({
  requireUser: createMiddleware<{ Variables: { userId: string } }>(async (c, next) => {
    if (c.req.header('x-test-user') !== 'yes') return c.json({ error: 'unauthorized' }, 401);
    c.set('userId', 'user-1');
    await next();
  }),
}));
vi.mock('../src/db/client.js', () => ({
  pool: { query, connect },
  isUniqueViolation: (err: unknown) => (err as { code?: string })?.code === '23505',
}));

const { devices, requireDevice } = await import('../src/print/devices.js');
const { sha256, formatPairCode, normalizePairCode } = await import('../src/print/secrets.js');
const { Hono } = await import('hono');

const SIGNED_IN = { headers: { 'x-test-user': 'yes' } };
const JSON_POST = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const DEVICE_ID = '11111111-2222-3333-4444-555555555555';

const sqlOf = (mock: typeof query, re: RegExp) => mock.mock.calls.filter(([sql]) => re.test(String(sql)));

beforeEach(() => {
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  connect.mockResolvedValue({ query: clientQuery, release });
});

afterEach(() => vi.clearAllMocks());

describe('without a session', () => {
  it.each([
    ['POST', '/me/print-devices/pair-code'],
    ['GET', '/me/print-devices'],
    ['DELETE', `/me/print-devices/${DEVICE_ID}`],
  ])('%s %s -> 401', async (method, path) => {
    const res = await devices.request(path, { method });
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /me/print-devices/pair-code', () => {
  it('stores the hash of the code, never the code, and returns code, expiry and deep link', async () => {
    const expires = new Date('2026-11-23T10:10:00.000Z');
    query.mockResolvedValueOnce({ rows: [{ expires_at: expires }], rowCount: 1 });

    const res = await devices.request('/me/print-devices/pair-code', { method: 'POST', ...SIGNED_IN });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.expiresAt).toBe(expires.toISOString());
    const raw = normalizePairCode(body.code);
    expect(body.link).toBe(`paperbrew://pair?code=${raw}&api=${encodeURIComponent('http://localhost:5173')}`);

    const [insert] = sqlOf(query, /insert into print_pair_codes/);
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual([sha256(raw), 'user-1']);
    expect(JSON.stringify(query.mock.calls)).not.toContain(raw);
  });

  it('draws another code when the hash collides', async () => {
    query
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
      .mockResolvedValueOnce({ rows: [{ expires_at: new Date() }], rowCount: 1 });
    const res = await devices.request('/me/print-devices/pair-code', { method: 'POST', ...SIGNED_IN });
    expect(res.status).toBe(200);
    expect(sqlOf(query, /insert into print_pair_codes/)).toHaveLength(2);
  });
});

describe('GET /me/print-devices', () => {
  it('lists the user\'s devices that are not revoked', async () => {
    const created = new Date('2026-11-20T09:00:00.000Z');
    query.mockResolvedValueOnce({
      rows: [{ id: DEVICE_ID, name: 'Studio Mac', created_at: created, last_seen_at: null }],
      rowCount: 1,
    });

    const res = await devices.request('/me/print-devices', SIGNED_IN);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      devices: [{ id: DEVICE_ID, name: 'Studio Mac', createdAt: created.toISOString(), lastSeenAt: null }],
    });
    const [select] = sqlOf(query, /from print_devices/);
    expect(String(select![0])).toMatch(/revoked_at is null/);
    expect(select![1]).toEqual(['user-1']);
  });
});

describe('DELETE /me/print-devices/:id', () => {
  it('revokes the device and answers 204', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await devices.request(`/me/print-devices/${DEVICE_ID}`, { method: 'DELETE', ...SIGNED_IN });
    expect(res.status).toBe(204);
    const [update] = sqlOf(query, /update print_devices set revoked_at/);
    expect(update![1]).toEqual([DEVICE_ID, 'user-1']);
  });

  it('is 404 for another user\'s or an already revoked device', async () => {
    const res = await devices.request(`/me/print-devices/${DEVICE_ID}`, { method: 'DELETE', ...SIGNED_IN });
    expect(res.status).toBe(404);
  });

  it('is 404 for a malformed id without touching the database', async () => {
    const res = await devices.request('/me/print-devices/nope', { method: 'DELETE', ...SIGNED_IN });
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /agent/pair', () => {
  const claimSql = /update print_pair_codes set used_at = now\(\)\s+where code_hash = \$1 and used_at is null and expires_at > now\(\)\s+returning user_id/;

  /** The code claim answers `claimed` rows; everything else succeeds. */
  const withClaim = (claimed: boolean) =>
    clientQuery.mockImplementation(async (sql: string) => {
      if (claimSql.test(sql)) return claimed ? { rows: [{ user_id: 'user-9' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (/insert into print_devices/.test(sql)) return { rows: [{ id: DEVICE_ID }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

  it('claims the code, revokes the other devices, inserts the new one and returns its token', async () => {
    withClaim(true);

    const res = await devices.request('/agent/pair', JSON_POST({ code: 'k7p2-9qxm', name: 'Studio Mac' }));

    expect(res.status).toBe(201);
    const { token, deviceId } = await res.json();
    expect(deviceId).toBe(DEVICE_ID);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const sql = clientQuery.mock.calls.map(([s]) => String(s).trim());
    expect(sql[0]).toBe('begin');
    const claim = clientQuery.mock.calls.find(([s]) => claimSql.test(String(s)))!;
    expect(claim[1]).toEqual([sha256('K7P29QXM')]);
    const revoke = clientQuery.mock.calls.find(([s]) => /update print_devices set revoked_at/.test(String(s)))!;
    expect(revoke[1]).toEqual(['user-9']);
    const insert = clientQuery.mock.calls.find(([s]) => /insert into print_devices/.test(String(s)))!;
    expect(insert[1]).toEqual(['user-9', 'Studio Mac', sha256(token)]);
    expect(sql.at(-1)).toBe('commit');
    expect(release).toHaveBeenCalledWith();
    // order: claim, revoke, insert
    const idx = (re: RegExp) => sql.findIndex((s) => re.test(s));
    expect(idx(claimSql)).toBeLessThan(idx(/update print_devices/));
    expect(idx(/update print_devices/)).toBeLessThan(idx(/insert into print_devices/));
    // the token itself is never stored or logged
    expect(JSON.stringify([...clientQuery.mock.calls, ...query.mock.calls])).not.toContain(token);
  });

  it('answers 410 when the code is expired or already used, and registers nothing', async () => {
    withClaim(false);

    const res = await devices.request('/agent/pair', JSON_POST({ code: 'K7P2-9QXM', name: 'Mac' }));

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'code expired or used' });
    expect(clientQuery.mock.calls.some(([s]) => /insert into print_devices/.test(String(s)))).toBe(false);
    expect(clientQuery.mock.calls.some(([s]) => /update print_devices/.test(String(s)))).toBe(false);
    expect(release).toHaveBeenCalled();
  });

  it('a second use of the same code is 410', async () => {
    let claimed = false;
    clientQuery.mockImplementation(async (sql: string) => {
      if (claimSql.test(sql)) {
        const first = !claimed;
        claimed = true;
        return first ? { rows: [{ user_id: 'user-9' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/insert into print_devices/.test(sql)) return { rows: [{ id: DEVICE_ID }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const first = await devices.request('/agent/pair', JSON_POST({ code: 'K7P29QXM', name: 'Mac' }));
    const second = await devices.request('/agent/pair', JSON_POST({ code: 'K7P29QXM', name: 'Mac' }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(410);
  });

  it('is 410 for a code that cannot be one, without a database round trip', async () => {
    const res = await devices.request('/agent/pair', JSON_POST({ code: 'short', name: 'Mac' }));
    expect(res.status).toBe(410);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ['trims', '  Studio Mac  ', 'Studio Mac'],
    ['caps at 80 chars', 'x'.repeat(200), 'x'.repeat(80)],
    ['defaults an empty name to Mac', '   ', 'Mac'],
  ])('name %s', async (_label, name, expected) => {
    withClaim(true);
    await devices.request('/agent/pair', JSON_POST({ code: 'K7P29QXM', name }));
    const insert = clientQuery.mock.calls.find(([s]) => /insert into print_devices/.test(String(s)))!;
    expect(insert[1][1]).toBe(expected);
  });

  it('defaults a missing name to Mac', async () => {
    withClaim(true);
    await devices.request('/agent/pair', JSON_POST({ code: 'K7P29QXM' }));
    const insert = clientQuery.mock.calls.find(([s]) => /insert into print_devices/.test(String(s)))!;
    expect(insert[1][1]).toBe('Mac');
  });

  it('is 400 when the body is not JSON with a code', async () => {
    const res = await devices.request('/agent/pair', { method: 'POST', body: 'nope' });
    expect(res.status).toBe(400);
  });

  it('rolls back and rethrows when a step fails', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (claimSql.test(sql)) return { rows: [{ user_id: 'user-9' }], rowCount: 1 };
      if (/insert into print_devices/.test(sql)) throw new Error('boom');
      return { rows: [], rowCount: 0 };
    });
    const res = await devices.request('/agent/pair', JSON_POST({ code: 'K7P29QXM', name: 'Mac' }));
    expect(res.status).toBe(500);
    expect(clientQuery.mock.calls.some(([s]) => String(s) === 'rollback')).toBe(true);
    expect(release).toHaveBeenCalledWith();
  });

  it('destroys a connection that could not roll back', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (claimSql.test(sql)) throw new Error('boom');
      if (sql === 'rollback') throw new Error('gone');
      return { rows: [], rowCount: 0 };
    });
    await devices.request('/agent/pair', JSON_POST({ code: 'K7P29QXM', name: 'Mac' }));
    expect(release).toHaveBeenCalledWith(true);
  });
});

describe('requireDevice', () => {
  const guarded = new Hono<import('../src/print/devices.js').DeviceEnv>();
  guarded.get('/agent/ping', requireDevice, (c) => c.json({ deviceId: c.get('deviceId'), userId: c.get('userId') }));

  const ping = (headers: Record<string, string> = {}) => guarded.request('/agent/ping', { headers });

  it.each([
    ['no header', {}],
    ['not a bearer header', { authorization: 'Basic abc' }],
    ['an empty bearer', { authorization: 'Bearer ' }],
  ])('%s -> 401 without a query', async (_l, headers) => {
    const res = await ping(headers);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(query).not.toHaveBeenCalled();
  });

  it('an unknown or revoked token -> 401', async () => {
    const res = await ping({ authorization: 'Bearer some-token' });
    expect(res.status).toBe(401);
    const [lookup] = sqlOf(query, /from print_devices/);
    expect(lookup![1]).toEqual([sha256('some-token')]);
    expect(String(lookup![0])).toMatch(/token_hash = \$1 and revoked_at is null/);
  });

  it('a valid token sets deviceId and userId and bumps last_seen_at at most once a minute', async () => {
    query.mockImplementation(async (sql: string) =>
      /select/.test(sql) ? { rows: [{ id: DEVICE_ID, user_id: 'user-9' }], rowCount: 1 } : { rows: [], rowCount: 1 },
    );
    const res = await ping({ authorization: 'Bearer some-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceId: DEVICE_ID, userId: 'user-9' });
    const [bump] = sqlOf(query, /update print_devices set last_seen_at/);
    expect(String(bump![0])).toMatch(/last_seen_at is null or last_seen_at < now\(\) - interval '1 minute'/);
    expect(bump![1]).toEqual([DEVICE_ID]);
  });

  it('a failing last_seen_at bump does not fail the request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    query.mockImplementation(async (sql: string) => {
      if (/select/.test(sql)) return { rows: [{ id: DEVICE_ID, user_id: 'user-9' }], rowCount: 1 };
      throw new Error('db down');
    });
    const res = await ping({ authorization: 'Bearer some-token' });
    expect(res.status).toBe(200);
  });
});

describe('formatPairCode in the response', () => {
  it('matches the shown format', () => {
    expect(formatPairCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});
