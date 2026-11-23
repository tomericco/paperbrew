import { countWords, NEWSLETTER_MIN_WORDS } from '../inbound/plan.js';

export const PROSE_RATIO_MIN = 0.7;

/** The lowercased address out of `"Name <a@b>"` (or a bare address). */
export function senderEmail(from: string): string {
  const m = from.match(/<([^<>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** `blocked` holds lowercased addresses. */
export function passesMetadataRules(
  meta: { listUnsubscribe: string | null; listId: string | null; from: string },
  blocked: Set<string>,
): { ok: boolean; reason: string } {
  if (!meta.listUnsubscribe && !meta.listId) return { ok: false, reason: 'not-a-list' };
  if (blocked.has(senderEmail(meta.from))) return { ok: false, reason: 'blocked-sender' };
  return { ok: true, reason: 'ok' };
}

/** Removes `<...>` tags in one pass; an unterminated `<` and everything after it is dropped. */
function stripTags(html: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = html.indexOf('<', pos);
    if (open === -1) return out + html.slice(pos);
    out += html.slice(pos, open) + ' ';
    const close = html.indexOf('>', open);
    if (close === -1) return out;
    pos = close + 1;
  }
}

/**
 * Words inside `<a>...</a>`, found with one forward pass (every search starts where the last
 * ended), so large or malformed html stays linear. An anchor that never closes counts for nothing.
 */
function anchorWords(html: string): number {
  const lower = html.toLowerCase();
  let words = 0;
  let pos = 0;
  for (;;) {
    const open = lower.indexOf('<a', pos);
    if (open === -1) return words;
    const next = lower.charAt(open + 2);
    if (next !== '>' && !/\s/.test(next)) {
      pos = open + 2;
      continue;
    }
    const tagEnd = lower.indexOf('>', open);
    if (tagEnd === -1) return words;
    let close = lower.indexOf('</a', tagEnd);
    while (close !== -1 && !/[>\s]/.test(lower.charAt(close + 3))) close = lower.indexOf('</a', close + 3);
    if (close === -1) return words;
    words += countWords(stripTags(html.slice(tagEnd + 1, close)));
    pos = close + 3;
  }
}

export function passesBodyRules(body: { html: string; text: string }): { ok: boolean; reason: string } {
  const total = countWords(body.text);
  if (total < NEWSLETTER_MIN_WORDS) return { ok: false, reason: 'too-short' };
  const ratio = body.html ? 1 - Math.min(anchorWords(body.html) / total, 1) : 1;
  if (ratio < PROSE_RATIO_MIN) return { ok: false, reason: 'mostly-links' };
  return { ok: true, reason: 'ok' };
}
