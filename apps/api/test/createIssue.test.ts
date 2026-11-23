import { beforeEach, describe, expect, it, vi } from 'vitest';

// createIssue runs without a database: the pool hands out a client that records its queries
// and answers the user lock and the candidate load from fixtures.
const clientQuery = vi.fn();
const release = vi.fn();

vi.mock('../src/config.js', () => ({ config: {} }));
vi.mock('../src/db/client.js', () => ({
  pool: { connect: async () => ({ query: clientQuery, release }) },
}));

const { createIssue } = await import('../src/schedule/createIssue.js');

// Monday 2026-11-23 08:30 UTC; the slot is Monday 07:00 UTC.
const NOW = new Date('2026-11-23T08:30:00Z');
const USER = {
  brew_enabled: true,
  brew_days: [1],
  brew_hour: 7,
  brew_timezone: 'UTC',
  brew_budget_minutes: 60,
  paper_layout: 'booklet',
  last_brew_at: null as Date | null,
};

let user: typeof USER | undefined;
let candidates: { id: string; reading_minutes: number | null; rollover_count: number }[];
let hasDevice: boolean;

const sqlOf = (call: unknown[]) => String(call[0]).replace(/\s+/g, ' ').trim();
const calls = (re: RegExp) => clientQuery.mock.calls.filter((c) => re.test(sqlOf(c)));

beforeEach(() => {
  clientQuery.mockReset();
  release.mockReset();
  user = { ...USER };
  candidates = [];
  hasDevice = true;
  clientQuery.mockImplementation(async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ');
    if (/from users where id = \$1 for update/.test(s)) return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
    if (/from print_devices/.test(s)) return { rows: [{ has_device: hasDevice }], rowCount: 1 };
    if (/from articles a/.test(s)) return { rows: candidates, rowCount: candidates.length };
    if (/insert into issues/.test(s)) return { rows: [{ id: 'issue-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

const three = () => [
  { id: 'a1', reading_minutes: 10, rollover_count: 0 },
  { id: 'a2', reading_minutes: 10, rollover_count: 0 },
  { id: 'a3', reading_minutes: 10, rollover_count: 0 },
];

describe('createIssue', () => {
  it('a due user with 3 candidates gets one issue with the articles in order and their layout', async () => {
    candidates = three();
    expect(await createIssue('u1', NOW)).toEqual({ issueId: 'issue-1' });

    const ins = calls(/insert into issues/);
    expect(ins).toHaveLength(1);
    expect(ins[0][1]).toEqual(['u1', 'booklet', ['a1', 'a2', 'a3']]);
    expect(calls(/update users set last_brew_at/)[0][1]).toEqual([NOW, 'u1']);
    expect(sqlOf(clientQuery.mock.calls[0])).toBe('begin');
    expect(sqlOf(clientQuery.mock.calls.at(-1)!)).toBe('commit');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('second run in the same slot creates nothing', async () => {
    candidates = three();
    user!.last_brew_at = new Date('2026-11-23T07:05:00Z');
    expect(await createIssue('u1', NOW)).toEqual({ issueId: null });
    expect(calls(/insert into issues/)).toHaveLength(0);
    expect(calls(/from articles a/)).toHaveLength(0);
    expect(calls(/update users set last_brew_at/)).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a due user with no active print device gets nothing: no issue, no article change, last_brew_at kept, committed', async () => {
    candidates = three();
    hasDevice = false;
    expect(await createIssue('u1', NOW)).toEqual({ issueId: null });

    const check = calls(/from print_devices/);
    expect(check).toHaveLength(1);
    expect(sqlOf(check[0])).toContain('d.user_id = $1');
    expect(sqlOf(check[0])).toContain('d.revoked_at is null');
    expect(check[0][1]).toEqual(['u1']);
    expect(calls(/from articles a/)).toHaveLength(0);
    expect(calls(/insert into issues/)).toHaveLength(0);
    expect(calls(/update articles/)).toHaveLength(0);
    expect(calls(/update users set last_brew_at/)).toHaveLength(0);
    expect(sqlOf(clientQuery.mock.calls.at(-1)!)).toBe('commit');
    expect(calls(/^rollback$/)).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not look for a device when no brew is due', async () => {
    user!.last_brew_at = new Date('2026-11-23T07:05:00Z');
    await createIssue('u1', NOW);
    expect(calls(/from print_devices/)).toHaveLength(0);
  });

  it('a disabled user gets nothing', async () => {
    candidates = three();
    user!.brew_enabled = false;
    expect(await createIssue('u1', NOW)).toEqual({ issueId: null });
    expect(calls(/insert into issues/)).toHaveLength(0);
    expect(calls(/update users set last_brew_at/)).toHaveLength(0);
  });

  it('a missing user gets nothing', async () => {
    user = undefined;
    expect(await createIssue('u1', NOW)).toEqual({ issueId: null });
    expect(calls(/insert into issues/)).toHaveLength(0);
  });

  it('with no candidates creates no issue but still sets last_brew_at', async () => {
    expect(await createIssue('u1', NOW)).toEqual({ issueId: null });
    expect(calls(/insert into issues/)).toHaveLength(0);
    expect(calls(/rollover_count = rollover_count \+ 1/)).toHaveLength(0);
    expect(calls(/update users set last_brew_at/)[0][1]).toEqual([NOW, 'u1']);
    expect(sqlOf(clientQuery.mock.calls.at(-1)!)).toBe('commit');
  });

  it('the candidate query takes ready, unarchived articles outside open issues, oldest first', async () => {
    await createIssue('u1', NOW);
    const sql = sqlOf(calls(/from articles a/)[0]);
    expect(sql).toContain("a.status = 'ready'");
    expect(sql).toContain('a.archived_at is null');
    expect(sql).toContain("status in ('queued','printing')");
    expect(sql).toContain('a.id = any(i.article_ids)');
    expect(sql).toContain('order by a.created_at asc');
  });

  it('bumps rollover for left-out articles and archives the ones at the limit, one statement each', async () => {
    // Budget 60: a1 (40) fits, a2 (30) does not -> stop; a2 has rolled once (skipped), a3 and a4 roll over.
    candidates = [
      { id: 'a1', reading_minutes: 40, rollover_count: 0 },
      { id: 'a2', reading_minutes: 30, rollover_count: 1 },
      { id: 'a3', reading_minutes: 5, rollover_count: 0 },
      { id: 'a4', reading_minutes: 5, rollover_count: 0 },
    ];
    await createIssue('u1', NOW);

    expect(calls(/insert into issues/)[0][1]).toEqual(['u1', 'booklet', ['a1']]);
    const bump = calls(/rollover_count = rollover_count \+ 1/);
    expect(bump).toHaveLength(1);
    expect(sqlOf(bump[0])).toContain('id = any($1::uuid[])');
    expect(bump[0][1]).toEqual([['a3', 'a4']]);
    const skip = calls(/archive_reason = 'skipped'/);
    expect(skip).toHaveLength(1);
    expect(sqlOf(skip[0])).toContain('rollover_count = 2');
    expect(sqlOf(skip[0])).toContain('archived_at = now()');
    expect(sqlOf(skip[0])).toContain('id = any($1::uuid[])');
    expect(skip[0][1]).toEqual([['a2']]);
  });

  it('never touches an article archived by hand since the candidates were loaded', async () => {
    candidates = [
      { id: 'a1', reading_minutes: 40, rollover_count: 0 },
      { id: 'a2', reading_minutes: 30, rollover_count: 1 },
      { id: 'a3', reading_minutes: 5, rollover_count: 0 },
    ];
    await createIssue('u1', NOW);
    expect(sqlOf(calls(/rollover_count = rollover_count \+ 1/)[0])).toContain('archived_at is null');
    expect(sqlOf(calls(/archive_reason = 'skipped'/)[0])).toContain('archived_at is null');
  });

  it('skips the rollover statements when nothing is left out', async () => {
    candidates = three();
    await createIssue('u1', NOW);
    expect(calls(/rollover_count = rollover_count \+ 1/)).toHaveLength(0);
    expect(calls(/archive_reason = 'skipped'/)).toHaveLength(0);
  });

  it('rolls back, releases and rethrows when a statement fails', async () => {
    candidates = three();
    clientQuery.mockImplementation(async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/for update/.test(s)) return { rows: [user], rowCount: 1 };
      if (/from print_devices/.test(s)) return { rows: [{ has_device: true }], rowCount: 1 };
      if (/from articles a/.test(s)) return { rows: candidates, rowCount: 3 };
      if (/insert into issues/.test(s)) throw new Error('boom');
      return { rows: [], rowCount: 0 };
    });
    await expect(createIssue('u1', NOW)).rejects.toThrow('boom');
    expect(calls(/^rollback$/)).toHaveLength(1);
    expect(calls(/^commit$/)).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the original error and destroys the client when the rollback itself fails', async () => {
    candidates = three();
    clientQuery.mockImplementation(async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/for update/.test(s)) return { rows: [user], rowCount: 1 };
      if (/from print_devices/.test(s)) return { rows: [{ has_device: true }], rowCount: 1 };
      if (/from articles a/.test(s)) return { rows: candidates, rowCount: 3 };
      if (/insert into issues/.test(s)) throw new Error('boom');
      if (s === 'rollback') throw new Error('connection lost');
      return { rows: [], rowCount: 0 };
    });
    await expect(createIssue('u1', NOW)).rejects.toThrow('boom');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toBeTruthy();
  });

  it('releases the client normally (no error argument) when the rollback works', async () => {
    candidates = three();
    clientQuery.mockImplementation(async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/for update/.test(s)) return { rows: [user], rowCount: 1 };
      if (/from print_devices/.test(s)) return { rows: [{ has_device: true }], rowCount: 1 };
      if (/from articles a/.test(s)) return { rows: candidates, rowCount: 3 };
      if (/insert into issues/.test(s)) throw new Error('boom');
      return { rows: [], rowCount: 0 };
    });
    await expect(createIssue('u1', NOW)).rejects.toThrow('boom');
    expect(release.mock.calls[0]).toEqual([]);
  });
});
