import { beforeEach, describe, expect, it, vi } from 'vitest';

// processEmail's newsletter branch asks findDuplicateNewsletter before inserting (same mocking pattern as resave.test.ts).
const poolQuery = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();
const planEmail = vi.fn();
const extractNewsletter = vi.fn();
const findDuplicateNewsletter = vi.fn();

vi.mock('../src/config.js', () => ({ config: {} }));
vi.mock('../src/db/client.js', () => ({
  pool: { query: poolQuery, connect: async () => ({ query: clientQuery, release }) },
}));
vi.mock('../src/inbound/plan.js', () => ({ planEmail }));
vi.mock('../src/extract/readable.js', () => ({ extractNewsletter }));
vi.mock('../src/inbound/dedupe.js', () => ({ findDuplicateNewsletter }));

const { processEmail } = await import('../src/pipeline/processEmail.js');

const ARTICLE = {
  title: 'Weekly Digest', author: 'Jane', siteName: null, excerpt: 'x', contentHtml: '<p>x</p>',
  textContent: 'x', wordCount: 300, readingMinutes: 2,
};
const resultOf = () => {
  const update = clientQuery.mock.calls.find(([sql]) => /update inbound_emails set status = 'processed'/.test(sql));
  return update![1][1];
};

beforeEach(() => {
  for (const m of [poolQuery, clientQuery, release, planEmail, extractNewsletter, findDuplicateNewsletter]) m.mockReset();
  poolQuery.mockResolvedValue({
    rows: [{ user_id: 'user-1', payload: { messageId: '<fwd@mail>' }, status: 'received' }],
  });
  planEmail.mockReturnValue({
    reason: 'forwarded-newsletter', urls: [],
    newsletter: { title: 'Weekly Digest', author: 'Jane', html: '<p>x</p>', text: 'x' },
  });
  extractNewsletter.mockReturnValue(ARTICLE);
  clientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('processEmail newsletter duplicates', () => {
  it('skips the newsletter insert, still marks the email processed, and records the duplicate', async () => {
    findDuplicateNewsletter.mockResolvedValue(true);

    await processEmail('email-1');

    expect(findDuplicateNewsletter).toHaveBeenCalledWith(
      expect.anything(), 'user-1', { messageId: '<fwd@mail>', title: 'Weekly Digest' }, 'email',
    );
    const sqls = clientQuery.mock.calls.map(([sql]) => sql as string);
    expect(sqls.some((s) => /insert into articles/.test(s))).toBe(false);
    expect(sqls).toContain('commit');
    expect(resultOf()).toEqual({
      reason: 'forwarded-newsletter', urls: [], linksAdded: 0, newsletterSaved: false, duplicate: true,
    });
  });

  it('saves the newsletter when it is not a duplicate', async () => {
    findDuplicateNewsletter.mockResolvedValue(false);

    await processEmail('email-1');

    const insert = clientQuery.mock.calls.find(([sql]) => /insert into articles/.test(sql));
    expect(insert).toBeDefined();
    expect(resultOf()).toMatchObject({ newsletterSaved: true, duplicate: false });
  });

  it('does not run the check when the email has no newsletter', async () => {
    planEmail.mockReturnValue({ reason: 'links', urls: [], newsletter: null });
    await processEmail('email-1');
    expect(findDuplicateNewsletter).not.toHaveBeenCalled();
  });
});
