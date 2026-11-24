import { createHmac, randomBytes } from 'node:crypto';
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

  it('verifies a fresh state, returning to settings by default', () => {
    expect(verifyState(signState('u1', secret, now), secret, now)).toEqual({ userId: 'u1', returnTo: 'settings' });
  });

  it('carries a signed return target', () => {
    expect(verifyState(signState('u1', secret, now, 'welcome'), secret, now)).toEqual({ userId: 'u1', returnTo: 'welcome' });
  });

  it('rejects a tampered return target', () => {
    const [user, , exp, sig] = signState('u1', secret, now, 'settings').split('.');
    expect(verifyState([user, 'welcome', exp, sig].join('.'), secret, now)).toBeNull();
  });

  it('rejects an expired state (11 minutes)', () => {
    const later = new Date(now.getTime() + 11 * 60_000);
    expect(verifyState(signState('u1', secret, now), secret, later)).toBeNull();
  });

  it('rejects a different secret', () => {
    expect(verifyState(signState('u1', secret, now), 'other', now)).toBeNull();
  });

  it('rejects a tampered user id', () => {
    const [, to, exp, sig] = signState('u1', secret, now).split('.');
    expect(verifyState(['u2', to, exp, sig].join('.'), secret, now)).toBeNull();
  });

  it('rejects a tampered expiry: a later time under the old signature', () => {
    const [user, to, exp, sig] = signState('u1', secret, now).split('.');
    const later = String(Number(exp) + 60 * 60_000);
    expect(verifyState([user, to, later, sig].join('.'), secret, now)).toBeNull();
    // Sanity: the untouched state still verifies, so the null above is the signature check.
    expect(verifyState([user, to, exp, sig].join('.'), secret, now)).toEqual({ userId: 'u1', returnTo: 'settings' });
  });

  it('round-trips a user id that contains dots', () => {
    expect(verifyState(signState('a.b.c', secret, now, 'welcome'), secret, now)).toEqual({
      userId: 'a.b.c',
      returnTo: 'welcome',
    });
  });

  it('returns null for malformed input without throwing', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c', 'a.notanumber.zz', '...', 'u1.9999999999999.', 'u1.settings.9999999999999.']) {
      expect(verifyState(bad, secret, now)).toBeNull();
    }
  });

  it('rejects a state in the old format (no return target)', () => {
    // Signed like the old <userId>.<expiresAt>.<hmac>: there is no return target, so it is refused.
    const payload = `u1.${now.getTime() + 60_000}`;
    const old = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
    expect(verifyState(old, secret, now)).toBeNull();
  });
});
