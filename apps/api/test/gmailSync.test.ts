import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailAuthError, HistoryExpiredError } from '../src/gmail/client.js';
import { encryptToken } from '../src/gmail/crypto.js';
import { paragraphs } from './helpers.js';

// syncGmail runs without Gmail, a database or the model: the Gmail client and the classifier are
// fakes, the pool and its transaction client record their queries, and extraction is a fixed answer.
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

const { syncGmail } = await import('../src/gmail/sync.js');

const QUERY = 'newer_than:2d -in:sent -in:chats -in:drafts';
const ARTICLE = {
  title: 'Weekly Digest', author: 'Jane Doe', siteName: 'Digest', excerpt: 'ex', contentHtml: '<p>x</p>',
  textContent: 'x', wordCount: 300, readingMinutes: 2,
};

type Headers = Record<string, string>;
const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function meta(id: string, headers: Headers) {
  return {
    id,
    payload: { mimeType: 'text/html', headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  };
}
function full(id: string, headers: Headers, html: string) {
  return {
    id,
    payload: {
      mimeType: 'text/html',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: { data: enc(html) },
    },
  };
}

const LONG_HTML = paragraphs(12).map((p) => `<p>${p}</p>`).join('');
const LONG_TEXT_START = paragraphs(1)[0].slice(0, 40);
const LIST_HEADERS = {
  From: 'Jane Doe <jane@news.example>',
  Subject: 'Fwd: Weekly Digest',
  'List-Unsubscribe': '<mailto:u@news.example>',
  'Message-ID': ' <m-1@news.example> ',
  Date: 'Mon, 1 Jan 2026 10:00:00 +0000',
};

let blocked: string[];
let seenIds: string[];
let duplicateRows: Record<string, unknown>[];
let finalUpdateRowCount: number;
let connection: { refresh_token_enc: string; history_id: string } | undefined;

function fakeGmail(overrides: Record<string, unknown> = {}) {
  return {
    refreshAccessToken: vi.fn(async () => 'access-1'),
    getProfile: vi.fn(async () => ({ emailAddress: 'me@gmail.com', historyId: '9000' })),
    listHistory: vi.fn(async () => ({ messageIds: ['m1'], historyId: '5000' })),
    listMessages: vi.fn(async () => ['m1']),
    getMessage: vi.fn(async (_t: string, id: string, format: 'metadata' | 'full') =>
      format === 'metadata' ? meta(id, LIST_HEADERS) : full(id, LIST_HEADERS, LONG_HTML)),
    ...overrides,
  } as unknown as typeof import('../src/gmail/client.js');
}

const classifyYes = vi.fn(async () => ({ editorial: true, reason: 'editorial 0.91' }));
const sqlOf = (call: unknown[]) => String(call[0]).replace(/\s+/g, ' ').trim();
const poolCalls = (re: RegExp) => poolQuery.mock.calls.filter((c) => re.test(sqlOf(c)));
const clientCalls = (re: RegExp) => clientQuery.mock.calls.filter((c) => re.test(sqlOf(c)));
const recorded = () =>
  [...poolCalls(/insert into gmail_messages/), ...clientCalls(/insert into gmail_messages/)].map((c) => c[1] as unknown[]);
const historyUpdates = () => poolCalls(/update gmail_connections set history_id/);

beforeEach(() => {
  for (const m of [poolQuery, clientQuery, release, extractNewsletter, classifyYes]) m.mockClear();
  config.GMAIL_TOKEN_KEY = KEY;
  blocked = [];
  seenIds = [];
  duplicateRows = [];
  finalUpdateRowCount = 1;
  connection = { refresh_token_enc: encryptToken('refresh-secret', KEY), history_id: '4000' };
  poolQuery.mockImplementation(async (sql: string) => {
    if (/from gmail_connections/.test(sql)) return { rows: connection ? [connection] : [] };
    if (/from gmail_messages/.test(sql)) return { rows: seenIds.map((gmail_message_id) => ({ gmail_message_id })) };
    if (/from gmail_blocked_senders/.test(sql)) return { rows: blocked.map((email) => ({ email })) };
    if (/from inbound_emails|from articles/.test(sql)) return { rows: duplicateRows };
    if (/update gmail_connections set history_id/.test(sql)) return { rows: [], rowCount: finalUpdateRowCount };
    return { rows: [], rowCount: 1 };
  });
  clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  extractNewsletter.mockReturnValue(ARTICLE);
});

describe('connection and auth', () => {
  it('does nothing when the user has no connection', async () => {
    connection = undefined;
    const gmail = fakeGmail();
    await expect(syncGmail('user-1', { gmail })).resolves.toEqual({ seen: 0, saved: 0 });
    expect(gmail.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('decrypts the stored token and refreshes with it', async () => {
    const gmail = fakeGmail({ listHistory: vi.fn(async () => ({ messageIds: [], historyId: '5000' })) });
    await syncGmail('user-1', { gmail, classify: classifyYes });
    expect(gmail.refreshAccessToken).toHaveBeenCalledWith('refresh-secret');
    expect(gmail.listHistory).toHaveBeenCalledWith('access-1', '4000');
  });

  it('marks needs_reconnect on invalid_grant and resolves', async () => {
    const gmail = fakeGmail({
      refreshAccessToken: vi.fn(async () => {
        throw new GmailAuthError('Google rejected the grant');
      }),
    });
    await expect(syncGmail('user-1', { gmail, classify: classifyYes })).resolves.toEqual({ seen: 0, saved: 0 });
    const [sql, params] = poolCalls(/update gmail_connections set status = 'needs_reconnect'/)[0];
    // Guarded by the token the sync started with: a reconnect during the run is not flagged.
    expect(sql.replace(/\s+/g, ' ')).toContain('last_error = $2 where user_id = $1 and refresh_token_enc = $3');
    expect(params).toEqual(['user-1', 'Google rejected the grant', connection!.refresh_token_enc]);
    expect(gmail.listHistory).not.toHaveBeenCalled();
  });

  it('also handles an auth error raised later in the sync (a 401 from Gmail)', async () => {
    const gmail = fakeGmail({
      listHistory: vi.fn(async () => {
        throw new GmailAuthError();
      }),
    });
    await expect(syncGmail('user-1', { gmail, classify: classifyYes })).resolves.toEqual({ seen: 0, saved: 0 });
    expect(poolCalls(/needs_reconnect/)).toHaveLength(1);
  });

  it('throws a clear error, without secrets, when GMAIL_TOKEN_KEY is unset', async () => {
    config.GMAIL_TOKEN_KEY = undefined;
    const err = await syncGmail('user-1', { gmail: fakeGmail() }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/GMAIL_TOKEN_KEY/);
    expect((err as Error).message).not.toContain('refresh-secret');
  });

  it('rethrows other Gmail errors so the runner retries, without advancing history_id', async () => {
    const gmail = fakeGmail({
      listHistory: vi.fn(async () => {
        throw new Error('Gmail history request returned 500');
      }),
    });
    await expect(syncGmail('user-1', { gmail, classify: classifyYes })).rejects.toThrow('returned 500');
    expect(historyUpdates()).toHaveLength(0);
    expect(poolCalls(/needs_reconnect/)).toHaveLength(0);
  });
});

describe('finding the messages', () => {
  it('falls back to a recent-mail search and the profile historyId when history expired', async () => {
    const gmail = fakeGmail({
      listHistory: vi.fn(async () => {
        throw new HistoryExpiredError();
      }),
      listMessages: vi.fn(async () => []),
    });
    await syncGmail('user-1', { gmail, classify: classifyYes });
    expect(gmail.listMessages).toHaveBeenCalledWith('access-1', QUERY, 200);
    expect(gmail.getProfile).toHaveBeenCalledWith('access-1');
    expect(historyUpdates()[0][1]).toEqual(['user-1', '9000', connection!.refresh_token_enc]);
  });

  it('drops ids already in gmail_messages, scoped to the user', async () => {
    seenIds = ['m1'];
    const gmail = fakeGmail({ listHistory: vi.fn(async () => ({ messageIds: ['m1', 'm2'], historyId: '5000' })) });
    await expect(syncGmail('user-1', { gmail, classify: classifyYes })).resolves.toEqual({ seen: 1, saved: 1 });
    const [sql, params] = poolCalls(/from gmail_messages/)[0];
    expect(sql.replace(/\s+/g, ' ')).toContain('where user_id = $1 and gmail_message_id = any($2)');
    expect(params).toEqual(['user-1', ['m1', 'm2']]);
    expect(gmail.getMessage).not.toHaveBeenCalledWith('access-1', 'm1', expect.anything());
    expect(gmail.getMessage).toHaveBeenCalledWith('access-1', 'm2', 'metadata');
  });

  it('loads the blocked senders for this user', async () => {
    blocked = ['jane@news.example'];
    const gmail = fakeGmail();
    await syncGmail('user-1', { gmail, classify: classifyYes });
    expect(poolCalls(/from gmail_blocked_senders/)[0][1]).toEqual(['user-1']);
    expect(recorded()[0]).toEqual(expect.arrayContaining(['rule_skip', 'blocked-sender']));
  });
});

describe('deciding each message', () => {
  it('records a rule_skip when the metadata has no list headers, without fetching the full message', async () => {
    const gmail = fakeGmail({
      getMessage: vi.fn(async (_t: string, id: string) => meta(id, { From: 'Bob <bob@x.example>', Subject: 'Lunch?' })),
    });
    await expect(syncGmail('user-1', { gmail, classify: classifyYes })).resolves.toEqual({ seen: 1, saved: 0 });
    expect(gmail.getMessage).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'full');
    // Mail that is not a list is not ours to show: its subject and sender are not stored.
    expect(recorded()).toEqual([['user-1', 'm1', 'rule_skip', 'not-a-list', null, null]]);
    expect(classifyYes).not.toHaveBeenCalled();
  });

  it('records a rule_skip when the body is too short', async () => {
    const gmail = fakeGmail({
      getMessage: vi.fn(async (_t: string, id: string, format: string) =>
        format === 'metadata' ? meta(id, LIST_HEADERS) : full(id, LIST_HEADERS, '<p>Just a few words.</p>')),
    });
    await syncGmail('user-1', { gmail, classify: classifyYes });
    expect(recorded()[0].slice(2, 4)).toEqual(['rule_skip', 'too-short']);
    expect(classifyYes).not.toHaveBeenCalled();
  });

  it('records not_editorial and saves no article', async () => {
    const classify = vi.fn(async () => ({ editorial: false, reason: 'promotion 0.88' }));
    await expect(syncGmail('user-1', { gmail: fakeGmail(), classify })).resolves.toEqual({ seen: 1, saved: 0 });
    expect(recorded()).toEqual([
      ['user-1', 'm1', 'not_editorial', 'promotion 0.88', 'jane@news.example', 'Fwd: Weekly Digest'],
    ]);
    expect(clientCalls(/insert into articles/)).toHaveLength(0);
    expect(poolCalls(/insert into articles/)).toHaveLength(0);
    expect(clientCalls(/begin/)).toHaveLength(0);
  });

  it('passes the decoded plain text (not the html) to the classifier', async () => {
    await syncGmail('user-1', { gmail: fakeGmail(), classify: classifyYes });
    const arg = (classifyYes.mock.calls[0] as unknown as [{ subject: string; html: string; text: string }])[0];
    expect(arg.subject).toBe('Fwd: Weekly Digest');
    expect(arg.text).toContain(LONG_TEXT_START);
    expect(arg.text).not.toMatch(/<p>/);
  });

  it('saves an editorial message as a gmail article and records it, in one transaction', async () => {
    await expect(syncGmail('user-1', { gmail: fakeGmail(), classify: classifyYes })).resolves.toEqual({ seen: 1, saved: 1 });

    expect(extractNewsletter).toHaveBeenCalledWith({
      html: expect.stringContaining('<p>'),
      text: expect.stringContaining(LONG_TEXT_START),
      title: 'Weekly Digest', // Fwd: stripped
      author: 'Jane Doe',
    });

    const sqls = clientQuery.mock.calls.map(sqlOf);
    expect(sqls[0]).toBe('begin');
    expect(sqls.at(-1)).toBe('commit');
    const article = clientCalls(/insert into articles/)[0];
    expect(sqlOf(article)).toContain("'email'");
    expect(sqlOf(article)).toContain("'gmail'");
    expect(sqlOf(article)).toContain("'ready'");
    expect(sqlOf(article)).toContain('on conflict do nothing');
    expect(article[1]).toEqual([
      'user-1', 'Weekly Digest', 'Jane Doe', 'Digest', 'ex', '<p>x</p>', 'x', 300, 2, 'm1', '<m-1@news.example>',
    ]);
    const message = clientCalls(/insert into gmail_messages/)[0];
    expect(sqlOf(message)).toContain('on conflict (user_id, gmail_message_id) do nothing');
    expect(message[1]).toEqual(['user-1', 'm1', 'editorial', 'editorial 0.91', 'jane@news.example', 'Fwd: Weekly Digest']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('skips as a duplicate when the Message-ID is already an inbound email', async () => {
    duplicateRows = [{ one: 1 }];
    await expect(syncGmail('user-1', { gmail: fakeGmail(), classify: classifyYes })).resolves.toEqual({ seen: 1, saved: 0 });
    const dup = poolCalls(/from inbound_emails/)[0];
    expect(dup[1]).toEqual(['user-1', '<m-1@news.example>']);
    expect(recorded()).toEqual([
      ['user-1', 'm1', 'rule_skip', 'duplicate', 'jane@news.example', 'Fwd: Weekly Digest'],
    ]);
    expect(clientCalls(/insert into articles/)).toHaveLength(0);
    expect(extractNewsletter).not.toHaveBeenCalled();
  });

  it('records a message deleted before it was fetched (404) as rule_skip "gone" and carries on', async () => {
    const gmail = fakeGmail({
      listHistory: vi.fn(async () => ({ messageIds: ['gone-1', 'm2'], historyId: '5000' })),
      getMessage: vi.fn(async (_t: string, id: string, format: 'metadata' | 'full') => {
        if (id === 'gone-1') throw new Error('Gmail messages request returned 404');
        return format === 'metadata' ? meta(id, LIST_HEADERS) : full(id, LIST_HEADERS, LONG_HTML);
      }),
    });
    await expect(syncGmail('user-1', { gmail, classify: classifyYes })).resolves.toEqual({ seen: 2, saved: 1 });
    expect(recorded()).toContainEqual(['user-1', 'gone-1', 'rule_skip', 'gone', null, null]);
    expect(historyUpdates()).toHaveLength(1);
  });

  it('rolls back and rethrows when the article insert fails, leaving history_id alone', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (/insert into articles/.test(sql)) throw new Error('db down');
      return { rows: [], rowCount: 1 };
    });
    await expect(syncGmail('user-1', { gmail: fakeGmail(), classify: classifyYes })).rejects.toThrow('db down');
    expect(clientCalls(/^rollback/).length).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(historyUpdates()).toHaveLength(0);
  });

  it('rethrows any other error from fetching a message, keeping earlier messages recorded', async () => {
    const gmail = fakeGmail({
      listHistory: vi.fn(async () => ({ messageIds: ['m1', 'm2'], historyId: '5000' })),
      getMessage: vi.fn(async (_t: string, id: string, format: 'metadata' | 'full') => {
        if (id === 'm2') throw new Error('Gmail messages request returned 500');
        return format === 'metadata'
          ? meta(id, { From: 'Bob <bob@x.example>', Subject: 'Lunch?' })
          : full(id, LIST_HEADERS, LONG_HTML);
      }),
    });
    await expect(syncGmail('user-1', { gmail, classify: classifyYes })).rejects.toThrow('returned 500');
    expect(recorded()).toHaveLength(1);
    expect(historyUpdates()).toHaveLength(0);
  });

  it('tolerates two overlapping syncs: every insert is on conflict do nothing', async () => {
    const ruleSkip = fakeGmail({
      getMessage: vi.fn(async (_t: string, id: string) => meta(id, { From: 'Bob <bob@x.example>', Subject: 'Hi' })),
    });
    await syncGmail('user-1', { gmail: ruleSkip, classify: classifyYes });
    await syncGmail('user-1', { gmail: fakeGmail(), classify: classifyYes });
    const inserts = [
      ...poolCalls(/insert into/), ...clientCalls(/insert into/),
    ].map(sqlOf);
    expect(inserts.length).toBeGreaterThanOrEqual(3);
    for (const sql of inserts) expect(sql).toMatch(/on conflict (\(user_id, gmail_message_id\) )?do nothing/);
  });

  it('counts an article another sync already saved as seen but not saved', async () => {
    clientQuery.mockImplementation(async (sql: string) =>
      /insert into articles/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 });
    await expect(syncGmail('user-1', { gmail: fakeGmail(), classify: classifyYes })).resolves.toEqual({ seen: 1, saved: 0 });
    expect(clientCalls(/insert into gmail_messages/)).toHaveLength(1);
  });
});

describe('a message that keeps failing', () => {
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const failing = (failIds: string[]) =>
    fakeGmail({
      listHistory: vi.fn(async () => ({ messageIds: ids, historyId: '5000' })),
      getMessage: vi.fn(async (_t: string, id: string, format: 'metadata' | 'full') => {
        if (failIds.includes(id)) throw new Error(`Gmail messages request returned 500 for ${id}`);
        return format === 'metadata' ? meta(id, LIST_HEADERS) : full(id, LIST_HEADERS, LONG_HTML);
      }),
    });

  it('propagates the error on a normal attempt (lastAttempt defaults to false)', async () => {
    await expect(syncGmail('user-1', { gmail: failing(['m2']), classify: classifyYes })).rejects.toThrow('returned 500');
    expect(historyUpdates()).toHaveLength(0);
  });

  it('on the last attempt records it as rule_skip "error", carries on and advances history_id', async () => {
    const result = await syncGmail('user-1', { gmail: failing(['m2']), classify: classifyYes, lastAttempt: true });
    expect(result).toEqual({ seen: 5, saved: 4 });
    expect(recorded()).toContainEqual(['user-1', 'm2', 'rule_skip', 'error', null, null]);
    const errorInsert = poolCalls(/insert into gmail_messages/).find((c) => (c[1] as unknown[])[1] === 'm2')!;
    expect(sqlOf(errorInsert)).toContain('on conflict (user_id, gmail_message_id) do nothing');
    expect(historyUpdates()).toHaveLength(1);
  });

  it('on the last attempt, stops and rethrows after 3 consecutive failures, leaving history_id alone', async () => {
    await expect(
      syncGmail('user-1', { gmail: failing(['m1', 'm2', 'm3']), classify: classifyYes, lastAttempt: true }),
    ).rejects.toThrow('returned 500 for m3');
    const errors = recorded().filter((r) => r[3] === 'error');
    expect(errors.map((r) => r[1])).toEqual(['m1', 'm2']);
    expect(historyUpdates()).toHaveLength(0);
  });

  it('on the last attempt, a success in between resets the count of consecutive failures', async () => {
    const gmail = failing(['m1', 'm2', 'm4', 'm5']);
    await expect(syncGmail('user-1', { gmail, classify: classifyYes, lastAttempt: true })).resolves.toEqual({
      seen: 5,
      saved: 1,
    });
    expect(recorded().filter((r) => r[3] === 'error')).toHaveLength(4);
    expect(historyUpdates()).toHaveLength(1);
  });

  it('on the last attempt, an auth error is not skipped: the connection is flagged', async () => {
    const gmail = fakeGmail({
      getMessage: vi.fn(async () => {
        throw new GmailAuthError();
      }),
    });
    await expect(syncGmail('user-1', { gmail, classify: classifyYes, lastAttempt: true })).resolves.toBeDefined();
    expect(poolCalls(/needs_reconnect/)).toHaveLength(1);
    expect(recorded()).toHaveLength(0);
  });
});

describe('NUL bytes', () => {
  it('are stripped from the subject, sender, html and text before anything is stored', async () => {
    const headers = { ...LIST_HEADERS, Subject: 'Weekly\u0000 Digest', From: 'Jane <jane@news.example>' };
    const gmail = fakeGmail({
      getMessage: vi.fn(async (_t: string, id: string, format: 'metadata' | 'full') =>
        format === 'metadata' ? meta(id, headers) : full(id, headers, `<p>Hel\u0000lo</p>${LONG_HTML}`)),
    });
    await syncGmail('user-1', { gmail, classify: classifyYes });
    const arg = (classifyYes.mock.calls[0] as unknown as [{ subject: string; html: string; text: string }])[0];
    expect(arg.subject).toBe('Weekly Digest');
    expect(arg.html).not.toContain('\u0000');
    expect(arg.text).not.toContain('\u0000');
    const extractArg = extractNewsletter.mock.calls[0][0] as { html: string; text: string; title: string };
    expect(extractArg.html + extractArg.text + extractArg.title).not.toContain('\u0000');
    expect(JSON.stringify(recorded())).not.toContain('\\u0000');
    expect(recorded()[0][5]).toBe('Weekly Digest');
  });
});

describe('advancing history_id', () => {
  it('advances history_id and last_synced_at once every message was recorded', async () => {
    await syncGmail('user-1', { gmail: fakeGmail(), classify: classifyYes });
    const [sql, params] = historyUpdates()[0];
    expect(sql.replace(/\s+/g, ' ')).toContain(
      "set history_id = $2, last_synced_at = now(), last_error = null, status = 'active' where user_id = $1 and refresh_token_enc = $3",
    );
    expect(params).toEqual(['user-1', '5000', connection!.refresh_token_enc]);
  });

  it('processes only 200 of 250 new ids and leaves history_id unchanged', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const gmail = fakeGmail({
      listHistory: vi.fn(async () => ({ messageIds: ids, historyId: '5000' })),
      getMessage: vi.fn(async (_t: string, id: string) => meta(id, { From: 'Bob <bob@x.example>', Subject: 'Hi' })),
    });
    await expect(syncGmail('user-1', { gmail, classify: classifyYes })).resolves.toEqual({ seen: 200, saved: 0 });
    expect(gmail.getMessage).toHaveBeenCalledTimes(200);
    expect(gmail.getMessage).not.toHaveBeenCalledWith('access-1', 'id-200', 'metadata');
    expect(historyUpdates()).toHaveLength(0);
    const [sql, params] = poolCalls(/update gmail_connections set last_synced_at/)[0];
    expect(sql).not.toMatch(/history_id/);
    expect(sql.replace(/\s+/g, ' ')).toContain('where user_id = $1 and refresh_token_enc = $2');
    expect(params).toEqual(['user-1', connection!.refresh_token_enc]);
  });

  it('still resolves when the connection was deleted mid-sync (the final update hits 0 rows)', async () => {
    finalUpdateRowCount = 0;
    await expect(syncGmail('user-1', { gmail: fakeGmail(), classify: classifyYes })).resolves.toEqual({ seen: 1, saved: 1 });
    expect(historyUpdates()).toHaveLength(1);
  });

  it('never logs or stores the token', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    await syncGmail('user-1', { gmail: fakeGmail(), classify: classifyYes });
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('refresh-secret');
    expect(JSON.stringify(poolQuery.mock.calls)).not.toContain('refresh-secret');
    expect(JSON.stringify(clientQuery.mock.calls)).not.toContain('refresh-secret');
    vi.restoreAllMocks();
  });
});
