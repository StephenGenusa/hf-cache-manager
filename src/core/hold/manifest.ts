// Recently Deleted: the per-deletion manifest (`<holdRoot>/<deletionId>/manifest.json`), its serializer and a strict,
// hand-written parser. The manifest is untrusted input: anything that can steer a later restore or empty (paths, roles,
// layout) is re-derived and cross-checked here, so a tampered file is rejected rather than acted on.
//
// Recorded deviation (same class as): the manifest is written with writeFileAtomic, which does not fsync. A
// power loss may leave a stale or missing manifest; held items are never lost, they are listed as corrupt with their
// folder path.
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { classifyRepo } from '../classify/classify';
import { executePlan, type ExecDeps, type ExecOutcome } from '../exec/executor';
import { factsMatch, factsOf, isFileFacts, isNotFound, readFs, type ReadFs } from '../fsx';
import { isStrictlyInside } from '../paths';
import type { SafeFs } from '../safe-fs';
import type { CacheModel, DeletionPlan, ExecHooks, ExecResult, FileFacts, Op, ViewName } from '../types';
import { MANIFEST_NAME, walkTree } from './tree';
import { MAX_HELD_VIEW_FILE_BYTES, MAX_HELD_VIEW_TOTAL_BYTES, viewHoldCost, viewHoldProblem } from './view-limits';

export { MAX_HELD_VIEW_FILE_BYTES, MAX_HELD_VIEW_TOTAL_BYTES };

export const HOLD_MANIFEST_VERSION = 1;
export { MANIFEST_NAME };
/** The planner's deletion id: `<ISO time with : and . replaced by ->-<8 hex>` (planner.ts). */
export const DELETION_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
/** A manifest larger than this is reported as corrupt (the executor refuses a larger write-file `before`). */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export type HoldStatus = 'moving' | 'held' | 'partial';
export type HoldItemRole = 'snapshot-link' | 'repo-blob' | 'repo-folder';
export interface HoldRepoEntry { repoId: string; whole: boolean; groups: Array<{ key: string; label: string }> }
export interface HoldItem {
  originalPath: string; heldPath: string; role: HoldItemRole; facts: FileFacts; linkTarget?: string; done: boolean;
  /** Required iff role === 'repo-folder'. Every entry under the folder (POSIX rel, lstat facts, links not followed). */
  tree?: Array<{ rel: string; facts: FileFacts }>;
}
export interface HoldStoreItem {
  originalPath: string; heldPath: string | null;   // null = payload kept in the hub (still referenced)
  refsRemoved: string[]; refsPath: string; facts: FileFacts; size: number; done: boolean;
}
export interface HoldViewEntry { view: ViewName; path: string; linkTarget?: string; manifestText?: string;
  /** Recorded as "target, contents": the bytes of a regular `view-blob` of at most MAX_HELD_VIEW_FILE_BYTES. A record only; Sync recreates view entries. */
  contentBase64?: string; done: boolean }
export interface HoldManifest {
  version: 1; deletionId: string; planId: string; createdAt: number; hubRoot: string;
  repos: HoldRepoEntry[]; items: HoldItem[]; storeItems: HoldStoreItem[]; viewEntriesRemoved: HoldViewEntry[];
  bytesHeld: number; bytesFreedWhenEmptied: number; status: HoldStatus;
}

export function manifestPath(holdRoot: string, deletionId: string): string {
  return join(holdRoot, deletionId, MANIFEST_NAME);
}

/** The absolute held path of a hold-mode store-sweep, whose `holdDest` is holdRoot-relative POSIX. */
export function heldPathOfHoldDest(holdRoot: string, holdDest: string): string {
  return join(holdRoot, ...holdDest.split('/'));
}

/** Compact (no indentation, so large holds stay under MAX_MANIFEST_BYTES); parseManifest accepts any JSON layout. */
export function serializeManifest(m: HoldManifest): string {
  return JSON.stringify(m) + '\n';
}

/** Why a hold is refused when its manifest would be larger than the app can read back. */
export const TOO_MANY_FILES = 'Too many files to move to Recently Deleted — use Delete Permanently.';

const REPO_FOLDER = /^(datasets|kernels|models|spaces)--./;
const HASH_RE = /^[0-9a-f]{64}$/;
const REF_LINE_RE = /^(models|datasets|spaces|kernels)--[^/\n\r\0]+\/blobs\/[^/\n\r\0]+$/;
const ROLES: readonly string[] = ['snapshot-link', 'repo-blob', 'repo-folder'];
const STATUSES: readonly string[] = ['moving', 'held', 'partial'];
const VIEWS: readonly string[] = ['lmstudio', 'ollama'];

class Bad extends Error {}
const bad = (field: string, why: string): never => { throw new Bad(`${field}: ${why}`); };

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);

function obj(x: unknown, field: string, allowed: readonly string[]): Rec {
  if (!isRec(x)) return bad(field, 'must be an object');
  for (const k of Object.keys(x)) if (!allowed.includes(k)) bad(field, `unknown field ${JSON.stringify(k)}`);
  return x;
}
function str(x: unknown, field: string): string {
  return typeof x === 'string' ? x : bad(field, 'must be a string');
}
function bool(x: unknown, field: string): boolean {
  return typeof x === 'boolean' ? x : bad(field, 'must be a boolean');
}
function nat(x: unknown, field: string): number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : bad(field, 'must be a non-negative integer');
}
/** Canonical base64 (it re-encodes to itself) that decodes to at most MAX_HELD_VIEW_FILE_BYTES. */
function base64(x: unknown, field: string): string {
  const t = str(x, field);
  const bytes = Buffer.from(t, 'base64');
  if (bytes.toString('base64') !== t) bad(field, 'must be valid base64');
  if (bytes.length > MAX_HELD_VIEW_FILE_BYTES) bad(field, 'must decode to at most 1 MiB');
  return t;
}
function arr(x: unknown, field: string): unknown[] {
  return Array.isArray(x) ? x : bad(field, 'must be an array');
}
function absNorm(x: unknown, field: string): string {
  const p = str(x, field);
  if (p === '' || p.includes('\0') || !isAbsolute(p) || normalize(p) !== p || (p.length > 1 && p.endsWith(sep))) bad(field, 'must be a normalised absolute path');
  return p;
}
function facts(x: unknown, field: string): FileFacts {
  return isFileFacts(x) ? x : bad(field, 'is not valid file facts');
}
function relPosix(x: unknown, field: string): string {
  const p = str(x, field);
  if (p === '' || p.includes('\0') || p.includes('\\') || p.startsWith('/')) bad(field, 'must be a relative POSIX path');
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) bad(field, 'must not contain empty, "." or ".." segments');
  return p;
}

/** The hub-relative segments of `originalPath` (strictly inside the hub). */
function hubSegs(hubRoot: string, p: string, field: string): string[] {
  if (!isStrictlyInside(p, hubRoot)) bad(field, `${p} is not inside the hub`);
  return relative(hubRoot, p).split(sep);
}

function parseItem(x: unknown, i: number, hubRoot: string, dir: string): HoldItem {
  const f = `items[${i}]`;
  const o = obj(x, f, ['originalPath', 'heldPath', 'role', 'facts', 'linkTarget', 'done', 'tree']);
  const originalPath = absNorm(o.originalPath, `${f}.originalPath`);
  const heldPath = absNorm(o.heldPath, `${f}.heldPath`);
  const role = str(o.role, `${f}.role`);
  if (!ROLES.includes(role)) bad(`${f}.role`, `${JSON.stringify(role)} is not a held item role`);
  const segs = hubSegs(hubRoot, originalPath, `${f}.originalPath`);
  if (!REPO_FOLDER.test(segs[0]!)) bad(`${f}.originalPath`, `${originalPath} is not inside a repo folder`);
  const shapeOk = role === 'repo-folder' ? segs.length === 1
    : role === 'repo-blob' ? segs.length === 3 && segs[1] === 'blobs'
      : segs.length >= 4 && segs[1] === 'snapshots';
  if (!shapeOk) bad(`${f}.originalPath`, `${originalPath} does not have the shape of a ${role}`);
  if (heldPath !== join(dir, ...segs)) bad(`${f}.heldPath`, `${heldPath} is not at its place inside the deletion folder`);
  const item: HoldItem = { originalPath, heldPath, role: role as HoldItemRole, facts: facts(o.facts, `${f}.facts`), done: bool(o.done, `${f}.done`) };
  if (o.linkTarget !== undefined) item.linkTarget = str(o.linkTarget, `${f}.linkTarget`);
  if (role === 'repo-folder') {
    if (o.tree === undefined) bad(`${f}.tree`, 'is required for a repo-folder item');
    const seen = new Set<string>();
    item.tree = arr(o.tree, `${f}.tree`).map((e, j) => {
      const tf = `${f}.tree[${j}]`;
      const eo = obj(e, tf, ['rel', 'facts']);
      const rel = relPosix(eo.rel, `${tf}.rel`);
      if (seen.has(rel)) bad(`${tf}.rel`, `duplicate path ${rel}`);
      seen.add(rel);
      return { rel, facts: facts(eo.facts, `${tf}.facts`) };
    });
  } else if (o.tree !== undefined) bad(`${f}.tree`, 'is only allowed on a repo-folder item');
  return item;
}

function parseStoreItem(x: unknown, i: number, hubRoot: string, dir: string): HoldStoreItem {
  const f = `storeItems[${i}]`;
  const o = obj(x, f, ['originalPath', 'heldPath', 'refsRemoved', 'refsPath', 'facts', 'size', 'done']);
  const originalPath = absNorm(o.originalPath, `${f}.originalPath`);
  const segs = hubSegs(hubRoot, originalPath, `${f}.originalPath`);
  const [top, xx, hash] = segs;
  if (segs.length !== 3 || top !== 'blobs' || !HASH_RE.test(hash!) || xx !== hash!.slice(0, 2)) {
    bad(`${f}.originalPath`, `${originalPath} is not <hub>/blobs/<xx>/<64 hex>`);
  }
  let heldPath: string | null = null;
  if (o.heldPath !== null) {
    heldPath = absNorm(o.heldPath, `${f}.heldPath`);
    if (heldPath !== join(dir, 'store', xx!, hash!)) bad(`${f}.heldPath`, `${heldPath} is not the deletion folder's store/<xx>/<hash>`);
  }
  const refsPath = absNorm(o.refsPath, `${f}.refsPath`);
  if (refsPath !== originalPath + '.refs') bad(`${f}.refsPath`, 'must be the payload path plus ".refs"');
  const refsRemoved = arr(o.refsRemoved, `${f}.refsRemoved`).map((l, j) => {
    const line = str(l, `${f}.refsRemoved[${j}]`);
    if (!REF_LINE_RE.test(line) || line.split('/').some((seg) => seg === '.' || seg === '..')) bad(`${f}.refsRemoved[${j}]`, `${JSON.stringify(line)} is not a relative blob reference`);
    return line;
  });
  return { originalPath, heldPath, refsRemoved, refsPath, facts: facts(o.facts, `${f}.facts`), size: nat(o.size, `${f}.size`), done: bool(o.done, `${f}.done`) };
}

function parseView(x: unknown, i: number): HoldViewEntry {
  const f = `viewEntriesRemoved[${i}]`;
  const o = obj(x, f, ['view', 'path', 'linkTarget', 'manifestText', 'contentBase64', 'done']);
  const view = str(o.view, `${f}.view`);
  if (!VIEWS.includes(view)) bad(`${f}.view`, `${JSON.stringify(view)} is not a known view`);
  const e: HoldViewEntry = { view: view as ViewName, path: relPosix(o.path, `${f}.path`), done: bool(o.done, `${f}.done`) };
  if (o.linkTarget !== undefined) e.linkTarget = str(o.linkTarget, `${f}.linkTarget`);
  if (o.manifestText !== undefined) e.manifestText = str(o.manifestText, `${f}.manifestText`);
  if (o.contentBase64 !== undefined) e.contentBase64 = base64(o.contentBase64, `${f}.contentBase64`);
  return e;
}

function parseRepo(x: unknown, i: number): HoldRepoEntry {
  const f = `repos[${i}]`;
  const o = obj(x, f, ['repoId', 'whole', 'groups']);
  const groups = arr(o.groups, `${f}.groups`).map((g, j) => {
    const go = obj(g, `${f}.groups[${j}]`, ['key', 'label']);
    return { key: str(go.key, `${f}.groups[${j}].key`), label: str(go.label, `${f}.groups[${j}].label`) };
  });
  return { repoId: str(o.repoId, `${f}.repoId`), whole: bool(o.whole, `${f}.whole`), groups };
}

function parseValue(v: unknown, ctx: { holdRoot: string; deletionId: string }): HoldManifest {
  const o = obj(v, 'manifest', ['version', 'deletionId', 'planId', 'createdAt', 'hubRoot', 'repos', 'items', 'storeItems',
    'viewEntriesRemoved', 'bytesHeld', 'bytesFreedWhenEmptied', 'status']);
  if (o.version !== HOLD_MANIFEST_VERSION) bad('version', `unsupported manifest version ${JSON.stringify(o.version)}`);
  if (!DELETION_ID_RE.test(ctx.deletionId)) bad('deletionId', `${JSON.stringify(ctx.deletionId)} is not a deletion id`);
  if (o.deletionId !== ctx.deletionId) bad('deletionId', 'does not match its folder');
  const holdRoot = absNorm(ctx.holdRoot, 'holdRoot');
  const dir = join(holdRoot, ctx.deletionId);
  const hubRoot = absNorm(o.hubRoot, 'hubRoot');
  const planId = str(o.planId, 'planId');
  const createdAt = nat(o.createdAt, 'createdAt');
  const status = str(o.status, 'status');
  if (!STATUSES.includes(status)) bad('status', `${JSON.stringify(status)} is not a hold status`);
  const bytesHeld = nat(o.bytesHeld, 'bytesHeld');
  const bytesFreedWhenEmptied = nat(o.bytesFreedWhenEmptied, 'bytesFreedWhenEmptied');
  const repos = arr(o.repos, 'repos').map(parseRepo);
  const items = arr(o.items, 'items').map((x, i) => parseItem(x, i, hubRoot, dir));
  const storeItems = arr(o.storeItems, 'storeItems').map((x, i) => parseStoreItem(x, i, hubRoot, dir));
  const viewEntriesRemoved = arr(o.viewEntriesRemoved, 'viewEntriesRemoved').map(parseView);
  const seenOrig = new Set<string>();
  const seenHeld = new Set<string>();
  const claim = (set: Set<string>, p: string, field: string): void => {
    if (set.has(p)) bad(field, `duplicate path ${p}`);
    set.add(p);
  };
  // No entry may sit inside another entry's path (e.g. a repo folder plus a child of it). heldPath is derived from
  // originalPath by the layout check, so held paths overlap exactly when original paths do.
  const noOverlap = (set: Set<string>, field: (i: number) => string, paths: string[]): void => {
    paths.forEach((p, i) => {
      for (let a = dirname(p); a !== dirname(a); a = dirname(a)) {
        if (set.has(a)) bad(field(i), `${p} overlaps ${a}`);
      }
    });
  };
  items.forEach((it, i) => { claim(seenOrig, it.originalPath, `items[${i}].originalPath`); claim(seenHeld, it.heldPath, `items[${i}].heldPath`); });
  storeItems.forEach((it, i) => {
    claim(seenOrig, it.originalPath, `storeItems[${i}].originalPath`);
    if (it.heldPath !== null) claim(seenHeld, it.heldPath, `storeItems[${i}].heldPath`);
  });
  // Store items are exactly <hub>/blobs/<xx>/<hash>, never inside a repo folder, so only items can overlap.
  noOverlap(seenOrig, (i) => `items[${i}].originalPath`, items.map((it) => it.originalPath));
  return { version: 1, deletionId: ctx.deletionId, planId, createdAt, hubRoot, repos, items, storeItems, viewEntriesRemoved,
    bytesHeld, bytesFreedWhenEmptied, status: status as HoldStatus };
}

export function parseManifest(text: string, ctx: { holdRoot: string; deletionId: string }):
  { ok: true; manifest: HoldManifest } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: 'manifest is not valid JSON' };
  }
  try {
    return { ok: true, manifest: parseValue(v, ctx) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const isHoldPlan = (plan: DeletionPlan): plan is DeletionPlan & { deletionId: string; holdRoot: string } =>
  plan.mode === 'hold' && plan.purpose === 'delete' && !!plan.deletionId && !!plan.holdRoot;

const VIEW_UNLINK_ROLES: ReadonlySet<string> = new Set(['view-link', 'view-manifest', 'view-blob']);
/** Builds the `moving` manifest for a hold plan (read-only; writes it from beforeFirstOp, before any move). */
export async function manifestFromPlan(plan: DeletionPlan, ctx: {
  model: CacheModel; viewRoots: Partial<Record<ViewName, string>>; fs?: ReadFs; now: number;
}): Promise<HoldManifest> {
  if (!isHoldPlan(plan)) throw new Error('not a hold plan');
  const fs = ctx.fs ?? readFs;
  const { holdRoot } = plan;
  const items: HoldItem[] = [];
  const storeItems: HoldStoreItem[] = [];
  const viewEntriesRemoved: HoldViewEntry[] = [];
  let viewBytes = 0;
  const toRead: Array<{ entry: HoldViewEntry; op: Extract<Op, { kind: 'unlink' }> }> = [];
  for (const op of plan.ops) {
    if (op.kind === 'hold-rename') {
      if (op.role !== 'snapshot-link' && op.role !== 'repo-blob' && op.role !== 'repo-folder') throw new Error(`hold plan renames a ${op.role}`);
      const item: HoldItem = { originalPath: op.path, heldPath: op.dest, role: op.role, facts: op.expect, done: false };
      if (op.expect.linkTarget !== undefined) item.linkTarget = op.expect.linkTarget;
      if (op.role === 'repo-folder') item.tree = await walkTree(fs, op.path);
      items.push(item);
    } else if (op.kind === 'store-sweep') {
      if (op.payload === 'delete') throw new Error('hold plan contains a store-sweep with payload delete');
      storeItems.push({
        originalPath: op.storePath, heldPath: op.payload === 'hold' ? heldPathOfHoldDest(holdRoot, op.holdDest!) : null,
        refsRemoved: [...op.removeRefs], refsPath: op.refsPath, facts: op.expect, size: op.expect.size, done: false,
      });
    } else if (op.kind === 'unlink' && VIEW_UNLINK_ROLES.has(op.role as string)) {
      const owners = (Object.entries(ctx.viewRoots) as Array<[ViewName, string]>).filter(([, root]) => isStrictlyInside(op.path, root));
      if (owners.length === 0) throw new Error(`${op.path} is not inside a view root`);
      if (owners.length > 1) throw new Error(`${op.path} is inside more than one view folder`);
      const [view, root] = owners[0]!;
      const entry: HoldViewEntry = { view, path: relative(root, op.path).split(sep).join('/'), done: false };
      const problem = viewHoldProblem(op.role as string, op.expect);
      if (problem === 'not-a-file') {
        throw new Error(`Cannot move to Recently Deleted: ${op.path} is not a regular file or link in the ${view} folder \u2014 use Delete Permanently.`);
      }
      if (problem === 'not-a-link') {
        throw new Error(`Cannot move to Recently Deleted: ${op.path} is a regular file in the ${view} folder, not a link \u2014 use Delete Permanently.`);
      }
      if (problem === 'too-large') {
        throw new Error(`Cannot move to Recently Deleted: ${op.path} is a regular file in the ${view} folder larger than 1 MiB \u2014 use Delete Permanently.`);
      }
      viewBytes += viewHoldCost(op.role as string, op.expect);
      if (viewBytes > MAX_HELD_VIEW_TOTAL_BYTES) throw new Error('Cannot move to Recently Deleted: more than 4 MiB of view data \u2014 use Delete Permanently.');
      if (op.expect.isSymlink) entry.linkTarget = op.expect.linkTarget!;
      else toRead.push({ entry, op });
      viewEntriesRemoved.push(entry);
    }
  }
  // Regular view files are read only after every limit above passed. Each is opened only while its
  // lstat facts are the plan's (never a FIFO, folder or other file put there since), and its bytes must still be the
  // planned size (at most MAX_HELD_VIEW_FILE_BYTES).
  for (const { entry, op } of toRead) {
    const changed = new Error(`${op.path} changed since preview \u2014 try again.`);
    const now = await factsOf(fs, op.path);
    if (now === null || !factsMatch(now, op.expect)) throw changed;
    const bytes = await fs.readFile(op.path);
    if (bytes.length !== op.expect.size) throw changed;
    if (op.role === 'view-manifest') entry.manifestText = bytes.toString('utf8');
    else entry.contentBase64 = bytes.toString('base64');
  }
  const sel = plan.selection;
  if (!sel) throw new Error('hold plan has no selection');
  const repos: HoldRepoEntry[] = sel.repos.map((rs) => {
    const repo = ctx.model.repos.find((r) => r.id === rs.repoId);
    if (!repo) throw new Error(`unknown repo ${rs.repoId}`);
    const groups = classifyRepo(repo).groups;
    if (rs.whole) return { repoId: rs.repoId, whole: true, groups: groups.map((g) => ({ key: g.key, label: g.label })) };
    return {
      repoId: rs.repoId, whole: false,
      groups: rs.groupKeys.map((key) => {
        const g = groups.find((x) => x.key === key);
        if (!g) throw new Error(`unknown group ${key} in ${rs.repoId}`);
        return { key, label: g.label };
      }),
    };
  });
  return {
    version: 1, deletionId: plan.deletionId, planId: plan.id, createdAt: ctx.now, hubRoot: plan.hubRoot,
    repos, items, storeItems, viewEntriesRemoved,
    bytesHeld: plan.apparentBytes, bytesFreedWhenEmptied: plan.freed.bytes, status: 'moving',
  };
}

/** A recorded dev is never compared with a live one; the held entry must be on the deletion folder's
 *  live device with the recorded inode. */
const sameInode = (a: FileFacts | null, b: FileFacts, liveDev: number): boolean => a !== null && a.dev === liveDev && a.ino === b.ino;

/**
 * Writes the manifest, refusing (STALE) to replace a file that is not the one last written or read, and refusing
 * (TOO_MANY_FILES, nothing written) text larger than `maxBytes`: listHeld would report it as corrupt and the
 * deletion could be neither restored nor emptied.
 */
async function writeManifest(safeFs: SafeFs, fs: ReadFs, path: string, m: HoldManifest, expect: FileFacts | null,
  maxBytes = MAX_MANIFEST_BYTES): Promise<FileFacts | null> {
  const text = serializeManifest(m);
  if (Buffer.byteLength(text) > maxBytes) throw new Error(TOO_MANY_FILES);
  await safeFs.writeFileAtomic(path, text, { expect });
  return factsOf(fs, path);
}

/** The plan's view unlinks in plan order, which is the order manifestFromPlan lists viewEntriesRemoved. */
const viewUnlinks = (plan: DeletionPlan): Array<Extract<Op, { kind: 'unlink' }>> =>
  plan.ops.filter((o): o is Extract<Op, { kind: 'unlink' }> => o.kind === 'unlink' && VIEW_UNLINK_ROLES.has(o.role as string));

/**
 * Exec hooks for a hold delete: write the `moving` manifest before the first op, then mark each entry done as its op
 * completes (the last op also sets `held`). A manifest larger than `maxManifestBytes` is never written; from
 * beforeFirstOp that refuses the hold with TOO_MANY_FILES before anything moves (the executor: "Could not prepare"). Plans that are not hold deletes are ignored. The executor creates the
 * deletion folder exclusively before calling beforeFirstOp; the hook only checks it is a real directory.
 */
export function createHoldHooks(deps: {
  safeFs: SafeFs; fs?: ReadFs; model: CacheModel; viewRoots: Partial<Record<ViewName, string>>; now: () => number;
  /** The largest manifest the hooks write (default MAX_MANIFEST_BYTES; lowered by tests). */
  maxManifestBytes?: number;
}): ExecHooks & { wrote(planId: string): boolean } {
  const fs = deps.fs ?? readFs;
  const max = deps.maxManifestBytes ?? MAX_MANIFEST_BYTES;
  const wrote = new Set<string>();
  const state = new Map<string, { m: HoldManifest; facts: FileFacts | null }>();
  return {
    /** Whether this hook set wrote the manifest for the plan (executeHold finalizes only then). */
    wrote: (planId) => wrote.has(planId),
    async beforeFirstOp(plan) {
      if (!isHoldPlan(plan)) return;
      const dir = join(plan.holdRoot, plan.deletionId);
      const d = await factsOf(fs, dir);
      if (!d || !d.isDirectory || d.isSymlink) throw new Error(`the deletion folder ${dir} was not created as a directory`);
      const m = await manifestFromPlan(plan, { model: deps.model, viewRoots: deps.viewRoots, fs, now: deps.now() });
      state.set(plan.id, { m, facts: await writeManifest(deps.safeFs, fs, manifestPath(plan.holdRoot, plan.deletionId), m, null, max) });
      wrote.add(plan.id);
    },
    async afterOp(plan, i) {
      if (!isHoldPlan(plan)) return;
      const st = state.get(plan.id);
      if (!st) throw new Error('no manifest was written for this plan');
      const op = plan.ops[i]!;
      const last = i === plan.ops.length - 1;
      let entry: { done: boolean } | undefined;
      if (op.kind === 'hold-rename') entry = st.m.items.find((x) => x.originalPath === op.path);
      else if (op.kind === 'store-sweep') entry = st.m.storeItems.find((x) => x.originalPath === op.storePath);
      else if (op.kind === 'unlink') entry = st.m.viewEntriesRemoved[viewUnlinks(plan).indexOf(op)];
      if (entry) entry.done = true;
      if (last) st.m.status = 'held';
      if (entry || last) st.facts = await writeManifest(deps.safeFs, fs, manifestPath(plan.holdRoot, plan.deletionId), st.m, st.facts, max);
      if (last) state.delete(plan.id);
    },
  };
}

/**
 * After a hold delete: `held` when the run succeeded, otherwise `partial` with each entry's `done` reconciled against
 * the disk (the executor may have rolled any of it back). Null when the plan is not a hold delete or no manifest was
 * written. It runs after executePlan released the AppLock; only this single-instance app writes inside the deletion
 * folder, and the write passes the facts of the manifest it read so a concurrent change is STALE.
 */
export async function finalizeHold(plan: DeletionPlan, result: ExecResult, deps: { safeFs: SafeFs; fs?: ReadFs }):
  Promise<HoldManifest | null> {
  if (!isHoldPlan(plan)) return null;
  const fs = deps.fs ?? readFs;
  const mp = manifestPath(plan.holdRoot, plan.deletionId);
  let text: string;
  let read: FileFacts | null;
  try {
    read = await factsOf(fs, mp);
    text = await fs.readFile(mp, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  const parsed = parseManifest(text, { holdRoot: plan.holdRoot, deletionId: plan.deletionId });
  if (!parsed.ok) throw new Error(`The Recently Deleted manifest ${mp} is unreadable: ${parsed.error}`);
  const m = parsed.manifest;
  if (result.ok) {
    if (m.status === 'held') return m;
    m.status = 'held';
  } else {
    const unlinks = viewUnlinks(plan);
    if (unlinks.length !== m.viewEntriesRemoved.length) throw new Error('The manifest\'s view entries do not match the plan\'s view operations.');
    // Pairing is by order, so each entry's path must be the tail of its op's path (a reordered manifest is refused).
    unlinks.forEach((u, k) => {
      if (!u.path.endsWith(sep + m.viewEntriesRemoved[k]!.path.split('/').join(sep))) throw new Error('The manifest\'s view entries do not match the plan\'s view operations.');
    });
    for (const [k, v] of m.viewEntriesRemoved.entries()) v.done = (await factsOf(fs, unlinks[k]!.path)) === null;
    const dirDev = (await fs.lstat(dirname(mp))).dev;
    for (const it of m.items) it.done = sameInode(await factsOf(fs, it.heldPath), it.facts, dirDev);
    for (const it of m.storeItems) {
      if (it.heldPath !== null) it.done = sameInode(await factsOf(fs, it.heldPath), it.facts, dirDev);
      else {
        let lines: string[] = [];
        try {
          lines = (await fs.readFile(it.refsPath, 'utf8')).split('\n');
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        it.done = !it.refsRemoved.some((l) => lines.includes(l));
      }
    }
    m.status = 'partial';
  }
  await writeManifest(deps.safeFs, fs, mp, m, read);
  return m;
}

/**
 * executePlan with the hold hooks, then finalizeHold when a hold delete did not succeed (a rolled-back or refused
 * run must not leave a `moving` manifest). A finalize failure is appended to `notes`, never thrown.
 */
export async function executeHold(plan: DeletionPlan, deps: ExecDeps, ctx: {
  model: CacheModel; viewRoots: Partial<Record<ViewName, string>>; fs?: ReadFs;
}): Promise<ExecOutcome> {
  const fs = ctx.fs ?? readFs;
  const hooks = createHoldHooks({ safeFs: deps.safeFs, fs, model: ctx.model, viewRoots: ctx.viewRoots, now: deps.now });
  const result = await executePlan(plan, { ...deps, hooks });
  if (result.ok || !hooks.wrote(plan.id)) return result;
  try {
    await finalizeHold(plan, result, { safeFs: deps.safeFs, fs });
  } catch (e) {
    result.notes = [...(result.notes ?? []), `Could not update the Recently Deleted record: ${(e as Error).message}`];
  }
  return result;
}
