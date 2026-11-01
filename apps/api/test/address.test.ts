import { describe, expect, it } from 'vitest';
import { addressTokens, formatAddress, newToken, normalizeToken } from '../src/inbound/address.js';
import { WORDS } from '../src/inbound/words.js';

const POSTMARK = 'a1b2c3+{token}@inbound.postmarkapp.com';
const OWN_DOMAIN = '{token}@save.paperbrew.com';

describe('formatAddress', () => {
  it('fills the template', () => {
    expect(formatAddress(POSTMARK, 'amber-otter-lantern')).toBe('a1b2c3+amber-otter-lantern@inbound.postmarkapp.com');
  });
});

describe('addressTokens', () => {
  it('finds the token in a Postmark-style address, ignoring case and plus tags', () => {
    expect(addressTokens(['A1B2C3+Amber-Otter-Lantern+Trip@Inbound.Postmarkapp.com'], POSTMARK)).toEqual([
      'amber-otter-lantern',
    ]);
  });

  it('dedupes, skips other domains and too-short tokens', () => {
    expect(
      addressTokens(
        ['amber-otter@save.paperbrew.com', 'AMBER-OTTER+x@save.paperbrew.com', 'friend@gmail.com', 'ab@save.paperbrew.com'],
        OWN_DOMAIN,
      ),
    ).toEqual(['amber-otter']);
  });

  it('ignores addresses with a different prefix', () => {
    expect(addressTokens(['zzz+amber-otter@inbound.postmarkapp.com'], POSTMARK)).toEqual([]);
  });

  it('ignores reserved and malformed tokens', () => {
    expect(addressTokens(['postmaster@save.paperbrew.com', '-amber@save.paperbrew.com'], OWN_DOMAIN)).toEqual([]);
  });
});

describe('newToken', () => {
  it('is three lowercase words joined by hyphens', () => {
    expect(newToken()).toMatch(/^[a-z]{3,7}-[a-z]{3,7}-[a-z]{3,7}$/);
  });

  it('is practically unique', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => newToken()));
    expect(seen.size).toBeGreaterThanOrEqual(999);
  });

  it('always passes normalizeToken', () => {
    for (let i = 0; i < 200; i++) {
      const t = newToken();
      expect(normalizeToken(t)).toEqual({ ok: true, token: t });
    }
  });
});

describe('WORDS', () => {
  it('has at least 1,024 distinct 3-7 letter lowercase words', () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(1024);
    expect(new Set(WORDS).size).toBe(WORDS.length);
    for (const w of WORDS) expect(w).toMatch(/^[a-z]{3,7}$/);
  });

  it('contains no reserved token', () => {
    for (const w of ['admin', 'abuse', 'root', 'support', 'help', 'info', 'hello', 'billing', 'mail', 'security']) {
      expect(WORDS).not.toContain(w);
    }
  });
});

describe('normalizeToken', () => {
  it('trims and lowercases', () => {
    expect(normalizeToken('  Amber-Otter ')).toEqual({ ok: true, token: 'amber-otter' });
  });

  it.each(['ab', '-amber', 'amber-', 'amber--otter', 'amber otter', 'x'.repeat(41), ''])('rejects %j', (input) => {
    const r = normalizeToken(input);
    expect(r).toEqual({ ok: false, error: 'Use 3–40 letters, numbers and single hyphens.' });
  });

  it.each(['postmaster', 'Admin', 'no-reply', 'paperbrew'])('refuses reserved %j', (input) => {
    expect(normalizeToken(input)).toEqual({ ok: false, error: 'That address is reserved.' });
  });
});
