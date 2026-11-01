import sanitizeHtml from 'sanitize-html';

/** Keep only print-friendly structure: text, headings, lists, quotes, code, tables and images. */
const TABLE_TAGS = ['table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption'];

/**
 * Newsletters use tables for layout, not data: pass keepTables=false to flatten them
 * (the tags are dropped, their content is kept).
 */
export function sanitizeArticleHtml(html: string, opts: { keepTables?: boolean } = {}): string {
  const keepTables = opts.keepTables ?? true;
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code',
      'em', 'strong', 'b', 'i', 'u', 's', 'sup', 'sub', 'small', 'br', 'hr', 'a',
      'figure', 'figcaption', 'img', 'dl', 'dt', 'dd', 'abbr', 'cite', 'q', 'mark',
      ...(keepTables ? TABLE_TAGS : []),
    ],
    allowedAttributes: {
      a: ['href'],
      img: ['src', 'alt', 'width', 'height'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      abbr: ['title'],
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    // The article title becomes the page title, so in-body h1s become h2s.
    transformTags: { h1: 'h2' },
    exclusiveFilter: (frame) =>
      // Drop tracking pixels and empty wrappers.
      (frame.tag === 'img' && (frame.attribs.width === '1' || frame.attribs.height === '1')) ||
      (['p', 'figure', 'li'].includes(frame.tag) && !frame.text.trim() && !frame.mediaChildren?.length),
  });
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230));
}
