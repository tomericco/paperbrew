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

/** Routes the pool mock by SQL: the articles query gets `articles`, the users query gets the layout. */
function mockDb(articles: unknown[], paperLayout: string | null = 'flat') {
  query.mockImplementation(async (sql: string) => {
    if (/from articles/.test(sql)) return { rows: articles };
    if (/from users/.test(sql)) return { rows: paperLayout === null ? [] : [{ paper_layout: paperLayout }] };
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

  it('booklet imposition failure returns 500', async () => {
    mockDb([ROW], 'booklet');
    htmlToPdf.mockResolvedValue(pdfStream([1, 2, 3]));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Couldn't brew the magazine. Try again." });
    expect(console.error).toHaveBeenCalled();
  });
});
