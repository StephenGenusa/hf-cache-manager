// Sync. planSync is read-only: it computes presence, reconciles, applies the hub and mass-removal
// guards and snapshots the FileFacts of every path executeSync may touch. executeSync takes the AppLock, revalidates
// that snapshot (anything changed: the whole view is `stale` and nothing is written), applies the items in the CLI's
// order (prunes first) through the view drivers, whose every mutation goes through SafeFs via viewFs, and saves the
// state file with the facts seen at revalidation as its `expect`.
// V31: the state file is written with SafeFs.writeFileAtomic (temp file + rename, no fsync), like the CLI's os.replace.
// Deviation from the CLI (safe direction): a prune or update never removes a path that another item of
// the same view plan wants as it is: an adopt or noop item's desired path (already correct on disk), or a create or
// update item's desired path when that item's sha256 equals the removing key's (same content). The CLI's apply only
// protects paths of keys already owned, so a file moved inside its repo with the same content (same view path) had its
// correct link removed by the old key's prune and then claimed by the new key's adopt, which the next sync tombstoned.
// Such a path is kept, shown in keepsShared with the wanting key as owner, and its ownership passes to that key.
// Ollama alias manifests never count as "as it is" (presence only checks that they exist), so an alias still naming
// the old model is removed with it and rewritten for the new key by the next sync.
// A create/update of DIFFERENT content does not protect the path: it holds the old model (an alias manifest with the old
// digest, which create would refuse to overwrite), so it is removed as in the CLI and rewritten by the new key.
// Deviation (golden-tested only at unit level): an Ollama entry whose registry-cache file (keyed by repo and
// BASENAME) is shared with another entry of the same repo is skipped and warned about, never written; the CLI has no such
// check and synthesises both. LM Studio basename collisions behave as in the CLI (first wins) and are golden-tested.
// V12: a sync plan has no journal (the CLI has none; the state file is the record). Deviation, acknowledged in rulings.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { HfhubConfig } from '../compat/config';
import { loadState, serializeState, STATE_FILE, StateError, type OwnedEntry, type ViewState } from '../compat/state';
import { ExecError } from '../exec/errors';
import type { AppLock } from '../exec/lock';
import { factsOf, fileReadAt, readFs, type ReadFs } from '../fsx';
import { SafeFsError, type SafeFs } from '../safe-fs';
import { parseRepoFolder } from '../scan/scanner';
import type { CacheModel, FileFacts, ViewName } from '../types';
import { ggufEntries } from '../views/entries';
import { lmstudioDriver } from '../views/lmstudio';
import { ollamaDriver } from '../views/ollama';
import { localIsoSeconds, pyCompare, pySort } from '../compat/pyjson';
import { readGgufHeader, type GgufHeader } from '../views/gguf-header';
import { makeOllamaCreate } from '../views/ollama-create';
import { applyOrder, isMassRemoval, reconcile, removablePaths, type SyncAction } from '../views/reconcile';
import { registryCollisions, type FetchLike } from '../views/registry';
import { CreateIncomplete, SkipEntry, type ApplyCtx, type Desired, type ForeignEntry, type Presence, type ViewDriver } from '../views/view-types';
import { viewFs } from '../views/walk';
import { overlappingRoots, VIEW_ROOTS_OVERLAP } from '../views/view-path';

export type { SyncAction };

export const PLAN_TTL_MS = 10 * 60_000;
const VIEWS: readonly ViewName[] = ['lmstudio', 'ollama'];
const ACTIONS: readonly SyncAction[] = ['skip', 'update', 'foreign', 'create', 'noop', 'tombstone', 'adopt', 'prune'];

export interface SyncItem {
  key: string;
  action: SyncAction;
  reason?: string;
  presence?: Presence;
  desired?: Desired;
  owned?: OwnedEntry;
  conditional: string[];   // subset of removes (Ollama blobs/): removed only if no manifest left on disk uses them
  removes: string[];       // prune/update: owned paths that would go (shared-path protection applied at plan time)
  keepsShared: Array<{ path: string; owners: string[] }>;
}

export interface ViewSyncPlan {
  view: ViewName;
  root: string;            // realpath
  statePath: string;
  stateRaw: string | null;
  state: ViewState;
  items: SyncItem[];
  foreign: ForeignEntry[];
  warnings: string[];
  massRemoval: boolean;
  ownedCount: number;
  expect: Record<string /* view-relative */, FileFacts | null>;
  collisions: Record<string, string>;   // key -> warning; {} for lmstudio (V13)
  counts: Record<SyncAction, number>;
}

export interface SyncPlan {
  id: string;
  createdAt: number;
  expiresAt: number;       // createdAt + 10 min (V12)
  hubRoot: string;
  offline: boolean;
  hubMissing: boolean;
  views: ViewSyncPlan[];
  skipped: Array<{ view: ViewName; reason: string }>;
  warnings: string[];
}

export interface ItemStep {
  state: ViewState;
  removes: string[];
  keepsShared: Array<{ path: string; owners: string[] }>;
  conditional: string[];
}

/**
 * The ONE state-transition rule shared by planSync (preview) and executeSync. Pure: `state` is not mutated.
 * `created` is what the driver's create returned; the preview passes none and uses the desired paths.
 * - create: owned paths = previous paths union created.
 * - adopt: owned paths = previous paths union the desired LINK paths only (CLI base.py:53-55 `Desired.paths` and :166):
 *   an adopted Ollama entry never owns the hf.co manifest or an alias, which the user's own `ollama pull` may have
 *   written. Removing such a manifest would let Ollama garbage-collect the user's weights.
 * - update: removes = old minus created (shared paths protected); owned paths = created (CLI base.py `apply`).
 * - prune: removes = owned paths not listed by another owned key; the key leaves `owned`.
 * - tombstone: the key leaves `owned` and gains a tombstone (`tombstoneAt` or ''); nothing is removed.
 * - `wanted` (from `wantedPaths`): a prune/update candidate that ANOTHER key wants as it is (adopt/noop, or the same
 *   sha256 as this key's) is never removed; it goes to keepsShared with that key as owner and is added to that key's
 *   owned paths now if it is owned or takes it as it is (an adopt, which owns only its links in its own step), else by
 *   its own create/update step.
 * Everything is evaluated against `state` as it is NOW, after earlier items were applied.
 */
export function applyItemToState(
  state: ViewState, item: Pick<SyncItem, 'key' | 'action' | 'desired'>, created?: string[],
  opts: { conditionalBlobs?: boolean; tombstoneAt?: string; wanted?: ReadonlyMap<string, Wanted> } = {},
): ItemStep {
  const next = clone(state);
  const { key, action, desired } = item;
  const prev = next.owned[key];
  let removes: string[] = [];
  let keepsShared: ItemStep['keepsShared'] = [];
  const made = created ?? desired?.paths ?? [];
  const wanted = opts.wanted ?? new Map<string, Wanted>();
  const takerOf = (p: string): string | null => {
    const w = wanted.get(p);
    return w !== undefined && w.key !== key && (w.asIs || w.sha256 === prev?.sha256) ? w.key : null;
  };
  const removable = (candidates: string[]): void => {
    const handed = candidates.filter((p) => takerOf(p) !== null);
    const handedSet = new Set(handed);
    const r = removablePaths(key, candidates.filter((p) => !handedSet.has(p)), next);
    removes = r.remove;
    keepsShared = [...r.keepShared, ...handed.map((path) => ({ path, owners: [takerOf(path)!] }))]
      .sort((a, b) => pyCompare(a.path, b.path));
    for (const p of handed) {
      const taker = takerOf(p)!;
      const to = next.owned[taker];
      const w = wanted.get(p)!;
      if (to === undefined && w.asIs) next.owned[taker] = { paths: [p], sha256: w.sha256 };
      else if (to !== undefined && !to.paths.includes(p)) to.paths = pySort([...to.paths, p]);
    }
  };
  if (action === 'prune' && prev !== undefined) {
    removable(prev.paths);
    delete next.owned[key];
  } else if (action === 'tombstone') {
    delete next.owned[key];
    next.tombstones[key] = opts.tombstoneAt ?? '';
  } else if (action === 'update' && desired !== undefined) {
    const keep = new Set(made);
    removable((prev?.paths ?? []).filter((p) => !keep.has(p)));
    next.owned[key] = { paths: pySort(new Set(made)), sha256: desired.sha256 };
  } else if (action === 'create' && desired !== undefined) {
    next.owned[key] = { paths: pySort(new Set([...made, ...(prev?.paths ?? [])])), sha256: desired.sha256 };
  } else if (action === 'adopt' && desired !== undefined) {
    next.owned[key] = { paths: pySort(new Set([...desired.links.map((l) => l.path), ...(prev?.paths ?? [])])), sha256: desired.sha256 };
  }
  const conditional = opts.conditionalBlobs === true ? removes.filter((p) => p.startsWith('blobs/')) : [];
  return { state: next, removes, keepsShared, conditional };
}

const WANTING: ReadonlySet<SyncAction> = new Set<SyncAction>(['create', 'adopt', 'update', 'noop']);

/** A path another item wants: its key, its sha256, and whether it takes the path as it is (adopt/noop, never an alias). */
export interface Wanted { key: string; sha256: string; asIs: boolean }

/** Every desired path of a create/adopt/update/noop item (first key in key order wins). Shared by preview and execute. */
export function wantedPaths(items: ReadonlyArray<Pick<SyncItem, 'key' | 'action' | 'desired'>>): Map<string, Wanted> {
  const out = new Map<string, Wanted>();
  for (const i of [...items].sort((a, b) => pyCompare(a.key, b.key))) {
    if (!WANTING.has(i.action) || i.desired === undefined) continue;
    const asIs = i.action === 'adopt' || i.action === 'noop';
    // An Ollama alias manifest counts as present when it merely exists (presence does not check its model digest), so
    // it is never taken "as it is": it may still name the old model and must follow the same-sha rule.
    const aliases = new Set(i.desired.ollama?.aliasPaths ?? []);
    for (const p of i.desired.paths) {
      if (!out.has(p)) out.set(p, { key: i.key, sha256: i.desired.sha256, asIs: asIs && !aliases.has(p) });
    }
  }
  return out;
}

const clone = (s: ViewState): ViewState => ({
  version: 1,
  owned: Object.fromEntries(Object.entries(s.owned).map(([k, o]) => [k, { paths: [...o.paths], sha256: o.sha256 }])),
  tombstones: { ...s.tombstones },
});

async function isDir(fs: ReadFs, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function planView(
  view: ViewName, config: HfhubConfig, model: CacheModel, entries: ReturnType<typeof ggufEntries>, fs: ReadFs,
  real: string,
): Promise<ViewSyncPlan> {
  const loaded = await loadState(real, fs);
  const state = loaded.state;
  const cfg = config.views[view];
  const driver: ViewDriver = view === 'lmstudio'
    ? lmstudioDriver(real, model.hubRoot, fs)
    : ollamaDriver(real, model.hubRoot, cfg.aliases, plansNeverCreate, fs);

  const warnings: string[] = [];
  const desired = driver.desired(entries, warnings);
  const byKey = new Map(desired.map((d) => [d.key, d]));
  const presence = new Map<string, Presence>();
  const inputs = [];
  for (const d of desired) {
    const p = await driver.presence(d);
    presence.set(d.key, p);
    const owned = state.owned[d.key];
    const stale = owned !== undefined && p === 'wrong' ? await driver.isStale(d, owned) : false;
    inputs.push({ key: d.key, presence: p, stale });
  }
  const recon = reconcile(inputs, state);

  const items: SyncItem[] = recon.map((r) => {
    const item: SyncItem = { key: r.key, action: r.action, removes: [], conditional: [], keepsShared: [] };
    if (r.reason !== undefined) item.reason = r.reason;
    const p = presence.get(r.key);
    if (p !== undefined) item.presence = p;
    const d = byKey.get(r.key);
    if (d !== undefined) item.desired = d;
    const o = state.owned[r.key];
    if (o !== undefined) item.owned = { paths: [...o.paths], sha256: o.sha256 };
    return item;
  });

  for (const item of items) {
    if (item.action !== 'foreign') continue;
    const why = await driver.foreignReason(item.desired!);   // a foreign item always comes from a desired entry
    if (why !== undefined) item.reason = why;
  }

  // removablePaths depends on the LIVE state, so simulate executeSync's order (prunes first) with the shared rule.
  let live = state;
  const itemOf = new Map(items.map((i) => [i.key, i]));
  const collisions: Record<string, string> = view === 'ollama' ? Object.fromEntries(registryCollisions(entries)) : {};
  for (const item of items) {
    if ((item.action === 'create' || item.action === 'update') && collisions[item.key] !== undefined) {
      item.action = 'skip';       // execute's create throws SkipEntry for a colliding key: nothing changes
      item.reason = collisions[item.key]!;
    }
  }
  const wanted = wantedPaths(items);
  for (const r of applyOrder(recon)) {
    const item = itemOf.get(r.key)!;
    if (item.action === 'skip') continue;
    const step = applyItemToState(live, item, undefined, { conditionalBlobs: view === 'ollama', wanted });
    item.removes = step.removes;
    item.keepsShared = step.keepsShared;
    item.conditional = step.conditional;
    live = step.state;
  }

  const ownedPaths = new Set(Object.values(state.owned).flatMap((o) => o.paths));
  const foreign = await driver.foreign(ownedPaths);

  const rels = new Set<string>(ownedPaths);
  for (const d of desired) for (const p of d.paths) rels.add(p);
  const expect: Record<string, FileFacts | null> = {};
  for (const rel of [...rels].sort()) expect[rel] = await factsOf(fs, `${real}/${rel}`);

  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<SyncAction, number>;
  for (const i of items) counts[i.action] += 1;

  for (const msg of Object.values(collisions)) warnings.push(`[ollama] ${msg}`);

  return {
    view, root: real, statePath: loaded.path, stateRaw: loaded.raw, state, items, foreign, warnings,
    massRemoval: isMassRemoval(items, state), ownedCount: Object.keys(state.owned).length, expect, collisions, counts,
  };
}

/** The create hook of the driver a preview uses: a preview only reads, so reaching it is a bug. */
export const plansNeverCreate = (): Promise<string[]> => Promise.reject(new Error('plans never create'));

export async function planSync(
  config: HfhubConfig, model: CacheModel, opts: { offline: boolean; now: number; fs?: ReadFs },
): Promise<SyncPlan> {
  const fs = opts.fs ?? readFs;
  const plan: SyncPlan = {
    id: randomUUID(), createdAt: opts.now, expiresAt: opts.now + PLAN_TTL_MS, hubRoot: model.hubRoot,
    offline: opts.offline, hubMissing: false, views: [], skipped: [], warnings: [],
  };

  let hubOk: boolean;
  try {
    hubOk = (await fs.lstat(model.hubRoot)).isDirectory() && model.repos.length > 0;
  } catch {
    hubOk = false;
  }
  if (!hubOk) {
    plan.hubMissing = true;
    for (const view of VIEWS) {
      if (config.views[view].root === null) continue;
      plan.skipped.push({ view, reason: `hub not found or empty: ${model.hubRoot}; nothing done` });
    }
    return plan;
  }
  // Overlapping view folders would share one state file and each other's files: every view that overlaps another is
  // refused (pairwise, any number of views); the others are planned as usual.
  const overlapping = await overlappingRoots(fs, VIEWS.map((v) => config.views[v].root));
  const refused = new Set(VIEWS.filter((_, i) => overlapping[i] === true));
  for (const view of refused) plan.skipped.push({ view, reason: VIEW_ROOTS_OVERLAP });

  const entries = ggufEntries(model);
  for (const view of VIEWS) {
    if (refused.has(view)) continue;
    const cfg = config.views[view];
    if (cfg.root === null) {
      plan.skipped.push({ view, reason: cfg.problem ?? 'not configured' });
      continue;
    }
    if (!(await isDir(fs, cfg.root))) {
      plan.skipped.push({ view, reason: `root does not exist: ${cfg.root}` });
      continue;
    }
    try {
      const real = await fs.realpath(cfg.root);
      const vp = await planView(view, config, model, entries, fs, real);
      plan.views.push(vp);
      plan.warnings.push(...vp.warnings);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (e instanceof StateError || code === 'EACCES' || code === 'EPERM') {
        plan.skipped.push({ view, reason: `aborted: ${(e as Error).message}` });
      } else throw e;
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------------
// executeSync

export interface ExecuteSyncDeps {
  safeFs: SafeFs;
  fs: ReadFs;
  fetch: FetchLike;
  allowMassRemoval: boolean;
  token: string | null;
  now: () => Date;
  readGguf?: (abs: string) => Promise<GgufHeader>;
  /** V11: the same AppLock deletions use; held from before revalidation until the last state file is saved. */
  lock: AppLock;
}

export type ViewSyncStatus = 'applied' | 'refused-mass-removal' | 'stale' | 'aborted' | 'skipped';

export interface ViewSyncResult {
  view: ViewName;
  status: ViewSyncStatus;
  message?: string;
  applied: Array<{ key: string; action: SyncAction }>;
  /** Execute-time skips (SkipEntry: nothing written) and items that failed after a partial write (owned, retried next sync). */
  skippedEntries: Array<{ key: string; reason: string; /** true: the item failed after part of it was written. */ partialWrite?: true }>;
  removedPaths: string[];   // view-relative
  createdPaths: string[];   // view-relative: what the drivers' create returned (or wrote, for a partial create)
  warnings: string[];
}

export interface SyncResult { planId: string; views: ViewSyncResult[] }

const CHANGES: ReadonlySet<SyncAction> = new Set<SyncAction>(['prune', 'tombstone', 'adopt', 'create', 'update']);

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const emptyResult = (view: ViewName, status: ViewSyncStatus, message?: string): ViewSyncResult => ({
  view, status, ...(message === undefined ? {} : { message }),
  applied: [], skippedEntries: [], removedPaths: [], createdPaths: [], warnings: [],
});

async function readGgufFile(abs: string): Promise<GgufHeader> {
  const r = fileReadAt(abs);
  try {
    return await readGgufHeader(r.readAt);
  } finally {
    await r.close();
  }
}

/** The hub is a real directory holding at least one `<type>s--<org>--<name>` folder. */
async function hubHasRepos(fs: ReadFs, hubRoot: string): Promise<boolean> {
  try {
    const st = await fs.lstat(hubRoot);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    return (await fs.readdir(hubRoot)).some((name) => parseRepoFolder(name) !== null);
  } catch {
    return false;
  }
}

/**
 * The root, the state file text and every planned path's facts must be exactly what the preview saw.
 * Returns the state file's facts (V37: the final save's `expect`) and the state as read from disk (applied instead of
 * the plan's copy: the raw text was just checked, so they are equal, but ownership then never comes from the plan), or 'stale'. Any error reading counts as changed.
 */
async function revalidate(fs: ReadFs, v: ViewSyncPlan): Promise<{ stateFacts: FileFacts | null; state: ViewState } | 'stale'> {
  try {
    if (v.statePath !== join(v.root, STATE_FILE)) return 'stale';
    const st = await fs.lstat(v.root);
    if (!st.isDirectory() || st.isSymbolicLink() || (await fs.realpath(v.root)) !== v.root) return 'stale';
    const before = await factsOf(fs, v.statePath);
    const loaded = await loadState(v.root, fs);
    const stateFacts = await factsOf(fs, v.statePath);
    if (loaded.raw !== v.stateRaw || !isDeepStrictEqual(before, stateFacts)) return 'stale';
    for (const [rel, want] of Object.entries(v.expect)) {
      if (!isDeepStrictEqual(await factsOf(fs, join(v.root, ...rel.split('/'))), want)) return 'stale';
    }
    return { stateFacts, state: loaded.state };
  } catch {
    return 'stale';
  }
}

/**
 * Applies one ViewSyncPlan. Every state change is `applyItemToState` (the preview's rule) with what the driver actually
 * did; removals are only ever the paths that rule computes against the live state AND the preview listed for the item.
 */
async function executeView(plan: SyncPlan, v: ViewSyncPlan, deps: ExecuteSyncDeps): Promise<ViewSyncResult> {
  const { fs } = deps;
  const out = emptyResult(v.view, 'applied');
  const tag = `[${v.view}]`;
  const roots = deps.safeFs.roots;
  if (!roots.viewRoots.includes(v.root) || roots.hubRoot !== plan.hubRoot) {
    return emptyResult(v.view, 'skipped', `${tag} not covered by the SafeFs roots: ${v.root}`);
  }
  const checked = await revalidate(fs, v);
  if (checked === 'stale') return emptyResult(v.view, 'stale', `${tag} the view changed since the preview — preview again`);
  if (v.massRemoval && !deps.allowMassRemoval) {
    return emptyResult(v.view, 'refused-mass-removal',
      `${tag} refused: plan would remove every owned entry (${v.ownedCount}); confirm "allow mass removal" if this is intended`);
  }

  // The plan's facts, updated only to "absent" for a path that this run removed (a later write there must find it gone).
  const live = new Map<string, FileFacts | null>(Object.entries(v.expect));
  const ctx: ApplyCtx = { safeFs: deps.safeFs, fs, expect: (rel) => live.get(rel), warnings: out.warnings };
  const markGone = async (rels: string[]): Promise<void> => {
    for (const rel of rels) {
      if (live.has(rel) && live.get(rel) !== null && (await factsOf(fs, join(v.root, ...rel.split('/')))) === null) live.set(rel, null);
    }
  };
  const driver: ViewDriver = v.view === 'lmstudio'
    ? lmstudioDriver(v.root, plan.hubRoot, fs)
    : ollamaDriver(v.root, plan.hubRoot, {}, makeOllamaCreate({
      registry: { root: v.root, fs, fetch: deps.fetch, offline: plan.offline, token: deps.token },
      hubRoot: plan.hubRoot, readGguf: deps.readGguf ?? readGgufFile, collisions: new Map(Object.entries(v.collisions)),
    }), fs);
  const opts = { conditionalBlobs: v.view === 'ollama', wanted: wantedPaths(v.items) };

  let state = checked.state;

  /** Removes `step.removes` that the preview also listed; any other path stays owned by `key` (never unowned). */
  const removeAsPreviewed = async (item: SyncItem, step: ItemStep, sha256: string): Promise<ViewState> => {
    noteHanded(step);
    const previewed = new Set(item.removes);
    const pass = step.removes.filter((p) => previewed.has(p));
    const withheld = step.removes.filter((p) => !previewed.has(p));
    for (const p of withheld) out.warnings.push(`${p}: not in the previewed removals; kept and still owned`);
    if (pass.length > 0) {
      out.removedPaths.push(...(await driver.remove(pass, ctx, sha256)));
      await markGone(pass);
    }
    const next = step.state;
    if (withheld.length > 0) {
      const kept = next.owned[item.key];
      next.owned[item.key] = { paths: pySort(new Set([...(kept?.paths ?? []), ...withheld])), sha256: kept?.sha256 ?? sha256 };
    }
    return next;
  };

  /** Paths a prune/update kept for a key that did not own them yet (its own create/adopt step is to take them). */
  const handedTo = new Map<string, string[]>();
  const noteHanded = (step: ItemStep): void => {
    for (const k of step.keepsShared) {
      const taker = k.owners[0]!;
      if (opts.wanted.get(k.path)?.key === taker && step.state.owned[taker] === undefined) {
        handedTo.set(taker, [...(handedTo.get(taker) ?? []), k.path]);
      }
    }
  };
  const warnOrphans = (key: string): void => {
    for (const p of handedTo.get(key) ?? []) {
      if (!Object.values(state.owned).some((o) => o.paths.includes(p))) out.warnings.push(`${p}: kept but no longer owned; next sync will re-check`);
    }
  };

  /**
   * create's SkipEntry: nothing written, no state change. CreateIncomplete: own what was written, report, go on.
   * For an update (`prev` given), the previous sha256 is kept until the new model is actually named
   * on disk (for Ollama: until the hf.co manifest was written), so the next plan still sees the entry as stale and
   * retries the update instead of reporting it `foreign` for ever.
   */
  const tryCreate = async (item: SyncItem, d: Desired, prev?: OwnedEntry): Promise<string[] | null> => {
    try {
      const created = await driver.create(d, ctx, prev);
      out.createdPaths.push(...created);
      return created;
    } catch (e) {
      if (e instanceof SkipEntry) {
        out.skippedEntries.push({ key: item.key, reason: e.message });
        warnOrphans(item.key);
        return null;
      }
      if (e instanceof CreateIncomplete) {
        state = applyItemToState(state, { key: item.key, action: 'create', desired: d }, e.written, opts).state;
        if (prev !== undefined && !(d.ollama !== undefined && e.written.includes(d.ollama.manifestPath))) {
          state.owned[item.key]!.sha256 = prev.sha256;
        }
        out.createdPaths.push(...e.written);
        out.skippedEntries.push({ key: item.key, reason: `failed after a partial write: ${e.message}`, partialWrite: true });
        warnOrphans(item.key);
        return null;
      }
      throw e;
    }
  };

  const applyOne = async (item: SyncItem): Promise<boolean> => {
    const prev = state.owned[item.key];
    switch (item.action) {
      case 'prune': {
        if (prev === undefined) return false;
        state = await removeAsPreviewed(item, applyItemToState(state, item, undefined, opts), prev.sha256);
        return true;
      }
      case 'tombstone':
        state = applyItemToState(state, item, undefined, { ...opts, tombstoneAt: localIsoSeconds(deps.now()) }).state;
        return true;
      case 'adopt':
        state = applyItemToState(state, needDesired(item), undefined, opts).state;
        return true;
      case 'create': {
        const created = await tryCreate(item, needDesired(item).desired);
        if (created === null) return false;
        state = applyItemToState(state, item, created, opts).state;
        return true;
      }
      case 'update': {
        const d = needDesired(item).desired;
        if (prev === undefined) throw new Error(`${item.key}: update of a key that is not owned`);
        // Nothing is removed before create: an owned alias is overwritten in create's write phase.
        const before = state;
        const created = await tryCreate(item, d, prev);
        if (created === null) return false;
        // Until the old paths are removed, own both (a failing remove then leaves nothing unowned).
        state = applyItemToState(before, { key: item.key, action: 'create', desired: d }, created, opts).state;
        state = await removeAsPreviewed(item, applyItemToState(before, item, created, opts), prev.sha256);
        return true;
      }
      default:
        return false;   // skip, noop, foreign
    }
  };

  const byKey = new Map(v.items.map((i) => [i.key, i]));
  const ordered = applyOrder(v.items).map((r) => byKey.get(r.key)!);
  const messages: string[] = [];
  for (const [idx, item] of ordered.entries()) {
    try {
      if (await applyOne(item)) out.applied.push({ key: item.key, action: item.action });
    } catch (e) {
      out.status = 'aborted';
      messages.push(`${tag} aborted: ${errText(e)}`);
      for (const rest of ordered.slice(idx + 1)) {
        if (CHANGES.has(rest.action)) out.warnings.push(`${rest.key}: ${rest.action} not applied`);
      }
      break;
    }
  }

  // Saved on success and after an abort alike (the CLI saves after every executed apply, even with no change).
  try {
    await viewFs(deps.safeFs, v.root, fs).writeFileAtomic(v.statePath, serializeState(state), { expect: checked.stateFacts });
  } catch (e) {
    out.status = 'aborted';
    const why = e instanceof SafeFsError && e.code === 'STALE' ? 'the state file changed during sync' : `the state file could not be saved (${errText(e)})`;
    const lost = out.createdPaths.length > 0 ? `; not recorded: ${out.createdPaths.join(', ')}` : '';
    messages.push(`${tag} aborted: ${why}${lost}`);
  }
  if (messages.length > 0) out.message = messages.join('; ');
  return out;
}

function needDesired(item: SyncItem): SyncItem & { desired: Desired } {
  if (item.desired === undefined) throw new Error(`${item.key}: ${item.action} without a desired entry`);
  return item as SyncItem & { desired: Desired };
}

/**
 * Executes a previewed SyncPlan. Nothing happens for a missing hub. An expired plan (V12) is `stale`; a held AppLock
 * (V11) or a hub with no repo folder left skips every view. Views never share state, and one view's failure does
 * not stop the next.
 */
export async function executeSync(plan: SyncPlan, deps: ExecuteSyncDeps): Promise<SyncResult> {
  if (plan.hubMissing) return { planId: plan.id, views: [] };
  const all = (status: ViewSyncStatus, message: (view: ViewName) => string): SyncResult =>
    ({ planId: plan.id, views: plan.views.map((v) => emptyResult(v.view, status, message(v.view))) });
  if (!(deps.now().getTime() < plan.expiresAt)) return all('stale', (view) => `[${view}] preview expired — preview again`);
  try {
    await deps.lock.acquire(deps.now().getTime());
  } catch (e) {
    if (e instanceof ExecError && e.code === 'LOCKED') return all('skipped', (view) => `[${view}] another operation is running`);
    return all('skipped', (view) => `[${view}] the app lock could not be taken: ${errText(e)}`);
  }
  let result: SyncResult;
  try {
    result = (await hubHasRepos(deps.fs, plan.hubRoot))
      ? { planId: plan.id, views: await executeViews(plan, deps) }
      : all('skipped', () => 'hub not found or has no repos');
  } catch (e) {
    await deps.lock.release().catch(() => undefined);
    throw e;
  }
  try {
    await deps.lock.release();
  } catch (e) {
    // Reported, never thrown over the result: the work is done and recorded.
    for (const r of result.views) r.warnings.push(`the app lock could not be released: ${errText(e)}`);
  }
  return result;
}

async function executeViews(plan: SyncPlan, deps: ExecuteSyncDeps): Promise<ViewSyncResult[]> {
  const out: ViewSyncResult[] = [];
  for (const v of plan.views) out.push(await executeView(plan, v, deps));
  return out;
}
