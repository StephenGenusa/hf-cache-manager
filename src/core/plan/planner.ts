import { randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { classifyRepo } from '../classify/classify';
import { compareStrings as cmp, isStrictlyInside } from '../paths';
import { holdRootFor } from '../hold/hold-root';
import { MAX_HELD_VIEW_TOTAL_BYTES, viewHoldCost, viewHoldProblem } from '../hold/view-limits';
import { viewPathProblem } from '../views/view-path';
import type {
  CacheModel, DeleteMode, DeletionPlan, FileFacts, FreedLine, Op, OpRole, PlanPair, Repo, RepoBlob, SafeRoots, Selection,
  SnapshotFile, StoreFile, ViewImpactLine, ViewImpactProvider,
} from '../types';
import { checkClosure, checkShape, closeSelection, PlanError, targetOf, type Closure } from './closure';
import { fingerprintPlan, hashCanonical } from './fingerprint';
import { computeFreed, refLine, storeDoubt } from './freed';
import type { PlanRegistry } from './registry';

/** An `.incomplete` file younger than this counts as an active download. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

export interface CoreCtx { mode: DeleteMode; hubRoot: string; holdRoot: string | null; deletionId: string | null; now: number }

export interface CorePlan {
  ops: Op[];
  freed: { bytes: number; lines: FreedLine[] };
  apparentBytes: number;
  kept: DeletionPlan['kept'];
  warnings: string[];
  /** Every doomed repo blob (64-hex RepoBlobs and 40-hex blobs), sorted; what view impact is computed from. */
  doomedRepoBlobPaths: string[];
}

const VIEW_ROLES = new Set(['view-link', 'view-manifest', 'view-blob']);

/**
 * Execution phase of an op for `purpose: 'delete'` plans only (restore ordering is 's).
 * 0 view roles + write-file, 1 snapshot-link, 2 repo-blob/repo-folder/held-item, 3 store-sweep/store-refs-add,
 * 4 rmdir-empty. A role the table does not name (store-payload) is placed with the store phase.
 */
export function phaseOf(op: Op): 0 | 1 | 2 | 3 | 4 {
  switch (op.kind) {
    case 'write-file': return 0;
    case 'store-sweep':
    case 'store-refs-add': return 3;
    case 'rmdir-empty': return 4;
    case 'unlink':
    case 'hold-rename':
    case 'restore-rename':
      if (VIEW_ROLES.has(op.role)) return 0;
      if (op.role === 'snapshot-link') return 1;
      if (op.role === 'store-payload') return 3;
      return 2;
  }
}

const segments = (p: string): number => p.split(sep).length;
const isRegular = (f: FileFacts): boolean => f.isFile && !f.isSymlink;
const inodeKey = (f: FileFacts): string => `${f.dev}:${f.ino}`;

/** Hub-wide activity: any `.incomplete` anywhere in the hub younger than ACTIVE_WINDOW_MS. */
function hubDownloadActive(model: CacheModel, now: number): boolean {
  return model.repos.some((r) => r.incomplete.some((i) => now - i.mtimeMs < ACTIVE_WINDOW_MS));
}

/** The model with every store's validRefs unknown, so computeFreed keeps every payload (under activity). */
function withUncertainStore(model: CacheModel): CacheModel {
  const store: Record<string, StoreFile> = {};
  for (const [k, s] of Object.entries(model.store)) store[k] = { ...s, validRefs: null };
  return { ...model, store };
}

/** Why a payload that gets no sweep op is kept, mirroring computeFreed's check order. Null when nothing needs saying. */
function storeKeptWarning(
  model: CacheModel, storePath: string, group: RepoBlob[], doomed: ReadonlySet<string>, active: boolean,
): string | null {
  if (group.every((b) => b.dangling)) return null; // no payload left to keep
  const store = Object.hasOwn(model.store, storePath) ? model.store[storePath] : undefined;
  const name = store?.hash ?? basename(storePath);
  const kept = (why: string): string => `store payload ${name} kept: ${why}`;
  if (!store) return kept(`${storePath} is not a known store file`);
  if (group.some((b) => b.dangling)) return kept('a link to it is dangling');
  if (active) return kept('download in progress');
  const doubt = storeDoubt(model, store, doomed);
  if (doubt !== null) return doubt;
  if (store.lockPresent) return kept('it is locked by another process');
  if (store.facts.nlink > 1) return kept('it has other hard links');
  if (!model.storeMarked) return kept('the shared store is not marked as in use');
  if (store.refsRaw === null) return kept('its .refs file is missing or unreadable');
  if (store.validRefs === null) return kept('its .refs file could not be validated');
  return kept('its references are uncertain');
}

/** Bytes of the unique first-hop targets of `files` (64-hex payload size, 40-hex/plain file size, 0 otherwise). */
function targetBytes(repo: Repo, files: SnapshotFile[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const t = targetOf(repo, file);
    if (t.kind === 'other') continue;
    if (t.kind === 'blob') {
      if (seen.has(t.path)) continue;
      seen.add(t.path);
      const rb = file.blobEtag !== null && Object.hasOwn(repo.blobs, file.blobEtag) ? repo.blobs[file.blobEtag]! : null;
      total += rb !== null && rb.path === t.path ? (rb.dangling ? 0 : rb.size) : t.facts.size;
    } else {
      const k = 'p:' + inodeKey(file.facts);
      if (seen.has(k)) continue;
      seen.add(k);
      total += file.facts.size;
    }
  }
  return total;
}

/** Per repo, in classifyRepo group order: unselected groups with remaining files, and selected groups with refused files. */
function keptOf(c: Closure): DeletionPlan['kept'] {
  const out: DeletionPlan['kept'] = [];
  const selected = new Set(c.selectedGroupKeys);
  const refused = new Set(c.refused.map((r) => r.file.linkPath));
  for (const g of classifyRepo(c.repo).groups) {
    if (selected.has(g.key)) {
      const files = g.files.filter((x) => refused.has(x.linkPath));
      if (files.length > 0) {
        out.push({ repoId: c.repo.id, groupKey: g.key, label: `${g.label} (partly kept)`, bytes: targetBytes(c.repo, files) });
      }
    } else {
      // Invariant (enforced by checkClosure in planCore): no link outside the selection is doomed, except an
      // older-revision link in no group, so no file of an unselected group is: such a group's link to a blob S
      // targets is a blocker, and plain and other targets are doomed only when selected.
      out.push({ repoId: c.repo.id, groupKey: g.key, label: g.label, bytes: targetBytes(c.repo, g.files) });
    }
  }
  return out;
}

/**
 * Whole-repo guard: the enumeration must be a tree of real directories rooted at the repo folder, each path
 * listed once. A path whose parent is not a scanned real directory (e.g. reached through a symlinked snapshots/) could
 * alias an entry outside the folder or another listed path, so planning refuses rather than emit an op for it.
 */
function assertWholeTree(c: Closure): void {
  const repo = c.repo;
  const realDirs = new Set([repo.folder, ...repo.snapshotDirs, ...repo.otherDirs]);
  const seen = new Set<string>([repo.folder]);
  const check = (p: string): void => {
    if (!realDirs.has(dirname(p))) {
      throw new Error(`planCore: ${p}: its parent ${dirname(p)} is not a real directory of the repo folder ${repo.folder}`);
    }
    if (seen.has(p)) throw new Error(`planCore: ${p} is listed twice in ${repo.id}`);
    seen.add(p);
  };
  for (const d of [...repo.snapshotDirs, ...repo.otherDirs]) check(d);
  for (const p of [...c.links.map((l) => l.linkPath), ...c.blobs.map((b) => b.path), ...c.others.map((o) => o.path)]) check(p);
}

/** Where hold mode puts things: `<holdRoot>/<deletionId>/...`. Null in permanent mode. */
interface HoldTarget { holdRoot: string; deletionId: string; dir: string }

/**
 * Validates the hold inputs of a hold-mode ctx. The deletion id must be one plain path segment, so that every dest
 * lies inside `<holdRoot>/<deletionId>`; the hold root must be absolute.
 */
function holdTargetOf(ctx: CoreCtx): HoldTarget | null {
  if (ctx.mode !== 'hold') return null;
  const { holdRoot, deletionId } = ctx;
  if (!holdRoot || !deletionId) throw new Error('hold mode needs holdRoot and deletionId');
  if (!isAbsolute(holdRoot)) throw new Error(`planCore: holdRoot ${holdRoot} is not an absolute path`);
  if (deletionId === '.' || deletionId === '..' || /[\\/]/.test(deletionId) || deletionId.includes('\0')) {
    throw new Error(`planCore: deletionId ${JSON.stringify(deletionId)} is not a single plain path segment`);
  }
  return { holdRoot, deletionId, dir: join(holdRoot, deletionId) };
}

/** `<holdRoot>/<deletionId>/<folderName>/<p relative to folder>` for `p` equal to or strictly inside `folder`. */
function heldPathOf(hold: HoldTarget, folder: string, p: string): string {
  if (p !== folder && !isStrictlyInside(p, folder)) throw new Error(`planCore: ${p} is not inside its repo folder ${folder}`);
  const dest = join(hold.dir, basename(folder), relative(folder, p));
  if (!isStrictlyInside(dest, hold.dir)) throw new Error(`planCore: hold destination ${dest} is not inside ${hold.dir}`);
  return dest;
}

/** holdRoot-relative POSIX `<deletionId>/store/<xx>/<hash>` for a store payload at `<hub>/blobs/<xx>/<hash>`. */
function storeHoldDestOf(hold: HoldTarget, hubRoot: string, store: StoreFile): string {
  const xx = basename(dirname(store.path));
  if (dirname(dirname(store.path)) !== join(hubRoot, 'blobs') || basename(store.path) !== store.hash ||
      store.hash.length < 3 || xx !== store.hash.slice(0, 2)) {
    throw new Error(`planCore: store payload ${store.path} is not at <hub>/blobs/<xx>/<hash>`);
  }
  return posix.join(hold.deletionId, 'store', xx, store.hash);
}

/**
 * The hub ops of a delete plan (no view ops), in execution order: phase-major across repos; within
 * phases 1–2 repos in selection order and paths sorted; store sweeps by store path; rmdir-empty deepest first overall.
 * Store sweeps follow the sweep rules and are emitted only where computeFreed (which applies storeDoubt) allows: payload
 * 'delete' when the payload is freed, 'keep' when other valid refs remain; otherwise no op, 0 bytes and a warning.
 * A whole-repo closure unlinks every snapshot entry, repo blob and other file of the folder (role repo-blob
 * directly in `<folder>/blobs`, else repo-folder), then rmdir-empties every real directory and finally the folder.
 *
 * Hold mode moves instead of deleting, and only by rename: each unlink becomes a hold-rename to
 * `<holdRoot>/<deletionId>/<folderName>/<path in folder>`; a whole repo is one hold-rename of the folder itself (role
 * repo-folder, expect = folderFacts) with no rmdir-empty; a payload sweep that would delete the payload holds it at
 * `<deletionId>/store/<xx>/<hash>` (holdRoot-relative POSIX). rmdir-empty of emptied snapshot dirs stays in the hub.
 * freed, apparentBytes, kept, warnings and doomedRepoBlobPaths are identical in both modes.
 */
export function planCore(model: CacheModel, selection: Selection, ctx: CoreCtx): CorePlan {
  if (ctx.hubRoot !== model.hubRoot) throw new Error('planCore: ctx.hubRoot does not match the scanned hub');
  const hold = holdTargetOf(ctx);
  const closures = closeSelection(model, selection);

  const phase1: Op[] = [];
  const phase2: Op[] = [];
  const dirs: string[] = [];
  const warnings: string[] = [];
  const kept: DeletionPlan['kept'] = [];
  const doomedBlobs: string[] = [];
  const doomedOthers: string[] = [];
  const storeGroups = new Map<string, RepoBlob[]>();
  const regularDoomed = new Map<string, number>(); // inode → size
  const addRegular = (f: FileFacts): void => {
    if (isRegular(f)) regularDoomed.set(inodeKey(f), f.size);
  };

  for (const c of closures) {
    const repo = c.repo;
    /** Unlink in permanent mode; in hold mode a rename keeping the folder-relative layout under the deletion dir. */
    const removeOp = (path: string, expect: FileFacts, role: OpRole): Op =>
      hold === null
        ? { kind: 'unlink', path, expect, role }
        : { kind: 'hold-rename', path, dest: heldPathOf(hold, repo.folder, path), expect, role };
    const byPath = new Map(Object.values(repo.blobs).map((b) => [b.path, b]));
    const noteStore = (path: string): void => {
      const rb = byPath.get(path);
      if (rb !== undefined && rb.storePath !== null) {
        const g = storeGroups.get(rb.storePath) ?? [];
        g.push(rb);
        storeGroups.set(rb.storePath, g);
      }
    };
    if (c.whole) {
      // Every entry under the folder, then the folder itself, as non-recursive unlink and rmdir-empty ops
      assertWholeTree(c);
      const wholeLinks: Op[] = [];
      const wholeOps: Op[] = [];
      for (const l of c.links) {
        wholeLinks.push({ kind: 'unlink', path: l.linkPath, expect: l.facts, role: 'snapshot-link' });
        doomedOthers.push(l.linkPath);
        addRegular(l.facts);
      }
      const blobsDir = join(repo.folder, 'blobs');
      const blobPaths = new Set(c.blobs.map((b) => b.path));
      for (const e of [...c.blobs, ...c.others].sort((a, b) => cmp(a.path, b.path))) {
        wholeOps.push({ kind: 'unlink', path: e.path, expect: e.facts, role: dirname(e.path) === blobsDir ? 'repo-blob' : 'repo-folder' });
        (blobPaths.has(e.path) ? doomedBlobs : doomedOthers).push(e.path);
        addRegular(e.facts);
        noteStore(e.path);
      }
      if (hold === null) {
        phase1.push(...wholeLinks);
        phase2.push(...wholeOps);
        dirs.push(...repo.snapshotDirs, ...repo.otherDirs, repo.folder); // the folder is the shallowest, so it sorts last
      } else {
        // A whole-repo hold is one rename of the folder (a real directory), which carries every entry
        const ff = repo.folderFacts;
        if (!ff.isDirectory || ff.isSymlink) throw new Error(`planCore: repo folder ${repo.folder} is not a real directory`);
        phase2.push(removeOp(repo.folder, ff, 'repo-folder'));
      }
      continue;
    }
    checkClosure(c);   // No link outside the selection is doomed
    const doomedLinks = new Set(c.links.map((l) => l.linkPath));
    for (const l of c.links) {
      phase1.push(removeOp(l.linkPath, l.facts, 'snapshot-link'));
      doomedOthers.push(l.linkPath);
      addRegular(l.facts);
    }
    for (const b of c.blobs) {
      phase2.push(removeOp(b.path, b.facts, 'repo-blob'));
      doomedBlobs.push(b.path);
      addRegular(b.facts);
      noteStore(b.path);
    }
    // huggingface_hub scans only refs/main, so the main snapshot root is the one ref target we can protect: keep it
    const mainRoot = repo.mainCommit === null ? null : join(repo.folder, 'snapshots', repo.mainCommit);
    // Only dirs that lose at least one file and keep none
    for (const d of repo.snapshotDirs) {
      if (d === mainRoot) continue;
      const under = repo.files.filter((x) => x.linkPath.startsWith(d + sep));
      if (under.length > 0 && under.every((x) => doomedLinks.has(x.linkPath))) dirs.push(d);
    }
    for (const r of c.refused) {
      const where = r.groupLabel === null ? r.snapshot! : `unselected group ${r.groupLabel}`;
      const also = r.alsoIn === undefined ? '' : `; also in ${r.alsoIn.join(', ')}`;
      warnings.push(`${r.file.relpath} kept: same content as ${r.sameAs} in ${where}${also}`);
    }
    if (repo.files.length > 0 && repo.files.every((x) => doomedLinks.has(x.linkPath))) {
      warnings.push(`${repo.id}: every file is selected; use Delete entire repo to remove the whole repo folder`);
    }
    kept.push(...keptOf(c));
  }

  const active = hubDownloadActive(model, ctx.now);
  const doomedRepoBlobPaths = [...new Set(doomedBlobs)].sort(cmp);
  const freed = computeFreed(active ? withUncertainStore(model) : model, doomedRepoBlobPaths, [...new Set(doomedOthers)].sort(cmp));
  const lineAt = new Map(freed.lines.map((l) => [l.path, l]));
  const doomed = new Set([...doomedRepoBlobPaths, ...doomedOthers]);

  const phase3: Op[] = [];
  let payloadBytes = 0;
  for (const storePath of [...storeGroups.keys()].sort(cmp)) {
    const group = storeGroups.get(storePath)!;
    const line = lineAt.get(storePath);
    const store = Object.hasOwn(model.store, storePath) ? model.store[storePath] : undefined;
    const payload = line?.reason === 'store-unreferenced' ? 'delete' : line?.reason === 'store-shared' ? 'keep' : null;
    if (store === undefined || payload === null || store.refsRaw === null) {
      const w = storeKeptWarning(model, storePath, group, doomed, active);
      if (w !== null) warnings.push(w);
      continue;
    }
    const removeRefs = [...new Set(group.map((b) => refLine(model.hubRoot, b.path)))].sort(cmp);
    const base = { kind: 'store-sweep' as const, storePath, refsPath: store.refsPath, removeRefs, expectRefsRaw: store.refsRaw };
    phase3.push(payload === 'delete' && hold !== null
      ? { ...base, payload: 'hold', holdDest: storeHoldDestOf(hold, model.hubRoot, store), expect: store.facts }
      : { ...base, payload, expect: store.facts });
    if (payload === 'delete' && !regularDoomed.has(inodeKey(store.facts))) payloadBytes += store.facts.size;
  }

  const phase4: Op[] = [...new Set(dirs)]
    .sort((a, b) => segments(b) - segments(a) || cmp(a, b))
    .map((path) => ({ kind: 'rmdir-empty' as const, path }));

  const apparentBytes = [...regularDoomed.values()].reduce((s, n) => s + n, 0) + payloadBytes;
  return { ops: [...phase1, ...phase2, ...phase3, ...phase4], freed, apparentBytes, kept, warnings, doomedRepoBlobPaths };
}

/** Why the PlanPair offers no hold plan (may substitute holdAvailability's reason; outside the fingerprint). */
export const HOLD_UNAVAILABLE = 'Recently Deleted is not available for this cache';

/** Plans expire this long after creation. */
export const PLAN_TTL_MS = 10 * 60_000;

/**
 * Refuses with PlanError ACTIVE_DOWNLOAD when any selected repo, whole or partial and
 * in either mode, has an `.incomplete` file younger than ACTIVE_WINDOW_MS (a future, NaN or missing mtime counts as
 * active). The selection's shape is checked first (INVALID_SELECTION for malformed IPC input). Besides
 * `repo.incomplete` it also looks at every other file of the repo whose name ends in `.incomplete` (fails closed).
 * An unknown repo id gives UNKNOWN_REPO. planDeletion calls it before building any plan; the executor calls it again
 * on its rescan before re-deriving the plan.
 */
export function assertNoActiveDownload(model: CacheModel, selection: Selection, now: number): void {
  for (const sel of checkShape(selection)) {
    const repo = model.repos.find((r) => r.id === sel.repoId);
    if (!repo) throw new PlanError('UNKNOWN_REPO', `${sel.repoId} is not in the cache`);
    const partials = [
      ...repo.incomplete.map((i) => ({ path: i.path, mtimeMs: i.mtimeMs })),
      ...repo.otherFiles.filter((o) => basename(o.path).endsWith('.incomplete')).map((o) => ({ path: o.path, mtimeMs: o.facts.mtimeMs })),
    ];
    // Fails closed: a NaN or missing mtime (comparison false) counts as active
    const active = partials.find((p) => !(now - p.mtimeMs >= ACTIVE_WINDOW_MS));
    if (active) {
      throw new PlanError('ACTIVE_DOWNLOAD', `${repo.id} has a download in progress (${basename(active.path)}); try again when it finishes`);
    }
  }
}

const VIEW_UNLINK_ROLES: ReadonlySet<OpRole> = new Set<OpRole>(['view-link', 'view-manifest', 'view-blob']);

/**
 * Defensive check of the provider's ops: only `unlink` with a view role, `rmdir-empty`, and `write-file` with role
 * `view-state`, each at a normalized absolute path strictly inside one of `roots.viewRoots` and never at or inside the
 * hub, `roots.holdRoot` or this hub's app folder `<dirname(hub)>/.hf-cache-manager` (whatever roots.holdRoot says).
 * Ordering: no op may follow an rmdir-empty of its own path or of an ancestor, and within each view root rmdir-empty
 * ops are deepest first. Anything else is a provider bug, so planning throws (no plan is better than a wrong one).
 */
function assertViewOps(ops: readonly Op[], roots: SafeRoots): void {
  const removedDirs: string[] = [];
  const lastRmdirDepth = new Map<string, number>(); // view root → depth of its previous rmdir-empty
  for (const op of ops) {
    const fail = (why: string): never => { throw new Error(`planDeletion: view op ${op.kind} ${'path' in op ? op.path : ''}: ${why}`); };
    const kindOk = (op.kind === 'unlink' && VIEW_UNLINK_ROLES.has(op.role)) || op.kind === 'rmdir-empty' ||
      (op.kind === 'write-file' && op.role === 'view-state');
    if (!kindOk) fail('only view unlinks, rmdir-empty and view-state writes may come from a view provider');
    const path = (op as { path: string }).path;
    const problem = viewPathProblem(path, roots.viewRoots, roots);
    if (problem !== null) fail(problem);
    const gone = removedDirs.find((d) => path === d || isStrictlyInside(path, d));
    if (gone !== undefined) fail(`it comes after rmdir-empty of ${gone}`);
    if (op.kind === 'rmdir-empty') {
      const root = roots.viewRoots.find((v) => isStrictlyInside(path, v))!;
      const depth = segments(path);
      const prev = lastRmdirDepth.get(root);
      if (prev !== undefined && depth > prev) fail('rmdir-empty ops of a view are not deepest first');
      lastRmdirDepth.set(root, depth);
      removedDirs.push(path);
    }
  }
}

const VIEW_LABEL: Record<ViewImpactLine['view'], string> = { lmstudio: 'LM Studio', ollama: 'Ollama' };

/**
 * Why no hold plan can be offered for these view ops, or null. Recently Deleted records a view symlink, and a
 * regular view-blob or view-manifest of at most MAX_HELD_VIEW_FILE_BYTES with at most MAX_HELD_VIEW_TOTAL_BYTES in
 * total (manifest.ts decides with the same helpers); anything else would be lost or too big, so the hold is refused
 * here, before the user confirms, rather than when manifestFromPlan runs.
 */
function viewHoldRefusal(ops: Op[], lines: ViewImpactLine[], roots: SafeRoots): string | null {
  let total = 0;
  for (const op of ops) {
    if (op.kind !== 'unlink' || !VIEW_UNLINK_ROLES.has(op.role)) continue;
    const problem = viewHoldProblem(op.role, op.expect);
    total += viewHoldCost(op.role, op.expect);
    if (problem === null && total <= MAX_HELD_VIEW_TOTAL_BYTES) continue;
    const root = roots.viewRoots.find((v) => isStrictlyInside(op.path, v))!; // assertViewOps guarantees one
    const rel = relative(root, op.path).split(sep).join('/');
    const view = lines.find((l) => l.path === rel)?.view;
    const folder = view === undefined ? 'view' : VIEW_LABEL[view];
    if (problem === 'not-a-file') return `Recently Deleted can't hold ${rel} (not a regular file or link in the ${folder} folder) \u2014 use Delete Permanently`;
    if (problem === 'not-a-link') return `Recently Deleted can't hold ${rel} (a regular file in the ${folder} folder, not a link) \u2014 use Delete Permanently`;
    if (problem === 'too-large') return `Recently Deleted can't hold ${rel} (a regular file in the ${folder} folder larger than 1 MiB) \u2014 use Delete Permanently`;
    return `Recently Deleted can't hold this many ${folder} files (over 4 MiB of view data) \u2014 use Delete Permanently`;
  }
  return null;
}

/** A blocked view line never refuses the deletion; it becomes a warning on both plans. */
function blockedWarnings(lines: readonly ViewImpactLine[]): string[] {
  return lines
    .filter((l) => l.action === 'blocked')
    .map((l) => `${VIEW_LABEL[l.view]} view not updated${l.path ? ` (${l.path})` : ''}: ${l.note ?? 'blocked'}`);
}

/**
 * Builds the two plans the review screen offers: "Move to Recently Deleted" (hold) and "Delete
 * Permanently". Order of work: the active-download check over the selected repos; both cores; one
 * `views.impactFor(model, doomedRepoBlobPaths)`; view ops (validated) prepended to both plans; fingerprints last.
 * Both plans share selection, freed, apparentBytes, kept, viewImpact, warnings and contentDigest (the permanent-mode
 * hub-op enumeration the executor revalidates against).
 *
 * Hold is offered only when `roots.holdRoot` is this hub's canonical Recently Deleted root (holdRootFor); otherwise
 * `hold` is null with HOLD_UNAVAILABLE and the permanent plan is still returned.
 * With `registry`, both plans are registered as a linked pair (taking either uses up both); without it (preview)
 * nothing is registered.
 *
 * Errors: PlanError (UNKNOWN_REPO, UNKNOWN_GROUP, LOCKED_GROUP, INVALID_SELECTION, ACTIVE_DOWNLOAD) for refusals the
 * user can act on. Any other Error is an internal invariant or provider failure (e.g. planCore's whole-tree guard, a
 * provider op outside a view root, roots.hubRoot not the scanned hub); it propagates unchanged as a rejection, and the
 * IPC layer maps every non-PlanError to its generic plan failure. Nothing is registered when it rejects.
 */
export async function planDeletion(args: {
  model: CacheModel; selection: Selection; roots: SafeRoots; views: ViewImpactProvider; now: number; registry?: PlanRegistry;
}): Promise<PlanPair> {
  const { model, roots, views, now } = args;
  checkShape(args.selection); // INVALID_SELECTION for malformed IPC input, before anything else reads it
  const selection = structuredClone(args.selection);
  if (roots.hubRoot !== model.hubRoot) throw new Error('planDeletion: roots.hubRoot is not the scanned hub (model.hubRoot)');

  assertNoActiveDownload(model, selection, now);

  const hubRoot = model.hubRoot; // realpath'd by the scanner; planCore requires exactly this
  const permCore = planCore(model, selection, { mode: 'permanent', hubRoot, holdRoot: null, deletionId: null, now });
  const holdRoot = roots.holdRoot !== null && roots.holdRoot === holdRootFor(hubRoot) ? roots.holdRoot : null;
  const deletionId = holdRoot === null ? null
    : `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const holdCore = holdRoot === null ? null : planCore(model, selection, { mode: 'hold', hubRoot, holdRoot, deletionId, now });
  // Invariant: planCore derives doomedRepoBlobPaths, freed, apparentBytes, kept and warnings without reading ctx.mode,
  // so both cores agree on them; the plans below share permCore's.

  const impact = await views.impactFor(model, [...permCore.doomedRepoBlobPaths]);
  assertViewOps(impact.ops, roots);
  const viewImpact = structuredClone(impact.lines);
  const warnings = [...permCore.warnings, ...blockedWarnings(impact.lines)];

  // The enumeration every hold revalidation compares against, even when its ops are one folder rename
  const contentDigest = hashCanonical(permCore.ops);
  const build = (mode: DeleteMode, core: CorePlan): DeletionPlan => {
    const body: Omit<DeletionPlan, 'id' | 'fingerprint'> = {
      mode,
      purpose: 'delete',
      hubRoot,
      holdRoot: mode === 'hold' ? holdRoot : null,
      deletionId: mode === 'hold' ? deletionId : null,
      createdAt: now,
      expiresAt: now + PLAN_TTL_MS,
      selection: structuredClone(selection),
      ops: [...structuredClone(impact.ops), ...core.ops],
      freed: structuredClone(permCore.freed),
      apparentBytes: permCore.apparentBytes,
      kept: structuredClone(permCore.kept),
      viewImpact: structuredClone(viewImpact),
      warnings: [...warnings],
      confirmPhrase: mode === 'hold' ? null
        : selection.repos.length === 1 ? selection.repos[0]!.repoId : `delete ${selection.repos.length} repos`,
      contentDigest,
    };
    return { id: randomUUID(), fingerprint: fingerprintPlan(body), ...body };
  };

  const permanent = build('permanent', permCore);
  const viewRefusal = viewHoldRefusal(impact.ops, impact.lines, roots);
  const hold = holdCore === null || viewRefusal !== null ? null : build('hold', holdCore);
  const holdUnavailableReason = hold !== null ? null : holdCore === null ? HOLD_UNAVAILABLE : viewRefusal;
  const pair: PlanPair = { hold, holdUnavailableReason, permanent };
  args.registry?.putPair(pair);
  return pair;
}
