// The one layer through which the main process calls the shipped core. It binds the
// core's dependencies (SafeFs, Journal, AppLock, disk free, rescan, hold hooks, fetch, token) so services never build
// them, and it applies the checks every deletion offer needs before it reaches the user: the hold reason from
// holdAvailability, hold/permanent parity and the hold manifest size. DTO mapping lives in dto.ts.
// Read paths take a ReadFs; every write goes through the SafeFs built here (FsLike is never named in src/main).
import { dirname, join } from 'node:path';
import { canonicalJson } from '../core/plan/fingerprint';
import { ConfigError, configPath, loadConfig, type HfhubConfig } from '../core/compat/config';
import { executePlan, type ExecDeps } from '../core/exec/executor';
import { Journal, JOURNAL_FILE, type IncompletePlan } from '../core/exec/journal';
import { AppLock } from '../core/exec/lock';
import { fileReadAt, readFs, type ReadFs } from '../core/fsx';
import { autoEmptyDue, HeldError, listHeld, planEmpty, planRestore, type HeldDeletion } from '../core/hold/held';
import { holdAvailability, holdRootFor } from '../core/hold/hold-root';
import { executeHold, manifestFromPlan, MAX_MANIFEST_BYTES, serializeManifest, TOO_MANY_FILES } from '../core/hold/manifest';
import { isStrictlyInside, resolveHubRoot } from '../core/paths';
import { HOLD_UNAVAILABLE, planDeletion } from '../core/plan/planner';
import { SafeFs } from '../core/safe-fs';
import { scanHub } from '../core/scan/scanner';
import { executeSync, planSync, type SyncPlan, type SyncResult } from '../core/sync/sync';
import type { CacheModel, DeletionPlan, ExecResult, Op, PlanPair, SafeRoots, Selection, UsageIndex, ViewName } from '../core/types';
import { createViewImpactProvider } from '../core/views/impact';
import { readGgufHeader, type GgufHeader } from '../core/views/gguf-header';
import { readToken, type FetchLike } from '../core/views/registry';
import { buildUsageIndex } from '../core/views/usage';
import type { DtoContext } from './dto';

const VIEWS: readonly ViewName[] = ['lmstudio', 'ollama'];

/** A hold is offered only while its manifest stays this far under the cap. */
export const MANIFEST_MARGIN_BYTES = 64 * 1024;
/** The hold plan would not touch exactly the paths of the permanent plan. */
export const HOLD_PARITY_REASON = 'Recently Deleted would not move exactly the reviewed files, so only Delete Permanently is offered.';

/** config.toml is read once; when it cannot be, view-touching operations are refused by the caller. */
export type ConfigResult = { ok: true; config: HfhubConfig } | { ok: false; error: string; path: string };

/** Why the hub cannot be used. It is then never treated as present (deletion and sync stay disabled). */
export type HubProblemKind = 'missing' | 'not-a-folder' | 'no-access' | 'other';
export type HubResolution =
  | { hubRoot: string; present: true }
  | { hubRoot: string; present: false; problem: { kind: HubProblemKind; message: string } };

/** The roots of one realpath'd hub: what every planner and executor call of this port uses. */
export interface PortRoots {
  safeFs: SafeFs;
  /** `safeFs.roots`: realpath'd hub, existing configured view roots and, when available, the canonical hold root. */
  roots: SafeRoots;
  /** Realpaths of the existing configured view roots, by view. */
  viewRoots: Partial<Record<ViewName, string>>;
  /** holdAvailability's reason when hold is unavailable, else null. */
  holdUnavailableReason: string | null;
}

export interface CorePortOptions {
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** HFHUB_OFFLINE: sync plans offline and executeSync gets a fetch that always rejects. */
  offline: boolean;
  fs?: ReadFs;
  /** Builds the SafeFs for a set of roots (default `SafeFs.create(roots)`); tests pass a guarded one. */
  makeSafeFs?: (roots: SafeRoots) => Promise<SafeFs>;
  fetch?: FetchLike;
  now?: () => number;
  /** The manifest cap the hold check measures against (default MAX_MANIFEST_BYTES; tests lower it). */
  maxManifestBytes?: number;
  /**
   * TEST-ONLY. Never set by the composition root or any startup code. Replaces the core planDeletion so a test can
   * feed the port a tampered pair and prove the parity and manifest checks drop its hold. Production uses the core.
   */
  testPlanner?: typeof planDeletion;
}

export interface CorePort {
  /** The hub from the environment, realpath'd when it is an existing folder (present); otherwise as resolved, with why. */
  resolveHub(): Promise<HubResolution>;
  loadConfig(): Promise<ConfigResult>;
  /** `realHub` must exist. `config` null (unreadable) gives no view roots. */
  roots(realHub: string, config: HfhubConfig | null): Promise<PortRoots>;
  dtoContext(model: CacheModel, r: PortRoots, config: HfhubConfig | null): DtoContext;
  usage(model: CacheModel, config: HfhubConfig): Promise<UsageIndex>;
  /**
   * Both plans of a review, never registered (the caller registers after its own checks). The hold plan is dropped,
   * with the reason, when holdAvailability refused it, when it would not touch exactly the permanent plan's
   * paths, or when its manifest cannot be built or would be too large.
   */
  planDeletion(model: CacheModel, selection: Selection, r: PortRoots, config: HfhubConfig, now: number): Promise<PlanPair>;
  /** Why the hold manifest of `plan` cannot be written (TOO_MANY_FILES or manifestFromPlan's message), or null. */
  holdManifestProblem(plan: DeletionPlan, model: CacheModel, r: PortRoots, now: number): Promise<string | null>;
  /** A hold delete runs through executeHold (manifest hooks + finalize); everything else through executePlan. */
  executePlan(plan: DeletionPlan, model: CacheModel, r: PortRoots): Promise<ExecResult>;
  /** The hub's app.lock names this process but no operation of ours holds it (a lock left behind). Never throws. */
  lockIsStaleOwn(hubRoot: string): Promise<boolean>;
  listHeld(r: PortRoots): Promise<HeldDeletion[]>;
  /** HeldError NOT_FOUND when the id is not listed. */
  planRestore(model: CacheModel, r: PortRoots, deletionId: string, now: number): Promise<DeletionPlan>;
  /** One plan per deletion; HeldError NOT_FOUND when a given id is not listed. */
  planEmpty(r: PortRoots, target: 'all' | string[], now: number): Promise<{ plans: DeletionPlan[]; skipped: string[] }>;
  /** `days` null (Never) selects nothing. */
  autoEmptyDue(list: HeldDeletion[], now: number, days: number | null): HeldDeletion[];
  planSync(model: CacheModel, config: HfhubConfig, now: number): Promise<SyncPlan>;
  executeSync(plan: SyncPlan, opts: { allowMassRemoval: boolean }, r: PortRoots): Promise<SyncResult>;
  /**
   * Read-only: the GGUF header of each file, in the order given (advice reads a quant's shards first to last). null
   * when any of them is not a readable GGUF header (bad magic, truncated, invalid values): that is a fact of the bytes.
   * An I/O error (an errno code: EACCES, EIO, EMFILE, ENOENT, ...) rejects instead, so the caller does not cache it.
   * Every file is opened read-only and closed again.
   */
  readGgufHeaders(paths: readonly string[]): Promise<GgufHeader[] | null>;
  journalIncomplete(): Promise<IncompletePlan[]>;
  acknowledge(planId: string): Promise<void>;
  journalPath: string;
  /**
   * What the download engine writes through for `realHub`: a SafeFs rooted at the hub alone (no view or hold
   * root; DownloadFs narrows it further to one repo folder), and the same AppLock instance deletions and sync take, so
   * a commit and a deletion exclude each other and the stale-lock check never mistakes a download for a lock left
   * behind.
   */
  downloadTarget(realHub: string): { safeFs: () => Promise<SafeFs>; lock: AppLock };
}

/** Per-layer header arrays (head_count_kv, sliding_window_pattern) must cover every layer (shape.ts MAX_LAYERS). */
export const GGUF_ARRAY_ITEMS = 4096;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

function hubProblem(hub: string, e: unknown): HubResolution {
  const code = codeOf(e);
  const problem = code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' as const, message: `Cache not found at ${hub}` }
    : code === 'EACCES' || code === 'EPERM' ? { kind: 'no-access' as const, message: `The cache at ${hub} cannot be read (${code}).` }
      : { kind: 'other' as const, message: `The cache at ${hub} could not be opened: ${errText(e)}` };
  return { hubRoot: hub, present: false, problem };
}

/** The fetch an offline app hands executeSync (HFCM_OFFLINE=1): every registry call fails, nothing is downloaded. */
export const offlineFetch: FetchLike = () => Promise.reject(new Error('offline (HFCM_OFFLINE=1)'));

/** Paths an op changes, for the parity check: rmdir-empty and the hold-manifest write are left out. */
function touched(ops: readonly Op[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.kind === 'unlink' || op.kind === 'hold-rename' || op.kind === 'restore-rename') out.add(op.path);
    else if (op.kind === 'store-sweep') {
      if (op.payload !== 'keep') out.add(op.storePath);
      out.add(op.refsPath);
    } else if (op.kind === 'store-refs-add') out.add(op.refsPath);
    else if (op.kind === 'write-file' && op.role === 'view-state') out.add(op.path);
  }
  return out;
}

/**
 * The hold plan touches exactly the permanent plan's paths, a whole-repo folder rename standing for every path
 * inside that folder, and only for a repo selected whole. Both plans must carry the same selection.
 */
export function holdMatchesPermanent(pair: PlanPair, model: CacheModel): boolean {
  const { hold, permanent } = pair;
  if (hold === null || canonicalJson(hold.selection) !== canonicalJson(permanent.selection)) return false;
  const H = touched(hold.ops);
  const P = touched(permanent.ops);
  const folders = hold.ops.flatMap((o) => (o.kind === 'hold-rename' && o.role === 'repo-folder' ? [o.path] : []));
  const wholeFolders = (permanent.selection?.repos ?? []).flatMap((s) => {
    const repo = s.whole ? model.repos.find((x) => x.id === s.repoId) : undefined;
    return repo === undefined ? [] : [repo.folder];
  });
  // A folder rename stands for the whole repo, so the permanent plan must remove every path the model
  // lists for that repo (snapshot links, repo blobs, other files, incomplete files); an rmdir alone is not enough
  const covered = (f: string): boolean => {
    const repo = model.repos.find((x) => x.folder === f);
    if (repo === undefined) return false;
    const listed = [
      ...repo.files.map((x) => x.linkPath), ...Object.values(repo.blobs).map((b) => b.path),
      ...repo.otherFiles.map((o) => o.path), ...repo.incomplete.map((i) => i.path),
    ];
    return listed.every((p) => P.has(p));
  };
  return folders.every((f) => wholeFolders.includes(f) && covered(f))
    && [...P].every((p) => H.has(p) || folders.some((f) => isStrictlyInside(p, f)))
    && [...H].every((h) => P.has(h) || folders.includes(h));
}

export function createCorePort(opts: CorePortOptions): CorePort {
  const fs = opts.fs ?? readFs;
  const now = opts.now ?? Date.now;
  const makeSafeFs = opts.makeSafeFs ?? ((roots: SafeRoots) => SafeFs.create(roots));
  const maxManifest = opts.maxManifestBytes ?? MAX_MANIFEST_BYTES;
  const planner = opts.testPlanner ?? planDeletion;
  const journal = new Journal(opts.userDataDir, now);
  // One AppLock per hub, shared by deletions and sync (AppLock.acquire creates its folder)
  const locks = new Map<string, AppLock>();
  const lockFor = (hubRoot: string): AppLock => {
    const dir = join(dirname(hubRoot), '.hf-cache-manager');
    const lock = locks.get(dir) ?? new AppLock(dir);
    locks.set(dir, lock);
    return lock;
  };
  const diskFree = async (p: string): Promise<number> => {
    const s = await fs.statfs(p);
    return s.bavail * s.bsize;
  };
  const isDir = async (p: string): Promise<boolean> => {
    try {
      return (await fs.stat(p)).isDirectory();
    } catch {
      return false;
    }
  };

  const port: CorePort = {
    journalPath: join(opts.userDataDir, JOURNAL_FILE),

    async resolveHub() {
      const hub = resolveHubRoot(opts.env, opts.home);
      try {
        if (!(await fs.stat(hub)).isDirectory()) {
          return { hubRoot: hub, present: false, problem: { kind: 'not-a-folder', message: `Cache not found at ${hub} (not a folder).` } };
        }
        return { hubRoot: await fs.realpath(hub), present: true };
      } catch (e) {
        return hubProblem(hub, e);
      }
    },

    async loadConfig() {
      try {
        return { ok: true, config: await loadConfig(opts.env, opts.home, fs) };
      } catch (e) {
        return { ok: false, error: errText(e), path: e instanceof ConfigError ? e.path : configPath(opts.env, opts.home) };
      }
    },

    async roots(realHub, config) {
      const avail = await holdAvailability(realHub, fs);
      const viewRoots: Partial<Record<ViewName, string>> = {};
      for (const view of VIEWS) {
        const root = config?.views[view].root ?? null;
        if (root !== null && (await isDir(root))) viewRoots[view] = await fs.realpath(root);
      }
      // Overlapping roots stay in (the impact provider and sync refuse them; SafeFs only bounds the writes)
      const safeFs = await makeSafeFs({
        hubRoot: realHub, viewRoots: [...new Set(Object.values(viewRoots))], holdRoot: avail.ok ? holdRootFor(realHub) : null,
      });
      return { safeFs, roots: safeFs.roots, viewRoots, holdUnavailableReason: avail.ok ? null : avail.reason };
    },

    dtoContext(model, r, config) {
      return {
        model, home: opts.home, holdRoot: r.roots.holdRoot,
        viewRoots: { lmstudio: r.viewRoots.lmstudio ?? null, ollama: r.viewRoots.ollama ?? null },
        configuredViews: config === null ? [] : VIEWS.filter((v) => config.views[v].root !== null),
      };
    },

    usage(model, config) {
      return buildUsageIndex(config, model, fs);
    },

    async planDeletion(model, selection, r, config, at) {
      const pair = await planner({ model, selection, roots: r.roots, views: createViewImpactProvider(config, fs), now: at });
      if (pair.hold === null) {
        const reason = pair.holdUnavailableReason === HOLD_UNAVAILABLE ? r.holdUnavailableReason ?? HOLD_UNAVAILABLE : pair.holdUnavailableReason;
        return { ...pair, holdUnavailableReason: reason };
      }
      if (!holdMatchesPermanent(pair, model)) return { ...pair, hold: null, holdUnavailableReason: HOLD_PARITY_REASON };
      const problem = await port.holdManifestProblem(pair.hold, model, r, at);
      return problem === null ? pair : { ...pair, hold: null, holdUnavailableReason: problem };
    },

    async holdManifestProblem(plan, model, r, at) {
      try {
        const m = await manifestFromPlan(plan, { model, viewRoots: r.viewRoots, fs, now: at });
        return Buffer.byteLength(serializeManifest(m)) > maxManifest - MANIFEST_MARGIN_BYTES ? TOO_MANY_FILES : null;
      } catch (e) {
        return errText(e);
      }
    },

    executePlan(plan, model, r) {
      const deps: ExecDeps = {
        safeFs: r.safeFs, fs, journal, lock: lockFor(r.roots.hubRoot), rescan: () => scanHub(r.roots.hubRoot, fs), now, diskFree,
      };
      if (plan.purpose === 'delete' && plan.mode === 'hold') return executeHold(plan, deps, { model, viewRoots: r.viewRoots, fs });
      return executePlan(plan, deps);
    },

    lockIsStaleOwn(hubRoot) {
      return lockFor(hubRoot).recordIsOurs();
    },

    listHeld(r) {
      return listHeld(r.roots, fs);
    },

    async planRestore(model, r, deletionId, at) {
      const d = (await listHeld(r.roots, fs)).find((x) => x.deletionId === deletionId);
      if (d === undefined) throw new HeldError('NOT_FOUND', `${deletionId} is not in Recently Deleted.`);
      return planRestore(d, model, r.roots, at, fs);
    },

    async planEmpty(r, target, at) {
      if (target === 'all') return planEmpty('all', r.roots, at, fs);
      const list = await listHeld(r.roots, fs);
      const chosen = target.map((id) => {
        const d = list.find((x) => x.deletionId === id);
        if (d === undefined) throw new HeldError('NOT_FOUND', `${id} is not in Recently Deleted.`);
        return d;
      });
      return planEmpty(chosen, r.roots, at, fs);
    },

    autoEmptyDue(list, at, days) {
      return autoEmptyDue(list, at, days ?? 'never');
    },

    planSync(model, config, at) {
      return planSync(config, model, { offline: opts.offline, now: at, fs });
    },

    async executeSync(plan, { allowMassRemoval }, r) {
      return executeSync(plan, {
        safeFs: r.safeFs, fs, allowMassRemoval, lock: lockFor(r.roots.hubRoot),
        fetch: opts.offline ? offlineFetch : opts.fetch ?? ((url, init) => globalThis.fetch(url, init)),
        token: await readToken(opts.env, opts.home, fs), now: () => new Date(now()),
      });
    },

    async readGgufHeaders(paths) {
      const out: GgufHeader[] = [];
      for (const p of paths) {
        // open() on a FIFO or device blocks forever; anything but a regular file is not a GGUF header
        if (!(await fs.stat(p)).isFile()) return null;
        const r = fileReadAt(p);
        try {
          out.push(await readGgufHeader(r.readAt, GGUF_ARRAY_ITEMS));
        } catch (e) {
          if (typeof codeOf(e) === 'string') throw e;
          return null;
        } finally {
          await r.close().catch(() => undefined);
        }
      }
      return out;
    },

    journalIncomplete() {
      return journal.incompletePlans();
    },

    downloadTarget(realHub) {
      let safe: Promise<SafeFs> | null = null;
      return {
        safeFs: () => {
          safe ??= makeSafeFs({ hubRoot: realHub, viewRoots: [], holdRoot: null });
          safe.catch(() => { safe = null; });   // a failed create is tried again next time
          return safe;
        },
        lock: lockFor(realHub),
      };
    },

    acknowledge(planId) {
      return journal.acknowledge(planId);
    },
  };
  return port;
}
