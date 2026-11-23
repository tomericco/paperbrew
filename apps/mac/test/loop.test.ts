import { describe, expect, it, vi } from 'vitest';
import { createApi, GoneError, OfflineError, UnauthorizedError } from '../src/api';
import { runOnce, type LoopDeps, type Pending } from '../src/loop';

const PDF = new Uint8Array([37, 80, 68, 70]);

function makeDeps(over: Partial<Record<string, any>> = {}) {
  const api = {
    pair: vi.fn(),
    claim: vi.fn(async () => ({ id: 'i1', layout: 'booklet' as const })),
    downloadPdf: vi.fn(async () => PDF),
    report: vi.fn(async () => {}),
    ...(over.api ?? {}),
  };
  const print = vi.fn(async (_f: string, _l: string, _p: string | null) => {});
  const writeTemp = vi.fn(async (_b: Uint8Array) => '/tmp/x.pdf');
  const removeTemp = vi.fn(async (_f: string) => {});
  const deps = {
    api,
    print: over.print ?? print,
    writeTemp: over.writeTemp ?? writeTemp,
    removeTemp: over.removeTemp ?? removeTemp,
    printer: over.printer ?? null,
  } as unknown as LoopDeps;
  return { deps, api, print: (over.print ?? print) as typeof print, writeTemp, removeTemp: (over.removeTemp ?? removeTemp) as typeof removeTemp };
}

describe('runOnce', () => {
  it('claim null -> idle', async () => {
    const { deps } = makeDeps({ api: { claim: vi.fn(async () => null) } });
    expect(await runOnce(deps, null)).toEqual({ outcome: 'idle', pending: null });
  });

  it('full success prints with the layout and reports ok', async () => {
    const { deps, api, print, removeTemp } = makeDeps({ printer: 'HP' });
    const r = await runOnce(deps, null);
    expect(r).toEqual({ outcome: 'printed', pending: null });
    expect(print).toHaveBeenCalledWith('/tmp/x.pdf', 'booklet', 'HP');
    expect(api.report).toHaveBeenCalledWith('i1', { ok: true });
    expect(removeTemp).toHaveBeenCalledWith('/tmp/x.pdf');
  });

  it('retries the pending issue first', async () => {
    const { deps, api } = makeDeps();
    const r = await runOnce(deps, { id: 'p9', layout: 'flat' });
    expect(api.claim).not.toHaveBeenCalled();
    expect(api.downloadPdf).toHaveBeenCalledWith('p9');
    expect(r.outcome).toBe('printed');
  });

  it('download OfflineError -> offline, pending kept', async () => {
    const { deps } = makeDeps({ api: { downloadPdf: vi.fn(async () => { throw new OfflineError('x'); }) } });
    const r = await runOnce(deps, null);
    expect(r).toEqual({ outcome: 'offline', pending: { id: 'i1', layout: 'booklet' } });
  });

  it('download null -> printed, no print, no report', async () => {
    const { deps, api, print } = makeDeps({ api: { downloadPdf: vi.fn(async () => null) } });
    const r = await runOnce(deps, null);
    expect(r).toEqual({ outcome: 'printed', pending: null, nothingToPrint: true });
    expect(print).not.toHaveBeenCalled();
    expect(api.report).not.toHaveBeenCalled();
  });

  it('missing printer -> reports failure with printerMissing', async () => {
    const msg = 'lp: The printer or class does not exist.';
    const { deps, api } = makeDeps({ print: vi.fn(async () => { throw new Error(msg); }) });
    const r = await runOnce(deps, null);
    expect(r).toEqual({ outcome: 'failed', pending: null, error: msg, printerMissing: true, issueId: 'i1' });
    expect(api.report).toHaveBeenCalledWith('i1', { ok: false, error: msg });
  });

  it('other print failure -> failed without printerMissing', async () => {
    const { deps, api } = makeDeps({ print: vi.fn(async () => { throw new Error('lp: paper jam'); }) });
    const r = await runOnce(deps, null);
    expect(r.outcome).toBe('failed');
    expect(r.printerMissing).toBeFalsy();
    expect(api.report).toHaveBeenCalledWith('i1', { ok: false, error: 'lp: paper jam' });
  });

  it('removes the temp file on failure too', async () => {
    const { deps, removeTemp } = makeDeps({ print: vi.fn(async () => { throw new Error('boom'); }) });
    await runOnce(deps, null);
    expect(removeTemp).toHaveBeenCalledWith('/tmp/x.pdf');
  });

  it('a removeTemp failure does not change the outcome', async () => {
    const { deps } = makeDeps({ removeTemp: vi.fn(async () => { throw new Error('enoent'); }) });
    expect((await runOnce(deps, null)).outcome).toBe('printed');
  });

  it('claim UnauthorizedError -> unauthorized', async () => {
    const { deps } = makeDeps({ api: { claim: vi.fn(async () => { throw new UnauthorizedError(); }) } });
    expect(await runOnce(deps, null)).toEqual({ outcome: 'unauthorized', pending: null });
  });

  it('download UnauthorizedError drops pending', async () => {
    const { deps } = makeDeps({ api: { downloadPdf: vi.fn(async () => { throw new UnauthorizedError(); }) } });
    expect(await runOnce(deps, { id: 'p', layout: 'flat' })).toEqual({ outcome: 'unauthorized', pending: null });
  });

  it('claim OfflineError -> offline with nothing pending', async () => {
    const { deps } = makeDeps({ api: { claim: vi.fn(async () => { throw new OfflineError('x'); }) } });
    expect(await runOnce(deps, null)).toEqual({ outcome: 'offline', pending: null });
  });

  it('unexpected claim error -> failed with the message', async () => {
    const { deps } = makeDeps({ api: { claim: vi.fn(async () => { throw new Error('unexpected status 400'); }) } });
    expect(await runOnce(deps, null)).toEqual({ outcome: 'failed', pending: null, error: 'unexpected status 400' });
  });

  it('unexpected download error -> failed, no report, pending dropped', async () => {
    const { deps, api } = makeDeps({ api: { downloadPdf: vi.fn(async () => { throw new Error('unexpected status 400'); }) } });
    const r = await runOnce(deps, null);
    expect(r).toEqual({ outcome: 'failed', pending: null, error: 'unexpected status 400', issueId: 'i1' });
    expect(api.report).not.toHaveBeenCalled();
  });

  it('GoneError on download -> idle, pending dropped, no print or report', async () => {
    const { deps, api, print } = makeDeps({ api: { downloadPdf: vi.fn(async () => { throw new GoneError(); }) } });
    const r = await runOnce(deps, { id: 'p', layout: 'flat' });
    expect(r).toEqual({ outcome: 'idle', pending: null });
    expect(print).not.toHaveBeenCalled();
    expect(api.report).not.toHaveBeenCalled();
  });

  it('GoneError on report ok -> idle, pending null', async () => {
    const { deps } = makeDeps({ api: { report: vi.fn(async () => { throw new GoneError(); }) } });
    expect(await runOnce(deps, null)).toEqual({ outcome: 'idle', pending: null });
  });

  it('report ok offline keeps a printed pending; the retry never prints again', async () => {
    const report = vi.fn()
      .mockRejectedValueOnce(new OfflineError('x'))
      .mockResolvedValueOnce(undefined);
    const { deps, api, print, writeTemp } = makeDeps({ api: { report } });
    const first = await runOnce(deps, null);
    expect(first).toEqual({ outcome: 'offline', pending: { id: 'i1', layout: 'booklet', printed: true } });
    const second = await runOnce(deps, first.pending);
    expect(second).toEqual({ outcome: 'printed', pending: null });
    expect(print).toHaveBeenCalledTimes(1);
    expect(writeTemp).toHaveBeenCalledTimes(1);
    expect(api.downloadPdf).toHaveBeenCalledTimes(1);
    expect(api.claim).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenNthCalledWith(2, 'i1', { ok: true });
  });

  describe('printed pending', () => {
    const printed: Pending = { id: 'i1', layout: 'flat', printed: true };
    it('still offline -> offline with the same pending', async () => {
      const { deps, print } = makeDeps({ api: { report: vi.fn(async () => { throw new OfflineError('x'); }) } });
      expect(await runOnce(deps, printed)).toEqual({ outcome: 'offline', pending: printed });
      expect(print).not.toHaveBeenCalled();
    });
    it('Gone -> idle', async () => {
      const { deps } = makeDeps({ api: { report: vi.fn(async () => { throw new GoneError(); }) } });
      expect(await runOnce(deps, printed)).toEqual({ outcome: 'idle', pending: null });
    });
    it('Unauthorized -> unauthorized', async () => {
      const { deps } = makeDeps({ api: { report: vi.fn(async () => { throw new UnauthorizedError(); }) } });
      expect(await runOnce(deps, printed)).toEqual({ outcome: 'unauthorized', pending: null });
    });
  });

  it('report ok:false offline after a print failure -> failed, pending null', async () => {
    const { deps } = makeDeps({
      print: vi.fn(async () => { throw new Error('lp: paper jam'); }),
      api: { report: vi.fn(async () => { throw new OfflineError('x'); }) },
    });
    expect(await runOnce(deps, null)).toEqual({ outcome: 'failed', pending: null, error: 'lp: paper jam', issueId: 'i1' });
  });

  it('report ok:false unauthorized -> unauthorized', async () => {
    const { deps } = makeDeps({
      print: vi.fn(async () => { throw new Error('lp: paper jam'); }),
      api: { report: vi.fn(async () => { throw new UnauthorizedError(); }) },
    });
    expect(await runOnce(deps, null)).toEqual({ outcome: 'unauthorized', pending: null });
  });

  it('a writeTemp failure is reported as a print failure', async () => {
    const { deps, api, print } = makeDeps({ writeTemp: vi.fn(async () => { throw new Error('ENOSPC'); }) });
    const r = await runOnce(deps, null);
    expect(r).toEqual({ outcome: 'failed', pending: null, error: 'ENOSPC', issueId: 'i1' });
    expect(print).not.toHaveBeenCalled();
    expect(api.report).toHaveBeenCalledWith('i1', { ok: false, error: 'ENOSPC' });
  });
});

describe('createApi', () => {
  const res = (status: number, body?: BodyInit | null, headers?: HeadersInit) => new Response(body ?? null, { status, headers });
  const api = (impl: (url: string, init?: RequestInit) => Promise<Response>, token: string | null = 'tok') =>
    createApi('https://x.test/api', token, impl as unknown as typeof fetch);

  it('claim: 204 -> null', async () => {
    expect(await api(async () => res(204)).claim()).toBeNull();
  });
  it('claim: 200 -> job; sends bearer and POSTs to /agent/jobs/claim', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => res(200, JSON.stringify({ id: 'a', layout: 'flat' }), { 'content-type': 'application/json' }));
    expect(await api(f).claim()).toEqual({ id: 'a', layout: 'flat' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://x.test/api/agent/jobs/claim');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('claim: 401 -> UnauthorizedError', async () => {
    await expect(api(async () => res(401)).claim()).rejects.toBeInstanceOf(UnauthorizedError);
  });
  it('claim: fetch throws -> OfflineError', async () => {
    await expect(api(async () => { throw new TypeError('fetch failed'); }).claim()).rejects.toBeInstanceOf(OfflineError);
  });
  it('claim: 5xx -> OfflineError', async () => {
    await expect(api(async () => res(502)).claim()).rejects.toBeInstanceOf(OfflineError);
  });
  it('claim: bad body -> plain Error', async () => {
    const e = await api(async () => res(200, JSON.stringify({ id: 1 }))).claim().catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(OfflineError);
  });
  it('no token -> no authorization header', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => res(204));
    await api(f, null).claim();
    expect(new Headers(f.mock.calls[0]![1]?.headers).get('authorization')).toBeNull();
  });

  it('downloadPdf: 200 -> bytes', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => res(200, PDF));
    expect(await api(f).downloadPdf('abc')).toEqual(PDF);
    expect(f.mock.calls[0]![0]).toBe('https://x.test/api/agent/issues/abc/pdf');
  });
  it('downloadPdf: 204 -> null', async () => {
    expect(await api(async () => res(204)).downloadPdf('a')).toBeNull();
  });
  it('downloadPdf: 503 and 500 -> OfflineError', async () => {
    await expect(api(async () => res(503, null, { 'retry-after': '30' })).downloadPdf('a')).rejects.toBeInstanceOf(OfflineError);
    await expect(api(async () => res(500)).downloadPdf('a')).rejects.toBeInstanceOf(OfflineError);
  });
  it('downloadPdf: 404 -> GoneError, 401 -> UnauthorizedError', async () => {
    await expect(api(async () => res(404)).downloadPdf('a')).rejects.toBeInstanceOf(GoneError);
    await expect(api(async () => res(401)).downloadPdf('a')).rejects.toBeInstanceOf(UnauthorizedError);
  });
  it('downloadPdf: 400 -> plain Error naming the status', async () => {
    const e = await api(async () => res(400)).downloadPdf('a').catch((x) => x);
    expect(e).not.toBeInstanceOf(OfflineError);
    expect(String(e.message)).toContain('400');
  });
  it('downloadPdf: uses a longer timeout than claim', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await api(async () => res(204)).claim();
    await api(async () => res(204)).downloadPdf('a');
    expect(spy.mock.calls.map((c) => c[0])).toEqual([30_000, 120_000]);
    spy.mockRestore();
  });
  it('a timeout counts as OfflineError', async () => {
    const f = async () => { throw new DOMException('timed out', 'TimeoutError'); };
    await expect(api(f).downloadPdf('a')).rejects.toBeInstanceOf(OfflineError);
  });

  it('report: posts the body, 204 resolves', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => res(204));
    await api(f).report('abc', { ok: false, error: 'bad' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://x.test/api/agent/issues/abc/result');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ ok: false, error: 'bad' });
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });
  it('report: 404 -> GoneError, 401 -> UnauthorizedError, 5xx -> OfflineError', async () => {
    await expect(api(async () => res(404)).report('a', { ok: true })).rejects.toBeInstanceOf(GoneError);
    await expect(api(async () => res(401)).report('a', { ok: true })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(api(async () => res(500)).report('a', { ok: true })).rejects.toBeInstanceOf(OfflineError);
  });

  it('pair: 201 -> token and deviceId, no bearer', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => res(201, JSON.stringify({ token: 't', deviceId: 'd' })));
    expect(await api(f, null).pair('ABCD1234', 'My Mac')).toEqual({ token: 't', deviceId: 'd' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://x.test/api/agent/pair');
    expect(JSON.parse(init?.body as string)).toEqual({ code: 'ABCD1234', name: 'My Mac' });
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
  });
  it('pair: 410 -> code expired or used; network -> OfflineError', async () => {
    await expect(api(async () => res(410)).pair('x', 'y')).rejects.toThrow('code expired or used');
    await expect(api(async () => { throw new TypeError('x'); }).pair('x', 'y')).rejects.toBeInstanceOf(OfflineError);
  });
});
