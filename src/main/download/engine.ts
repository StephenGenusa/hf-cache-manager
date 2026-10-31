// The download engine (items 2, 3, 10, 11).
// A queue of items (one repo commit each), every file a small state machine:
//   blob already there? → verify it, link only
//   other-downloader check → free-space check → stream into blobs/<etag>.incomplete (resume: Range)
//   → hash the .incomplete on disk → under the AppLock: commit the blob, link (or copy) the snapshot entry, and when
//   every file of the item is done: link the unchanged files, then move refs/<revision> (branch revisions only).
// It never deletes and never overwrites anything: DownloadFs is its only writer (no unlink, rmdir or truncate exists
// there), a partial file is kept on pause, cancel, failure and disk-full, and every refusal leaves both files as found.
import { dirname, join, posix } from 'node:path';
import { DownloadFs, DownloadFsError, type BlobSource } from '../../core/download/download-fs';
import { hasherFor, matches } from '../../core/download/hash';
import { repoFolderName } from '../../core/download/remote-repo';
import { ExecError } from '../../core/exec/errors';
import type { AppLock } from '../../core/exec/lock';
import { factsMatch, factsOf, isNotFound, readFs, type ReadFs } from '../../core/fsx';
import { SafeFs, SafeFsError } from '../../core/safe-fs';
import type { FileFacts } from '../../core/types';
import { isCommitHash } from '../../shared/hub-input';
import type { AppSettingsStore } from '../app-settings';
import { HubClientError, type HubClient } from '../hub/client';
import { QUEUE_ITEM, type DlState, type DownloadProgressDTO, type QueueFile, type QueueItem } from './queue';

export type { DlState, DownloadProgressDTO, QueueFile, QueueItem } from './queue';

/** Free space that must be left after a file. */
export const FREE_MARGIN = 5e9;
/** Files streaming at once, across all items. */
export const MAX_STREAMS = 4;
/** AppLock held by a deletion or sync: retry the commit this often. */
export const LOCK_RETRY_MS = 2_000;
/** Another downloader holds the file: re-check this often, and treat its partial file as live this long. */
export const OTHER_RETRY_MS = 30_000;
export const OTHER_FRESH_MS = 10 * 60_000;
/** At most 4 progress events per second per file; state changes are always sent. */
export const PROGRESS_MS = 250;

export const MSG = {
  otherProgram: 'another program is downloading this',
  appBusy: 'waiting for a deletion or sync to finish',
  diskFull: 'paused: disk nearly full',
  cannotResume: 'the server cannot resume this file',
  partialMismatch: 'the partial file does not match the Hub; delete it from the library and retry',
  different: 'a different file is already there',
  cachedMismatch: 'a cached file does not match the Hub',
  partialTooBig: 'the partial file is larger than the file on the Hub; delete it from the library and retry',
  partialNotFile: 'the partial file is not a regular file; delete it from the library and retry',
  endedEarly: 'the download ended before the whole file arrived; Resume continues it',
  tooManyBytes: 'the Hub sent more bytes than the file has',
  removed: 'files of this download were removed; download it again',
  copyMismatch: 'a copied file does not match the Hub',
  danglingStore: 'the cached blob links to a file in the shared store that is missing; remove that link (delete the file from the library) and retry',
  refUnknown: (revision: string): string =>
    `refs/${revision} was not changed: this download was queued by an older version that did not record the ref`,
  refMoved: (revision: string): string => `refs/${revision} was moved by another download meanwhile; not changed`,
} as const;

export interface DownloadEngineDeps {
  client: HubClient;
  hubRoot: string;
  safeFs: () => Promise<SafeFs>;
  lock: AppLock;
  settings: AppSettingsStore;
  statfs: (p: string) => Promise<{ bavail: number; bsize: number }>;
  now: () => number;
  emit: (e: DownloadProgressDTO) => void;
  symlinksSupported: boolean;
  /** Reads only (lstat, facts); every write goes through SafeFs. Defaults to the real filesystem. */
  fs?: ReadFs;
  /** Waits `ms`, rejecting with the signal's reason when it aborts. Tests shorten it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A file stops with this state and reason (no exception escapes a file's run). */
class Stop extends Error {
  constructor(readonly state: 'failed' | 'paused-disk', message: string) {
    super(message);
  }
}

/** A failure inside the commit step: recorded even when a pause arrived meanwhile (the commit ran to its end). */
class InCommit extends Error {
  constructor(readonly inner: unknown) {
    super(message(inner));
  }
}

const NO_SPACE = new Set(['ENOSPC', 'EDQUOT']);
const isNoSpace = (e: unknown): boolean => e instanceof SafeFsError && e.errno !== undefined && NO_SPACE.has(e.errno);
const RESUMABLE: ReadonlySet<DlState> = new Set(['paused', 'paused-disk', 'failed']);
const isRegular = (f: FileFacts | null): f is FileFacts => f !== null && f.isFile && !f.isSymlink && !f.isDirectory;
function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
type Usable = Extract<BlobSource, { ok: true }>;
/** A snapshot copy hashed before the AppLock: its facts then (the hash matched), or 'mismatch'. */
type Hashed = FileFacts | 'mismatch';
const joinNotes = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : `${a}; ${b}`);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal.reason);
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A counting semaphore whose waiters leave the line when their signal aborts. */
class Slots {
  private readonly waiters: Array<() => void> = [];
  constructor(private free: number) {}

  take(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const go = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(go);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal.reason);
      };
      this.waiters.push(go);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  give(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free += 1;
  }
}

interface Run { ctl: AbortController; done: Promise<void> }

export class DownloadEngine {
  private readonly items = new Map<string, QueueItem>();
  private readonly runs = new Map<string, Run>();
  private readonly streams = new Slots(MAX_STREAMS);
  /** Commit steps run one at a time inside the app as well (one AppLock instance cannot be taken twice). */
  private readonly commits = new Slots(1);
  /** One run per blob at a time: two files (or items) with the same etag never share a .incomplete. */
  private readonly blobBusy = new Map<string, Promise<void>>();
  private readonly lastProgress = new Map<string, { at: number; bytes: number }>();
  /** Bytes each running file will still write (its rest, plus its snapshot copy without symlinks), across files. */
  private readonly reserved = new Map<string, () => number>();
  private readonly fs: ReadFs;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private dirty = false;
  private saving: Promise<void> | null = null;
  /** Why the last queue save failed or was skipped, or null. The queue keeps running; the next state change saves again. */
  saveError: string | null = null;
  /** Why the last AppLock release failed, or null (a record left behind keeps deletions and later commits waiting). */
  lockError: string | null = null;

  constructor(private readonly d: DownloadEngineDeps) {
    this.fs = d.fs ?? readFs;
    this.sleep = d.sleep ?? defaultSleep;
  }

  /** Queues `item` (validated; its repo folder name must be safe) and starts its unfinished files. */
  async start(item: QueueItem): Promise<void> {
    const parsed = QUEUE_ITEM.safeParse(item);
    if (!parsed.success) throw new Error(`Invalid download: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    repoFolderName(parsed.data.repoId, parsed.data.type);   // throws on an unsafe repo id
    if (this.items.has(parsed.data.id)) throw new Error(`Download ${parsed.data.id} is already in the queue`);
    if (parsed.data.files.some((f) => f.state === 'done')) throw new Error('A new download cannot list files as done');
    const own = structuredClone(parsed.data);
    this.items.set(own.id, own);
    for (const f of own.files) {
      f.state = 'queued';
      f.error = null;
      this.emitState(own, f);
    }
    this.persist();
    for (const f of own.files) this.launch(own, f);
  }

  /** Stops every unfinished file of `id`; partial files stay. A file already committing finishes as done. */
  pause(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    for (const f of item.files) {
      if (f.state !== 'done' && !RESUMABLE.has(f.state)) this.set(item, f, 'paused', null);
      this.runs.get(this.key(item, f))?.ctl.abort(new Error('paused'));
    }
    this.persist();
  }

  /** Restarts the paused, disk-paused and failed files of `id` (Retry), resuming their partial files. */
  async resume(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    const again = item.files.filter((f) => RESUMABLE.has(f.state));
    for (const f of again) this.set(item, f, 'queued', null);
    this.persist();
    for (const f of again) this.launch(item, f);
  }

  /** Pause, then drop `id` from the queue. Nothing on disk changes: the partial files stay where they are. */
  cancel(id: string): void {
    if (!this.items.has(id)) return;
    this.pause(id);
    this.items.delete(id);
    this.persist();
  }

  list(): QueueItem[] {
    return structuredClone([...this.items.values()]);
  }

  /**
   * Loads the queue saved in settings (a bad block is an empty queue). Every file that is neither done nor
   * failed comes back 'paused' with its bytes read from its partial file; nothing starts until resume().
   */
  async restore(): Promise<void> {
    const { settings } = await this.d.settings.loadChecked();
    let loaded = false;
    for (const saved of settings.downloads?.items ?? []) {
      if (this.items.has(saved.id)) continue;
      loaded = true;
      const item = structuredClone(saved);
      this.items.set(item.id, item);
      for (const f of item.files) {
        if (f.state !== 'done' && f.state !== 'failed') {
          f.state = 'paused';
          f.error = null;
        }
        if (f.state !== 'done') f.bytes = await this.partialSize(item, f);
        this.emitState(item, f);
      }
    }
    if (loaded) this.persist();   // a bad or empty block stays in the file until the queue really changes
  }

  /** Resolves when no file is running and the queue is saved (tests, shutdown). */
  async whenIdle(): Promise<void> {
    for (;;) {
      const runs = [...this.runs.values()];
      if (runs.length > 0) {
        await Promise.all(runs.map((r) => r.done));
        continue;
      }
      if (this.saving) {
        await this.saving;
        continue;
      }
      return;
    }
  }

  // ---------- runs ----------

  private key(item: QueueItem, f: QueueFile): string {
    return `${item.id}\0${f.path}`;
  }

  /** Starts a file's run after any earlier run of the same file has wound down. */
  private launch(item: QueueItem, f: QueueFile): void {
    const k = this.key(item, f);
    const prev = this.runs.get(k);
    const ctl = new AbortController();
    const done = (prev ? prev.done : Promise.resolve())
      .then(() => this.runFile(item, f, ctl.signal))
      .finally(() => {
        if (this.runs.get(k)?.ctl === ctl) this.runs.delete(k);
        this.lastProgress.delete(k);
        this.persist();
      });
    this.runs.set(k, { ctl, done });
  }

  /** Never throws: every outcome ends as a state (an abort leaves the state pause() set). */
  private async runFile(item: QueueItem, f: QueueFile, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted) return;
      await this.oneAtATime(this.blobKey(item, f), signal, () => this.pipeline(item, f, signal));
    } catch (thrown) {
      let e = thrown;
      if (e instanceof InCommit) e = e.inner;   // the commit step ran to its end: its outcome is recorded even after a pause
      else if (signal.aborted) return;   // paused or cancelled: pause() set the state; whatever happened is kept on disk
      if (e instanceof Stop) this.set(item, f, e.state, e.message);
      else if (e instanceof HubClientError) this.set(item, f, 'failed', e.code === 'RANGE_IGNORED' ? MSG.cannotResume : e.message);
      else if (isNoSpace(e)) this.set(item, f, 'paused-disk', MSG.diskFull);
      else this.set(item, f, 'failed', message(e));
    } finally {
      this.reserved.delete(this.key(item, f));
    }
  }

  private blobKey(item: QueueItem, f: QueueFile): string {
    return `${repoFolderName(item.repoId, item.type)}/${f.etag}`;
  }

  private async oneAtATime(key: string, signal: AbortSignal, fn: () => Promise<void>): Promise<void> {
    let onAbort = (): void => undefined;
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    stopped.catch(() => undefined);
    try {
      for (let busy = this.blobBusy.get(key); busy; busy = this.blobBusy.get(key)) await Promise.race([busy, stopped]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) throw signal.reason;
    let release!: () => void;
    this.blobBusy.set(key, new Promise((r) => (release = r)));
    try {
      await fn();
    } finally {
      this.blobBusy.delete(key);
      release();
    }
  }

  private async pipeline(item: QueueItem, f: QueueFile, signal: AbortSignal): Promise<void> {
    const dfs = new DownloadFs(await this.d.safeFs(), this.d.hubRoot, { repoId: item.repoId, type: item.type }, this.fs);
    const inc = dfs.incompletePath(f.etag);
    const blob = join(dfs.folder, 'blobs', f.etag);
    for (;;) {
      // A blob already there (another downloader finished it, or a Retry after the commit): verify it, link only.
      if ((await this.facts(blob)) !== null) {
        this.set(item, f, 'verifying', null);
        const src = await this.verifyBlob(dfs, f);
        if (signal.aborted) throw signal.reason;
        if (!this.d.symlinksSupported && !(await this.roomFor(item, f, dfs, f.size))) throw new Stop('paused-disk', MSG.diskFull);
        return this.commit(item, f, dfs, signal, { blob: src });
      }
      await this.streams.take(signal);
      let waiting: boolean;
      try {
        // The slot is given back on every way out of here, a failing check included.
        waiting = await this.otherDownloader(item, inc, f);
        if (!waiting) await this.download(item, f, dfs, inc, signal);
      } finally {
        this.streams.give();
      }
      if (!waiting) break;
      this.set(item, f, 'waiting-other', MSG.otherProgram);
      await this.sleep(OTHER_RETRY_MS, signal);
    }
    this.set(item, f, 'verifying', null);
    const facts = await this.facts(inc);
    if (!isRegular(facts)) throw new Stop('failed', MSG.partialNotFile);
    if (facts.size !== f.size) throw new Stop('failed', MSG.endedEarly);
    if (!(await this.hashMatches(inc, facts, f))) throw new Stop('failed', MSG.partialMismatch);
    if (signal.aborted) throw signal.reason;
    await this.commit(item, f, dfs, signal, { incomplete: facts });
  }

  /** `.locks/<folder>/<etag>.lock` present and blobs/<etag>.incomplete modified in the last 10 minutes. */
  private async otherDownloader(item: QueueItem, inc: string, f: QueueFile): Promise<boolean> {
    const lock = join(this.d.hubRoot, '.locks', repoFolderName(item.repoId, item.type), `${f.etag}.lock`);
    if ((await this.facts(lock)) === null) return false;
    const partial = await this.facts(inc);
    return partial !== null && this.d.now() - partial.mtimeMs < OTHER_FRESH_MS;
  }

  /**
   * Streams the rest of the file into its .incomplete: created exclusively, or any regular partial file no
   * larger than the Hub size resumed from its end with a Range request, appended to only while it is still the file
   * whose facts were read. A 200 to that request is refused (RANGE_IGNORED) before the partial file is opened.
   */
  private async download(item: QueueItem, f: QueueFile, dfs: DownloadFs, inc: string, signal: AbortSignal): Promise<void> {
    const cur = await this.facts(inc);
    if (cur !== null && !isRegular(cur)) throw new Stop('failed', MSG.partialNotFile);
    if (cur !== null && cur.size > f.size) throw new Stop('failed', MSG.partialTooBig);
    const from = cur?.size ?? 0;
    f.bytes = from;
    // Without symlinks the snapshot entry is a second copy of the file: that needs room too.
    if (!(await this.roomFor(item, f, dfs, f.size - from + (this.d.symlinksSupported ? 0 : f.size)))) throw new Stop('paused-disk', MSG.diskFull);
    if (from === f.size) return;
    await dfs.ensureDirs(item.commit, this.relDir(f.path));
    this.set(item, f, 'downloading', null);
    const attempt = new AbortController();
    const sig = AbortSignal.any([signal, attempt.signal]);
    try {
      const res = await this.d.client.open(item.repoId, item.type, item.commit, f.path, from, sig);
      if (res.size !== null && res.size !== f.size) throw new Stop('failed', `the Hub reports ${res.size} bytes for this file, the listing ${f.size}`);
      const w = await dfs.openIncomplete(f.etag, cur);
      let failure: unknown = null;
      try {
        for await (const chunk of res.body) {
          if (f.bytes + chunk.length > f.size) throw new Stop('failed', MSG.tooManyBytes);
          await w.write(chunk);
          f.bytes += chunk.length;
          this.progress(item, f);
        }
      } catch (e) {
        failure = e;
      }
      try {
        await w.close();
      } catch (e) {
        failure ??= e;
      }
      if (failure !== null) throw failure;
    } finally {
      attempt.abort();
    }
    if (f.bytes < f.size) throw new Stop('failed', MSG.endedEarly);
  }

  /**
   * Across files: statfs of the nearest existing folder on the way to blobs/. The file may start only if
   * free − FREE_MARGIN − (what every other running file has reserved) leaves room for `own` plus, without symlinks,
   * the copies of the item's unchanged links. On success `own` is reserved (shrinking as bytes arrive) until the run ends.
   */
  private async roomFor(item: QueueItem, f: QueueFile, dfs: DownloadFs, own: number): Promise<boolean> {
    const links = await this.linkCopyBytes(item, dfs);
    const free = await this.freeBytes(dfs);
    const k = this.key(item, f);
    if (free - FREE_MARGIN - this.reservedExcept(k) < own + links) return false;
    const copy = this.d.symlinksSupported ? 0 : f.size;
    this.reserved.set(k, () => Math.max(0, f.size - f.bytes) + copy);
    return true;
  }

  private reservedExcept(k: string): number {
    let n = 0;
    for (const [key, rest] of this.reserved) if (key !== k) n += rest();
    return n;
  }

  /** Without symlinks: the bytes the item's unchanged links will copy (entries not yet in the snapshot). */
  private async linkCopyBytes(item: QueueItem, dfs: DownloadFs): Promise<number> {
    if (this.d.symlinksSupported) return 0;
    let n = 0;
    for (const l of item.links) {
      if ((await this.facts(join(dfs.folder, 'snapshots', item.commit, ...l.path.split('/')))) !== null) continue;
      const src = await dfs.blobSource(l.etag);
      n += src?.ok === true ? src.facts.size : 0;
    }
    return n;
  }

  private async freeBytes(dfs: DownloadFs): Promise<number> {
    let p = join(dfs.folder, 'blobs');
    for (;;) {
      try {
        if ((await this.fs.lstat(p)).isDirectory()) break;
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      const up = dirname(p);
      if (up === p) break;
      p = up;
    }
    const s = await this.d.statfs(p);
    return s.bavail * s.bsize;
  }

  /**
   * Under the AppLock (LOCKED → 'waiting-other', retried every 2 s): the blob (rename of the verified
   * .incomplete, or the verified blob already there, unchanged since), then the snapshot entry, then, when this was
   * the item's last file, the unchanged links and the ref. The file is done only when all of that succeeded.
   */
  private async commit(item: QueueItem, f: QueueFile, dfs: DownloadFs, signal: AbortSignal,
    have: { incomplete: FileFacts } | { blob: Usable }): Promise<void> {
    // The other files' snapshot copies are re-hashed now, before the AppLock (a deletion or sync is never
    // kept waiting for that read); under the lock only their facts are compared with the ones hashed here
    const hashed = item.files.every((o) => o === f || o.state === 'done') ? await this.hashCopies(item, f, dfs) : new Map<string, Hashed>();
    await this.underLock(item, f, signal, async () => {
      await dfs.ensureDirs(item.commit, this.relDir(f.path));
      let note: string | null = null;
      if ('incomplete' in have) {
        if ((await dfs.commitBlob(f.etag, have.incomplete)) === 'already-present') {
          await this.verifyBlob(dfs, f);
          note = `the same file was already in the cache; this download's partial file is left at ${dfs.incompletePath(f.etag)}`;
        }
      } else {
        const now = await dfs.blobSource(f.etag);
        if (now === null || !now.ok || now.path !== have.blob.path || !factsMatch(now.entry, have.blob.entry) || !factsMatch(now.facts, have.blob.facts)) {
          throw new Stop('failed', 'the blob changed while it was checked; Retry');
        }
      }
      await this.place(item, dfs, f.path, f.etag);
      if (item.files.every((o) => o === f || o.state === 'done')) note = joinNotes(note, await this.finish(item, f, dfs, hashed));
      this.set(item, f, 'done', note);
    });
  }

  private async underLock(item: QueueItem, f: QueueFile, signal: AbortSignal, fn: () => Promise<void>): Promise<void> {
    await this.commits.take(signal);
    try {
      for (;;) {
        try {
          await this.d.lock.acquire(this.d.now());
          break;
        } catch (e) {
          if (!(e instanceof ExecError) || e.code !== 'LOCKED') throw e;
          signal.throwIfAborted();   // a pause during the attempt: its 'paused' stands, and the commit never starts
          this.set(item, f, 'waiting-other', MSG.appBusy);
          await this.sleep(LOCK_RETRY_MS, signal);
        }
      }
      this.set(item, f, 'verifying', null);
      try {
        await fn();
      } catch (e) {
        throw new InCommit(e);
      } finally {
        await this.d.lock.release().then(() => { this.lockError = null; }, (e: unknown) => { this.lockError = `the app lock could not be released: ${message(e)}`; });
      }
    } finally {
      this.commits.give();
    }
  }

  /**
   * Unchanged files linked into snapshots/<commit>, then refs/<revision> (never for a commit),
   * moved only from the commit it named at the start. Returns the note for the item, or null.
   */
  private async finish(item: QueueItem, f: QueueFile, dfs: DownloadFs, hashed: ReadonlyMap<string, Hashed>): Promise<string | null> {
    // Every file committed earlier must still be in place (a deletion may have run between files);
    // otherwise the ref is not moved, and the missing files fail so Retry downloads them again. A copy with other bytes
    // fails with its own reason.
    const gone: Array<{ o: QueueFile; why: string }> = [];
    for (const o of item.files) {
      const r = await this.inPlace(item, dfs, o, o === f ? null : hashed.get(o.path));
      if (r !== 'ok') gone.push({ o, why: r === 'mismatch' ? MSG.copyMismatch : MSG.removed });
    }
    if (gone.length > 0) {
      for (const { o, why } of gone) if (o !== f) this.set(item, o, 'failed', why);
      throw new Stop('failed', (gone.find((g) => g.o === f) ?? gone[0]!).why);
    }
    const links = await this.linkCopyBytes(item, dfs);
    if (links > 0 && (await this.freeBytes(dfs)) - FREE_MARGIN - this.reservedExcept(this.key(item, f)) < links) {
      throw new Stop('paused-disk', `${MSG.diskFull} (the unchanged files still to copy need ${links} bytes)`);
    }
    const bad: string[] = [];
    for (const l of item.links) {
      // The cached blob is linked only after its content hash (which covers its size) matches the Hub's etag; a
      // store link is checked through its payload.
      const src = await dfs.blobSource(l.etag);
      if (src === null || !src.ok || !(await this.hashMatches(src.path, src.facts, { size: src.facts.size, etag: l.etag, lfs: l.etag.length === 64 }))) {
        bad.push(l.path);
        continue;
      }
      try {
        await dfs.ensureDirs(item.commit, this.relDir(l.path));
        await this.place(item, dfs, l.path, l.etag);
      } catch (e) {
        if (e instanceof Stop && e.state === 'paused-disk') throw e;
        throw new Stop('failed', `could not link the unchanged file ${l.path}: ${message(e)}; the ref was not moved`);
      }
    }
    if (bad.length > 0) throw new Stop('failed', `${MSG.cachedMismatch} (${bad.join(', ')}); it was not linked and the ref was not moved`);
    if (isCommitHash(item.revision)) return null;
    if (item.refAtStart === undefined) return MSG.refUnknown(item.revision);   // A legacy item
    let moved: 'replaced' | 'same' | 'moved';
    try {
      moved = await dfs.replaceRef(item.revision, item.commit, item.refAtStart);
    } catch (e) {
      // DownloadFs names any temp file the attempt left (never deleted), so the user can remove it.
      throw new Stop('failed', `could not update refs/${item.revision}: ${message(e)}`);
    }
    return moved === 'moved' ? MSG.refMoved(item.revision) : null;
  }

  /**
   * snapshots/<commit>/<path> → the blob: a link, or (no symlinks) a copy created exclusively at the entry and checked.
   * A shorter regular entry (a copy that stopped part-way, e.g. on ENOSPC) is finished by appending, once its bytes are
   * shown to be the blob's first bytes; anything else there is "a different file is already there", left untouched.
   * A partial copy left by a failure is named in the reason, from the error's `leftPath` (never parsed from text).
   */
  private async place(item: QueueItem, dfs: DownloadFs, path: string, etag: string): Promise<void> {
    try {
      if (this.d.symlinksSupported) {
        await dfs.linkSnapshot(item.commit, path, etag);
      } else {
        const entry = await this.facts(join(dfs.folder, 'snapshots', item.commit, ...path.split('/')));
        const src = await dfs.blobSource(etag);
        if (isRegular(entry) && src?.ok === true && entry.size < src.facts.size) await dfs.resumeSnapshotCopy(item.commit, path, etag, entry);
        else await dfs.copySnapshot(item.commit, path, etag);
      }
    } catch (e) {
      const left = e instanceof DownloadFsError ? e.leftPath : null;
      const where = left === null ? '' : `; the partial copy is left at ${left}`;
      if (e instanceof SafeFsError && e.code === 'EXISTS') throw new Stop('failed', `${MSG.different}${where}`);
      if (isNoSpace(e)) throw new Stop('paused-disk', `${MSG.diskFull}${where}`);
      throw e;
    }
  }

  /**
   * Without symlinks, before the AppLock: each done file's snapshot copy (other than `f`) that is a
   * regular file of the Hub size is hashed; its facts at that moment are kept when the hash matches, else 'mismatch'.
   */
  private async hashCopies(item: QueueItem, f: QueueFile, dfs: DownloadFs): Promise<Map<string, Hashed>> {
    const out = new Map<string, Hashed>();
    if (this.d.symlinksSupported) return out;
    for (const o of item.files) {
      if (o === f || o.state !== 'done') continue;
      const p = join(dfs.folder, 'snapshots', item.commit, ...o.path.split('/'));
      const entry = await this.facts(p);
      if (!isRegular(entry) || entry.size !== o.size) continue;
      out.set(o.path, (await this.hashMatches(p, entry, o)) ? entry : 'mismatch');
    }
    return out;
  }

  /**
   * A committed file is in place: blobs/<etag> holds the Hub size (a regular file, or a store link to a regular
   * payload), and snapshots/<commit>/<path> is a link resolving to those very bytes (dev + ino) or, without symlinks,
   * a regular copy of the same size and content hash. `hashed`: null for the file whose copy was just
   * made and checked under this lock; else what hashCopies found, so that only the facts are compared here (a copy
   * not hashed before, or changed since, is hashed now). 'mismatch': the copy has other bytes.
   */
  private async inPlace(item: QueueItem, dfs: DownloadFs, f: QueueFile, hashed: Hashed | null | undefined): Promise<'ok' | 'removed' | 'mismatch'> {
    const src = await dfs.blobSource(f.etag);
    if (src === null || !src.ok || src.facts.size !== f.size) return 'removed';
    const entryPath = join(dfs.folder, 'snapshots', item.commit, ...f.path.split('/'));
    const entry = await this.facts(entryPath);
    if (entry === null) return 'removed';
    if (!entry.isSymlink) {
      if (this.d.symlinksSupported || !isRegular(entry) || entry.size !== f.size) return 'removed';
      if (hashed === null || (hashed !== undefined && hashed !== 'mismatch' && factsMatch(entry, hashed))) return 'ok';
      if (hashed === 'mismatch') return 'mismatch';
      return (await this.hashMatches(entryPath, entry, f)) ? 'ok' : 'mismatch';
    }
    try {
      const target = await this.fs.stat(entryPath);
      return target.dev === src.facts.dev && target.ino === src.facts.ino ? 'ok' : 'removed';
    } catch {
      return 'removed';
    }
  }

  /**
   * The blob already at blobs/<etag> must hold the Hub size and hash (a regular file, or a store link checked through
   * its payload), else the file fails untouched.
   */
  private async verifyBlob(dfs: DownloadFs, f: QueueFile): Promise<Usable> {
    const src = await dfs.blobSource(f.etag);
    if (src !== null && !src.ok && src.reason === 'dangling') throw new Stop('failed', MSG.danglingStore);
    if (src === null || !src.ok || src.facts.size !== f.size || !(await this.hashMatches(src.path, src.facts, f))) throw new Stop('failed', MSG.different);
    return src;
  }

  private async hashMatches(p: string, facts: FileFacts, file: { size: number; etag: string; lfs: boolean }): Promise<boolean> {
    const h = hasherFor(file);
    await (await this.d.safeFs()).readChunks(p, facts, (chunk) => h.update(chunk));
    return matches(file, h.digestHex());
  }

  private relDir(path: string): string {
    const d = posix.dirname(path);
    return d === '.' ? '' : d;
  }

  private async facts(p: string): Promise<FileFacts | null> {
    return factsOf(this.fs, p);
  }

  private async partialSize(item: QueueItem, f: QueueFile): Promise<number> {
    try {
      const p = join(this.d.hubRoot, repoFolderName(item.repoId, item.type), 'blobs', `${f.etag}.incomplete`);
      const facts = await this.facts(p);
      return isRegular(facts) ? Math.min(facts.size, f.size) : 0;
    } catch {
      return 0;
    }
  }

  // ---------- state, progress, persistence ----------

  private set(item: QueueItem, f: QueueFile, state: DlState, error: string | null): void {
    if (f.state === state && f.error === error) return;
    f.state = state;
    f.error = error;
    this.emitState(item, f);
    this.persist();
  }

  private emitState(item: QueueItem, f: QueueFile): void {
    this.lastProgress.set(this.key(item, f), { at: this.d.now(), bytes: f.bytes });
    this.send(item, f, 0);
  }

  /** Byte progress, at most once per PROGRESS_MS per file. */
  private progress(item: QueueItem, f: QueueFile): void {
    const k = this.key(item, f);
    const now = this.d.now();
    const last = this.lastProgress.get(k);
    if (last && now - last.at < PROGRESS_MS) return;
    const rate = last && now > last.at ? ((f.bytes - last.bytes) * 1000) / (now - last.at) : 0;
    this.lastProgress.set(k, { at: now, bytes: f.bytes });
    this.send(item, f, rate);
  }

  private send(item: QueueItem, f: QueueFile, bytesPerSec: number): void {
    try {
      this.d.emit({ id: item.id, path: f.path, state: f.state, bytes: f.bytes, size: f.size, bytesPerSec, error: f.error });
    } catch {
      // a failing listener never stops a download
    }
  }

  /**
   * Saves the queue (version 1) through AppSettingsStore.update, coalescing bursts. A settings file whose auto-empty
   * or advice part cannot be trusted is never rewritten from here (the queue never touches autoEmptyDays).
   */
  private persist(): void {
    this.dirty = true;
    this.saving ??= this.flush();
  }

  private async flush(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        const items = this.list();
        try {
          let skipped: string | null = null;
          await this.d.settings.update((cur) => {
            // A bad advice block would be rewritten as the defaults; left as it is, like remember().
            // A bad downloads block is this queue's own and is replaced by it.
            const why = cur.error ?? cur.adviceError;
            if (why === null) return { ...cur.settings, downloads: { version: 1, items } };
            skipped = `settings.json cannot be trusted (${why}); the download queue is not saved and will not survive a restart`;
            return null;
          });
          this.saveError = skipped;
        } catch (e) {
          this.saveError = message(e);
        }
      }
    } finally {
      this.saving = null;
    }
  }
}
