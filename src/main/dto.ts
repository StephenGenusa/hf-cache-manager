// Core results → the DTOs the renderer sees. Pure mapping over a scanned model and a plan; the only
// work beyond copying is the planner run behind each group's reclaimable figure. Every path the user sees goes through
// displayPath, so no full commit or blob hash reaches the primary UI.
import { basename, dirname, join, relative, sep } from 'node:path';
import { currentFiles, fileBytes } from '../core/classify/classify';
import { STATE_FILE } from '../core/compat/state';
import { compareStrings, isStrictlyInside } from '../core/paths';
import { STALE_MESSAGE } from '../core/exec/errors';
import type { HeldDeletion } from '../core/hold/held';
import type { SyncItem, SyncPlan, SyncResult, ViewSyncPlan, ViewSyncResult } from '../core/sync/sync';
import { planCore } from '../core/plan/planner';
import { parseRepoFolder } from '../core/scan/scanner';
import type {
  CacheModel, DeletionPlan, ExecResult, FreedLine, Group, Op, OpRole, Repo, RepoBlob, RepoKind, RepoView, UsageIndex, ViewImpactLine, ViewName,
} from '../core/types';
import type {
  EmptyPlanDTO, ExecResultDTO, FileRowDTO, GroupDTO, HeldDeletionDTO, KeptFileDTO, OpRowDTO, PlanDTO, RepoDetailDTO, RepoSummaryDTO, SyncEntryDTO, SyncPlanDTO, SyncResultDTO,
  SyncViewDTO, SyncViewResultDTO, ViewEntryKind, ViewLineDTO,
} from '../shared/api';

export interface DtoContext {
  model: CacheModel;
  home: string;
  /** Realpaths of the existing configured view roots (the roots view ops are under). */
  viewRoots: Record<ViewName, string | null>;
  /** Views with a root in config.toml. */
  configuredViews: ViewName[];
  /** The Recently Deleted root in use, or null when hold is unavailable. */
  holdRoot: string | null;
}

/** The warning on a superseded group. */
export const SUPERSEDED_WARNING =
  'An update may be in progress or incomplete: some of these files are the only copy of files missing from the current revision.';

export const shortHash = (h: string): string => h.slice(0, 4) + '…' + h.slice(-2);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const BADGE: Record<Exclude<RepoKind, 'gguf' | 'transformers'>, string> = {
  diffusers: 'Diffusers pipeline', adapter: 'LoRA adapter', 'single-file': 'Single-file checkpoint', diffusion: 'Diffusion / ComfyUI',
  component: 'VAE / component', dataset: 'Dataset', space: 'Space', unknown: 'Unknown',
};

export function badgeFor(view: RepoView): string {
  const kind = view.kinds[0] ?? 'unknown';
  if (kind === 'gguf') return `GGUF · ${plural(view.groups.filter((g) => g.kind === 'quant').length, 'quant')}`;
  if (kind === 'transformers') {
    const shards = view.groups.find((g) => g.kind === 'weights')?.shards?.expected ?? 0;
    return shards > 1 ? `Safetensors · ${shards} shards` : 'Transformers';
  }
  return BADGE[kind];
}

/** Every LM Studio path and Ollama tag using any of these etags, each once, sorted. */
function usedBy(etags: Iterable<string>, usage: UsageIndex): { lmstudio: string[]; ollama: string[] } {
  const lm = new Set<string>();
  const ol = new Set<string>();
  for (const e of etags) {
    const u = Object.hasOwn(usage, e) ? usage[e] : undefined;
    u?.lmstudio.forEach((p) => lm.add(p));
    u?.ollama.forEach((t) => ol.add(t));
  }
  return { lmstudio: [...lm].sort(compareStrings), ollama: [...ol].sort(compareStrings) };
}

const maxOr = (xs: number[], fallback: number): number => (xs.length === 0 ? fallback : Math.max(...xs));

/** `ambiguous`: another repo of a different type has the same id; the caller works that out over the model. */
export function toRepoSummary(repo: Repo, view: RepoView, usage: UsageIndex, ambiguous = false): RepoSummaryDTO {
  const u = usedBy(Object.keys(repo.blobs), usage);
  return {
    repoId: repo.id, type: repo.type, kinds: [...view.kinds], badge: badgeFor(view), apparentBytes: view.apparentBytes,
    lastModifiedMs: maxOr([...repo.files.map((f) => f.facts.mtimeMs), ...Object.values(repo.blobs).map((b) => b.facts.mtimeMs)],
      repo.folderFacts.mtimeMs),
    usage: { lmstudio: u.lmstudio.length, ollama: u.ollama.length }, partialDownloads: view.partialDownloads, ambiguous,
  };
}

/**
 * A superseded group may hold the only copy of a file when a download is incomplete, or when
 * one of its relpaths is missing from the current revision (an abandoned update leaves no `.incomplete`).
 */
function supersededWarning(repo: Repo): string | null {
  const current = new Set(currentFiles(repo).map((f) => f.relpath));
  const missing = repo.files.some((f) => !f.isCurrent && !current.has(f.relpath));
  return repo.incomplete.length > 0 || missing ? SUPERSEDED_WARNING : null;
}

/**
 * What deleting this group alone would free: the real planner (its closure keeps a blob that an unselected current
 * file shares), so the figure matches what a selection of this group plans. A locked group is unlocked
 * for this figure only. null (unknown, never a guessed 0) when the repo id is ambiguous (the planner would resolve
 * another repo) or planning fails.
 */
function reclaimable(model: CacheModel, repo: Repo, g: Group, now: number): number | null {
  if (model.repos.find((r) => r.id === repo.id) !== repo) return null;
  try {
    return planCore(model, { repos: [{ repoId: repo.id, whole: false, groupKeys: [g.key], unlockComponents: true }] },
      { mode: 'permanent', hubRoot: model.hubRoot, holdRoot: null, deletionId: null, now }).freed.bytes;
  } catch {
    return null;
  }
}

function toGroup(model: CacheModel, repo: Repo, g: Group, usage: UsageIndex, now: number): GroupDTO {
  return {
    key: g.key, kind: g.kind, label: g.label, fileCount: g.files.length, apparentBytes: g.apparentBytes,
    reclaimableBytes: reclaimable(model, repo, g, now), shards: g.shards ? { ...g.shards } : null, locked: g.locked,
    usedBy: usedBy(g.files.flatMap((f) => (f.blobEtag === null ? [] : [f.blobEtag])), usage),
    files: g.files.map((f) => ({
      relpath: f.relpath, commitShort: f.commit.slice(0, 7), current: f.isCurrent, bytes: fileBytes(repo, f),
      plainFile: f.facts.isFile && !f.facts.isSymlink,
    })),
    warning: g.kind === 'superseded' ? supersededWarning(repo) : null,
  };
}

export function toRepoDetail(model: CacheModel, repo: Repo, view: RepoView, usage: UsageIndex, now: number = Date.now()): RepoDetailDTO {
  const current = currentFiles(repo);
  const revision = current[0]?.commit ?? repo.mainCommit ?? repo.snapshots[0] ?? null;
  const blobMtime = (etag: string | null): number[] => {
    const b = etag === null ? undefined : repo.blobs[etag];
    return b === undefined ? [] : [b.facts.mtimeMs];
  };
  const groups = view.groups.map((g) => toGroup(model, repo, g, usage, now));
  return {
    repoId: repo.id, type: repo.type, kinds: [...view.kinds], kindLabel: badgeFor(view),
    revisionShort: revision === null ? null : revision.slice(0, 7),
    downloadedAtMs: current.length === 0 ? null : maxOr(current.flatMap((f) => [f.facts.mtimeMs, ...blobMtime(f.blobEtag)]), 0),
    apparentBytes: view.apparentBytes, hasLockedGroups: groups.some((g) => g.locked), groups,
  };
}

export function reasonText(line: FreedLine): string {
  const shared = line.sharedWith ?? [];
  switch (line.reason) {
    case 'only-link': return 'only link';
    case 'hardlink-others-remain':
      return shared.length === 0 ? 'hardlink, other links remain — not freed'
        : `hardlink, ${plural(shared.length, 'other link')} — not freed`;
    case 'hardlink-all-planned': return 'hardlink, every link removed';
    case 'store-shared': return `shared with ${shared.length === 0 ? 'other repos' : shared.join(', ')} — not freed`;
    case 'store-unreferenced': return 'shared store, no other references';
    case 'store-uncertain': return 'shared store state uncertain — kept, counted as 0';
    case 'link-only': return 'link only — no data freed';
    case 'plain-file': return 'plain file';
    case 'special-file': return 'special file (fifo/socket/device) — no data freed';
  }
}

export function actionText(line: ViewImpactLine): string {
  switch (line.action) {
    case 'remove': return 'will be removed';
    case 'keep-shared': return 'kept — another entry still uses it';
    case 'state-update': return 'sync state updated';
    case 'blocked': return `blocked — ${line.note ?? 'not updated'}`;
    case 'foreign': return `left in place — ${line.note ?? 'not ours'}`;
  }
}

const HEX40 = /^[0-9a-f]{40}$/;
const BLOB_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STORE_NAME = /^([0-9a-f]{64})(\.refs)?$/;
const OLLAMA_BLOB = /^sha256-([0-9a-f]{64})$/;

/**
 * Shortens commit folders (snapshots/<40hex> → 7 chars), repo blob names and shared-store hashes (shortHash), and
 * Ollama blob names (sha256-<64hex> → sha256-<12hex>…).
 */
function shorten(parts: string[]): string[] {
  return parts.map((p, i) => {
    const prev = parts[i - 1];
    const ollama = OLLAMA_BLOB.exec(p);
    if (ollama !== null) return `sha256-${ollama[1]!.slice(0, 12)}…`;
    if (prev === 'snapshots' && HEX40.test(p)) return p.slice(0, 7);
    if (prev === 'blobs' && BLOB_NAME.test(p)) return shortHash(p);
    const store = STORE_NAME.exec(p);
    if (store !== null && prev !== undefined && prev === store[1]!.slice(0, 2)) return shortHash(store[1]!) + (store[2] ?? '');
    return p;
  });
}

const posixRel = (root: string, p: string): string[] => relative(root, p).split(sep);
const within = (p: string, root: string): boolean => p === root || isStrictlyInside(p, root);

function tilde(p: string, home: string): string {
  if (p === home) return '~';
  return isStrictlyInside(p, home) ? ['~', ...posixRel(home, p)].join('/') : p;
}

/** The configured view whose root holds `p`, longest root first. */
function viewAt(p: string, ctx: DtoContext): { view: ViewName; root: string } | null {
  let best: { view: ViewName; root: string } | null = null;
  for (const view of ['lmstudio', 'ollama'] as const) {
    const root = ctx.viewRoots[view];
    if (root !== null && within(p, root) && (best === null || root.length > best.root.length)) best = { view, root };
  }
  return best;
}

/**
 * How an absolute path is shown. Under the hold root: `Recently Deleted/<deletionId>/…`. In the hub: the shared store as
 * `shared store/…`, a repo folder as `{repoId, path inside the folder}` (`(repo folder)` for the folder itself), named
 * from the folder so a folder the model no longer has (a restore) still gets its repo id. In a view: the view root, then
 * the view path. Anything else: `~` for the home folder only.
 */
export function displayPath(abs: string, ctx: DtoContext): { repoId: string | null; text: string } {
  if (ctx.holdRoot !== null && within(abs, ctx.holdRoot)) {
    const parts = abs === ctx.holdRoot ? [] : posixRel(ctx.holdRoot, abs);
    const folder = parts[1] === undefined ? null : parseRepoFolder(parts[1]);
    return { repoId: folder?.id ?? null, text: ['Recently Deleted', ...shorten(parts)].join('/') };
  }
  const hub = ctx.model.hubRoot;
  if (isStrictlyInside(abs, hub)) {
    const parts = posixRel(hub, abs);
    if (parts[0] === 'blobs') return { repoId: null, text: ['shared store', ...shorten(parts.slice(1))].join('/') };
    const folder = parseRepoFolder(parts[0]!);
    if (folder !== null) {
      return { repoId: folder.id, text: parts.length === 1 ? '(repo folder)' : shorten(parts.slice(1)).join('/') };
    }
  }
  const v = viewAt(abs, ctx);
  if (v !== null) {
    const root = tilde(v.root, ctx.home);
    return { repoId: null, text: abs === v.root ? root : [root, ...shorten(posixRel(v.root, abs))].join('/') };
  }
  return { repoId: null, text: tilde(abs, ctx.home) };
}

/** The repo blob at `p` (`<folder>/blobs/<etag>`), if the model has one. */
function repoBlobAt(p: string, folders: Map<string, Repo>): { repo: Repo; blob: RepoBlob } | null {
  const repo = folders.get(dirname(dirname(p)));
  const blob = repo === undefined || !Object.hasOwn(repo.blobs, basename(p)) ? undefined : repo.blobs[basename(p)];
  return repo !== undefined && blob !== undefined && blob.path === p ? { repo, blob } : null;
}

function fileRow(line: FreedLine, ctx: DtoContext, folders: Map<string, Repo>): FileRowDTO {
  const d = displayPath(line.path, ctx);
  const row: FileRowDTO = {
    repoId: d.repoId, displayPath: d.text, otherLinks: 0, blobShort: null, bytes: line.bytes, reason: line.reason, reasonText: reasonText(line),
    fullPath: line.path,
  };
  const at = repoBlobAt(line.path, folders);
  if (at === null) return row;
  // A repo blob is shown by the snapshot file naming it: the first current one, else any (else its own blobs/ path)
  const links = at.repo.files.filter((f) => f.blobEtag === at.blob.etag);
  const first = links.find((f) => f.isCurrent) ?? links[0];
  return {
    ...row, displayPath: first === undefined ? d.text : displayPath(first.linkPath, ctx).text,
    otherLinks: Math.max(0, links.length - 1), blobShort: shortHash(at.blob.etag),
  };
}

/** A restore frees nothing; its rows are what moves back and each `.refs` it re-adds. */
function restoreRows(plan: DeletionPlan, ctx: DtoContext): FileRowDTO[] {
  return plan.ops.flatMap((op): FileRowDTO[] => {
    if (op.kind === 'restore-rename') {
      const d = displayPath(op.dest, ctx);
      return [{ repoId: d.repoId, displayPath: d.text, otherLinks: 0, blobShort: null,
        bytes: op.expect.isFile && !op.expect.isSymlink ? op.expect.size : 0, reason: 'restore-move', reasonText: 'moves back', fullPath: op.dest }];
    }
    if (op.kind === 'store-refs-add') {
      const d = displayPath(op.refsPath, ctx);
      return [{ repoId: d.repoId, displayPath: d.text, otherLinks: 0, blobShort: null, bytes: 0, reason: 'restore-refs', reasonText: '.refs re-added',
        fullPath: op.refsPath }];
    }
    return [];
  });
}

const opPath = (op: Op): string => (op.kind === 'store-sweep' ? op.storePath : op.kind === 'store-refs-add' ? op.refsPath : op.path);

function opRow(op: Op, ctx: DtoContext): OpRowDTO {
  return { kind: op.kind, role: 'role' in op ? op.role : null, displayPath: displayPath(opPath(op), ctx).text, fullPath: opPath(op) };
}

const ENTRY_KIND: Partial<Record<OpRole, ViewEntryKind>> = { 'view-link': 'symlink', 'view-manifest': 'manifest', 'view-blob': 'blob' };

/**
 * Every state key that owns a removed view path (the impact line names only the first). Read from the
 * view-state write's `before` text; the line's own key when that text is missing or unreadable.
 */
function ownerKeys(plan: DeletionPlan, root: string, rel: string): string | null {
  const write = plan.ops.find((o) => o.kind === 'write-file' && o.role === 'view-state' && o.path === join(root, STATE_FILE));
  if (write === undefined || write.kind !== 'write-file' || write.before === null) return null;
  try {
    const owned = (JSON.parse(write.before) as { owned?: Record<string, { paths?: unknown }> }).owned ?? {};
    const keys = Object.entries(owned).filter(([, o]) => Array.isArray(o.paths) && o.paths.includes(rel)).map(([k]) => k);
    return keys.length === 0 ? null : keys.sort(compareStrings).join(', ');
  } catch {
    return null;
  }
}

function viewLine(l: ViewImpactLine, plan: DeletionPlan, ctx: DtoContext): ViewLineDTO {
  const root = ctx.viewRoots[l.view];
  const abs = root === null ? null : join(root, ...l.path.split('/').filter((s) => s !== ''));
  const op = abs === null ? undefined : plan.ops.find((o) => o.kind === 'unlink' && o.path === abs);
  const entryKind = l.action === 'state-update' ? 'state'
    : l.action === 'remove' && op !== undefined && op.kind === 'unlink' ? ENTRY_KIND[op.role] ?? null : null;
  const key = l.action === 'remove' && root !== null ? ownerKeys(plan, root, l.path) ?? l.key ?? null : l.key ?? null;
  return {
    view: l.view, displayPath: abs === null ? l.path : displayPath(abs, ctx).text, action: l.action, actionText: actionText(l),
    key, note: l.note ?? null, entryKind, fullPath: abs ?? l.path,
  };
}

/** A view folder the plan leaves empty is removed; it is listed with the view's lines. */
function folderLines(plan: DeletionPlan, ctx: DtoContext): ViewLineDTO[] {
  return plan.ops.flatMap((op): ViewLineDTO[] => {
    if (op.kind !== 'rmdir-empty') return [];
    const v = viewAt(op.path, ctx);
    if (v === null) return [];
    return [{ view: v.view, displayPath: displayPath(op.path, ctx).text, action: 'remove', actionText: 'empty folder removed',
      key: null, note: null, entryKind: 'folder', fullPath: op.path }];
  });
}

function titleOf(plan: DeletionPlan, repoIds: string[]): string {
  if (plan.purpose === 'restore') return 'Restore from Recently Deleted';
  if (plan.purpose === 'empty') return 'Empty Recently Deleted';
  return `Review deletion — ${repoIds.length === 1 ? repoIds[0]! : `${repoIds.length} repos`}`;
}

/** The superseded warning travels into the review when a superseded group is selected. */
function supersededSelected(plan: DeletionPlan, model: CacheModel): boolean {
  return (plan.selection?.repos ?? []).some((s) => {
    if (s.whole || !s.groupKeys.some((k) => k.startsWith('superseded:'))) return false;
    const repo = model.repos.find((r) => r.id === s.repoId);
    return repo !== undefined && supersededWarning(repo) !== null;
  });
}

/**
 * An executor result for the renderer. STALE and FINGERPRINT read as the review-again copy; a restore that worked
 * offers Sync (the view links it removed are not put back); the core's notes travel as they are.
 * `staleOwnLock` comes from AppLock.recordIsOurs (a structured check, never a parse of the message).
 */
export function toExecResultDTO(plan: DeletionPlan, r: ExecResult, staleOwnLock = false): ExecResultDTO {
  const e = r.error;
  // A LOCKED refusal carries the lock file (display only) and, when main found our own pid in it, the stale flag
  const lockInfo = e?.code !== 'LOCKED' ? {}
    : { ...(e.path !== undefined ? { detailPath: e.path } : {}), ...(staleOwnLock ? { staleOwnLock: true } : {}) };
  return {
    ok: r.ok, planId: plan.id, mode: plan.mode, purpose: plan.purpose, appliedOps: r.appliedOps, totalOps: plan.ops.length,
    error: e === undefined ? null
      : { code: e.code, message: e.code === 'STALE' || e.code === 'FINGERPRINT' ? STALE_MESSAGE : e.message, ...lockInfo },
    freedBytesPlanned: r.freedBytesPlanned, heldBytes: r.heldBytes, diskFreeDelta: r.diskFreeAfter - r.diskFreeBefore,
    followUp: plan.purpose === 'restore' && r.ok ? 'offer-sync' : null, notes: [...(r.notes ?? [])],
  };
}

/**
 * One Recently Deleted row. A readable manifest gives held, partial (a restore left some of it) or interrupted (a
 * move that did not finish); an unreadable one gives corrupt, or leftover for a folder holding only empty folders.
 */
export function toHeldDeletionDTO(d: HeldDeletion, pendingAutoEmpty: ReadonlySet<string> = new Set()): HeldDeletionDTO {
  const pending = pendingAutoEmpty.has(d.deletionId);
  if (!d.ok) {
    return { deletionId: d.deletionId, status: d.emptyLeftover === true ? 'leftover' : 'corrupt', error: d.error, repoIds: [],
      groupLabels: [], bytes: 0, heldAtMs: 0, otherEntries: 0, pendingAutoEmpty: pending };
  }
  const m = d.manifest;
  return {
    deletionId: d.deletionId, status: d.interrupted ? 'interrupted' : m.status === 'partial' ? 'partial' : 'held', error: null,
    repoIds: m.repos.map((r) => r.repoId),
    groupLabels: m.repos.flatMap((r) => (r.whole ? ['whole repo'] : r.groups.map((g) => g.label))),
    bytes: m.bytesHeld, heldAtMs: m.createdAt, otherEntries: d.otherEntries, pendingAutoEmpty: pending,
  };
}

/**
 * Every snapshot entry of a partly selected repo that the plan neither unlinks nor moves, sorted (a
 * whole repo keeps nothing; its hold plan is one folder rename). Unlink and hold-rename ops name the entry by `path`.
 */
function keptFiles(plan: DeletionPlan, ctx: DtoContext): KeptFileDTO[] {
  if (plan.purpose !== 'delete' || plan.selection === null) return [];
  const touched = new Set(plan.ops.flatMap((op) => (op.kind === 'unlink' || op.kind === 'hold-rename' ? [op.path] : [])));
  return plan.selection.repos.flatMap((sel) => {
    const repo = sel.whole ? undefined : ctx.model.repos.find((r) => r.id === sel.repoId);
    if (repo === undefined) return [];
    return repo.files.filter((f) => !touched.has(f.linkPath)).map((f) => f.linkPath).sort(compareStrings)
      .map((p) => ({ repoId: repo.id, displayPath: displayPath(p, ctx).text, fullPath: p }));
  });
}

export function toPlanDTO(plan: DeletionPlan, ctx: DtoContext): PlanDTO {
  const folders = new Map(ctx.model.repos.map((r) => [r.folder, r]));
  const files = plan.purpose === 'restore' ? restoreRows(plan, ctx) : plan.freed.lines.map((l) => fileRow(l, ctx, folders));
  const viewLines = [...plan.viewImpact.map((l) => viewLine(l, plan, ctx)), ...folderLines(plan, ctx)];
  const repoIds = plan.selection !== null ? plan.selection.repos.map((r) => r.repoId)
    : [...new Set(files.flatMap((f) => (f.repoId === null ? [] : [f.repoId])))];
  const groupCount = plan.purpose !== 'delete' || plan.selection === null ? 0
    : plan.selection.repos.reduce((n, r) => n + (r.whole ? 1 : r.groupKeys.length), 0);
  // A view is unaffected only with no line at all; its foreign (dangling) or kept lines are always shown
  const touched = (v: ViewName): boolean => viewLines.some((l) => l.view === v);
  return {
    planId: plan.id, fingerprint: plan.fingerprint, mode: plan.mode, purpose: plan.purpose, title: titleOf(plan, repoIds),
    repoIds, groupCount, createdAt: plan.createdAt, expiresAt: plan.expiresAt,
    filesRemoved: files.length, freedBytes: plan.freed.bytes, apparentBytes: plan.apparentBytes,
    sharedBytes: Math.max(0, plan.apparentBytes - plan.freed.bytes),
    files, ops: plan.ops.map((op) => opRow(op, ctx)), viewLines,
    viewsUnaffected: ctx.configuredViews.filter((v) => !touched(v)),
    kept: plan.kept.map((k) => ({ ...k })),
    keptFiles: keptFiles(plan, ctx),
    warnings: [...plan.warnings, ...(supersededSelected(plan, ctx.model) ? [SUPERSEDED_WARNING] : [])],
    confirmPhrase: plan.confirmPhrase,
    holdRootDisplay: plan.mode === 'hold' && plan.holdRoot !== null ? tilde(plan.holdRoot, ctx.home) : null,
  };
}

/** An empty batch with its totals; every figure is a sum of the per-plan planner figures (never UI arithmetic). */
export function toEmptyPlanDTO(plans: PlanDTO[], skipped: readonly string[]): EmptyPlanDTO {
  const total = (k: 'freedBytes' | 'apparentBytes' | 'sharedBytes'): number => plans.reduce((n, p) => n + p[k], 0);
  return { plans, skipped: [...skipped], freedBytes: total('freedBytes'), apparentBytes: total('apparentBytes'), sharedBytes: total('sharedBytes') };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sync. Nothing the core reports is dropped on the way to the renderer.

const SYNC_VIEWS: readonly ViewName[] = ['lmstudio', 'ollama'];

/** One entry; `root` is the view's realpath, so each relative path also travels as its exact absolute path. */
const syncEntry = (root: string, key: string, paths: readonly string[], note: string | null): SyncEntryDTO =>
  ({ key, paths: [...paths], fullPaths: paths.map((p) => join(root, ...p.split('/'))), note });

/** A prune/update removal: shared-path protection and conditional removals are spelled out. */
function removalEntry(root: string, item: SyncItem): SyncEntryDTO {
  const notes: string[] = [];
  if (item.conditional.length > 0) notes.push(`removed only if no manifest uses it: ${item.conditional.join(', ')}`);
  for (const k of item.keepsShared) notes.push(`${k.path} kept — also owned by ${k.owners.join(', ')}`);
  return syncEntry(root, item.key, item.removes, notes.length === 0 ? null : notes.join('; '));
}

function toSyncViewDTO(v: ViewSyncPlan, home: string): SyncViewDTO {
  const of = (...actions: SyncItem['action'][]): SyncItem[] => v.items.filter((i) => actions.includes(i.action));
  const desired = (i: SyncItem): string[] => i.desired?.paths ?? i.owned?.paths ?? [];
  const entry = (i: SyncItem): SyncEntryDTO => syncEntry(v.root, i.key, desired(i), i.reason ?? null);
  return {
    view: v.view, rootDisplay: tilde(v.root, home), skippedReason: null,
    adds: of('create').map(entry),
    updates: of('update').map(entry),
    // an update's old paths go too, so they are listed as removals as well as under the update (also a hand-over note)
    removals: [...of('prune'), ...of('update').filter((i) => i.removes.length > 0 || i.keepsShared.length > 0)].map((i) => removalEntry(v.root, i)),
    tombstones: of('tombstone').map(entry),
    adopts: of('adopt').map(entry),
    foreign: [
      ...of('foreign').map(entry),
      ...v.foreign.map((f) => syncEntry(v.root, f.key, [f.path], f.target === undefined ? null : `points to ${tilde(f.target, home)}`)),
    ],
    skipped: of('skip').map(entry),
    ownedCount: v.ownedCount, wouldRemoveAll: v.massRemoval, warnings: [...v.warnings],
  };
}

/** One row per view: a planned one in full, a refused or unconfigured one with the reason it was left alone. */
export function toSyncPlanDTO(plan: SyncPlan, home: string): SyncPlanDTO {
  const views = SYNC_VIEWS.map((view): SyncViewDTO => {
    const planned = plan.views.find((v) => v.view === view);
    if (planned !== undefined) return toSyncViewDTO(planned, home);
    const reason = plan.skipped.find((s) => s.view === view)?.reason ?? 'not configured';
    return {
      view, rootDisplay: null, skippedReason: reason, adds: [], updates: [], removals: [], tombstones: [], adopts: [], foreign: [],
      skipped: [], ownedCount: 0, wouldRemoveAll: false, warnings: [],
    };
  });
  return {
    planId: plan.id, createdAt: plan.createdAt, expiresAt: plan.expiresAt, views,
    warnings: plan.offline ? ['Offline: nothing is downloaded, so Ollama entries that need the registry are skipped.'] : [],
  };
}

function toSyncViewResultDTO(v: ViewSyncResult): SyncViewResultDTO {
  const count = (action: string): number => v.applied.filter((a) => a.action === action).length;
  const partial = v.skippedEntries.filter((s) => s.partialWrite === true);
  const plain = v.skippedEntries.filter((s) => s.partialWrite !== true);
  return {
    view: v.view, status: v.status, created: count('create'), updated: count('update'), removed: v.removedPaths.length,
    adopted: count('adopt'), tombstoned: count('tombstone'), skipped: v.skippedEntries.length,
    error: v.status === 'applied' ? null : v.message ?? `${v.view}: ${v.status}`,
    partialWrites: partial.map((s) => `${s.key}: ${s.reason}`),
    warnings: [...v.warnings, ...plain.map((s) => `${s.key}: skipped — ${s.reason}`)],
  };
}

/**
 * Every executed view, then every view the plan left out (with its reason). `ok` is true only when a view ran, every
 * executed view was applied and no entry failed after a partial write; a view the plan skipped does not decide it.
 */
export function toSyncResultDTO(r: SyncResult, planSkipped: ReadonlyArray<{ view: ViewName; reason: string }>): SyncResultDTO {
  const views = r.views.map(toSyncViewResultDTO);
  const left = planSkipped.filter((s) => !r.views.some((v) => v.view === s.view)).map((s): SyncViewResultDTO => ({
    view: s.view, status: 'skipped', created: 0, updated: 0, removed: 0, adopted: 0, tombstoned: 0, skipped: 0, error: s.reason,
    partialWrites: [], warnings: [],
  }));
  return {
    ok: views.length > 0 && views.every((v) => v.status === 'applied' && v.partialWrites.length === 0),
    views: [...views, ...left], massRemovalViews: views.filter((v) => v.status === 'refused-mass-removal').map((v) => v.view),
  };
}
