// Advisory app lock: deletion, restore, empty and sync are mutually exclusive, also against a
// second app instance. The lock file is <dir>/app.lock, where callers pass join(dirname(hubRoot), '.hf-cache-manager')
//. Every access lstats <dir> first and refuses a symlinked or non-directory folder. Files inside it are
// opened through openChecked (O_NOFOLLOW where the platform has it, plus an lstat/fstat identity check everywhere), so
// nothing is ever read or written through a symlink.
//
// Taking over a stale lock is serialised by a second exclusive file, <dir>/app.lock.takeover: only the guard holder may
// unlink app.lock, and only while its bytes are identical to the record that was judged stale. A fresh create never
// unlinks anything, so two instances can never both end up owning the lock.
import { constants, lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ExecError } from './errors';

export const LOCK_FILE = 'app.lock';
export const TAKEOVER_FILE = 'app.lock.takeover';
/** An unparseable lock younger than this may be mid-write by another instance, so it still counts as held. */
export const UNPARSEABLE_GRACE_MS = 60_000;
/** A takeover guard older than this (by mtime) was left by a crashed taker. */
export const TAKEOVER_STALE_MS = 60_000;
const BAD_DIR = 'lock folder is a symlink or not a directory';
export const DEFAULT_NOFOLLOW: number = constants.O_NOFOLLOW ?? 0;

const errno = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
const isPid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const codeError = (code: string, p: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${p}`), { code });

/**
 * Opens a regular file at `p` without ever following a symlink at `p`, also where O_NOFOLLOW is unavailable
 * (`nofollow` = 0, e.g. Windows): lstat first and refuse anything but a regular file (EEXIST for an exclusive create,
 * ELOOP otherwise), open, then require that fstat of the handle and a fresh lstat of `p` name the same regular file
 * (dev + ino), and the same one the first lstat saw.
 */
export async function openChecked(p: string, flags: number, mode: number | undefined, nofollow: number): Promise<FileHandle> {
  let pre: Stats | null = null;
  try {
    pre = await lstat(p);
  } catch (e) {
    if (errno(e) !== 'ENOENT') throw e;
  }
  if (pre && (flags & constants.O_EXCL) !== 0 && (flags & constants.O_CREAT) !== 0) throw codeError('EEXIST', p);
  if (pre && !pre.isFile()) throw codeError(pre.isDirectory() ? 'EISDIR' : 'ELOOP', p);
  const fh = await open(p, flags | nofollow, mode);
  try {
    const st = await fh.stat();
    const post = await lstat(p);
    const same = (a: Stats): boolean => a.dev === st.dev && a.ino === st.ino;
    if (!st.isFile() || !post.isFile() || !same(post) || (pre !== null && !same(pre))) throw codeError('ELOOP', p);
  } catch (e) {
    await fh.close().catch(() => undefined);
    throw e;
  }
  return fh;
}

type Record_ = { kind: 'owned'; pid: number; at: number; mtimeMs: number; ino: number; text: string }
  | { kind: 'unparseable'; mtimeMs: number; ino: number; text: string };
type FileState = { kind: 'none' } | { kind: 'not-a-file' } | Record_;

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH: no such process. EPERM: it exists but belongs to someone else. Anything else: fail closed (alive).
    return errno(e) !== 'ESRCH';
  }
}

export interface AppLockOptions {
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  /** O_NOFOLLOW flag to use; 0 forces the lstat/fstat-only path (tests exercise it on POSIX). */
  noFollowFlag?: number;
  /** Test hook: runs after a lock was judged stale and before the takeover (simulates a racing instance). */
  beforeTakeover?: () => Promise<void>;
}

export class AppLock {
  private readonly file: string;
  private readonly guard: string;
  private readonly pid: number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly nofollow: number;
  private readonly beforeTakeover: (() => Promise<void>) | undefined;
  /** The `at` this instance wrote, while it holds the lock. */
  private heldAt: number | null = null;

  constructor(private readonly dir: string, opts: AppLockOptions = {}) {
    if (!isAbsolute(dir)) throw new Error(`AppLock dir must be absolute: ${dir}`);
    this.file = join(dir, LOCK_FILE);
    this.guard = join(dir, TAKEOVER_FILE);
    this.pid = opts.pid ?? process.pid;
    if (!isPid(this.pid)) throw new Error(`AppLock pid must be a positive integer: ${String(this.pid)}`);
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.nofollow = opts.noFollowFlag ?? DEFAULT_NOFOLLOW;
    this.beforeTakeover = opts.beforeTakeover;
  }

  async acquire(now: number): Promise<void> {
    await this.ensureDir(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this.create(this.file, now)) return this.confirmOwn(now);
      const st = await this.readState(this.file);
      if (st.kind === 'none') continue; // vanished between EEXIST and read (its owner released): retry the create
      if (st.kind === 'not-a-file') throw new ExecError('IO', 'lock file is not a regular file', this.file);
      if (this.isLive(st, now)) throw this.locked(st);
      await this.beforeTakeover?.();
      if (await this.takeover(st, now)) return this.confirmOwn(now);
    }
    const st = await this.readState(this.file);
    throw st.kind === 'owned' || st.kind === 'unparseable'
      ? this.locked(st)
      : new ExecError('LOCKED', 'Another operation is in progress.', this.file);
  }

  async release(): Promise<void> {
    await this.ensureDir(false);
    const held = this.heldAt;
    this.heldAt = null;
    if (held === null) return;
    const st = await this.readState(this.file);
    // Only our own record (same pid and the `at` this instance wrote) is removed.
    if (st.kind === 'owned' && st.pid === this.pid && st.at === held) await this.unlinkIfSame(this.file, st);
  }

  async isHeld(now: number): Promise<boolean> {
    if (!(await this.ensureDir(false))) return false;
    const st = await this.readState(this.file);
    if (st.kind === 'none') return false;
    if (st.kind === 'not-a-file') return true; // cannot vouch for it: fail closed
    return this.isLive(st, now);
  }

  /**
   * True when app.lock holds a record naming this process's pid that this instance is not holding, i.e. a lock
   * this app left behind (isLive treats our own pid as live, so acquire stays LOCKED until someone deletes it).
   * Read-only; any problem reading answers false.
   */
  async recordIsOurs(): Promise<boolean> {
    try {
      if (this.heldAt !== null || !(await this.ensureDir(false))) return false;
      const st = await this.readState(this.file);
      return st.kind === 'owned' && st.pid === this.pid;
    } catch {
      return false;
    }
  }

  private isLive(st: Record_, now: number): boolean {
    if (st.kind === 'unparseable') return now - st.mtimeMs < UNPARSEABLE_GRACE_MS;
    return st.pid === this.pid || this.isPidAlive(st.pid);
  }

  private locked(st: Record_): ExecError {
    const who = st.kind === 'owned' ? ` (process ${st.pid})` : '';
    return new ExecError('LOCKED', `Another operation is in progress${who}.`, this.file);
  }

  /** Our create succeeded: re-read and make sure the file holds exactly our record before claiming it. */
  private async confirmOwn(now: number): Promise<void> {
    const st = await this.readState(this.file);
    if (st.kind === 'owned' && st.pid === this.pid && st.at === now) {
      this.heldAt = now;
      return;
    }
    throw st.kind === 'owned' || st.kind === 'unparseable'
      ? this.locked(st)
      : new ExecError('LOCKED', 'Another operation is in progress.', this.file);
  }

  /**
   * Under the takeover guard: unlink app.lock only if its bytes still equal the stale record, then create ours.
   * false → someone else changed or re-created the lock; the caller re-evaluates.
   */
  private async takeover(stale: Record_, now: number): Promise<boolean> {
    await this.takeGuard(now);
    try {
      const cur = await this.readState(this.file);
      if (cur.kind !== 'none') {
        if (cur.kind === 'not-a-file' || cur.text !== stale.text) return false;
        await this.unlinkIfSame(this.file, cur);
      }
      return await this.create(this.file, now);
    } finally {
      await this.dropGuard(now);
    }
  }

  private async takeGuard(now: number): Promise<void> {
    if (await this.create(this.guard, now)) return;
    const g = await this.readState(this.guard);
    if (g.kind === 'not-a-file') throw new ExecError('IO', 'lock takeover file is not a regular file', this.guard);
    if (g.kind !== 'none') {
      const fresh = now - g.mtimeMs < TAKEOVER_STALE_MS;
      const alive = g.kind === 'owned' && (g.pid === this.pid || this.isPidAlive(g.pid));
      if (g.kind === 'owned' ? alive && fresh : fresh) {
        throw new ExecError('LOCKED', 'Another instance is taking over the lock.', this.guard);
      }
      // Crashed taker: remove its guard only if it still has the bytes judged stale.
      const again = await this.readState(this.guard);
      if (again.kind !== 'none' && (again.kind === 'not-a-file' || again.text !== g.text)) {
        throw new ExecError('LOCKED', 'Another instance is taking over the lock.', this.guard);
      }
      if (again.kind !== 'none') await this.unlinkIfSame(this.guard, again);
    }
    if (!(await this.create(this.guard, now))) {
      throw new ExecError('LOCKED', 'Another instance is taking over the lock.', this.guard);
    }
  }

  private async dropGuard(now: number): Promise<void> {
    const g = await this.readState(this.guard).catch(() => ({ kind: 'none' }) as const);
    if (g.kind === 'owned' && g.pid === this.pid && g.at === now) await this.unlinkIfSame(this.guard, g).catch(() => undefined);
  }

  /** lstat <dir>: a real directory → true; missing → created (non-recursively) when `create`, else false. */
  private async ensureDir(create: boolean): Promise<boolean> {
    let st;
    try {
      st = await lstat(this.dir);
    } catch (e) {
      if (errno(e) !== 'ENOENT') throw new ExecError('IO', `Could not check the lock folder: ${errno(e)}`, this.dir);
      if (!create) return false;
      try {
        await mkdir(this.dir);
      } catch (e2) {
        if (errno(e2) !== 'EEXIST') throw new ExecError('IO', `Could not create the lock folder: ${errno(e2)}`, this.dir);
      }
      return this.ensureDir(false); // re-check what is there now (a racing creator may have left a symlink)
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ExecError('IO', BAD_DIR, this.dir);
    return true;
  }

  /** Exclusive create of `p` holding our record; false when something already exists there. */
  private async create(p: string, now: number): Promise<boolean> {
    let fh;
    try {
      fh = await openChecked(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644, this.nofollow);
    } catch (e) {
      if (errno(e) === 'EEXIST') return false;
      throw new ExecError('IO', `Could not create the lock file: ${errno(e)}`, p);
    }
    let ino = -1;
    try {
      ino = (await fh.stat()).ino;
      await fh.writeFile(`${JSON.stringify({ pid: this.pid, at: now })}\n`, 'utf8');
      await fh.datasync();
      await fh.close();
    } catch (e) {
      await fh.close().catch(() => undefined);
      if (ino !== -1) await this.unlinkIfSame(p, { ino, text: null }).catch(() => undefined);
      throw new ExecError('IO', `Could not write the lock file: ${errno(e)}`, p);
    }
    return true;
  }

  private async readState(p: string): Promise<FileState> {
    let fh;
    try {
      fh = await openChecked(p, constants.O_RDONLY, undefined, this.nofollow);
    } catch (e) {
      const code = errno(e);
      if (code === 'ENOENT') return { kind: 'none' };
      if (code === 'ELOOP' || code === 'EISDIR') return { kind: 'not-a-file' };
      throw new ExecError('IO', `Could not read the lock file: ${code}`, p);
    }
    try {
      const st = await fh.stat();
      const text = await fh.readFile('utf8');
      let rec: unknown;
      try {
        rec = JSON.parse(text);
      } catch {
        rec = null;
      }
      const r = rec as { pid?: unknown; at?: unknown } | null;
      if (r && typeof r === 'object' && isPid(r.pid) && typeof r.at === 'number' && Number.isFinite(r.at)) {
        return { kind: 'owned', pid: r.pid, at: r.at, mtimeMs: st.mtimeMs, ino: st.ino, text };
      }
      return { kind: 'unparseable', mtimeMs: st.mtimeMs, ino: st.ino, text };
    } catch (e) {
      throw new ExecError('IO', `Could not read the lock file: ${errno(e)}`, p);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  /**
   * Unlinks `p` only while it is still the regular file (same inode) that was inspected and, when `text` is given,
   * still holds exactly those bytes.
   */
  private async unlinkIfSame(p: string, seen: { ino: number; text: string | null }): Promise<void> {
    await this.ensureDir(false);
    if (seen.text !== null) {
      const cur = await this.readState(p);
      if (cur.kind === 'none') return;
      if (cur.kind === 'not-a-file' || cur.text !== seen.text || cur.ino !== seen.ino) return;
    }
    let st;
    try {
      st = await lstat(p);
    } catch (e) {
      if (errno(e) === 'ENOENT') return;
      throw new ExecError('IO', `Could not check the lock file: ${errno(e)}`, p);
    }
    if (!st.isFile() || st.ino !== seen.ino) return;
    try {
      await unlink(p);
    } catch (e) {
      if (errno(e) !== 'ENOENT') throw new ExecError('IO', `Could not remove the lock file: ${errno(e)}`, p);
    }
  }
}
