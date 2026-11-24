import { createMiddleware } from 'hono/factory';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// route.ts is tested without Better Auth, Chromium or a database: requireUser signs in a fixed
// user, the pool records its queries, and htmlToPdf returns fixed bytes.
const query = vi.fn();
const htmlToPdf = vi.fn();

vi.mock('../src/routes/library.js', () => ({
  requireUser: createMiddleware<{ Variables: { userId: string } }>(async (c, next) => {
    if (c.req.header('x-test-user') !== 'yes') return c.json({ error: 'unauthorized' }, 401);
    c.set('userId', 'user-1');
    await next();
  }),
}));
vi.mock('../src/db/client.js', () => ({ pool: { query } }));
vi.mock('../src/brew/pdf.js', () => ({ htmlToPdf }));

const { brew } = await import('../src/brew/route.js');
const { BusyError } = await import('../src/brew/lifecycle.js');

/** What htmlToPdf now returns: the PDF as a stream. */
function pdfStream(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/** A real A5 PDF with `pages` pages; every page draws something so pdf-lib can embed it. */
async function a5Pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([419.53, 595.28]);
    page.drawRectangle({ x: 20, y: 20, width: 100, height: 100 });
  }
  return doc.save();
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Routes the pool mock by SQL: the articles query gets `articles`, the users query gets the layout and look. */
function mockDb(articles: unknown[], paperLayout: string | null = 'flat', paperLook: string | null = null) {
  query.mockImplementation(async (sql: string) => {
    if (/from articles/.test(sql)) return { rows: articles };
    if (/from users/.test(sql)) return { rows: paperLayout === null ? [] : [{ paper_layout: paperLayout, paper_look: paperLook }] };
    throw new Error(`unexpected query: ${sql}`);
  });
}

const ROW = {
  title: '<script>x</script>',
  author: 'Ann',
  site_name: 'example.com',
  source_url: 'https://example.com/a',
  reading_minutes: 4,
  content_html: '<p>Hello</p>',
};

describe('GET /brew', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T23:30:00Z'));
    query.mockReset();
    htmlToPdf.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('401s without a session', async () => {
    const res = await brew.request('/brew');
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("renders only the signed-in user's ready articles, oldest first", async () => {
    mockDb([ROW]);
    htmlToPdf.mockResolvedValue(pdfStream([37, 80, 68, 70]));

    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="paperbrew-2026-11-01.pdf"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    // Streamed: no content-length, so Vercel's 4.5 MB response cap doesn't apply.
    expect(res.headers.get('content-length')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));

    const [sql, params] = query.mock.calls.find(([q]) => /from articles/.test(q))!;
    expect(sql).toMatch(/from articles\s+where user_id = \$1 and status = 'ready'/);
    expect(sql).toMatch(/order by created_at asc\s+limit 50/);
    expect(params).toEqual(['user-1']);

    const html: string = htmlToPdf.mock.calls[0][0];
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('<p>Hello</p>');
    expect(html).toContain('Sunday, 1 November 2026');
  });

  it('brews an empty issue when there is nothing ready', async () => {
    mockDb([]);
    htmlToPdf.mockResolvedValue(pdfStream([1]));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.status).toBe(200);
    expect(htmlToPdf.mock.calls[0][0]).toContain('Nothing to brew yet. Forward some articles first.');
  });

  it('answers 500 with a message when rendering fails', async () => {
    mockDb([ROW]);
    htmlToPdf.mockRejectedValue(new Error('chromium crashed'));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Couldn't brew the magazine. Try again." });
    expect(console.error).toHaveBeenCalled();
  });

  it('answers 503 when another brew holds the browser for too long', async () => {
    mockDb([ROW]);
    htmlToPdf.mockRejectedValue(new BusyError());
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Another magazine is brewing. Try again in a minute.' });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('flat by default', async () => {
    mockDb([ROW], 'flat');
    htmlToPdf.mockResolvedValue(pdfStream([37, 80, 68, 70]));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="paperbrew-2026-11-01.pdf"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(htmlToPdf.mock.calls[0][0]).toContain('size: A4');
    const [, params] = query.mock.calls.find(([q]) => /from users/.test(q))!;
    expect(params).toEqual(['user-1']);
  });

  it('treats an unknown layout as flat', async () => {
    mockDb([ROW], 'weird');
    htmlToPdf.mockResolvedValue(pdfStream([1]));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="paperbrew-2026-11-01.pdf"');
  });

  it('reads paper_look with the layout and renders in that look', async () => {
    mockDb([ROW], 'flat', 'zine');
    htmlToPdf.mockResolvedValue(pdfStream([1]));
    await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    const [sql] = query.mock.calls.find(([q]) => /from users/.test(q))!;
    expect(sql).toContain('paper_look');
    const html: string = htmlToPdf.mock.calls[0][0];
    expect(html).toContain('Space Mono');
    expect(html).toContain('#1d4ed8');
  });

  it('falls back to broadsheet for an unknown or missing stored look', async () => {
    for (const stored of ['weird', null]) {
      mockDb([ROW], 'flat', stored);
      htmlToPdf.mockResolvedValue(pdfStream([1]));
      await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    }
    for (const [html] of htmlToPdf.mock.calls) {
      expect(html).not.toContain('Space Mono');
      expect(html).not.toContain('DM Sans');
    }
    expect(htmlToPdf).toHaveBeenCalledTimes(2);
  });

  it('booklet: renders A5 and returns imposed A4 sheets', async () => {
    mockDb([ROW], 'booklet');
    htmlToPdf.mockResolvedValue(bytesStream(await a5Pdf(2)));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.status).toBe(200);
    expect(htmlToPdf.mock.calls[0][0]).toContain('size: A5');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="paperbrew-2026-11-01-booklet.pdf"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-length')).toBeNull();
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(doc.getPageCount()).toBe(2);
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBeCloseTo(841.89, 1);
      expect(page.getHeight()).toBeCloseTo(595.28, 1);
    }
  });

  it('booklet with no articles still returns one sheet', async () => {
    mockDb([], 'booklet');
    htmlToPdf.mockResolvedValue(bytesStream(await a5Pdf(1)));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.status).toBe(200);
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(doc.getPageCount()).toBe(2);
  });

  it('brews only unarchived articles', async () => {
    mockDb([ROW]);
    htmlToPdf.mockResolvedValue(pdfStream([1]));
    await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    const [sql] = query.mock.calls.find(([q]) => /from articles/.test(q))!;
    expect(sql).toContain('archived_at is null');
  });

  it('reports brewed ids in a header', async () => {
    mockDb([{ ...ROW, id: 'a1' }, { ...ROW, id: 'a2' }]);
    htmlToPdf.mockResolvedValue(pdfStream([1]));
    const flat = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(flat.headers.get('x-brew-article-ids')).toBe('a1,a2');

    mockDb([{ ...ROW, id: 'a1' }, { ...ROW, id: 'a2' }], 'booklet');
    htmlToPdf.mockResolvedValue(bytesStream(await a5Pdf(2)));
    const booklet = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(booklet.status).toBe(200);
    expect(booklet.headers.get('x-brew-article-ids')).toBe('a1,a2');
  });

  it('empty brew sends an empty ids header', async () => {
    mockDb([]);
    htmlToPdf.mockResolvedValue(pdfStream([1]));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.headers.get('x-brew-article-ids')).toBe('');
  });

  describe('ids', () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const asUser = { 'x-test-user': 'yes' };

    it('brews only the chosen ids, still scoped to the caller, ready and unarchived', async () => {
      mockDb([{ ...ROW, id: A }, { ...ROW, id: B }]);
      htmlToPdf.mockResolvedValue(pdfStream([1]));
      const res = await brew.request(`/brew?ids=${A},${B}`, { headers: asUser });
      expect(res.status).toBe(200);
      const [sql, params] = query.mock.calls.find(([q]) => /from articles/.test(q))!;
      expect(sql).toMatch(/where user_id = \$1 and status = 'ready' and archived_at is null\s+and id = any\(\$2\)/);
      expect(sql).toMatch(/order by created_at asc\s+limit 50/);
      expect(params).toEqual(['user-1', [A, B]]);
      expect(res.headers.get('x-brew-article-ids')).toBe(`${A},${B}`);
    });

    it('lists in the header only the ids that matched', async () => {
      // B belongs to someone else or is archived, so the query does not return it.
      mockDb([{ ...ROW, id: A }]);
      htmlToPdf.mockResolvedValue(pdfStream([1]));
      const res = await brew.request(`/brew?ids=${A},${B}`, { headers: asUser });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-brew-article-ids')).toBe(A);
    });

    it('still brews the empty issue when no id matches', async () => {
      mockDb([]);
      htmlToPdf.mockResolvedValue(pdfStream([1]));
      const res = await brew.request(`/brew?ids=${A}`, { headers: asUser });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-brew-article-ids')).toBe('');
      expect(htmlToPdf.mock.calls[0][0]).toContain('Nothing to brew yet. Forward some articles first.');
    });

    it('accepts exactly 50 ids', async () => {
      mockDb([]);
      htmlToPdf.mockResolvedValue(pdfStream([1]));
      const ids = Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const res = await brew.request(`/brew?ids=${ids.join(',')}`, { headers: asUser });
      expect(res.status).toBe(200);
    });

    it.each([
      ['a non-UUID', 'ids=nope'],
      ['a non-UUID among valid ids', `ids=${A},nope`],
      ['an empty list', 'ids='],
      ['a trailing comma', `ids=${A},`],
      ['more than 50 ids', `ids=${Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')}`],
    ])('400s on %s without querying or rendering', async (_name, qs) => {
      const res = await brew.request(`/brew?${qs}`, { headers: asUser });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.any(String) });
      expect(query).not.toHaveBeenCalled();
      expect(htmlToPdf).not.toHaveBeenCalled();
    });

    it('without ids keeps the original query and params', async () => {
      mockDb([ROW]);
      htmlToPdf.mockResolvedValue(pdfStream([1]));
      await brew.request('/brew', { headers: asUser });
      const [sql, params] = query.mock.calls.find(([q]) => /from articles/.test(q))!;
      expect(sql).not.toContain('any(');
      expect(params).toEqual(['user-1']);
    });
  });

  it('booklet imposition failure returns 500', async () => {
    mockDb([ROW], 'booklet');
    htmlToPdf.mockResolvedValue(pdfStream([1, 2, 3]));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Couldn't brew the magazine. Try again." });
    expect(console.error).toHaveBeenCalled();
  });
});
