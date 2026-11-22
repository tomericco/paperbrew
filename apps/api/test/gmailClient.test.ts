import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authUrl,
  exchangeCode,
  getMessage,
  getProfile,
  GmailAuthError,
  HistoryExpiredError,
  listHistory,
  listMessages,
  refreshAccessToken,
  revokeToken,
} from '../src/gmail/client.js';

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('authUrl', () => {
  it('asks for offline readonly access with consent and carries the state', () => {
    const url = authUrl('state-123', 'https://app.example/cb');
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('scope=openid+email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly');
    expect(url).toContain('state=state-123');
    expect(url).toContain('client_id=client-id');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example%2Fcb');
    expect(url).toContain('response_type=code');
  });
});

describe('exchangeCode', () => {
  it('returns both tokens', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'at', refresh_token: 'rt' }));
    await expect(exchangeCode('code', 'https://app.example/cb')).resolves.toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(String(init.body)).toContain('grant_type=authorization_code');
  });

  it('returns a null refresh token when Google sends none', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'at' }));
    await expect(exchangeCode('code', 'r')).resolves.toEqual({ accessToken: 'at', refreshToken: null });
  });
});

describe('refreshAccessToken', () => {
  it('returns the new access token', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'fresh' }));
    await expect(refreshAccessToken('rt')).resolves.toBe('fresh');
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('grant_type=refresh_token');
  });

  it('rejects with GmailAuthError on invalid_grant', async () => {
    fetchMock.mockResolvedValue(json({ error: 'invalid_grant' }, 400));
    await expect(refreshAccessToken('rt')).rejects.toBeInstanceOf(GmailAuthError);
  });

  it('rejects with a plain Error on a 500, without leaking secrets', async () => {
    fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));
    const err = await refreshAccessToken('secret-refresh-token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GmailAuthError);
    expect((err as Error).message).toContain('500');
    expect((err as Error).message).not.toContain('secret-refresh-token');
    expect((err as Error).message).not.toContain('client-secret');
  });
});

describe('revokeToken', () => {
  it('never throws, on a network error or a bad status', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(revokeToken('t')).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(json({}, 400));
    await expect(revokeToken('t')).resolves.toBeUndefined();
  });
});

describe('gmail calls', () => {
  it('getProfile sends the bearer token', async () => {
    fetchMock.mockResolvedValue(json({ emailAddress: 'a@b.c', historyId: '42' }));
    await expect(getProfile('tok')).resolves.toEqual({ emailAddress: 'a@b.c', historyId: '42' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('a 401 is a GmailAuthError', async () => {
    fetchMock.mockResolvedValue(json({}, 401));
    await expect(getProfile('tok')).rejects.toBeInstanceOf(GmailAuthError);
  });

  it('other failures are plain Errors with the status and no token', async () => {
    fetchMock.mockResolvedValue(json({}, 503));
    const err = await getProfile('tok-secret').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GmailAuthError);
    expect((err as Error).message).toContain('503');
    expect((err as Error).message).not.toContain('tok-secret');
  });

  it('listMessages passes q and maxResults and returns ids', async () => {
    fetchMock.mockResolvedValue(json({ messages: [{ id: 'm1' }, { id: 'm2' }] }));
    await expect(listMessages('tok', 'category:promotions', 50)).resolves.toEqual(['m1', 'm2']);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/gmail/v1/users/me/messages');
    expect(url.searchParams.get('q')).toBe('category:promotions');
    expect(url.searchParams.get('maxResults')).toBe('50');
  });

  it('listMessages returns an empty list when there are no messages', async () => {
    fetchMock.mockResolvedValue(json({ resultSizeEstimate: 0 }));
    await expect(listMessages('tok', 'q', 10)).resolves.toEqual([]);
  });

  it('getMessage metadata asks for the header set', async () => {
    fetchMock.mockResolvedValue(json({ id: 'm1', payload: { mimeType: 'text/html' } }));
    await expect(getMessage('tok', 'm1', 'metadata')).resolves.toEqual({
      id: 'm1',
      payload: { mimeType: 'text/html' },
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/gmail/v1/users/me/messages/m1');
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(url.searchParams.getAll('metadataHeaders')).toEqual([
      'From',
      'Subject',
      'List-Unsubscribe',
      'List-Id',
      'Message-ID',
      'Date',
    ]);
  });

  it('getMessage full does not send metadataHeaders', async () => {
    fetchMock.mockResolvedValue(json({ id: 'm1', payload: { mimeType: 'text/html' } }));
    await getMessage('tok', 'm1', 'full');
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('format')).toBe('full');
    expect(url.searchParams.has('metadataHeaders')).toBe(false);
  });
});

describe('listHistory', () => {
  it('rejects with HistoryExpiredError on 404', async () => {
    fetchMock.mockResolvedValue(json({}, 404));
    await expect(listHistory('tok', '1')).rejects.toBeInstanceOf(HistoryExpiredError);
  });

  it('follows pages, de-duplicates ids and returns the last historyId', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          history: [{ messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] }],
          nextPageToken: 'p2',
          historyId: '100',
        }),
      )
      .mockResolvedValueOnce(
        json({
          history: [{ messagesAdded: [{ message: { id: 'b' } }, { message: { id: 'c' } }] }, { messages: [] }],
          historyId: '200',
        }),
      );
    await expect(listHistory('tok', '50')).resolves.toEqual({ messageIds: ['a', 'b', 'c'], historyId: '200' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = new URL(fetchMock.mock.calls[0][0]);
    expect(first.searchParams.get('startHistoryId')).toBe('50');
    expect(first.searchParams.get('historyTypes')).toBe('messageAdded');
    expect(first.searchParams.has('pageToken')).toBe(false);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('pageToken')).toBe('p2');
  });

  it('keeps the start id when Google returns no historyId and no history', async () => {
    fetchMock.mockResolvedValue(json({}));
    await expect(listHistory('tok', '50')).resolves.toEqual({ messageIds: [], historyId: '50' });
  });
});
