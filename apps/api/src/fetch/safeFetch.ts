import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch } from 'undici';
import { isPrivateIp } from './ip.js';

export class FetchError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

// Every connection is checked at DNS time, so redirects and DNS rebinding can't reach internal hosts.
const guardedLookup: typeof dns.lookup = ((hostname: string, options: any, callback: any) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses: dns.LookupAddress[]) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isPrivateIp(a.address));
    if (bad) return callback(new FetchError(`Blocked private address for ${hostname}`, false));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}) as typeof dns.lookup;

const agent = new Agent({ connect: { lookup: guardedLookup }, maxRedirections: 0 } as any);

export interface FetchedPage {
  finalUrl: string;
  html: string;
}

export async function fetchHtml(
  url: string,
  opts: { timeoutMs: number; maxBytes: number; maxRedirects?: number },
): Promise<FetchedPage> {
  let current = url;
  const maxRedirects = opts.maxRedirects ?? 6;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new FetchError(`Unsupported protocol ${parsed.protocol}`, false);
    }
    // IP-literal hosts skip DNS, so the lookup guard never sees them: check them here.
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) {
      throw new FetchError(`Blocked private address ${host}`, false);
    }

    let res;
    try {
      res = await fetch(current, {
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          'user-agent': 'PaperbrewBot/0.1 (+https://paperbrew.example/bot)',
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
      });
    } catch (err) {
      if (err instanceof FetchError) throw err;
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof FetchError) throw cause;
      throw new FetchError(`Network error: ${(err as Error).message}`, true);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new FetchError(`Redirect without location (${res.status})`, false);
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      throw new FetchError(`HTTP ${res.status}`, true);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new FetchError(`HTTP ${res.status}`, false);
    }

    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      await res.body?.cancel();
      throw new FetchError(`Not an HTML page (${type || 'unknown type'})`, false);
    }

    // Read with a byte cap so huge pages can't exhaust memory.
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel();
        throw new FetchError('Page too large', false);
      }
      chunks.push(value);
    }
    const charset = /charset=([^;]+)/i.exec(type)?.[1]?.trim() ?? 'utf-8';
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset);
    } catch {
      decoder = new TextDecoder('utf-8');
    }
    return { finalUrl: current, html: decoder.decode(Buffer.concat(chunks)) };
  }
  throw new FetchError('Too many redirects', false);
}
