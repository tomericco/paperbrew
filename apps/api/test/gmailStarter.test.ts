import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailAuthError } from '../src/gmail/client.js';
import { encryptToken } from '../src/gmail/crypto.js';
import { paragraphs } from './helpers.js';

// fetchStarterArticles runs without Gmail, a database or the model, in the same style as gmailSync.test.ts:
// the Gmail client and classifier are fakes, the pool records its queries, extraction is a fixed answer.
const poolQuery = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();
const extractNewsletter = vi.fn();

const KEY = Buffer.alloc(32, 9).toString('base64');
const config: { GMAIL_TOKEN_KEY?: string } = { GMAIL_TOKEN_KEY: KEY };

vi.mock('../src/config.js', () => ({ config }));
vi.mock('../src/db/client.js', () => ({
  pool: { query: poolQuery, connect: async () => ({ query: clientQuery, release }) },
}));
vi.mock('../src/extract/readable.js', () => ({ extractNewsletter }));

const { fetchStarterArticles, STARTER_QUERY, STARTER_MAX_SCAN, STARTER_TARGET } = await import('../src/gmail/starter.js');

const ARTICLE = {
  title: 'Weekly Digest', author: 'Jane Doe', siteName: 'Digest', excerpt: 'ex', contentHtml: '<p>x</p>',
  textContent: 'x', wordCount: 300, readingMinutes: 2,
};
const LONG_HTML = paragraphs(12).map((p) => `<p>${p}</p>`).join('');
const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const headersFor = (id: string) =>
  Object.entries({
    From: 'Jane Doe <jane@news.example>',
    Subject: `Issue ${id}`,
    'List-Unsubscribe': '<mailto:u@news.example>',
    'Message-ID': `<${id}@news.example>`,
  }).map(([name, value]) => ({ name, value }));

function fakeGmail(ids: string[], overrides: Record<string, unknown> = {}) {
  return {
    refreshAccessToken: vi.fn(async () => 'access-1'),
    listMessages: vi.fn(async () => ids),
    getMessage: vi.fn(async (_t: string, id: string, format: 'metadata' | 'full') =>
      format === 'metadata'
        ? { id, payload: { mimeType: 'text/html', headers: headersFor(id) } }
        : { id, payload: { mimeType: 'text/html', headers: headersFor(id), body: { data: enc(LONG_HTML) } } }),
    ...overrides,
  } as unknown as typeof import('../src/gmail/client.js');
}

/** Editorial when the subject names one of `editorialIds`. */
const classifyFor = (editorialIds: string[]) =>
  vi.fn(async ({ subject }: { subject: string }) =>
    editorialIds.some((id) => subject === `Issue ${id}`)
      ? { editorial: true, reason: 'editorial 0.9' }
      : { editorial: false, reason: 'promo 0.8' });

const sqlOf = (call: unknown[]) => String(call[0]).replace(/\s+/g, ' ').trim();
const poolCalls = (re: RegExp) => poolQuery.mock.calls.filter((c) => re.test(sqlOf(c)));
const doneUpdates = () => poolCalls(/set starter_done_at/);
const articleInserts = () => clientQuery.mock.calls.filter((c) => /insert into articles/.test(sqlOf(c)));

let seenIds: string[];
let connection: { refresh_token_enc: string; starter_done_at: Date | null } | undefined;

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  for (const m of [poolQuery, clientQuery, release, extractNewsletter]) m.mockClear();
  config.GMAIL_TOKEN_KEY = KEY;
  seenIds = [];
  connection = { refresh_token_enc: encryptToken('refresh-secret', KEY), starter_done_at: null };
  poolQuery.mockImplementation(async (sql: string) => {
    if (/from gmail_connections/.test(sql)) return { rows: connection ? [connection] : [] };
    if (/from gmail_messages/.test(sql)) return { rows: seenIds.map((gmail_message_id) => ({ gmail_message_id })) };
    if (/from gmail_blocked_senders/.test(sql)) return { rows: [] };
    if (/from inbound_emails|from articles/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 1 };
  });
  clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  extractNewsletter.mockReturnValue(ARTICLE);
});

describe('constants', () => {
  it('scans the last 30 days, up to 40 messages, for 3 articles', () => {
    expect(STARTER_QUERY).toBe('newer_than:30d -in:sent -in:chats -in:drafts');
    expect(STARTER_MAX_SCAN).toBe(40);
    expect(STARTER_TARGET).toBe(3);
  });
});

describe('fetchStarterArticles', () => {
  it('stops at 3 saved when 5 of 8 are editorial, and records starter_done_at', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
    const gmail = fakeGmail(ids);
    const classify = classifyFor(['m2', 'm3', 'm5', 'm6', 'm8']);

    await expect(fetchStarterArticles('user-1', { gmail, classify })).resolves.toEqual({ scanned: 5, saved: 3 });

    expect(gmail.refreshAccessToken).toHaveBeenCalledWith('refresh-secret');
    expect(gmail.listMessages).toHaveBeenCalledWith('access-1', STARTER_QUERY, STARTER_MAX_SCAN);
    expect(articleInserts()).toHaveLength(3);
    expect(gmail.getMessage).not.toHaveBeenCalledWith('access-1', 'm6', expect.anything());
    expect(doneUpdates()).toHaveLength(1);
    expect(doneUpdates()[0][1]).toEqual(['user-1', connection!.refresh_token_enc]);
  });

  it('finds nothing: saved 0, starter_done_at still recorded', async () => {
    const gmail = fakeGmail(['m1', 'm2']);
    await expect(fetchStarterArticles('user-1', { gmail, classify: classifyFor([]) })).resolves.toEqual({
      scanned: 2,
      saved: 0,
    });
    expect(articleInserts()).toHaveLength(0);
    expect(doneUpdates()).toHaveLength(1);
  });

  it('an empty inbox still records starter_done_at', async () => {
    const gmail = fakeGmail([]);
    await expect(fetchStarterArticles('user-1', { gmail, classify: classifyFor([]) })).resolves.toEqual({
      scanned: 0,
      saved: 0,
    });
    expect(doneUpdates()).toHaveLength(1);
  });

  it('skips ids already in gmail_messages', async () => {
    seenIds = ['m1'];
    const gmail = fakeGmail(['m1', 'm2']);
    await expect(fetchStarterArticles('user-1', { gmail, classify: classifyFor(['m1', 'm2']) })).resolves.toEqual({
      scanned: 1,
      saved: 1,
    });
    const [sql, params] = poolCalls(/from gmail_messages/)[0];
    expect(String(sql).replace(/\s+/g, ' ')).toContain('where user_id = $1 and gmail_message_id = any($2)');
    expect(params).toEqual(['user-1', ['m1', 'm2']]);
    expect(gmail.getMessage).not.toHaveBeenCalledWith('access-1', 'm1', expect.anything());
  });

  it('does nothing, without calling Gmail, when starter_done_at is already set', async () => {
    connection!.starter_done_at = new Date('2026-11-20T10:00:00Z');
    const gmail = fakeGmail(['m1']);
    await expect(fetchStarterArticles('user-1', { gmail })).resolves.toEqual({ scanned: 0, saved: 0 });
    expect(gmail.refreshAccessToken).not.toHaveBeenCalled();
    expect(gmail.listMessages).not.toHaveBeenCalled();
    expect(doneUpdates()).toHaveLength(0);
  });

  it('does nothing when the user has no connection', async () => {
    connection = undefined;
    const gmail = fakeGmail(['m1']);
    await expect(fetchStarterArticles('user-1', { gmail })).resolves.toEqual({ scanned: 0, saved: 0 });
    expect(gmail.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('a GmailAuthError flags the connection like syncGmail, records starter_done_at and resolves', async () => {
    const gmail = fakeGmail(['m1'], {
      refreshAccessToken: vi.fn(async () => {
        throw new GmailAuthError('Google rejected the grant');
      }),
    });
    await expect(fetchStarterArticles('user-1', { gmail })).resolves.toEqual({ scanned: 0, saved: 0 });

    const [sql, params] = poolCalls(/set status = 'needs_reconnect'/)[0];
    expect(String(sql).replace(/\s+/g, ' ')).toContain('last_error = $2 where user_id = $1 and refresh_token_enc = $3');
    expect(params).toEqual(['user-1', 'Google rejected the grant', connection!.refresh_token_enc]);
    expect(gmail.listMessages).not.toHaveBeenCalled();
    // Done, so the welcome page stops waiting; reconnecting does not run it again.
    expect(doneUpdates()).toHaveLength(1);
  });

  it('a GmailAuthError mid-job keeps what was saved and resolves', async () => {
    const getMessage = vi.fn(async (_t: string, id: string, format: 'metadata' | 'full') => {
      if (id === 'm2') throw new GmailAuthError();
      return format === 'metadata'
        ? { id, payload: { mimeType: 'text/html', headers: headersFor(id) } }
        : { id, payload: { mimeType: 'text/html', headers: headersFor(id), body: { data: enc(LONG_HTML) } } };
    });
    const gmail = fakeGmail(['m1', 'm2', 'm3'], { getMessage });
    await expect(
      fetchStarterArticles('user-1', { gmail, classify: classifyFor(['m1', 'm3']) }),
    ).resolves.toEqual({ scanned: 2, saved: 1 });
    expect(poolCalls(/needs_reconnect/)).toHaveLength(1);
    expect(getMessage).not.toHaveBeenCalledWith('access-1', 'm3', expect.anything());
  });

  it('rethrows other errors so the runner retries, without recording starter_done_at', async () => {
    const gmail = fakeGmail([], {
      listMessages: vi.fn(async () => {
        throw new Error('Gmail list request returned 500');
      }),
    });
    await expect(fetchStarterArticles('user-1', { gmail })).rejects.toThrow('returned 500');
    expect(doneUpdates()).toHaveLength(0);
    expect(poolCalls(/needs_reconnect/)).toHaveLength(0);
  });

  it('on the last attempt, records starter_done_at before rethrowing so the page stops waiting', async () => {
    const gmail = fakeGmail([], {
      listMessages: vi.fn(async () => {
        throw new Error('Gmail list request returned 500');
      }),
    });
    await expect(fetchStarterArticles('user-1', { gmail, lastAttempt: true })).rejects.toThrow('returned 500');
    expect(doneUpdates()).toHaveLength(1);
  });

  it('on the last attempt, a token that cannot be decrypted still records starter_done_at before throwing', async () => {
    connection!.refresh_token_enc = 'not-a-valid-token';
    const gmail = fakeGmail([]);
    await expect(fetchStarterArticles('user-1', { gmail, lastAttempt: true })).rejects.toThrow();
    expect(gmail.refreshAccessToken).not.toHaveBeenCalled();
    expect(doneUpdates()).toHaveLength(1);
  });

  it('on an earlier attempt, a token that cannot be decrypted throws without recording starter_done_at', async () => {
    connection!.refresh_token_enc = 'not-a-valid-token';
    await expect(fetchStarterArticles('user-1', { gmail: fakeGmail([]) })).rejects.toThrow();
    expect(doneUpdates()).toHaveLength(0);
  });

  it('on the last attempt, skips a message that keeps failing and carries on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getMessage = vi.fn(async (_t: string, id: string, format: 'metadata' | 'full') => {
      if (id === 'm1') throw new Error('Gmail message request returned 500');
      return format === 'metadata'
        ? { id, payload: { mimeType: 'text/html', headers: headersFor(id) } }
        : { id, payload: { mimeType: 'text/html', headers: headersFor(id), body: { data: enc(LONG_HTML) } } };
    });
    const gmail = fakeGmail(['m1', 'm2'], { getMessage });
    await expect(
      fetchStarterArticles('user-1', { gmail, classify: classifyFor(['m2']), lastAttempt: true }),
    ).resolves.toEqual({ scanned: 2, saved: 1 });
    const errorSkip = poolCalls(/insert into gmail_messages/).find((c) => (c[1] as unknown[]).includes('error'));
    expect(errorSkip?.[1]).toEqual(['user-1', 'm1', 'rule_skip', 'error', null, null]);
    expect(doneUpdates()).toHaveLength(1);
  });

  it('throws a clear error, without secrets, when GMAIL_TOKEN_KEY is unset', async () => {
    config.GMAIL_TOKEN_KEY = undefined;
    const err = await fetchStarterArticles('user-1', { gmail: fakeGmail([]) }).catch((e) => e as Error);
    expect((err as Error).message).toMatch(/GMAIL_TOKEN_KEY/);
    expect((err as Error).message).not.toContain('refresh-secret');
  });
});
