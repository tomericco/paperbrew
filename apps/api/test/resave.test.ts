import { beforeEach, describe, expect, it, vi } from 'vitest';

// processEmail and fetchArticle are tested without a database: the pool and its transaction client
// record their queries, and planning, extraction and fetching are replaced by fixed answers.
const poolQuery = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();
const fetchHtml = vi.fn();
const extractArticle = vi.fn();
const planEmail = vi.fn();

class UniqueViolation extends Error {
  code = '23505';
}

vi.mock('../src/config.js', () => ({ config: { FETCH_TIMEOUT_MS: 1000, FETCH_MAX_BYTES: 1000 } }));
vi.mock('../src/db/client.js', () => ({
  pool: { query: poolQuery, connect: async () => ({ query: clientQuery, release }) },
  isUniqueViolation: (err: unknown) => (err as { code?: string } | null)?.code === '23505',
}));
vi.mock('../src/inbound/plan.js', () => ({ planEmail }));
vi.mock('../src/fetch/safeFetch.js', () => ({
  fetchHtml,
  FetchError: class FetchError extends Error {
    constructor(message: string, public retryable: boolean) {
      super(message);
    }
  },
}));
vi.mock('../src/extract/readable.js', () => ({ extractArticle, extractNewsletter: vi.fn() }));

const { processEmail } = await import('../src/pipeline/processEmail.js');
const { fetchArticle } = await import('../src/pipeline/fetchArticle.js');

const UNARCHIVE =
  /update articles set archived_at = null, rollover_count = 0, archive_reason = null,\s+created_at = now\(\), updated_at = now\(\)/;

describe('re-saving an archived article', () => {
  beforeEach(() => {
    for (const m of [poolQuery, clientQuery, release, fetchHtml, extractArticle, planEmail]) m.mockReset();
  });

  it('processEmail clears archived_at when a forwarded link already exists', async () => {
    poolQuery.mockResolvedValue({
      rows: [{ user_id: 'user-1', payload: {}, status: 'received' }],
    });
    planEmail.mockReturnValue({ reason: 'links', urls: ['https://example.com/a'], newsletter: null });
    clientQuery.mockImplementation(async (sql: string) => {
      // The link insert hits the unique index and returns no row.
      if (/insert into articles/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    await processEmail('email-1');

    const calls = clientQuery.mock.calls;
    const unarchive = calls.find(([sql]) => UNARCHIVE.test(sql));
    expect(unarchive).toBeDefined();
    expect(unarchive![0].replace(/\s+/g, ' ')).toContain(
      'update articles set archived_at = null, rollover_count = 0, archive_reason = null, created_at = now(), updated_at = now() where user_id = $1 and canonical_url = $2 and archived_at is not null',
    );
    expect(unarchive![1]).toEqual(['user-1', 'https://example.com/a']);
    expect(calls.some(([sql]) => /insert into jobs/.test(sql))).toBe(false);
    expect(calls.map(([sql]) => sql)).toContain('commit');
  });

  it('fetchArticle un-archives the existing copy on a canonical duplicate', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (/^select user_id/.test(sql)) {
        return { rows: [{ user_id: 'user-1', source_url: 'https://t.example/x', status: 'queued' }] };
      }
      if (/set canonical_url/.test(sql)) throw new UniqueViolation('duplicate key');
      return { rows: [], rowCount: 1 };
    });
    fetchHtml.mockResolvedValue({ html: '<p>x</p>', finalUrl: 'https://example.com/a' });
    extractArticle.mockReturnValue({
      canonicalUrl: 'https://example.com/a',
      title: 'T', author: null, siteName: 'example.com', excerpt: '', contentHtml: '<p>x</p>',
      textContent: 'x', wordCount: 1, readingMinutes: 1, leadImageUrl: null, publishedAt: null,
    });

    await fetchArticle('art-2', false);

    const sqls = poolQuery.mock.calls.map(([sql]) => sql as string);
    const unarchiveAt = sqls.findIndex((s) => UNARCHIVE.test(s));
    const deleteAt = sqls.findIndex((s) => /delete from articles where id = \$1/.test(s));
    expect(unarchiveAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(unarchiveAt);
    expect(poolQuery.mock.calls[unarchiveAt][1]).toEqual(['user-1', 'https://example.com/a']);
    expect(poolQuery.mock.calls[deleteAt][1]).toEqual(['art-2']);
  });
});
