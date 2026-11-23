export type Settings = {
  api: string | null;
  printer: string | null;
  lastPrintedAt: string | null;
  /** True once the first-run "start at login" default has been applied, so turning it off sticks. */
  loginItemInit: boolean;
};

export const DEFAULT_SETTINGS: Settings = { api: null, printer: null, lastPrintedAt: null, loginItemInit: false };

/** An origin we may talk to: https anywhere, or http only on localhost. Returns the bare origin, else null. */
export function safeApiOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost');
  return ok ? u.origin : null;
}

/** Reads settings.json content defensively: anything malformed falls back to the default for that field. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const date = (v: unknown): string | null => {
    const s = str(v);
    return s !== null && !Number.isNaN(Date.parse(s)) ? s : null;
  };
  return {
    api: safeApiOrigin(r.api),
    printer: str(r.printer),
    lastPrintedAt: date(r.lastPrintedAt),
    loginItemInit: r.loginItemInit === true,
  };
}

export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  return normalizeSettings({ ...current, ...patch });
}

/** Where "Open Paperbrew" goes. Null when no api is saved. */
export function settingsUrl(api: string | null): string | null {
  const origin = safeApiOrigin(api);
  return origin ? `${origin}/app/settings` : null;
}

/** The name shown in Paperbrew settings for this Mac: the hostname without macOS's `.local` suffix. */
export function deviceName(hostname: string): string {
  const name = hostname.trim().replace(/\.local$/i, '').trim();
  return name || 'Mac';
}

/**
 * Whether pairing from a link with this origin needs the user's confirmation first: everything except localhost,
 * and localhost too in a packaged app (only an unpackaged dev run skips the dialog).
 */
export function needsPairConfirmation(api: string, isPackaged: boolean): boolean {
  if (isPackaged) return true;
  try {
    return new URL(api).hostname !== 'localhost';
  } catch {
    return true;
  }
}

/** Host (with port, if any) shown in the confirmation dialog. */
export function hostLabel(api: string): string {
  try {
    return new URL(api).host;
  } catch {
    return api;
  }
}

export function formatLastPrinted(iso: string | null, locale?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `Last printed ${d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

const NOTIFY_ERROR_MAX = 200;

/** Keeps notification bodies short and on one line. */
export function truncateError(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > NOTIFY_ERROR_MAX ? `${flat.slice(0, NOTIFY_ERROR_MAX - 1)}…` : flat;
}

/** The build's default origin, from `dist/defaults.json`. Null when missing or not a safe origin. */
export function parseDefaults(raw: unknown): { api: string | null } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { api: safeApiOrigin(r.api) };
}

/** Notification de-dup key: the same error on the same issue is told once; a different issue is told again. */
export function failureKey(issueId: string | undefined, message: string): string {
  return `${issueId ?? ''}\u0000${message}`;
}

/** Text under the pairing confirmation dialog's title. */
export function confirmDetail(alreadyConnected: boolean): string {
  const base = 'Only continue if you clicked Connect this Mac on your Paperbrew settings page.';
  return alreadyConnected ? `${base} This replaces your current connection.` : base;
}
