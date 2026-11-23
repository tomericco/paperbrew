import type { Layout } from './lp';

/** The device was revoked (401): stop and ask the user to pair again. */
export class UnauthorizedError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Network failure, timeout, or a 5xx answer: worth retrying later. */
export class OfflineError extends Error {
  constructor(message = 'offline') {
    super(message);
    this.name = 'OfflineError';
  }
}

/** 404: the issue is no longer this device's (timed out and swept, or reprinted). Drop it. */
export class GoneError extends Error {
  constructor(message = 'issue is no longer ours') {
    super(message);
    this.name = 'GoneError';
  }
}

export type ClaimedJob = { id: string; layout: Layout };

const SHORT_TIMEOUT_MS = 30_000;
const PDF_TIMEOUT_MS = 120_000;

/**
 * `base` is `<api origin>/api`; routes are `${base}/agent/...`. Never logs tokens or bodies.
 * Every request has a timeout so a hung connection cannot stall the poll loop; a timeout is an OfflineError.
 */
export function createApi(base: string, token: string | null, fetchImpl: typeof fetch = fetch) {
  async function request(
    path: string,
    init: { method: 'GET' | 'POST'; json?: unknown; timeoutMs: number },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    try {
      return await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers,
        body,
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch {
      throw new OfflineError('network error');
    }
  }

  // Statuses that mean the same thing on every authenticated route.
  function common(res: Response): void {
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status >= 500) throw new OfflineError(`server error ${res.status}`);
  }

  return {
    async pair(code: string, name: string): Promise<{ token: string; deviceId: string }> {
      const res = await request('/agent/pair', { method: 'POST', json: { code, name }, timeoutMs: SHORT_TIMEOUT_MS });
      if (res.status === 410) throw new Error('code expired or used');
      if (res.status >= 500) throw new OfflineError(`server error ${res.status}`);
      if (res.status !== 201) throw new Error(`unexpected status ${res.status}`);
      const data: unknown = await res.json().catch(() => null);
      const d = data as { token?: unknown; deviceId?: unknown } | null;
      if (!d || typeof d.token !== 'string' || typeof d.deviceId !== 'string') throw new Error('unexpected pair response');
      return { token: d.token, deviceId: d.deviceId };
    },

    async claim(): Promise<ClaimedJob | null> {
      const res = await request('/agent/jobs/claim', { method: 'POST', timeoutMs: SHORT_TIMEOUT_MS });
      common(res);
      if (res.status === 204) return null;
      if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);
      const d = (await res.json().catch(() => null)) as { id?: unknown; layout?: unknown } | null;
      if (!d || typeof d.id !== 'string' || (d.layout !== 'flat' && d.layout !== 'booklet')) {
        throw new Error('unexpected claim response');
      }
      return { id: d.id, layout: d.layout };
    },

    /** 200 -> bytes; 204 -> null (nothing left to print, already marked printed: do not report). */
    async downloadPdf(id: string): Promise<Uint8Array | null> {
      const res = await request(`/agent/issues/${encodeURIComponent(id)}/pdf`, { method: 'GET', timeoutMs: PDF_TIMEOUT_MS });
      common(res);
      if (res.status === 204) return null;
      if (res.status === 404) throw new GoneError();
      if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);
      try {
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        throw new OfflineError('download interrupted');
      }
    },

    async report(id: string, r: { ok: boolean; error?: string }): Promise<void> {
      const res = await request(`/agent/issues/${encodeURIComponent(id)}/result`, {
        method: 'POST',
        json: r,
        timeoutMs: SHORT_TIMEOUT_MS,
      });
      common(res);
      if (res.status === 404) throw new GoneError();
      if (res.status < 200 || res.status >= 300) throw new Error(`unexpected status ${res.status}`);
    },
  };
}

export type Api = ReturnType<typeof createApi>;
