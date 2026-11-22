import type { GmailMessage, GmailPart } from './client.js';

/** Case-insensitive header lookup on the top-level payload. */
export function header(msg: GmailMessage, name: string): string | null {
  const wanted = name.toLowerCase();
  const found = msg.payload.headers?.find((h) => h.name.toLowerCase() === wanted);
  return found ? found.value : null;
}

function decodeData(part: GmailPart): string {
  const data = part.body?.data;
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  larr: '←',
  rarr: '→',
  zwnj: '',
  zwj: '',
  shy: '',
};

function codePoint(n: number, fallback: string): string {
  const valid = Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff);
  return valid ? String.fromCodePoint(n) : fallback;
}

function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]{1,8})|#(\d{1,8})|([a-z][a-z0-9]{1,15}));/gi, (m, hex, dec, name) => {
    if (hex) return codePoint(parseInt(hex, 16), m);
    if (dec) return codePoint(parseInt(dec, 10), m);
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? m;
  });
}

const SKIPPED_ELEMENTS = new Set(['script', 'style', 'head']);
const BLOCK_CLOSERS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CLOSE_TAG: Record<string, RegExp> = {
  script: /<\/script\b/gi,
  style: /<\/style\b/gi,
  head: /<\/head\b/gi,
};
const TAG_START = /<(\/?)([a-z][a-z0-9]*)/iy;

/**
 * Single pass over the input (every indexOf/regex scan either ends the walk or moves the cursor
 * past what it scanned), so hostile senders cannot make it quadratic. A `<` that does not open
 * a tag, or that has no `>` after it, is literal text. An unterminated comment or script/style/head
 * element drops the rest of the input.
 */
function stripTags(html: string): string {
  const out: string[] = [];
  const lastGt = html.lastIndexOf('>');
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    const next = html.charCodeAt(lt + 1);

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }

    // `<` followed by a letter, `/`, `!` or `?` can open a tag; anything else is text.
    const opensTag =
      (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 47 || next === 33 || next === 63;
    if (!opensTag || lt > lastGt) {
      out.push('<');
      i = lt + 1;
      continue;
    }

    const gt = html.indexOf('>', lt + 1);
    TAG_START.lastIndex = lt;
    const m = TAG_START.exec(html);
    const closing = m?.[1] === '/';
    const name = m ? m[2].toLowerCase() : '';
    i = gt + 1;

    if (m && !closing && SKIPPED_ELEMENTS.has(name) && html[gt - 1] !== '/') {
      const closeRe = CLOSE_TAG[name];
      closeRe.lastIndex = i;
      const found = closeRe.exec(html);
      if (!found) break;
      const closeGt = html.indexOf('>', found.index);
      if (closeGt === -1) break;
      i = closeGt + 1;
    } else if (name === 'br' || (closing && BLOCK_CLOSERS.has(name))) {
      out.push('\n');
    }
  }
  return out.join('');
}

function htmlToText(html: string): string {
  return decodeEntities(stripTags(html))
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[ \t\r\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pulls the readable body out of a Gmail payload. Depth-first: the first text/plain and the
 * first text/html part without a filename win; attachments are ignored. When there is no
 * plain part, text is derived from the html.
 */
export function decodeBody(payload: GmailPart): { html: string; text: string } {
  let html: string | null = null;
  let text: string | null = null;

  const walk = (part: GmailPart): void => {
    if (part.filename) return;
    if (part.mimeType === 'text/plain' && text === null) text = decodeData(part);
    else if (part.mimeType === 'text/html' && html === null) html = decodeData(part);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  const finalHtml: string = html ?? '';
  const finalText: string = text ?? (finalHtml ? htmlToText(finalHtml) : '');
  return { html: finalHtml, text: finalText };
}
