import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCode } from '../src/deepLink';
import type { Pending, RunResult } from '../src/loop';
import { createPoller, MAX_OFFLINE_TICKS } from '../src/poller';
import {
  deviceName,
  formatLastPrinted,
  hostLabel,
  mergeSettings,
  needsPairConfirmation,
  normalizeSettings,
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
});

describe('settings', () => {
  it('defaults and drops malformed fields', () => {
    expect(normalizeSettings(null)).toEqual({ api: null, printer: null, lastPrintedAt: null, loginItemInit: false });
    expect(normalizeSettings({ api: 'http://evil.example', printer: 5, lastPrintedAt: 'nope', loginItemInit: 'yes' })).toEqual({
      api: null, printer: null, lastPrintedAt: null, loginItemInit: false,
    });
  });
  it('keeps valid fields and reduces api to its origin', () => {
    const s = normalizeSettings({ api: 'https://paperbrew.example/app?x=1', printer: 'HP', lastPrintedAt: '2026-11-22T10:00:00Z', loginItemInit: true });
    expect(s).toEqual({ api: 'https://paperbrew.example', printer: 'HP', lastPrintedAt: '2026-11-22T10:00:00Z', loginItemInit: true });
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
    expect(needsPairConfirmation('http://localhost:5173')).toBe(false);
    expect(needsPairConfirmation('https://paperbrew.example')).toBe(true);
    expect(needsPairConfirmation('https://localhost.evil.example')).toBe(true);
    expect(needsPairConfirmation('http://127.0.0.1:5173')).toBe(true);
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
    expect(run).toHaveBeenLastCalledWith({ id: 'a', layout: 'flat' });
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
