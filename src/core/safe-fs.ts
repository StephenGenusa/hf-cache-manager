import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { FileFacts, SafeRoots } from './types';
import { factsMatch, factsOf, isNotFound, nodeFs, type FileHandleLike, type FsLike, type StatLike } from './fsx';
import { isStrictlyInside } from './paths';

export type SafeFsErrorCode = 'CONTAINMENT' | 'STALE' | 'EXISTS' | 'IO';

export class SafeFsError extends Error {
  readonly code: SafeFsErrorCode;
  /** The caller-supplied path the error concerns (for rename: `dest` for EXISTS and inside-itself, otherwise `src`). */
  readonly path: string;
  /** Underlying Node error code (e.g. 'EXDEV', 'ENOTEMPTY', 'EPERM'), when there is one. */
  readonly errno?: string;
  /** The contained, resolved path that was acted on, once resolution has succeeded. */
  readonly resolved?: string;

  constructor(code: SafeFsErrorCode, path: string, message: string, errno?: string, resolved?: string) {
    super(`${code}: ${message} (${path})`);
    this.name = 'SafeFsError';
    this.code = code;
    this.path = path;
    if (errno !== undefined) this.errno = errno;
    if (resolved !== undefined) this.resolved = resolved;
  }
}

/** Path segment separators of `platform`: both slashes on Windows, '/' elsewhere. */
export function segmentSplit(platform: NodeJS.Platform): RegExp {
  return platform === 'win32' ? /[\\/]/ : /\//;
}

const SEGMENT_SPLIT = segmentSplit(process.platform);

function errnoOf(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A root must be a non-empty absolute path that is not a filesystem root; returns it normalised. */
function checkRoot(r: unknown, label: string): string {
  const shown = typeof r === 'string' ? r : String(r);
  if (typeof r !== 'string' || r === '' || r.includes('\0') || !isAbsolute(r)) {
    throw new SafeFsError('CONTAINMENT', shown, `${label} must be a non-empty absolute path`);
  }
  const abs = resolve(r);
  if (parse(abs).root === abs) throw new SafeFsError('CONTAINMENT', shown, `${label} must not be a filesystem root`);
  return abs;
}

/**
 * The only module allowed to mutate the filesystem. Every method proves containment in
 * `roots` before acting, and never follows a leaf symlink when deleting.
 */
/**
 * Optional per-call hook: `onAttempt` runs after every check of the call has passed (containment,
 * revalidation), immediately before the mutating syscall. A caller uses it to tell "the syscall was attempted"
 * (it may have taken effect even if it then reported an error) from "refused before acting" (nothing changed).
 */
export interface AttemptHook { onAttempt?: () => void }

/** A `.incomplete` file open for writing (download mode). Every byte goes through the one fd. */
export interface IncompleteWriter {
  /** Size of the file when it was opened (0 for a new file). */
  readonly startSize: number;
  write(chunk: Uint8Array): Promise<void>;
  /** Closes the fd and returns the file's facts, after proving the path still names the file that was written. */
  close(): Promise<FileFacts>;
}

/** dev, ino and size: the identity a resumed partial file must keep (download mode). */
const sameFile = (st: StatLike, f: FileFacts): boolean => st.dev === f.dev && st.ino === f.ino && st.size === f.size;
const INCOMPLETE = '.incomplete';

const COPY_CHUNK = 8 * 1024 * 1024;

/** A copy that failed after its dest was created: the partial dest is left in place and named (never removed). */
function partialCopy(dest: string, to: string, e: unknown): SafeFsError {
  return new SafeFsError('IO', dest, `copy failed part-way (${String(e)}); the partial copy is left at ${to}`, errnoOf(e), to);
}

/** Closes an fd on a failure path; the original error is what the caller needs. */
async function closeQuietly(fh: FileHandleLike): Promise<void> {
  try {
    await fh.close();
  } catch {
    // ignored: the fd is released either way
  }
}

export class SafeFs {
  readonly roots: SafeRoots;
  private readonly allRoots: readonly string[];
  private readonly fs: FsLike;

  constructor(roots: SafeRoots, fs: FsLike = nodeFs) {
    const hubRoot = checkRoot(roots.hubRoot, 'hubRoot');
    if (!Array.isArray(roots.viewRoots)) throw new SafeFsError('CONTAINMENT', String(roots.viewRoots), 'viewRoots must be an array');
    const viewRoots = Object.freeze(roots.viewRoots.map((r, i) => checkRoot(r, `viewRoots[${i}]`)));
    const holdRoot = roots.holdRoot === null ? null : checkRoot(roots.holdRoot, 'holdRoot');
    // viewRoots is frozen; the cast only drops `readonly` from the shared SafeRoots type.
    this.roots = Object.freeze({ hubRoot, viewRoots: viewRoots as string[], holdRoot });
    this.allRoots = Object.freeze([hubRoot, ...viewRoots, ...(holdRoot === null ? [] : [holdRoot])]);
    this.fs = fs;
  }

  /**
   * A SafeFs over realpath'd roots, so containment and the executor's root-equality guard work when a root is
   * reached through a symlink (e.g. a symlinked home or temp dir). The hub root must exist and is realpath'd itself;
   * a view or hold root may not exist yet, so it is realpath(nearest existing ancestor) + the missing segments.
   * Any failure to resolve (missing hub, dangling link, loop, EACCES) is CONTAINMENT. The constructor's checks run
   * on the inputs first and again on the resolved roots.
   */
  static async create(roots: SafeRoots, fs: FsLike = nodeFs): Promise<SafeFs> {
    const checked = new SafeFs(roots, fs).roots; // input validation (absolute, not a filesystem root, ...)
    const real = async (p: string, label: string): Promise<string> => {
      try {
        return await fs.realpath(p);
      } catch (e) {
        throw new SafeFsError('CONTAINMENT', p, `${label} cannot be resolved`, errnoOf(e));
      }
    };
    const viaAncestor = async (p: string, label: string): Promise<string> => {
      const missing: string[] = [];
      let cur = p;
      for (;;) {
        try {
          await fs.lstat(cur);
          return join(await real(cur, label), ...missing);
        } catch (e) {
          if (e instanceof SafeFsError) throw e;
          if (!isNotFound(e)) throw new SafeFsError('CONTAINMENT', p, `${label}: cannot inspect ${cur}`, errnoOf(e));
          const up = dirname(cur);
          if (up === cur) throw new SafeFsError('CONTAINMENT', p, `${label} has no existing ancestor`);
          missing.unshift(basename(cur));
          cur = up;
        }
      }
    };
    const hubRoot = await real(checked.hubRoot, 'hubRoot');
    const viewRoots: string[] = [];
    for (const [i, v] of checked.viewRoots.entries()) viewRoots.push(await viaAncestor(v, `viewRoots[${i}]`));
    const holdRoot = checked.holdRoot === null ? null : await viaAncestor(checked.holdRoot, 'holdRoot');
    return new SafeFs({ hubRoot, viewRoots, holdRoot }, fs);
  }

  /**
   * Containment check without acting. Returns realpath(nearest existing ancestor of the parent)
   * + the missing segments + basename; the leaf itself is never resolved. Throws CONTAINMENT.
   */
  async resolveContained(p: string): Promise<string> {
    const lex = this.lexical(p);
    const root = this.pickRoot(lex);
    if (root === null) throw new SafeFsError('CONTAINMENT', p, 'path is not inside any root');
    const resolved = join(await this.realParent(dirname(lex), p), basename(lex));
    // Same root after resolution (inside_root): a path may not escape its root through a
    // symlinked parent, even into another root.
    if (this.pickRoot(resolved) !== root) throw new SafeFsError('CONTAINMENT', p, `resolves outside its root ${root}`);
    if (this.allRoots.includes(resolved)) throw new SafeFsError('CONTAINMENT', p, 'refusing to act on a root itself');
    this.refuseRootAncestor(p, lex, resolved);
    return resolved;
  }

  async assertContained(p: string): Promise<void> {
    await this.resolveContained(p);
  }

  /** Removes the entry at `p` itself (a symlink is removed as a link), after revalidating it against `expect`. */
  async unlink(p: string, expect: FileFacts, hook: AttemptHook = {}): Promise<void> {
    if (expect.isDirectory) throw new SafeFsError('IO', p, 'unlink refuses directories');
    const target = await this.resolveContained(p);
    // Invariant: revalidate's factsMatch requires actual.isDirectory === expect.isDirectory, which is false here
    await this.revalidate(p, target, expect);
    hook.onAttempt?.();
    await this.wrapIo(p, target, () => this.fs.unlink(target));
  }

  /** Removes an empty real directory. Symlinks (even to directories), files and missing paths are STALE. */
  async rmdirEmpty(p: string, hook: AttemptHook = {}): Promise<void> {
    const target = await this.resolveContained(p);
    const actual = await this.wrapIo(p, target, () => factsOf(this.fs, target));
    if (actual === null) throw new SafeFsError('STALE', p, 'directory is missing', undefined, target);
    if (actual.isSymlink || !actual.isDirectory) throw new SafeFsError('STALE', p, 'not a real directory', undefined, target);
    hook.onAttempt?.();
    await this.wrapIo(p, target, () => this.fs.rmdir(target));
  }

  /**
   * Moves `src` to `dest` with a single `rename(2)`: both contained (each may be in a
   * different root, e.g. hub -> hold), `dest` not inside `src`, `src` revalidated against `expect`
   * (directories allowed, for a whole-repo hold), and `dest` must not exist (lstat, so a dangling
   * symlink counts). The dest parent must already exist (callers `mkdirp` it); a missing parent
   * surfaces as IO/ENOENT. Never copies and never falls back: EXDEV is IO and `src` is untouched.
   */
  async rename(src: string, dest: string, expect: FileFacts, hook: AttemptHook = {}): Promise<void> {
    const from = await this.resolveContained(src);
    const to = await this.resolveContained(dest);
    if (isStrictlyInside(this.lexical(dest), this.lexical(src)) || isStrictlyInside(to, from)) {
      throw new SafeFsError('CONTAINMENT', dest, `cannot move ${src} inside itself`, undefined, to);
    }
    await this.revalidate(src, from, expect);
    if ((await this.lstatOrNull(dest, to)) !== null) throw new SafeFsError('EXISTS', dest, 'destination exists', undefined, to);
    // Residual race: Node's rename has no RENAME_NOREPLACE, so a dest created between the check above
    // and this call would be replaced (a file) or refused by the OS (a non-empty directory). A hold
    // moves into the hold root, where only this app writes (under the AppLock), so that window is
    // closed in practice. A restore moves into the hub, where an external `hf download` (not under
    // our AppLock) could create the dest in that window: the executor's active-download refusal for
    // restores narrows the window but does not close it. A download of the same path
    // writes the same content-addressed data (blob names are the content hash, snapshot links point
    // at them), so what it would replace is equivalent.
    hook.onAttempt?.();
    await this.wrapIo(src, from, () => this.fs.rename(from, to));
  }

  /** Creates a symlink at `p` whose text is exactly `target` (link text; not containment-checked). */
  async symlink(target: string, p: string): Promise<void> {
    const at = await this.resolveContained(p);
    if ((await this.lstatOrNull(p, at)) !== null) throw new SafeFsError('EXISTS', p, 'path exists', undefined, at);
    await this.wrapIo(p, at, () => this.fs.symlink(target, at, 'file'));
  }

  /**
   * Opens the partial download `p` (a `*.incomplete` name) for writing; never truncates, never follows a symlink.
   * - `expect` null: created exclusively ('wx'); anything already at `p` (a file, a symlink, a directory) is EXISTS.
   * - otherwise (a resume): `p` must be a regular file with no other hard link (else EXISTS) whose lstat matches `expect` on dev, ino and size
   *   (else STALE); it is opened for append (O_NOFOLLOW where available) and the fd's fstat must match too, else the
   *   fd is closed and the call is STALE.
   * close() fstats the fd, closes it, and requires lstat of `p` to name the same regular file (dev, ino), else STALE.
   */
  async openIncomplete(p: string, expect: FileFacts | null): Promise<IncompleteWriter> {
    const at = await this.resolveContained(p);
    if (!basename(at).endsWith(INCOMPLETE) || basename(at) === INCOMPLETE) {
      throw new SafeFsError('CONTAINMENT', p, `openIncomplete only writes *${INCOMPLETE} files`, undefined, at);
    }
    return this.openWriter(p, at, expect);
  }

  /**
   * Opens the existing regular file `p` for append, through exactly the resume path of openIncomplete (lstat and the
   * fd's fstat must match `expect` on dev, ino and size; never truncates, never follows a symlink, never creates).
   * Used to finish a snapshot copy that stopped part-way (download mode, no-symlink fallback).
   */
  async appendExisting(p: string, expect: FileFacts): Promise<IncompleteWriter> {
    return this.openWriter(p, await this.resolveContained(p), expect);
  }

  private async openWriter(p: string, at: string, expect: FileFacts | null): Promise<IncompleteWriter> {
    if (expect !== null) {
      const pre = await this.lstatOrNull(p, at);
      if (pre === null) throw new SafeFsError('STALE', p, 'partial file is missing', undefined, at);
      if (!pre.isFile()) throw new SafeFsError('EXISTS', p, 'not a regular file; refusing to write through or into it', undefined, at);
      // Appending would change the file under its other names too
      if (pre.nlink !== 1) throw new SafeFsError('EXISTS', p, 'the file has other hard links; refusing to append through them', undefined, at);
      if (!sameFile(pre, expect)) throw new SafeFsError('STALE', p, 'partial file changed since it was checked', undefined, at);
    }
    let fh: FileHandleLike;
    try {
      fh = await this.fs.open(at, expect === null ? 'wx' : 'a');
    } catch (e) {
      // 'a' has no O_CREAT: a partial file that vanished since the lstat is STALE, like one missing before it.
      if (expect !== null && isNotFound(e)) throw new SafeFsError('STALE', p, 'partial file is missing', errnoOf(e), at);
      throw this.toSafeError(p, at, e);
    }
    let opened: StatLike;
    try {
      opened = await fh.stat();
    } catch (e) {
      await closeQuietly(fh);
      throw this.toSafeError(p, at, e);
    }
    if (!opened.isFile() || (expect !== null && (!sameFile(opened, expect) || opened.nlink !== 1))) {
      await closeQuietly(fh);
      throw new SafeFsError('STALE', p, 'the opened file is not the one that was checked', undefined, at);
    }
    return this.incompleteWriter(p, at, fh, opened);
  }

  private incompleteWriter(p: string, at: string, fh: FileHandleLike, opened: StatLike): IncompleteWriter {
    let closed = false;
    const ensureOpen = (): void => {
      if (closed) throw new SafeFsError('IO', p, 'the partial file is already closed', undefined, at);
    };
    return {
      startSize: opened.size,
      write: async (chunk) => {
        ensureOpen();
        await this.wrapIo(p, at, () => fh.write(chunk));
      },
      close: async () => {
        ensureOpen();
        closed = true;
        let end: StatLike;
        try {
          end = await fh.stat();
        } catch (e) {
          await closeQuietly(fh);
          throw this.toSafeError(p, at, e);
        }
        await this.wrapIo(p, at, () => fh.close());
        const now = await this.wrapIo(p, at, () => factsOf(this.fs, at));
        if (now === null || !now.isFile || now.dev !== end.dev || now.ino !== end.ino) {
          throw new SafeFsError('STALE', p, 'the partial file was moved or replaced while it was written', undefined, at);
        }
        return now;
      },
    };
  }

  /**
   * Copies the regular file `src` to the new file `dest` (the no-symlink snapshot fallback), through fds
   * only: both contained; `src` revalidated against `expect`, then opened read-only (O_NOFOLLOW where available) and
   * its fstat must match `expect` on dev, ino and size (else STALE, before any dest exists); `dest` absent (lstat, so
   * a dangling symlink counts) and created with 'wx' (O_EXCL, never replaced). A copy that fails part-way leaves the
   * partial dest in place, never removed (fs.copyFile is not used: it unlinks the dest on failure), and the error
   * (IO) names it. `hook.onCreated` runs once the exclusive create of `dest` has succeeded, so a caller can tell a
   * failure that left this call's own partial copy from one that created nothing.
   */
  async copyExclusive(src: string, dest: string, expect: FileFacts, hook: { onCreated?: () => void } = {}): Promise<void> {
    if (!expect.isFile || expect.isSymlink || expect.isDirectory) throw new SafeFsError('IO', src, 'copyExclusive copies regular files only');
    const from = await this.resolveContained(src);
    const to = await this.resolveContained(dest);
    await this.revalidate(src, from, expect);
    if ((await this.lstatOrNull(dest, to)) !== null) throw new SafeFsError('EXISTS', dest, 'destination exists', undefined, to);
    await this.withPinned(src, from, expect, async (sfh) => {
      const dfh = await this.wrapIo(dest, to, () => this.fs.open(to, 'wx'));
      hook.onCreated?.();   // from here on, `dest` is this call's own file (a failure leaves it as the partial copy)
      try {
        await this.pump(sfh, (chunk) => dfh.write(chunk));
      } catch (e) {
        await closeQuietly(dfh);
        throw partialCopy(dest, to, e);
      }
      try {
        await dfh.close();
      } catch (e) {
        throw partialCopy(dest, to, e);
      }
    });
  }

  /**
   * Read-only: streams the regular file `p` to `onChunk` through an fd opened without following a symlink, whose
   * fstat must match `expect` on dev, ino and size (else STALE). Used to compare an existing snapshot copy. An async
   * `onChunk` is awaited before the next read; whatever it throws ends the read (as IO unless it is a SafeFsError).
   */
  async readChunks(p: string, expect: FileFacts, onChunk: (chunk: Uint8Array) => void | Promise<void>): Promise<void> {
    const at = await this.resolveContained(p);
    await this.withPinned(p, at, expect, (fh) => this.wrapIo(p, at, () => this.pump(fh, async (c) => { await onChunk(c); })));
  }

  /** Opens `at` read-only and runs `fn` on the fd only if fstat names the expected regular file; always closes it. */
  private async withPinned(p: string, at: string, expect: FileFacts, fn: (fh: FileHandleLike) => Promise<void>): Promise<void> {
    const fh = await this.wrapIo(p, at, () => this.fs.open(at, 'r'));
    try {
      const st = await this.wrapIo(p, at, () => fh.stat());
      if (!st.isFile() || !sameFile(st, expect)) throw new SafeFsError('STALE', p, 'the opened file is not the one that was checked', undefined, at);
      await fn(fh);
    } finally {
      await closeQuietly(fh);
    }
  }

  /** Reads `from` to its end in COPY_CHUNK pieces, handing each to `sink` in order. */
  private async pump(from: FileHandleLike, sink: (chunk: Uint8Array) => Promise<void>): Promise<void> {
    for (let off = 0; ; ) {
      const chunk = await from.read(COPY_CHUNK, off);
      if (chunk.length === 0) return;
      await sink(chunk);
      off += chunk.length;
    }
  }

  /**
   * Replaces (or creates) the regular file at `p` atomically: the data goes to a temp file in the
   * same directory created exclusively ('wx', never through a symlink), which is then renamed over
   * `p`. rename replaces a leaf symlink swapped in after the check rather than following it. An
   * existing non-regular `p` (symlink, directory) is EXISTS. No temp file survives success or failure.
   * `expect` (rollback): `p` must still match these facts (null = must be absent) when checked
   * immediately before the final rename, else STALE and nothing is replaced. Residual race, as for
   * rename(): Node has no compare-and-swap rename, so a replacement of `p` between that lstat and the
   * rename(2) itself would be overwritten; the window is a few syscalls, under the AppLock.
   * `keepTmp` (download mode): a temp file this call created is left in place on failure, never unlinked.
   */
  async writeFileAtomic(
    p: string, data: string | Uint8Array,
    opts: { tmpPath?: string; mode?: number; expect?: FileFacts | null; keepTmp?: boolean } & AttemptHook = {},
  ): Promise<void> {
    const at = await this.resolveContained(p);
    const current = await this.lstatOrNull(p, at);
    if (current !== null && !current.isFile()) {
      throw new SafeFsError('EXISTS', p, 'not a regular file; refusing to write through or over it', undefined, at);
    }
    const tmp = opts.tmpPath === undefined
      ? join(dirname(at), `${basename(at)}.${randomBytes(4).toString('hex')}.tmp`)
      : await this.tmpBeside(opts.tmpPath, at);
    const writeOpts = opts.mode === undefined ? { flag: 'wx' as const } : { flag: 'wx' as const, mode: opts.mode };
    const discard: (t: string) => Promise<void> = opts.keepTmp === true ? async () => undefined : (t) => this.discard(t);
    try {
      await this.fs.writeFile(tmp, data, writeOpts);
    } catch (e) {
      // EEXIST: the temp name belongs to someone else; leave it alone.
      if (errnoOf(e) !== 'EEXIST') await discard(tmp);
      throw this.toSafeError(p, at, e);
    }
    if (opts.expect !== undefined) {
      let now: FileFacts | null;
      try {
        now = await factsOf(this.fs, at);
      } catch (e) {
        await discard(tmp);
        throw this.toSafeError(p, at, e);
      }
      if (opts.expect === null ? now !== null : now === null || !factsMatch(now, opts.expect)) {
        await discard(tmp);
        throw new SafeFsError('STALE', p, 'changed since it was checked', undefined, at);
      }
    }
    opts.onAttempt?.(); // the final rename is the step that changes `p`
    try {
      await this.fs.rename(tmp, at);
    } catch (e) {
      await discard(tmp);
      throw this.toSafeError(p, at, e);
    }
  }

  /**
   * Creates `p` and any missing ancestors inside its root, one non-recursive mkdir at a time.
   * Never creates a missing root; the one exception is the canonical hold root and its
   * `.hf-cache-manager` parent. An existing directory is a no-op;
   * an existing non-directory at `p` or an ancestor is EXISTS.
   * - `created` receives each directory this call made, outermost first, as soon as its mkdir succeeded (so a caller
   *   knows exactly what to remove again, even when the call fails part-way). Directories that already existed, or
   *   that appeared meanwhile (EEXIST), are never listed.
   * - `exclusive`: `p` itself must not exist and must be made by this call: an existing `p`, or
   *   EEXIST from its own mkdir (a race), is EXISTS and nothing is merged into it. Allowed only for a direct child of
   *   the hold root (`<holdRoot>/<deletionId>`), else CONTAINMENT.
   */
  async mkdirp(p: string, opts: { created?: string[]; exclusive?: boolean } = {}): Promise<void> {
    const lex = this.lexical(p);
    const canonical = this.canonicalHoldRoot();
    if (opts.exclusive === true && (canonical === null || dirname(lex) !== canonical)) {
      throw new SafeFsError('CONTAINMENT', p, 'an exclusive mkdirp is only for a direct child of the hold root');
    }
    const hold = this.canonicalHoldRoot();
    const root = lex === hold ? hold : this.pickRoot(lex);
    if (root === null) throw new SafeFsError('CONTAINMENT', p, 'path is not inside any root');
    if (lex !== hold && this.allRoots.includes(lex)) throw new SafeFsError('CONTAINMENT', p, 'refusing to act on a root itself');

    const { existing, stat, missing } = await this.nearestExisting(lex, p);
    const real = await this.realOf(existing, p);
    if (existing !== root && !isStrictlyInside(existing, root)) {
      // The root itself is missing. Only the canonical hold root may be created, and only from the
      // hub's parent or a real (non-symlink) .hf-cache-manager directory that resolves to itself.
      if (root !== hold) throw new SafeFsError('CONTAINMENT', p, `root ${root} does not exist and is never created`);
      if (existing !== dirname(this.roots.hubRoot) && existing !== dirname(hold)) {
        throw new SafeFsError('CONTAINMENT', p, `hold root ancestor ${existing} is missing`);
      }
      if (stat.isSymbolicLink() || real !== existing) throw new SafeFsError('CONTAINMENT', p, `${existing} is a symlink or resolves elsewhere`);
    }
    const resolved = join(real, ...missing);
    const isHold = root === hold && resolved === hold;
    if (!isHold && (this.pickRoot(resolved) !== root || this.allRoots.includes(resolved))) {
      throw new SafeFsError('CONTAINMENT', p, `resolves outside its root ${root}`, undefined, resolved);
    }
    this.refuseRootAncestor(p, lex, resolved);
    // Never traverse or accept a symlinked directory: p itself and every existing component strictly
    // below the matched root must be a real entry (lstat), even when the link stays inside the root.
    for (let c = existing; c !== root && isStrictlyInside(c, root); c = dirname(c)) {
      const st = c === existing ? stat : await this.wrapIo(p, resolved, () => this.fs.lstat(c));
      if (st.isSymbolicLink()) throw new SafeFsError('EXISTS', p, `${c} is a symlink; refusing to traverse it`, undefined, resolved);
    }
    // A symlinked `existing` was refused above (or failed containment), so lstat is the entry itself.
    if (!stat.isDirectory()) throw new SafeFsError('EXISTS', p, `${existing} exists and is not a directory`, undefined, resolved);
    if (opts.exclusive === true && missing.length === 0) throw new SafeFsError('EXISTS', p, 'directory already exists', undefined, resolved);

    let cur = real;
    for (const [k, seg] of missing.entries()) {
      cur = join(cur, seg);
      const dir = cur;
      try {
        await this.fs.mkdir(dir);
      } catch (e) {
        if (errnoOf(e) !== 'EEXIST') throw this.toSafeError(p, resolved, e);
        if (opts.exclusive === true && k === missing.length - 1) {
          throw new SafeFsError('EXISTS', p, 'directory already exists', 'EEXIST', resolved);
        }
        const now = await this.lstatOrNull(p, dir);
        if (now === null || !now.isDirectory()) throw new SafeFsError('EXISTS', p, `${dir} exists and is not a directory`, 'EEXIST', resolved);
        continue;
      }
      opts.created?.push(dir);
    }
  }

  /** Step 1: absolute, no NUL, no '.' or '..' segment. Returns the normalised path. */
  private lexical(p: string): string {
    const shown = typeof p === 'string' ? p : String(p);
    if (typeof p !== 'string' || p === '' || p.includes('\0') || !isAbsolute(p)) {
      throw new SafeFsError('CONTAINMENT', shown, 'path must be absolute and contain no NUL');
    }
    if (p.split(SEGMENT_SPLIT).some((s) => s === '.' || s === '..')) {
      throw new SafeFsError('CONTAINMENT', p, "path must not contain '.' or '..' segments");
    }
    return resolve(p);
  }

  /** The root strictly containing `p`; the longest when several do. */
  private pickRoot(p: string): string | null {
    let best: string | null = null;
    for (const r of this.allRoots) {
      if (isStrictlyInside(p, r) && (best === null || r.length > best.length)) best = r;
    }
    return best;
  }

  /** realpath of the nearest existing ancestor of `dir` (inclusive), with the missing segments appended. */
  private async realParent(dir: string, p: string): Promise<string> {
    const { existing, missing } = await this.nearestExisting(dir, p);
    return join(await this.realOf(existing, p), ...missing);
  }

  /**
   * Walks up from `dir` (inclusive) to the nearest entry that lstat can see, returning it, its lstat
   * and the missing segments below it. Anything that cannot be inspected (EACCES, ...) fails closed.
   */
  private async nearestExisting(dir: string, p: string): Promise<{ existing: string; stat: StatLike; missing: string[] }> {
    const missing: string[] = [];
    let cur = dir;
    for (;;) {
      try {
        return { existing: cur, stat: await this.fs.lstat(cur), missing };
      } catch (e) {
        if (!isNotFound(e)) throw new SafeFsError('CONTAINMENT', p, `cannot inspect ${cur}`, errnoOf(e));
        const up = dirname(cur);
        if (up === cur) throw new SafeFsError('CONTAINMENT', p, 'no existing ancestor');
        missing.unshift(basename(cur));
        cur = up;
      }
    }
  }

  /** realpath that fails closed: a dangling link, loop or EACCES is CONTAINMENT. */
  private async realOf(existing: string, p: string): Promise<string> {
    try {
      return await this.fs.realpath(existing);
    } catch (e) {
      throw new SafeFsError('CONTAINMENT', p, `cannot resolve ${existing}`, errnoOf(e));
    }
  }

  /**
   * Refuses a target that is an ancestor of any configured root, lexically or after resolution: acting
   * on it would move, remove or create that root (nested roots, e.g. a view root containing the hub).
   */
  private refuseRootAncestor(p: string, lex: string, resolved: string): void {
    const inner = this.allRoots.find((r) => isStrictlyInside(r, lex) || isStrictlyInside(r, resolved));
    if (inner !== undefined) throw new SafeFsError('CONTAINMENT', p, `would act on an ancestor of root ${inner}`, undefined, resolved);
  }

  /** The hold root, when it is the canonical one that mkdirp may create. */
  private canonicalHoldRoot(): string | null {
    const { hubRoot, holdRoot } = this.roots;
    return holdRoot !== null && holdRoot === join(dirname(hubRoot), '.hf-cache-manager', 'recently-deleted') ? holdRoot : null;
  }

  /** Revalidation: the entry at `target` must still match `expect`, else STALE. */
  private async revalidate(p: string, target: string, expect: FileFacts): Promise<FileFacts> {
    const actual = await this.wrapIo(p, target, () => factsOf(this.fs, target));
    if (actual === null) throw new SafeFsError('STALE', p, 'missing since review', undefined, target);
    if (!factsMatch(actual, expect)) throw new SafeFsError('STALE', p, 'changed since review', undefined, target);
    return actual;
  }

  /** lstat that returns null for a missing entry; other failures are IO. */
  private async lstatOrNull(p: string, target: string): Promise<StatLike | null> {
    try {
      return await this.fs.lstat(target);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw this.toSafeError(p, target, e);
    }
  }

  /** A caller-supplied temp path: contained, in the same resolved directory as `at`, and not `at` itself. */
  private async tmpBeside(tmpPath: string, at: string): Promise<string> {
    const tmp = await this.resolveContained(tmpPath);
    if (dirname(tmp) !== dirname(at) || tmp === at) {
      throw new SafeFsError('CONTAINMENT', tmpPath, 'tmpPath must be another name in the same directory as the target', undefined, tmp);
    }
    return tmp;
  }

  /** Best-effort removal of our own temp file (unlink never follows a symlink). */
  private async discard(tmp: string): Promise<void> {
    try {
      await this.fs.unlink(tmp);
    } catch {
      // Already gone, or not removable; the original error is what the caller needs.
    }
  }

  /** Runs an fs step, mapping any non-SafeFs failure via `toSafeError`. */
  private async wrapIo<T>(p: string, resolved: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.toSafeError(p, resolved, e);
    }
  }

  /** Maps an fs failure to SafeFsError: EEXIST is EXISTS, anything else IO; the Node errno is kept. */
  private toSafeError(p: string, resolved: string, e: unknown): SafeFsError {
    if (e instanceof SafeFsError) return e;
    const errno = errnoOf(e);
    return new SafeFsError(errno === 'EEXIST' ? 'EXISTS' : 'IO', p, e instanceof Error ? e.message : String(e), errno, resolved);
  }
}
