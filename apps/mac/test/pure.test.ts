import { describe, expect, it } from 'vitest';
import { lpArgs } from '../src/lp';
import { parsePrinters } from '../src/printers';
import { parsePairLink } from '../src/deepLink';
import { statusText } from '../src/status';

describe('lpArgs', () => {
  it('booklet is two-sided short edge on A4', () => {
    expect(lpArgs('/t/x.pdf', 'booklet', null)).toEqual([
      '-o', 'sides=two-sided-short-edge', '-o', 'media=A4', '/t/x.pdf',
    ]);
  });
  it('adds the printer first', () => {
    expect(lpArgs('/t/x.pdf', 'booklet', 'HP')).toEqual([
      '-d', 'HP', '-o', 'sides=two-sided-short-edge', '-o', 'media=A4', '/t/x.pdf',
    ]);
  });
  it('flat is plain A4', () => {
    expect(lpArgs('/t/x.pdf', 'flat', null)).toEqual(['-o', 'media=A4', '/t/x.pdf']);
    expect(lpArgs('/t/x.pdf', 'flat', 'Brother')).toEqual(['-d', 'Brother', '-o', 'media=A4', '/t/x.pdf']);
  });
});

describe('parsePrinters', () => {
  it('puts the default first and flags it', () => {
    const out = [
      'printer Brother_HL is idle.  enabled since Mon Nov 22 10:00:00 2026',
      'printer HP_LaserJet is idle.  enabled since Mon Nov 22 10:00:00 2026',
      'system default destination: HP_LaserJet',
    ].join('\n');
    expect(parsePrinters(out)).toEqual([
      { name: 'HP_LaserJet', isDefault: true },
      { name: 'Brother_HL', isDefault: false },
    ]);
  });
  it('flags none when there is no default', () => {
    const out = 'printer A is idle.  enabled since x\nprinter B is idle.  enabled since x\nno system default destination\n';
    expect(parsePrinters(out)).toEqual([
      { name: 'A', isDefault: false },
      { name: 'B', isDefault: false },
    ]);
  });
  it('returns an empty list for no printers', () => {
    expect(parsePrinters('lpstat: No destinations added.\nno system default destination\n')).toEqual([]);
    expect(parsePrinters('')).toEqual([]);
  });
});

describe('parsePairLink', () => {
  const ok = (api: string, code = 'K7P29QXM') =>
    `paperbrew://pair?code=${code}&api=${encodeURIComponent(api)}`;
  it('parses an https link', () => {
    expect(parsePairLink('paperbrew://pair?code=K7P29QXM&api=https%3A%2F%2Fpaperbrew.app')).toEqual({
      code: 'K7P29QXM',
      api: 'https://paperbrew.app',
    });
  });
  it('parses http localhost with a port', () => {
    expect(parsePairLink(ok('http://localhost:5173'))).toEqual({ code: 'K7P29QXM', api: 'http://localhost:5173' });
  });
  it('strips a trailing slash and path', () => {
    expect(parsePairLink(ok('https://paperbrew.app/'))?.api).toBe('https://paperbrew.app');
  });
  it('normalizes the code', () => {
    expect(parsePairLink(ok('https://paperbrew.app', 'k7p2-9qxm'))?.code).toBe('K7P29QXM');
  });
  it('rejects bad codes', () => {
    expect(parsePairLink(ok('https://paperbrew.app', 'K7P29QX'))).toBeNull();
    expect(parsePairLink(ok('https://paperbrew.app', 'K7P29QXI'))).toBeNull(); // I not in alphabet
    expect(parsePairLink(ok('https://paperbrew.app', 'K7P29QXO'))).toBeNull();
    expect(parsePairLink('paperbrew://pair?api=https%3A%2F%2Fpaperbrew.app')).toBeNull();
  });
  it('rejects other hosts and schemes for api', () => {
    expect(parsePairLink(ok('http://evil.com'))).toBeNull();
    expect(parsePairLink(ok('http://paperbrew.app'))).toBeNull();
    expect(parsePairLink(ok('ftp://paperbrew.app'))).toBeNull();
    expect(parsePairLink(ok('javascript:alert(1)'))).toBeNull();
    expect(parsePairLink(ok('not a url'))).toBeNull();
    expect(parsePairLink('paperbrew://pair?code=K7P29QXM')).toBeNull();
  });
  it('rejects credentials in api', () => {
    expect(parsePairLink(ok('https://user:pw@paperbrew.app'))).toBeNull();
    expect(parsePairLink(ok('https://user@paperbrew.app'))).toBeNull();
  });
  it('rejects a lookalike localhost host', () => {
    expect(parsePairLink(ok('http://localhost.evil.com'))).toBeNull();
  });
  it('rejects wrong scheme or command', () => {
    expect(parsePairLink('https://pair?code=K7P29QXM&api=https%3A%2F%2Fpaperbrew.app')).toBeNull();
    expect(parsePairLink('paperbrew://other?code=K7P29QXM&api=https%3A%2F%2Fpaperbrew.app')).toBeNull();
    expect(parsePairLink('paperbrew://evil.com/pair?code=K7P29QXM&api=https%3A%2F%2Fpaperbrew.app')).toBeNull();
    expect(parsePairLink('garbage')).toBeNull();
  });
});

describe('statusText', () => {
  it('has the exact copy for each state', () => {
    expect(statusText({ kind: 'not_connected' })).toBe('Not connected');
    expect(statusText({ kind: 'ready', printer: 'HP' })).toBe('Ready · HP');
    expect(statusText({ kind: 'printing' })).toBe('Printing your issue…');
    expect(statusText({ kind: 'offline' })).toBe("Can't reach Paperbrew");
    expect(statusText({ kind: 'error', message: 'out of paper' })).toBe("Couldn't print: out of paper");
  });
});
