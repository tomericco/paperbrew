import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, shell, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApi, OfflineError } from './api';
import { normalizeCode, parsePairLink } from './deepLink';
import { runOnce, type RunResult } from './loop';
import { createPoller, createTickLoop } from './poller';
import { parsePrinters } from './printers';
import {
  confirmDetail,
  deviceName,
  failureKey,
  formatLastPrinted,
  hostLabel,
  needsPairConfirmation,
  parseDefaults,
  settingsUrl,
  truncateError,
  unreportedFromPending,
} from './settings';
import { statusText, type AppState } from './status';
import { clearToken, loadSettings, loadToken, saveSettings, saveToken } from './store';
import { lpstat, print, removeTemp, writeTemp } from './system';

const POLL_MS = 60_000;
const PROTOCOL = 'paperbrew';
const PASTE_HTML = path.join(__dirname, 'paste.html');
const SMOKE_TEST = !app.isPackaged && !!process.env.PAPERBREW_SMOKE_TEST;
const NEED_PAIR_FIRST = 'Click Connect this Mac in Paperbrew settings first';

type Health = { kind: 'ok' } | { kind: 'offline' } | { kind: 'error'; message: string };

let tray: Tray | null = null;
let pasteWin: BrowserWindow | null = null;
let appReady = false;
const queuedUrls: string[] = [];
let pairing = false;
let health: Health = { kind: 'ok' };
let defaultPrinterName: string | null = null;
let menuSeq = 0;
let lastErrorNotified: string | null = null;
let pollTimer: NodeJS.Timeout | null = null;

/** The origin baked in at build time (dist/defaults.json), used by Paste code… on a fresh install. */
const defaults = (() => {
  try {
    return parseDefaults(JSON.parse(fs.readFileSync(path.join(__dirname, 'defaults.json'), 'utf8')));
  } catch {
    return { api: null };
  }
})();

// Everything a tick needs, captured just before it starts.
type TickCtx = { base: string; token: string; printer: string | null };

// Remembers which printed-but-unreported issue is on disk, so settings.json is only written when it changes.
let persistedUnreported: string | null = null;
function persistPending(pending: Parameters<typeof unreportedFromPending>[0]): void {
  const u = unreportedFromPending(pending);
  const key = u ? `${u.id}:${u.layout}` : null;
  if (key === persistedUnreported) return;
  persistedUnreported = key;
  try {
    saveSettings({ unreportedPrinted: u });
  } catch {
    // Best effort: a disk error must not stop printing.
  }
}

const poller = createPoller<TickCtx>({
  onPendingChange: persistPending,
  run: (pending, ctx) => {
    return runOnce(
      { api: createApi(ctx.base, ctx.token), print, writeTemp, removeTemp, printer: ctx.printer },
      pending,
    );
  },
});

function notify(title: string, body?: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function isConnected(): boolean {
  const s = loadSettings();
  return loadToken() !== null && s.api !== null;
}

function currentState(): AppState {
  if (!isConnected()) return { kind: 'not_connected' };
  if (health.kind === 'offline') return { kind: 'offline' };
  if (health.kind === 'error') return { kind: 'error', message: health.message };
  return { kind: 'ready', printer: loadSettings().printer ?? defaultPrinterName ?? 'Default printer' };
}

// ---- menu ----------------------------------------------------------------------------------

async function refreshMenu(): Promise<void> {
  if (!tray) return;
  const seq = ++menuSeq;
  const printers = parsePrinters(await lpstat());
  if (seq !== menuSeq || !tray) return; // a newer refresh is on its way
  defaultPrinterName = printers.find((p) => p.isDefault)?.name ?? null;

  const settings = loadSettings();
  const connected = isConnected();
  const lastPrinted = formatLastPrinted(settings.lastPrintedAt);
  const openUrl = settingsUrl(settings.api);

  const printerChoices: MenuItemConstructorOptions[] = [
    {
      label: 'Default printer',
      type: 'radio',
      checked: settings.printer === null,
      click: () => choosePrinter(null),
    },
    ...printers.map((p): MenuItemConstructorOptions => ({
      label: p.name,
      type: 'radio',
      checked: settings.printer === p.name,
      click: () => choosePrinter(p.name),
    })),
  ];
  // A saved printer that has since disappeared stays visible (and selected) until the user picks another.
  if (settings.printer !== null && !printers.some((p) => p.name === settings.printer)) {
    printerChoices.push({ label: settings.printer, type: 'radio', checked: true, click: () => choosePrinter(settings.printer) });
  }

  const template: MenuItemConstructorOptions[] = [{ label: statusText(currentState()), enabled: false }];
  if (lastPrinted) template.push({ label: lastPrinted, enabled: false });
  template.push(
    { type: 'separator' },
    { label: 'Printer', submenu: printerChoices },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      enabled: app.isPackaged, // unpackaged dev runs must not register Electron itself as a login item
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        void refreshMenu();
      },
    },
    { type: 'separator' },
    { label: 'Open Paperbrew', enabled: openUrl !== null, click: () => openUrl && void shell.openExternal(openUrl) },
    { label: 'Paste code…', click: openPasteWindow },
    { label: 'Disconnect', enabled: connected, click: disconnect },
    { type: 'separator' },
    { label: 'Quit Paperbrew', role: 'quit' },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function choosePrinter(name: string | null): void {
  saveSettings({ printer: name });
  void refreshMenu();
}

function disconnect(): void {
  stopPolling();
  clearToken();
  poller.reset();
  health = { kind: 'ok' };
  void refreshMenu();
}

// ---- polling -------------------------------------------------------------------------------

async function tickOnce(): Promise<void> {
  const token = loadToken();
  const settings = loadSettings();
  if (!token || !settings.api) return;
  // A result from a tick that started before a pair / disconnect / revoke is discarded inside the poller (null).
  const result = await poller.tick({ base: `${settings.api}/api`, token, printer: settings.printer });
  if (result) handleResult(result);
  await refreshMenu();
}

const tickLoop = createTickLoop(tickOnce);
/** `force`: run again right after a tick that is in flight (used right after pairing). */
const tick = (force = false): Promise<void> => tickLoop(force);

function startPolling(): void {
  if (!pollTimer) pollTimer = setInterval(() => void tick(), POLL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function handleResult(r: RunResult): void {
  if (r.outcome !== 'failed') lastErrorNotified = null;
  switch (r.outcome) {
    case 'unauthorized':
      // Happens once per transition: the token is cleared right here, so later ticks do nothing.
      notify('Paperbrew removed this Mac. Click Connect this Mac in Settings to set it up again.');
      stopPolling();
      clearToken();
      poller.reset();
      health = { kind: 'ok' };
      break;
    case 'offline':
      health = { kind: 'offline' };
      break;
    case 'idle':
      health = { kind: 'ok' };
      break;
    case 'printed':
      health = { kind: 'ok' };
      // nothingToPrint: the server had nothing left to print, so nothing went to the printer.
      if (!r.nothingToPrint) {
        saveSettings({ lastPrintedAt: new Date().toISOString() });
        notify('Your issue is printing');
      }
      break;
    case 'failed': {
      const message = truncateError(r.error ?? 'unknown error');
      health = { kind: 'error', message };
      if (r.printerMissing) saveSettings({ printer: null }); // falls back to the default printer next time
      // A persistent error (e.g. a bad server answer) would repeat every minute: tell the user once.
      const key = failureKey(r.issueId, message);
      if (key !== lastErrorNotified) notify(`Couldn't print your issue: ${message}`);
      lastErrorNotified = key;
      break;
    }
  }
}

// ---- pairing -------------------------------------------------------------------------------

function friendlyError(err: unknown): string {
  if (err instanceof OfflineError) return "Can't reach Paperbrew";
  return err instanceof Error ? err.message : 'something went wrong';
}

/** Runs `fn` unless another pairing is in progress. Holds the flag across any confirmation dialog. */
async function withPairing<T>(busy: T, fn: () => Promise<T>): Promise<T> {
  if (pairing) return busy;
  pairing = true;
  try {
    return await fn();
  } finally {
    pairing = false;
  }
}

async function pairWith(code: string, api: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { token } = await createApi(`${api}/api`, null).pair(code, deviceName(os.hostname()));
    saveToken(token);
    saveSettings({ api });
    poller.reset();
    health = { kind: 'ok' };
    lastErrorNotified = null;
    notify('Connected to Paperbrew');
    startPolling();
    void tick(true); // runs right after any in-flight (now stale) tick finishes
    void refreshMenu();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

async function handlePairLink(link: string): Promise<void> {
  const parsed = parsePairLink(link);
  if (!parsed) return;
  await withPairing(undefined, async () => {
    if (needsPairConfirmation(parsed.api, app.isPackaged)) {
      app.focus({ steal: true });
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `Connect this Mac to ${hostLabel(parsed.api)}?`,
        detail: confirmDetail(isConnected()),
        buttons: ['Connect', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
    }
    const result = await pairWith(parsed.code, parsed.api);
    if (!result.ok) notify("Couldn't connect to Paperbrew", result.error);
  });
}

// ---- paste window --------------------------------------------------------------------------

function openPasteWindow(): void {
  if (pasteWin && !pasteWin.isDestroyed()) {
    pasteWin.show();
    pasteWin.focus();
    return;
  }
  app.focus({ steal: true });
  const win = new BrowserWindow({
    width: 380,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Paperbrew',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Local file only: no navigation, no new windows, no permissions.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.on('closed', () => {
    if (pasteWin === win) pasteWin = null;
  });
  pasteWin = win;
  void win.loadFile(PASTE_HTML);
}

function registerPasteIpc(): void {
  const pasteUrl = pathToFileURL(PASTE_HTML).href;
  ipcMain.handle('paste:submit', async (event, raw: unknown): Promise<{ ok: boolean; error?: string }> => {
    const fromPasteWindow =
      pasteWin !== null && !pasteWin.isDestroyed() && event.sender === pasteWin.webContents && event.senderFrame?.url === pasteUrl;
    if (!fromPasteWindow) return { ok: false, error: 'Not allowed' };
    const code = typeof raw === 'string' ? normalizeCode(raw) : null;
    if (!code) return { ok: false, error: "That code doesn't look right. It has 8 letters and numbers." };
    // No host confirmation here: both origins are trusted (a saved, already-confirmed pairing, or the build's own constant).
    const api = loadSettings().api ?? defaults.api;
    if (!api) return { ok: false, error: NEED_PAIR_FIRST };
    const result = await withPairing({ ok: false, error: 'Already connecting…' } as { ok: boolean; error?: string }, () =>
      pairWith(code, api),
    );
    if (result.ok) pasteWin?.close();
    return result;
  });
}

// ---- startup -------------------------------------------------------------------------------

function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'IconTemplate.png'));
  img.setTemplateImage(true);
  return img;
}

function registerProtocol(): void {
  if (SMOKE_TEST) return; // a smoke run must not touch the system's URL handlers
  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/**
 * A printed issue whose report never went through (we quit or updated while offline) is picked up again, so the
 * next tick only retries the report and never prints twice. It belongs to the paired device: with no token it is stale.
 */
function restoreUnreported(): void {
  const u = loadSettings().unreportedPrinted;
  if (!u) return;
  if (loadToken() === null) {
    saveSettings({ unreportedPrinted: null });
    return;
  }
  persistedUnreported = `${u.id}:${u.layout}`;
  poller.restore({ id: u.id, layout: u.layout, printed: true });
}

function applyFirstRunLoginItem(): void {
  if (!app.isPackaged) return;
  if (loadSettings().loginItemInit) return;
  app.setLoginItemSettings({ openAtLogin: true });
  saveSettings({ loginItemInit: true });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Menu-bar app: nothing to show.
  });

  app.on('will-finish-launching', () => {
    app.on('open-url', (event, url) => {
      event.preventDefault();
      if (appReady) void handlePairLink(url);
      else queuedUrls.push(url);
    });
  });

  app.on('before-quit', stopPolling);

  // Closing the paste window must not quit the app.
  app.on('window-all-closed', () => {});

  void app.whenReady().then(() => {
    app.dock?.hide();
    registerProtocol();
    applyFirstRunLoginItem();
    registerPasteIpc();

    tray = new Tray(trayIcon());
    tray.setToolTip('Paperbrew');
    appReady = true;
    console.log('[paperbrew] started, tray created');
    void refreshMenu();

    for (const url of queuedUrls.splice(0)) void handlePairLink(url);

    restoreUnreported();
    startPolling();
    powerMonitor.on('resume', () => void tick());
    void tick();

    if (SMOKE_TEST) setTimeout(() => app.quit(), 3000);
  });
}
