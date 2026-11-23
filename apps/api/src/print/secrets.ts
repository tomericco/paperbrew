import { createHash, randomBytes, randomInt } from 'node:crypto';

// No I, L, O, 0 or 1: a code read off a screen and typed in cannot be mistaken.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** A pairing code, 8 characters, no dash. randomInt is uniform, so there is no modulo bias. */
export function newPairCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** `K7P29QXM` -> `K7P2-9QXM`, the form shown to people. */
export function formatPairCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What a person typed (any case, spaces, dashes) -> the canonical code. */
export function normalizePairCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 32 random bytes as base64url (43 characters). Only its hash is stored. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
