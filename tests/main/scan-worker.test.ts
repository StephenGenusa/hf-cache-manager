import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'vite';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import type { ScanProgressDTO } from '../../src/shared/api';
import { makeWorkerScanRunner } from '../../src/main/scan-client';
import { buildAppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';
import { makeTempRoot, removeTempRoot } from '../helpers/tmp';

useCanaries();
beforeEach(() => expect.hasAssertions());

let outDir = '';
let workerFile = '';
beforeAll(async () => {
  outDir = await makeTempRoot('hfcm-t-');
  await build({
    configFile: false, logLevel: 'silent', root: resolve('.'),
    build: {
      ssr: true, outDir, emptyOutDir: false, minify: false, target: 'node22',
      rollupOptions: { input: { 'scan-worker': resolve('src/main/scan-worker.ts') }, output: { format: 'es', entryFileNames: '[name].mjs' } },
    },
    ssr: { noExternal: true },
  });
  workerFile = join(outDir, 'scan-worker.mjs');
  return () => removeTempRoot(outDir);
}, 60_000);

const runner = () => makeWorkerScanRunner((hubRoot) => new Worker(workerFile, { workerData: { hubRoot } }));

test('the built worker file exists and scans a real fixture with progress then done', async () => {
  expect(existsSync(workerFile)).toBe(true);
  const fx = await buildAppFixture();
  const seen: ScanProgressDTO[] = [];
  const out = await runner()(fx.hubRoot, (p) => seen.push(p), new AbortController().signal);
  expect(seen[0]).toEqual({ phase: 'scan', done: 0, total: 1 });
  expect(seen.at(-1)).toEqual({ phase: 'classify', done: 7, total: 7 });
  expect(out.views.map((v) => v.repoId).sort()).toEqual([
    'bartowski/tiny-GGUF', 'black-forest-labs/FLUX.1-dev', 'org/dupe', 'org/partial', 'org/shared-a', 'org/shared-b', 'unsloth/Qwen3.6-27B-GGUF',
  ]);
});

test('a missing hub in the real worker rejects with one scan error', async () => {
  const fx = await buildAppFixture();
  await expect(runner()(join(fx.root, 'nope'), () => {}, new AbortController().signal)).rejects.toThrow(/Cache not found/);
});

test('aborting terminates the real worker', async () => {
  const fx = await buildAppFixture();
  const ac = new AbortController();
  const p = runner()(fx.hubRoot, () => {}, ac.signal);
  ac.abort();
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
});
