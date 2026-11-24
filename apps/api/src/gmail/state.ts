import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed OAuth `state`: <userId>.<returnTo>.<expiresAtMs>.<hmac>. Ties the Google callback to the user who
// started it, and carries the page to return to. The return target is signed, so it cannot be swapped.

const TTL_MS = 10 * 60_000;

/** The only pages the callback returns to. Anything else is `settings`. */
export const RETURN_TARGETS = ['welcome', 'settings'] as const;
export type ReturnTarget = (typeof RETURN_TARGETS)[number];

export const toReturnTarget = (v: unknown): ReturnTarget => (v === 'welcome' ? 'welcome' : 'settings');

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signState(
  userId: string,
  secret: string,
  now: Date = new Date(),
  returnTo: ReturnTarget = 'settings',
): string {
  const payload = `${userId}.${toReturnTarget(returnTo)}.${now.getTime() + TTL_MS}`;
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

export function verifyState(
  state: string,
  secret: string,
  now: Date = new Date(),
): { userId: string; returnTo: ReturnTarget } | null {
  if (typeof state !== 'string') return null;
  // Parse from the right so a user id containing dots still works.
  const sigAt = state.lastIndexOf('.');
  if (sigAt < 0) return null;
  const payload = state.slice(0, sigAt);
  const expAt = payload.lastIndexOf('.');
  if (expAt <= 0) return null;
  const toAt = payload.lastIndexOf('.', expAt - 1);
  if (toAt <= 0) return null;
  const userId = payload.slice(0, toAt);
  const returnTo = payload.slice(toAt + 1, expAt);
  const expiresAt = Number(payload.slice(expAt + 1));
  if (!Number.isFinite(expiresAt)) return null;
  if (!(RETURN_TARGETS as readonly string[]).includes(returnTo)) return null;

  const given = Buffer.from(state.slice(sigAt + 1), 'base64url');
  const expected = sign(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (now.getTime() > expiresAt) return null;
  return { userId, returnTo: returnTo as ReturnTarget };
}
