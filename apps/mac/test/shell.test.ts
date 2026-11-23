import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCode } from '../src/deepLink';
import type { Pending, RunResult } from '../src/loop';
import { createPoller, createTickLoop, MAX_OFFLINE_TICKS } from '../src/poller';
import {
  deviceName,
  formatLastPrinted,
  hostLabel,
  mergeSettings,
  confirmDetail,
  failureKey,
  needsPairConfirmation,
  normalizeSettings,
  normalizeUnreported,
  unreportedFromPending,
  parseDefaults,
  safeApiOrigin,
  settingsUrl,
  truncateError,
} from '../src/settings';
import { removeTemp, writeTemp } from '../src/system';

describe('normalizeCode', () => {
  it('uppercases and drops one dash', () => {
    expect(normalizeCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(normalizeCode('ABCD2345')).toBe('ABCD2345');
  });
  it('rejects bad characters and lengths', () => {
    expect(normalizeCode('ABCD234')).toBeNull();
    expect(normalizeCode('ABCD23456')).toBeNull();
    expect(normalizeCode('ABCD234O')).toBeNull(); // O is not in the alphabet
    expect(normalizeCode('')).toBeNull();
  });
  it('ignores every dash and whitespace character, nothing else', () => {
    expect(normalizeCode('K7P2 9QXM')).toBe('K7P29QXM');
    expect(normalizeCode('K7P2-9QXM')).toBe('K7P29QXM');
    expect(normalizeCode('K7-P29-QXM')).toBe('K7P29QXM');
    expect(normalizeCode(' k7p2 - 9qxm\n')).toBe('K7P29QXM');
    expect(normalizeCode('K7P2+9QXM')).toBeNull();
    expect(normalizeCode('K7P2/9QXM')).toBeNull();
    expect(normalizeCode('K7P2_9QXM')).toBeNull();
    expect(normalizeCode('K7P2-9QXMA')).toBeNull(); // 9 characters
    expect(normalizeCode('K7P2-9QX')).toBeNull(); // 7 characters
  });
});

describe('defaults, failure key, confirm detail', () => {
  it('parseDefaults accepts only safe origins', () => {
    expect(parseDefaults({ api: 'https://paperbrew.example/x' })).toEqual({ api: 'https://paperbrew.example' });
    expect(parseDefaults({ api: 'http://localhost:5173' })).toEqual({ api: 'http://localhost:5173' });
    expect(parseDefaults({ api: 'http://paperbrew.example' })).toEqual({ api: null });
    expect(parseDefaults(null)).toEqual({ api: null });
    expect(parseDefaults('x')).toEqual({ api: null });
  });
  it('failureKey separates issues and messages', () => {
    expect(failureKey('a', 'boom')).toBe(failureKey('a', 'boom'));
    expect(failureKey('a', 'boom')).not.toBe(failureKey('b', 'boom'));
    expect(failureKey('a', 'boom')).not.toBe(failureKey('a', 'bang'));
    expect(failureKey(undefined, 'boom')).not.toBe(failureKey('a', 'boom'));
  });
  it('confirmDetail mentions the replacement only when already connected', () => {
    expect(confirmDetail(false)).not.toMatch(/replaces/);
    expect(confirmDetail(true)).toMatch(/This replaces your current connection\./);
  });
});

describe('settings', () => {
  it('defaults and drops malformed fields', () => {
    expect(normalizeSettings(null)).toEqual({ api: null, printer: null, lastPrintedAt: null, loginItemInit: false, unreportedPrinted: null });
    expect(normalizeSettings({ api: 'http://evil.example', printer: 5, lastPrintedAt: 'nope', loginItemInit: 'yes' })).toEqual({
      api: null, printer: null, lastPrintedAt: null, loginItemInit: false, unreportedPrinted: null,
    });
  });
  it('keeps valid fields and reduces api to its origin', () => {
    const s = normalizeSettings({ api: 'https://paperbrew.example/app?x=1', printer: 'HP', lastPrintedAt: '2026-11-22T10:00:00Z', loginItemInit: true, unreportedPrinted: null });
    expect(s).toEqual({ api: 'https://paperbrew.example', printer: 'HP', lastPrintedAt: '2026-11-22T10:00:00Z', loginItemInit: true, unreportedPrinted: null });
  });
  it('merge applies a patch and null resets a field', () => {
    const base = normalizeSettings({ api: 'http://localhost:5173', printer: 'HP' });
    expect(mergeSettings(base, { printer: null }).printer).toBeNull();
    expect(mergeSettings(base, { printer: null }).api).toBe('http://localhost:5173');
  });
  it('safeApiOrigin: https anywhere, http only on localhost, no credentials', () => {
    expect(safeApiOrigin('https://a.example')).toBe('https://a.example');
    expect(safeApiOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(safeApiOrigin('http://a.example')).toBeNull();
    expect(safeApiOrigin('https://u:p@a.example')).toBeNull();
    expect(safeApiOrigin('javascript:alert(1)')).toBeNull();
    expect(safeApiOrigin(undefined)).toBeNull();
  });
  it('settingsUrl', () => {
    expect(settingsUrl('https://a.example')).toBe('https://a.example/app/settings');
    expect(settingsUrl(null)).toBeNull();
  });
  it('deviceName strips .local', () => {
    expect(deviceName('Tomers-MacBook-Pro.local')).toBe('Tomers-MacBook-Pro');
    expect(deviceName('Studio.LOCAL')).toBe('Studio');
    expect(deviceName('.local')).toBe('Mac');
    expect(deviceName('')).toBe('Mac');
  });
  it('confirmation is needed for everything except localhost', () => {
    expect(needsPairConfirmation('http://localhost:5173', false)).toBe(false);
    expect(needsPairConfirmation('https://paperbrew.example', false)).toBe(true);
    expect(needsPairConfirmation('https://localhost.evil.example', false)).toBe(true);
    expect(needsPairConfirmation('http://127.0.0.1:5173', false)).toBe(true);
    // A packaged app confirms even for localhost.
    expect(needsPairConfirmation('http://localhost:5173', true)).toBe(true);
    expect(hostLabel('https://paperbrew.example')).toBe('paperbrew.example');
    expect(hostLabel('https://paperbrew.example:8443')).toBe('paperbrew.example:8443');
  });
  it('formatLastPrinted and truncateError', () => {
    expect(formatLastPrinted(null)).toBeNull();
    expect(formatLastPrinted('garbage')).toBeNull();
    expect(formatLastPrinted('2026-11-22T10:00:00Z', 'en-US')).toMatch(/^Last printed Nov 2[12], 2026/);
    expect(truncateError('a\n  b')).toBe('a b');
    const long = truncateError('x'.repeat(500));
    expect(long.length).toBe(200);
    expect(long.endsWith('…')).toBe(true);
  });
});

const offline = (pending: Pending): RunResult => ({ outcome: 'offline', pending });

describe('createPoller', () => {
  it('keeps pending between ticks and passes it back in', async () => {
    const run = vi.fn<(p: Pending) => Promise<RunResult>>()
      .mockResolvedValueOnce(offline({ id: 'a', layout: 'flat' }))
      .mockResolvedValueOnce({ outcome: 'printed', pending: null });
    const p = createPoller({ run });
    await p.tick();
    expect(p.pending).toEqual({ id: 'a', layout: 'flat' });
    await p.tick();
    expect(run).toHaveBeenLastCalledWith({ id: 'a', layout: 'flat' }, undefined);
    expect(p.pending).toBeNull();
  });

  it('never runs two ticks at once', async () => {
    let release!: (r: RunResult) => void;
    const run = vi.fn(() => new Promise<RunResult>((res) => { release = res; }));
    const p = createPoller({ run });
    const first = p.tick();
    expect(p.busy).toBe(true);
    expect(await p.tick()).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    release({ outcome: 'idle', pending: null });
    await first;
    expect(p.busy).toBe(false);
    release = () => {};
    void p.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('drops the same unprinted pending after 5 offline ticks in a row', async () => {
    const job = { id: 'a', layout: 'booklet' as const };
    const p = createPoller({ run: async () => offline(job) });
    for (let i = 1; i < MAX_OFFLINE_TICKS; i++) {
      await p.tick();
      expect(p.pending).toEqual(job);
    }
    await p.tick();
    expect(p.pending).toBeNull();
  });

  it('a different issue or a non-offline result restarts the count', async () => {
    const results: RunResult[] = [
      offline({ id: 'a', layout: 'flat' }), offline({ id: 'a', layout: 'flat' }), offline({ id: 'a', layout: 'flat' }), offline({ id: 'a', layout: 'flat' }),
      { outcome: 'idle', pending: null },
      offline({ id: 'a', layout: 'flat' }), offline({ id: 'a', layout: 'flat' }), offline({ id: 'a', layout: 'flat' }), offline({ id: 'a', layout: 'flat' }),
    ];
    const p = createPoller({ run: async () => results.shift()! });
    for (let i = 0; i < 9; i++) await p.tick();
    expect(p.pending).toEqual({ id: 'a', layout: 'flat' });
  });

  it('never drops a pending that already printed', async () => {
    const job = { id: 'a', layout: 'flat' as const, printed: true as const };
    const p = createPoller({ run: async () => offline(job) });
    for (let i = 0; i < 20; i++) await p.tick();
    expect(p.pending).toEqual(job);
  });

  it('reset forgets the pending issue', async () => {
    const p = createPoller({ run: async () => offline({ id: 'a', layout: 'flat' }) });
    await p.tick();
    p.reset();
    expect(p.pending).toBeNull();
  });

  it('turns a thrown error into a failed result', async () => {
    const p = createPoller({ run: async () => { throw new Error('boom'); } });
    expect(await p.tick()).toEqual({ outcome: 'failed', pending: null, error: 'boom' });
    expect(p.busy).toBe(false);
  });
});

describe('persisting a printed-but-unreported issue', () => {
  it('only a printed pending is persisted', () => {
    expect(unreportedFromPending({ id: 'a', layout: 'booklet', printed: true })).toEqual({ id: 'a', layout: 'booklet' });
    expect(unreportedFromPending({ id: 'a', layout: 'booklet' })).toBeNull();
    expect(unreportedFromPending(null)).toBeNull();
  });
  it('normalizeUnreported validates what comes back from disk', () => {
    expect(normalizeUnreported({ id: 'a', layout: 'flat' })).toEqual({ id: 'a', layout: 'flat' });
    expect(normalizeUnreported({ id: '', layout: 'flat' })).toBeNull();
    expect(normalizeUnreported({ id: 'a', layout: 'poster' })).toBeNull();
    expect(normalizeUnreported({ id: 5, layout: 'flat' })).toBeNull();
    expect(normalizeUnreported('x')).toBeNull();
    expect(normalizeUnreported(null)).toBeNull();
  });
  it('round-trips through settings normalize/merge', () => {
    const s = mergeSettings(normalizeSettings({}), { unreportedPrinted: { id: 'a', layout: 'booklet' } });
    expect(normalizeSettings(JSON.parse(JSON.stringify(s))).unreportedPrinted).toEqual({ id: 'a', layout: 'booklet' });
    expect(mergeSettings(s, { unreportedPrinted: null }).unreportedPrinted).toBeNull();
  });

  const printed: Pending = { id: 'a', layout: 'booklet', printed: true };
  it('onPendingChange fires only on real changes and on reset, not on restore', async () => {
    const seen: Pending[] = [];
    const results: RunResult[] = [
      { outcome: 'offline', pending: printed },
      { outcome: 'offline', pending: { ...printed } }, // same issue again: no change
      { outcome: 'printed', pending: null },
    ];
    const p = createPoller({ run: async () => results.shift()!, onPendingChange: (x) => seen.push(x) });
    p.restore(printed);
    expect(seen).toEqual([]);
    expect(p.pending).toEqual(printed);
    await p.tick();
    expect(seen).toEqual([]); // still the same printed issue
    await p.tick();
    await p.tick();
    expect(seen).toEqual([null]); // reported: cleared
  });
  it('a restored printed pending is handed to run, and reset clears it', async () => {
    const seen: Pending[] = [];
    const run = vi.fn(async (_p: Pending, _c: void): Promise<RunResult> => ({ outcome: 'offline', pending: printed }));
    const p = createPoller({ run, onPendingChange: (x) => seen.push(x) });
    p.restore(printed);
    await p.tick();
    expect(run).toHaveBeenCalledWith(printed, undefined);
    p.reset();
    expect(p.pending).toBeNull();
    expect(seen).toEqual([null]);
  });
  it('reports a new printed pending as it appears', async () => {
    const seen: Pending[] = [];
    const p = createPoller({
      run: async () => ({ outcome: 'offline', pending: printed }) as RunResult,
      onPendingChange: (x) => seen.push(x),
    });
    await p.tick();
    expect(seen).toEqual([printed]);
  });
});

describe('connection generation', () => {
  function deferred() {
    let resolve!: (r: RunResult) => void;
    const promise = new Promise<RunResult>((res) => { resolve = res; });
    return { promise, resolve };
  }

  it('discards a tick that finished after reset(): no pending, no offline count, result null', async () => {
    const d = deferred();
    const p = createPoller({ run: () => d.promise });
    const gen = p.generation;
    const t = p.tick();
    p.reset();
    expect(p.generation).toBe(gen + 1);
    d.resolve(offline({ id: 'old', layout: 'flat' }));
    expect(await t).toBeNull();
    expect(p.pending).toBeNull();
    expect(p.busy).toBe(false);
  });

  it('a discarded unauthorized result is not returned (so it cannot clear the new token)', async () => {
    const d = deferred();
    const p = createPoller({ run: () => d.promise });
    const t = p.tick();
    p.reset();
    d.resolve({ outcome: 'unauthorized', pending: null });
    expect(await t).toBeNull();
  });

  it('stays busy until the stale tick finishes, then the next tick works normally', async () => {
    const d = deferred();
    const run = vi.fn<(p: Pending) => Promise<RunResult>>()
      .mockReturnValueOnce(d.promise)
      .mockResolvedValueOnce({ outcome: 'printed', pending: null });
    const p = createPoller({ run });
    const t = p.tick();
    p.reset();
    expect(p.busy).toBe(true);
    expect(await p.tick()).toBeNull(); // old tick still running
    d.resolve({ outcome: 'idle', pending: null });
    await t;
    expect(await p.tick()).toEqual({ outcome: 'printed', pending: null });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('passes the tick context through to run', async () => {
    const run = vi.fn(async (_p: Pending, _c: { n: number }): Promise<RunResult> => ({ outcome: 'idle', pending: null }));
    const p = createPoller<{ n: number }>({ run });
    await p.tick({ n: 7 });
    expect(run).toHaveBeenCalledWith(null, { n: 7 });
  });
});

describe('createTickLoop', () => {
  it('drops a plain request during a running tick', async () => {
    let release!: () => void;
    const once = vi.fn(() => new Promise<void>((res) => { release = res; }));
    const request = createTickLoop(once);
    const first = request();
    await request();
    release();
    await first;
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('a forced request during a running tick runs again right after it', async () => {
    const releases: Array<() => void> = [];
    const once = vi.fn(() => new Promise<void>((res) => { releases.push(res); }));
    const request = createTickLoop(once);
    const first = request();
    await request(true);
    expect(once).toHaveBeenCalledTimes(1);
    releases[0]();
    await vi.waitFor(() => expect(once).toHaveBeenCalledTimes(2));
    releases[1]();
    await first;
    expect(once).toHaveBeenCalledTimes(2);
  });

  it('can run again after finishing, and survives a failing tick', async () => {
    const once = vi.fn(async () => {});
    const request = createTickLoop(once);
    await request();
    await request();
    expect(once).toHaveBeenCalledTimes(2);
    const bad = createTickLoop(async () => { throw new Error('x'); });
    await expect(bad()).rejects.toThrow('x');
    await expect(bad()).rejects.toThrow('x'); // not stuck "ticking"
  });
});

describe('writeTemp / removeTemp', () => {
  it('writes into a private fresh directory and removes the whole directory', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'pb-test-'));
    try {
      const a = await writeTemp(new Uint8Array([1, 2, 3]), base);
      const b = await writeTemp(new Uint8Array([4]), base);
      expect(path.dirname(a)).not.toBe(path.dirname(b));
      expect(path.dirname(path.dirname(a))).toBe(base);
      expect(path.isAbsolute(a)).toBe(true);
      expect((await stat(path.dirname(a))).mode & 0o777).toBe(0o700);
      expect([...(await readFile(a))]).toEqual([1, 2, 3]);
      await removeTemp(a);
      await expect(stat(path.dirname(a))).rejects.toThrow();
      await expect(stat(path.dirname(b))).resolves.toBeTruthy();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('refuses to remove a directory that is not ours', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'pb-test-'));
    try {
      await removeTemp(path.join(base, 'x.pdf')); // dirname = base, not prefixed paperbrew-
      await expect(stat(base)).resolves.toBeTruthy();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
