const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{8}$`);

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

  const code = rawCode.trim().toUpperCase().replace('-', '');
  if (!CODE_RE.test(code)) return null;

  let api: URL;
  try {
    api = new URL(rawApi);
  } catch {
    return null;
  }
  if (api.username || api.password) return null;
  const okHost =
    api.protocol === 'https:' || (api.protocol === 'http:' && api.hostname === 'localhost');
  if (!okHost) return null;

  return { code, api: api.origin };
}
