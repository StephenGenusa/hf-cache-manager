// Renders build/icon.svg to build/icon.png (1024 px) with Electron's own Chromium; electron-builder derives the
// Windows .ico and the macOS .icns from that PNG. Run: npm run icon (needs a display; xvfb-run works).
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true } });
  const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8');
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  writeFileSync(join(root, 'build', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
