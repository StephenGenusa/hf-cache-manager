// Recently Deleted, read side: list what is held (read-only, ReadFs) and re-read one deletion for a planner.
// Everything here treats the hold root as untrusted input: manifests are strictly parsed, counts come from the disk
// (never the manifest's `done` flags, which a crash leaves stale), and links are never followed.
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { hubDownloadActive } from '../exec/store-ops';
import { factsMatch, factsOf, isNotFound, readFs, type ReadFs } from '../fsx';
import { compareStrings, isStrictlyInside } from '../paths';
import { fingerprintPlan } from '../plan/fingerprint';
import { PlanError } from '../plan/closure';
import { assertNoActiveDownload, PLAN_TTL_MS } from '../plan/planner';
import { isStorePath, parseRefs, validRefsFor } from '../scan/store';
import type { CacheModel, DeletionPlan, FileFacts, FreedLine, FreedReason, Op, SafeRoots } from '../types';
import {
  DELETION_ID_RE, MANIFEST_NAME, MAX_MANIFEST_BYTES, parseManifest, serializeManifest, type HoldItem, type HoldManifest, type HoldStoreItem,
} from './manifest';
import { restoreContentDigest, walkTree, type TreeEntry } from './tree';

/** The roots listHeld, planRestore and planEmpty share (a SafeRoots satisfies it). */
export type HeldRoots = Pick<SafeRoots, 'hubRoot' | 'holdRoot'>;

export type HeldErrorCode =
  'NO_HOLD_ROOT' | 'HUB_MISMATCH' | 'CORRUPT' | 'NOT_FOUND' | 'BAD_DAYS' | 'STALE_MANIFEST' | 'ACTIVE_DOWNLOAD';
export class HeldError extends Error {
  constructor(public code: HeldErrorCode, message: string) {
    super(message);
    this.name = 'HeldError';
  }
}

export type HeldDeletion =
  | { ok: true; deletionId: string; dir: string; manifest: HoldManifest; manifestText: string;
      /** Items and held store items whose heldPath is on disk as recorded (sameHeldObject, on the folder's live device). */
      heldCount: number;
      /** Non-directory entries under the deletion folder that the manifest does not account for. */
      otherEntries: number;
      /** manifest.status === 'moving' */
      interrupted: boolean }
  | { ok: false; deletionId: string; dir: string; error: string;
      /** No manifest and nothing but directories (a crash after a restore's or an empty's manifest unlink). */
      emptyLeftover?: true };

/** The `error` of a deletion folder with no manifest and only (empty) directories in it. */
export const EMPTY_LEFTOVER = 'empty leftover: no manifest.json and nothing but empty folders';

/** Whether `dir` holds nothing but directories, at any depth (lstat: a symlink is not a directory). */
async function onlyDirs(fs: ReadFs, dir: string): Promise<boolean> {
  for (const name of await fs.readdir(dir)) {
    const p = join(dir, name);
    if (!(await fs.lstat(p)).isDirectory() || !(await onlyDirs(fs, p))) return false;
  }
  return true;
}

/**
 * The entry the manifest recorded, wherever it is now. A recorded `dev` is never compared with a
 * live one: device numbers change across reboots (btrfs subvolumes, NVMe and device-mapper minors, a USB drive plugged
 * in again). The entry must be on `liveDev` (the device of the deletion folder for a held path, of the hub for an
 * original path, both read now) with the recorded inode, type, link text and, for a non-directory, size (inode
 * numbers are reused; a rename never changes a size).
 */
export const sameHeldObject = (actual: FileFacts | null, recorded: FileFacts, liveDev: number): boolean =>
  actual !== null && actual.dev === liveDev && actual.ino === recorded.ino &&
  (recorded.isDirectory || actual.size === recorded.size) &&
  actual.isSymlink === recorded.isSymlink && actual.isDirectory === recorded.isDirectory && actual.isFile === recorded.isFile &&
  actual.linkTarget === recorded.linkTarget;

/** factsMatch of a live tree entry against its recorded facts, on `liveDev` instead of the recorded device. */
export const treeEntryMatches = (actual: FileFacts, recorded: FileFacts, liveDev: number): boolean =>
  factsMatch(actual, { ...recorded, dev: liveDev });

/** Parses a manifest and requires it to belong to `hubRoot`. */
function parseFor(text: string, roots: { hubRoot: string; holdRoot: string }, deletionId: string):
  { ok: true; manifest: HoldManifest } | { ok: false; error: string; hub: boolean } {
  const r = parseManifest(text, { holdRoot: roots.holdRoot, deletionId });
  if (!r.ok) return { ok: false, error: r.error, hub: false };
  if (r.manifest.hubRoot !== roots.hubRoot) return { ok: false, error: 'hubRoot: the manifest belongs to a different hub', hub: true };
  return r;
}

/** Counts what is on disk: matching held items, and non-directory entries nothing in the manifest accounts for. */
async function inspect(fs: ReadFs, dir: string, dirDev: number, m: HoldManifest): Promise<{ heldCount: number; otherEntries: number }> {
  let heldCount = 0;
  const expected = new Set<string>([join(dir, MANIFEST_NAME)]);
  for (const it of m.items) {
    if (!sameHeldObject(await factsOf(fs, it.heldPath), it.facts, dirDev)) continue;   // an impostor stays an "other entry"
    heldCount++;
    expected.add(it.heldPath);
    for (const t of it.tree ?? []) expected.add(join(it.heldPath, ...t.rel.split('/')));
  }
  for (const it of m.storeItems) {
    if (it.heldPath === null) continue;
    if (!sameHeldObject(await factsOf(fs, it.heldPath), it.facts, dirDev)) continue;
    heldCount++;
    expected.add(it.heldPath);
  }
  let otherEntries = 0;
  const walk = async (abs: string): Promise<void> => {
    for (const name of await fs.readdir(abs)) {
      const p = join(abs, name);
      if ((await fs.lstat(p)).isDirectory()) await walk(p);
      else if (!expected.has(p)) otherEntries++;
    }
  };
  await walk(dir);
  return { heldCount, otherEntries };
}

async function readEntry(fs: ReadFs, roots: { hubRoot: string; holdRoot: string }, deletionId: string): Promise<HeldDeletion> {
  const dir = join(roots.holdRoot, deletionId);
  const corrupt = (error: string): HeldDeletion => ({ ok: false, deletionId, dir, error });
  try {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return corrupt('not a directory');
    const mp = join(dir, MANIFEST_NAME);
    const mf = await factsOf(fs, mp);
    if (mf === null) {
      return (await onlyDirs(fs, dir)) ? { ok: false, deletionId, dir, error: EMPTY_LEFTOVER, emptyLeftover: true } : corrupt('manifest.json missing');
    }
    if (!mf.isFile) return corrupt('manifest.json is not a regular file');
    if (mf.size > MAX_MANIFEST_BYTES) return corrupt('manifest too large');
    const manifestText = await fs.readFile(mp, 'utf8');
    const parsed = parseFor(manifestText, roots, deletionId);
    if (!parsed.ok) return corrupt(parsed.error);
    const { heldCount, otherEntries } = await inspect(fs, dir, st.dev, parsed.manifest);
    return { ok: true, deletionId, dir, manifest: parsed.manifest, manifestText, heldCount, otherEntries,
      interrupted: parsed.manifest.status === 'moving' };
  } catch (e) {
    return corrupt((e as Error).message);
  }
}

/**
 * Lists the deletions under `roots.holdRoot`: ok entries newest first (ties by id, descending), then corrupt ones by
 * name. Read-only. An absent hold root lists nothing.
 * `interrupted` is the manifest's own status: a `moving` manifest (a hold that crashed part-way) that a restore then
 * rewrote as `partial` is no longer reported as interrupted; what it still holds is counted from the disk as
 * for any other deletion. The exact bytes emptying would free come from planEmpty, not `bytesFreedWhenEmptied`.
 * A folder with no manifest that holds nothing but directories is listed not ok with EMPTY_LEFTOVER and
 * `emptyLeftover: true`; planEmpty can remove it.
 */
export async function listHeld(roots: HeldRoots, fs: ReadFs = readFs): Promise<HeldDeletion[]> {
  if (roots.holdRoot === null) return [];
  const checked = { hubRoot: roots.hubRoot, holdRoot: roots.holdRoot };
  let names: string[];
  try {
    names = await fs.readdir(roots.holdRoot);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const entries: HeldDeletion[] = [];
  for (const name of names.filter((n) => DELETION_ID_RE.test(n)).sort()) entries.push(await readEntry(fs, checked, name));
  const good = entries.filter((d): d is Extract<HeldDeletion, { ok: true }> => d.ok)
    .sort((a, b) => b.manifest.createdAt - a.manifest.createdAt || b.deletionId.localeCompare(a.deletionId));
  return [...good, ...entries.filter((d) => !d.ok)];
}

/**
 * What planRestore and planEmpty use instead of a caller-supplied HeldDeletion. Re-resolves the folder from the
 * id alone, requires a real directory and a regular manifest.json whose text equals `expectedText`, and re-parses it.
 */
export async function rereadHeld(roots: HeldRoots, deletionId: string, expectedText: string, fs: ReadFs = readFs):
  Promise<{ dir: string; dirDev: number; manifest: HoldManifest; manifestText: string; manifestFacts: FileFacts }> {
  if (roots.holdRoot === null) throw new HeldError('NO_HOLD_ROOT', 'Recently Deleted is not available for this cache.');
  if (!DELETION_ID_RE.test(deletionId)) throw new HeldError('CORRUPT', `${JSON.stringify(deletionId)} is not a deletion id.`);
  const dir = join(roots.holdRoot, deletionId);
  const dirFacts = await factsOf(fs, dir);
  if (dirFacts === null || !dirFacts.isDirectory) throw new HeldError('NOT_FOUND', 'That deletion is no longer in Recently Deleted.');
  const mp = join(dir, MANIFEST_NAME);
  const mf = await factsOf(fs, mp);
  if (mf === null || !mf.isFile) throw new HeldError('CORRUPT', `${mp} is missing or not a regular file.`);
  if (mf.size > MAX_MANIFEST_BYTES) throw new HeldError('CORRUPT', 'manifest too large');
  const manifestText = await fs.readFile(mp, 'utf8');
  if (manifestText !== expectedText) throw new HeldError('STALE_MANIFEST', 'Recently Deleted changed — please review again.');
  const parsed = parseFor(manifestText, { hubRoot: roots.hubRoot, holdRoot: roots.holdRoot }, deletionId);
  if (!parsed.ok) throw new HeldError(parsed.hub ? 'HUB_MISMATCH' : 'CORRUPT', parsed.error);
  // manifestFacts were taken before the read: a later change is caught by the executor's revalidation of them
  return { dir, dirDev: dirFacts.dev, manifest: parsed.manifest, manifestText, manifestFacts: mf };
}

// ---------- restore ----------

export const RESTORE_SYNC_HINT = 'Run Sync afterwards to recreate the LM Studio and Ollama links this deletion removed.';

/** The per-item texts a restore plan carries in `warnings` (the UI renders them verbatim). */
export const RESTORE_REASONS = {
  exists:        (p: string) => `Not restored: ${p} already exists (it may have been downloaded again).`,
  changed:       (p: string) => `Not restored: ${p} changed since it was moved to Recently Deleted.`,
  missingHeld:   (p: string) => `Not restored: ${p} is not in Recently Deleted.`,
  storeGone:     (p: string) => `Not restored: ${p} points at a shared-store file that no longer exists.`,
  targetMissing: (p: string) => `Not restored: ${p} would point at a file that is not being restored.`,
  storePresent:  (p: string) => `Kept in Recently Deleted: ${p} is already back in the shared store.`,
  storeRefsPresent: (p: string) => `Kept in Recently Deleted: ${p} — the shared store already has a .refs for it.`,
  storeUnused:   (p: string) => `Kept in Recently Deleted: ${p} — nothing being restored uses it.`,
  folderStoreGone: (repo: string, n: number) => `${repo}: ${n} file(s) will be missing because their shared-store file no longer exists.`,
  /** The payload is not gone, another deletion holds it. */
  storeHeldElsewhere: (p: string, other: string) =>
    `Not restored: ${p} points at a shared-store file that ${other} holds in Recently Deleted — restore ${other} first.`,
  folderStoreHeldElsewhere: (repo: string, n: number, other: string) =>
    `${repo}: ${n} file(s) will be missing because ${other} holds their shared-store file in Recently Deleted — restore ${other} first.`,
  repoFolderGone: (repo: string) => `${repo}: the repo folder is gone; only the restored files will be put back.`,
  strays:        'Recently Deleted still holds files for this deletion that were not part of it; empty it to remove them.',
} as const;

type RenameOp = Extract<Op, { kind: 'restore-rename' }>;
type RefsAddOp = Extract<Op, { kind: 'store-refs-add' }>;
const REPO_ROLES: ReadonlySet<string> = new Set(['repo-folder', 'repo-blob', 'snapshot-link']);
/** Code-unit order; every path sorted here is unique (the parser rejects duplicates). */
const byPath = (a: string, b: string): number => (a < b ? -1 : 1);
const inPathOrder = (w: Array<[string, string]>): string[] => w.sort((a, b) => byPath(a[0], b[0])).map((x) => x[1]);
const depthOf = (p: string): number => p.split(sep).length;

/** `<type>--<org>--<name>` (the parser checked the shape) → `org/name`. */
const repoIdOf = (folder: string): string => folder.slice(folder.indexOf('--') + 2).split('--').join('/');

/** How a deletion is named in another deletion's texts: its repos and its id. */
export const deletionLabel = (d: { deletionId: string; manifest: HoldManifest }): string =>
  `${d.manifest.repos.map((r) => r.repoId).join(', ')} (${d.deletionId})`;

/** An entry that vanishes while the plan is being made means the deletion changed under us: a HeldError, not an IO error. */
async function orStale<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (isNotFound(e)) throw new HeldError('STALE_MANIFEST', 'Recently Deleted changed — please review again.');
    throw e;
  }
}

/**
 * Turns a held deletion into a restore plan (`mode: 'hold'`, `purpose: 'restore'`) for the registry and executor.
 *
 * Only `deletion.deletionId` and `deletion.manifestText` are used: the folder and manifest are re-read from disk
 * (rereadHeld) and every decision is made from the disk, never from the manifest's `done` flags (a crashed hold leaves
 * them stale). Per item, first match wins:
 * - never moved: the original path holds the manifest's dev+ino: no op, no warning;
 * - exists: the original path holds something else;
 * - missingHeld: nothing at the held path;
 * - changed: the held path is not the recorded inode/type/size/link text, is reached through a symlinked directory
 *   (realpath(dirname) must equal dirname), or, for a repo folder, a fresh lstat walk differs from its recorded
 *   tree (same rel set, per entry factsMatch);
 * - storeGone: a repo blob linking to a shared-store payload that will not be in the hub after the restore;
 * - targetMissing: a snapshot link whose target is neither restored by this plan nor on disk (a target blob on disk
 *   that is a store link counts only when its payload is in the hub or moved back by this plan).
 * A repo folder is never split; blob links in it whose payload is gone give one folderStoreGone warning.
 *
 * Shared-store payloads: a held payload goes back only when its `.refs` is absent now, or stale (a regular
 * file whose every valid reference is a line this deletion removed, left by a crash), and at least one of its removed
 * lines is re-added; otherwise it stays held (storeRefsPresent / storeUnused / storePresent). A line is
 * re-added only when its repo blob will be a symlink to that payload after the restore (a valid reference),
 * into an existing regular-file `.refs`, or into a new one only for a payload of this deletion: one the plan moves
 * back, or one already in the hub without `.refs` that is the held payload itself (sameHeldObject),
 * put back by an interrupted restore. A foreign payload without a `.refs` is never given one: hf never deletes it
 * , and inventing a `.refs` for it could under-count its references.
 *
 * Op order: held payloads without a `.refs`; repo folders, then repo blobs; one store-refs-add per `.refs`; held
 * payloads with a stale `.refs` (their lines are valid again by then); snapshot links; then,
 * when every non-directory entry of the deletion folder is restored, the manifest unlink and `rmdir-empty` of every
 * directory in it, deepest first (the folder itself last). Invariant: at every op boundary each store payload in the
 * hub has either no `.refs` or at least one valid reference, so an external `hf cache gc` never deletes a payload
 * this plan brings back. When something stays held, only the directories the restore emptied are removed, then the
 * manifest is rewritten (`partial`) when its lists change or it is still `moving` (the reviewed restore acknowledges
 * an interrupted hold, so it can be emptied afterwards).
 *
 * A restore that fails and rolls back puts every item back into the deletion folder, but hub directories the
 * executor created for it (parents of restored links) may stay behind, empty.
 *
 * Throws HeldError ACTIVE_DOWNLOAD when a repo receiving an item has a fresh `.incomplete`, or when the plan has a
 * store op and any repo in the hub has one. Also throws NO_HOLD_ROOT, CORRUPT, HUB_MISMATCH, NOT_FOUND, STALE_MANIFEST.
 */
export async function planRestore(deletion: HeldDeletion, model: CacheModel, roots: SafeRoots, now: number,
  fs: ReadFs = readFs): Promise<DeletionPlan> {
  if (roots.holdRoot === null) throw new HeldError('NO_HOLD_ROOT', 'Recently Deleted is not available for this cache.');
  if (!deletion.ok) throw new HeldError('CORRUPT', `That deletion cannot be restored: ${deletion.error}`);
  if (model.hubRoot !== roots.hubRoot) throw new HeldError('HUB_MISMATCH', 'The scanned cache is not the cache of this Recently Deleted folder.');
  const { dir, dirDev, manifest: m, manifestText, manifestFacts } = await rereadHeld(roots, deletion.deletionId, deletion.manifestText, fs);
  const hub = roots.hubRoot;
  const hubDev = (await fs.lstat(hub)).dev;                                                  // Live devices only
  const lineOf = (p: string): string => relative(hub, p).split(sep).join('/');
  const blobOf = (line: string): string => join(hub, ...line.split('/'));
  const targetOf = (p: string, linkTarget: string): string => resolve(dirname(p), linkTarget);
  const itemWarnings: Array<[string, string]> = [];
  const storeWarnings: Array<[string, string]> = [];
  const folderWarnings: string[] = [];

  /** 'never', 'exists', or null when the original path is free. */
  const originalState = async (p: string, f: FileFacts): Promise<'never' | 'exists' | null> => {
    const o = await factsOf(fs, p);
    return o === null ? null : sameHeldObject(o, f, hubDev) ? 'never' : 'exists';
  };
  /** The held path's current facts when it is still exactly the recorded entry, else the refusal. */
  const heldState = async (p: string, f: FileFacts): Promise<FileFacts | 'missingHeld' | 'changed'> => {
    const h = await factsOf(fs, p);
    if (h === null) return 'missingHeld';
    if ((await orStale(() => fs.realpath(dirname(p)))) !== dirname(p)) return 'changed';
    return sameHeldObject(h, f, dirDev) ? h : 'changed';
  };
  /** The fresh lstat walk of the held folder when it equals the recorded tree (on the folder's live device). */
  const treeIntact = async (p: string, tree: TreeEntry[]): Promise<TreeEntry[] | null> => {
    const walk = await orStale(() => walkTree(fs, p));
    const rec = new Map(tree.map((e) => [e.rel, e.facts]));
    return walk.length === rec.size &&
      walk.every((e) => { const r = rec.get(e.rel); return r !== undefined && treeEntryMatches(e.facts, r, dirDev); }) ? walk : null;
  };

  // 1. Items, on their own (order up to `changed`)
  /** `walk`: a repo folder's live tree (its facts are what the restore moves; the recorded ones may name another dev). */
  type Candidate = { item: HoldItem; now: FileFacts; walk?: TreeEntry[] };
  const candidates: Candidate[] = [];
  for (const item of m.items) {
    const o = await originalState(item.originalPath, item.facts);
    if (o === 'never') continue;
    if (o === 'exists') { itemWarnings.push([item.originalPath, RESTORE_REASONS.exists(item.originalPath)]); continue; }
    const h = await heldState(item.heldPath, item.facts);
    if (typeof h === 'string') { itemWarnings.push([item.originalPath, RESTORE_REASONS[h](item.originalPath)]); continue; }
    if (item.role !== 'repo-folder') { candidates.push({ item, now: h }); continue; }
    const walk = await treeIntact(item.heldPath, item.tree!);
    if (walk === null) {
      itemWarnings.push([item.originalPath, RESTORE_REASONS.changed(item.originalPath)]);
      continue;
    }
    candidates.push({ item, now: h, walk });
  }

  // 2. Store payloads: 'present' in the hub (refs = its current lines, null = no .refs), 'candidate' (held, restorable,
  //    restored if a line is re-added; refs = null: no .refs, else a stale one), else 'absent'
  type Store = { it: HoldStoreItem; avail: 'present' | 'candidate' | 'absent'; refs: string[] | null; held?: FileFacts;
    /** The hub payload is this deletion's held one (sameHeldObject), put back by an interrupted restore. */
    ours?: boolean;
    /** A payload this deletion did not hold, gone from the hub, that another deletion holds (its label). */
    elsewhere?: string };
  let others: Array<Extract<HeldDeletion, { ok: true }>> | null = null;
  /** The newest other listed deletion whose held copy of `payload` is in its folder. */
  const heldElsewhere = async (payload: string): Promise<string | undefined> => {
    others ??= (await listHeld(roots, fs)).filter((d): d is Extract<HeldDeletion, { ok: true }> => d.ok && d.deletionId !== m.deletionId);
    for (const d of others) {
      const x = d.manifest.storeItems.find((y) => y.originalPath === payload && y.heldPath !== null);
      if (x !== undefined && (await factsOf(fs, x.heldPath!)) !== null) return deletionLabel(d);
    }
    return undefined;
  };
  /**
   * A `.refs` left in the hub by a crash between the hold's payload move and its `.refs` unlink (or
   * a rolled-back restore whose `.refs` undo failed): a regular file whose every valid reference (checked
   * now) is one of the lines this deletion removed. False when a line cannot be checked (never guess).
   */
  const staleRefs = async (it: HoldStoreItem, refs: string[]): Promise<boolean> => {
    const valid = await validRefsFor(hub, it.originalPath, refs, fs);
    return valid !== null && valid.every((l) => it.refsRemoved.includes(l));
  };
  const stores = new Map<string, Store>();
  for (const it of m.storeItems) {
    const rf = await factsOf(fs, it.refsPath);
    const refs = rf?.isFile === true ? parseRefs(await orStale(() => fs.readFile(it.refsPath, 'utf8'))) : null;
    const refsBad = rf !== null && !rf.isFile;
    const pf = await factsOf(fs, it.originalPath);
    let st: Store;
    if (pf !== null) {
      const ours = it.heldPath !== null && sameHeldObject(pf, it.facts, hubDev);
      if (it.heldPath !== null && !ours) {
        storeWarnings.push([it.originalPath, RESTORE_REASONS.storePresent(it.originalPath)]);
      }
      st = { it, avail: pf.isFile && !refsBad ? 'present' : 'absent', refs, ours };
    } else if (it.heldPath === null) {
      st = { it, avail: 'absent', refs, elsewhere: await heldElsewhere(it.originalPath) };
    } else {
      const h = await heldState(it.heldPath, it.facts);
      if (typeof h === 'string') {
        storeWarnings.push([it.originalPath, RESTORE_REASONS[h](it.originalPath)]);
        st = { it, avail: 'absent', refs };
      } else if (refs !== null && (await staleRefs(it, refs))) {
        st = { it, avail: 'candidate', refs, held: h };
      } else if (rf !== null) {
        storeWarnings.push([it.originalPath, RESTORE_REASONS.storeRefsPresent(it.originalPath)]);
        st = { it, avail: 'absent', refs };
      } else {
        st = { it, avail: 'candidate', refs: null, held: h };
      }
    }
    stores.set(it.originalPath, st);
  }
  /** Will `line` (a repo blob linking to `payload`) be there after the restore? A candidate needs the line recorded. */
  const storeOk = (payload: string, line: string): boolean => {
    const st = stores.get(payload);
    return st !== undefined && (st.avail === 'present' || (st.avail === 'candidate' && st.it.refsRemoved.includes(line)));
  };
  const storeTarget = (p: string, f: FileFacts): string | null => {
    if (!f.isSymlink) return null;
    const t = targetOf(p, f.linkTarget!);
    return isStorePath(hub, t) ? t : null;
  };

  // 3. Repo folders (never split) and repo blobs (storeGone)
  const restored: Candidate[] = [];
  for (const c of candidates.filter((x) => x.item.role === 'repo-folder')) {
    const repo = repoIdOf(basename(c.item.originalPath));
    let gone = 0;
    const elsewhere = new Map<string, number>();
    for (const e of c.item.tree!) {
      const p = join(c.item.originalPath, ...e.rel.split('/'));
      const t = e.rel.startsWith('blobs/') ? storeTarget(p, e.facts) : null;
      if (t === null || storeOk(t, lineOf(p))) continue;
      const other = stores.get(t)?.elsewhere;
      if (other === undefined) gone++;
      else elsewhere.set(other, (elsewhere.get(other) ?? 0) + 1);
    }
    if (gone > 0) folderWarnings.push(RESTORE_REASONS.folderStoreGone(repo, gone));
    for (const [other, n] of elsewhere) {                                                  // in recorded tree order
      folderWarnings.push(RESTORE_REASONS.folderStoreHeldElsewhere(repo, n, other));
    }
    restored.push(c);
  }
  for (const c of candidates.filter((x) => x.item.role === 'repo-blob')) {
    const t = storeTarget(c.item.originalPath, c.item.facts);
    if (t !== null && !storeOk(t, lineOf(c.item.originalPath))) {
      const other = stores.get(t)?.elsewhere;
      itemWarnings.push([c.item.originalPath, other === undefined ? RESTORE_REASONS.storeGone(c.item.originalPath)
        : RESTORE_REASONS.storeHeldElsewhere(c.item.originalPath, other)]);
      continue;
    }
    restored.push(c);
  }
  const restoredBlobs = new Map(restored.map((c) => [c.item.originalPath, c.item]));

  // 4. Lines to re-add: the repo blob will be a symlink to this payload after the restore (valid reference)
  const validAfter = async (line: string, payload: string): Promise<boolean> => {
    const b = blobOf(line);
    const r = restoredBlobs.get(b);
    if (r !== undefined) return storeTarget(b, r.facts) === payload;
    const f = restored.find((x) => x.item.role === 'repo-folder' && isStrictlyInside(b, x.item.originalPath));
    if (f !== undefined) {
      const rel = relative(f.item.originalPath, b).split(sep).join('/');
      const e = f.item.tree!.find((x) => x.rel === rel);
      return e !== undefined && storeTarget(b, e.facts) === payload;
    }
    const cur = await factsOf(fs, b);
    return cur !== null && storeTarget(b, cur) === payload;
  };
  const payloadOps: RenameOp[] = [];
  /** Payloads with a stale `.refs` move after their lines are valid again (blobs back, then the refs add). */
  const latePayloadOps: RenameOp[] = [];
  const refsOps: RefsAddOp[] = [];
  /** Per payload: the removed lines that are valid references after the restore (written now or already there). */
  const handled = new Map<string, string[]>();
  for (const st of [...stores.values()].sort((a, b) => byPath(a.it.originalPath, b.it.originalPath))) {
    // a present payload without .refs is never given one (hf never deletes it), unless it is ours
    if (st.avail === 'absent' || (st.avail === 'present' && st.refs === null && st.ours !== true)) continue;
    const lines: string[] = [];
    for (const l of st.it.refsRemoved) if (await validAfter(l, st.it.originalPath)) lines.push(l);
    if (st.avail === 'candidate') {
      if (lines.length === 0) {
        storeWarnings.push([st.it.originalPath, RESTORE_REASONS.storeUnused(st.it.originalPath)]);
        continue;
      }
      (st.refs === null ? payloadOps : latePayloadOps)
        .push({ kind: 'restore-rename', path: st.it.heldPath!, dest: st.it.originalPath, expect: st.held!, role: 'store-payload' });
    }
    handled.set(st.it.originalPath, lines);
    const addRefs = lines.filter((l) => !(st.refs ?? []).includes(l));
    if (addRefs.length > 0) refsOps.push({ kind: 'store-refs-add', refsPath: st.it.refsPath, addRefs, expectRefsRaw: st.refs });
  }

  // 5. Snapshot links: the target must be restored by this plan or be on disk; a target blob on disk that is a store
  //    link must resolve too (its payload in the hub now, or moved back by this plan)
  const payloadsBack = new Set([...payloadOps, ...latePayloadOps].map((o) => o.dest));
  const resolves = async (t: string): Promise<boolean> => {
    const f = await factsOf(fs, t);
    if (f === null) return false;
    const payload = storeTarget(t, f);
    return payload === null || payloadsBack.has(payload) || (await factsOf(fs, payload)) !== null;
  };
  const linkOps: RenameOp[] = [];
  for (const c of candidates.filter((x) => x.item.role === 'snapshot-link')) {
    if (c.item.facts.isSymlink) {
      const t = targetOf(c.item.originalPath, c.item.facts.linkTarget!);
      if (!restoredBlobs.has(t) && !(await resolves(t))) {
        itemWarnings.push([c.item.originalPath, RESTORE_REASONS.targetMissing(c.item.originalPath)]);
        continue;
      }
    }
    linkOps.push({ kind: 'restore-rename', path: c.item.heldPath, dest: c.item.originalPath, expect: c.now, role: c.item.role });
  }

  const rr = (c: Candidate): RenameOp =>
    ({ kind: 'restore-rename', path: c.item.heldPath, dest: c.item.originalPath, expect: c.now, role: c.item.role });
  const byDest = (a: RenameOp, b: RenameOp): number => byPath(a.dest, b.dest);
  const folderOps = restored.filter((c) => c.item.role === 'repo-folder').map(rr).sort(byDest);
  const ops: Op[] = [
    ...payloadOps,
    ...folderOps,
    ...restored.filter((c) => c.item.role === 'repo-blob').map(rr).sort(byDest),
    ...refsOps.sort((a, b) => byPath(a.refsPath, b.refsPath)),
    ...latePayloadOps,
    ...linkOps.sort(byDest),
  ];

  // 6. Cleanup. The lstat walk of the deletion folder says which directories the restore leaves empty. When every
  //    non-directory entry is restored (or is the manifest) the manifest is unlinked and every directory removed,
  //    deepest first, the folder itself last. Otherwise (a partial restore) only the directories this restore
  //    emptied are removed, then the manifest is rewritten for what is still held.
  const moved = new Set(ops.flatMap((o) => (o.kind === 'restore-rename' ? [o.path] : [])));
  const heldPaths = new Set([...m.items.map((i) => i.heldPath), ...m.storeItems.flatMap((i) => (i.heldPath === null ? [] : [i.heldPath]))]);
  const mp = join(dir, MANIFEST_NAME);
  const dirs: Array<{ path: string; touched: boolean }> = [];
  let strays = false;
  /** `empty`: nothing but restored entries (and the manifest) is left in it; `touched`: the restore took something out. */
  const walk = async (d: string): Promise<{ empty: boolean; touched: boolean }> => {
    let empty = true;
    let touched = false;
    for (const name of (await fs.readdir(d)).sort()) {
      const p = join(d, name);
      if (moved.has(p)) { touched = true; continue; }
      if (p === mp) continue;
      if (!heldPaths.has(p) && (await fs.lstat(p)).isDirectory()) {      // lstat: a symlink is a leaf
        const sub = await walk(p);
        empty &&= sub.empty;
        touched ||= sub.touched;
      } else {
        empty = false;
        if (!heldPaths.has(p)) strays = true;
      }
    }
    if (empty && (await fs.realpath(dirname(d))) !== dirname(d)) empty = false;
    if (empty) dirs.push({ path: d, touched });
    return { empty, touched };
  };
  const complete = (await orStale(() => walk(dir))).empty;
  const deepestFirst = (xs: string[]): Op[] =>
    xs.sort((a, b) => depthOf(b) - depthOf(a) || byPath(a, b)).map((path): Op => ({ kind: 'rmdir-empty', path }));
  const goneRepos: string[] = [];
  /** What the deletion folder still holds after this restore, as the `after` manifest's lists and totals. */
  const remaining = async (): Promise<Pick<HoldManifest, 'items' | 'storeItems' | 'bytesHeld' | 'bytesFreedWhenEmptied'>> => {
    const items: HoldItem[] = [];
    for (const it of m.items) {
      // restored, never moved and missing items are no longer held; a refused item that is still there stays
      if (!moved.has(it.heldPath) && (await factsOf(fs, it.heldPath)) !== null) items.push(it);
    }
    const storeItems: HoldStoreItem[] = [];
    const sizes = new Map<string, number>();
    const count = (f: FileFacts): void => { if (f.isFile) sizes.set(`${f.dev}:${f.ino}`, f.size); };
    for (const it of items) { count(it.facts); for (const e of it.tree ?? []) count(e.facts); }
    for (const it of m.storeItems) {
      const left = it.refsRemoved.filter((l) => !(handled.get(it.originalPath) ?? []).includes(l));
      const heldOn = it.heldPath !== null && !moved.has(it.heldPath) && (await factsOf(fs, it.heldPath)) !== null;
      // lines not written yet stay recorded while the payload is (or will be) in the hub, so a later restore of their
      // blobs can add them. heldPath null means the payload was not held: it may be in the hub or gone; a gone one is
      // dropped below when it has no lines left to add (and planRestore treats its blobs as storeGone)
      const inHub = it.heldPath === null || moved.has(it.heldPath) || stores.get(it.originalPath)?.avail === 'present';
      if (!heldOn && !(left.length > 0 && inHub)) continue;
      storeItems.push({ ...it, heldPath: heldOn ? it.heldPath : null, refsRemoved: left });
      if (heldOn) count(it.facts);
    }
    const bytesHeld = [...sizes.values()].reduce((a, b) => a + b, 0);
    return { items, storeItems, bytesHeld, bytesFreedWhenEmptied: Math.min(m.bytesFreedWhenEmptied, bytesHeld) };
  };
  if (complete) {
    ops.push({ kind: 'unlink', path: mp, expect: manifestFacts, role: 'held-item' });
    ops.push(...deepestFirst(dirs.map((x) => x.path)));
  } else {
    ops.push(...deepestFirst(dirs.filter((x) => x.touched && x.path !== dir).map((x) => x.path)));
    // A restored item whose repo folder is gone from the hub
    const names = new Set(ops.flatMap((o) => (o.kind === 'restore-rename' && o.role !== 'repo-folder' && REPO_ROLES.has(o.role)
      ? [relative(hub, o.dest).split(sep)[0]!] : [])));
    for (const name of [...names].sort()) {
      if ((await factsOf(fs, join(hub, name))) === null) goneRepos.push(RESTORE_REASONS.repoFolderGone(repoIdOf(name)));
    }
    const rest = await remaining();
    // A `moving` manifest is rewritten as `partial` even when nothing else changes, so a reviewed
    // restore acknowledges an interrupted hold and the deletion can then be emptied
    if (m.status === 'moving' ||
      JSON.stringify(rest.items) !== JSON.stringify(m.items) || JSON.stringify(rest.storeItems) !== JSON.stringify(m.storeItems)) {
      const after: HoldManifest = { ...m, ...rest, status: 'partial' };
      ops.push({ kind: 'write-file', path: mp, before: manifestText, after: serializeManifest(after), role: 'hold-manifest' });
    }
  }

  // No restore into a repo that is downloading; no store change while anything in the hub is
  for (const o of ops) {
    if (o.kind !== 'restore-rename' || !REPO_ROLES.has(o.role)) continue;
    const repo = model.repos.find((r) => r.folder === join(hub, relative(hub, o.dest).split(sep)[0]!));
    if (repo === undefined) continue;
    try {
      assertNoActiveDownload(model, { repos: [{ repoId: repo.id, whole: true }] }, now);
    } catch (e) {
      if (e instanceof PlanError && e.code === 'ACTIVE_DOWNLOAD') throw new HeldError('ACTIVE_DOWNLOAD', e.message);
      throw e;
    }
  }
  if ((payloadOps.length > 0 || latePayloadOps.length > 0 || refsOps.length > 0) && (await hubDownloadActive(hub, fs, now))) {
    throw new HeldError('ACTIVE_DOWNLOAD', 'A download is in progress in this cache; try again when it finishes.');
  }

  // apparentBytes: the restored regular files, each inode once
  const sizes = new Map<string, number>();
  const count = (f: FileFacts): void => { if (f.isFile) sizes.set(`${f.dev}:${f.ino}`, f.size); };
  for (const o of ops) if (o.kind === 'restore-rename') count(o.expect);
  for (const c of restored) for (const e of c.walk ?? []) count(e.facts);

  const warnings = [
    ...inPathOrder(itemWarnings),
    ...inPathOrder(storeWarnings),
    ...folderWarnings,
    ...goneRepos,
    ...(strays && !complete ? [RESTORE_REASONS.strays] : []),
    ...(m.viewEntriesRemoved.length > 0 ? [RESTORE_SYNC_HINT] : []),
  ];
  const body: Omit<DeletionPlan, 'id' | 'fingerprint'> = {
    mode: 'hold', purpose: 'restore', hubRoot: hub, holdRoot: roots.holdRoot, deletionId: m.deletionId,
    createdAt: now, expiresAt: now + PLAN_TTL_MS, selection: null, ops,
    freed: { bytes: 0, lines: [] }, apparentBytes: [...sizes.values()].reduce((a, b) => a + b, 0),
    kept: [], viewImpact: [], warnings, confirmPhrase: null,
    // Only when a repo folder moves, over exactly those ops' held paths
    ...(folderOps.length > 0 ? { contentDigest: await restoreContentDigest(fs, folderOps.map((o) => o.path)) } : {}),
  };
  return { id: randomUUID(), fingerprint: fingerprintPlan(body), ...body };
}

// ---------- empty ----------

/** Why `planEmpty` left a deletion alone; returned in `skipped`, never as plan warnings. */
export const EMPTY_SKIPPED = {
  corrupt:     (id: string, err: string) => `Skipped ${id}: its manifest is unreadable (${err}). It was left untouched.`,
  interrupted: (id: string) => `Skipped ${id}: a move into Recently Deleted did not finish. Restore it or review it first.`,
  gone:        (id: string) => `Skipped ${id}: it is no longer in Recently Deleted.`,
  changed:     (id: string) => `Skipped ${id}: it changed after it was listed. Review Recently Deleted again.`,
} as const;

/** Texts an empty plan carries in `warnings` (the review shows them). */
export const EMPTY_WARNINGS = {
  /** Another deletion, not emptied with this one, needs this payload to restore its files. */
  neededBy: (p: string, other: string) =>
    `${other} needs ${p} to be restored; emptying this deletion deletes that file for good.`,
} as const;

/** A deletion that cannot be planned any more (it changed after listing) is skipped, never fatal. */
function skipText(id: string, e: unknown): string {
  if (!(e instanceof HeldError)) throw e;
  // Invariant: the codes rereadHeld and emptyPlanOf throw once the hold root is known to be set
  return e.code === 'NOT_FOUND' ? EMPTY_SKIPPED.gone(id) : e.code === 'STALE_MANIFEST' ? EMPTY_SKIPPED.changed(id)
    : EMPTY_SKIPPED.corrupt(id, e.message);
}

/** A repo folder name at the top of a deletion folder, as in the hub. */
const REPO_DIR = /^(datasets|kernels|models|spaces)--./;
const staleHeld = (): HeldError => new HeldError('STALE_MANIFEST', 'Recently Deleted changed — please review again.');

/**
 * Plans permanently deleting held deletions: one plan per deletion, oldest first (manifest createdAt, ties by
 * id), each `mode: 'permanent'`, `purpose: 'empty'`, `deletionId` set, `confirmPhrase: null`, no `contentDigest`.
 * `'all'` takes every deletion listHeld reports. An empty leftover is re-checked from its id (a real directory with
 * no manifest) and planned with only `rmdir-empty` ops, deepest first, the folder itself last; anything but
 * directories in it now skips it as changed. Any other corrupt deletion, or one whose re-read manifest is still `moving`
 * (a hold that did not finish), is skipped with an EMPTY_SKIPPED text in `skipped`; a deletion passed twice is planned
 * once. A deletion that changed after it was listed (gone, corrupt, another hub, text or entries changed mid-plan) is
 * skipped too (EMPTY_SKIPPED.gone / changed / corrupt), never failing the others. Plans are built up front: when
 * deletions share an inode, a later plan goes STALE (nlink changed) once an earlier one ran, and must be planned and
 * reviewed again (never run unreviewed).
 *
 * Only `deletionId` and `manifestText` of each deletion are used (rereadHeld: real folder, hubRoot check, exact
 * text); the manifest's lists are not used at all. The ops come from an lstat walk of `<holdRoot>/<deletionId>` that
 * never follows a link and never leaves that folder, so everything it holds is listed, strays included, and a
 * store payload the manifest records with `heldPath: null` (it was never held) gets no op:
 * - `unlink` (role `held-item`, `expect` = the entry's lstat facts) of every non-directory entry but the manifest,
 *   deepest first; then `rmdir-empty` of every sub-directory, deepest first; then the `manifest.json` unlink and
 *   `rmdir-empty` of the deletion folder, so a run that stops early leaves the deletion listable. The executor refuses
 *   (STALE, before any change) a directory holding anything the plan does not remove, and fails (IO) one that is not
 *   empty when its rmdir runs.
 * Every directory walked must be its own realpath, so no op path is reached through a symlink, and every entry
 * must be on the deletion folder's device (a mount inside it is never walked); the executor
 * re-checks each unlink's and rmdir's parent the same way at apply time, and revalidates every op's facts first.
 *
 * Freed bytes are recomputed from lstat, never taken from the manifest; per plan, regular files grouped by
 * dev:ino: nlink 1 frees its size (`store-unreferenced` under `<id>/store/`, `only-link` inside a repo folder,
 * `plain-file` otherwise, e.g. the manifest or a stray); nlink > 1 frees its size once (first path) only when this plan
 * removes every link (`hardlink-all-planned`), else 0 (`hardlink-others-remain`, also when the other link is in another
 * deletion: the safe direction). A symlink frees nothing (`link-only`), nor does a fifo, socket or device node
 * (`special-file`).
 * `apparentBytes` is the size of every regular file, each inode once.
 * For every held payload a plan removes that another listed deletion, not emptied by this call, records as kept in
 * the hub (heldPath null: it needs the payload to restore), the plan carries an EMPTY_WARNINGS.neededBy warning.
 *
 * Throws HeldError NO_HOLD_ROOT; per deletion, CORRUPT/HUB_MISMATCH, NOT_FOUND and STALE_MANIFEST (the manifest or an
 * entry changed or vanished mid-plan, a directory is not its own realpath, an entry is on another device) become
 * skipped texts; any other read error propagates unchanged.
 */
export async function planEmpty(deletions: HeldDeletion[] | 'all', roots: SafeRoots, now: number, fs: ReadFs = readFs):
  Promise<{ plans: DeletionPlan[]; skipped: string[] }> {
  if (roots.holdRoot === null) throw new HeldError('NO_HOLD_ROOT', 'Recently Deleted is not available for this cache.');
  const list = deletions === 'all' ? await listHeld(roots, fs) : deletions;
  const skipped: string[] = [];
  const seen = new Set<string>();
  const ready: Array<Awaited<ReturnType<typeof rereadHeld>>> = [];
  const leftovers: EmptyTarget[] = [];
  for (const d of list) {
    if (seen.has(d.deletionId)) continue;
    seen.add(d.deletionId);
    if (!d.ok && d.emptyLeftover === true) {
      try {
        leftovers.push(await rereadLeftover(roots, d.deletionId, fs));
      } catch (e) {
        skipped.push(skipText(d.deletionId, e));
      }
      continue;
    }
    if (!d.ok) { skipped.push(EMPTY_SKIPPED.corrupt(d.deletionId, d.error)); continue; }
    let r: Awaited<ReturnType<typeof rereadHeld>>;
    try {
      r = await rereadHeld(roots, d.deletionId, d.manifestText, fs);
    } catch (e) {
      skipped.push(skipText(d.deletionId, e));
      continue;
    }
    if (r.manifest.status === 'moving') { skipped.push(EMPTY_SKIPPED.interrupted(d.deletionId)); continue; }
    ready.push(r);
  }
  ready.sort((a, b) => a.manifest.createdAt - b.manifest.createdAt || compareStrings(a.manifest.deletionId, b.manifest.deletionId));
  // Listed deletions not emptied here that need a payload (heldPath null) another deletion holds
  const emptied = new Set(ready.map((r) => r.manifest.deletionId));
  const listed = deletions === 'all' ? list : await listHeld(roots, fs);
  const dependants = listed.filter((d): d is Extract<HeldDeletion, { ok: true }> => d.ok && !emptied.has(d.deletionId));
  const neededBy = (payload: string): string[] => dependants
    .filter((d) => d.manifest.storeItems.some((x) => x.heldPath === null && x.originalPath === payload)).map(deletionLabel);
  const plans: DeletionPlan[] = [];
  // empty leftovers last, in list order (listHeld lists them by name)
  const targets: EmptyTarget[] = [...ready.map((r) => ({ ...r, deletionId: r.manifest.deletionId })), ...leftovers];
  for (const t of targets) {
    try {
      plans.push(await emptyPlanOf(t, roots, now, fs, neededBy));
    } catch (e) {
      skipped.push(skipText(t.deletionId, e));
    }
  }
  return { plans, skipped };
}

/** What emptyPlanOf works from: the folder and its live device, and the manifest's facts (null: an empty leftover). */
interface EmptyTarget { dir: string; dirDev: number; deletionId: string; manifestFacts: FileFacts | null }

/**
 * Re-checks an empty leftover from its id alone: a real directory with no `manifest.json`. Its contents are
 * checked by emptyPlanOf's walk (only directories). Throws HeldError NOT_FOUND or STALE_MANIFEST.
 */
async function rereadLeftover(roots: SafeRoots, deletionId: string, fs: ReadFs): Promise<EmptyTarget> {
  // Invariant: planEmpty refused a null hold root. The id may come from the caller, so it is checked as rereadHeld does
  if (!DELETION_ID_RE.test(deletionId)) throw new HeldError('CORRUPT', `${JSON.stringify(deletionId)} is not a deletion id.`);
  const dir = join(roots.holdRoot!, deletionId);
  const d = await factsOf(fs, dir);
  if (d === null || !d.isDirectory) throw new HeldError('NOT_FOUND', 'That deletion is no longer in Recently Deleted.');
  if ((await factsOf(fs, join(dir, MANIFEST_NAME))) !== null) throw staleHeld();
  return { dir, dirDev: d.dev, deletionId, manifestFacts: null };
}

async function emptyPlanOf(
  held: EmptyTarget, roots: SafeRoots, now: number, fs: ReadFs, neededBy: (payload: string) => string[],
): Promise<DeletionPlan> {
  const { dir, dirDev, deletionId, manifestFacts } = held;
  const files: Array<{ path: string; facts: FileFacts }> = [];
  const dirs: string[] = [];
  const walk = async (d: string): Promise<void> => {
    if ((await fs.realpath(d)) !== d) throw staleHeld();
    dirs.push(d);
    for (const name of (await fs.readdir(d)).sort()) {
      const p = join(d, name);
      const f = await factsOf(fs, p);
      if (f === null) throw staleHeld();
      // A hold only renames within one device, so an entry on another one is a mount: never planned
      if (f.dev !== dirDev) throw staleHeld();
      if (f.isDirectory) await walk(p);                                                     // lstat: a symlink is a leaf
      else files.push({ path: p, facts: f });
    }
  };
  await orStale(() => walk(dir));
  const mp = join(dir, MANIFEST_NAME);
  const man = files.find((x) => x.path === mp);
  // the manifest unlinked last is the one rereadHeld read; an empty leftover must still hold only directories
  if (manifestFacts === null ? files.length > 0 : man === undefined || !factsMatch(man.facts, manifestFacts)) throw staleHeld();

  const deepestFirst = (a: string, b: string): number => depthOf(b) - depthOf(a) || byPath(a, b);
  // The manifest goes after every sub-directory, just before the folder itself, so a run that stops while
  // removing directories (one not empty: the executor fails it) leaves the deletion listable
  const ops: Op[] = [
    ...files.filter((x) => x !== man).sort((a, b) => deepestFirst(a.path, b.path))
      .map((x): Op => ({ kind: 'unlink', path: x.path, expect: x.facts, role: 'held-item' })),
    ...dirs.filter((d) => d !== dir).sort(deepestFirst).map((path): Op => ({ kind: 'rmdir-empty', path })),
    ...(man === undefined ? [] : [{ kind: 'unlink', path: mp, expect: man.facts, role: 'held-item' } satisfies Op]),
    { kind: 'rmdir-empty', path: dir },
  ];

  // Freed (recomputed from lstat) and apparent bytes
  const lines: FreedLine[] = [];
  const inodes = new Map<string, Array<{ path: string; facts: FileFacts }>>();
  for (const x of files) {
    if (!x.facts.isFile) { lines.push({ path: x.path, bytes: 0, reason: x.facts.isSymlink ? 'link-only' : 'special-file' }); continue; }
    const k = `${x.facts.dev}:${x.facts.ino}`;
    inodes.set(k, [...(inodes.get(k) ?? []), x]);
  }
  const store = join(dir, 'store');
  const soleReason = (p: string): FreedReason => isStrictlyInside(p, store) ? 'store-unreferenced'
    : REPO_DIR.test(relative(dir, p).split(sep)[0]!) ? 'only-link' : 'plain-file';     // split always yields a first element
  let apparentBytes = 0;
  for (const group of inodes.values()) {
    group.sort((a, b) => byPath(a.path, b.path));
    const { size, nlink } = group[0]!.facts;
    apparentBytes += size;
    const reason: FreedReason = nlink === 1 ? soleReason(group[0]!.path)
      : group.length >= nlink ? 'hardlink-all-planned' : 'hardlink-others-remain';
    const frees = nlink === 1 || group.length >= nlink;
    group.forEach((g, i) => lines.push({ path: g.path, bytes: frees && i === 0 ? size : 0, reason }));
  }
  lines.sort((a, b) => byPath(a.path, b.path));
  // A held payload `<D>/store/<xx>/<hash>` is the hub's `blobs/<xx>/<hash>`
  const warnings = files.map((x) => relative(store, x.path).split(sep)).filter((r) => r.length === 2 && r[0] !== '..')
    .map((r) => join(roots.hubRoot, 'blobs', ...r)).sort(byPath)
    .flatMap((p) => neededBy(p).map((other) => EMPTY_WARNINGS.neededBy(p, other)));

  const body: Omit<DeletionPlan, 'id' | 'fingerprint'> = {
    mode: 'permanent', purpose: 'empty', hubRoot: roots.hubRoot, holdRoot: roots.holdRoot, deletionId,
    createdAt: now, expiresAt: now + PLAN_TTL_MS, selection: null, ops,
    freed: { bytes: lines.reduce((a, l) => a + l.bytes, 0), lines }, apparentBytes,
    kept: [], viewImpact: [], warnings, confirmPhrase: null,
  };
  return { id: randomUUID(), fingerprint: fingerprintPlan(body), ...body };
}

/** The default stored by settings; autoEmptyDue itself requires `days`. */
export const AUTO_EMPTY_DEFAULT_DAYS = 14;
export const DAY_MS = 86_400_000;

/**
 * Pure: which deletions auto-empty may permanently delete now. Never corrupt or interrupted ones. A deletion that holds
 * nothing and has no unaccounted entries (both counted from disk) is due at any age; any other is due only once
 * `days` full days have passed since createdAt (a future createdAt is never due). `'never'` selects nothing.
 * A deletion holding a payload that another listed deletion records as kept in the hub (heldPath null, so it needs
 * it to restore) is deferred while that deletion is not due itself.
 */
export function autoEmptyDue(deletions: HeldDeletion[], now: number, days: number | 'never'): HeldDeletion[] {
  if (days === 'never') return [];
  if (!Number.isInteger(days) || days < 0) throw new HeldError('BAD_DAYS', `days must be a non-negative integer or 'never', got ${String(days)}`);
  type Ok = Extract<HeldDeletion, { ok: true }>;
  const byAge = deletions.filter((d): d is Ok => {
    if (!d.ok || d.interrupted) return false;
    if (d.heldCount === 0 && d.otherEntries === 0) return true;
    const age = now - d.manifest.createdAt;
    return age >= 0 && age >= days * DAY_MS;
  });
  // `a` needs a payload `b` holds (a records it with heldPath null, b with a held path)
  const needs = (a: Ok, b: Ok): boolean => a.manifest.storeItems.some((x) => x.heldPath === null &&
    b.manifest.storeItems.some((y) => y.heldPath !== null && y.originalPath === x.originalPath));
  const listed = deletions.filter((d): d is Ok => d.ok);
  const due = new Set(byAge);
  // a deletion waits while a listed deletion that needs its payload is not due itself (to a fixed point: deferring one
  // can defer the deletions whose payloads it needs)
  for (let changed = true; changed;) {
    changed = false;
    for (const b of due) {
      if (listed.some((a) => !due.has(a) && needs(a, b))) { due.delete(b); changed = true; }
    }
  }
  return byAge.filter((d) => due.has(d));
}
