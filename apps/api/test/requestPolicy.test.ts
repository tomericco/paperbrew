import { describe, expect, it } from 'vitest';
import { allowRendererRequest, allowResourceType } from '../src/brew/requestPolicy.js';

describe('allowRendererRequest', () => {
  it.each<[string, string[]]>([
    ['https://fonts.googleapis.com/css2?x', ['142.250.0.1']],
    ['https://example.com/a.jpg', ['93.184.216.34']],
    ['data:image/png;base64,AAAA', []],
  ])('allows %s', (url, addrs) => {
    expect(allowRendererRequest(url, addrs)).toBe(true);
  });

  it.each<[string, string[]]>([
    ['http://169.254.169.254/latest', ['169.254.169.254']],
    ['http://localhost/x.png', ['127.0.0.1']],
    ['https://evil.test/x.png', ['10.0.0.5']],
    ['https://ok.test/x.png', ['93.184.216.34', '192.168.1.1']],
    ['file:///etc/passwd', []],
    ['ftp://x.test/a', ['93.184.216.34']],
    // No DNS answer (lookup failed or timed out): refuse.
    ['https://example.com/a.jpg', []],
    // A private IP literal is refused even if the caller passed a public address.
    ['http://127.0.0.1/x.png', ['93.184.216.34']],
    ['http://[::1]/x.png', ['::1']],
    ['http://[::ffff:169.254.169.254]/x', ['::ffff:169.254.169.254']],
    ['not a url', ['93.184.216.34']],
  ])('refuses %s', (url, addrs) => {
    expect(allowRendererRequest(url, addrs)).toBe(false);
  });
});

describe('allowResourceType', () => {
  it.each<[string, string]>([
    ['document', 'about:blank'],
    ['image', 'https://example.com/a.jpg'],
    ['image', 'data:image/png;base64,AAAA'],
    ['stylesheet', 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono'],
    ['font', 'https://fonts.gstatic.com/s/ibmplexmono/v1/x.woff2'],
  ])('allows %s %s', (type, url) => {
    expect(allowResourceType(type, url)).toBe(true);
  });

  it.each<[string, string]>([
    ['document', 'https://example.com/'],
    ['script', 'https://example.com/a.js'],
    ['xhr', 'https://example.com/api'],
    ['fetch', 'https://example.com/api'],
    ['media', 'https://example.com/a.mp4'],
    ['websocket', 'wss://example.com/'],
    ['other', 'https://example.com/'],
    ['stylesheet', 'https://evil.test/a.css'],
    ['font', 'https://evil.test/a.woff2'],
  ])('refuses %s %s', (type, url) => {
    expect(allowResourceType(type, url)).toBe(false);
  });
});
