const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|ref_src|s_cid|oly_enc_id|oly_anon_id|vero_id|__s)$/i;

/** Unwrap well-known redirect wrappers so we store the real destination. */
function unwrap(u: URL): URL {
  const host = u.hostname.toLowerCase();
  const pick = (param: string) => {
    const v = u.searchParams.get(param);
    try {
      return v ? new URL(v) : null;
    } catch {
      return null;
    }
  };
  if ((host === 'www.google.com' || host === 'google.com') && u.pathname === '/url') return pick('q') ?? pick('url') ?? u;
  if (host.endsWith('safelinks.protection.outlook.com')) return pick('url') ?? u;
  if (host === 'l.facebook.com' || host === 'lm.facebook.com') return pick('u') ?? u;
  if (host === 'www.linkedin.com' && u.pathname.startsWith('/redir/redirect')) return pick('url') ?? u;
  return u;
}

/** Normalize a URL for storage and dedupe. Returns null if it isn't an http(s) URL. */
export function cleanUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    const next = unwrap(u);
    if (next === u) break;
    u = next;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.hostname = u.hostname.toLowerCase();
  let out = u.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}
