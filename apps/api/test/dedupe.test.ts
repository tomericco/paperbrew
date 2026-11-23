import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findDuplicateNewsletter } from '../src/inbound/dedupe.js';

const query = vi.fn();
const db = { query } as unknown as Parameters<typeof findDuplicateNewsletter>[0];
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** Make the first query matching `re` return a row (a hit); everything else returns none. */
function hitOn(re: RegExp) {
  query.mockImplementation(async (sql: string) => (re.test(sql) ? { rows: [{ one: 1 }] } : { rows: [] }));
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('findDuplicateNewsletter by Message-ID', () => {
  it('matches a Message-ID already stored as an inbound email or an article (gmail path)', async () => {
    hitOn(/message_id/);
    await expect(findDuplicateNewsletter(db, 'user-1', { messageId: '<a@x>', title: 'T' }, 'gmail')).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(squash(sql)).toContain('from inbound_emails where user_id = $1 and message_id = $2');
    expect(squash(sql)).toContain('from articles where user_id = $1 and message_id = $2');
    expect(params).toEqual(['user-1', '<a@x>']);
  });

  it('does not count the email being processed against itself (email path checks articles only)', async () => {
    hitOn(/message_id/);
    await expect(findDuplicateNewsletter(db, 'user-1', { messageId: '<a@x>', title: 'T' }, 'email')).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/inbound_emails/);
    expect(squash(sql)).toContain('from articles where user_id = $1 and message_id = $2');
    expect(params).toEqual(['user-1', '<a@x>']);
  });

  it('skips the Message-ID check when there is none', async () => {
    await expect(findDuplicateNewsletter(db, 'user-1', { messageId: null, title: 'T' }, 'gmail')).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toMatch(/message_id/);
  });
});

describe('findDuplicateNewsletter by title', () => {
  it('matches the same title saved by the other path in the last 3 days (gmail saving)', async () => {
    hitOn(/lower\(title\)/);
    await expect(findDuplicateNewsletter(db, 'user-1', { messageId: null, title: 'Weekly Digest' }, 'gmail')).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0];
    const s = squash(sql);
    expect(s).toContain('lower(title) = lower($2)');
    expect(s).toContain("created_at > now() - interval '3 days'");
    expect(s).toContain("added_via <> 'gmail'");
    expect(params).toEqual(['user-1', 'Weekly Digest']);
  });

  it('looks for a Gmail article when the email path is saving', async () => {
    hitOn(/lower\(title\)/);
    await expect(findDuplicateNewsletter(db, 'user-1', { messageId: null, title: 'Weekly Digest' }, 'email')).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(squash(sql)).toContain("added_via = 'gmail'");
    expect(squash(sql)).not.toContain('<>');
    expect(params).toEqual(['user-1', 'Weekly Digest']);
  });

  it('is false when no article is that recent (the window is 3 days, not longer)', async () => {
    // The database applies the window, so "4 days old" arrives here as no rows.
    await expect(findDuplicateNewsletter(db, 'user-1', { messageId: '<a@x>', title: 'Weekly Digest' }, 'gmail')).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    const titleSql = squash(query.mock.calls[1][0]);
    expect(titleSql).toContain("interval '3 days'");
    expect(titleSql).not.toMatch(/4 days|7 days/);
  });

  it('ignores a blank title', async () => {
    await expect(findDuplicateNewsletter(db, 'user-1', { messageId: null, title: '  ' }, 'gmail')).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('stops at the Message-ID hit without running the title query', async () => {
    hitOn(/message_id/);
    await findDuplicateNewsletter(db, 'user-1', { messageId: '<a@x>', title: 'T' }, 'gmail');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
