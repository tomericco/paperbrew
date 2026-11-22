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
};

function codePoint(n: number, fallback: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
    if (hex) return codePoint(parseInt(hex, 16), m);
    if (dec) return codePoint(parseInt(dec, 10), m);
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? m;
  });
}

function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .replace(/[ \t\r\f\v]+/g, ' ')
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
