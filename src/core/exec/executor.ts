// executePlan: the only code that changes the disk for a deletion plan. Order of work:
//   1. diskFreeBefore  2. fingerprint (+ expiry)  3. containment and role/root pre-check of every path
//   4. AppLock (not in a dry run)  5. revalidate every op against the disk
//   6. purpose 'delete': rescan, active-download check and re-derivation of the plan, compared exactly
//   7. the shared op loop: dry run records, the real applier journals and mutates through SafeFs only;
//      store ops go through store-ops.ts (fresh read, download check and sweep immediately before acting)
//   8. hold mode, on any failure after the first change: the rollback, reverse order, rename-only
//   9. diskFreeAfter, journal end, lock release (in a finally spanning acquire → return).
// Nothing changes on disk before step 7, and every refusal in steps 1–6 returns ok:false with nothing touched.
// This module never imports node fs: reads go through deps.fs (ReadFs), every mutation through deps.safeFs.
import { basename, dirname, isAbsolute, join, normalize, posix } from 'node:path';
import { factsMatch, factsOf, isFileFacts as isFacts, isNotFound, type ReadFs } from '../fsx';
import { holdRootFor } from '../hold/hold-root';
import { MANIFEST_NAME, restoreContentDigest } from '../hold/tree';
import { isStrictlyInside } from '../paths';
import { PlanError } from '../plan/closure';
import { canonicalJson, fingerprintPlan, hashCanonical } from '../plan/fingerprint';
import { assertNoActiveDownload, planCore, type CorePlan } from '../plan/planner';
import { SafeFs, SafeFsError, type AttemptHook } from '../safe-fs';
import { isStorePath, parseRefs, readStoreFile } from '../scan/store';
import type { CacheModel, DeletionPlan, ExecErrorCode, ExecHooks, ExecResult, FileFacts, Op, OpRole } from '../types';
import { ExecError, STALE_MESSAGE } from './errors';
import type { Journal } from './journal';
import type { AppLock } from './lock';
import { applyStoreRefsAdd, applyStoreSweep, hubDownloadActive, StoreStaleError, writeRefsText, type StoreUndo } from './store-ops';

export interface ExecDeps {
  safeFs: SafeFs;
  /** Read-only; FsLike is assignable. Used for revalidation reads only. */
  fs: ReadFs;
  journal: Journal;
  /** Acquired and released on this same instance (release is owner-checked). */
  lock: AppLock;
  rescan: () => Promise<CacheModel>;
  hooks?: ExecHooks;
  now: () => number;
  diskFree: (p: string) => Promise<number>;
  dryRun?: boolean;
}

export type ExecOutcome = ExecResult & { dryRunOps?: Op[] };

/** Hold mode buffers regular view files it unlinks, for the rollback; larger ones refuse with IO up front. */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Text files (write-file `before`) are compared in memory; anything larger cannot be what the plan reviewed. */
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

const VIEW_ROLES: ReadonlySet<OpRole> = new Set<OpRole>(['view-link', 'view-manifest', 'view-blob']);
const REPO_ROLES: ReadonlySet<OpRole> = new Set<OpRole>(['snapshot-link', 'repo-blob', 'repo-folder']);
/** Repo folder names in the hub (as store.ts CANDIDATE_PREFIX): `<type>s--<owner>--<name>`. */
const REPO_FOLDER = /^(datasets|kernels|models|spaces)--./;
const HASH64 = /^[0-9a-f]{64}$/;

/** Exact equality of facts: factsMatch plus an unchanged nlink. `b` is the fresh lstat (null = missing). */
export function sameFacts(a: FileFacts, b: FileFacts | null): boolean {
  return b !== null && factsMatch(b, a) && a.nlink === b.nlink;
}

/**
 * Whether an op belongs to a view (LM Studio / Ollama) rather than the hub: unlink/rename with a view role, or a
 * view-state write. An rmdir-empty carries no role, so it counts as a view op only when it lies strictly inside one of
 * the given `viewRoots`.
 */
export function isViewOp(op: Op, viewRoots: readonly string[] = []): boolean {
  switch (op.kind) {
    case 'unlink':
    case 'hold-rename':
    case 'restore-rename':
      return VIEW_ROLES.has(op.role);
    case 'write-file':
      return op.role === 'view-state';
    case 'rmdir-empty':
      return viewRoots.some((v) => isStrictlyInside(op.path, v));
    default:
      return false;
  }
}

// Both never throw, even for a hostile error object (a throwing getter), so a failure report cannot itself fail.
const errnoOf = (e: unknown): string | undefined => {
  try {
    if (e instanceof SafeFsError) return e.errno ?? e.code;
    const code = (e as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};
const messageOf = (e: unknown): string => {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return 'unknown error';
  }
};
/** The errno of `e` when it has one, else its message (never throws). */
const errText = (e: unknown): string => errnoOf(e) ?? messageOf(e);
const contain = (why: string, path?: string): ExecError => new ExecError('CONTAINMENT', `Refused: ${why}`, path);
const stale = (path?: string): ExecError => new ExecError('STALE', STALE_MESSAGE, path);

/** The paths an op touches (for errors and the containment walk). */
function primaryPath(op: Op): string {
  switch (op.kind) {
    case 'store-sweep': return op.storePath;
    case 'store-refs-add': return op.refsPath;
    default: return op.path;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Step 3: containment and role/root consistency
// ---------------------------------------------------------------------------------------------------------------

interface Scope { hubRoot: string; viewRoots: readonly string[]; holdRoot: string | null; holdDir: string | null; appDir: string }

/** A normalised absolute path string (SafeFs then refuses '.', '..' and NUL). */
function absPath(p: unknown, what: string): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || !isAbsolute(p) || normalize(p) !== p) {
    throw contain(`${what} is not a normalised absolute path`, typeof p === 'string' ? p : undefined);
  }
  return p;
}

/** The repo-folder-relative segments of a hub path: [<folder>, ...rest], or null when not inside a repo folder. */
function repoSegments(scope: Scope, p: string): string[] | null {
  if (!isStrictlyInside(p, scope.hubRoot)) return null;
  const segs = p.slice(scope.hubRoot.length + 1).split(/[\\/]/);
  return REPO_FOLDER.test(segs[0]!) ? segs : null; // split always yields a first element
}

const inViewRoot = (scope: Scope, p: string): boolean =>
  scope.viewRoots.some((v) => isStrictlyInside(p, v)) &&
  ![scope.hubRoot, scope.appDir, ...(scope.holdRoot === null ? [] : [scope.holdRoot])].some((r) => p === r || isStrictlyInside(p, r));

/** Where a path with `role` may live. Throws CONTAINMENT otherwise. */
function checkRolePath(scope: Scope, role: OpRole, p: string): void {
  if (REPO_ROLES.has(role)) {
    const segs = repoSegments(scope, p);
    if (segs === null) throw contain(`${role} ${p} is not inside a repo folder of the hub`, p);
    if (role === 'snapshot-link' && (segs.length < 4 || segs[1] !== 'snapshots')) throw contain(`snapshot-link ${p} is not in a snapshot`, p);
    if (role === 'repo-blob' && (segs.length !== 3 || segs[1] !== 'blobs')) throw contain(`repo-blob ${p} is not in the repo's blobs/`, p);
    return;
  }
  if (VIEW_ROLES.has(role)) {
    if (!inViewRoot(scope, p)) throw contain(`${role} ${p} is not inside a view root`, p);
    return;
  }
  if (role === 'store-payload') {
    if (!isStorePath(scope.hubRoot, p)) throw contain(`store-payload ${p} is not <hub>/blobs/<xx>/<hash>`, p);
    return;
  }
  if (role === 'held-item') {
    if (scope.holdRoot === null || !isStrictlyInside(p, scope.holdRoot)) throw contain(`held-item ${p} is not inside the hold root`, p);
    return;
  }
  throw contain(`unknown role ${String(role)}`, p);
}

/** `<deletionId>/store/<xx>/<hash>` (holdRoot-relative POSIX), resolved; CONTAINMENT unless it has exactly that shape. */
function holdDestOf(holdRoot: string, holdDir: string, deletionId: string, holdDest: unknown): string {
  if (typeof holdDest !== 'string' || holdDest.includes('\\') || posix.isAbsolute(holdDest) || isAbsolute(holdDest)) {
    throw contain('holdDest is not a relative POSIX path');
  }
  const segs = holdDest.split('/');
  if (segs.length !== 4 || segs.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0')) || segs[0] !== deletionId || segs[1] !== 'store') {
    throw contain(`holdDest ${holdDest} is not ${deletionId}/store/<xx>/<hash>`);
  }
  // Invariant: four plain segments (no '', '.', '..', NUL, '\\'; '/' was split) starting <deletionId>/store, so the
  // joined path is strictly inside <holdDir>/store
  return join(holdRoot, ...segs);
}

/**
 * Proves, before anything else reads or writes, that every path of every op is where its kind and role allow
 *  and that SafeFs agrees it is contained (realpath of its parent stays in the same root). Also refuses
 * ops the plan's mode/purpose can never contain: a hold plan never unlinks hub entries or deletes a payload; a
 * permanent plan never moves anything to the hold root; a delete plan never restores.
 * Restore and empty plans need a hold root and a deletion id, and touch only `<holdRoot>/<deletionId>`
 * (D below) plus, for a restore, the hub destinations of what it puts back:
 * - empty: always permanent (an emptied item can never be put back, so there is nothing a hold-mode rollback could
 *   do); `unlink` strictly inside D, `rmdir-empty` of D or inside it; nothing else.
 * - restore: always hold mode, so any failure is rolled back; `restore-rename` from strictly inside D to a hub
 *   repo path (repo roles) or a store payload path, `store-refs-add`, `rmdir-empty` of D or inside it, and either
 *   exactly one `unlink` of `D/manifest.json`, role `held-item`, expected as a regular file, after which only
 *   `rmdir-empty` ops follow, or
 *   (a partial restore) a `hold-manifest` write-file of exactly `D/manifest.json` as the last op (so it is the
 *   only write-file) and no unlink at all (no other plan writes a hold manifest through an op);
 *   nothing else.
 */
async function precheck(plan: DeletionPlan, safeFs: SafeFs): Promise<void> {
  const roots = safeFs.roots;
  if (plan.hubRoot !== roots.hubRoot) throw contain('the plan is for a different hub than this session');
  if (plan.holdRoot !== null && plan.holdRoot !== roots.holdRoot) throw contain('the plan\'s hold root is not this session\'s hold root');
  const hold = plan.mode === 'hold';
  if (plan.mode !== 'hold' && plan.mode !== 'permanent') throw contain('unknown plan mode');
  if (!['delete', 'restore', 'empty'].includes(plan.purpose)) throw contain('unknown plan purpose');
  const D = plan.deletionId;
  if (D !== null && (typeof D !== 'string' || D === '' || D === '.' || D === '..' || /[\\/\0]/.test(D))) {
    throw contain('the deletion id is not one plain path segment');
  }
  if (hold && (plan.holdRoot === null || D === null)) throw contain('a hold plan needs a hold root and a deletion id');
  const del = plan.purpose === 'delete';
  const aPlan = plan.purpose === 'empty' ? 'an empty plan' : `a ${plan.purpose} plan`;
  if (!del && (plan.holdRoot === null || D === null)) throw contain(`${aPlan} needs a hold root and a deletion id`);
  if (plan.purpose === 'empty' && hold) throw contain('an empty plan is always permanent');
  // A restore must be able to roll back (applies to hold mode only)
  if (plan.purpose === 'restore' && !hold) throw contain('a restore plan is always hold mode');
  if (!Array.isArray(plan.ops)) throw contain('the plan has no op list');

  const scope: Scope = {
    hubRoot: roots.hubRoot, viewRoots: roots.viewRoots, holdRoot: roots.holdRoot,
    holdDir: roots.holdRoot !== null && D !== null ? join(roots.holdRoot, D) : null,
    appDir: dirname(holdRootFor(roots.hubRoot)),
  };
  const toCheck: string[] = [];
  /** Restore/empty plans: strictly inside `<holdRoot>/<deletionId>` (`orSelf`: or that folder itself). */
  const inDeletion = (p: string, orSelf = false): boolean =>
    scope.holdDir !== null && ((orSelf && p === scope.holdDir) || isStrictlyInside(p, scope.holdDir));

  for (const [i, op] of (plan.ops as unknown[]).entries()) {
    const o = op as Op;
    if (typeof o !== 'object' || o === null) throw contain('an op is not an object');
    switch (o.kind) {
      case 'unlink': {
        const p = absPath(o.path, 'unlink path');
        if (!isFacts(o.expect)) throw contain('unlink without valid expected facts', p);
        if (plan.purpose === 'restore') {
          // The one unlink a restore makes: its own manifest, once every item is back (only rmdir-empty after it).
          // Invariant: precheck proved a restore plan names a hold root and a deletion id, so scope.holdDir is set
          if (p !== join(scope.holdDir!, MANIFEST_NAME) || o.role !== 'held-item') throw contain(`${aPlan} never unlinks ${p}`, p);
          if (!o.expect.isFile || o.expect.isSymlink || o.expect.isDirectory) throw contain(`the manifest ${p} is not a regular file`, p);
          // so a second unlink (of anything) is refused here too
          if (plan.ops.slice(i + 1).some((x) => (x as Op | null)?.kind !== 'rmdir-empty')) {
            throw contain('a restore plan unlinks its manifest only after every other change; only rmdir-empty may follow', p);
          }
        } else if (!del && !inDeletion(p)) {
          // purpose 'empty' here (restore handled above)
          throw contain(`${aPlan} never unlinks ${p}`, p);
        }
        checkRolePath(scope, o.role, p);
        if (del && !REPO_ROLES.has(o.role) && !VIEW_ROLES.has(o.role)) throw contain(`a delete plan never unlinks a ${o.role}`, p);
        if (hold && del && !VIEW_ROLES.has(o.role)) throw contain('a hold plan never unlinks hub entries', p);
        toCheck.push(p);
        break;
      }
      case 'hold-rename': {
        const p = absPath(o.path, 'hold-rename path');
        const dest = absPath(o.dest, 'hold-rename dest');
        if (!hold || scope.holdDir === null) throw contain('hold-rename in a plan that is not a hold plan', p);
        if (!del) throw contain(`${aPlan} never moves anything to the hold root`, p);
        if (!isFacts(o.expect)) throw contain('hold-rename without valid expected facts', p);
        if (!REPO_ROLES.has(o.role)) throw contain(`hold-rename of a ${o.role}`, p);
        checkRolePath(scope, o.role, p);
        if (!isStrictlyInside(dest, scope.holdDir)) throw contain(`hold destination ${dest} is not inside ${scope.holdDir}`, dest);
        toCheck.push(p, dest);
        break;
      }
      case 'restore-rename': {
        const p = absPath(o.path, 'restore-rename path');
        const dest = absPath(o.dest, 'restore-rename dest');
        if (plan.purpose !== 'restore') throw contain('restore-rename outside a restore plan', p);
        if (!isFacts(o.expect)) throw contain('restore-rename without valid expected facts', p);
        if (!inDeletion(p)) throw contain(`restore source ${p} is not inside the deletion folder`, p);
        if (!REPO_ROLES.has(o.role) && o.role !== 'store-payload') throw contain(`restore-rename of a ${o.role}`, dest);
        checkRolePath(scope, o.role, dest);
        toCheck.push(p, dest);
        break;
      }
      case 'rmdir-empty': {
        const p = absPath(o.path, 'rmdir-empty path');
        if (del ? repoSegments(scope, p) === null && !inViewRoot(scope, p) : !inDeletion(p, true)) {
          throw contain(`rmdir-empty ${p} is not inside ${del ? 'a repo folder or a view root' : 'the deletion folder'}`, p);
        }
        toCheck.push(p);
        break;
      }
      case 'write-file': {
        const p = absPath(o.path, 'write-file path');
        if (typeof o.after !== 'string' || (o.before !== null && typeof o.before !== 'string')) throw contain('write-file content is malformed', p);
        if (o.role === 'view-state') {
          if (!del) throw contain(`${aPlan} never writes view state`, p);
          if (!inViewRoot(scope, p)) throw contain(`view-state ${p} is not inside a view root`, p);
        } else if (o.role === 'hold-manifest') {
          if (plan.purpose === 'empty') throw contain('an empty plan never writes a hold manifest', p);
          if (!hold || scope.holdDir === null || !isStrictlyInside(p, scope.holdDir)) throw contain(`hold-manifest ${p} is not inside the deletion folder`, p);
          // Only a partial restore writes a manifest (the hold's own is written by its hooks): its own, and never
          // together with the manifest unlink
          if (plan.purpose !== 'restore') throw contain(`${aPlan} never writes a hold manifest`, p);
          if (p !== join(scope.holdDir, MANIFEST_NAME)) throw contain('a restore plan writes only its own manifest', p);
          if ((plan.ops as Op[]).some((x) => x.kind === 'unlink')) {
            throw contain('a restore plan that rewrites its manifest never also unlinks it', p);
          }
          // After every other change, so a second write-file (which would precede it) is refused here too
          if (i !== plan.ops.length - 1) throw contain('a restore plan rewrites its manifest only as its last op', p);
        } else {
          throw contain(`unknown write-file role ${String((o as { role: unknown }).role)}`, p);
        }
        toCheck.push(p);
        break;
      }
      case 'store-sweep': {
        const sp = absPath(o.storePath, 'store-sweep storePath');
        const rp = absPath(o.refsPath, 'store-sweep refsPath');
        if (!del) throw contain(`${aPlan} never sweeps the store`, sp);
        if (!isStorePath(scope.hubRoot, sp)) throw contain(`store payload ${sp} is not <hub>/blobs/<xx>/<hash>`, sp);
        if (rp !== sp + '.refs') throw contain(`refsPath ${rp} is not the payload's .refs`, rp);
        if (!isFacts(o.expect)) throw contain('store-sweep without valid expected facts', sp);
        if (!Array.isArray(o.expectRefsRaw) || !Array.isArray(o.removeRefs)) throw contain('store-sweep refs are malformed', rp);
        if (o.payload === 'hold') {
          if (!hold || D === null) throw contain('a permanent plan never holds a payload', sp);
          // Invariant: hold implies plan.holdRoot === roots.holdRoot !== null (checked above), so scope.holdDir is set
          const dest = holdDestOf(scope.holdRoot!, scope.holdDir!, D, o.holdDest);
          toCheck.push(dest);
        } else if (o.payload === 'delete' || o.payload === 'keep') {
          if (o.holdDest !== undefined) throw contain('holdDest on a payload that is not held', sp);
          if (hold && o.payload === 'delete') throw contain('a hold plan never deletes a payload', sp);
        } else {
          throw contain('unknown store-sweep payload action', sp);
        }
        toCheck.push(sp, rp);
        break;
      }
      case 'store-refs-add': {
        const rp = absPath(o.refsPath, 'store-refs-add refsPath');
        const hash = basename(rp).endsWith('.refs') ? basename(rp).slice(0, -'.refs'.length) : '';
        if (!HASH64.test(hash) || !isStorePath(scope.hubRoot, join(dirname(rp), hash))) {
          throw contain(`refsPath ${rp} is not <hub>/blobs/<xx>/<64hex>.refs`, rp);
        }
        if (plan.purpose !== 'restore') throw contain(`${aPlan} never adds store references`, rp);
        if (!Array.isArray(o.addRefs) || (o.expectRefsRaw !== null && !Array.isArray(o.expectRefsRaw))) throw contain('store-refs-add refs are malformed', rp);
        toCheck.push(rp);
        break;
      }
      default:
        throw contain(`unknown op kind ${String((o as { kind: unknown }).kind)}`);
    }
  }
  for (const p of toCheck) await safeFs.assertContained(p);
}

// ---------------------------------------------------------------------------------------------------------------
// Step 5: revalidation of every op against the disk
// ---------------------------------------------------------------------------------------------------------------

/**
 * Plans that remove a whole deletion folder (every empty plan, and a restore that unlinks its manifest)
 * must leave nothing behind it unreviewed. Revalidation requires every directory they rmdir-empty to hold exactly
 * entries the plan removes, and at apply time a directory that is not empty fails the run (IO) instead of being kept
 * with a note, so the folder is never left without its manifest around something the review did not show.
 */
export function removesDeletionFolder(plan: Pick<DeletionPlan, 'purpose' | 'ops'>): boolean {
  return plan.purpose === 'empty' || (plan.purpose === 'restore' && plan.ops.some((o) => o.kind === 'unlink'));
}

/** lstat facts; a failure other than not-found is IO (fails closed, nothing touched). */
async function factsAt(fs: ReadFs, p: string): Promise<FileFacts | null> {
  try {
    return await factsOf(fs, p);
  } catch (e) {
    throw new ExecError('IO', `Could not check ${p}: ${errText(e)}`, p);
  }
}

const isRealDir = (f: FileFacts | null): boolean => f !== null && f.isDirectory && !f.isSymlink;

async function readText(fs: ReadFs, p: string, facts: FileFacts): Promise<string> {
  if (!facts.isFile || facts.isSymlink || facts.size > MAX_TEXT_BYTES) throw stale(p);
  try {
    return await fs.readFile(p, 'utf8');
  } catch (e) {
    if (isNotFound(e)) throw stale(p);
    throw new ExecError('IO', `Could not read ${p}: ${errText(e)}`, p);
  }
}

/**
 * Every op must still describe the disk exactly (sameFacts). Renames need an absent dest; rmdir-empty a real
 * directory with a real parent; store ops their payload facts and raw .refs lines; write-file its `before`.
 * A hold delete plan: `<holdRoot>/<deletionId>` must not exist yet; a restore or empty plan: it must exist as a
 * real directory. Hold mode: the content of each regular file it will unlink (view files, and a
 * restore's own manifest) is buffered for the rollback. Returns those buffers.
 * A restore that moves repo folders: a folder rename's own facts say nothing about what is inside it, so every
 * `repo-folder` source is walked again (lstat, links never followed) and restoreContentDigest must equal the plan's
 * `contentDigest`, else STALE naming the deletion folder (an entry vanishing mid-walk too; any other read error is IO).
 */
async function revalidate(plan: DeletionPlan, fs: ReadFs): Promise<Map<string, Buffer>> {
  const buffers = new Map<string, Buffer>();
  const hold = plan.mode === 'hold';
  /** removesDeletionFolder: every path the plan takes out of a directory (unlink and rename sources, rmdir targets). */
  const removed = removesDeletionFolder(plan)
    ? new Set(plan.ops.flatMap((o) => (o.kind === 'unlink' || o.kind === 'restore-rename' || o.kind === 'rmdir-empty' ? [o.path] : [])))
    : null;
  for (const op of plan.ops) {
    switch (op.kind) {
      case 'unlink':
      case 'hold-rename':
      case 'restore-rename': {
        const now = await factsAt(fs, op.path);
        if (!sameFacts(op.expect, now)) throw stale(op.path);
        if (op.kind !== 'unlink' && (await factsAt(fs, op.dest)) !== null) throw stale(op.dest);
        if (hold && op.kind === 'unlink' && op.expect.isFile && !op.expect.isSymlink) {
          if (op.expect.size > MAX_BUFFERED_BYTES) {
            throw new ExecError('IO', `Cannot keep a copy of ${op.path} (larger than 16 MiB) to undo its removal`, op.path);
          }
          let buf: Buffer;
          try {
            buf = await fs.readFile(op.path);
          } catch (e) {
            if (isNotFound(e)) throw stale(op.path);
            throw new ExecError('IO', `Could not read ${op.path}: ${errText(e)}`, op.path);
          }
          if (buf.length !== op.expect.size || !sameFacts(op.expect, await factsAt(fs, op.path))) throw stale(op.path);
          buffers.set(op.path, buf);
        }
        break;
      }
      case 'rmdir-empty': {
        if (!isRealDir(await factsAt(fs, op.path))) throw stale(op.path);
        if (!isRealDir(await factsAt(fs, dirname(op.path)))) throw stale(op.path);
        if (removed !== null) {
          // readdir names entries without following anything; one the plan does not remove was added after the review
          let names: string[];
          try {
            names = await fs.readdir(op.path);
          } catch (e) {
            if (isNotFound(e)) throw stale(op.path);
            throw new ExecError('IO', `Could not read ${op.path}: ${errText(e)}`, op.path);
          }
          const extra = names.sort().map((n) => join(op.path, n)).find((p) => !removed.has(p));
          if (extra !== undefined) throw stale(extra);
        }
        break;
      }
      case 'write-file': {
        const now = await factsAt(fs, op.path);
        if (op.before === null) {
          if (now !== null) throw stale(op.path);
        } else if (now === null || (await readText(fs, op.path, now)) !== op.before) {
          throw stale(op.path);
        }
        break;
      }
      case 'store-sweep': {
        // readStoreFile never rejects: each read failure inside it yields store null, refsRaw null or validRefs null
        const { store } = await readStoreFile(plan.hubRoot, op.storePath, fs);
        if (store === null || !sameFacts(op.expect, store.facts)) throw stale(op.storePath);
        if (store.refsRaw === null || canonicalJson(store.refsRaw) !== canonicalJson(op.expectRefsRaw)) throw stale(op.refsPath);
        break;
      }
      case 'store-refs-add': {
        const now = await factsAt(fs, op.refsPath);
        const raw = now === null ? null : parseRefs(await readText(fs, op.refsPath, now));
        if (canonicalJson(raw) !== canonicalJson(op.expectRefsRaw)) throw stale(op.refsPath);
        break;
      }
    }
  }
  const del = plan.purpose === 'delete';
  if (hold || !del) {
    // Invariant: precheck proved a hold plan and every restore/empty plan names a hold root and a deletion id
    const dir = join(plan.holdRoot!, plan.deletionId!);
    const at = await factsAt(fs, dir);
    if (del ? at !== null : !isRealDir(at)) throw stale(dir);
    const folders = plan.purpose === 'restore'
      ? plan.ops.flatMap((o) => (o.kind === 'restore-rename' && o.role === 'repo-folder' ? [o.path] : []))
      : [];
    if (folders.length > 0) {
      let digest: string;
      try {
        digest = await restoreContentDigest(fs, folders);
      } catch (e) {
        if (isNotFound(e)) throw stale(dir);
        throw new ExecError('IO', `Could not check ${dir}: ${errText(e)}`, dir);
      }
      if (digest !== plan.contentDigest) throw stale(dir);
    }
  }
  return buffers;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 6: rescan and re-derive
// ---------------------------------------------------------------------------------------------------------------

/** Plan ops split into the leading view ops and the hub ops; a view op after a hub op is a malformed plan (STALE). */
function hubOpsOf(plan: DeletionPlan, viewRoots: readonly string[]): Op[] {
  const k = plan.ops.findIndex((o) => !isViewOp(o, viewRoots));
  const hub = k === -1 ? [] : plan.ops.slice(k);
  if (hub.some((o) => isViewOp(o, viewRoots))) throw stale();
  return hub;
}

/**
 * For purpose 'delete': the fresh rescan must reproduce the reviewed plan exactly. The selected repos must have no
 * active download. planCore in the plan's own mode must give the same hub ops, freed, apparentBytes and
 * kept, and its warnings must be the plan's leading warnings (the rest are view warnings). planCore in PERMANENT mode
 * must hash to the plan's contentDigest: that enumerates every doomed path with its facts, which a whole-repo hold's
 * single folder rename does not. Any difference or planning failure is STALE.
 */
async function rederive(plan: DeletionPlan, deps: ExecDeps): Promise<void> {
  let model: CacheModel;
  try {
    model = await deps.rescan();
  } catch (e) {
    throw new ExecError('IO', `Could not rescan the cache: ${errText(e)}`);
  }
  if (plan.selection === null || typeof plan.contentDigest !== 'string') throw stale();
  const now = deps.now();
  try {
    assertNoActiveDownload(model, plan.selection, now);
  } catch (e) {
    if (e instanceof PlanError && e.code === 'ACTIVE_DOWNLOAD') throw new ExecError('ACTIVE_DOWNLOAD', e.message);
    throw stale();
  }
  let core: CorePlan;
  let perm: CorePlan;
  try {
    const base = { hubRoot: plan.hubRoot, now };
    perm = planCore(model, plan.selection, { ...base, mode: 'permanent', holdRoot: null, deletionId: null });
    core = plan.mode === 'permanent' ? perm
      : planCore(model, plan.selection, { ...base, mode: 'hold', holdRoot: plan.holdRoot, deletionId: plan.deletionId });
  } catch {
    throw stale();
  }
  const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
  if (!same(hubOpsOf(plan, deps.safeFs.roots.viewRoots), core.ops)) throw stale();
  if (!same(plan.freed, core.freed) || plan.apparentBytes !== core.apparentBytes || !same(plan.kept, core.kept)) throw stale();
  if (!same(plan.warnings.slice(0, core.warnings.length), core.warnings)) throw stale();
  if (hashCanonical(perm.ops) !== plan.contentDigest) throw stale();
}

// ---------------------------------------------------------------------------------------------------------------
// Step 7: the shared op loop
// ---------------------------------------------------------------------------------------------------------------

/** What has been done so far; the hold-mode rollback (step 8) reads it. */
export interface RunState {
  /** Ops that completed, in order, with their plan index and the note they returned (a skipped rmdir-empty has one). */
  applied: Array<{ index: number; op: Op; note?: string }>;
  /**
   * Directories this run created (SafeFs.mkdirp `created`, so only ones it really made), deepest first per op, incl.
   * `<holdRoot>/<deletionId>`. The rollback removes those inside the hold root again when they are empty.
   */
  createdDirs: string[];
  /** Indices of ops whose mutating syscall was attempted (SafeFs onAttempt), i.e. that may have taken effect. */
  attempted: Set<number>;
  /** Content of regular view files unlinked in hold mode, captured at revalidation. */
  buffers: Map<string, Buffer>;
  /** View entries unlinked in hold mode: not kept in Recently Deleted (notes); the rollback re-creates them. */
  viewUnlinks: string[];
  /** Undo records of store ops, registered before each op's first write, filled in as it proceeds. */
  storeUndo: Array<{ index: number; undo: StoreUndo }>;
  notes: string[];
}

interface Applier {
  start(): Promise<void>;
  apply(op: Op, index: number): Promise<void>;
}

/** The one loop both the dry run and the real run go through, so the dry run reports exactly what would run. */
async function runOps(plan: DeletionPlan, applier: Applier): Promise<void> {
  await applier.start();
  for (const [i, op] of plan.ops.entries()) await applier.apply(op, i);
}

/** A failure after the first change: never STALE_MESSAGE. */
class OpFailure extends Error {
  constructor(readonly op: Op, readonly index: number, readonly err: unknown, readonly path: string, label: string = op.kind) {
    super(`${label} failed: ${errText(err)}`);
  }
}

/** mkdirp that records, deepest first, exactly the directories it made in `into`, also when it fails part-way. */
async function mkdirpTracked(safeFs: SafeFs, p: string, into: string[], exclusive = false): Promise<void> {
  const created: string[] = [];
  try {
    await safeFs.mkdirp(p, { created, exclusive });
  } finally {
    into.push(...created.reverse());
  }
}

/**
 * Applies one op through SafeFs. Returns a note for an op that was safely skipped or kept something (rmdir-empty,
 * store-sweep). Store ops register their undo record in `state.storeUndo` before their first write.
 */
async function applyOp(op: Op, index: number, deps: ExecDeps, state: RunState, plan: DeletionPlan): Promise<string | undefined> {
  const { safeFs, fs } = deps;
  // Marked only once every check passed, immediately before the syscall: a refusal never counts
  const attempted: AttemptHook = { onAttempt: () => { state.attempted.add(index); } };
  switch (op.kind) {
    case 'unlink':
      // Restore and empty plans: the parent must be its own realpath, so no directory inside the deletion folder
      // was swapped for a symlink after revalidation (SafeFs alone would only keep the unlink inside the hold root).
      // Residual, as for rmdirEmpty's realParent check: a swap between this check and the unlink(2) is not caught (Node
      // has no unlinkat on a held directory fd); only this app writes inside the hold root, under the AppLock
      if (plan.purpose !== 'delete' && (await fs.realpath(dirname(op.path))) !== dirname(op.path)) {
        throw new SafeFsError('STALE', op.path, 'parent is reached through a symlink');
      }
      await safeFs.unlink(op.path, op.expect, attempted);
      return undefined;
    case 'hold-rename':
    case 'restore-rename': {
      // A root exists by construction and SafeFs never creates one (a whole repo goes back into the hub root);
      // SafeFs.rename still refuses a missing parent (IO)
      const { roots } = safeFs;
      if (![roots.hubRoot, roots.holdRoot, ...roots.viewRoots].includes(dirname(op.dest))) {
        await mkdirpTracked(safeFs, dirname(op.dest), state.createdDirs);
      }
      await safeFs.rename(op.path, op.dest, op.expect, attempted);
      return undefined;
    }
    case 'write-file':
      await safeFs.writeFileAtomic(op.path, op.after, attempted);
      return undefined;
    case 'rmdir-empty':
      return rmdirEmpty(op.path, deps, attempted, plan.purpose !== 'delete', removesDeletionFolder(plan));
    case 'store-sweep': {
      const { roots } = safeFs;
      const r = await applyStoreSweep(op, {
        safeFs, fs, hubRoot: roots.hubRoot, holdRoot: roots.holdRoot,
        activeDownload: () => hubDownloadActive(roots.hubRoot, fs, deps.now()),
        onUndo: (undo) => state.storeUndo.push({ index, undo }),
        createdDirs: state.createdDirs,
      });
      return r.note;
    }
    case 'store-refs-add':
      await applyStoreRefsAdd(op, {
        safeFs, fs, hubRoot: safeFs.roots.hubRoot, onUndo: (undo) => state.storeUndo.push({ index, undo }),
      });
      return undefined;
  }
}

/**
 * rmdir-empty at apply time: the parent must be a real directory and the target a real directory
 * (not a symlink), else the op fails. A target already gone, or not empty (checked by readdir, or ENOTEMPTY/EEXIST
 * from a race), is a note and the run continues: nothing is lost by keeping a directory. `realParent` (restore and
 * empty plans, final review): the parent must also be its own realpath, so no ancestor is a symlink (residual: a swap
 * between that check and the rmdir(2) is not caught). `mustEmpty` (removesDeletionFolder): a directory
 * that is not empty fails the op (IO ENOTEMPTY) instead of being kept.
 */
async function rmdirEmpty(p: string, deps: ExecDeps, hook: AttemptHook = {}, realParent = false, mustEmpty = false): Promise<string | undefined> {
  const gone = `rmdir-empty skipped: ${p} is already gone`;
  const kept = `rmdir-empty skipped: ${p} is not empty, so it was kept`;
  const parent = await factsAt(deps.fs, dirname(p));
  if (parent === null) return gone;
  if (!isRealDir(parent)) throw new SafeFsError('STALE', p, 'parent is not a real directory');
  if (realParent && (await deps.fs.realpath(dirname(p))) !== dirname(p)) {
    throw new SafeFsError('STALE', p, 'parent is reached through a symlink');
  }
  const facts = await factsAt(deps.fs, p);
  if (facts === null) return gone;
  if (!isRealDir(facts)) throw new SafeFsError('STALE', p, 'not a real directory');
  let names: string[];
  try {
    names = await deps.fs.readdir(p);
  } catch (e) {
    if (isNotFound(e)) return gone;
    throw e;
  }
  const notEmpty = new SafeFsError('IO', p, 'directory is not empty', 'ENOTEMPTY');
  if (names.length > 0) {
    if (mustEmpty) throw notEmpty;
    return kept;
  }
  try {
    await deps.safeFs.rmdirEmpty(p, hook);
  } catch (e) {
    const errno = errnoOf(e);
    if (e instanceof SafeFsError && e.code === 'STALE' && e.message.includes('directory is missing')) return gone;
    if (errno === 'ENOTEMPTY' || errno === 'EEXIST') {
      if (mustEmpty) throw notEmpty;
      return kept;
    }
    throw e;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 8: hold-mode rollback
// ---------------------------------------------------------------------------------------------------------------

/**
 * What failed: the message and path for the error (path '' when unknown), and the op index when the failure belongs to
 * one op (null: no op is known to have failed; the rollback then reverses every op this run applied or registered).
 */
export interface Failure {
  message: string; path: string; index: number | null;
  /** The failure was a refusal because the disk no longer matched the review (SafeFs STALE / StoreStaleError). */
  stale: boolean;
}

/** The Failure for anything thrown once ops may have run: an OpFailure names its op; anything else names none. */
export function toFailure(e: unknown): Failure {
  if (e instanceof OpFailure) {
    return { message: e.message, path: e.path, index: e.index, stale: (e.err instanceof SafeFsError && e.err.code === 'STALE') || e.err instanceof StoreStaleError };
  }
  return { message: messageOf(e), path: '', index: null, stale: false };
}

/** Indices to reverse, highest first: every applied or registered op, plus the failing one when it is known. */
export function rollbackIndices(applied: Iterable<number>, registered: Iterable<number>, failing: number | null): number[] {
  const all = new Set([...applied, ...registered, ...(failing === null ? [] : [failing])]);
  return [...all].sort((a, b) => b - a);
}

/** Runs one reversal; a throw becomes a problem for that op, so the rollback goes on with the others. */
export async function reverseGuarded(i: number, op: Op, fn: () => Promise<UndoOutcome>): Promise<UndoOutcome> {
  try {
    return await fn();
  } catch (e) {
    return { acted: true, problems: [`op ${i} (${op.kind} ${primaryPath(op)}) could not be reversed: ${messageOf(e)}`] };
  }
}

/** The failure's path for an ExecError: undefined when it is not known (''). */
export const failurePath = (failure: Failure): string | undefined => (failure.path === '' ? undefined : failure.path);

/**
 * The rollback's result: ROLLED_BACK when nothing is left, else IO naming what is left; the path only when known. The
 * ROLLED_BACK message names the operation: a restore from Recently Deleted, else a move to it.
 */
export function rollbackError(failure: Failure, left: readonly string[], purpose?: DeletionPlan['purpose']): ExecError {
  const path = failurePath(failure);
  const where = path === undefined ? '' : ` (${path})`;
  if (left.length === 0) {
    const what = purpose === 'restore' ? 'Restore from Recently Deleted' : 'Move to Recently Deleted';
    return new ExecError('ROLLED_BACK', `${what} failed: ${failure.message}${where}. Everything already changed was put back.`, path);
  }
  return new ExecError('IO', `Rollback incomplete: ${failure.message}${where}. Not put back: ${left.join('; ')}.`, path);
}

/** Where a hold plan's items are: `<holdRoot>/<deletionId>`, or null when the plan does not name one. */
export function holdDirOf(plan: Pick<DeletionPlan, 'mode' | 'holdRoot' | 'deletionId'>): string | null {
  return plan.mode === 'hold' && plan.holdRoot !== null && plan.deletionId !== null ? join(plan.holdRoot, plan.deletionId) : null;
}

/** Message of the defence-in-depth IO result: what failed, how many ops had been applied, and where held items may be. */
export function unexpectedFailureMessage(e: unknown, applied: number, holdDir: string | null): string {
  if (applied === 0) return `Unexpected failure: ${messageOf(e)}.`;
  return `Unexpected failure: ${messageOf(e)}. ${applied} operation(s) had been applied${holdDir === null ? '' : `; items may remain in ${holdDir}`}. See the journal.`;
}

/**
 * The same item, wherever it now is: identity (dev, ino), type and link text; for a non-directory also size and
 * mtime. A rename keeps all of these; a directory's mtime may change when it is moved under a new parent.
 */
export function sameItem(a: FileFacts, b: FileFacts): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isFile === b.isFile && a.isDirectory === b.isDirectory &&
    a.isSymlink === b.isSymlink && a.linkTarget === b.linkTarget &&
    (a.isDirectory || (a.size === b.size && a.mtimeMs === b.mtimeMs));
}

/**
 * Moves the item at `from` back to `to` with SafeFs.rename (one rename(2), never a copy, refuses an existing `to`,
 * EXDEV is IO). `from` must still hold the item described by `expect`; the rename is revalidated against its fresh
 * facts. An item that is already back at `to` is a success. Anything else throws, and nothing is removed.
 */
async function renameBack(deps: ExecDeps, from: string, to: string, expect: FileFacts): Promise<void> {
  const at = await factsAt(deps.fs, from);
  if (at !== null && sameItem(expect, at)) {
    await deps.safeFs.rename(from, to, at);
    return;
  }
  const home = await factsAt(deps.fs, to);
  if (home !== null && sameItem(expect, home)) return;
  throw new Error(at === null ? `${from} is missing` : `${from} is not the item that was moved there`);
}

/**
 * The regular-file text at `p` with the facts it was read under: lstat → read → lstat, and both lstats must be the
 * same (sameFacts: dev, ino, size, mtime, nlink), so the text belongs to exactly those facts. `null` = missing (both
 * times). A non-regular or oversized entry, or one that changed during the read, throws.
 */
async function capturedText(fs: ReadFs, p: string): Promise<{ text: string; facts: FileFacts } | null> {
  const first = await factsAt(fs, p);
  if (first === null) {
    if ((await factsAt(fs, p)) !== null) throw new Error(`${p} changed while it was being checked`);
    return null;
  }
  if (!first.isFile || first.isSymlink || first.size > MAX_TEXT_BYTES) throw new Error(`${p} is no longer a regular file`);
  const text = await fs.readFile(p, 'utf8');
  if (!sameFacts(first, await factsAt(fs, p))) throw new Error(`${p} changed while it was being checked, so it was left as it is`);
  return { text, facts: first };
}

/**
 * Puts a file this run wrote back to `before` (null = it did not exist: the file is removed). Only while it still
 * holds exactly `after` (null = absent), the state this run left: a file someone has changed or replaced since is never
 * overwritten or removed. The facts the content was read under are passed as `expect` to SafeFs.unlink /
 * writeFileAtomic, which revalidate them immediately before acting (residual window: see SafeFs.writeFileAtomic).
 * `refs` writes with the `.refs` temp name and mode. Returns false, without acting, when `ifTookEffect`
 * and the file is not in the `after` state (a failing op that did not change it).
 */
async function restoreText(
  deps: ExecDeps, p: string, before: string | null, after: string | null, refs: boolean, ifTookEffect = false,
): Promise<boolean> {
  const now = await capturedText(deps.fs, p);
  if ((now === null ? null : now.text) !== after || (now === null) !== (after === null)) {
    if (ifTookEffect) return false;
    throw new Error(`${p} has changed since this operation wrote it, so it was left as it is`);
  }
  const facts = now === null ? null : now.facts;
  if (before === null) {
    // Invariant: every caller passing before null wrote text (after !== null), so the file is there (facts set)
    await deps.safeFs.unlink(p, facts!);
  } else if (refs) {
    await writeRefsText(deps.safeFs, p, before, facts);
  } else {
    await deps.safeFs.writeFileAtomic(p, before, { expect: facts });
  }
  return true;
}

export interface UndoOutcome { acted: boolean; problems: string[] }

/**
 * Which unlink the rollback may re-create, checked here rather than relying on precheck: a view entry,
 * or the restore's own `<holdRoot>/<deletionId>/manifest.json`; null for anything else (never re-created).
 */
export function reCreateKindOf(op: Op, plan: Pick<DeletionPlan, 'purpose' | 'holdRoot' | 'deletionId'>, viewRoots: readonly string[]):
  'view entry' | 'manifest' | null {
  if (isViewOp(op, viewRoots)) return 'view entry';
  const manifest = plan.purpose === 'restore' && plan.holdRoot !== null && plan.deletionId !== null
    ? join(plan.holdRoot, plan.deletionId, MANIFEST_NAME) : null;
  return op.kind === 'unlink' && op.path === manifest ? 'manifest' : null;
}

/**
 * Reverses an unlink that took effect: re-created when `kind` allows it (restoreUnlinked), else (null) not attempted.
 * Returns the problem to report, or null when it was re-created. Owns the "cannot be put back" case: precheck lets a
 * hold-mode plan unlink only what reCreateKindOf accepts, so the rollback never reaches it today.
 */
export async function undoUnlink(
  deps: ExecDeps, state: RunState, op: Extract<Op, { kind: 'unlink' }>, kind: 'view entry' | 'manifest' | null,
): Promise<string | null> {
  if (kind === null) return `${op.path} was removed and cannot be put back`;
  try {
    await restoreUnlinked(deps, state, op.path, op.expect);
    return null;
  } catch (e) {
    return `the ${kind} ${op.path} was not restored: ${messageOf(e)}`;
  }
}

/**
 * Re-creates a view entry (LM Studio / Ollama), or a restore's own manifest, that this run unlinked: a
 * symlink with exactly its reviewed link text (SafeFs.symlink), a regular file from the content buffered at
 * revalidation (SafeFs.writeFileAtomic). Only while nothing else has appeared at the path: an existing entry is never
 * overwritten.
 */
async function restoreUnlinked(deps: ExecDeps, state: RunState, p: string, expect: FileFacts): Promise<void> {
  if ((await factsAt(deps.fs, p)) !== null) throw new Error(`something else is at ${p} now, so it was left as it is`);
  if (expect.isSymlink) {
    // Invariant: expect passed revalidation against factsOf, which always reads a symlink's text (linkTarget set)
    await deps.safeFs.symlink(expect.linkTarget!, p);
    return;
  }
  const buf = state.buffers.get(p);
  if (!expect.isFile || buf === undefined) throw new Error(`no copy of ${p} was kept`);
  await deps.safeFs.writeFileAtomic(p, buf, { expect: null });
}

/**
 * Reverses one op:
 * - The failing op itself (not in `applied`) is reversed too when it took effect although it reported an error
 *   (re-checked on disk): a rename whose item is at the destination and gone from the source, a view unlink or
 *   rmdir-empty whose path is gone, a write-file whose file holds exactly `after`, a sweep whose `.refs` is exactly
 *   what it was about to leave (StoreUndo.refsPending).
 * - hold-rename / restore-rename: rename back.
 * - rmdir-empty that really removed its directory (hub or view root): mkdirp it again (SafeFs: inside its root).
 * - write-file: `before` back (or the file removed when `before` was null), only while it still holds `after`.
 * - store-sweep: `.refs` back to exactly `refsBefore` when it was changed (still holding what the op left), then the
 *   held payload renamed back; store-refs-add: `.refs` back to its text before the op (removed when it was absent),
 *   also when the write reported an error but took effect (registered with refsPending before the write).
 * - unlink of a view entry, or of a restore's manifest (`reCreate` = reCreateKindOf): re-created (undoUnlink →
 *   restoreUnlinked: symlink from expect.linkTarget, regular file from its buffer). Any other unlink is a problem
 *   (undoUnlink); precheck already refuses every hold-mode plan that has one.
 * Every step that fails is a problem and the rest still run. Nothing is ever deleted that this run did not create.
 */
async function undoOne(
  op: Op, entry: RunState['applied'][number] | undefined, undo: StoreUndo | undefined, deps: ExecDeps, state: RunState,
  reCreate: 'view entry' | 'manifest' | null,
  failing: { attempted: boolean; stale: boolean } = { attempted: false, stale: false },
): Promise<UndoOutcome> {
  const out: UndoOutcome = { acted: false, problems: [] };
  /** A failing op refused by revalidation never acted; its path changed after the review and is left, but named. */
  const changedByOthers = (p: string): void => {
    if (entry === undefined && !failing.attempted && failing.stale) {
      out.problems.push(`${p} was changed by something else after the review, so it was left as it is`);
    }
  };
  /** Runs one reversal step; `false` from it means there was nothing to reverse (not journaled). */
  const attempt = async (fn: () => Promise<void | boolean>, problem: (msg: string) => string): Promise<void> => {
    try {
      if ((await fn()) !== false) out.acted = true;
    } catch (e) {
      out.acted = true;
      out.problems.push(problem(messageOf(e)));
    }
  };
  const gone = async (p: string): Promise<boolean> => {
    try {
      return (await factsAt(deps.fs, p)) === null;
    } catch {
      return false; // cannot tell: never re-create over something unknown
    }
  };
  const stillHeld = (from: string, to: string) => (msg: string) => `${from} is still in Recently Deleted (it belongs at ${to}): ${msg}`;
  const tookEffect = async (src: string, dest: string, expect: FileFacts): Promise<boolean> => {
    try {
      const at = await factsAt(deps.fs, dest);
      return at !== null && sameItem(expect, at) && (await factsAt(deps.fs, src)) === null;
    } catch {
      return true; // cannot tell: let renameBack decide (it only acts on the item it can identify)
    }
  };

  switch (op.kind) {
    case 'hold-rename':
    case 'restore-rename':
      if (entry !== undefined || (failing.attempted && (await tookEffect(op.path, op.dest, op.expect)))) {
        await attempt(() => renameBack(deps, op.dest, op.path, op.expect), stillHeld(op.dest, op.path));
      }
      break;
    case 'unlink':
      // a failing unlink that took effect anyway: re-created when it can be, else reported (never a silent ROLLED_BACK)
      if (entry === undefined && !(failing.attempted && (await gone(op.path)))) {
        changedByOthers(op.path);
        break;
      }
      {
        const problem = await undoUnlink(deps, state, op, reCreate);
        out.acted = true;
        if (problem !== null) out.problems.push(problem);
      }
      break;
    case 'rmdir-empty':
      if (entry !== undefined ? entry.note === undefined : failing.attempted && (await gone(op.path))) {
        await attempt(() => deps.safeFs.mkdirp(op.path), (msg) => `the folder ${op.path} could not be recreated: ${msg}`);
      } else {
        changedByOthers(op.path);
      }
      break;
    case 'write-file':
      if (op.before !== op.after && (entry !== undefined || failing.attempted)) {
        // applied: must still be `after`; failing: reversed only if its final rename was attempted and took effect
        await attempt(() => restoreText(deps, op.path, op.before, op.after, false, entry === undefined),
          (msg) => `${op.path} was not restored: ${msg}`);
      }
      break;
    case 'store-sweep': {
      if (undo !== undefined && undo.refsBefore !== null) {
        const before = undo.refsBefore;
        await attempt(async () => { await restoreText(deps, op.refsPath, before, undo.refsAfter ?? null, true); },
          (msg) => `${op.refsPath} was not restored to its earlier content: ${msg}`);
      } else if (undo?.refsPending !== undefined) {
        // the .refs write/unlink was attempted and reported an error: reverse it only if it took effect anyway
        const pending = undo.refsPending;
        await attempt(() => restoreText(deps, op.refsPath, pending.before, pending.after, true, true),
          (msg) => `${op.refsPath} was not restored to its earlier content: ${msg}`);
      }
      const holdRoot = deps.safeFs.roots.holdRoot;
      let held = undo?.payloadMovedTo ?? null;
      // the payload rename is attempted only after the sweep registered its undo (store-ops register() precedes it)
      if (held === null && entry === undefined && undo !== undefined && op.payload === 'hold' && holdRoot !== null && typeof op.holdDest === 'string') {
        const dest = join(holdRoot, ...op.holdDest.split('/'));
        if (await tookEffect(op.storePath, dest, op.expect)) held = dest;
      }
      if (held !== null) {
        const from = held;
        await attempt(() => renameBack(deps, from, op.storePath, op.expect), stillHeld(from, op.storePath));
      }
      break;
    }
    case 'store-refs-add':
      if (undo !== undefined) {
        // Invariant: registered just before its write, always with refsPending. refsAfter is set once the write
        // succeeded; until then the write is reversed only if it took effect anyway.
        const { before, after } = undo.refsPending!;
        await attempt(() => restoreText(deps, op.refsPath, before, after, true, undo.refsAfter === undefined),
          (msg) => `${op.refsPath} was not restored to its earlier content: ${msg}`);
      }
      break;
  }
  return out;
}

/**
 * Removes the directories this run created inside the hold root (deepest first, each only while empty, via
 * SafeFs.rmdirEmpty). A directory that is not empty (a held item that could not be put back, or a hold's
 * manifest.json) is kept and returned. Never throws.
 */
async function removeCreatedDirs(deps: ExecDeps, state: RunState): Promise<string[]> {
  const holdRoot = deps.safeFs.roots.holdRoot;
  if (holdRoot === null) return [];
  const depth = (p: string): number => p.split(/[\\/]/).length;
  const dirs = [...new Set(state.createdDirs)].filter((d) => isStrictlyInside(d, holdRoot)).sort((a, b) => depth(b) - depth(a));
  const kept: string[] = [];
  for (const d of dirs) {
    try {
      if ((await factsAt(deps.fs, d)) === null) continue;
      if ((await deps.fs.readdir(d)).length > 0) {
        kept.push(d);
        continue;
      }
      await deps.safeFs.rmdirEmpty(d);
    } catch (e) {
      const errno = errnoOf(e);
      if (errno !== 'ENOTEMPTY' && errno !== 'EEXIST') state.notes.push(`could not remove the empty folder ${d}: ${errText(e)}`);
      kept.push(d);
    }
  }
  return kept;
}

/**
 * Hold-mode failure after a change. Reverses every op that changed something, in reverse order, through
 * SafeFs only (rename back, never copy, never delete what the plan held), journaling a `rollback` record per op, and
 * then removes the empty directories this run created. Every reversal is attempted even after one fails.
 * - Everything reversed, view entries included: ROLLED_BACK, with the original error and its path.
 * - Anything not reversed: IO "Rollback incomplete: …" naming exactly what is left where; also listed in notes.
 */
async function rollback(plan: DeletionPlan, deps: ExecDeps, state: RunState, failure: Failure): Promise<ExecError> {
  const viewRoots = deps.safeFs.roots.viewRoots;
  const applied = new Map(state.applied.map((a) => [a.index, a]));
  const undos = new Map(state.storeUndo.map((u) => [u.index, u.undo]));
  const left: string[] = [];
  for (const i of rollbackIndices(applied.keys(), undos.keys(), failure.index)) {
    const op = plan.ops[i]!; // every index is that of an op this run applied, registered or failed on
    const failing = { attempted: state.attempted.has(i), stale: i === failure.index && failure.stale };
    // A restore re-creates its own manifest (only unlinks use reCreate), checked here as well as in precheck
    const reCreate = reCreateKindOf(op, plan, viewRoots);
    const r = await reverseGuarded(i, op, () => undoOne(op, applied.get(i), undos.get(i), deps, state, reCreate, failing));
    left.push(...r.problems);
    if (!r.acted && r.problems.length === 0) continue;
    try {
      await deps.journal.rollback(plan.id, i, r.problems.length === 0, r.problems.length > 0 ? r.problems.join('; ') : undefined);
    } catch (e) {
      state.notes.push(`the journal rollback record for op ${i} could not be written: ${errText(e)}`);
    }
  }
  const kept = await removeCreatedDirs(deps, state);
  if (left.length > 0 && kept.length > 0) state.notes.push(`kept in Recently Deleted (not empty): ${kept.join(', ')}`);

  state.notes.push(...left.map((l) => `not rolled back: ${l}`));
  return rollbackError(failure, left, plan.purpose);
}

/** rollback that never throws: an unexpected failure of the rollback itself is IO "Rollback incomplete". */
async function safeRollback(plan: DeletionPlan, deps: ExecDeps, state: RunState, failure: Failure): Promise<ExecError> {
  try {
    return await rollback(plan, deps, state, failure);
  } catch (e) {
    // a rollback runs only for a hold plan, whose holdRoot and deletionId precheck proved set
    const holdDir = join(plan.holdRoot!, plan.deletionId!);
    return new ExecError('IO', `Rollback incomplete: ${failure.message}; the rollback itself failed (${messageOf(e)}). ` +
      `${state.applied.length} operation(s) had been applied; items may remain in ${holdDir}. See the journal.`, failurePath(failure));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// executePlan
// ---------------------------------------------------------------------------------------------------------------

/** Maps a failure before any change (steps 1–6) to its ExecError (pre-check mapping). */
function beforeChange(e: unknown): ExecError {
  if (e instanceof ExecError) return e;
  // Invariant: before a change SafeFs is only asked assertContained, which throws CONTAINMENT and nothing else; every
  // PlanError (rescan, re-derivation) is already mapped inside rederive
  if (e instanceof SafeFsError) return new ExecError('CONTAINMENT', `Refused: ${e.message}`, e.path);
  return new ExecError('IO', messageOf(e));
}

/**
 * Executes a reviewed plan. Returns ok:false with an error for every ExecErrorCode and never throws (an
 * unexpected internal failure is IO). Before the first change it refuses with FINGERPRINT, EXPIRED, CONTAINMENT,
 * LOCKED, STALE, ACTIVE_DOWNLOAD or IO and nothing is touched; after it, a failure stops the run: IO
 * "<kind> failed: <errno|code>" with the op's path in permanent mode (appliedOps = ops completed), and in hold mode the
 * Rollback: ROLLED_BACK, or IO "Rollback incomplete…" naming what is left where. A failure while preparing
 * (after the journal begin record, e.g. creating `<holdRoot>/<deletionId>`, which must not exist yet:) is IO, and
 * the empty directories the run created are removed again.
 * A dry run performs every check except the lock and returns `dryRunOps` (= plan.ops); it creates nothing, runs no
 * hook and writes no journal. The app lock is released in a finally that spans acquire → return.
 */
export async function executePlan(plan: DeletionPlan, deps: ExecDeps): Promise<ExecOutcome> {
  const state: RunState = { applied: [], createdDirs: [], attempted: new Set(), buffers: new Map(), viewUnlinks: [], storeUndo: [], notes: [] };
  const lock = { held: false };
  let result: ExecOutcome;
  try {
    result = await executeLocked(plan, deps, state, lock);
  } catch (e) {
    // Defence in depth: executeLocked catches every failure of its steps; what remains is a malformed plan field it
    // reads unguarded when building the result. Never claim a clean state that is not proven.
    result = {
      ok: false, planId: plan.id, appliedOps: state.applied.length, freedBytesPlanned: 0, heldBytes: 0, diskFreeBefore: 0, diskFreeAfter: 0,
      error: { code: 'IO', message: unexpectedFailureMessage(e, state.applied.length, holdDirOf(plan)) },
    };
  } finally {
    if (lock.held) {
      try {
        await deps.lock.release();
      } catch (e) {
        state.notes.push(`the app lock could not be released: ${errText(e)}`);
      }
    }
  }
  if (state.notes.length > 0) result.notes = state.notes;
  return result;
}

/** executePlan's work; `lock.held` is set as soon as the lock is acquired, and the caller releases it. */
async function executeLocked(plan: DeletionPlan, deps: ExecDeps, state: RunState, lock: { held: boolean }): Promise<ExecOutcome> {
  const hubRoot = deps.safeFs.roots.hubRoot;
  const dryRun = deps.dryRun === true;
  let error: ExecError | null = null;
  let dryRunOps: Op[] | undefined;
  let journaled = false;
  let diskFreeBefore = 0;

  try {
    try {
      diskFreeBefore = await deps.diskFree(hubRoot);
    } catch (e) {
      throw new ExecError('IO', `Could not measure free space: ${errText(e)}`);
    }
    let fp: string;
    try {
      fp = fingerprintPlan(plan);
    } catch {
      fp = '';
    }
    if (fp === '' || fp !== plan.fingerprint) throw new ExecError('FINGERPRINT', 'The plan does not match what was reviewed.');
    // Defence in depth: the registry already refused an expired plan at take(); same boundary and message
    if (!(deps.now() < plan.expiresAt)) throw new ExecError('EXPIRED', 'This plan expired — please review again.');
    await precheck(plan, deps.safeFs);
    if (!dryRun) {
      try {
        await deps.lock.acquire(deps.now());
      } catch (e) {
        throw e instanceof ExecError ? e : new ExecError('IO', `Could not take the app lock: ${errText(e)}`);
      }
      lock.held = true;
    }
    state.buffers = await revalidate(plan, deps.fs);
    if (plan.purpose === 'delete') await rederive(plan, deps);
    // A restore gets no re-derivation, so it checks the whole hub for an active download here
    if (plan.purpose === 'restore' && (await hubDownloadActive(plan.hubRoot, deps.fs, deps.now()))) {
      throw new ExecError('ACTIVE_DOWNLOAD', 'A download is in progress in this cache; try again when it finishes.');
    }
  } catch (e) {
    error = beforeChange(e);
  }

  if (error === null) {
    const hold = plan.mode === 'hold';
    // Only a delete plan makes the deletion folder; a restore or empty plan works in the existing one
    const newHoldDir = hold && plan.purpose === 'delete' ? join(plan.holdRoot!, plan.deletionId!) : null;
    const viewRoots = deps.safeFs.roots.viewRoots;
    const recorded: Op[] = [];
    const dry: Applier = { start: async () => undefined, apply: async (op) => { recorded.push(structuredClone(op)); } };
    let phase = 'start' as 'start' | 'ops'; // set inside start(); the cast keeps TS from narrowing it here
    const real: Applier = {
      start: async () => {
        await deps.journal.begin(plan);
        journaled = true;
        try {
          // The deletion folder is made by this run or the run stops; it is never merged into
          if (newHoldDir !== null) await mkdirpTracked(deps.safeFs, newHoldDir, state.createdDirs, true);
          await deps.hooks?.beforeFirstOp?.(plan);
        } catch (e) {
          // Nothing in the hub or views has changed: remove the empty directories this run made
          await removeCreatedDirs(deps, state);
          throw new ExecError('IO', `Could not prepare the operation: ${messageOf(e)}`, e instanceof SafeFsError ? e.path : undefined);
        }
        phase = 'ops';
      },
      apply: async (op, i) => {
        const path = primaryPath(op);
        try {
          await deps.journal.before(plan.id, i, op);
        } catch (e) {
          throw new OpFailure(op, i, e, path, 'journal');
        }
        let note: string | undefined;
        try {
          note = await applyOp(op, i, deps, state, plan);
        } catch (e) {
          await deps.journal.after(plan.id, i, { ok: false, error: `${op.kind} failed: ${errText(e)}` }).catch(() => undefined);
          throw new OpFailure(op, i, e, e instanceof SafeFsError || e instanceof StoreStaleError ? e.path : path);
        }
        state.applied.push(note === undefined ? { index: i, op } : { index: i, op, note });
        if (note !== undefined) state.notes.push(note);
        if (hold && op.kind === 'unlink' && isViewOp(op, viewRoots)) {
          state.viewUnlinks.push(op.path);
          state.notes.push(`removed ${op.path} (a view entry; it is not kept in Recently Deleted)`);
        }
        try {
          await deps.journal.after(plan.id, i, note === undefined ? { ok: true } : { ok: true, note });
        } catch (e) {
          throw new OpFailure(op, i, e, path, 'journal');
        }
        try {
          await deps.hooks?.afterOp?.(plan, i);
        } catch (e) {
          throw new OpFailure(op, i, e, path, 'afterOp hook');
        }
      },
    };
    try {
      await runOps(plan, dryRun ? dry : real);
      if (dryRun) dryRunOps = recorded;
    } catch (e) {
      if (hold && phase === 'ops') {
        // Any failure once ops may have run is rolled back, whatever threw
        error = await safeRollback(plan, deps, state, toFailure(e));
      } else if (e instanceof OpFailure) {
        // Never the stale-plan message once ops may have run. (Its one op-phase exception, a StoreStaleError as
        // the first op of a permanent plan, cannot occur: only a restore — always hold — can start with a
        // store op; a permanent delete unlinks the repo blobs before its sweeps and an empty plan has no store op.)
        error = new ExecError('IO', e.message, e.path);
      } else {
        // Once the journal begin record is written, a start failure is IO, never the stale-plan message.
        // Invariant: such a failure (and nothing else gets here: apply() wraps every op-phase failure in an OpFailure)
        // comes from start()'s own catch, which throws ExecError IO.
        error = phase === 'start' && !journaled ? beforeChange(e) : e as ExecError;
      }
    }
  }

  let diskFreeAfter = 0;
  try {
    diskFreeAfter = await deps.diskFree(hubRoot);
  } catch (e) {
    state.notes.push(`could not measure free space after the operation: ${errText(e)}`);
  }
  const ok = error === null;
  const result: ExecOutcome = {
    ok,
    planId: plan.id,
    // a complete rollback leaves nothing applied
    appliedOps: error?.code === 'ROLLED_BACK' ? 0 : state.applied.length,
    freedBytesPlanned: plan.mode === 'permanent' ? plan.freed.bytes : 0,
    // Only a hold delete puts bytes into Recently Deleted; a restore takes them out (toasts use apparentBytes)
    heldBytes: ok && plan.mode === 'hold' && plan.purpose === 'delete' && !dryRun ? plan.apparentBytes : 0,
    diskFreeBefore,
    diskFreeAfter,
  };
  if (error !== null) {
    result.error = { code: error.code as ExecErrorCode, message: error.message, ...(error.path !== undefined ? { path: error.path } : {}) };
  }
  if (journaled) {
    try {
      await deps.journal.end(plan.id, { ...result, ...(state.notes.length ? { notes: [...state.notes] } : {}) });
    } catch (e) {
      state.notes.push(`the journal end record could not be written: ${errText(e)}`);
    }
  }
  if (dryRunOps !== undefined) result.dryRunOps = dryRunOps;
  return result;
}
