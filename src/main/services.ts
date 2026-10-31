// AppServices: what the IPC handlers call. Every public method returns an ApiResult and never
// throws. The scan state (model, classification, usage, config, roots) lives here. `planningContext` applies the
// refusals every view-touching operation shares (hub missing, failed scan, unreadable config,
// ambiguous repo ids). The write side plans deletions, restores and empties, registers every plan in one
// PlanRegistry, and executes only a plan `registry.take` hands back, after an exact confirm-text check,
// under one service-level mutex (BUSY), followed by a fresh scan.
import { totalmem } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { AdviceSettings, MachineProfile } from '../core/advice/types';
import { STATE_FILE } from '../core/compat/state';
import type { HfhubConfig } from '../core/compat/config';
import { canonicalJson } from '../core/plan/fingerprint';
import { ExecError, STALE_MESSAGE } from '../core/exec/errors';
import { readFs, type ReadFs } from '../core/fsx';
import { DAY_MS, deletionLabel, HeldError, type HeldDeletion } from '../core/hold/held';
import { PlanError } from '../core/plan/closure';
import { HOLD_UNAVAILABLE } from '../core/plan/planner';
import { PlanRegistry } from '../core/plan/registry';
import { hubDiskBytes } from '../core/scan/hub-bytes';
import type { SyncPlan } from '../core/sync/sync';
import type { CacheModel, DeleteMode, DeletionPlan, ExecResult, Op, PlanPair, Repo, RepoView, Selection, UsageIndex, ViewName } from '../core/types';
import { VIEW_ROOTS_OVERLAP, overlappingRoots } from '../core/views/view-path';
import { isStrictlyInside } from '../core/paths';
import type {
  ApiError, ApiErrorCode, ApiResult, AutoEmptyPendingNoticeDTO, MachineProfileDTO, RepoAdviceDTO, AutoEmptySkippedNoticeDTO, DiskInfoDTO, EmptyPlanDTO, EmptyTarget, ExecResultDTO, HeldListDTO, LibraryDTO, PlanDTO,
  PlanPairDTO, RepoDetailDTO, ScanProgressDTO, SelectionPreviewDTO, SettingsDTO, SettingsViewDTO, JournalNoticeDTO, StartupNoticeDTO,
  SyncPlanDTO, SyncResultDTO, DownloadDoneDTO, DownloadGroupDTO, DownloadPreviewDTO, DownloadProgressDTO, DownloadsDTO, HubLookupDTO, RecentLookupDTO,
} from '../shared/api';
import { formatBytes } from '../shared/format';
import { profileDto, repoAdvice, undetectedMachine, type ShapeCache } from './advice-service';
import { AppSettingsStore, diskInfoFrom, probeSymlinks, type UserSafeFsFactory } from './app-settings';
import type { ConfigResult, CorePort, HubResolution, PortRoots } from './core-port';
import {
  displayPath, toEmptyPlanDTO, toExecResultDTO, toHeldDeletionDTO, toPlanDTO, toRepoDetail, toRepoSummary, toSyncPlanDTO, toSyncResultDTO, type DtoContext,
} from './dto';
import { DownloadService, repoLabel, type DownloadOptions } from './download-service';
import { parseRepoFolder } from '../core/scan/scanner';
import type { ScanRunner } from './scan-client';

export interface ServicesDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  userDataDir: string;
  port: CorePort;
  scanRunner: ScanRunner;
  now: () => number;
  emitProgress: (p: ScanProgressDTO) => void;
  platform: NodeJS.Platform;
  /** Read-only fs for facts (default the real one). */
  fs?: ReadFs;
  /** The SafeFs rooted at userData that settings.json and the symlink probe write through (default `SafeFs.create`). */
  makeUserSafeFs?: UserSafeFsFactory;
  /** Runs `run` after `ms` (default `defaultSchedule`, a real timer); tests pass a fake one. */
  schedule?: Scheduler;
  /**
   * The auto-empty grace period (default AUTO_EMPTY_GRACE_MS). Production never sets it: bootstrap passes it only for a
   * guarded E2E run (`e2eGraceMs`, HFCM_E2E_AUTO_EMPTY_GRACE_MS), so the E2E suite can watch the countdown end.
   */
  autoEmptyGraceMs?: number;
  /**
   * Machine detection for advice. Production passes nvidia-smi detection, or the E2E profile under a
   * guarded E2E run (bootstrap). Absent (tests): nothing is spawned, the machine has no GPU.
   */
  detectMachine?: () => Promise<MachineProfile>;
  /** Download progress events and the per-download "done" event (after its rescan), to the window. */
  emitDownloadProgress?: (e: DownloadProgressDTO) => void;
  emitDownloadDone?: (e: DownloadDoneDTO) => void;
  /** Test seams (fetch, statfs, sleeps). Production passes none: the hub client then uses `hubFetch`. */
  download?: DownloadOptions;
  /** The disk meter's statfs; absent: the real one. Set only by a guarded E2E run (bootstrap e2eDisk). */
  statfs?: (p: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
}

/** The grace timer for a pending auto-empty. */
export type Scheduler = (run: () => Promise<void>, ms: number) => { cancel(): void };
export const defaultSchedule: Scheduler = (run, ms) => {
  const t = setTimeout(() => { void run(); }, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};
/** Due deletions are emptied this long after the first good scan, so the user can restore or dismiss first. */
export const AUTO_EMPTY_GRACE_MS = 10 * 60_000;
/** A pending run that finds a scan or operation running tries again after this long. */
export const AUTO_EMPTY_RETRY_MS = 60_000;
/** Clock sanity bounds. */
const FUTURE_SLACK_MS = DAY_MS;
const STALE_CLOCK_MS = 365 * DAY_MS;

/** What a view-touching operation needs: the last good scan, a readable config and the roots of the realpath'd hub. */
export interface PlanningContext {
  model: CacheModel;
  views: RepoView[];
  usage: UsageIndex;
  config: HfhubConfig;
  roots: PortRoots;
  dto: DtoContext;
}

type Loaded = {
  kind: 'ok'; model: CacheModel; views: RepoView[]; usage: UsageIndex; config: HfhubConfig | null;
  configError: { error: string; path: string } | null; roots: PortRoots; ambiguousIds: ReadonlySet<string>;
};
/** The outcome of the latest finished scan. A failed one keeps no model. */
type ScanState = Loaded | { kind: 'hub-missing'; hubRoot: string; message: string } | { kind: 'scan-failed'; message: string };

/** What main remembers about a registered plan: enough to gate an execute before the registry is touched, and the
 *  model the plan was built from (a hold's manifest is built from it). */
interface Issued {
  voided: boolean; mode: DeleteMode; purpose: DeletionPlan['purpose']; confirmPhrase: string | null; expiresAt: number; model: CacheModel;
  /** The plan itself, so executePlan can re-check the download queue before `take`. */
  plan: DeletionPlan;
}

/** The context Recently Deleted operations need: the last good scan and the roots with an available hold root. */
interface HeldContext { model: CacheModel; config: HfhubConfig | null; roots: PortRoots }

/** A sync preview kept by id: single use, and gone after its expiry (10 minutes). */
interface SyncIssued { plan: SyncPlan; used: boolean }
export const SYNC_HUB_TEXT = (hubRoot: string): string =>
  `Cache not found or empty at ${hubRoot}; sync is disabled so nothing is removed by mistake.`;
export const SYNC_VOID_TEXT = 'Preview expired — the cache changed; preview Sync again.';
export const SYNC_RACE_TEXT = 'Preview expired — preview Sync again';
export const DELETE_VOID_TEXT = 'The cache or its links changed; review the deletion again';
export const SYNC_USED_TEXT = 'This sync preview was already used — preview again.';

export const DOWNLOAD_ACTIVE_TEXT = (repo: string): string =>
  `${repo} has downloads in progress, paused or failed; finish or cancel them first.`;
export const DOWNLOAD_QUEUE_UNREADABLE_TEXT = (repo: string, why: string): string =>
  `${repo} has partial downloads and the saved download queue cannot be read (${why}); fix settings.json first.`;
export const BUSY_TEXT = 'Another operation is running — try again when it finishes.';
export const CONFIRM_MISMATCH = 'The confirmation text did not match.';
export const EXPIRED_TEXT = 'This plan expired — please review again.';
export const UNKNOWN_PLAN_TEXT = 'Unknown plan — please review again.';
export const PLAN_FAILED = 'Could not build the plan.';
/** A held deletion keeps a store payload in the hub (heldPath null) and needs it back to restore. */
export const NEEDED_BY_PERMANENT = (label: string, path: string): string =>
  `${label} in Recently Deleted needs ${path} to be restored; Delete Permanently removes it for good.`;
export const NEEDED_BY_HOLD = (label: string, path: string): string =>
  `${label} in Recently Deleted needs ${path} to be restored; it moves into this deletion, so restore this one first.`;
export const HELD_UNREADABLE_WARNING = (error: string): string =>
  `Recently Deleted could not be read (${error}); this review cannot tell whether a held deletion needs these files.`;

export const SETTINGS_UNREADABLE_TEXT = 'Settings could not be read, so they were not changed. Fix or remove settings.json first.';
export const AMBIGUOUS_NOTE = 'Two repos share this id (model and dataset); deletion is disabled for them in this version.';
/** Synthetic notice ids (not journal plans); acknowledging one only hides it for this session. */
const SETTINGS_NOTICE = 'settings-unreadable' as const;
const HELD_NOTICE = 'held-unreadable' as const;
const PENDING_NOTICE = 'auto-empty-pending' as const;
const SKIPPED_NOTICE = 'auto-empty-skipped' as const;
export const AUTO_EMPTY_PENDING_TEXT = (n: number, days: number, bytes: number, emptyAt: number | null = null): string =>
  `${n} item(s) in Recently Deleted are older than ${days} days and will be emptied ${emptyAt === null ? 'in 10 minutes' : `at ${new Date(emptyAt).toLocaleTimeString()}`} (${formatBytes(bytes)} freed). `
  + 'Open Recently Deleted to restore any you want to keep. Dismiss to keep them for this session.';
/** A dismissal that arrives once the timed run has started (it still stops every plan not yet run). */
export const AUTO_EMPTY_ALREADY_STARTED =
  'Recently Deleted was already being emptied; anything not emptied yet is kept for this session.';
export const AUTO_EMPTY_CLOCK_TEXT = (why: string): string =>
  `Automatic emptying of Recently Deleted is off for this session: ${why}, so the system clock may be wrong. Check the date and time.`;
const VIEWS: readonly ViewName[] = ['lmstudio', 'ollama'];

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const fail = (code: ApiErrorCode, message: string): { ok: false; error: ApiError } => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });

/** The core's refusal classes map to API codes; anything else is a generic failure (its message is not sent). */
function planFailure(e: unknown): { ok: false; error: ApiError } {
  if (e instanceof PlanError) {
    const code: ApiErrorCode = e.code === 'UNKNOWN_REPO' || e.code === 'UNKNOWN_GROUP' ? 'NOT_FOUND'
      : e.code === 'ACTIVE_DOWNLOAD' ? 'ACTIVE_DOWNLOAD' : 'INVALID_INPUT';
    return fail(code, e.message);
  }
  if (e instanceof HeldError) {
    const code: ApiErrorCode = e.code === 'NOT_FOUND' || e.code === 'NO_HOLD_ROOT' ? 'NOT_FOUND'
      : e.code === 'STALE_MANIFEST' ? 'STALE' : e.code === 'ACTIVE_DOWNLOAD' ? 'ACTIVE_DOWNLOAD'
        : e.code === 'CORRUPT' || e.code === 'HUB_MISMATCH' ? 'INVALID_INPUT' : 'INTERNAL';
    return fail(code, code === 'INTERNAL' ? PLAN_FAILED : e.message);
  }
  return fail('INTERNAL', PLAN_FAILED);
}
const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';
/** The copy for a config.toml that cannot be read. */
const configText = (error: string): string => `config.toml could not be read (${error}); fix it before deleting or syncing.`;
const scanFailedText = (message: string): string => `The cache could not be read: ${message}. Fix the permissions and rescan.`;

function tilde(abs: string, home: string): string {
  if (abs === home) return '~';
  return abs.startsWith(home + sep) ? `~/${abs.slice(home.length + 1).split(sep).join('/')}` : abs;
}

/** The path an op acts on, for the startup notice. */
function opPath(op: Op): string | null {
  if ('path' in op) return op.path;
  if ('storePath' in op) return op.storePath;
  return op.refsPath;
}

const PURPOSE_TEXT = (purpose: JournalNoticeDTO['purpose'], mode: JournalNoticeDTO['mode']): string =>
  purpose === 'restore' ? 'a restore' : purpose === 'empty' ? 'emptying Recently Deleted'
    : mode === 'hold' ? 'a move to Recently Deleted' : 'a permanent deletion';

export class AppServices {
  private readonly fs: ReadFs;
  private readonly settingsStore: AppSettingsStore;
  private state: ScanState | null = null;
  private inflight: Promise<ApiResult<LibraryDTO>> | null = null;
  private abort: AbortController | null = null;
  private symlinks: { ok: boolean; detail: string } | null = null;
  private heldError: string | null = null;
  private settingsError: string | null = null;
  private dismissed = new Set<string>();
  private readonly registry = new PlanRegistry();
  private readonly issued = new Map<string, Issued>();
  /** The service-level mutex: an execute (with its rescan) or an auto-empty run. */
  private op: 'execute' | 'auto-empty' | 'sync' | null = null;
  private readonly syncIssued = new Map<string, SyncIssued>();
  /** Bumped by every operation that changes the hub or the views; a plan built across a bump is never registered. */
  private gen = 0;
  /** Set by the first good scan of this start: auto-empty is considered (scheduled or not) once per start. */
  private autoEmptyDone = false;
  /** Auto-empty is off for the rest of the session: the pending notice was dismissed, or the clock looked wrong. */
  private autoEmptyCancelled = false;
  private pendingTimer: { cancel(): void } | null = null;
  /** The grace timer was started (by the first startupNotices() call that returned the pending notice). */
  private pendingArmed = false;
  /** The pending notice's facts: the days setting and each announced deletion's freed bytes. */
  private pendingFacts: { days: number; bytes: ReadonlyMap<string, number> } | null = null;
  /** The armed countdown's deadline (null until startupNotices() delivers the notice). */
  private pendingEmptyAt: number | null = null;
  /**
   * The deletions the pending notice announced; the timed run empties no others. A deletion whose
   * restore or single empty review is opened leaves this set (replaced, never mutated) for the rest of the session.
   */
  private announced: ReadonlySet<string> | null = null;
  /** The announced ids a review withdrew; a started run skips them before each plan. */
  private withdrawn: ReadonlySet<string> = new Set();
  /** The timed run has started (its notice is retired; a dismissal then gets AUTO_EMPTY_ALREADY_STARTED). */
  private autoEmptyStarted = false;
  private autoEmptyNotice: AutoEmptyPendingNoticeDTO | AutoEmptySkippedNoticeDTO | null = null;
  private lastAutoEmpty: LibraryDTO['lastAutoEmpty'] = null;
  /** The detected machine; null until the first detection finishes (advice then sees no GPU). */
  private machine: MachineProfile | null = null;
  private detecting: Promise<MachineProfile> | null = null;
  /** GGUF shapes by sorted blob etags (content-addressed, so a rescan never invalidates them). */
  private readonly shapes: ShapeCache = new Map();
  /** Look-ups, previews and the download engine. Downloads run outside `op` (they are background work). */
  private readonly dl: DownloadService;

  constructor(private readonly d: ServicesDeps) {
    this.fs = d.fs ?? readFs;
    this.settingsStore = new AppSettingsStore(d.userDataDir, {
      fs: this.fs, ...(d.makeUserSafeFs === undefined ? {} : { makeSafeFs: d.makeUserSafeFs }),
    });
    this.dl = new DownloadService({
      env: d.env, home: d.home, now: d.now, fs: this.fs, port: d.port, settings: this.settingsStore,
      model: () => this.scannedModel(),
      opRunning: () => this.op === 'execute' || this.op === 'sync' || this.op === 'auto-empty',
      rescan: () => this.rescan(),
      symlinksSupported: () => this.symlinksOk(),
      adviceContext: async () => {
        if (this.detecting !== null) await this.detecting;
        const cfg = await this.d.port.loadConfig();
        return { machine: this.machineNow(), settings: await this.adviceSettings(), config: cfg.ok ? cfg.config : null };
      },
      emitProgress: (e) => this.d.emitDownloadProgress?.(e),
      emitDone: (e) => this.d.emitDownloadDone?.(e),
    }, d.download);
  }

  private async safe<T>(fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try {
      return await fn();
    } catch (e) {
      return fail('INTERNAL', errText(e));
    }
  }

  /** Coalescing policy: a request while a scan runs gets the same promise, so one run serves every caller. */
  scan(): Promise<ApiResult<LibraryDTO>> {
    if (this.inflight !== null) return this.inflight;
    const controller = new AbortController();
    this.abort = controller;
    const run: Promise<ApiResult<LibraryDTO>> = this.safe(async () => this.afterScan(await this.runScan(controller.signal))).finally(() => {
      if (this.inflight === run) {
        this.inflight = null;
        this.abort = null;
      }
    });
    this.inflight = run;
    return run;
  }

  cancelScan(): Promise<ApiResult<null>> {
    this.abort?.abort();
    // a scan() right after a cancel starts a fresh run instead of joining the settling cancelled one
    this.inflight = null;
    this.abort = null;
    return Promise.resolve(ok(null));
  }

  /**
   * A cancelled run (cancelScan nulls `inflight` at once, so a newer scan or an operation may already
   * have run) writes nothing: it re-checks the signal after every await, before any state or progress is written.
   */
  private async runScan(signal: AbortSignal): Promise<ApiResult<LibraryDTO>> {
    const { port, emitProgress: emit } = this.d;
    const cancelled = (): ApiResult<LibraryDTO> => fail('INTERNAL', 'Scan cancelled');
    const hub = await port.resolveHub();
    if (signal.aborted) return cancelled();
    if (!hub.present) {
      this.voidSync();
      this.state = { kind: 'hub-missing', hubRoot: hub.hubRoot, message: hub.problem.message };
      emit({ phase: 'done', done: 1, total: 1 });
      return ok(this.library(hub.hubRoot, false, [], 0, 0, 0, hub.problem.message));
    }
    const cfg = await port.loadConfig();
    if (signal.aborted) return cancelled();
    const config = cfg.ok ? cfg.config : null;
    let out;
    try {
      out = await this.d.scanRunner(hub.hubRoot, emit, signal);
    } catch (e) {
      if (isAbort(e) || signal.aborted) return cancelled();
      const message = errText(e);
      this.voidSync();
      this.state = { kind: 'scan-failed', message: scanFailedText(message) };
      emit({ phase: 'error', done: 0, total: 1, message });
      return ok(this.library(hub.hubRoot, true, [], 0, 0, 0, scanFailedText(message)));
    }
    if (signal.aborted) return cancelled();
    const roots = await port.roots(hub.hubRoot, config);
    if (signal.aborted) return cancelled();
    emit({ phase: 'usage', done: 0, total: 1 });
    const usage = config === null ? {} : await port.usage(out.model, config);
    if (signal.aborted) return cancelled();
    emit({ phase: 'usage', done: 1, total: 1 });
    const counts = new Map<string, number>();
    for (const r of out.model.repos) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
    const ambiguousIds = new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
    const byKey = new Map(out.views.map((v) => [`${v.type}:${v.repoId}`, v]));
    const repos = out.model.repos.flatMap((r) => {
      const view = byKey.get(`${r.type}:${r.id}`);
      return view === undefined ? [] : [toRepoSummary(r, view, usage, ambiguousIds.has(r.id))];
    });
    const held = await this.heldTotals(roots);
    if (signal.aborted) return cancelled();
    this.heldError = held.error;
    this.voidSyncIfChanged(out.model);
    this.dismissed.delete(HELD_NOTICE);
    this.state = {
      kind: 'ok', model: out.model, views: out.views, usage, config, roots, ambiguousIds,
      configError: cfg.ok ? null : { error: cfg.error, path: cfg.path },
    };
    emit({ phase: 'done', done: 1, total: 1 });
    return ok(this.library(hub.hubRoot, true, repos, hubDiskBytes(out.model), held.bytes, held.count, null));
  }

  /** A rescan that finds a different model voids every preview not yet run (the first scan has none to void). */
  private voidSyncIfChanged(next: CacheModel): void {
    if (![...this.syncIssued.values()].some((x) => !x.used)) return;
    if (this.state?.kind !== 'ok' || canonicalJson({ ...this.state.model, scannedAt: 0 }) !== canonicalJson({ ...next, scannedAt: 0 })) this.voidSync();
  }

  private library(hubRoot: string, hubPresent: boolean, repos: LibraryDTO['repos'], hubBytes: number, heldBytes: number,
    heldCount: number, scanError: string | null): LibraryDTO {
    return { hubRoot, hubPresent, scannedAt: this.d.now(), repos, hubBytes, heldBytes, heldCount, lastAutoEmpty: this.lastAutoEmpty, scanError };
  }

  /** A held listing that cannot be read does not fail the scan: the totals are then 0. */
  private async heldTotals(roots: PortRoots): Promise<{ bytes: number; count: number; error: string | null }> {
    if (roots.roots.holdRoot === null) return { bytes: 0, count: 0, error: null };
    try {
      const held: HeldDeletion[] = await this.d.port.listHeld(roots);
      const good = held.flatMap((h) => (h.ok ? [h] : []));
      return { bytes: good.reduce((n, h) => n + h.manifest.bytesHeld, 0), count: good.length, error: null };
    } catch (e) {
      return { bytes: 0, count: 0, error: errText(e) };
    }
  }

  /** The scan state, scanning first when none has run. A failed or cancelled first scan is returned as is. */
  private async current(): Promise<ApiResult<ScanState>> {
    if (this.state === null) {
      const r = await this.scan();
      if (!r.ok) return r;
    }
    return this.state === null ? fail('INTERNAL', 'The scan did not finish') : ok(this.state);
  }

  /** The one repo lookup behind repoDetail and advice, so their refusals cannot drift: the last good scan (NOT_FOUND
   *  when there is none), the repo (NOT_FOUND), not an ambiguous id (INVALID_INPUT), and its classified view. */
  private async lookup(repoId: string): Promise<ApiResult<{ s: Loaded; repo: Repo; view: RepoView }>> {
    const cur = await this.current();
    if (!cur.ok) return cur;
    const s = cur.data;
    if (s.kind !== 'ok') return fail('NOT_FOUND', s.message);
    const repo = s.model.repos.find((r) => r.id === repoId);
    if (repo === undefined) return fail('NOT_FOUND', `${repoId} is not in the cache.`);
    if (s.ambiguousIds.has(repoId)) return fail('INVALID_INPUT', AMBIGUOUS_NOTE);
    const view = s.views.find((v) => v.repoId === repo.id && v.type === repo.type);
    if (view === undefined) return fail('NOT_FOUND', `${repoId} is not in the cache.`);
    return ok({ s, repo, view });
  }

  repoDetail(repoId: string): Promise<ApiResult<RepoDetailDTO>> {
    return this.safe(async () => {
      const found = await this.lookup(repoId);
      if (!found.ok) return found;
      const { s, repo, view } = found.data;
      return ok(toRepoDetail(s.model, repo, view, s.usage, this.d.now()));
    });
  }

  /**
   * The shared gate for previewSelection, planDelete and planSync (Tasks 6 and 7). Refuses, in order: no usable hub
   * (HUB_MISSING), a failed scan (NOT_FOUND), an unreadable config.toml (CONFIG), a repo id not in the scan
   * (NOT_FOUND) and an ambiguous one (INVALID_INPUT), so nothing is planned against a stale or doubtful model.
   */
  planningContext(repoIds: readonly string[] = []): Promise<ApiResult<PlanningContext>> {
    return this.safe(async () => {
      const cur = await this.current();
      if (!cur.ok) return cur;
      const s = cur.data;
      if (s.kind === 'hub-missing') return fail('HUB_MISSING', s.message);
      if (s.kind === 'scan-failed') return fail('NOT_FOUND', s.message);
      // config.toml is read again now, so an edit since the scan is seen (core revalidation stays the safety net)
      const cfg = await this.d.port.loadConfig();
      if (!cfg.ok) return fail('CONFIG', configText(cfg.error));
      for (const id of repoIds) {
        if (!s.model.repos.some((r) => r.id === id)) return fail('NOT_FOUND', `${id} is not in the cache.`);
        if (s.ambiguousIds.has(id)) return fail('INVALID_INPUT', AMBIGUOUS_NOTE);
      }
      const roots = await this.d.port.roots(s.model.hubRoot, cfg.config);
      const usage = await this.d.port.usage(s.model, cfg.config);
      return ok({ model: s.model, views: s.views, usage, config: cfg.config, roots, dto: this.d.port.dtoContext(s.model, roots, cfg.config) });
    });
  }

  settings(): Promise<ApiResult<SettingsDTO>> {
    return this.safe(async () => {
      const { port } = this.d;
      const hub = await port.resolveHub();
      const cfg = await port.loadConfig();
      const config = cfg.ok ? cfg.config : null;
      const roots = hub.present ? await port.roots(hub.hubRoot, config) : null;
      const overlaps = await overlappingRoots(this.fs, VIEWS.map((v) => config?.views[v].root ?? null));
      const views: SettingsViewDTO[] = [];
      for (const [i, view] of VIEWS.entries()) {
        const vc = config?.views[view];
        const root = vc?.root ?? null;
        views.push({
          view, root, rootExists: root !== null && (await this.isDir(root)), statePath: root === null ? null : join(root, STATE_FILE),
          aliases: { ...(vc?.aliases ?? {}) }, problem: vc?.problem ?? (overlaps[i] === true ? VIEW_ROOTS_OVERLAP : null),
        });
      }
      if (this.symlinks === null) {
        const probe = await probeSymlinks(this.d.userDataDir, {
          fs: this.fs, platform: this.d.platform, ...(this.d.makeUserSafeFs === undefined ? {} : { makeSafeFs: this.d.makeUserSafeFs }),
        });
        if (probe.ok) this.symlinks = probe;   // a failure may be transient: it is probed again next time
        else return this.settingsDto(hub, cfg, views, roots, probe);
      }
      return this.settingsDto(hub, cfg, views, roots, this.symlinks);
    });
  }

  private async settingsDto(hub: HubResolution, cfg: ConfigResult, views: SettingsViewDTO[], roots: PortRoots | null,
    symlinks: { ok: boolean; detail: string }): Promise<ApiResult<SettingsDTO>> {
    const checked = await this.settingsStore.loadChecked();
    this.settingsError = checked.error;
    return ok({
      hubRoot: hub.hubRoot, hubPresent: hub.present, configPath: cfg.ok ? cfg.config.path : cfg.path,
      configExists: cfg.ok ? cfg.config.exists : await this.isFile(cfg.path),
      configError: cfg.ok ? null : cfg.error, settingsError: checked.error, views,
      holdRoot: roots?.roots.holdRoot ?? null,
      holdUnavailableReason: roots === null ? (hub.present ? null : hub.problem.message) : roots.holdUnavailableReason,
      journalPath: this.d.port.journalPath, symlinks,
      autoEmptyDays: checked.settings.autoEmptyDays, platform: this.d.platform,
    });
  }

  private async isDir(p: string): Promise<boolean> {
    try {
      return (await this.fs.stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  private async isFile(p: string): Promise<boolean> {
    try {
      return (await this.fs.stat(p)).isFile();
    } catch {
      return false;
    }
  }

  diskInfo(): Promise<ApiResult<DiskInfoDTO>> {
    return this.safe(async () => {
      const hub = await this.d.port.resolveHub();
      if (!hub.present) return fail('HUB_MISSING', hub.problem.message);
      return ok(diskInfoFrom(await (this.d.statfs ?? ((p: string) => this.fs.statfs(p)))(hub.hubRoot), hub.hubRoot));
    });
  }

  startupNotices(): Promise<ApiResult<StartupNoticeDTO[]>> {
    return this.safe(async () => {
      const plans = await this.d.port.journalIncomplete();
      this.settingsError = (await this.settingsStore.loadChecked()).error;
      const extra: StartupNoticeDTO[] = [];
      if (this.settingsError !== null && !this.dismissed.has(SETTINGS_NOTICE)) {
        extra.push({ kind: 'settings-unreadable', id: SETTINGS_NOTICE,
          message: `Settings file could not be read (${this.settingsError}); automatic emptying is off until you save Settings` });
      }
      if (this.heldError !== null && !this.dismissed.has(HELD_NOTICE)) {
        extra.push({ kind: 'held-unreadable', id: HELD_NOTICE,
          message: `Recently Deleted could not be read (${this.heldError}); its totals are not shown. Rescan after fixing it.` });
      }
      if (this.autoEmptyNotice !== null && !this.dismissed.has(this.autoEmptyNotice.id)) {
        this.armPending();   // first: the notice returned below carries the deadline
        extra.push({ ...this.autoEmptyNotice });
      }
      return ok([...extra, ...plans.map((p): StartupNoticeDTO => {
        const path = p.lastOp === null ? null : opPath(p.lastOp);
        return {
          kind: 'journal', planId: p.planId, startedAtMs: p.startedAt, purpose: p.purpose, mode: p.mode, opsStarted: p.opsStarted,
          lastOpPath: path === null ? null : tilde(path, this.d.home),
          message: `An operation did not finish: ${PURPOSE_TEXT(p.purpose, p.mode)} (plan ${p.planId.slice(0, 8)}) started ${p.opsStarted} `
            + `step(s) (started ${new Date(p.startedAt).toLocaleString()}). The cache has been rescanned; review what remains before continuing.`,
        };
      })]);
    });
  }

  ackStartupNotice(idOrPlanId: string): Promise<ApiResult<null>> {
    return this.safe(async () => {
      if (idOrPlanId === PENDING_NOTICE) {
        // Dismissing the pending notice keeps the deletions for this session. Once the timed run has started,
        // it still stops every plan not yet run, but the user is told the run had started
        const started = this.autoEmptyStarted;
        this.cancelAutoEmpty();
        this.dismissed.add(PENDING_NOTICE);
        return started ? fail('NOT_FOUND', AUTO_EMPTY_ALREADY_STARTED) : ok(null);
      }
      if (idOrPlanId === SETTINGS_NOTICE || idOrPlanId === HELD_NOTICE || idOrPlanId === SKIPPED_NOTICE) {
        this.dismissed.add(idOrPlanId);   // session-only: the files themselves are never changed here
        return ok(null);
      }
      if (!(await this.d.port.journalIncomplete()).some((p) => p.planId === idOrPlanId)) {
        return fail('NOT_FOUND', 'That notice is no longer pending.');
      }
      await this.d.port.acknowledge(idOrPlanId);
      return ok(null);
    });
  }
  // ------------------------------------------------------------------ write side

  /** A scan or an operation (an execute with its rescan, an auto-empty run) is running. */
  private busy(): boolean {
    return this.inflight !== null || this.op !== null;
  }

  /**
   * The first good scan of a start never empties anything. When deletions are due it posts the
   * `auto-empty-pending` notice and schedules the run AUTO_EMPTY_GRACE_MS later; dismissing the notice cancels it. A
   * scan of a missing hub or a failed scan does not count as the first good one.
   */
  private async afterScan(r: ApiResult<LibraryDTO>): Promise<ApiResult<LibraryDTO>> {
    if (this.autoEmptyDone || !r.ok || this.state?.kind !== 'ok') return r;
    this.autoEmptyDone = true;
    try {
      const d = await this.dueNow();
      if (d.kind === 'clock') this.skipForClock(d.why);
      if (d.kind === 'due' && d.due.length > 0 && !this.autoEmptyCancelled) {
        const { plans } = await this.d.port.planEmpty(d.roots, d.due.map((x) => x.deletionId), this.d.now());
        if (plans.length > 0) {
          const bytes = new Map<string, number>();
          for (const p of plans) if (p.deletionId !== null) bytes.set(p.deletionId, p.freed.bytes);
          this.pendingFacts = { days: d.days, bytes };
          this.announced = new Set(bytes.keys());
          this.dismissed.delete(PENDING_NOTICE);
          this.refreshPendingNotice();
          // the countdown starts when startupNotices() hands the notice to the renderer (armPending), never before
        }
      }
    } catch {
      // nothing is scheduled: auto-empty waits for the next start
    }
    return r;
  }

  /**
   * The grace timer starts only when the pending notice has actually been returned to the renderer, so the user can
   * always see the warning before the deletions go. A notice that is never fetched means auto-empty never runs.
   */
  private armPending(): void {
    if (this.pendingArmed || this.autoEmptyCancelled || this.autoEmptyStarted || this.announced === null) return;
    if (this.autoEmptyNotice?.kind !== PENDING_NOTICE || this.dismissed.has(PENDING_NOTICE)) return;
    this.pendingArmed = true;
    const grace = this.d.autoEmptyGraceMs ?? AUTO_EMPTY_GRACE_MS;
    this.pendingEmptyAt = this.d.now() + grace;
    this.refreshPendingNotice();
    this.pendingTimer = this.schedule(() => this.firePending(), grace);
  }

  /** The pending notice from the announced set as it stands (count and bytes) and the deadline, once armed. */
  private refreshPendingNotice(): void {
    const f = this.pendingFacts;
    if (f === null) return;
    const bytes = [...f.bytes.values()].reduce((n, b) => n + b, 0);
    this.autoEmptyNotice = {
      kind: PENDING_NOTICE, id: PENDING_NOTICE, message: AUTO_EMPTY_PENDING_TEXT(f.bytes.size, f.days, bytes, this.pendingEmptyAt),
      emptyAt: this.pendingEmptyAt,
    };
  }

  /**
   * The user opened a review (restore, or emptying this one deletion) of an announced deletion, so the
   * timed run must not empty it underneath them. It leaves the announced set for the session, synchronously, before the
   * review is even planned. The notice's count and bytes follow; when nothing is left the countdown is cancelled and
   * the notice retired. During a started run the review is answered BUSY, but the withdrawal still counts: the run
   * re-checks this set before each plan and skips a withdrawn one (final re-).
   */
  private withdrawFromAutoEmpty(deletionId: string): void {
    const ids = this.announced;
    const f = this.pendingFacts;
    if (ids === null || f === null || !ids.has(deletionId)) return;
    const rest = new Set([...ids].filter((id) => id !== deletionId));
    this.announced = rest;
    this.withdrawn = new Set([...this.withdrawn, deletionId]);
    this.pendingFacts = { days: f.days, bytes: new Map([...f.bytes].filter(([id]) => id !== deletionId)) };
    if (rest.size > 0) {
      if (this.autoEmptyNotice?.kind === PENDING_NOTICE) this.refreshPendingNotice();
      return;
    }
    this.cancelAutoEmpty();
    if (this.autoEmptyNotice?.kind === PENDING_NOTICE) this.autoEmptyNotice = null;
  }

  private schedule(run: () => Promise<void>, ms: number): { cancel(): void } {
    return (this.d.schedule ?? defaultSchedule)(run, ms);
  }

  /** The grace timer fired: run with the due set computed now, unless dismissed; retry while something else runs. */
  private async firePending(): Promise<void> {
    this.pendingTimer = null;
    const announced = this.announced;
    if (this.autoEmptyCancelled || announced === null) return;
    if (this.busy()) {
      this.pendingTimer = this.schedule(() => this.firePending(), AUTO_EMPTY_RETRY_MS);
      return;
    }
    // From here on the run cannot be fully undone, so the notice offering to keep the items is retired
    this.autoEmptyStarted = true;
    if (this.autoEmptyNotice?.kind === PENDING_NOTICE) this.autoEmptyNotice = null;
    await this.autoEmptyLocked(announced);
  }

  /** Plans both modes of a selection (never registered). The port has already applied the hold-plan checks. */
  private async planPair(selection: Selection): Promise<ApiResult<{ pair: PlanPair; ctx: PlanningContext }>> {
    const c = await this.planningContext(selection.repos.map((r) => r.repoId));
    if (!c.ok) return c;
    try {
      return ok({ pair: await this.d.port.planDeletion(c.data.model, selection, c.data.roots, c.data.config, this.d.now()), ctx: c.data });
    } catch (e) {
      return planFailure(e);
    }
  }

  /** The action-bar totals: the real planner's permanent figure, nothing registered. */
  previewSelection(selection: Selection): Promise<ApiResult<SelectionPreviewDTO>> {
    return this.safe(async () => {
      if (this.busy()) return fail('BUSY', BUSY_TEXT);
      const planned = await this.planPair(selection);
      if (!planned.ok) return planned;
      const { pair, ctx } = planned.data;
      const dto = toPlanDTO(pair.permanent, ctx.dto);
      return ok({
        groupCount: dto.groupCount, freedBytes: pair.permanent.freed.bytes,
        viewLinksAffected: pair.permanent.viewImpact.filter((l) => l.action === 'remove').length, warnings: dto.warnings,
      });
    });
  }

  private issue(plan: DeletionPlan, model: CacheModel): void {
    this.issued.set(plan.id, { voided: false, mode: plan.mode, purpose: plan.purpose, confirmPhrase: plan.confirmPhrase, expiresAt: plan.expiresAt, model, plan });
  }

  private prune(now: number): void {
    for (const [id, x] of this.issued) if (x.expiresAt <= now) this.issued.delete(id);
  }

  /**
   * The review pair, registered as one review (putPair: executing either uses up both). A payload a held deletion
   * needs in order to be restored gets a warning on the plan that would delete it (permanent) or move it (hold).
   */
  planDelete(selection: Selection): Promise<ApiResult<PlanPairDTO>> {
    return this.safe(async () => {
      if (this.busy()) return fail('BUSY', BUSY_TEXT);
      const gen = this.gen;
      const planned = await this.planPair(selection);
      if (!planned.ok) return planned;
      const { pair, ctx } = planned.data;
      const downloading = (await this.downloadBlock(pair.permanent)) ?? (pair.hold === null ? null : await this.downloadBlock(pair.hold));
      if (downloading !== null) return downloading;
      const needs = await this.heldNeeds(ctx.roots);
      // an operation that changed the hub or the views ran while this was being planned: the review would be of old facts
      if (gen !== this.gen || this.busy()) return fail('STALE', DELETE_VOID_TEXT);
      this.prune(this.d.now());
      this.registry.putPair(pair);
      this.issue(pair.permanent, ctx.model);
      if (pair.hold !== null) this.issue(pair.hold, ctx.model);
      const withNeeds = (plan: DeletionPlan, payload: 'delete' | 'hold', text: (l: string, p: string) => string): PlanDTO => {
        const dto = toPlanDTO(plan, ctx.dto);
        const extra = needs.error !== null ? [HELD_UNREADABLE_WARNING(needs.error)] : plan.ops.flatMap((op) => (
          op.kind === 'store-sweep' && op.payload === payload
            ? needs.labels(op.storePath).map((l) => text(l, displayPath(op.storePath, ctx.dto).text)) : []));
        return { ...dto, warnings: [...dto.warnings, ...extra] };
      };
      return ok({
        hold: pair.hold === null ? null : withNeeds(pair.hold, 'hold', NEEDED_BY_HOLD),
        holdUnavailableReason: pair.holdUnavailableReason,
        permanent: withNeeds(pair.permanent, 'delete', NEEDED_BY_PERMANENT),
      });
    });
  }

  /** Which listed deletions keep `storePath` in the hub (heldPath null) and need it to be restored. */
  private async heldNeeds(roots: PortRoots): Promise<{ labels: (storePath: string) => string[]; error: string | null }> {
    // With no usable hold root nothing can be listed, but held deletions may still be on disk
    if (roots.roots.holdRoot === null) return { labels: () => [], error: roots.holdUnavailableReason ?? HOLD_UNAVAILABLE };
    let held: HeldDeletion[];
    try {
      held = await this.d.port.listHeld(roots);
    } catch (e) {
      return { labels: () => [], error: errText(e) };
    }
    const good = held.flatMap((d) => (d.ok ? [d] : []));
    return {
      labels: (p) => good.filter((d) => d.manifest.storeItems.some((x) => x.heldPath === null && x.originalPath === p)).map(deletionLabel),
      error: null,
    };
  }

  /**
   * Runs a reviewed plan. Refusals, in order, each leaving the cache untouched: an unknown or expired plan, a mode that
   * is not the plan's, a confirm text that is not exactly the phrase (no trimming or case folding; a plan without a
   * phrase takes none), a scan or operation running (BUSY), a missing app data folder, a hub or scan no longer usable,
   * an unreadable config.toml for a deletion; then `registry.take` (single use, expiry, fingerprint, phrase). Only
   * the plan `take` returns is executed. A fresh scan follows whatever the result.
   */
  executePlan(planId: string, fingerprint: string, mode: DeleteMode, confirmText: string | null): Promise<ApiResult<ExecResultDTO>> {
    return this.safe(async () => {
      const now = this.d.now();
      const entry = this.issued.get(planId);
      this.prune(now);
      if (entry === undefined) return fail('UNKNOWN_PLAN', UNKNOWN_PLAN_TEXT);
      if (entry.voided) return fail('UNKNOWN_PLAN', DELETE_VOID_TEXT);
      if (now >= entry.expiresAt) return fail('EXPIRED', EXPIRED_TEXT);
      if (mode !== entry.mode) return fail('INVALID_INPUT', `This plan is a ${entry.mode} plan, not ${mode}.`);
      if (entry.confirmPhrase === null && confirmText !== null) return fail('INVALID_INPUT', 'This plan takes no confirmation text.');
      if (entry.confirmPhrase !== null && confirmText !== entry.confirmPhrase) return fail('CONFIRM', CONFIRM_MISMATCH);
      // Checked again now; a download queued or paused since the review keeps its repo out
      const downloading = await this.downloadBlock(entry.plan);
      if (downloading !== null) return downloading;
      // the busy check and the mutex are set in the same synchronous step: a double-click runs once
      if (this.busy()) return fail('BUSY', BUSY_TEXT);
      this.op = 'execute';
      try {
        // Checked again under the mutex (no download can start or resume now), closing the await above
        const late = await this.downloadBlock(entry.plan);
        if (late !== null) return late;
        return await this.runExecute(planId, fingerprint, confirmText, entry);
      } finally {
        this.op = null;
      }
    });
  }

  private async runExecute(planId: string, fingerprint: string, confirmText: string | null, entry: Issued): Promise<ApiResult<ExecResultDTO>> {
    const { port } = this.d;
    this.gen++;
    // The journal lives in userData; it must exist before anything runs
    if (!(await this.isDir(this.d.userDataDir))) {
      return fail('INTERNAL', `The app data folder ${this.d.userDataDir} is missing; restart the app before deleting.`);
    }
    const s = this.state;
    if (s === null || s.kind === 'scan-failed') return fail('NOT_FOUND', s?.message ?? 'The cache has not been scanned.');
    if (s.kind === 'hub-missing') return fail('HUB_MISSING', s.message);
    // The hub is resolved again now (a drive unmounted since the review), and must be the one the plan was built on
    const hub = await port.resolveHub();
    if (!hub.present) return fail('HUB_MISSING', hub.problem.message);
    if (hub.hubRoot !== entry.model.hubRoot) return fail('HUB_MISSING', `The cache is no longer at ${entry.model.hubRoot}.`);
    const cfg = await port.loadConfig();
    if (!cfg.ok && entry.purpose === 'delete') {
      return fail('CONFIG', configText(cfg.error));
    }
    // the roots are rebuilt now: a hold root or view root that is no longer usable makes the executor refuse its ops
    const roots = await port.roots(entry.model.hubRoot, cfg.ok ? cfg.config : null);
    let plan: DeletionPlan;
    try {
      plan = this.registry.take(planId, fingerprint, this.d.now(), confirmText ?? undefined);
    } catch (e) {
      if (!(e instanceof ExecError)) throw e;
      if (e.code === 'USED' || e.code === 'UNKNOWN_PLAN' || e.code === 'EXPIRED') this.issued.delete(planId);
      return fail(e.code, e.code === 'FINGERPRINT' ? STALE_MESSAGE : e.message);
    }
    this.issued.delete(planId);
    let res: ExecResult;
    let staleOwnLock = false;
    try {
      res = await port.executePlan(plan, entry.model, roots);
      // Checked right away (structured), while the services mutex keeps every other operation of ours out
      if (res.error?.code === 'LOCKED') staleOwnLock = await port.lockIsStaleOwn(entry.model.hubRoot);
    } finally {
      await this.rescan();
    }
    return ok(toExecResultDTO(plan, res, staleOwnLock));
  }

  // ------------------------------------------------------------------ sync side

  /**
   * The preview. Refuses, in order: a scan or operation running (BUSY), then planningContext's refusals (HUB_MISSING,
   * failed scan, CONFIG), then a hub with no repos (HUB_MISSING; sync would otherwise remove every owned entry).
   * Writes nothing; the plan is kept by id for executeSync.
   */
  planSync(): Promise<ApiResult<SyncPlanDTO>> {
    return this.safe(async () => {
      if (this.busy()) return fail('BUSY', BUSY_TEXT);
      // read before the context: an op that starts and ends during its awaits still voids this preview
      const gen = this.gen;
      const c = await this.planningContext();
      if (!c.ok) return c.error.code === 'HUB_MISSING' ? fail('HUB_MISSING', SYNC_HUB_TEXT(this.hubRootNow(c.error.message))) : c;
      const { model, config } = c.data;
      if (model.repos.length === 0) return fail('HUB_MISSING', SYNC_HUB_TEXT(model.hubRoot));
      const plan = await this.d.port.planSync(model, config, this.d.now());
      if (gen !== this.gen || this.busy()) return fail('STALE', SYNC_RACE_TEXT);
      if (plan.hubMissing) return fail('HUB_MISSING', SYNC_HUB_TEXT(model.hubRoot));
      this.pruneSync(this.d.now());
      this.voidSync();   // a new preview supersedes the older ones
      this.syncIssued.set(plan.id, { plan, used: false });
      return ok(toSyncPlanDTO(plan, this.d.home));
    });
  }

  /** The hub folder named by the last scan (a missing hub keeps its resolved path), else the refusal's own text. */
  private hubRootNow(fallback: string): string {
    return this.state?.kind === 'hub-missing' ? this.state.hubRoot : fallback;
  }

  /** Drops every preview not yet run (used ones stay, so a repeat gets USED, until they expire). */
  private voidSync(): void {
    for (const [id, x] of this.syncIssued) if (!x.used) this.syncIssued.delete(id);
  }

  private pruneSync(now: number): void {
    for (const [id, x] of this.syncIssued) if (x.plan.expiresAt <= now) this.syncIssued.delete(id);
  }

  /**
   * Runs a previewed sync. Refusals, in order, each leaving every view untouched: an unknown plan, a used one (USED),
   * an expired one (EXPIRED), a scan or operation running (BUSY), a hub no longer usable or no longer the one the
   * preview used, an unreadable config.toml (CONFIG). Then the plan is marked used (so a second call, or a
   * double-click, can never run it twice) and runs under the core's AppLock; the core revalidates every view against the
   * preview. A fresh scan follows whatever the result. Every skipped, stale, aborted or refused view and every entry
   * that failed after a partial write reaches the DTO.
   */
  executeSync(planId: string, opts: { allowMassRemoval: boolean }): Promise<ApiResult<SyncResultDTO>> {
    return this.safe(async () => {
      const now = this.d.now();
      const entry = this.syncIssued.get(planId);
      if (entry === undefined) return fail('UNKNOWN_PLAN', SYNC_VOID_TEXT);
      if (entry.used) return fail('USED', SYNC_USED_TEXT);
      if (now >= entry.plan.expiresAt) {
        this.pruneSync(now);
        return fail('EXPIRED', EXPIRED_TEXT);
      }
      // the busy check and the mutex are set in the same synchronous step
      if (this.busy()) return fail('BUSY', BUSY_TEXT);
      this.op = 'sync';
      try {
        return await this.runSync(entry, opts.allowMassRemoval === true);
      } finally {
        this.op = null;
      }
    });
  }

  private async runSync(entry: SyncIssued, allowMassRemoval: boolean): Promise<ApiResult<SyncResultDTO>> {
    const { port } = this.d;
    const { plan } = entry;
    const s = this.state;
    if (s === null || s.kind === 'scan-failed') return fail('NOT_FOUND', s?.message ?? 'The cache has not been scanned.');
    if (s.kind === 'hub-missing') return fail('HUB_MISSING', SYNC_HUB_TEXT(s.hubRoot));
    const hub = await port.resolveHub();
    if (!hub.present) return fail('HUB_MISSING', SYNC_HUB_TEXT(hub.hubRoot));
    if (hub.hubRoot !== plan.hubRoot) return fail('HUB_MISSING', SYNC_HUB_TEXT(plan.hubRoot));
    const cfg = await port.loadConfig();
    if (!cfg.ok) return fail('CONFIG', configText(cfg.error));
    const roots = await port.roots(plan.hubRoot, cfg.config);
    entry.used = true;   // from here the plan can never run again, whatever happens
    this.gen++;
    // the links this sync creates or removes are not in any deletion review made before it
    for (const x of this.issued.values()) if (x.purpose === 'delete') x.voided = true;
    try {
      return ok(toSyncResultDTO(await port.executeSync(plan, { allowMassRemoval }, roots), plan.skipped));
    } finally {
      await this.rescan();
    }
  }

  /** A scan that starts after the change: one already running (started before it) is waited out, never joined. */
  private async rescan(): Promise<void> {
    this.gen++;
    // anything that reaches a rescan changed the hub or the views: a sync previewed before it is no longer what is on disk
    this.voidSync();
    while (this.inflight !== null) await this.inflight;
    await this.scan();
  }

  /**
   * Recently Deleted needs the last good scan (hub present, scan succeeded) and an available hold root. config.toml may
   * be unreadable (these operations touch no view).
   */
  private async heldContext(): Promise<ApiResult<HeldContext>> {
    const cur = await this.current();
    if (!cur.ok) return cur;
    const s = cur.data;
    if (s.kind === 'hub-missing') return fail('HUB_MISSING', s.message);
    if (s.kind === 'scan-failed') return fail('NOT_FOUND', s.message);
    const cfg = await this.d.port.loadConfig();
    const config = cfg.ok ? cfg.config : null;
    const roots = await this.d.port.roots(s.model.hubRoot, config);
    if (roots.roots.holdRoot === null) return fail('NOT_FOUND', roots.holdUnavailableReason ?? HOLD_UNAVAILABLE);
    return ok({ model: s.model, config, roots });
  }

  private async autoEmptyDays(): Promise<number | null> {
    return (await this.settingsStore.loadChecked()).settings.autoEmptyDays;
  }

  listHeld(): Promise<ApiResult<HeldListDTO>> {
    return this.safe(async () => {
      const autoEmptyDays = await this.autoEmptyDays();
      const h = await this.heldContext();
      if (!h.ok) return ok<HeldListDTO>({ available: false, unavailableReason: h.error.message, totalBytes: 0, items: [], autoEmptyDays, autoEmptyAt: null });
      // The rows the pending notice announced, while that run can still happen
      const ids = this.announced;
      const live = !this.autoEmptyCancelled && !this.autoEmptyStarted;
      const pending: ReadonlySet<string> = live && ids !== null ? ids : new Set();
      const items = (await this.d.port.listHeld(h.data.roots)).map((d) => toHeldDeletionDTO(d, pending));
      return ok({
        available: true, unavailableReason: null, totalBytes: items.reduce((n, i) => n + i.bytes, 0), items, autoEmptyDays,
        autoEmptyAt: live ? this.pendingEmptyAt : null,
      });
    });
  }

  /** One restore plan for a listed deletion, registered on its own. */
  planRestore(deletionId: string): Promise<ApiResult<PlanDTO>> {
    this.withdrawFromAutoEmpty(deletionId);
    return this.safe(async () => {
      if (this.busy()) return fail('BUSY', BUSY_TEXT);
      const h = await this.heldContext();
      if (!h.ok) return h;
      const { model, roots, config } = h.data;
      let plan: DeletionPlan;
      try {
        plan = await this.d.port.planRestore(model, roots, deletionId, this.d.now());
      } catch (e) {
        return planFailure(e);
      }
      const downloading = await this.downloadBlock(plan);
      if (downloading !== null) return downloading;
      this.prune(this.d.now());
      this.registry.put(plan);
      this.issue(plan, model);
      return ok(toPlanDTO(plan, this.d.port.dtoContext(model, roots, config)));
    });
  }

  /**
   * One plan per deletion, each registered on its own; the renderer reviews them together and executes them in
   * order, stopping at the first failure. A later plan that went STALE is planned and reviewed again.
   */
  planEmpty(target: EmptyTarget): Promise<ApiResult<EmptyPlanDTO>> {
    if (!('all' in target)) this.withdrawFromAutoEmpty(target.deletionId);
    return this.safe(async () => {
      if (this.busy()) return fail('BUSY', BUSY_TEXT);
      const h = await this.heldContext();
      if (!h.ok) return h;
      const { model, roots, config } = h.data;
      let batch: { plans: DeletionPlan[]; skipped: string[] };
      try {
        batch = await this.d.port.planEmpty(roots, 'all' in target ? 'all' : [target.deletionId], this.d.now());
      } catch (e) {
        return planFailure(e);
      }
      this.prune(this.d.now());
      const ctx = this.d.port.dtoContext(model, roots, config);
      const plans = batch.plans.map((p) => {
        this.registry.put(p);
        this.issue(p, model);
        return toPlanDTO(p, ctx);
      });
      return ok(toEmptyPlanDTO(plans, batch.skipped));
    });
  }

  /** Writes settings.json (through the userData SafeFs). A later read sees it, which also clears an unreadable-file state. */
  setAutoEmptyDays(days: number | null): Promise<ApiResult<null>> {
    return this.safe(async () => {
      await this.settingsStore.update((cur) => ({ ...cur.settings, autoEmptyDays: days }));   // keeps advice and the download queue
      return ok(null);
    });
  }

  /** Keep advice for the current snapshot of `repoId`. Reads GGUF headers read-only; never writes. */
  advice(repoId: string): Promise<ApiResult<RepoAdviceDTO>> {
    return this.safe(async () => {
      const found = await this.lookup(repoId);
      if (!found.ok) return found;
      const { repo, view } = found.data;
      const cfg = await this.d.port.loadConfig();
      if (this.detecting !== null) await this.detecting;   // startup detection (5 s timeout): never cache "GPU not set" advice
      return ok(await repoAdvice({
        repo, view, machine: this.machineNow(), settings: await this.adviceSettings(), config: cfg.ok ? cfg.config : null,
        readHeaders: (paths) => this.d.port.readGgufHeaders(paths), cache: this.shapes,
      }));
    });
  }

  /** The machine profile, waiting for a detection that is still running. */
  machineProfile(): Promise<ApiResult<MachineProfileDTO>> {
    return this.safe(async () => {
      if (this.detecting !== null) await this.detecting;
      return ok(await this.profile());
    });
  }

  /**
   * Saves the advice block through the userData SafeFs, keeping autoEmptyDays. A settings.json that cannot be read is
   * never overwritten from here (that would destroy the user's file and persist "Never"): SETTINGS, nothing written.
   */
  setAdviceSettings(advice: AdviceSettings): Promise<ApiResult<MachineProfileDTO>> {
    return this.safe(async () => {
      let unreadable = false;
      await this.settingsStore.update((cur) => {
        unreadable = cur.error !== null;
        return unreadable ? null : { ...cur.settings, advice };
      });
      if (unreadable) return fail('SETTINGS', SETTINGS_UNREADABLE_TEXT);
      if (this.detecting !== null) await this.detecting;
      return ok(await this.profile());
    });
  }

  /** Runs detection (once at startup from bootstrap, and on "Detect again"); a call while one runs joins it. */
  redetectMachine(): Promise<ApiResult<MachineProfileDTO>> {
    return this.safe(async () => {
      if (this.detecting === null) {
        const detect = this.d.detectMachine ?? (() => Promise.resolve(undetectedMachine(this.d.platform, totalmem())));
        const run = detect().catch(() => undetectedMachine(this.d.platform, totalmem()));
        this.detecting = run;
        try {
          this.machine = await run;
        } finally {
          if (this.detecting === run) this.detecting = null;
        }
      } else {
        await this.detecting;
      }
      return ok(await this.profile());
    });
  }

  private machineNow(): MachineProfile {
    return this.machine ?? undetectedMachine(this.d.platform, totalmem());
  }

  private async adviceSettings(): Promise<AdviceSettings> {
    return (await this.settingsStore.loadChecked()).settings.advice;
  }

  private async profile(): Promise<MachineProfileDTO> {
    const cfg = await this.d.port.loadConfig();
    const checked = await this.settingsStore.loadChecked();
    return profileDto(this.machineNow(), checked.settings.advice, checked.adviceError, cfg.ok ? cfg.config : null);
  }

  /**
   * INTERNAL: the timed run behind the `auto-empty-pending` notice. Never call it at startup or from
   * IPC: the grace period and the notice exist so the user can restore or dismiss first. `announced` is the set of
   * deletion ids the notice named; only those, if still due, are emptied.
   *
   * Permanently empties the announced deletions older than the setting. null (nothing done) unless the setting is a
   * day count (an unreadable settings file means Never), the last scan succeeded on a present hub, userData exists,
   * hold is available, the clock looks sane, auto-empty was not dismissed this session, and no scan or operation is
   * running. Plans run in order without review (journaled by the executor); the run stops at the first
   * failure, and at a dismissal (checked after the due set, after planning and before each plan).
   */
  async runAutoEmpty(announced: ReadonlySet<string>): Promise<{ count: number; freedBytes: number } | null> {
    if (this.inflight !== null || this.autoEmptyCancelled) return null;
    return this.autoEmptyLocked(announced);
  }

  /** Under the mutex. A run that emptied anything is followed by a fresh scan, still under the mutex. */
  private async autoEmptyLocked(announced: ReadonlySet<string>): Promise<{ count: number; freedBytes: number } | null> {
    if (this.op !== null) return null;
    this.op = 'auto-empty';
    try {
      this.gen++;
      const done = await this.autoEmpty(announced);
      this.gen++;
      this.voidSync();
      if (done !== null && done.count > 0) await this.rescan();
      return done;
    } catch {
      return null;
    } finally {
      this.op = null;
    }
  }

  /**
   * What auto-empty may empty now. 'off' unless: the setting is a day count, the last scan succeeded on a present hub,
   * userData exists (the journal lives there), and hold is available. 'clock' when a held deletion is dated
   * more than a day in the future, or the newest one is more than a year old.
   */
  private async dueNow(): Promise<{ kind: 'off' } | { kind: 'clock'; why: string }
    | { kind: 'due'; model: CacheModel; roots: PortRoots; due: HeldDeletion[]; days: number }> {
    const { port } = this.d;
    const days = await this.autoEmptyDays();
    const s = this.state;
    if (days === null || s === null || s.kind !== 'ok') return { kind: 'off' };
    if (!(await this.isDir(this.d.userDataDir))) return { kind: 'off' };
    const cfg = await port.loadConfig();
    const roots = await port.roots(s.model.hubRoot, cfg.ok ? cfg.config : null);
    if (roots.roots.holdRoot === null) return { kind: 'off' };
    const now = this.d.now();
    const list = await port.listHeld(roots);
    const stamps = list.flatMap((d) => (d.ok ? [d.manifest.createdAt] : []));
    if (stamps.some((t) => t > now + FUTURE_SLACK_MS)) return { kind: 'clock', why: 'a deletion is dated in the future' };
    if (stamps.length > 0 && Math.max(...stamps) < now - STALE_CLOCK_MS) return { kind: 'clock', why: 'the newest deletion is more than a year old' };
    return { kind: 'due', model: s.model, roots, due: port.autoEmptyDue(list, now, days), days };
  }

  private async autoEmpty(announced: ReadonlySet<string>): Promise<{ count: number; freedBytes: number } | null> {
    const d = await this.dueNow();
    if (d.kind === 'off' || this.autoEmptyCancelled) return null;
    if (d.kind === 'clock') {
      this.skipForClock(d.why);
      return null;
    }
    const due = d.due.filter((x) => announced.has(x.deletionId));
    if (due.length === 0) return { count: 0, freedBytes: 0 };
    const now = this.d.now();
    const { plans } = await this.d.port.planEmpty(d.roots, due.map((x) => x.deletionId), now);
    let count = 0;
    let freedBytes = 0;
    for (const plan of plans) {
      // A dismissal wins before every plan; a plan already running finishes
      if (this.autoEmptyCancelled) break;
      // A review requested during the run (answered BUSY) withdrew this deletion; it is kept
      if (plan.deletionId !== null && this.withdrawn.has(plan.deletionId)) continue;
      const res = await this.d.port.executePlan(plan, d.model, d.roots);
      if (!res.ok) break;
      count++;
      freedBytes += res.freedBytesPlanned;
    }
    if (count > 0) this.lastAutoEmpty = { at: now, count, freedBytes, days: d.days };
    return { count, freedBytes };
  }

  // ------------------------------------------------------------------ download mode

  /** The last good scan's model (scanning first when none has run); HUB_MISSING or NOT_FOUND otherwise. */
  private async scannedModel(): Promise<ApiResult<CacheModel>> {
    const cur = await this.current();
    if (!cur.ok) return cur;
    const s = cur.data;
    if (s.kind === 'hub-missing') return fail('HUB_MISSING', s.message);
    if (s.kind === 'scan-failed') return fail('NOT_FOUND', s.message);
    return ok(s.model);
  }

  /**
   * A delete or restore plan whose ops touch a repo folder with an unfinished
   * download item (any file not done: queued, running, paused, waiting or failed; the saved queue too while the engine
   * has not restored it) is refused with ACTIVE_DOWNLOAD. A paused item may
   * have no fresh .incomplete, so the planner's active-download rule alone would let its committed files be removed underneath it.
   * Emptying Recently Deleted touches only the hold root and is never refused here.
   */
  private async downloadBlock(plan: DeletionPlan): Promise<{ ok: false; error: ApiError } | null> {
    if (plan.purpose === 'empty') return null;
    const { active, unreadable } = await this.dl.activeFolders(plan.hubRoot);
    const touched = new Set<string>();
    for (const op of plan.ops) {
      const paths = [opPath(op), 'dest' in op ? op.dest : null];
      for (const p of paths) {
        if (p === null) continue;
        for (const [folder, label] of active) {
          if (p === folder || isStrictlyInside(p, folder)) return fail('ACTIVE_DOWNLOAD', DOWNLOAD_ACTIVE_TEXT(label));
        }
        if (isStrictlyInside(p, plan.hubRoot)) touched.add(relative(plan.hubRoot, p).split(sep)[0]!);
      }
    }
    // The saved queue cannot be read, so any repo with a partial file (any age) may be a paused download
    if (unreadable !== null) {
      for (const name of [...touched].sort()) {
        const repo = parseRepoFolder(name);
        if (repo === null) continue;
        let partial: boolean;
        try {
          partial = (await this.fs.readdir(join(plan.hubRoot, name, 'blobs'))).some((n) => n.endsWith('.incomplete'));
        } catch (e) {
          // No blobs/ holds no partial file; one that cannot be read may, so it fails closed
          const code = (e as NodeJS.ErrnoException | null)?.code;
          partial = code !== 'ENOENT' && code !== 'ENOTDIR';
        }
        if (partial) {
          return fail('ACTIVE_DOWNLOAD', DOWNLOAD_QUEUE_UNREADABLE_TEXT(repoLabel(repo.id, repo.type), unreadable));
        }
      }
    }
    return null;
  }

  /** The symlink probe of Settings (cached once it succeeds); a failed probe means copies, never links. */
  private async symlinksOk(): Promise<boolean> {
    if (this.symlinks !== null) return this.symlinks.ok;
    const probe = await probeSymlinks(this.d.userDataDir, {
      fs: this.fs, platform: this.d.platform, ...(this.d.makeUserSafeFs === undefined ? {} : { makeSafeFs: this.d.makeUserSafeFs }),
    });
    if (probe.ok) this.symlinks = probe;
    return probe.ok;
  }

  hubLookup(input: string): Promise<ApiResult<HubLookupDTO>> {
    return this.safe(() => this.dl.hubLookup(input));
  }

  downloadAdvice(lookupId: string): Promise<ApiResult<RepoAdviceDTO>> {
    return this.safe(() => this.dl.downloadAdvice(lookupId));
  }

  /**
   * Called once by bootstrap after the services are built. Builds the download engine and restores the saved
   * queue (unfinished files come back paused), so they exist before any download call. Never throws.
   */
  startDownloads(): Promise<void> {
    return this.dl.start();
  }

  downloadPreview(lookupId: string, groupKeys: string[]): Promise<ApiResult<DownloadPreviewDTO>> {
    return this.safe(() => this.dl.downloadPreview(lookupId, groupKeys));
  }

  /** Refused (BUSY) while an execute, sync or auto-empty run holds the mutex; the download itself runs outside it. */
  downloadStart(previewId: string, fingerprint: string): Promise<ApiResult<{ id: string }>> {
    return this.safe(() => this.dl.downloadStart(previewId, fingerprint));
  }

  downloadPause(id: string): Promise<ApiResult<null>> {
    return this.safe(() => this.dl.downloadPause(id));
  }

  downloadResume(id: string): Promise<ApiResult<null>> {
    return this.safe(() => this.dl.downloadResume(id));
  }

  downloadCancel(id: string): Promise<ApiResult<null>> {
    return this.safe(() => this.dl.downloadCancel(id));
  }

  downloads(): Promise<ApiResult<DownloadsDTO>> {
    return this.safe(() => this.dl.downloads());
  }

  lookupGroups(lookupId: string): Promise<ApiResult<DownloadGroupDTO[]>> {
    return this.safe(() => this.dl.lookupGroups(lookupId));
  }

  recentLookups(): Promise<ApiResult<RecentLookupDTO[]>> {
    return this.safe(() => this.dl.recentLookups());
  }

  /** Off for the session, with a notice. */
  private skipForClock(why: string): void {
    this.cancelAutoEmpty();
    this.autoEmptyNotice = { kind: SKIPPED_NOTICE, id: SKIPPED_NOTICE, message: AUTO_EMPTY_CLOCK_TEXT(why) };
    this.dismissed.delete(SKIPPED_NOTICE);
  }

  private cancelAutoEmpty(): void {
    this.autoEmptyCancelled = true;
    this.pendingTimer?.cancel();
    this.pendingTimer = null;
  }
}
