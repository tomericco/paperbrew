import { describe, expect, it } from 'vitest';
import { formatPairCode, newDeviceToken, newPairCode, normalizePairCode, sha256 } from '../src/print/secrets.js';

describe('newPairCode', () => {
  it('is 8 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) expect(newPairCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it('differs between calls', () => {
    expect(new Set(Array.from({ length: 50 }, newPairCode)).size).toBe(50);
  });
});

describe('formatPairCode', () => {
  it('shows XXXX-XXXX', () => {
    expect(formatPairCode('K7P29QXM')).toBe('K7P2-9QXM');
  });
});

describe('normalizePairCode', () => {
  it('uppercases and strips everything but letters and digits', () => {
    expect(normalizePairCode(' k7p2-9qxm ')).toBe('K7P29QXM');
    expect(normalizePairCode('K7P2 9QXM\n')).toBe('K7P29QXM');
  });

  it('round-trips a formatted code', () => {
    const code = newPairCode();
    expect(normalizePairCode(formatPairCode(code))).toBe(code);
  });
});

describe('newDeviceToken', () => {
  it('is 43 url-safe characters and unique', () => {
    const a = newDeviceToken();
    const b = newDeviceToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe('sha256', () => {
  it('is lowercase hex', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
