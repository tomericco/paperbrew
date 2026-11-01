import { extractLinks } from '../links/extract.js';

export interface ForwardSplit {
  note: string; // what the user typed above the forwarded message
  forwarded: string | null; // the forwarded message body, if any
  original: { from: string | null; subject: string | null } | null;
}

export interface NewsletterPlan {
  title: string;
  author: string | null;
  html: string;
  text: string;
}

export interface EmailPlan {
  urls: string[]; // links to fetch and save as articles
  newsletter: NewsletterPlan | null; // the email itself, saved as an article
  reason: string;
}

/** A forwarded message must have at least this many words to be saved as an article. */
export const NEWSLETTER_MIN_WORDS = 250;

const FORWARD_MARKERS: RegExp[] = [
  /^[ \t>]*-{3,}\s*Forwarded message\s*-{3,}[ \t]*$/im, // Gmail
  /^[ \t>]*Begin forwarded message:[ \t]*$/im, // Apple Mail
  /^[ \t>]*-{3,}\s*Original Message\s*-{3,}[ \t]*$/im, // older Outlook
  /^[ \t>]*From:[^\n]+\n[ \t>]*(Sent|Date):[^\n]+\n(?:[ \t>]*(?:To|Cc):[^\n]*\n)*[ \t>]*Subject:[^\n]*$/im, // Outlook
];

export function countWords(text: string): number {
  const stripped = text.replace(/https?:\/\/\S+/g, ' ');
  return (stripped.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

function headerValue(block: string, name: string): string | null {
  const m = block.match(new RegExp(`^[ \\t>]*${name}:[ \\t]*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
}

export function splitForward(text: string): ForwardSplit {
  let best: { index: number; length: number } | null = null;
  for (const re of FORWARD_MARKERS) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, length: m[0].length };
  }
  if (!best) return { note: text.trim(), forwarded: null, original: null };

  const note = text.slice(0, best.index).trim();
  // Header lines (From:, Date:, Subject:, To:) follow the marker, sometimes after a blank line
  // (Apple Mail); the forwarded body starts at the first blank line after them.
  const lines = text.slice(best.index).split(/\r?\n/);
  let i = 0;
  if (!/^[ \t>]*From:/i.test(lines[0])) i = 1; // skip a marker line like "Begin forwarded message:"
  while (i < lines.length && /^[ \t>]*$/.test(lines[i])) i++;
  const headerStart = i;
  while (i < lines.length && !/^[ \t>]*$/.test(lines[i])) i++;
  const headerBlock = lines.slice(Math.max(0, headerStart - 1), i).join('\n');
  const body = lines.slice(i).join('\n').trim();

  return {
    note,
    forwarded: body,
    original: {
      from: headerValue(headerBlock, 'From'),
      subject: headerValue(headerBlock, 'Subject'),
    },
  };
}

export function cleanSubject(subject: string): string {
  return subject.replace(/^\s*((fwd?|fw|tr|wg|rv|i)\s*:\s*)+/i, '').trim();
}

/** "Jane Doe <jane@x.com>" -> "Jane Doe"; "jane@x.com" -> null */
export function displayName(from: string | null): string | null {
  if (!from) return null;
  const name = from.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  return name && !name.includes('@') ? name : null;
}

/**
 * Decide what to save from one email:
 *  - links the user wrote or forwarded in a short message -> fetch each as an article
 *  - a long forwarded newsletter -> save the email itself as an article
 *  - a newsletter sent straight to the Paperbrew address (has List-Unsubscribe) -> save it as an article
 */
export function planEmail(email: {
  subject: string;
  text: string;
  html: string;
  from: string;
  listUnsubscribe?: string | null;
}): EmailPlan {
  const text = email.text || '';
  const split = splitForward(text);

  // 1) Newsletter subscribed directly with the Paperbrew address.
  if (!split.forwarded && email.listUnsubscribe && countWords(text) >= NEWSLETTER_MIN_WORDS) {
    return {
      urls: [],
      newsletter: { title: cleanSubject(email.subject), author: displayName(email.from), html: email.html, text },
      reason: 'direct-newsletter',
    };
  }

  // 2) Forwarded message.
  if (split.forwarded !== null) {
    const noteLinks = extractLinks({ text: split.note });
    if (countWords(split.forwarded) >= NEWSLETTER_MIN_WORDS) {
      return {
        urls: noteLinks,
        newsletter: {
          title: cleanSubject(split.original?.subject ?? email.subject),
          author: displayName(split.original?.from ?? null),
          html: email.html,
          text: split.forwarded,
        },
        reason: noteLinks.length ? 'forwarded-newsletter+note-links' : 'forwarded-newsletter',
      };
    }
    // Short forward ("thought you'd like this: <link>"): take links from both parts.
    const urls = extractLinks({ text: `${split.note}\n${split.forwarded}` });
    return { urls, newsletter: null, reason: urls.length ? 'short-forward-links' : 'nothing-to-save' };
  }

  // 3) A long email with no forward marker (e.g. an auto-forwarding rule): keep the email itself.
  if (countWords(text) >= NEWSLETTER_MIN_WORDS) {
    return {
      urls: [],
      newsletter: { title: cleanSubject(email.subject), author: displayName(email.from), html: email.html, text },
      reason: 'long-email',
    };
  }

  // 4) A short email the user wrote: save its links. HTML anchors first, then bare URLs in text.
  const urls = extractLinks({ html: email.html, text });
  if (urls.length) return { urls, newsletter: null, reason: 'links' };
  return { urls: [], newsletter: null, reason: 'nothing-to-save' };
}
