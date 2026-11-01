import { createMiddleware } from 'hono/factory';
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
    query.mockResolvedValue({ rows: [ROW] });
    htmlToPdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));

    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="paperbrew-2026-11-01.pdf"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/from articles\s+where user_id = \$1 and status = 'ready'/);
    expect(sql).toMatch(/order by created_at asc\s+limit 50/);
    expect(params).toEqual(['user-1']);

    const html: string = htmlToPdf.mock.calls[0][0];
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('<p>Hello</p>');
    expect(html).toContain('Sunday, 1 November 2026');
  });

  it('brews an empty issue when there is nothing ready', async () => {
    query.mockResolvedValue({ rows: [] });
    htmlToPdf.mockResolvedValue(new Uint8Array([1]));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.status).toBe(200);
    expect(htmlToPdf.mock.calls[0][0]).toContain('Nothing to brew yet. Forward some articles first.');
  });

  it('answers 500 with a message when rendering fails', async () => {
    query.mockResolvedValue({ rows: [ROW] });
    htmlToPdf.mockRejectedValue(new Error('chromium crashed'));
    const res = await brew.request('/brew', { headers: { 'x-test-user': 'yes' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Couldn't brew the magazine. Try again." });
    expect(console.error).toHaveBeenCalled();
  });
});
