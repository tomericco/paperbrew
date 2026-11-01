import { JSDOM, VirtualConsole } from 'jsdom';
import { cleanUrl } from './clean.js';

// Links that are never something you'd want to print and read.
const NON_ARTICLE_HOSTS = [
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'threads.net',
  'youtube.com', 'youtu.be', 'linkedin.com', 'apps.apple.com', 'play.google.com',
  'maps.google.com', 'calendar.google.com', 'zoom.us',
];
const NON_ARTICLE_PATH = /(unsubscribe|optout|opt-out|manage[-_]?(preferences|subscription)|email[-_]?preferences|\/subscribe\b|\/account\b|\/login\b|\/signin\b|view[-_]?in[-_]?browser|\/share\b|\/intent\/)/i;
const NON_ARTICLE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|mp4|mov|mp3|zip|ics)(\?|$)/i;
const NON_ARTICLE_TEXT = /^(unsubscribe|view (this|it|email) in (your )?browser|view online|manage (your )?preferences|update (your )?preferences|privacy policy|terms|share|tweet|forward to a friend|subscribe)$/i;

const URL_IN_TEXT = /https?:\/\/[^\s<>"'()\[\]]+[^\s<>"'()\[\].,;:!?]/gi;

function hostMatches(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith('.' + h));
}

export function isArticleCandidate(url: string, anchorText = ''): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (hostMatches(u.hostname, NON_ARTICLE_HOSTS)) return false;
  if (NON_ARTICLE_EXT.test(u.pathname)) return false;
  if (NON_ARTICLE_PATH.test(u.pathname + u.search)) return false;
  if (anchorText && NON_ARTICLE_TEXT.test(anchorText.trim())) return false;
  // A bare homepage is rarely the article the user meant.
  if ((u.pathname === '/' || u.pathname === '') && !u.search) return false;
  return true;
}

/** Article-looking links from an email, in order of appearance, deduped. */
export function extractLinks(input: { html?: string; text?: string }, limit = 25): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string, anchorText = '') => {
    const clean = cleanUrl(raw);
    if (!clean || seen.has(clean) || !isArticleCandidate(clean, anchorText)) return;
    seen.add(clean);
    out.push(clean);
  };

  if (input.html) {
    const dom = new JSDOM(input.html, { virtualConsole: new VirtualConsole() });
    for (const a of dom.window.document.querySelectorAll('a[href]')) {
      // Skip image-only links (logos, banners).
      if (!a.textContent?.trim() && a.querySelector('img')) continue;
      add(a.getAttribute('href') ?? '', a.textContent ?? '');
    }
  }
  if (input.text) {
    for (const m of input.text.matchAll(URL_IN_TEXT)) add(m[0]);
  }
  return out.slice(0, limit);
}
