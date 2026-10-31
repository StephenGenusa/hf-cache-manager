import type { WebContents } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ReadFs } from '../../src/core/fsx';
import { API_METHODS, CHANNELS, DOWNLOAD_DONE_EVENT, DOWNLOAD_PROGRESS_EVENT, SCAN_PROGRESS_EVENT } from '../../src/shared/api';
import type { InvokeMethod, ScanProgressDTO } from '../../src/shared/api';
import * as corePort from '../../src/main/core-port';
import { bootFailed, bootstrap, createProductionServices, devOriginOf, e2eDisk, e2eGraceMs, e2eMachine, guardPathsFor, productionServicesDeps } from '../../src/main/bootstrap';
import { networkBlockedCount } from '../../src/main/hub/client';
import * as hardware from '../../src/main/hardware';
import { AUTO_EMPTY_GRACE_MS } from '../../src/main/services';
import type { BootApp, BootDeps, WindowLike } from '../../src/main/bootstrap';
import { hardenElectronWebContents } from '../../src/main/window';
import type { ElectronIpcEvent, ServiceSurface } from '../../src/main/ipc';
import { useCanaries } from '../helpers/canary';

vi.mock('../../src/main/core-port', async (orig) => {
  const real = await orig<typeof import('../../src/main/core-port')>();
  return { ...real, createCorePort: vi.fn(real.createCorePort) };
});

// No test ever runs nvidia-smi: the real detector is replaced, and its calls are recorded.
vi.mock('../../src/main/hardware', async (orig) => {
  const real = await orig<typeof import('../../src/main/hardware')>();
  return {
    ...real,
    productionExec: vi.fn(() => Promise.reject(new Error('a test must not spawn nvidia-smi'))),
    detectMachine: vi.fn(() => Promise.resolve({
      platform: 'linux', ramBytes: 1, gpuName: null, gpuBytes: null, gpuKind: 'other', computeCap: null, drivesDisplay: false,
    })),
  };
});

useCanaries();
beforeEach(() => expect.hasAssertions());

const TMP = '/tmp/hfcm-e2e-abc123';
const USER_DATA = `${TMP}/userdata`;
const HOME = '/home/user';
const PROJECT = '/home/user/Projects/HF Cache Model Manager';
const enoent = (): never => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
const dirStat = (): unknown => ({
  dev: 1, ino: 2, size: 0, mtimeMs: 0, nlink: 2, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false,
});
const linkStat = (): unknown => ({ ...(dirStat() as object), isSymbolicLink: () => true, isDirectory: () => false });
function fsWith(lstat: (p: string) => unknown): ReadFs {
  return {
    lstat: ((p: string) => Promise.resolve(lstat(p))) as ReadFs['lstat'], stat: enoent, readlink: () => Promise.resolve('/elsewhere'),
    readdir: enoent, readFile: enoent as ReadFs['readFile'], realpath: enoent, statfs: enoent,
  };
}
const userDataOnly = fsWith((p) => (p === USER_DATA ? dirStat() : enoent()));

interface Rig {
  events: string[]; deps: BootDeps; win: WindowLike & { sent: Array<[string, unknown]>; destroyed: boolean; minimized: boolean };
  handlers: Map<string, (e: ElectronIpcEvent, ...a: unknown[]) => Promise<unknown>>;
  appHandlers: Record<string, () => void>; wcCreated: Array<(wc: WebContents) => void>;
  svc: Record<InvokeMethod, ReturnType<typeof vi.fn>>; fatal: string[]; built: Array<(p: ScanProgressDTO) => void>;
  windows: { n: number };
}

function rig(env: NodeJS.ProcessEnv = {}, over: { lock?: boolean; fs?: ReadFs; platform?: NodeJS.Platform; userData?: string } = {}): Rig {
  const events: string[] = [];
  const handlers: Rig['handlers'] = new Map();
  const appHandlers: Record<string, () => void> = {};
  const wcCreated: Rig['wcCreated'] = [];
  const fatal: string[] = [];
  const built: Rig['built'] = [];
  const windows = { n: 0 };
  const svc = Object.fromEntries(API_METHODS.map((m) => [m, vi.fn(() => Promise.resolve({ ok: true, data: null }))])) as Rig['svc'];
  const win = {
    webContents: { send: (ch: string, p: unknown) => { win.sent.push([ch, p]); } },
    sent: [] as Array<[string, unknown]>, destroyed: false, minimized: false,
    isDestroyed: () => win.destroyed, isMinimized: () => win.minimized,
    restore: () => { events.push('restore'); }, focus: () => { events.push('focus'); },
  };
  const app: BootApp = {
    isPackaged: false,
    setPath: (_n, p) => { events.push(`setPath:${p}`); },
    getPath: () => over.userData ?? USER_DATA,
    requestSingleInstanceLock: () => { events.push('lock'); return over.lock ?? true; },
    quit: () => { events.push('quit'); },
    whenReady: () => { events.push('whenReady'); return Promise.resolve(); },
    onWebContentsCreated: (fn) => { wcCreated.push(fn); },
    onActivate: (fn) => { appHandlers['activate'] = fn; },
    onSecondInstance: (fn) => { appHandlers['second-instance'] = fn; },
    onWindowAllClosed: (fn) => { appHandlers['window-all-closed'] = fn; },
  };
  const deps: BootDeps = {
    app, env, home: HOME, platform: over.platform ?? 'linux', fs: over.fs ?? userDataOnly,
    guardOptions: { fs: over.fs ?? userDataOnly, homedir: HOME, projectDir: PROJECT },
    ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); } },
    harden: (wc) => { events.push('harden'); void wc; },
    buildServices: ({ userDataDir, emitProgress }) => { events.push(`build:${userDataDir}`); built.push(emitProgress); return svc as unknown as ServiceSurface; },
    createWindow: () => { windows.n++; events.push('window'); return win; },
    rendererFile: '/app/out/renderer/index.html', rendererUrl: null,
    reportFatal: (m) => { fatal.push(m); },
    mkdir: () => { throw new Error('the test rig must not reach a real mkdir'); },
    exitEarly: (m) => { events.push(`exit:${m}`); fatal.push(m); },
  };
  return { events, deps, win, handlers, appHandlers, wcCreated, svc, fatal, built, windows };
}

const mainEvent = (r: Rig, over: Partial<ElectronIpcEvent> = {}): ElectronIpcEvent => ({
  sender: r.win.webContents, senderFrame: { url: 'file:///app/out/renderer/index.html', parent: null }, ...over,
});

test('normal start: single-instance lock, ready, then services, ipc and window, in that order', async () => {
  const r = rig();
  expect(await bootstrap(r.deps)).toBe('started');
  expect(r.events).toEqual(['lock', 'whenReady', `build:${USER_DATA}`, 'window']);
  expect([...r.handlers.keys()].sort()).toEqual(Object.values(CHANNELS).sort());
});

test('without HFCM_USER_DATA_DIR the userData path is left alone', async () => {
  const r = rig();
  await bootstrap(r.deps);
  expect(r.events.some((e) => e.startsWith('setPath'))).toBe(false);
});

test('HFCM_USER_DATA_DIR outside E2E is ignored (a stray variable never moves settings or the journal)', async () => {
  for (const env of [{ HFCM_USER_DATA_DIR: '/x/ud' }, { HFCM_USER_DATA_DIR: '/x/ud', HFCM_E2E: '' }]) {
    const r = rig(env);
    expect(await bootstrap(r.deps)).toBe('started');
    expect(r.events, JSON.stringify(env)).toEqual(['lock', 'whenReady', `build:${USER_DATA}`, 'window']);
  }
});

test('a lost single-instance lock quits before anything else happens', async () => {
  const r = rig({}, { lock: false });
  expect(await bootstrap(r.deps)).toBe('second-instance');
  expect(r.events).toEqual(['lock', 'quit']);
  expect(r.handlers.size).toBe(0);
});

test('HFCM_E2E with a hub outside the temp root quits with an error and builds nothing', async () => {
  const r = rig({
    HFCM_E2E: '1', HFCM_E2E_ROOT: TMP, HFHUB_CONFIG: `${TMP}/cfg.toml`, HFCM_USER_DATA_DIR: USER_DATA, HOME: `${TMP}/home`, HF_HUB_CACHE: `${HOME}/.cache/huggingface/hub`,
  });
  r.deps.home = `${TMP}/home`;
  expect(await bootstrap(r.deps)).toBe('fatal');
  expect(r.fatal).toHaveLength(1);
  expect(r.fatal[0]).toContain('HFCM_E2E is set but the hub is outside the temp dir');
  // the pre-check refuses it before setPath, the lock or whenReady (Electron has written nothing), with a non-zero exit
  expect(r.events).toEqual([`exit:${r.fatal[0]!}`]);
  expect(r.handlers.size).toBe(0);
  expect(r.windows.n).toBe(0);
});

test('HFCM_E2E without a temp root fails closed', async () => {
  const r = rig({ HFCM_E2E: '1', HFHUB_CONFIG: `${TMP}/cfg.toml` });
  expect(await bootstrap(r.deps)).toBe('fatal');
  expect(r.fatal[0]).toContain('the temp dir is not usable');
  expect(r.events).not.toContain(`build:${USER_DATA}`);
});

test('HFCM_E2E with every path inside the temp root starts normally (guard runs before services)', async () => {
  const r = rig({
    HFCM_E2E: '1', HFCM_E2E_ROOT: TMP, HFHUB_CONFIG: `${TMP}/cfg.toml`, HFCM_USER_DATA_DIR: USER_DATA, HOME: `${TMP}/home`, HF_HOME: `${TMP}/hf`,
  });
  const fs = fsWith((p) => (p === USER_DATA ? dirStat() : enoent()));
  r.deps.fs = fs;
  r.deps.guardOptions = { fs, homedir: HOME, projectDir: PROJECT };
  r.deps.home = `${TMP}/home`;
  expect(await bootstrap(r.deps)).toBe('started');
  expect(r.events.indexOf('whenReady')).toBeLessThan(r.events.indexOf(`build:${USER_DATA}`));
  expect(r.fatal).toEqual([]);
});

test('only an E2E run exposes the blocked-network counter to the harness, after the guard passed', async () => {
  const g = globalThis as { __hfcmE2E?: { networkBlocked(): number } };
  const exposed = (): { networkBlocked(): number } | undefined => g.__hfcmE2E;
  delete g.__hfcmE2E;
  await bootstrap(rig().deps);
  expect(exposed()).toBeUndefined();
  const r = rig({
    HFCM_E2E: '1', HFCM_E2E_ROOT: TMP, HFHUB_CONFIG: `${TMP}/cfg.toml`, HFCM_USER_DATA_DIR: USER_DATA, HOME: `${TMP}/home`, HF_HOME: `${TMP}/hf`,
  });
  const fs = fsWith((p) => (p === USER_DATA ? dirStat() : enoent()));
  r.deps.fs = fs;
  r.deps.guardOptions = { fs, homedir: HOME, projectDir: PROJECT };
  r.deps.home = `${TMP}/home`;
  expect(await bootstrap(r.deps)).toBe('started');
  expect(exposed()?.networkBlocked()).toBe(networkBlockedCount());
  delete g.__hfcmE2E;
});

test('a userData folder that does not exist or is a symlink is fatal and nothing is built', async () => {
  for (const fs of [fsWith(() => enoent()), fsWith(() => linkStat())]) {
    const r = rig({}, { fs });
    expect(await bootstrap(r.deps)).toBe('fatal');
    expect(r.fatal[0]).toContain('app data');
    expect(r.events).toEqual(['lock', 'whenReady', 'quit']);
    expect(r.windows.n).toBe(0);
  }
});

test('the web-contents-created handler hardens every webContents it is given', async () => {
  const r = rig();
  r.deps.harden = hardenElectronWebContents;
  await bootstrap(r.deps);
  expect(r.wcCreated).toHaveLength(1);
  const prevented: string[] = [];
  const on = vi.fn((ev: string, fn: (e: { preventDefault(): void; url: string }) => void) => { fn({ preventDefault: () => { prevented.push(ev); }, url: 'https://evil.example/' }); });
  const setWindowOpenHandler = vi.fn();
  const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
  r.wcCreated[0]?.({ on, setWindowOpenHandler, session } as unknown as WebContents);
  expect(prevented.sort()).toEqual(['will-attach-webview', 'will-frame-navigate', 'will-navigate', 'will-redirect']);
  expect(setWindowOpenHandler).toHaveBeenCalledTimes(1);
  expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
});

test('the web-contents-created listener is registered before the app is ready (a window can never escape it)', async () => {
  const r = rig();
  const order: string[] = [];
  const app = r.deps.app;
  r.deps.app = { ...app, onWebContentsCreated: (fn) => { order.push('wc'); app.onWebContentsCreated(fn); }, whenReady: () => { order.push('ready'); return app.whenReady(); } };
  await bootstrap(r.deps);
  expect(order).toEqual(['wc', 'ready']);
});

test('ipc: only the main window top-level frame reaches the services', async () => {
  const r = rig();
  await bootstrap(r.deps);
  const scan = r.handlers.get('hfcm:scan');
  if (scan === undefined) throw new Error('no scan handler');
  expect(await scan(mainEvent(r))).toEqual({ ok: true, data: null });
  expect(r.svc.scan).toHaveBeenCalledTimes(1);
  for (const e of [mainEvent(r, { sender: {} }), mainEvent(r, { senderFrame: { url: 'file:///app/out/renderer/index.html', parent: {} } }), mainEvent(r, { senderFrame: { url: 'https://evil.example/', parent: null } })]) {
    expect(await scan(e)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  }
  expect(r.svc.scan).toHaveBeenCalledTimes(1);
});

test('ipc trusts the dev server origin only for a validated dev url', async () => {
  const r = rig();
  r.deps.rendererUrl = 'http://localhost:5173';
  await bootstrap(r.deps);
  const scan = r.handlers.get('hfcm:scan');
  const dev = mainEvent(r, { senderFrame: { url: 'http://localhost:5173/#/x', parent: null } });
  expect(await scan?.(dev)).toEqual({ ok: true, data: null });
  const r2 = rig();
  r2.deps.app = { ...r2.deps.app, isPackaged: true };
  r2.deps.rendererUrl = 'http://localhost:5173';
  await bootstrap(r2.deps);
  expect(await r2.handlers.get('hfcm:scan')?.(mainEvent(r2, { senderFrame: { url: 'http://localhost:5173/', parent: null } }))).toMatchObject({ error: { code: 'FORBIDDEN' } });
});

test('devOriginOf', () => {
  expect(devOriginOf('http://localhost:5173/x', false)).toBe('http://localhost:5173');
  expect(devOriginOf('http://localhost:5173', true)).toBeNull();
  expect(devOriginOf('https://evil.example:1', false)).toBeNull();
  expect(devOriginOf(null, false)).toBeNull();
});

test('scan progress is forwarded to the window and dropped once it is destroyed', async () => {
  const r = rig();
  await bootstrap(r.deps);
  const emit = r.built[0];
  const p: ScanProgressDTO = { phase: 'scan', done: 1, total: 3 };
  emit?.(p);
  expect(r.win.sent).toEqual([[SCAN_PROGRESS_EVENT, p]]);
  r.win.destroyed = true;
  emit?.(p);
  expect(r.win.sent).toHaveLength(1);
});

test('download progress and download-done events go to the window on their own channels, dropped once it is destroyed', async () => {
  const r = rig();
  let ev: Parameters<BootDeps['buildServices']>[0] | null = null;
  r.deps.buildServices = (ctx) => { ev = ctx; return r.svc as unknown as ServiceSurface; };
  await bootstrap(r.deps);
  const p = { id: 'i', path: 'a.gguf', state: 'downloading', bytes: 1, size: 2, bytesPerSec: 0, error: null } as const;
  const d = { id: 'i', repoId: 'o/n', type: 'model' } as const;
  ev!.emitDownloadProgress(p);
  ev!.emitDownloadDone(d);
  expect(r.win.sent).toEqual([[DOWNLOAD_PROGRESS_EVENT, p], [DOWNLOAD_DONE_EVENT, d]]);
  r.win.destroyed = true;
  ev!.emitDownloadProgress(p);
  expect(r.win.sent).toHaveLength(2);
});

test('progress before the window exists is dropped, not thrown', async () => {
  const r = rig();
  r.deps.buildServices = ({ emitProgress }) => { emitProgress({ phase: 'scan', done: 0, total: 1 }); return r.svc as unknown as ServiceSurface; };
  await expect(bootstrap(r.deps)).resolves.toBe('started');
});

test('second-instance focuses (restoring if minimised); activate reopens only when the window is gone; closing quits except on macOS', async () => {
  const r = rig();
  await bootstrap(r.deps);
  r.appHandlers['second-instance']?.();
  r.win.minimized = true;
  r.appHandlers['second-instance']?.();
  expect(r.events.slice(-3)).toEqual(['focus', 'restore', 'focus']);
  r.appHandlers['activate']?.();
  expect(r.windows.n).toBe(1);
  r.win.destroyed = true;
  r.appHandlers['activate']?.();
  expect(r.windows.n).toBe(2);
  r.win.destroyed = true;
  r.appHandlers['second-instance']?.();
  r.appHandlers['window-all-closed']?.();
  expect(r.events.filter((e) => e === 'quit')).toHaveLength(1);
  const mac = rig({}, { platform: 'darwin' });
  await bootstrap(mac.deps);
  mac.appHandlers['window-all-closed']?.();
  expect(mac.events).not.toContain('quit');
});

test('a throw while building services is fatal, not an unhandled rejection', async () => {
  const r = rig();
  r.deps.buildServices = () => { throw new Error('boom'); };
  expect(await bootstrap(r.deps)).toBe('fatal');
  expect(r.fatal[0]).toContain('boom');
  expect(r.events).toContain('quit');
});

test('guardPathsFor reads the hub, config, view roots, HF_HOME and home exactly as the services will', () => {
  const env = { HF_HUB_CACHE: '/t/hub', HFHUB_CONFIG: '/t/cfg.toml', HF_HOME: '/t/hf' };
  const cfg = { path: '/t/cfg.toml', exists: true, views: { lmstudio: { root: '/t/lm', aliases: {} }, ollama: { root: null, aliases: {} } } };
  expect(guardPathsFor(env, '/t/home', '/t/ud', cfg)).toEqual({
    hubRoot: '/t/hub', userDataDir: '/t/ud', configPath: '/t/cfg.toml', viewRoots: ['/t/lm', null], hfHome: '/t/hf', home: '/t/home',
  });
  expect(guardPathsFor(env, '/t/home', '/t/ud', null).viewRoots).toEqual([]);
});

test('production services: the real port gets no test-only options', () => {
  vi.mocked(corePort.createCorePort).mockClear();
  const svc = createProductionServices({ userDataDir: USER_DATA, env: { HFCM_OFFLINE: '1' }, home: HOME, platform: 'linux', emitProgress: () => undefined });
  expect(API_METHODS.every((m) => typeof svc[m] === 'function')).toBe(true);
  const opts = vi.mocked(corePort.createCorePort).mock.calls[0]?.[0];
  expect(opts).toEqual({ userDataDir: USER_DATA, env: { HFCM_OFFLINE: '1' }, home: HOME, offline: true });
  expect(opts).not.toHaveProperty('testPlanner');
  expect(opts).not.toHaveProperty('maxManifestBytes');
  createProductionServices({ userDataDir: USER_DATA, env: {}, home: HOME, platform: 'linux', emitProgress: () => undefined });
  expect(vi.mocked(corePort.createCorePort).mock.calls[1]?.[0]).toMatchObject({ offline: false });
});

test('startup never runs auto-empty by itself', async () => {
  const r = rig();
  await bootstrap(r.deps);
  expect(Object.keys(r.svc).sort()).toEqual([...API_METHODS].sort()); // the surface has no runAutoEmpty to call
  const src = await import('node:fs/promises').then((m) => m.readFile('src/main/bootstrap.ts', 'utf8'));
  const idx = await import('node:fs/promises').then((m) => m.readFile('src/main/index.ts', 'utf8'));
  expect(src + idx).not.toContain('runAutoEmpty');
});

const E2E_OK = { HFCM_E2E: '1', HFCM_E2E_ROOT: TMP, HFHUB_CONFIG: `${TMP}/cfg.toml`, HFCM_USER_DATA_DIR: USER_DATA, HOME: `${TMP}/home`, HF_HOME: `${TMP}/hf` };

test('E2E pre-check: a bad root, missing or outside userData or config exits before setPath, the lock or whenReady', async () => {
  const bad: Array<[string, NodeJS.ProcessEnv]> = [
    ['no root', { ...E2E_OK, HFCM_E2E_ROOT: undefined }],
    ['root is home', { ...E2E_OK, HFCM_E2E_ROOT: HOME }],
    ['no userData', { ...E2E_OK, HFCM_USER_DATA_DIR: undefined }],
    ['userData outside', { ...E2E_OK, HFCM_USER_DATA_DIR: `${HOME}/.config/hf-cache-manager` }],
    ['no config path', { ...E2E_OK, HFHUB_CONFIG: undefined }],
    ['config outside', { ...E2E_OK, HFHUB_CONFIG: `${HOME}/.config/hfhub/config.toml` }],
    ['hub outside', { ...E2E_OK, HF_HUB_CACHE: `${HOME}/.cache/huggingface/hub` }],
    ['legacy hub var outside', { ...E2E_OK, HUGGINGFACE_HUB_CACHE: `${HOME}/.cache/huggingface/hub` }],
    ['HF_HOME outside', { ...E2E_OK, HF_HOME: `${HOME}/.cache/huggingface` }],
    ['HF_HOME unset (falls back to the home)', { ...E2E_OK, HF_HOME: undefined, HOME: HOME }],
    ['staging', { ...E2E_OK, HUGGINGFACE_CO_STAGING: '1' }],
  ];
  for (const [name, env] of bad) {
    const r = rig(env);
    r.deps.home = env['HOME'] ?? HOME;
    expect(await bootstrap(r.deps), name).toBe('fatal');
    expect(r.events, name).toHaveLength(1);
    expect(r.events[0], name).toMatch(/^exit:HFCM_E2E is set but /);
    expect(r.handlers.size).toBe(0);
  }
});

test('E2E pre-check passes: setPath to the guarded dir comes first, then the lock', async () => {
  const r = rig(E2E_OK);
  const fs = fsWith((p) => (p === USER_DATA ? dirStat() : enoent()));
  r.deps.fs = fs;
  r.deps.guardOptions = { fs, homedir: HOME, projectDir: PROJECT };
  r.deps.home = `${TMP}/home`;
  expect(await bootstrap(r.deps)).toBe('started');
  expect(r.events.slice(0, 3)).toEqual([`setPath:${USER_DATA}`, 'lock', 'whenReady']);
});

test('without HFCM_E2E the pre-check does nothing (production relies on the default userData)', async () => {
  const r = rig();
  await bootstrap(r.deps);
  expect(r.events[0]).toBe('lock');
});

test('a missing userData is created by the guarded mkdir after ready, then the app starts', async () => {
  const made: string[] = [];
  const base = fsWith((p) => (made.includes(p) || p === '/home/user/.config' ? dirStat() : enoent()));
  const r = rig({}, { fs: base, userData: '/home/user/.config/hfcm' });
  r.deps.mkdir = (p) => { made.push(p); return Promise.resolve(); };
  expect(await bootstrap(r.deps)).toBe('started');
  expect(made).toEqual(['/home/user/.config/hfcm']);
});

test('HFCM_E2E_ROOT alone turns the guard on (a harness that loses HFCM_E2E still fails closed)', async () => {
  const r = rig({ HFCM_E2E_ROOT: TMP, HFHUB_CONFIG: `${HOME}/.config/hfhub/config.toml`, HFCM_USER_DATA_DIR: USER_DATA });
  expect(await bootstrap(r.deps)).toBe('fatal');
  expect(r.events).toHaveLength(1);
  expect(r.events[0]).toMatch(/^exit:HFCM_E2E is set but the config path/);
});

test('E2E: every fatal after ready exits non-zero without a dialog; production keeps the dialog and quits', async () => {
  const fs = fsWith(() => linkStat());
  const e2e = rig(E2E_OK, { fs });
  e2e.deps.home = `${TMP}/home`;
  e2e.deps.guardOptions = { fs: userDataOnly, homedir: HOME, projectDir: PROJECT };   // the pre-check passes; ensureUserDataDir sees a link
  expect(await bootstrap(e2e.deps)).toBe('fatal');
  expect(e2e.events.at(-1)).toMatch(/^exit:The app data location is not a folder/);
  expect(e2e.events).not.toContain('quit');
  const prod = rig({}, { fs });
  prod.deps.exitEarly = () => { throw new Error('production must not exit early'); };
  expect(await bootstrap(prod.deps)).toBe('fatal');
  expect(prod.events.at(-1)).toBe('quit');
});

test('e2eGraceMs: only a guarded E2E run may shorten the auto-empty grace period, and only to a sane value', () => {
  const g = { HFCM_E2E_AUTO_EMPTY_GRACE_MS: '4000' };
  expect(e2eGraceMs(g)).toBeUndefined();
  expect(e2eGraceMs({ ...g, HFCM_E2E: '' })).toBeUndefined();
  expect(e2eGraceMs({ ...E2E_OK, ...g })).toBe(4000);
  expect(e2eGraceMs({ HFCM_E2E_ROOT: TMP, ...g })).toBe(4000);
  expect(e2eGraceMs({ ...E2E_OK, HFCM_E2E_AUTO_EMPTY_GRACE_MS: '1000' })).toBe(1000);
  expect(e2eGraceMs({ ...E2E_OK, HFCM_E2E_AUTO_EMPTY_GRACE_MS: String(AUTO_EMPTY_GRACE_MS) })).toBe(AUTO_EMPTY_GRACE_MS);
  for (const bad of [undefined, '', '999', String(AUTO_EMPTY_GRACE_MS + 1), '4000.5', '-4000', '0x1000', '4e3', ' 4000', 'abc']) {
    expect(e2eGraceMs({ ...E2E_OK, HFCM_E2E_AUTO_EMPTY_GRACE_MS: bad }), String(bad)).toBeUndefined();
  }
});

test('production services deps carry the E2E grace override only under HFCM_E2E', () => {
  const base = { userDataDir: USER_DATA, home: HOME, platform: 'linux' as const, emitProgress: () => undefined };
  expect(productionServicesDeps({ ...base, env: { HFCM_E2E_AUTO_EMPTY_GRACE_MS: '4000' } })).not.toHaveProperty('autoEmptyGraceMs');
  expect(productionServicesDeps({ ...base, env: { ...E2E_OK, HFCM_E2E_AUTO_EMPTY_GRACE_MS: '4000' } }).autoEmptyGraceMs).toBe(4000);
  expect(productionServicesDeps({ ...base, env: { ...E2E_OK } })).not.toHaveProperty('autoEmptyGraceMs');
});

test('E2E pre-check: the real home (os.homedir) outside the run dir exits before anything else, whatever $HOME claims', async () => {
  const r = rig(E2E_OK);   // the rig's home is the real one
  expect(await bootstrap(r.deps)).toBe('fatal');
  expect(r.events).toEqual([`exit:${r.fatal[0]!}`]);
  expect(r.fatal[0]).toContain('HFCM_E2E is set but HOME is outside the temp dir');
});

test('final review M7a: a rejected bootstrap is fatal through the same E2E-aware path (exit 1 under E2E, never a dialog)', async () => {
  const calls: string[] = [];
  const sink = (env: NodeJS.ProcessEnv) => ({
    env, exitEarly: (m: string) => { calls.push(`exit:${m}`); }, reportFatal: (m: string) => { calls.push(`dialog:${m}`); },
    quit: () => { calls.push('quit'); },
  });
  bootFailed(new Error('boom'), sink({ HFCM_E2E: '1' }));
  expect(calls).toEqual(['exit:HF Cache Manager could not start: boom']);
  calls.length = 0;
  bootFailed('plain', sink({ HFCM_E2E_ROOT: TMP }));
  expect(calls).toEqual(['exit:HF Cache Manager could not start: plain']);
  calls.length = 0;
  bootFailed(new Error('boom'), sink({}));
  expect(calls).toEqual(['dialog:HF Cache Manager could not start: boom', 'quit']);
  // index.ts routes its top-level rejection through it and shows no dialog of its own there
  const idx = await import('node:fs/promises').then((m) => m.readFile('src/main/index.ts', 'utf8'));
  const tail = idx.slice(idx.lastIndexOf('}).catch('));
  expect(tail).toMatch(/^\}\)\.catch\(\(e: unknown\) => \{\n {2}bootFailed\(e, \{/);
  expect(tail).not.toContain('showErrorBox');
});

test('machine detection starts once, after the window, without blocking the start', async () => {
  const r = rig();
  let release!: () => void;
  r.svc.redetectMachine.mockImplementation(() => {
    r.events.push('detect');
    return new Promise((res) => { release = () => res({ ok: true, data: null }); });
  });
  expect(await bootstrap(r.deps)).toBe('started');   // resolves while detection is still pending
  expect(r.events).toEqual(['lock', 'whenReady', `build:${USER_DATA}`, 'window', 'detect']);
  expect(r.svc.redetectMachine).toHaveBeenCalledTimes(1);
  release();
});

test('the download engine is started once, after the window, without blocking the start', async () => {
  const r = rig();
  const startDownloads = vi.fn(() => { r.events.push('downloads'); return new Promise<void>(() => undefined); });
  (r.svc as unknown as { startDownloads: typeof startDownloads }).startDownloads = startDownloads;
  expect(await bootstrap(r.deps)).toBe('started');
  expect(r.events.indexOf('downloads')).toBeGreaterThan(r.events.indexOf('window'));
  expect(startDownloads).toHaveBeenCalledTimes(1);
});

test('a failed guard never starts machine detection', async () => {
  const r = rig({ ...E2E_OK, HOME: '/elsewhere' });
  await bootstrap(r.deps);
  expect(r.svc.redetectMachine).not.toHaveBeenCalled();
});

const MACHINE = { platform: 'linux', ramBytes: 64 * 2 ** 30, gpuName: 'Test GPU', gpuBytes: 24 * 2 ** 30, gpuKind: 'nvidia', computeCap: 8.9, drivesDisplay: false };

test('e2eMachine: HFCM_E2E_MACHINE is honoured only under the guarded E2E run; under E2E without it there is no GPU', () => {
  const json = JSON.stringify(MACHINE);
  expect(e2eMachine({ HFCM_E2E_MACHINE: json }, 'linux', 1000)).toBeUndefined();
  expect(e2eMachine({ HFCM_E2E: '', HFCM_E2E_MACHINE: json }, 'linux', 1000)).toBeUndefined();
  expect(e2eMachine({ ...E2E_OK, HFCM_E2E_MACHINE: json }, 'linux', 1000)).toEqual(MACHINE);
  const none = { platform: 'linux', ramBytes: 1000, gpuName: null, gpuBytes: null, gpuKind: 'other', computeCap: null, drivesDisplay: false };
  expect(e2eMachine({ ...E2E_OK }, 'linux', 1000)).toEqual(none);
  for (const bad of ['', '{', '[]', 'null', JSON.stringify({ ...MACHINE, extra: 1 }), JSON.stringify({ ...MACHINE, gpuKind: 'amd' }),
    JSON.stringify({ ...MACHINE, ramBytes: -1 }), JSON.stringify({ ...MACHINE, platform: 'plan9' })]) {
    expect(e2eMachine({ ...E2E_OK, HFCM_E2E_MACHINE: bad }, 'linux', 1000), bad).toEqual(none);
  }
});

test('e2eDisk: HFCM_E2E_DISK is honoured only under the guarded E2E run, and only as a strict {totalBytes, freeBytes}', async () => {
  const json = JSON.stringify({ totalBytes: 2e12, freeBytes: 5e11 });
  expect(e2eDisk({ HFCM_E2E_DISK: json })).toBeUndefined();
  expect(e2eDisk({ ...E2E_OK })).toBeUndefined();
  const statfs = e2eDisk({ ...E2E_OK, HFCM_E2E_DISK: json });
  expect(await statfs!('/any')).toEqual({ bsize: 1, blocks: 2e12, bfree: 5e11, bavail: 5e11 });
  for (const bad of ['', '{', 'null', JSON.stringify({ totalBytes: 1 }), JSON.stringify({ totalBytes: 1, freeBytes: 2 }),
    JSON.stringify({ totalBytes: 2, freeBytes: 1, extra: 0 }), JSON.stringify({ totalBytes: -1, freeBytes: -2 })]) {
    expect(e2eDisk({ ...E2E_OK, HFCM_E2E_DISK: bad }), bad).toBeUndefined();
  }
  const base = { userDataDir: USER_DATA, home: HOME, platform: 'linux' as const, emitProgress: () => undefined };
  expect(productionServicesDeps({ ...base, env: { ...E2E_OK, HFCM_E2E_DISK: json } }).statfs).toBeDefined();
  expect(productionServicesDeps({ ...base, env: { ...E2E_OK, HFCM_E2E_DISK: json } }).download?.statfs).toBeDefined();
  expect(productionServicesDeps({ ...base, env: { HFCM_E2E_DISK: json } }).statfs).toBeUndefined();
  expect(productionServicesDeps({ ...base, env: { HFCM_E2E_DISK: json } }).download).toBeUndefined();
});

test('production deps: detection uses nvidia-smi only outside E2E; under E2E it never spawns', async () => {
  const base = { userDataDir: USER_DATA, home: HOME, platform: 'linux' as const, emitProgress: () => undefined };
  vi.mocked(hardware.detectMachine).mockClear();
  const e2e = productionServicesDeps({ ...base, env: { ...E2E_OK, HFCM_E2E_MACHINE: JSON.stringify(MACHINE) } });
  expect(await e2e.detectMachine!()).toEqual(MACHINE);
  expect(await productionServicesDeps({ ...base, env: { ...E2E_OK } }).detectMachine!()).toMatchObject({ gpuBytes: null });
  expect(hardware.detectMachine).not.toHaveBeenCalled();
  expect(hardware.productionExec).not.toHaveBeenCalled();
  await productionServicesDeps({ ...base, env: {} }).detectMachine!();
  expect(hardware.detectMachine).toHaveBeenCalledTimes(1);
  expect(vi.mocked(hardware.detectMachine).mock.calls[0]![0]).toMatchObject({ platform: 'linux', exec: hardware.productionExec });
});

test('HFCM_NO_GPU_DETECT=1 turns detection off in every mode, without exec; HFCM_E2E_MACHINE still wins under E2E', async () => {
  const base = { userDataDir: USER_DATA, home: HOME, platform: 'linux' as const, emitProgress: () => undefined };
  vi.mocked(hardware.detectMachine).mockClear();
  vi.mocked(hardware.productionExec).mockClear();
  const off = await productionServicesDeps({ ...base, env: { HFCM_NO_GPU_DETECT: '1' } }).detectMachine!();
  expect(off).toMatchObject({ platform: 'linux', gpuBytes: null, gpuName: null, gpuKind: 'other' });
  expect(off.ramBytes).toBeGreaterThan(0);
  expect(await productionServicesDeps({ ...base, env: { ...E2E_OK, HFCM_NO_GPU_DETECT: '1' } }).detectMachine!()).toMatchObject({ gpuBytes: null });
  expect(await productionServicesDeps({ ...base, env: { ...E2E_OK, HFCM_NO_GPU_DETECT: '1', HFCM_E2E_MACHINE: JSON.stringify(MACHINE) } })
    .detectMachine!()).toEqual(MACHINE);
  expect(await productionServicesDeps({ ...base, env: { HFCM_NO_GPU_DETECT: '1', HFCM_E2E_MACHINE: JSON.stringify(MACHINE) } })
    .detectMachine!()).toMatchObject({ gpuBytes: null });   // no guard: the E2E profile is ignored
  expect(hardware.detectMachine).not.toHaveBeenCalled();
  expect(hardware.productionExec).not.toHaveBeenCalled();
  for (const v of ['0', '', 'yes']) {
    await productionServicesDeps({ ...base, env: { HFCM_NO_GPU_DETECT: v } }).detectMachine!();
  }
  expect(hardware.detectMachine).toHaveBeenCalledTimes(3);   // only exactly '1' turns it off
});
