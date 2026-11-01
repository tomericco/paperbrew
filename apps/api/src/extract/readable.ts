import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { countWords } from '../inbound/plan.js';
import { readingMinutes, sanitizeArticleHtml } from './sanitize.js';

export interface ExtractedArticle {
  title: string | null;
  author: string | null;
  siteName: string | null;
  excerpt: string | null;
  contentHtml: string;
  textContent: string;
  wordCount: number;
  readingMinutes: number;
  canonicalUrl: string | null;
  leadImageUrl: string | null;
  publishedAt: string | null;
}

function meta(doc: Document, ...selectors: string[]): string | null {
  for (const s of selectors) {
    const v = doc.querySelector(s)?.getAttribute('content') ?? doc.querySelector(s)?.getAttribute('href');
    if (v?.trim()) return v.trim();
  }
  return null;
}

function absolute(url: string | null, base: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function finish(
  parsed: ReturnType<Readability['parse']> & object,
  extra: Partial<ExtractedArticle>,
  keepTables = true,
): ExtractedArticle {
  const contentHtml = sanitizeArticleHtml(parsed.content ?? '', { keepTables });
  const textContent = (parsed.textContent ?? '').replace(/\s+\n/g, '\n').trim();
  const wordCount = countWords(textContent);
  return {
    title: parsed.title?.trim() || null,
    author: parsed.byline?.trim() || null,
    siteName: parsed.siteName?.trim() || null,
    excerpt: parsed.excerpt?.trim() || null,
    contentHtml,
    textContent,
    wordCount,
    readingMinutes: readingMinutes(wordCount),
    canonicalUrl: null,
    leadImageUrl: null,
    publishedAt: (parsed as { publishedTime?: string | null }).publishedTime ?? null,
    ...extra,
  };
}

/** Pull the readable article out of a web page. Returns null when there's no article to find. */
export function extractArticle(html: string, pageUrl: string): ExtractedArticle | null {
  const dom = new JSDOM(html, { url: pageUrl, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  const canonicalUrl = absolute(meta(doc, 'link[rel="canonical"]', 'meta[property="og:url"]'), pageUrl);
  const leadImageUrl = absolute(meta(doc, 'meta[property="og:image"]', 'meta[name="twitter:image"]'), pageUrl);

  const parsed = new Readability(doc, { charThreshold: 400 }).parse();
  if (!parsed || !parsed.content) return null;
  const article = finish(parsed, { canonicalUrl, leadImageUrl });
  return article.wordCount >= 80 ? article : null;
}

const FORWARD_TEXT = /(-{3,}\s*Forwarded message\s*-{3,}|Begin forwarded message:|-{3,}\s*Original Message\s*-{3,})/i;
const FOOTER_LINK_TEXT = /^(unsubscribe|view (this|it|email)? ?(in|on) (your )?(browser|web)|view online|manage (your )?(preferences|subscription)|update (your )?preferences|forward to a friend)$/i;

/** Turn the HTML of a forwarded (or directly received) newsletter into a clean article. */
export function extractNewsletter(input: { html: string; text: string; title: string; author: string | null }): ExtractedArticle {
  if (input.html.trim()) {
    const dom = new JSDOM(input.html, { url: 'https://email.invalid/', virtualConsole: new VirtualConsole() });
    const doc = dom.window.document;
    // Remove mail-client forward headers (Gmail puts them in .gmail_attr) and the user's note above them.
    doc.querySelectorAll('.gmail_attr').forEach((el) => el.remove());
    for (const el of [...doc.querySelectorAll('div, p, span')]) {
      const t = el.textContent ?? '';
      if (t.length < 400 && FORWARD_TEXT.test(t)) el.remove();
    }
    // Unsubscribe / view-in-browser links mean nothing on paper.
    doc.querySelectorAll('a').forEach((a) => {
      if (FOOTER_LINK_TEXT.test((a.textContent ?? '').trim())) a.remove();
    });
    const parsed = new Readability(doc, { charThreshold: 200 }).parse();
    if (parsed?.content) {
      const a = finish(parsed, {}, false);
      if (a.wordCount >= 100) return { ...a, title: input.title || a.title, author: input.author ?? a.author };
    }
  }
  // Fallback: plain text, paragraph by paragraph.
  const paragraphs = input.text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^>+\s?/gm, '').trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const wordCount = countWords(input.text);
  return {
    title: input.title || null,
    author: input.author,
    siteName: null,
    excerpt: null,
    contentHtml: sanitizeArticleHtml(paragraphs, { keepTables: false }),
    textContent: input.text,
    wordCount,
    readingMinutes: readingMinutes(wordCount),
    canonicalUrl: null,
    leadImageUrl: null,
    publishedAt: null,
  };
}
