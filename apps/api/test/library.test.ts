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
    AUTOBREW_ENABLED: false,
  },
}));

const { app } = await import('../src/app.js');
const { config } = await import('../src/config.js');
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
    ['GET', '/me/print-devices', undefined],
    ['POST', '/me/print-devices/pair-code', undefined],
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

  const SAVED = {
    paper_layout: 'booklet',
    paper_look: 'zine',
    brew_enabled: false,
    brew_days: [],
    brew_hour: 7,
    brew_timezone: 'UTC',
    brew_budget_minutes: 60,
  };
  const SAVED_JSON = {
    paperLayout: 'booklet',
    paperLook: 'zine',
    brewEnabled: false,
    brewDays: [],
    brewHour: 7,
    brewTimezone: 'UTC',
    brewBudgetMinutes: 60,
  };

  const signedIn = () => {
    vi.spyOn(auth.api, 'getSession').mockResolvedValue({
      user: { id: 'auth-1', email: 'a@example.com' },
      session: {},
    } as never);
    return vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      if (/from users where auth_user_id/.test(sql)) return { rows: [{ id: 'user-1' }] };
      if (/from users u join inbound_addresses/.test(sql)) {
        return { rows: [{ token: 'amber-otter', email: 'a@example.com', paper_layout: 'booklet', paper_look: 'zine' }] };
      }
      if (/^\s*update users set/.test(sql)) return { rows: [SAVED], rowCount: 1 };
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

  it('GET /me returns paperLook', async () => {
    signedIn();
    const res = await app.request('/me', { headers: { cookie: 'better-auth.session_token=x' } });
    expect((await res.json()).paperLook).toBe('zine');
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

  it('GET /me returns macAppUrl from MAC_APP_URL, or null', async () => {
    signedIn();
    const off = await app.request('/me', { headers: { cookie: 'better-auth.session_token=x' } });
    expect((await off.json()).macAppUrl).toBeNull();

    (config as { MAC_APP_URL?: string }).MAC_APP_URL = 'https://example.com/Paperbrew.dmg';
    try {
      const on = await app.request('/me', { headers: { cookie: 'better-auth.session_token=x' } });
      expect((await on.json()).macAppUrl).toBe('https://example.com/Paperbrew.dmg');
    } finally {
      delete (config as { MAC_APP_URL?: string }).MAC_APP_URL;
    }
  });

  it('GET /me returns scheduleAvailable from AUTOBREW_ENABLED', async () => {
    signedIn();
    const off = await app.request('/me', { headers: { cookie: 'better-auth.session_token=x' } });
    expect((await off.json()).scheduleAvailable).toBe(false);

    (config as { AUTOBREW_ENABLED: boolean }).AUTOBREW_ENABLED = true;
    try {
      const on = await app.request('/me', { headers: { cookie: 'better-auth.session_token=x' } });
      expect((await on.json()).scheduleAvailable).toBe(true);
    } finally {
      (config as { AUTOBREW_ENABLED: boolean }).AUTOBREW_ENABLED = false;
    }
  });

  it('PUT /me/settings saves the layout', async () => {
    const query = signedIn();
    const res = await put({ paperLayout: 'booklet' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAVED_JSON);
    const updates = query.mock.calls.filter(([sql]) => /update users set paper_layout = \$1 where id = \$2 returning/.test(String(sql)));
    expect(updates).toHaveLength(1);
    expect(updates[0]![1]).toEqual(['booklet', 'user-1']);
  });

  it('PUT /me/settings saves the look', async () => {
    const query = signedIn();
    const res = await put({ paperLook: 'zine' });
    expect(res.status).toBe(200);
    expect((await res.json()).paperLook).toBe('zine');
    const updates = query.mock.calls.filter(([sql]) => /update users set paper_look = \$1 where id = \$2 returning/.test(String(sql)));
    expect(updates).toHaveLength(1);
    expect(updates[0]![1]).toEqual(['zine', 'user-1']);
  });

  it('PUT /me/settings updates only the given columns, with parameters', async () => {
    const query = signedIn();
    const res = await put({
      brewEnabled: true,
      brewDays: [5, 1, 3],
      brewHour: 18,
      brewTimezone: 'Asia/Jerusalem',
      brewBudgetMinutes: 45,
    });
    expect(res.status).toBe(200);
    const [update] = query.mock.calls.filter(([sql]) => /^\s*update users set/.test(String(sql)));
    const sql = String(update![0]);
    expect(sql).toContain('brew_enabled = $1');
    expect(sql).toContain('brew_days = $2');
    expect(sql).toContain('brew_hour = $3');
    expect(sql).toContain('brew_timezone = $4');
    expect(sql).toContain('brew_budget_minutes = $5');
    expect(sql).toContain('where id = $6');
    expect(sql).not.toContain('paper_layout =');
    expect(sql).not.toContain('paper_look =');
    expect(sql).not.toContain('Jerusalem');
    expect(update![1]).toEqual([true, [1, 3, 5], 18, 'Asia/Jerusalem', 45, 'user-1']);
  });

  it('PUT /me/settings with a single schedule key sets just that column', async () => {
    const query = signedIn();
    expect((await put({ brewHour: 0 })).status).toBe(200);
    const [update] = query.mock.calls.filter(([sql]) => /^\s*update users set/.test(String(sql)));
    expect(String(update![0])).toMatch(/set brew_hour = \$1 where id = \$2/);
    expect(update![1]).toEqual([0, 'user-1']);
  });

  it.each([
    {},
    null,
    { foo: 1 },
    { paperLayout: 'a5' },
    { paperLook: 'x' },
    { paperLook: 1 },
    { brewTimezone: 'Mars/Base' },
    { brewTimezone: '' },
    { brewBudgetMinutes: 50 },
    { brewHour: 24 },
    { brewHour: -1 },
    { brewHour: 7.5 },
    { brewDays: [7] },
    { brewDays: [1, 1] },
    { brewDays: [1.5] },
    { brewDays: [0, 1, 2, 3, 4, 5, 6, 0] },
    { brewEnabled: 'yes' },
  ])('PUT /me/settings rejects %j', async (body) => {
    const query = signedIn();
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(query.mock.calls.filter(([sql]) => /update users/.test(String(sql)))).toHaveLength(0);
  });

  it('PUT /me/settings accepts an empty day list', async () => {
    const query = signedIn();
    expect((await put({ brewDays: [] })).status).toBe(200);
    const [update] = query.mock.calls.filter(([sql]) => /^\s*update users set/.test(String(sql)));
    expect(update![1]).toEqual([[], 'user-1']);
  });
});

describe('GET /me/schedule', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const cookie = { cookie: 'better-auth.session_token=x' };
  const row = (over: Record<string, unknown> = {}) => ({
    brew_enabled: true,
    brew_days: [0],
    brew_hour: 7,
    brew_timezone: 'UTC',
    brew_budget_minutes: 90,
    ...over,
  });

  const signedIn = (userRow: unknown) => {
    vi.spyOn(auth.api, 'getSession').mockResolvedValue({
      user: { id: 'auth-1', email: 'a@example.com' },
      session: {},
    } as never);
    return vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      if (/from users where auth_user_id/.test(sql)) return { rows: [{ id: 'user-1' }] };
      if (/brew_enabled/.test(sql)) return { rows: [userRow] };
      return { rows: [] };
    }) as never);
  };

  it('returns the schedule with nextBrewAt as an ISO string', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T12:00:00Z')); // a Monday
    const query = signedIn(row());
    const res = await app.request('/me/schedule', { headers: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      days: [0],
      hour: 7,
      timezone: 'UTC',
      budgetMinutes: 90,
      nextBrewAt: '2026-11-29T07:00:00.000Z',
      brewDue: false,
    });
    const select = query.mock.calls.find(([sql]) => /brew_enabled/.test(String(sql)))!;
    expect(select[1]).toEqual(['user-1']);
  });

  it('nextBrewAt is null when disabled', async () => {
    signedIn(row({ brew_enabled: false }));
    const body = await (await app.request('/me/schedule', { headers: cookie })).json();
    expect(body.enabled).toBe(false);
    expect(body.nextBrewAt).toBeNull();
  });

  describe('brewDue', () => {
    // Monday 2026-11-23 08:30 UTC; the Monday 07:00 UTC slot is open.
    const monday = row({ brew_days: [1], last_brew_at: null });

    it('is true when the slot is open and not yet brewed, while nextBrewAt stays next week', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-23T08:30:00Z'));
      signedIn(monday);
      const body = await (await app.request('/me/schedule', { headers: cookie })).json();
      expect(body.brewDue).toBe(true);
      expect(body.nextBrewAt).toBe('2026-11-30T07:00:00.000Z');
    });

    it('is false once this slot was brewed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-23T08:30:00Z'));
      signedIn({ ...monday, last_brew_at: new Date('2026-11-23T07:10:00Z') });
      const body = await (await app.request('/me/schedule', { headers: cookie })).json();
      expect(body.brewDue).toBe(false);
    });

    it('is false when the slot is older than the window', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-23T14:00:00Z'));
      signedIn(monday);
      const body = await (await app.request('/me/schedule', { headers: cookie })).json();
      expect(body.brewDue).toBe(false);
    });

    it('is false when the schedule is disabled', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-23T08:30:00Z'));
      signedIn({ ...monday, brew_enabled: false });
      const body = await (await app.request('/me/schedule', { headers: cookie })).json();
      expect(body.brewDue).toBe(false);
      expect(body.nextBrewAt).toBeNull();
    });

    it('selects last_brew_at', async () => {
      const query = signedIn(monday);
      await app.request('/me/schedule', { headers: cookie });
      const select = query.mock.calls.find(([sql]) => /brew_enabled/.test(String(sql)))!;
      expect(String(select[0])).toContain('last_brew_at');
    });
  });

  it('nextBrewAt is null when no days are chosen', async () => {
    signedIn(row({ brew_days: [] }));
    const body = await (await app.request('/me/schedule', { headers: cookie })).json();
    expect(body.nextBrewAt).toBeNull();
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
      { id: A, title: 'T', site_name: 's', source_url: 'https://x.test', status: 'ready', word_count: 10, created_at: new Date('2026-11-01T00:00:00Z'), archived_at: archivedAt, archive_reason: 'skipped' },
      { id: B, title: 'U', site_name: 's', source_url: 'https://y.test', status: 'ready', word_count: 10, created_at: new Date('2026-11-01T00:00:00Z'), archived_at: archivedAt },
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
    expect(sql).toContain('archive_reason');
    expect(articles[0].archiveReason).toBe('skipped');
    expect(articles[1].archiveReason).toBeNull();
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
    expect(String(update[0]).replace(/\s+/g, ' ')).toContain('rollover_count = 0, archive_reason = null');
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

describe('deleting articles and blocking senders', () => {
  afterEach(() => vi.restoreAllMocks());

  const A = '11111111-1111-4111-8111-111111111111';
  const cookie = { cookie: 'better-auth.session_token=x' };
  const ROW = { id: A, title: 'T', site_name: 's', source_url: 'https://x.test', status: 'ready', word_count: 10, created_at: new Date('2026-11-01T00:00:00Z') };

  /** `sender` is what the gmail_messages lookup returns (undefined: not a Gmail article). */
  const signedIn = (sender?: string) => {
    vi.spyOn(auth.api, 'getSession').mockResolvedValue({
      user: { id: 'auth-1', email: 'a@example.com' },
      session: {},
    } as never);
    return vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      if (/from users where auth_user_id/.test(sql)) return { rows: [{ id: 'user-1' }] };
      if (/gmail_messages/.test(sql) && /^\s*select/i.test(sql)) {
        return { rows: sender === undefined ? [] : [{ from_email: sender }] };
      }
      if (/delete from articles/.test(sql)) return { rows: [], rowCount: 1 };
      if (/from articles/.test(sql)) return { rows: [{ ...ROW, added_via: 'gmail' }] };
      return { rows: [], rowCount: 0 };
    }) as never);
  };

  const blocks = (query: ReturnType<typeof signedIn>) =>
    query.mock.calls.filter(([sql]) => /insert into gmail_blocked_senders/.test(String(sql)));

  const del = (qs = '') => app.request(`/articles/${A}${qs}`, { method: 'DELETE', headers: cookie });

  it('GET /articles rows include addedVia', async () => {
    signedIn();
    const res = await app.request('/articles', { headers: cookie });
    expect((await res.json()).articles[0].addedVia).toBe('gmail');
  });

  it('GET /articles?archived=1 rows include addedVia', async () => {
    signedIn();
    const res = await app.request('/articles?archived=1', { headers: cookie });
    expect((await res.json()).articles[0].addedVia).toBe('gmail');
  });

  it('blockSender=1 on a Gmail article blocks the bare, lowercased sender before deleting', async () => {
    const query = signedIn('Some Letter <News@Example.COM>');
    const res = await del('?blockSender=1');
    expect(res.status).toBe(204);
    const [block] = blocks(query);
    expect(block![1]).toEqual(['user-1', 'news@example.com']);
    expect(String(block![0])).toMatch(/on conflict do nothing/i);
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    const at = (re: RegExp) => sqls.findIndex((s) => re.test(s));
    expect(at(/insert into gmail_blocked_senders/)).toBeLessThan(at(/delete from articles/));
    const lookup = query.mock.calls.find(([sql]) => /gmail_messages/.test(String(sql)) && /^\s*select/i.test(String(sql)))!;
    expect(String(lookup[0])).toContain("added_via = 'gmail'");
    expect(lookup[1]).toEqual([A, 'user-1']);
  });

  it('blockSender=1 on a non-Gmail article blocks nothing but still deletes', async () => {
    const query = signedIn(undefined);
    const res = await del('?blockSender=1');
    expect(res.status).toBe(204);
    expect(blocks(query)).toHaveLength(0);
    expect(query.mock.calls.some(([sql]) => /delete from articles/.test(String(sql)))).toBe(true);
  });

  it('without the flag nothing is blocked', async () => {
    const query = signedIn('news@example.com');
    const res = await del();
    expect(res.status).toBe(204);
    expect(blocks(query)).toHaveLength(0);
  });
});

describe('onboarding', () => {
  afterEach(() => vi.restoreAllMocks());

  const cookie = { cookie: 'better-auth.session_token=x' };
  const BARE = {
    token: 'amber-otter',
    email: 'a@example.com',
    paper_layout: 'flat',
    paper_look: 'broadsheet',
    onboarded: false,
    has_articles: false,
    has_gmail: false,
    has_device: false,
    brew_enabled: false,
  };

  const signedIn = (me: Record<string, unknown>) => {
    vi.spyOn(auth.api, 'getSession').mockResolvedValue({
      user: { id: 'auth-1', email: 'a@example.com' },
      session: {},
    } as never);
    return vi.spyOn(pool, 'query').mockImplementation((async (sql: string) => {
      if (/from users where auth_user_id/.test(sql)) return { rows: [{ id: 'user-1' }] };
      if (/from users u join inbound_addresses/.test(sql)) return { rows: [{ ...BARE, ...me }] };
      if (/^\s*update users set onboarded_at/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    }) as never);
  };

  const me = async () => (await app.request('/me', { headers: cookie })).json();

  it('GET /me needs onboarding for a bare user', async () => {
    signedIn({});
    expect((await me()).needsOnboarding).toBe(true);
  });

  it.each([
    ['has finished onboarding', { onboarded: true }],
    ['has saved articles', { has_articles: true }],
    ['has a Gmail connection', { has_gmail: true }],
    ['has a paired printer', { has_device: true }],
    ['has brewing switched on', { brew_enabled: true }],
  ])('GET /me does not need onboarding when the user %s', async (_name, over) => {
    signedIn(over);
    expect((await me()).needsOnboarding).toBe(false);
  });

  it('GET /me checks the conditions in the same query and ignores revoked devices', async () => {
    const query = signedIn({});
    await me();
    const [call] = query.mock.calls.filter(([sql]) => /from users u join inbound_addresses/.test(String(sql)));
    const sql = String(call![0]);
    expect(sql).toMatch(/onboarded_at/);
    expect(sql).toMatch(/from articles/);
    expect(sql).toMatch(/from gmail_connections/);
    expect(sql).toMatch(/from print_devices[^)]*revoked_at is null/);
    expect(sql).toMatch(/brew_enabled/);
  });

  it('POST /me/onboarding/complete answers 204 and keeps the first completion time', async () => {
    const query = signedIn({});
    const res = await app.request('/me/onboarding/complete', { method: 'POST', headers: cookie });
    expect(res.status).toBe(204);
    const updates = query.mock.calls.filter(([sql]) => /^\s*update users set onboarded_at/.test(String(sql)));
    expect(updates).toHaveLength(1);
    expect(String(updates[0]![0])).toMatch(/onboarded_at = coalesce\(onboarded_at, now\(\)\)/);
    expect(updates[0]![1]).toEqual(['user-1']);
  });

  it('POST /me/onboarding/complete without a session is 401', async () => {
    const res = await app.request('/me/onboarding/complete', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
