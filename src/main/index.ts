// Electron entry: wires the real `app`, `ipcMain`, `dialog` and window into `bootstrap` (src/main/bootstrap.ts).
import { app, dialog, ipcMain } from 'electron';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootFailed, bootstrap, createProductionServices } from './bootstrap';
import { createMainWindow, hardenElectronWebContents } from './window';

const here = dirname(fileURLToPath(import.meta.url));
const rendererFile = join(here, '../renderer/index.html');
const rendererUrl = process.env['ELECTRON_RENDERER_URL'] ?? null;

const exitEarly = (message: string): void => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const reportFatal = (message: string): void => { dialog.showErrorBox('HF Cache Manager cannot start', message); };

void bootstrap({
  app: {
    isPackaged: app.isPackaged,
    setPath: (name, p) => app.setPath(name, p),
    getPath: (name) => app.getPath(name),
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    quit: () => app.quit(),
    whenReady: () => app.whenReady().then(() => undefined),
    onWebContentsCreated: (fn) => { app.on('web-contents-created', (_e, wc) => fn(wc)); },
    onActivate: (fn) => { app.on('activate', fn); },
    onSecondInstance: (fn) => { app.on('second-instance', fn); },
    onWindowAllClosed: (fn) => { app.on('window-all-closed', fn); },
  },
  ipcMain: {
    // The invoke event is passed through untouched (sender, senderFrame and its parent are what the sender check reads).
    handle: (ch, fn) => ipcMain.handle(ch, (e, ...a: unknown[]) => fn(e, ...a)),
  },
  env: process.env,
  home: homedir(),
  platform: process.platform,
  harden: hardenElectronWebContents,
  buildServices: (ctx) => createProductionServices({ ...ctx, env: process.env, home: homedir(), platform: process.platform }),
  createWindow: () => createMainWindow({
    preloadPath: join(here, '../preload/index.cjs'), rendererUrl, isPackaged: app.isPackaged, rendererFile,
  }),
  rendererFile,
  rendererUrl,
  exitEarly,
  reportFatal,
}).catch((e: unknown) => {
  bootFailed(e, { env: process.env, exitEarly, reportFatal, quit: () => app.quit() });
});
