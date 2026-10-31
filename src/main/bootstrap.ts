// App bootstrap, written against small injected interfaces so the safety-critical ordering can be
// tested without Electron. Order matters and is pinned by tests/main/bootstrap.test.ts:
//   E2E pre-check (HFCM_E2E or HFCM_E2E_ROOT set: root, userData, config, hub, HF_HOME and home inside the run dir) -> userData setPath ->
//   single-instance lock -> whenReady -> ensure userData (guarded create) -> E2E guard -> services -> IPC -> window
//   -> machine detection (started, never awaited: the window does not wait for nvidia-smi).
// Under E2E every fatal exits non-zero through `exitEarly` (no dialog), so a refused run fails the test instead of hanging.
// The pre-check runs before Electron writes anything; the guard runs before any service is built, so a failed guard
// touches nothing. Auto-empty is never started here: the services schedule it themselves after the first good scan.
import { arch, totalmem } from 'node:os';
import { z } from 'zod';
import type { MachineProfile } from '../core/advice/types';
import { loadConfig } from '../core/compat/config';
import type { HfhubConfig } from '../core/compat/config';
import { configPath } from '../core/compat/config';
import { readFs } from '../core/fsx';
import type { ReadFs } from '../core/fsx';
import { resolveHfHome, resolveHubRoot } from '../core/paths';
import { DOWNLOAD_DONE_EVENT, DOWNLOAD_PROGRESS_EVENT, SCAN_PROGRESS_EVENT } from '../shared/api';
import type { DownloadDoneDTO, DownloadProgressDTO, ScanProgressDTO } from '../shared/api';
import { undetectedMachine } from './advice-service';
import { createCorePort } from './core-port';
import { guardTestEnv, isE2E, preflightTestEnv } from './env-guard';
import type { GuardOptions, GuardPaths } from './env-guard';
import { detectMachine, productionExec } from './hardware';
import { adaptIpcMain, isTrustedSender, registerIpc } from './ipc';
import type { ElectronIpcMainLike, ServiceSurface } from './ipc';
import { runScanInWorker } from './scan-client';
import { AppServices, AUTO_EMPTY_GRACE_MS } from './services';
import type { ServicesDeps } from './services';
import { networkBlockedCount } from './hub/client';
import { ensureUserDataDir } from './user-data';
import { resolveRendererUrl } from './window';
import type { WebContents } from 'electron';

export interface WindowLike {
  webContents: object & { send(channel: string, payload: unknown): void };
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export interface BootApp {
  isPackaged: boolean;
  setPath(name: 'userData', path: string): void;
  getPath(name: 'userData'): string;
  requestSingleInstanceLock(): boolean;
  quit(): void;
  whenReady(): Promise<void>;
  onWebContentsCreated(fn: (wc: WebContents) => void): void;
  onActivate(fn: () => void): void;
  onSecondInstance(fn: () => void): void;
  onWindowAllClosed(fn: () => void): void;
}

export interface BootDeps {
  app: BootApp;
  ipcMain: ElectronIpcMainLike;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** Read-only fs for the userData check and the config read (default the real one). */
  fs?: ReadFs;
  guardOptions?: GuardOptions;
  harden: (wc: WebContents) => void;
  buildServices: (ctx: ServiceEvents & { userDataDir: string }) => ServiceSurface & Partial<Pick<AppServices, 'startDownloads'>>;
  createWindow: () => WindowLike;
  rendererFile: string;
  /** Raw ELECTRON_RENDERER_URL (or null); validated by `resolveRendererUrl`. */
  rendererUrl: string | null;
  reportFatal: (message: string) => void;
  /** E2E: print to stderr and exit non-zero, never a dialog (the pre-check runs before Electron has written anything; every later E2E fatal also ends here). */
  exitEarly: (message: string) => void;
  /** The single non-recursive mkdir behind `ensureUserDataDir` (default the real fs). */
  mkdir?: (path: string) => Promise<void>;
}

export type BootResult = 'started' | 'second-instance' | 'fatal';

/** The events main sends to the window (each dropped while there is no live window). */
export interface ServiceEvents {
  emitProgress: (p: ScanProgressDTO) => void;
  emitDownloadProgress: (e: DownloadProgressDTO) => void;
  emitDownloadDone: (e: DownloadDoneDTO) => void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Final review M7a: index.ts's handler for a bootstrap that rejected (a throw outside bootstrap's own try, such as one
 * before whenReady). The same E2E-aware fatal path as inside bootstrap: under E2E it exits non-zero through `exitEarly`
 * (a modal dialog would hang a headless run); otherwise the error dialog, then quit.
 */
export function bootFailed(e: unknown, d: { env: NodeJS.ProcessEnv; exitEarly: (m: string) => void; reportFatal: (m: string) => void; quit: () => void }): void {
  const message = `HF Cache Manager could not start: ${errText(e)}`;
  if (isE2E(d.env)) {
    d.exitEarly(message);
    return;
  }
  d.reportFatal(message);
  d.quit();
}

/** The origin of a validated dev server url (unpackaged only), else null. */
export function devOriginOf(raw: string | null, isPackaged: boolean): string | null {
  const url = resolveRendererUrl(raw, isPackaged);
  return url === null ? null : new URL(url).origin;
}

/** Every location an E2E run must keep inside its temp root, resolved exactly as the services will resolve them. */
export function guardPathsFor(env: NodeJS.ProcessEnv, home: string, userDataDir: string, cfg: HfhubConfig | null): GuardPaths {
  return {
    hubRoot: resolveHubRoot(env, home),
    userDataDir,
    configPath: configPath(env, home),
    viewRoots: cfg === null ? [] : [cfg.views.lmstudio.root, cfg.views.ollama.root],
    hfHome: resolveHfHome(env, home),
    home,
  };
}

/**
 * The E2E-only auto-empty grace override (HFCM_E2E_AUTO_EMPTY_GRACE_MS, whole milliseconds, 1000..AUTO_EMPTY_GRACE_MS).
 * Honoured only when the E2E guard is on (`isE2E`): bootstrap builds the services only after that guard has passed, so a
 * shortened countdown can only ever run against a temp-dir fixture. Anything else (unset, malformed, out of range) is
 * ignored and the real 10-minute grace applies.
 */
export function e2eGraceMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env['HFCM_E2E_AUTO_EMPTY_GRACE_MS'];
  if (!isE2E(env) || raw === undefined || !/^[0-9]{1,9}$/.test(raw)) return undefined;
  const ms = Number(raw);
  return ms >= 1000 && ms <= AUTO_EMPTY_GRACE_MS ? ms : undefined;
}

const PLATFORMS = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'] as const;
const E2E_MACHINE = z.strictObject({
  platform: z.enum(PLATFORMS),
  ramBytes: z.number().int().positive().max(1e15),
  gpuName: z.string().max(200).nullable(),
  gpuBytes: z.number().int().positive().max(1e15).nullable(),
  gpuKind: z.enum(['nvidia', 'apple', 'other']),
  computeCap: z.number().nonnegative().max(1000).nullable(),
  drivesDisplay: z.boolean(),
}) satisfies z.ZodType<MachineProfile>;

/**
 * The E2E machine profile. undefined outside E2E (real detection runs). Under E2E, which bootstrap reaches only after
 * guardTestEnv passed, HFCM_E2E_MACHINE (a strict JSON MachineProfile) replaces detection; without it, or when it does not
 * parse, the machine has no GPU. Either way nvidia-smi is never run under E2E.
 */
export function e2eMachine(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, ramBytes: number): MachineProfile | undefined {
  if (!isE2E(env)) return undefined;
  const raw = env['HFCM_E2E_MACHINE'];
  if (raw !== undefined && raw !== '') {
    try {
      const r = E2E_MACHINE.safeParse(JSON.parse(raw));
      if (r.success) return r.data;
    } catch {
      // not JSON: no GPU
    }
  }
  return undetectedMachine(platform, ramBytes);
}

const E2E_DISK = z.strictObject({
  totalBytes: z.number().int().positive().max(1e18),
  freeBytes: z.number().int().nonnegative().max(1e18),
}).refine((d) => d.freeBytes <= d.totalBytes);

/** A statfs result, as the disk meter and the download free-space checks read it. */
export type StatfsLike = (p: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;

/**
 * The E2E disk (README screenshots): under the guarded E2E run only, HFCM_E2E_DISK (a strict JSON
 * {totalBytes, freeBytes}) replaces statfs for the disk meter and the download free-space checks. undefined otherwise,
 * or when it does not parse: the real statfs is used.
 */
export function e2eDisk(env: NodeJS.ProcessEnv): StatfsLike | undefined {
  if (!isE2E(env)) return undefined;
  const raw = env['HFCM_E2E_DISK'];
  if (raw === undefined || raw === '') return undefined;
  try {
    const r = E2E_DISK.safeParse(JSON.parse(raw));
    if (!r.success) return undefined;
    const { totalBytes, freeBytes } = r.data;
    return () => Promise.resolve({ bsize: 1, blocks: totalBytes, bfree: freeBytes, bavail: freeBytes });
  } catch {
    return undefined;   // not JSON: the real disk
  }
}

type ProductionCtx = { userDataDir: string; env: NodeJS.ProcessEnv; home: string; platform: NodeJS.Platform; emitProgress: (p: ScanProgressDTO) => void }
  & Partial<Omit<ServiceEvents, 'emitProgress'>>;

/** The production services deps: the real port (no test-only options, ever), the worker scan runner and the real clock. */
export function productionServicesDeps(ctx: ProductionCtx): ServicesDeps {
  const port = createCorePort({ userDataDir: ctx.userDataDir, env: ctx.env, home: ctx.home, offline: ctx.env['HFCM_OFFLINE'] === '1' });
  const grace = e2eGraceMs(ctx.env);
  const platform = ctx.platform;
  const detect = (): Promise<MachineProfile> => {
    const e2e = e2eMachine(ctx.env, platform, totalmem());
    if (e2e !== undefined) return Promise.resolve(e2e);
    // HFCM_NO_GPU_DETECT=1 only removes a capability, so it is honoured in every mode (the E2E first-run launch too)
    if (ctx.env['HFCM_NO_GPU_DETECT'] === '1') return Promise.resolve(undetectedMachine(platform, totalmem()));
    return detectMachine({ platform, arch: arch(), totalmem, exec: productionExec });
  };
  const statfs = e2eDisk(ctx.env);
  return {
    ...(statfs === undefined ? {} : { statfs, download: { statfs } }),
    env: ctx.env, home: ctx.home, userDataDir: ctx.userDataDir, port, scanRunner: runScanInWorker, now: Date.now,
    emitProgress: ctx.emitProgress, platform, detectMachine: detect, ...(grace === undefined ? {} : { autoEmptyGraceMs: grace }),
    ...(ctx.emitDownloadProgress ? { emitDownloadProgress: ctx.emitDownloadProgress } : {}),
    ...(ctx.emitDownloadDone ? { emitDownloadDone: ctx.emitDownloadDone } : {}),
  };
}

/** The production composition (see `productionServicesDeps`). */
export function createProductionServices(ctx: ProductionCtx): AppServices {
  return new AppServices(productionServicesDeps(ctx));
}

export async function bootstrap(d: BootDeps): Promise<BootResult> {
  const { app, env } = d;
  const fs = d.fs ?? readFs;
  if (isE2E(env)) {
    // Before setPath, the lock or whenReady: Electron writes into userData as soon as it takes the lock.
    try {
      await preflightTestEnv(env, d.home, env['HFCM_E2E_ROOT'] ?? '', d.guardOptions ?? { fs });
    } catch (e) {
      d.exitEarly(errText(e));
      return 'fatal';
    }
  }
  // Honoured only under E2E (whose pre-check above has already confined it to the run dir); a stray
  // variable in a normal start would move settings.json and the journal away from the real ones
  const override = env['HFCM_USER_DATA_DIR'];
  if (isE2E(env) && override !== undefined && override !== '') app.setPath('userData', override);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return 'second-instance';
  }
  let win: WindowLike | null = null;
  const live = (): WindowLike | null => (win !== null && !win.isDestroyed() ? win : null);
  // Backstop: every webContents the app ever creates is hardened, not only the main window's.
  app.onWebContentsCreated((wc) => d.harden(wc));
  await app.whenReady();
  // E2E: exit non-zero with the message on stderr; a modal error dialog would block a headless run and quit with 0
  const fatal = (message: string): BootResult => {
    if (isE2E(env)) {
      d.exitEarly(message);
      return 'fatal';
    }
    d.reportFatal(message);
    app.quit();
    return 'fatal';
  };
  try {
    const userDataDir = app.getPath('userData');
    const problem = await ensureUserDataDir(userDataDir, { lstat: fs.lstat, ...(d.mkdir === undefined ? {} : { mkdir: d.mkdir }) });
    if (problem !== null) return fatal(problem);
    if (isE2E(env)) {
      let cfg: HfhubConfig | null = null;
      try {
        cfg = await loadConfig(env, d.home, fs);
      } catch {
        cfg = null; // unreadable config: the services refuse view operations (CONFIG); the config path itself is still checked
      }
      try {
        await guardTestEnv(env, guardPathsFor(env, d.home, userDataDir, cfg), env['HFCM_E2E_ROOT'] ?? '', d.guardOptions ?? { fs });
      } catch (e) {
        return fatal(errText(e));
      }
      // The harness reads (electronApp.evaluate) how many requests hubFetch refused as non-loopback
      (globalThis as { __hfcmE2E?: { networkBlocked(): number } }).__hfcmE2E = { networkBlocked: networkBlockedCount };
    }
    const svc = d.buildServices({
      userDataDir,
      emitProgress: (p) => { live()?.webContents.send(SCAN_PROGRESS_EVENT, p); },
      emitDownloadProgress: (e) => { live()?.webContents.send(DOWNLOAD_PROGRESS_EVENT, e); },
      emitDownloadDone: (e) => { live()?.webContents.send(DOWNLOAD_DONE_EVENT, e); },
    });
    const trust = (url: string): boolean => isTrustedSender(url, { rendererFile: d.rendererFile, devOrigin: devOriginOf(d.rendererUrl, app.isPackaged) });
    registerIpc(adaptIpcMain(d.ipcMain, (s) => live()?.webContents === s), svc, trust);
    win = d.createWindow();
    app.onActivate(() => { if (live() === null) win = d.createWindow(); });
    app.onSecondInstance(() => {
      const w = live();
      if (w === null) return;
      if (w.isMinimized()) w.restore();
      w.focus();
    });
    app.onWindowAllClosed(() => { if (d.platform !== 'darwin') app.quit(); });
    // Once per start, after the window: advice sees no GPU until it finishes. It never throws (ApiResult).
    void svc.redetectMachine();
    // The download engine and its saved queue (paused files) exist before the renderer asks. Never throws.
    void svc.startDownloads?.();
    return 'started';
  } catch (e) {
    return fatal(`The app could not start: ${errText(e)}`);
  }
}
