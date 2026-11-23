import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM for Gmail refresh tokens at rest. Format: v1.<iv>.<tag>.<ciphertext> (base64url).

function keyFrom(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('GMAIL_TOKEN_KEY must be base64 of exactly 32 bytes');
  return key;
}

export function encryptToken(plain: string, keyB64: string): string {
  const key = keyFrom(keyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptToken(enc: string, keyB64: string): string {
  const key = keyFrom(keyB64);
  const parts = enc.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unrecognised token format');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ct = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Unrecognised token format');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
