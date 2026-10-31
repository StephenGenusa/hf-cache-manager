// Shared-store ops: the only code that rewrites a store payload's `.refs` manifest or removes
// or holds the payload. A store-sweep follows huggingface_hub's sweep_shared_blob on a fresh read taken immediately
// before it acts, and on any doubt keeps everything and returns a note. It never does more than the plan says: a
// 'keep' op only ever rewrites `.refs`; a payload is removed or held only when the fresh read shows it unreferenced.
// This module never imports node fs: reads go through ctx.fs (ReadFs), every mutation through ctx.safeFs.
//
// Compat deviation: huggingface_hub writes the rewritten manifest with chmod 0o666 and fsync before
// os.replace. Here the temp file is created with mode 0o666, which the process umask masks (usually to 0o644), and
// SafeFs.writeFileAtomic does not fsync. Revisit with a SafeFs chmod/fsync.
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { factsOf, isNotFound, type ReadFs } from '../fsx';
import { ACTIVE_WINDOW_MS } from '../plan/planner';
import type { SafeFs } from '../safe-fs';
import { lockPresent, parseRefs, readStoreFile, sweepDecision } from '../scan/store';
import type { FileFacts, Op, StoreFile } from '../types';
// Cycle with executor.ts (which imports this module): only functions are used, and only at call time.
import { sameFacts } from './executor';

type StoreSweepOp = Extract<Op, { kind: 'store-sweep' }>;
type StoreRefsAddOp = Extract<Op, { kind: 'store-refs-add' }>;

/**
 * What the rollback needs to undo a store op. The record is handed to `onUndo` once, just before the op's first
 * write, and each field is set only after the write it describes has succeeded, so it never claims a change that did
 * not happen (a rollback must never rewrite a `.refs` this op did not touch: it could erase a ref appended meanwhile).
 * - store-sweep: `refsBefore` is the exact `.refs` text the op read, set once `.refs` has actually been rewritten or
 *   unlinked; null means `.refs` was not changed. `payloadMovedTo` is the held payload's new path once the rename has
 *   succeeded (hold mode), else null.
 * - store-refs-add: registered immediately before the write, with `refsPending`; once the write succeeded,
 *   `refsBefore` is the `.refs` text before it, or null when the file did not exist (undo removes it), and `refsAfter`
 *   is set. `payloadMovedTo` is always null.
 * - `refsAfter` is set together with the `.refs` change: the exact text this op wrote, or null when it unlinked
 *   `.refs`. The rollback restores `refsBefore` only while `.refs` is still exactly that, so it never overwrites a
 *   change someone else made meanwhile.
 */
export interface StoreUndo {
  refsBefore: string | null; payloadMovedTo: string | null; refsAfter?: string | null;
  /**
   * Set immediately before the `.refs` write or unlink is attempted: the text read (null: the file was absent, only for
   * store-refs-add) and what the op is about to leave (text, or null for unlinked, only for store-sweep). Lets the
   * rollback detect a write that took effect although it reported an error (refsAfter still undefined) and restore
   * it, only while `.refs` is exactly `after`.
   */
  refsPending?: { before: string | null; after: string | null };
}

/**
 * The store payload or its `.refs` no longer matches what the plan (or this op's own fresh read) saw. Thrown only
 * before the op has written anything, so the executor may report "nothing touched" when no earlier op changed the
 * disk either.
 */
export class StoreStaleError extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = 'StoreStaleError';
  }
}

export interface StoreSweepCtx {
  safeFs: SafeFs;
  /** Read-only. */
  fs: ReadFs;
  hubRoot: string;
  holdRoot: string | null;
  /** Hub-wide `.incomplete` check, asked after the fresh read, immediately before acting. */
  activeDownload: () => Promise<boolean>;
  /** Called once, before the op's first write, with the undo record that the op then fills in. */
  onUndo?: (undo: StoreUndo) => void;
  /** Receives the directories created for a held payload's destination, deepest first. */
  createdDirs?: string[];
  /** The last check before the payload is removed or held; defaults to confirmSweepDeletable (a seam for tests). */
  confirmDeletable?: (store: StoreFile, storeMarked: boolean) => string | null;
}

/**
 * Defence in depth, right before a payload is unlinked or held: the sweepDecision on the fresh read, with no
 * repo blob left to remove. Null when the payload may go; otherwise why it is kept.
 */
export function confirmSweepDeletable(store: StoreFile, storeMarked: boolean): string | null {
  const d = sweepDecision(store, [], storeMarked);
  return d.deletable ? null : `its references could not be confirmed (${d.reason})`;
}

export interface StoreRefsAddCtx {
  safeFs: SafeFs;
  fs: ReadFs;
  hubRoot: string;
  onUndo?: (undo: StoreUndo) => void;
}

/** Python's sorted() on str is code-point order, which is UTF-8 byte order (JS sort is UTF-16 code-unit order). */
const byCodePoint = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** Manifest bytes: unique lines, sorted, each "<rel posix>\n". */
export function refsText(lines: readonly string[]): string {
  return [...new Set(lines)].sort(byCodePoint).map((l) => `${l}\n`).join('');
}

/** Replaces `.refs` atomically with `refsText(lines)` via the temp name `<hash>.refs.<8hex>.tmp`, mode 0o666. */
export async function writeRefs(safeFs: SafeFs, refsPath: string, lines: string[]): Promise<void> {
  await writeRefsText(safeFs, refsPath, refsText(lines));
}

/**
 * Replaces `.refs` atomically with exactly `text` (the same temp name and mode as writeRefs); used by the rollback,
 * with `expect` = the facts `.refs` must still have just before the replace (null = absent; see writeFileAtomic).
 */
export async function writeRefsText(safeFs: SafeFs, refsPath: string, text: string, expect?: FileFacts | null): Promise<void> {
  const tmpPath = `${refsPath}.${randomBytes(4).toString('hex')}.tmp`;
  await safeFs.writeFileAtomic(refsPath, text, expect === undefined ? { tmpPath, mode: 0o666 } : { tmpPath, mode: 0o666, expect });
}

/**
 * Is any `<hub>/*\/blobs/*.incomplete` younger than ACTIVE_WINDOW_MS at `now`? Fails closed: an
 * unreadable hub or blobs dir, an `.incomplete` that cannot be lstat'd, or a NaN/future mtime counts as active.
 */
export async function hubDownloadActive(hubRoot: string, fs: ReadFs, now: number): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.readdir(hubRoot);
  } catch {
    return true;
  }
  for (const name of names) {
    const blobs = join(hubRoot, name, 'blobs');
    let entries: string[];
    try {
      entries = await fs.readdir(blobs);
    } catch (e) {
      if (isNotFound(e)) continue; // no blobs/ (or not a directory): nothing downloading there
      return true;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.incomplete')) continue;
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.lstat(join(blobs, entry))).mtimeMs;
      } catch (e) {
        if (isNotFound(e)) continue; // finished or removed meanwhile
        return true;
      }
      if (!(now - mtimeMs >= ACTIVE_WINDOW_MS)) return true;
    }
  }
  return false;
}

const sameLines = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === null || b === null ? a === b : a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Applies one store-sweep after the earlier ops removed or moved this payload's doomed repo blobs.
 *
 * 1. Fresh read: lstat `.refs`, readStoreFile, then the exact `.refs` text and a second lstat. The payload must still
 *    have the planned facts and the `.refs` lines must still equal `expectRefsRaw`, else StoreStaleError (nothing
 *    written). A `.refs` that is gone (ENOENT; it existed at planning) is also StoreStaleError. An unreadable `.refs`
 *    (EACCES or any other error), an unmarked store, a lock file or refs that cannot be validated keep
 *    everything (note). Then `activeDownload()`: true keeps everything (note "kept: download in progress").
 * 2. Valid refs remain: `.refs` is rewritten to exactly those refs when its text differs (huggingface_hub's rewrite;
 *    removeRefs lines whose link is gone drop out, lines absent from `.refs` are no-ops, and a doomed line that is a
 *    live link again stays). The payload is kept; a plan that meant to remove it gets a note.
 * 3. No valid refs: a 'keep' op changes nothing (note: never more than the plan). Otherwise, only if sweepDecision on
 *    the fresh read confirms it (confirmSweepDeletable) the payload is unlinked ('delete') or renamed to
 *    `<holdRoot>/<holdDest>` ('hold'), both against `op.expect`, and then `.refs` is unlinked against the facts read in
 *    step 1 (skipped when already gone, as huggingface_hub's missing_ok).
 */
export async function applyStoreSweep(op: StoreSweepOp, ctx: StoreSweepCtx): Promise<{ note?: string; undo: StoreUndo }> {
  const undo: StoreUndo = { refsBefore: null, payloadMovedTo: null };
  const kept = (why: string): { note: string; undo: StoreUndo } => ({ note: `store payload ${basename(op.storePath)} kept: ${why}`, undo });
  const refsFactsNow = async (): Promise<FileFacts | null | undefined> => {
    try {
      return await factsOf(ctx.fs, op.refsPath);
    } catch {
      return undefined; // unreadable
    }
  };
  const unreadable = 'its .refs file is unreadable';
  const refsGone = (): StoreStaleError => new StoreStaleError(op.refsPath, 'refs changed since review: the .refs file is gone');
  // Invariant: called at most once per sweep; the rewrite branch (2) returns before the payload branch (3) can call it
  const register = (): void => ctx.onUndo?.(undo);

  // 1. fresh read
  const refsFacts = await refsFactsNow();
  const { storeMarked, store } = await readStoreFile(ctx.hubRoot, op.storePath, ctx.fs);
  if (store === null || !sameFacts(op.expect, store.facts)) throw new StoreStaleError(op.storePath, 'payload changed since review');
  if (refsFacts === null) throw refsGone(); // proven change: the planned sweep read an existing .refs
  if (store.refsRaw === null || refsFacts === undefined) return kept(unreadable);
  if (!sameLines(store.refsRaw, op.expectRefsRaw)) throw new StoreStaleError(op.refsPath, 'refs changed since review');
  if (!storeMarked) return kept('the shared store is not marked as in use');
  if (store.lockPresent) return kept('it is locked by another process');
  if (store.validRefs === null) return kept('its .refs file could not be validated');
  if (await ctx.activeDownload()) return kept('download in progress');
  let text: string;
  try {
    text = await ctx.fs.readFile(op.refsPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw refsGone();
    return kept(unreadable);
  }
  // Accepted residual window: storeDoubt, the lock-file check and the download check are not re-run
  // between this fresh read and the writes below. Without flock the app cannot exclude a concurrent huggingface_hub
  // publish completely; the payload is still revalidated against op.expect by SafeFs, and `.refs` is unlinked only
  // against the facts read here, so a change to either in that window fails the op instead of being overwritten.
  const refsAfter = await refsFactsNow();
  if (refsAfter === undefined || !sameFacts(refsFacts, refsAfter) || !sameLines(parseRefs(text), store.refsRaw)) {
    throw new StoreStaleError(op.refsPath, 'refs changed since review');
  }

  // 2. still referenced: rewrite to exactly the valid refs, keep the payload
  const valid = store.validRefs;
  if (valid.length > 0) {
    if (refsText(valid) !== text) {
      register();
      undo.refsPending = { before: text, after: refsText(valid) };
      await writeRefs(ctx.safeFs, op.refsPath, valid);
      undo.refsBefore = text;
      undo.refsAfter = refsText(valid);
    }
    if (op.payload !== 'keep') return kept(`it is still referenced by ${valid.join(', ')}`);
    const relinked = valid.filter((l) => op.removeRefs.includes(l));
    return relinked.length > 0 ? kept(`it is still referenced by ${relinked.join(', ')}`) : { undo };
  }

  // 3. unreferenced
  if (op.payload === 'keep') return kept('it is no longer referenced, but the plan said keep');
  const refusal = (ctx.confirmDeletable ?? confirmSweepDeletable)(store, storeMarked);
  if (refusal !== null) return kept(refusal);
  register();
  if (op.payload === 'delete') {
    await ctx.safeFs.unlink(op.storePath, op.expect);
  } else {
    if (ctx.holdRoot === null || typeof op.holdDest !== 'string') throw new Error('a held payload needs a hold root and a holdDest');
    const dest = join(ctx.holdRoot, ...op.holdDest.split('/'));
    const parent = dirname(dest);
    const created: string[] = [];
    try {
      await ctx.safeFs.mkdirp(parent, { created });
    } finally {
      ctx.createdDirs?.push(...created.reverse()); // deepest first, also when mkdirp failed part-way
    }
    await ctx.safeFs.rename(op.storePath, dest, op.expect);
    undo.payloadMovedTo = dest;
  }
  // huggingface_hub removes the manifest after the payload (missing_ok)
  if ((await factsOf(ctx.fs, op.refsPath)) !== null) {
    undo.refsPending = { before: text, after: null };
    await ctx.safeFs.unlink(op.refsPath, refsFacts);
    undo.refsBefore = text;
    undo.refsAfter = null;
  }
  return { undo };
}

/**
 * Adds reference lines to a payload's `.refs` (restore): the current lines must equal `expectRefsRaw` (null =
 * the file is absent), else StoreStaleError "refs changed since review" with nothing written. A lock file for the
 * payload refuses (a concurrent publish's appended ref could be lost). The result is the sorted union, written with
 * writeRefs; a missing `.refs` is created. The undo record is handed to `onUndo` before the write, so a write
 * that took effect although it reported an error is still undone.
 */
export async function applyStoreRefsAdd(op: StoreRefsAddOp, ctx: StoreRefsAddCtx): Promise<{ undo: StoreUndo }> {
  if (!op.addRefs.every((r) => typeof r === 'string' && r !== '' && !/[\r\n]/.test(r))) {
    throw new Error('malformed reference line');
  }
  const undo: StoreUndo = { refsBefore: null, payloadMovedTo: null };
  if (!op.refsPath.endsWith('.refs')) throw new Error('not a .refs path');
  const storePath = op.refsPath.slice(0, -'.refs'.length);
  if (await lockPresent(storePath, ctx.fs)) throw new Error('the store payload is locked by another process');
  const before = await factsOf(ctx.fs, op.refsPath);
  let text: string | null = null;
  if (before !== null) {
    if (!before.isFile || before.isSymlink) throw new StoreStaleError(op.refsPath, 'refs changed since review: not a regular file');
    text = await ctx.fs.readFile(op.refsPath, 'utf8');
  }
  const raw = text === null ? null : parseRefs(text);
  const after = await factsOf(ctx.fs, op.refsPath);
  const unchanged = before === null ? after === null : sameFacts(before, after);
  if (!unchanged || !sameLines(raw, op.expectRefsRaw)) throw new StoreStaleError(op.refsPath, 'refs changed since review');
  const lines = [...(raw ?? []).filter((l) => l !== ''), ...op.addRefs];
  undo.refsPending = { before: text, after: refsText(lines) };
  ctx.onUndo?.(undo);
  await writeRefs(ctx.safeFs, op.refsPath, lines);
  // set only once the write succeeded: refsAfter defined means done, and null refsBefore then means "file was absent"
  undo.refsBefore = text;
  undo.refsAfter = refsText(lines);
  return { undo };
}
