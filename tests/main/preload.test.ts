import { contextBridge, ipcRenderer } from 'electron';
import { build } from 'vite';
import { beforeEach, expect, test, vi } from 'vitest';
import { API_METHODS, DOWNLOAD_DONE_EVENT, DOWNLOAD_PROGRESS_EVENT, SCAN_PROGRESS_EVENT } from '../../src/shared/api';
import type { DownloadDoneDTO, DownloadProgressDTO, HfcmApi, ScanProgressDTO } from '../../src/shared/api';
import { useCanaries } from '../helpers/canary';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

useCanaries();
beforeEach(() => expect.hasAssertions());

let cached: HfcmApi | null = null;
async function exposed(): Promise<HfcmApi> {
  if (cached !== null) return cached;
  await import('../../src/preload/index'); // evaluated once per file, so the first exposeInMainWorld call is kept here
  const call = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0];
  if (call === undefined) throw new Error('nothing exposed');
  expect(call[0]).toBe('api');
  cached = call[1] as HfcmApi;
  return cached;
}

test('exposes exactly the api methods and forwards to channels', async () => {
  const api = await exposed();
  expect(Object.keys(api).sort()).toEqual([...API_METHODS, 'onScanProgress', 'onDownloadProgress', 'onDownloadDone'].sort());
  expect(Object.values(api).every((v) => typeof v === 'function')).toBe(true);
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ ok: true, data: null });
  await api.executePlan('id', 'fp', 'hold', null);
  expect(ipcRenderer.invoke).toHaveBeenCalledWith('hfcm:executePlan', 'id', 'fp', 'hold', null);
  await api.scan();
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:scan');
});

test('exposes the four advice methods on their channels', async () => {
  const api = await exposed();
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ ok: true, data: null });
  await api.advice('a/b');
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:advice', 'a/b');
  await api.machineProfile();
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:machineProfile');
  await api.redetectMachine();
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:redetectMachine');
  const s = { gpuBytes: null, gpuKind: null, ramBytes: null, drivesDisplay: null, context: 32768, kvType: 'f16', tools: null } as const;
  await api.setAdviceSettings(s);
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:setAdviceSettings', s);
});

test('onScanProgress passes only the payload and unsubscribes', async () => {
  const api = await exposed();
  const cb = vi.fn();
  const off = api.onScanProgress(cb);
  const [ch, listener] = vi.mocked(ipcRenderer.on).mock.calls[0] ?? [];
  expect(ch).toBe(SCAN_PROGRESS_EVENT);
  const p: ScanProgressDTO = { phase: 'scan', done: 1, total: 2 };
  (listener as (e: unknown, p: ScanProgressDTO) => void)({ sender: 'secret-ipc-event' }, p);
  expect(cb).toHaveBeenCalledExactlyOnceWith(p);
  off();
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(SCAN_PROGRESS_EVENT, listener);
});

test('exposes the download methods on their channels', async () => {
  const api = await exposed();
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ ok: true, data: null });
  const id = '00000000-0000-4000-8000-000000000001';
  await api.hubLookup('org/name@main');
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:hubLookup', 'org/name@main');
  await api.downloadAdvice(id);
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:downloadAdvice', id);
  await api.lookupGroups(id);
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:lookupGroups', id);
  await api.downloadPreview(id, ['quant:Q4_K_M']);
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:downloadPreview', id, ['quant:Q4_K_M']);
  await api.downloadStart(id, 'f'.repeat(64));
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:downloadStart', id, 'f'.repeat(64));
  for (const m of ['downloadPause', 'downloadResume', 'downloadCancel'] as const) {
    await api[m](id);
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(`hfcm:${m}`, id);
  }
  await api.downloads();
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:downloads');
  await api.recentLookups();
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('hfcm:recentLookups');
});

test('onDownloadProgress and onDownloadDone pass only the payload on their own channels and unsubscribe', async () => {
  const api = await exposed();
  vi.mocked(ipcRenderer.on).mockClear();
  const progress = vi.fn();
  const done = vi.fn();
  const offP = api.onDownloadProgress(progress);
  const offD = api.onDownloadDone(done);
  const calls = vi.mocked(ipcRenderer.on).mock.calls;
  const [chP, lP] = calls[0] ?? [];
  const [chD, lD] = calls[1] ?? [];
  expect([chP, chD]).toEqual([DOWNLOAD_PROGRESS_EVENT, DOWNLOAD_DONE_EVENT]);
  const p: DownloadProgressDTO = { id: 'i', path: 'a.gguf', state: 'downloading', bytes: 1, size: 2, bytesPerSec: 3, error: null };
  const d: DownloadDoneDTO = { id: 'i', repoId: 'o/n', type: 'model' };
  (lP as (e: unknown, x: unknown) => void)({ sender: 'secret' }, p);
  (lD as (e: unknown, x: unknown) => void)({ sender: 'secret' }, d);
  expect(progress).toHaveBeenCalledExactlyOnceWith(p);
  expect(done).toHaveBeenCalledExactlyOnceWith(d);
  offP();
  offD();
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(DOWNLOAD_PROGRESS_EVENT, lP);
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(DOWNLOAD_DONE_EVENT, lD);
});

test('the preload bundle requires nothing but electron (sandbox-safe)', async () => {
  const out = await build({
    configFile: false, logLevel: 'silent',
    build: {
      write: false, minify: false, target: 'node22',
      lib: { entry: 'src/preload/index.ts', formats: ['cjs'], fileName: 'index' },
      rollupOptions: { external: (id: string) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  const code = outputs.flatMap((o) => ('output' in o ? o.output : [])).map((c) => ('code' in c ? c.code : '')).join('\n');
  const required = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  expect(required.length).toBeGreaterThan(0);
  expect(new Set(required)).toEqual(new Set(['electron']));
  expect(code).not.toMatch(/\bimport\s*\(/);
  expect(code).not.toContain('exposeInMainWorld("api", electron.ipcRenderer');
});
