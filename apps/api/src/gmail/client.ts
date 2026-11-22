// Google OAuth and the Gmail REST API. Only fixed Google hosts are called, so plain fetch is fine here
// (safeFetch is for user-supplied URLs). Errors never carry tokens, codes or the client secret.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly';
const METADATA_HEADERS = ['From', 'Subject', 'List-Unsubscribe', 'List-Id', 'Message-ID', 'Date'];

/** The refresh token was revoked or expired, or Gmail rejected the access token. The user must reconnect. */
export class GmailAuthError extends Error {
  constructor(message = 'Gmail authorization failed') {
    super(message);
    this.name = 'GmailAuthError';
  }
}

/** The start history id is too old; the caller must fall back to a full scan. */
export class HistoryExpiredError extends Error {
  constructor() {
    super('Gmail history id expired');
    this.name = 'HistoryExpiredError';
  }
}

export type GmailPart = {
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

export type GmailMessage = { id: string; payload: GmailPart };

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  return { clientId, clientSecret };
}

export function authUrl(state: string, redirectUri: string): string {
  const { clientId } = clientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string }> {
  const { clientId, clientSecret } = clientCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...form }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 400 && body?.error === 'invalid_grant') throw new GmailAuthError('Google rejected the grant');
    throw new Error(`Google token endpoint returned ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error('Google token endpoint returned no access token');
  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return t.access_token;
}

/** Best effort: disconnecting must succeed even if Google is unreachable or the token is already dead. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // ignored on purpose
  }
}

async function gmailGet<T>(accessToken: string, path: string, params?: URLSearchParams): Promise<T> {
  const query = params && [...params].length ? `?${params}` : '';
  const res = await fetch(`${GMAIL}${path}${query}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) throw new GmailAuthError();
  if (res.status === 404 && path === '/history') throw new HistoryExpiredError();
  if (!res.ok) throw new Error(`Gmail ${path.split('/')[1] ?? ''} request returned ${res.status}`);
  return (await res.json()) as T;
}

export function getProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  return gmailGet(accessToken, '/profile');
}

type HistoryPage = {
  history?: { messagesAdded?: { message: { id: string } }[] }[];
  nextPageToken?: string;
  historyId?: string;
};

export async function listHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ messageIds: string[]; historyId: string }> {
  const ids = new Set<string>();
  let historyId = startHistoryId;
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await gmailGet<HistoryPage>(accessToken, '/history', params);
    for (const h of page.history ?? []) for (const added of h.messagesAdded ?? []) ids.add(added.message.id);
    if (page.historyId) historyId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { messageIds: [...ids], historyId };
}

const MAX_PAGE = 500; // Gmail's cap on maxResults

/** Up to `max` message ids matching `q`, following nextPageToken; de-duplicated, in Gmail's order. */
export async function listMessages(accessToken: string, q: string, max: number): Promise<string[]> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  while (ids.size < max) {
    const params = new URLSearchParams({ q, maxResults: String(Math.min(MAX_PAGE, max - ids.size)) });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await gmailGet<{ messages?: { id: string }[]; nextPageToken?: string }>(
      accessToken,
      '/messages',
      params,
    );
    for (const m of page.messages ?? []) if (ids.size < max) ids.add(m.id);
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return [...ids];
}

export function getMessage(accessToken: string, id: string, format: 'metadata' | 'full'): Promise<GmailMessage> {
  const params = new URLSearchParams({ format });
  if (format === 'metadata') for (const h of METADATA_HEADERS) params.append('metadataHeaders', h);
  return gmailGet(accessToken, `/messages/${encodeURIComponent(id)}`, params);
}
