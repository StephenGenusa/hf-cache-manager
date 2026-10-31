import { createRequire } from 'node:module';
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents, WebPreferences } from 'electron';
import { cspFor } from './csp';

export { cspFor, PROD_CSP } from './csp';

export function webPreferencesFor(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
  };
}

export type BlockedEvent = 'will-navigate' | 'will-redirect' | 'will-frame-navigate' | 'will-attach-webview';
export const BLOCKED_EVENTS: readonly BlockedEvent[] = ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview'];

export interface WebContentsLike {
  on(ev: BlockedEvent, fn: (e: { preventDefault(): void }, url: string) => void): void;
  setWindowOpenHandler(fn: () => { action: 'deny' }): void;
  session: {
    setPermissionRequestHandler(fn: (wc: unknown, permission: string, cb: (ok: boolean) => void) => void): void;
    setPermissionCheckHandler(fn: () => boolean): void;
  };
}

/** The renderer is a single page that never navigates: deny every navigation, redirect, popup, webview and permission. */
export function hardenWebContents(wc: WebContentsLike): void {
  for (const ev of BLOCKED_EVENTS) wc.on(ev, (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  wc.session.setPermissionCheckHandler(() => false);
}

/**
 * The dev renderer URL is honoured only for an unpackaged app and only for a plain local dev server
 * (`http://localhost:<port>` or `http://127.0.0.1:<port>`); anything else is ignored and the bundled file is loaded.
 */
export function resolveRendererUrl(raw: string | null | undefined, isPackaged: boolean): string | null {
  if (isPackaged || raw === null || raw === undefined || raw === '') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return u.protocol === 'http:' && local && u.port !== '' && u.username === '' && u.password === '' ? raw : null;
}

/** Adapts a real WebContents to the minimal surface `hardenWebContents` needs. */
export function hardenElectronWebContents(wc: WebContents): void {
  hardenWebContents({
    on(ev, fn) {
      switch (ev) {
        case 'will-navigate':
          wc.on('will-navigate', (e) => fn(e, e.url));
          break;
        case 'will-redirect':
          wc.on('will-redirect', (e) => fn(e, e.url));
          break;
        case 'will-frame-navigate':
          wc.on('will-frame-navigate', (e) => fn(e, e.url));
          break;
        case 'will-attach-webview':
          wc.on('will-attach-webview', (e) => fn(e, ''));
          break;
      }
    },
    setWindowOpenHandler: (fn) => wc.setWindowOpenHandler(fn),
    session: wc.session,
  });
}

export interface MainWindowOptions {
  preloadPath: string;
  /** Raw ELECTRON_RENDERER_URL (or null); validated by `resolveRendererUrl`. */
  rendererUrl: string | null;
  rendererFile: string;
  isPackaged: boolean;
}

export interface WindowDeps {
  BrowserWindow?: new (o: BrowserWindowConstructorOptions) => BrowserWindow;
}

/** Loaded lazily so the pure helpers above can be unit-tested without the Electron binary being installed. */
function electron(): typeof import('electron') {
  return createRequire(import.meta.url)('electron') as typeof import('electron');
}

export function createMainWindow(opts: MainWindowOptions, deps: WindowDeps = {}): BrowserWindow {
  const Ctor = deps.BrowserWindow ?? electron().BrowserWindow;
  const devUrl = resolveRendererUrl(opts.rendererUrl, opts.isPackaged);
  const win = new Ctor({
    width: 1100,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: webPreferencesFor(opts.preloadPath),
  });
  const wc = win.webContents;
  const csp = cspFor(devUrl !== null, devUrl === null ? undefined : new URL(devUrl).origin);
  wc.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([k]) => k.toLowerCase() !== 'content-security-policy'));
    callback({ responseHeaders: { ...headers, 'Content-Security-Policy': [csp] } });
  });
  hardenElectronWebContents(wc);
  win.once('ready-to-show', () => win.show());
  if (devUrl !== null) void win.loadURL(devUrl);
  else void win.loadFile(opts.rendererFile);
  return win;
}
