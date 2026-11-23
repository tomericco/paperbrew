const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{8}$`);

/**
 * Normalizes a pairing code typed or pasted by a person: uppercase, with every dash and whitespace removed (so
 * "K7P2-9QXM" and "K7P2 9QXM" both work). Null if the rest is not 8 characters from the code alphabet.
 */
export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? code : null;
}

export type PairLink = { code: string; api: string };

/**
 * Parses `paperbrew://pair?code=XXXXXXXX&api=<origin>`. Strict on purpose: the link comes from
 * outside the app, and `api` decides where the pairing code is sent.
 */
export function parsePairLink(link: string): PairLink | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'paperbrew:' || u.hostname !== 'pair') return null;
  if (u.username || u.password || u.port) return null;
  if (u.pathname !== '' && u.pathname !== '/') return null;

  const rawCode = u.searchParams.get('code');
  const rawApi = u.searchParams.get('api');
  if (!rawCode || !rawApi) return null;

  const code = normalizeCode(rawCode);
  if (!code) return null;

  let api: URL;
  try {
    api = new URL(rawApi);
  } catch {
    return null;
  }
  if (api.username || api.password) return null;
  // Callers MUST confirm non-localhost hosts with the user before sending anything to them.
  const okHost =
    api.protocol === 'https:' || (api.protocol === 'http:' && api.hostname === 'localhost');
  if (!okHost) return null;

  return { code, api: api.origin };
}
