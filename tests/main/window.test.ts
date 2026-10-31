import { mkdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { cspFor, PROD_CSP, swapMetaCsp } from '../../src/main/csp';
import { guardTestEnv, isE2E, realpathNearest } from '../../src/main/env-guard';
import type { GuardPaths } from '../../src/main/env-guard';
import type { ReadFs } from '../../src/core/fsx';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { createMainWindow, hardenWebContents, resolveRendererUrl, webPreferencesFor } from '../../src/main/window';
import type { BlockedEvent, WebContentsLike } from '../../src/main/window';
import { useCanaries } from '../helpers/canary';

useCanaries();
beforeEach(() => expect.hasAssertions());

const PINNED_PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

test('webPreferences are locked down', () => {
  expect(webPreferencesFor('/app/out/preload/index.cjs')).toEqual({
    preload: '/app/out/preload/index.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false,
  });
});

test('production CSP is exact and the index.html meta matches it', async () => {
  const csp = cspFor(false);
  expect(csp).toBe(PINNED_PROD_CSP);
  expect(PROD_CSP).toBe(PINNED_PROD_CSP);
  const html = await readFile('src/renderer/index.html', 'utf8');
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  expect(cspFor(true, 'http://localhost:5173')).toContain("connect-src 'self' http://localhost:5173 ws://localhost:5173");
});

test('dev CSP only loosens script-src and connect-src; prod never has unsafe-inline scripts or a dev origin', () => {
  const dev = cspFor(true, 'http://localhost:5173');
  expect(dev).toContain("script-src 'self' 'unsafe-inline';");
  expect(dev).toContain('ws://localhost:5173');
  expect(cspFor(true)).toContain("script-src 'self' 'unsafe-inline'");
  expect(cspFor(true)).not.toContain('ws://');
  expect(cspFor(false)).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(cspFor(false, 'http://localhost:5173')).toBe(PINNED_PROD_CSP);
  for (const csp of [dev, cspFor(false)]) {
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/\*/);
  }
});

function makeFake() {
  const handlers = new Map<BlockedEvent, (e: { preventDefault(): void }, url: string) => void>();
  let open: (() => { action: 'deny' }) | undefined;
  let perm: ((wc: unknown, p: string, cb: (ok: boolean) => void) => void) | undefined;
  let check: (() => boolean) | undefined;
  const wc: WebContentsLike = {
    on: (ev, fn) => void handlers.set(ev, fn),
    setWindowOpenHandler: (fn) => void (open = fn),
    session: { setPermissionRequestHandler: (fn) => void (perm = fn), setPermissionCheckHandler: (fn) => void (check = fn) },
  };
  return {
    wc, handlers,
    open: () => open?.(), perm: () => perm, check: () => check?.(),
  };
}

test('navigation, redirects, webviews, new windows and permission requests are denied', () => {
  const f = makeFake();
  hardenWebContents(f.wc);
  expect([...f.handlers.keys()].sort()).toEqual(['will-attach-webview', 'will-frame-navigate', 'will-navigate', 'will-redirect']);
  for (const url of ['https://evil.example/', 'file:///tmp/evil.html', 'file:///app/out/renderer/index.html', 'http://localhost:5173/']) {
    for (const [, fn] of f.handlers) {
      const ev = { preventDefault: vi.fn() };
      fn(ev, url);
      expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    }
  }
  expect(f.open()).toEqual({ action: 'deny' });
  for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read']) {
    const cb = vi.fn();
    f.perm()?.(null, p, cb);
    expect(cb).toHaveBeenCalledWith(false);
  }
  expect(f.check()).toBe(false);
});

// ---- dev CSP swap ----

test('swapMetaCsp swaps the meta for the dev CSP and THROWS when the expected meta text is missing', async () => {
  const html = await readFile('src/renderer/index.html', 'utf8');
  const out = swapMetaCsp(html, 'http://localhost:5173');
  expect(out).toContain(cspFor(true, 'http://localhost:5173'));
  expect(out).not.toContain(PROD_CSP);
  expect(() => swapMetaCsp('<html><meta http-equiv="Content-Security-Policy" content="default-src *"></html>', 'http://localhost:5173'))
    .toThrow('CSP meta');
});

// ---- renderer URL and createMainWindow ----

test.each([
  ['http://localhost:5173', false, 'http://localhost:5173'],
  ['http://localhost:5173/', false, 'http://localhost:5173/'],
  ['http://127.0.0.1:3000', false, 'http://127.0.0.1:3000'],
  ['http://localhost:5173', true, null],
  [undefined, false, null],
  [null, false, null],
  ['', false, null],
  ['https://localhost:5173', false, null],
  ['http://localhost', false, null],
  ['http://evil.example:5173', false, null],
  ['http://localhost.evil.example:5173', false, null],
  ['http://user:pw@localhost:5173', false, null],
  ['file:///tmp/evil.html', false, null],
  ['not a url', false, null],
] as const)('resolveRendererUrl(%j, packaged=%j) -> %j', (raw, packaged, want) => {
  expect(resolveRendererUrl(raw, packaged)).toBe(want);
});

function makeFakeWindow() {
  const log = {
    options: undefined as Record<string, unknown> | undefined,
    wcHandlers: new Map<string, (e: { preventDefault(): void; url: string }) => void>(),
    open: undefined as (() => unknown) | undefined,
    perm: undefined as ((wc: unknown, p: string, cb: (ok: boolean) => void) => void) | undefined,
    check: undefined as (() => boolean) | undefined,
    headers: undefined as ((d: { responseHeaders: Record<string, string[]> }, cb: (r: { responseHeaders: Record<string, string[]> }) => void) => void) | undefined,
    once: new Map<string, () => void>(),
    shown: 0,
    loadedUrl: undefined as string | undefined,
    loadedFile: undefined as string | undefined,
  };
  class FakeWindow {
    webContents = {
      on: (ev: string, fn: (e: { preventDefault(): void; url: string }) => void) => void log.wcHandlers.set(ev, fn),
      setWindowOpenHandler: (fn: () => unknown) => void (log.open = fn),
      session: {
        setPermissionRequestHandler: (fn: NonNullable<typeof log.perm>) => void (log.perm = fn),
        setPermissionCheckHandler: (fn: () => boolean) => void (log.check = fn),
        webRequest: { onHeadersReceived: (fn: NonNullable<typeof log.headers>) => void (log.headers = fn) },
      },
    };
    constructor(o: Record<string, unknown>) { log.options = o; }
    once(ev: string, fn: () => void) { log.once.set(ev, fn); }
    show() { log.shown++; }
    loadURL(u: string) { log.loadedUrl = u; return Promise.resolve(); }
    loadFile(f: string) { log.loadedFile = f; return Promise.resolve(); }
  }
  return { log, Ctor: FakeWindow as unknown as new (o: BrowserWindowConstructorOptions) => BrowserWindow };
}

const winOpts = { preloadPath: '/app/preload/index.cjs', rendererFile: '/app/renderer/index.html' };

test('createMainWindow (packaged): file load, prod CSP header, hidden until ready, size, hardened', () => {
  const f = makeFakeWindow();
  createMainWindow({ ...winOpts, rendererUrl: 'http://localhost:5173', isPackaged: true }, { BrowserWindow: f.Ctor });
  expect(f.log.options).toMatchObject({ backgroundColor: '#0f1115', minWidth: 960, minHeight: 600, show: false, webPreferences: webPreferencesFor(winOpts.preloadPath) });
  expect(f.log.loadedUrl).toBeUndefined();
  expect(f.log.loadedFile).toBe(winOpts.rendererFile);
  let sent: Record<string, string[]> | undefined;
  f.log.headers?.({ responseHeaders: { 'X-A': ['1'], 'content-security-policy': ['x'] } }, (r) => void (sent = r.responseHeaders));
  expect(sent?.['Content-Security-Policy']).toEqual([PINNED_PROD_CSP]);
  expect(sent?.['X-A']).toEqual(['1']);
  expect(sent?.['content-security-policy']).toBeUndefined();
  expect(f.log.shown).toBe(0);
  f.log.once.get('ready-to-show')?.();
  expect(f.log.shown).toBe(1);
  for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) {
    const e = { preventDefault: vi.fn(), url: 'https://evil.example/' };
    f.log.wcHandlers.get(ev)?.(e);
    expect(e.preventDefault, ev).toHaveBeenCalledTimes(1);
  }
  expect(f.log.open?.()).toEqual({ action: 'deny' });
  expect(f.log.check?.()).toBe(false);
  const cb = vi.fn();
  f.log.perm?.(null, 'media', cb);
  expect(cb).toHaveBeenCalledWith(false);
});

test('createMainWindow (dev, unpackaged): loads the local dev URL with the dev CSP; a non-local URL falls back to the file', () => {
  const dev = makeFakeWindow();
  createMainWindow({ ...winOpts, rendererUrl: 'http://localhost:5173', isPackaged: false }, { BrowserWindow: dev.Ctor });
  expect(dev.log.loadedUrl).toBe('http://localhost:5173');
  let sent: Record<string, string[]> | undefined;
  dev.log.headers?.({ responseHeaders: {} }, (r) => void (sent = r.responseHeaders));
  expect(sent?.['Content-Security-Policy']).toEqual([cspFor(true, 'http://localhost:5173')]);

  const bad = makeFakeWindow();
  createMainWindow({ ...winOpts, rendererUrl: 'https://evil.example', isPackaged: false }, { BrowserWindow: bad.Ctor });
  expect(bad.log.loadedUrl).toBeUndefined();
  expect(bad.log.loadedFile).toBe(winOpts.rendererFile);
  let prod: Record<string, string[]> | undefined;
  bad.log.headers?.({ responseHeaders: {} }, (r) => void (prod = r.responseHeaders));
  expect(prod?.['Content-Security-Policy']).toEqual([PINNED_PROD_CSP]);
});

// ---- environment guard ----

const TMP = '/tmp/hfcm-e2e-abc123';
const HOME_REAL = '/home/user';
const PROJECT = '/home/user/Projects/HF Cache Model Manager';
const enoent = (): never => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};
/** Nothing exists: every path resolves lexically. */
const emptyFs: ReadFs = {
  lstat: enoent, stat: enoent, readlink: enoent, readdir: enoent, readFile: enoent as ReadFs['readFile'],
  realpath: enoent, statfs: enoent,
};
const good = (): GuardPaths => ({
  hubRoot: `${TMP}/hf/hub`, userDataDir: `${TMP}/ud`, configPath: `${TMP}/cfg/config.toml`,
  viewRoots: [`${TMP}/lm`, `${TMP}/ollama`], hfHome: `${TMP}/hf`, home: `${TMP}/home`,
});
const E2E = { HFCM_E2E: '1', HFHUB_CONFIG: `${TMP}/cfg/config.toml` };
const run = (env: NodeJS.ProcessEnv, p: GuardPaths, tmp = TMP): Promise<void> =>
  guardTestEnv(env, p, tmp, { fs: emptyFs, homedir: HOME_REAL, projectDir: PROJECT });
const PREFIX = /^HFCM_E2E is set but/;

test('E2E guard refuses a hub outside the temp dir, with the exact messages', async () => {
  await expect(run(E2E, { ...good(), hubRoot: '/home/u/.cache/huggingface/hub' }))
    .rejects.toThrow('HFCM_E2E is set but the hub is outside the temp dir: /home/u/.cache/huggingface/hub');
  await expect(run(E2E, { ...good(), userDataDir: '/home/u/x' }))
    .rejects.toThrow('HFCM_E2E is set but userData is outside the temp dir: /home/u/x');
  await expect(run(E2E, good())).resolves.toBeUndefined();
});

test('guard is a no-op when HFCM_E2E is unset or empty', async () => {
  const bad: GuardPaths = { hubRoot: '/home/u/hub', userDataDir: null, configPath: '/home/u/c', viewRoots: ['/home/u/lm'], hfHome: '/home/u', home: '/home/u' };
  await expect(run({}, bad)).resolves.toBeUndefined();
  await expect(run({ HFCM_E2E: '' }, bad)).resolves.toBeUndefined();
  expect(isE2E({})).toBe(false);
  expect(isE2E({ HFCM_E2E: '' })).toBe(false);
  expect(isE2E({ HFCM_E2E: '0' })).toBe(true); // fail closed: any non-empty value turns the guard on
  await expect(run({ HFCM_E2E: '0' }, bad)).rejects.toThrow(PREFIX);
});

test.each([
  ['config path', { configPath: '/home/u/.config/hfhub/config.toml' }, 'the config path is outside the temp dir: /home/u/.config/hfhub/config.toml'],
  ['LM Studio root', { viewRoots: ['/home/u/.lmstudio/models', null] }, 'a view root is outside the temp dir: /home/u/.lmstudio/models'],
  ['Ollama root', { viewRoots: [null, '/home/u/.ollama/models'] }, 'a view root is outside the temp dir: /home/u/.ollama/models'],
  ['one bad of two roots', { viewRoots: [`${TMP}/lm`, '/home/u/.ollama/models'] }, 'a view root is outside'],
  ['HF_HOME', { hfHome: '/home/u/.cache/huggingface' }, 'HF_HOME is outside the temp dir: /home/u/.cache/huggingface'],
  ['HOME', { home: '/home/u' }, 'HOME is outside the temp dir: /home/u'],
  ['userData unset', { userDataDir: null }, 'userData is not set'],
  ['relative hub', { hubRoot: 'x/hub' }, 'the hub is outside the temp dir: x/hub'],
  ['hub equal to the temp dir', { hubRoot: TMP }, `the hub is outside the temp dir: ${TMP}`],
  ['dot-dot escape', { hubRoot: `${TMP}/../../home/u/hub` }, 'outside the temp dir'],
  ['sibling prefix', { hubRoot: `${TMP}-evil/hub` }, 'outside the temp dir'],
] as const)('guard refuses: %s', async (_n, patch, msg) => {
  await expect(run(E2E, { ...good(), ...patch } as GuardPaths)).rejects.toThrow(msg);
});

test('guard requires HFHUB_CONFIG and refuses staging and renderer-URL env vars', async () => {
  await expect(run({ HFCM_E2E: '1' }, good())).rejects.toThrow('HFHUB_CONFIG is not set');
  await expect(run({ ...E2E, HFHUB_CONFIG: '' }, good())).rejects.toThrow('HFHUB_CONFIG is not set');
  await expect(run({ ...E2E, HUGGINGFACE_CO_STAGING: '1' }, good())).rejects.toThrow('HUGGINGFACE_CO_STAGING must not be set');
  await expect(run({ ...E2E, ELECTRON_RENDERER_URL: 'http://localhost:5173' }, good())).rejects.toThrow('ELECTRON_RENDERER_URL must not be set');
});

test('HFCM_E2E_ROOT alone is E2E mode', async () => {
  expect(isE2E({ HFCM_E2E_ROOT: TMP })).toBe(true);
  expect(isE2E({ HFCM_E2E_ROOT: '' })).toBe(false);
  await expect(run({ HFCM_E2E_ROOT: TMP, HFHUB_CONFIG: `${TMP}/cfg/config.toml` }, { ...good(), hubRoot: '/home/u/hub' })).rejects.toThrow(PREFIX);
});

test('the temp root is never trusted', async () => {
  const under = (root: string): GuardPaths => ({
    hubRoot: `${root}/hf/hub`, userDataDir: `${root}/ud`, configPath: `${root}/c.toml`,
    viewRoots: [`${root}/lm`], hfHome: `${root}/hf`, home: `${root}/home`,
  });
  for (const root of ['/', '/home', HOME_REAL, `${HOME_REAL}/.cache`, '/tmp', '/home/u', PROJECT, '/home/user/Projects', 'tmp', '/tmp/not-a-run-dir', '/tmp/hfcm-e2e', '/tmp/xhfcm-e2e-1']) {
    await expect(run(E2E, under(root), root), root).rejects.toThrow(/^HFCM_E2E is set but the temp dir is not usable/);
  }
  // a run dir INSIDE the real home is accepted (it is neither the home nor an ancestor of it); only a tmp root that is, or covers, the home or the project is refused (below)
  await expect(run(E2E, under(`${HOME_REAL}/hfcm-e2e-1`), `${HOME_REAL}/hfcm-e2e-1`)).resolves.toBeUndefined();
  await expect(guardTestEnv(E2E, under('/hfcm-e2e-1'), '/hfcm-e2e-1', { fs: emptyFs, homedir: '/hfcm-e2e-1', projectDir: PROJECT }))
    .rejects.toThrow('the temp dir is not usable');
  await expect(guardTestEnv(E2E, under('/hfcm-e2e-1'), '/hfcm-e2e-1', { fs: emptyFs, homedir: HOME_REAL, projectDir: '/hfcm-e2e-1/p' }))
    .rejects.toThrow('the temp dir is not usable');
  await expect(guardTestEnv(E2E, under('/hfcm-e2e-1'), '/hfcm-e2e-1', { fs: emptyFs, homedir: HOME_REAL, projectDir: '/hfcm-e2e-1' }))
    .rejects.toThrow('the temp dir is not usable');
  // a tmp root that resolves (symlink) onto a broad location is refused
  const viaLink: ReadFs = { ...emptyFs, realpath: (p) => (p === TMP ? Promise.resolve('/home/user') : Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' }))) };
  await expect(guardTestEnv(E2E, good(), TMP, { fs: viaLink, homedir: HOME_REAL, projectDir: PROJECT })).rejects.toThrow('the temp dir is not usable');
});

test('every real-looking default path is refused, against /tmp-style and os.tmpdir() run dirs', async () => {
  const home = '/home/user';
  const defaults: Array<[string, Partial<GuardPaths>]> = [
    ['default hub', { hubRoot: `${home}/.cache/huggingface/hub` }],
    ['staging hub', { hubRoot: `${home}/.cache/huggingface_staging/hub` }],
    ['default HF_HOME', { hfHome: `${home}/.cache/huggingface` }],
    ['xdg HF_HOME', { hfHome: `${home}/.local/share/huggingface` }],
    ['default config.toml', { configPath: `${home}/.config/hfhub/config.toml` }],
    ['LM Studio (new)', { viewRoots: [`${home}/.lmstudio/models`, null] }],
    ['LM Studio (old)', { viewRoots: [`${home}/.cache/lm-studio/models`, null] }],
    ['Ollama (user)', { viewRoots: [null, `${home}/.ollama/models`] }],
    ['Ollama (system)', { viewRoots: [null, '/usr/share/ollama/.ollama/models'] }],
    ['real userData', { userDataDir: `${home}/.config/hf-cache-manager` }],
    ['real HOME', { home }],
    ['HOME itself as hub', { hubRoot: home }],
  ];
  const osRun = join(tmpdir(), 'hfcm-e2e-zzz');
  for (const [name, patch] of defaults) {
    await expect(run(E2E, { ...good(), ...patch }), name).rejects.toThrow(PREFIX);
    await expect(guardTestEnv(E2E, { ...good(), ...patch }, osRun, { fs: emptyFs, homedir: home, projectDir: PROJECT }), `${name} (os.tmpdir)`).rejects.toThrow(PREFIX);
  }
});

test('guard resolves symlinks itself: a link inside the run dir pointing outside is refused', async () => {
  const sb = useCanaries().sandbox;
  const outside = join(sb, 'outside');
  const inside = join(sb, 'hfcm-e2e-run');
  await mkdir(outside, { recursive: true });
  await mkdir(inside, { recursive: true });
  await symlink(outside, join(inside, 'link'));
  const p = (hub: string): GuardPaths => ({
    hubRoot: hub, userDataDir: join(inside, 'ud'), configPath: join(inside, 'c.toml'),
    viewRoots: [null, join(inside, 'ollama')], hfHome: join(inside, 'hf'), home: join(inside, 'home'),
  });
  const real = (hub: string): Promise<void> => guardTestEnv(E2E, p(hub), inside, { homedir: '/nonexistent-home-zz', projectDir: '/nonexistent-proj-zz' });
  await expect(real(join(inside, 'link', 'hub'))).rejects.toThrow('the hub is outside the temp dir');
  await expect(real(join(inside, 'hub'))).resolves.toBeUndefined();
  // relative / empty entries are left for the checks to refuse
  await expect(guardTestEnv(E2E, { ...p(join(inside, 'hub')), viewRoots: [''] }, inside, { homedir: '/nonexistent-home-zz', projectDir: '/nonexistent-proj-zz' }))
    .rejects.toThrow('a view root is not set');
});

test('realpathNearest: missing tails, dangling links, non-ENOENT errors', async () => {
  const sb = useCanaries().sandbox;
  const outside = join(sb, 'outside');
  const inside = join(sb, 'inside');
  await mkdir(outside, { recursive: true });
  await mkdir(inside, { recursive: true });
  await symlink(outside, join(inside, 'link'));
  await symlink(join(outside, 'not-yet'), join(inside, 'dangling'));
  await symlink('dangling-rel', join(inside, 'dangling2'));
  const ro = await realpathNearest(outside);
  expect(await realpathNearest(join(inside, 'link', 'a', 'b'))).toBe(join(ro, 'a', 'b'));
  expect(await realpathNearest(join(inside, 'dangling', 'hub'))).toBe(join(ro, 'not-yet', 'hub'));
  expect(await realpathNearest(join(inside, 'dangling2'))).toBe(join(await realpathNearest(inside), 'dangling-rel'));
  expect(await realpathNearest('/nonexistent-zzz/a')).toBe('/nonexistent-zzz/a');
  expect(await realpathNearest(outside)).toBe(ro);
  const eacces: ReadFs = { ...emptyFs, realpath: () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) };
  await expect(realpathNearest('/a/b', eacces)).rejects.toThrow('x');
  const enotdir: ReadFs = { ...emptyFs, realpath: (p) => (p === '/a/b' ? Promise.reject(Object.assign(new Error('x'), { code: 'ENOTDIR' })) : Promise.resolve(p)) };
  expect(await realpathNearest('/a/b', enotdir)).toBe('/a/b');
  const lstatBoom: ReadFs = { ...emptyFs, lstat: () => Promise.reject(Object.assign(new Error('boom'), { code: 'EACCES' })) };
  await expect(realpathNearest('/a/b', lstatBoom)).rejects.toThrow('boom');
  const loop: ReadFs = {
    ...emptyFs,
    lstat: () => Promise.resolve({ isSymbolicLink: () => true } as Awaited<ReturnType<ReadFs['lstat']>>),
    readlink: () => Promise.resolve('/loop'),
  };
  await expect(realpathNearest('/loop', loop)).rejects.toThrow('too many symbolic links');
});
