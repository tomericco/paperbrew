import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings, type Settings } from './settings';

const tokenFile = () => path.join(app.getPath('userData'), 'token.bin');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The device token, or null if there is none, encryption is unavailable, or decryption fails. */
export function loadToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const token = safeStorage.decryptString(fs.readFileSync(tokenFile()));
    return token || null;
  } catch {
    return null;
  }
}

/** Stores the token encrypted (macOS Keychain-backed). Throws rather than ever storing plaintext. */
export function saveToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this Mac');
  writeFileAtomic(tokenFile(), safeStorage.encryptString(token));
}

export function clearToken(): void {
  fs.rmSync(tokenFile(), { force: true });
}

export function loadSettings(): Settings {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch: Partial<Settings>): void {
  writeFileAtomic(settingsFile(), JSON.stringify(mergeSettings(loadSettings(), patch), null, 2));
}
