import { randomInt } from 'node:crypto';
import { WORDS } from './words.js';

/** Local parts we never hand out or accept as a mailbox token. */
const RESERVED = new Set([
  'admin',
  'abuse',
  'postmaster',
  'hostmaster',
  'webmaster',
  'root',
  'support',
  'help',
  'info',
  'hello',
  'noreply',
  'no-reply',
  'security',
  'billing',
  'mail',
  'paperbrew',
]);

// Two or more words: a single word like "tomer" is too easy to guess, and the address is the secret.
const TOKEN_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const MIN_LEN = 3;
const MAX_LEN = 40;

export type TokenResult = { ok: true; token: string } | { ok: false; error: string };

/** Validate and canonicalize a mailbox token (trim, lowercase, reserved names, shape). */
export function normalizeToken(input: string): TokenResult {
  const token = input.trim().toLowerCase();
  if (RESERVED.has(token)) return { ok: false, error: 'That address is reserved.' };
  if (token.length < MIN_LEN || token.length > MAX_LEN || !TOKEN_RE.test(token)) {
    return {
      ok: false,
      error: 'Use two or more words joined by hyphens, like amber-otter (letters and numbers, up to 40 characters).',
    };
  }
  return { ok: true, token };
}

/** A fresh token: three random words, e.g. "amber-otter-lantern". */
export function newToken(): string {
  return [0, 1, 2].map(() => WORDS[randomInt(WORDS.length)]).join('-');
}

/** Fill the address template, e.g. "a1b2c3+{token}@inbound.postmarkapp.com". */
export function formatAddress(template: string, token: string): string {
  return template.replace('{token}', token);
}

/**
 * Pull mailbox tokens out of the recipient list.
 * With template "a1b2c3+{token}@inbound.postmarkapp.com":
 * "A1B2C3+Amber-Otter+Trip@inbound.postmarkapp.com" -> "amber-otter" (plus-tags after the token are ignored).
 * Other addresses, malformed tokens and reserved names are skipped; the result is deduped.
 */
export function addressTokens(recipients: string[], template: string): string[] {
  const lowered = template.toLowerCase();
  const at = lowered.indexOf('{token}');
  if (at < 0) return [];
  const prefix = lowered.slice(0, at);
  const suffix = lowered.slice(at + '{token}'.length);

  const tokens = new Set<string>();
  for (const recipient of recipients) {
    const r = recipient.trim().toLowerCase();
    if (r.length <= prefix.length + suffix.length || !r.startsWith(prefix) || !r.endsWith(suffix)) continue;
    const middle = r.slice(prefix.length, r.length - suffix.length).split('+')[0];
    const result = normalizeToken(middle);
    if (result.ok) tokens.add(result.token);
  }
  return [...tokens];
}
