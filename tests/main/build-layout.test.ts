import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { build } from 'electron-vite';
import { useCanaries } from '../helpers/canary';
import { makeTempRoot, removeTempRoot } from '../helpers/tmp';

useCanaries();
beforeEach(() => expect.hasAssertions());

// Builds the app into a fresh temp dir (never reads a stale project out/), then checks the layout the runtime relies on.
let out = '';
beforeAll(async () => {
  out = await makeTempRoot('hfcm-t-');
  await build({ configFile: 'electron.vite.config.ts', logLevel: 'silent', build: { outDir: out } });
}, 120_000);
afterAll(async () => { if (out !== '') await removeTempRoot(out); });

test('the scan worker the main bundle spawns sits beside it; preload is .cjs; the window loads them', () => {
  const main = readFileSync(join(out, 'main/index.js'), 'utf8');
  expect(main).toContain('new URL("./scan-worker.js", import.meta.url)');
  expect(existsSync(join(out, 'main/scan-worker.js'))).toBe(true);
  expect(existsSync(join(out, 'preload/index.cjs'))).toBe(true);
  expect(existsSync(join(out, 'renderer/index.html'))).toBe(true);
  expect(main).toContain('../preload/index.cjs');
  expect(main).toContain('../renderer/index.html');
});
