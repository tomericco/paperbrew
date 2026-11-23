import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '../src/gmail/crypto.js';
import { signState, verifyState } from '../src/gmail/state.js';

const KEY = randomBytes(32).toString('base64');

describe('token encryption', () => {
  it('round-trips', () => {
    const enc = encryptToken('refresh-token-123', KEY);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc.split('.')).toHaveLength(4);
    expect(decryptToken(enc, KEY)).toBe('refresh-token-123');
  });

  it('produces different output for the same input', () => {
    expect(encryptToken('same', KEY)).not.toBe(encryptToken('same', KEY));
  });

  it('throws when the ciphertext is tampered with', () => {
    const [v, iv, tag, ct] = encryptToken('secret', KEY).split('.');
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    expect(() => decryptToken([v, iv, tag, flipped].join('.'), KEY)).toThrow();
  });

  it('throws on the wrong key, a malformed token, or a key of the wrong length', () => {
    const enc = encryptToken('secret', KEY);
    expect(() => decryptToken(enc, randomBytes(32).toString('base64'))).toThrow();
    expect(() => decryptToken('garbage', KEY)).toThrow();
    expect(() => encryptToken('x', randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('oauth state', () => {
  const secret = 'state-secret';
  const now = new Date('2026-11-22T10:00:00Z');

  it('verifies a fresh state', () => {
    expect(verifyState(signState('u1', secret, now), secret, now)).toEqual({ userId: 'u1' });
  });

  it('rejects an expired state (11 minutes)', () => {
    const later = new Date(now.getTime() + 11 * 60_000);
    expect(verifyState(signState('u1', secret, now), secret, later)).toBeNull();
  });

  it('rejects a different secret', () => {
    expect(verifyState(signState('u1', secret, now), 'other', now)).toBeNull();
  });

  it('rejects a tampered user id', () => {
    const [, exp, sig] = signState('u1', secret, now).split('.');
    expect(verifyState(['u2', exp, sig].join('.'), secret, now)).toBeNull();
  });

  it('rejects a tampered expiry: a later time under the old signature', () => {
    const [user, exp, sig] = signState('u1', secret, now).split('.');
    const later = String(Number(exp) + 60 * 60_000);
    expect(verifyState([user, later, sig].join('.'), secret, now)).toBeNull();
    // Sanity: the untouched state still verifies, so the null above is the signature check.
    expect(verifyState([user, exp, sig].join('.'), secret, now)).toEqual({ userId: 'u1' });
  });

  it('round-trips a user id that contains dots', () => {
    expect(verifyState(signState('a.b.c', secret, now), secret, now)).toEqual({ userId: 'a.b.c' });
  });

  it('returns null for malformed input without throwing', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c', 'a.notanumber.zz', '...', 'u1.9999999999999.' ]) {
      expect(verifyState(bad, secret, now)).toBeNull();
    }
  });
});
