import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed OAuth `state`: <userId>.<expiresAtMs>.<hmac>. Ties the Google callback to the user who started it.

const TTL_MS = 10 * 60_000;

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signState(userId: string, secret: string, now: Date = new Date()): string {
  const payload = `${userId}.${now.getTime() + TTL_MS}`;
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

export function verifyState(state: string, secret: string, now: Date = new Date()): { userId: string } | null {
  if (typeof state !== 'string') return null;
  // Parse from the right so a user id containing dots still works.
  const sigAt = state.lastIndexOf('.');
  if (sigAt < 0) return null;
  const payload = state.slice(0, sigAt);
  const expAt = payload.lastIndexOf('.');
  if (expAt <= 0) return null;
  const userId = payload.slice(0, expAt);
  const expiresAt = Number(payload.slice(expAt + 1));
  if (!Number.isFinite(expiresAt)) return null;

  const given = Buffer.from(state.slice(sigAt + 1), 'base64url');
  const expected = sign(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (now.getTime() > expiresAt) return null;
  return { userId };
}
