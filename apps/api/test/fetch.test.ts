import { describe, expect, it } from 'vitest';
import { isPrivateIp } from '../src/fetch/ip.js';
import { fetchHtml } from '../src/fetch/safeFetch.js';
import { extractArticle } from '../src/extract/readable.js';
import { paragraphs } from './helpers.js';

describe('isPrivateIp', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1'])(
    'blocks %s',
    (ip) => expect(isPrivateIp(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5'])('allows %s', (ip) => expect(isPrivateIp(ip)).toBe(false));
});

describe('fetchHtml', () => {
  it('refuses to reach internal addresses', async () => {
    const opts = { timeoutMs: 2000, maxBytes: 1000 };
    for (const url of [
      'http://127.0.0.1:9/',
      'http://169.254.169.254/latest/meta-data/',
      'http://2130706433/', // 127.0.0.1 written as a number
      'http://[::1]/',
      'http://[::ffff:10.0.0.1]/',
      'http://localhost/',
    ]) {
      await expect(fetchHtml(url, opts), url).rejects.toThrow(/Blocked private address/);
    }
  });
});

describe('extractArticle', () => {
  it('pulls title, byline, canonical URL and clean content from a page', () => {
    const html = `<!doctype html><html><head><title>Slow reading | Example Blog</title>
      <link rel="canonical" href="/essays/slow-reading">
      <meta property="og:image" content="/img/cover.jpg"></head>
      <body><nav><a href="/">Home</a></nav>
      <article><h1>Slow reading</h1><p class="byline">By Jane Doe</p>
      ${paragraphs(8).map((p) => `<p>${p}</p>`).join('')}
      <script>track()</script></article><footer>© Example</footer></body></html>`;
    const a = extractArticle(html, 'https://blog.example.com/essays/slow-reading?utm_source=x');
    expect(a).not.toBeNull();
    expect(a!.canonicalUrl).toBe('https://blog.example.com/essays/slow-reading');
    expect(a!.leadImageUrl).toBe('https://blog.example.com/img/cover.jpg');
    expect(a!.contentHtml).not.toMatch(/<script|track\(\)/);
    expect(a!.wordCount).toBeGreaterThan(250);
  });
});
