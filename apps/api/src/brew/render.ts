// Turns saved articles into one print-ready HTML document (the magazine).
// Pure: no I/O, so it is unit-tested directly. pdf.ts prints the result with Chromium.
//
// Typography and structure follow docs/design/the-issue (Cover, ArticleOpener), set in one column.
// The design's Contents page is left out.

import type { PaperLayout } from './layout.js';
import { detectScript, directionOf, issueDirection, type Direction, type Script } from './direction.js';

export type BrewArticle = {
  title: string | null;
  author: string | null;
  siteName: string | null;
  sourceUrl: string | null;
  readingMinutes: number | null;
  /** Already sanitized at save time (sanitizeArticleHtml), so it is inserted as is. */
  contentHtml: string | null;
};

const FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500' +
  '&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400;1,8..60,600' +
  '&family=Frank+Ruhl+Libre:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=block';

const COVER_TITLES = 3;
const EMPTY_LINE = 'Nothing to brew yet. Forward some articles first.';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "Sunday, 1 November 2026", in UTC (the same day the download's filename uses). */
export function formatIssueDate(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Cover total: "N min" under an hour, otherwise "About 1 h 25 min". */
export function formatTotalTime(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `About ${h} h ${m} min` : `About ${h} h`;
}

type Piece = {
  number: string;
  title: string;
  author: string | null;
  site: string | null;
  minutes: number | null;
  url: string | null;
  body: string;
  script: Script;
};

const clean = (s: string | null): string | null => (s && s.trim() ? s.trim() : null);

function httpUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function toPieces(articles: BrewArticle[]): Piece[] {
  return articles
    .filter((a) => a.contentHtml && a.contentHtml.trim())
    .map((a, i) => {
      const url = httpUrl(a.sourceUrl);
      return {
        number: String(i + 1).padStart(2, '0'),
        title: clean(a.title) ?? 'Untitled',
        author: clean(a.author),
        site: clean(a.siteName) ?? (url ? url.hostname.replace(/^www\./, '') : null),
        minutes: a.readingMinutes && a.readingMinutes > 0 ? a.readingMinutes : null,
        url: url ? (a.sourceUrl as string).trim() : null,
        body: a.contentHtml as string,
        script: detectScript(a.contentHtml as string),
      };
    });
}

/** The issue reads right to left only when every article does. Empty articles are skipped, as in the render. */
export function magazineDirection(articles: BrewArticle[]): Direction {
  return issueDirection(toPieces(articles).map((p) => p.script));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function cover(pieces: Piece[], date: Date): string {
  const total = pieces.reduce((sum, p) => sum + (p.minutes ?? 0), 0);
  const shown = pieces.slice(0, COVER_TITLES);
  const more = pieces.length - shown.length;

  const lead = pieces.length
    ? `<div class="cover-titles">
        ${shown
          .map(
            (p) => `<div class="cover-title">
          <span class="t" dir="auto">${escapeHtml(p.title)}</span>${p.author ? `<span class="a">${escapeHtml(p.author)}</span>` : ''}
        </div>`,
          )
          .join('\n')}
        ${more > 0 ? `<span class="more">and ${more} more</span>` : ''}
      </div>
      <div class="rule"></div>
      <div class="stats mono">
        <span>${plural(pieces.length, 'piece', 'pieces')}</span>
        ${total ? `<span>${formatTotalTime(total)}</span>` : ''}
      </div>`
    : `<p class="empty">${EMPTY_LINE}</p>`;

  return `<section class="cover">
    <div class="topline mono"><span>Issue</span><span>${formatIssueDate(date)}</span></div>
    <div class="rule thick"></div>
    <h1 class="masthead">Paperbrew</h1>
    <div class="rule"></div>
    <p class="tagline mono">Your reading, collected and printed</p>
    <div class="grow"></div>
    ${lead}
  </section>`;
}

function article(p: Piece): string {
  const rtl = directionOf(p.script) === 'rtl';
  // In a right-to-left article the English kicker parts are isolated so the separators do not reorder.
  const wrap = (s: string) => (rtl ? `<bdi>${s}</bdi>` : s);
  const kicker = [p.number, p.site && escapeHtml(p.site), p.minutes && `${p.minutes} min read`]
    .filter(Boolean)
    .map((part) => wrap(part as string))
    .join(' · ');
  const attrs = rtl ? ` dir="rtl" lang="${p.script === 'hebrew' ? 'he' : 'ar'}"` : '';
  const link = p.url
    ? `<p class="source mono"${rtl ? ' dir="ltr"' : ''}>Read it online: <a href="${escapeHtml(p.url)}">${escapeHtml(
        p.url.replace(/^https?:\/\//, ''),
      )}</a></p>`
    : '';
  return `<article class="article"${attrs}>
    <p class="kicker mono">${kicker}</p>
    <h1 class="headline">${escapeHtml(p.title)}</h1>
    ${p.author ? `<p class="byline">${escapeHtml(p.author)}</p>` : ''}
    <div class="rule"></div>
    <div class="body">${p.body}</div>
    ${link}
  </article>`;
}

/** The page box. Both layouts number their pages in the bottom margin. */
function pageRule(size: string, margin: string): string {
  return `
@page {
  size: ${size}; margin: ${margin};
  /* Page numbers in the bottom margin (CSS margin boxes, Chrome 131+). The cover counts as page 1 but shows none. */
  @bottom-center {
    content: counter(page);
    font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 8pt; letter-spacing: 0.04em; color: #111;
  }
}
@page :first { @bottom-center { content: none; } }
`;
}

const CSS = `
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; color: #111; font-family: 'Source Serif 4', 'Frank Ruhl Libre', 'Noto Naskh Arabic', Georgia, serif; }
.mono { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
.rule { height: 0; border-top: 1px solid #111; }
.rule.thick { border-top-width: 3px; }

/* Cover: fills the first page (A4 297mm minus 2 x 16mm margins). */
.cover { height: 264mm; display: flex; flex-direction: column; }
.cover .topline { display: flex; justify-content: space-between; align-items: baseline; }
.cover .rule.thick { margin-top: 12px; }
.masthead { margin: 18px 0 0; font-size: 88px; line-height: 0.95; font-weight: 700; letter-spacing: -0.03em; }
.cover .masthead + .rule { margin-top: 18px; }
.tagline { margin: 10px 0 0; }
.grow { flex-grow: 1; }
.cover-titles { display: flex; flex-direction: column; gap: 14px; }
.cover-title { display: flex; flex-direction: column; gap: 2px; }
.cover-title .t { font-size: 20px; font-weight: 600; line-height: 1.2; }
.cover-title .a { font-size: 15px; font-style: italic; }
.more { font-size: 15px; }
.cover-titles + .rule { margin-top: 36px; }
.stats { display: flex; justify-content: space-between; margin-top: 10px; }
.empty { margin: 0 0 8px; font-size: 20px; font-style: italic; line-height: 1.3; }

/* Articles: each starts on a new page. */
.article { break-before: page; }
.kicker { margin: 24px 0 0; }
.headline { margin: 12px 0 0; font-size: 40px; line-height: 1.05; font-weight: 700; letter-spacing: -0.025em; text-wrap: balance; }
.byline { margin: 12px 0 0; font-size: 18px; font-style: italic; }
.article > .rule { margin-top: 18px; }
.body {
  margin-top: 18px; font-size: 10.75pt; line-height: 1.5; text-align: justify; hyphens: auto; -webkit-hyphens: auto;
  overflow-wrap: break-word;
}
.body > :first-child { margin-top: 0; }
.body p { margin: 0 0 0.6em; orphans: 2; widows: 2; }
.body > p:first-of-type::first-letter {
  float: inline-start; font-size: 3.6em; line-height: 0.82; font-weight: 700; padding-block-start: 0.06em; padding-inline-end: 0.08em;
}
/* Arabic letters join, so a detached initial would break the word. */
.article:lang(ar) .body > p:first-of-type::first-letter {
  float: none; font-size: inherit; line-height: inherit; font-weight: inherit; padding: 0;
}
.body h2, .body h3, .body h4, .body h5, .body h6 {
  text-align: start; line-height: 1.2; margin: 1em 0 0.4em; break-inside: avoid; break-after: avoid;
}
.body h2 { font-size: 13pt; } .body h3 { font-size: 10.75pt; } .body h4, .body h5, .body h6 { font-size: 10.5pt; }
.body img { display: block; max-width: 100%; height: auto; margin: 0.4em 0; break-inside: avoid; }
.body figure { margin: 0.6em 0; break-inside: avoid; }
.body figcaption { font-size: 8.5pt; line-height: 1.3; color: #4a4a4a; text-align: start; }
.body blockquote { margin: 0.6em 0; padding-inline-start: 0.8em; border-inline-start: 1.5pt solid #111; font-style: italic; }
.body ul, .body ol { margin: 0 0 0.6em; padding-inline-start: 1.2em; text-align: start; }
.body pre { white-space: pre-wrap; overflow-wrap: anywhere; text-align: start; font-size: 8pt; line-height: 1.35; }
.body code { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 0.85em; }
.body table { width: 100%; border-collapse: collapse; font-size: 8.5pt; text-align: start; break-inside: avoid; }
.body th, .body td { border-bottom: 0.5pt solid #999; padding: 2pt 3pt; vertical-align: top; }
.body hr { border: 0; border-top: 0.5pt solid #111; }
.body a { color: inherit; text-decoration: none; }
.source { margin: 16px 0 0; padding-top: 8px; border-top: 1px solid #111; text-transform: none; overflow-wrap: anywhere; break-inside: avoid; }
.source a { color: inherit; text-decoration: none; }
`;

/** Booklet pages are A5 (two per A4 sheet), so the page box shrinks and the large type steps down. Body text stays 10.75pt. */
const BOOKLET_CSS = `
/* Cover: fills the first A5 page (210mm minus 14mm top and 16mm bottom margins). */
.cover { height: 180mm; }
.masthead { font-size: 60px; }
.cover-title .t { font-size: 17px; }
.headline { font-size: 28px; }
.byline { font-size: 15px; }
`;

const FLAT_PAGE = pageRule('A4', '16mm 30mm');
const BOOKLET_PAGE = pageRule('A5', '14mm 16mm 16mm');

export function renderMagazine(input: { articles: BrewArticle[]; date: Date; layout?: PaperLayout }): string {
  const booklet = input.layout === 'booklet';
  const css = booklet ? BOOKLET_PAGE + CSS + BOOKLET_CSS : FLAT_PAGE + CSS;
  const pieces = toPieces(input.articles);
  const title = `Paperbrew · ${formatIssueDate(input.date)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtml(FONTS)}">
<style>${css}</style>
</head>
<body>
${cover(pieces, input.date)}
${pieces.map(article).join('\n')}
</body>
</html>
`;
}
