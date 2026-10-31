// The download writer: every write of a download goes through
// SafeFs and lands strictly inside <hub>/<repo folder>/ of the one repo being downloaded. It never deletes (no unlink,
// no rmdir, also on failure paths) and never overwrites: the single replacement is refs/<revision>, done atomically.
// Paths are built here from validated pieces only (40-hex commit, 40/64-hex etag, a safe relative sibling path), and
// every target is checked lexically and after resolving its existing ancestors before SafeFs is asked to act.
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { FileFacts, RepoType } from '../types';
import { factsOf, isNotFound, readFs, type ReadFs, type StatLike } from '../fsx';
import { isStrictlyInside } from '../paths';
import { SafeFs, SafeFsError, type IncompleteWriter } from '../safe-fs';
import { parseRepoFolder } from '../scan/scanner';
import { isStorePath } from '../scan/store';
import { isCommitHash, safeRef } from '../../shared/hub-input';
import { hasherFor, matches } from './hash';
import { isSafeSiblingPath, repoFolderName } from './remote-repo';

const COMMIT = /^[0-9a-f]{40}$/;
const ETAG = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A SafeFsError that also says which file the failed call left behind for the user (a partial snapshot copy, a ref
 * temp file), or null when it left nothing. Callers read the path from here, never from the message.
 */
export class DownloadFsError extends SafeFsError {
  constructor(from: SafeFsError, message: string, readonly leftPath: string | null) {
    super(from.code, from.path, message, from.errno, from.resolved);
    this.message = message;   // `message` already carries the code and path of `from`
    this.name = 'SafeFsError';   // still a SafeFsError to every caller (instanceof and name)
  }
}

/**
 * What blobs/<etag> holds: `entry` is its own lstat; `path` and `facts` name the regular file with the bytes,
 * the blob itself or, for a link into the shared store, its payload followed exactly one hop (as the scanner does).
 * 'dangling': a store link whose payload is missing. 'unusable': anything else (a directory, a link to another link
 * or outside the store layout).
 */
export type BlobSource = { ok: true; entry: FileFacts; path: string; facts: FileFacts } | { ok: false; reason: 'dangling' | 'unusable' };

const refuse = (p: string, message: string, errno?: string): SafeFsError => new SafeFsError('CONTAINMENT', p, message, errno);
const errnoOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const isRegular = (f: FileFacts | null): f is FileFacts => f !== null && f.isFile && !f.isSymlink && !f.isDirectory;

export class DownloadFs {
  /** <hub>/<repo folder>: the only place this writer touches. */
  readonly folder: string;
  private readonly hubRoot: string;

  /**
   * `hubRoot` must be the SafeFs hub root (as given or normalised). The folder name is the scanner's own pattern for
   * the repo's type and must parse back to the same id and type. `fs` is for reads only; every write goes to `safe`.
   */
  constructor(private readonly safe: SafeFs, hubRoot: string, repo: { repoId: string; type: RepoType }, private readonly fs: ReadFs = readFs) {
    if (typeof hubRoot !== 'string' || !isAbsolute(hubRoot) || resolve(hubRoot) !== safe.roots.hubRoot) {
      throw refuse(String(hubRoot), 'the download hub root must be the SafeFs hub root');
    }
    let name: string;
    try {
      name = repoFolderName(repo.repoId, repo.type);
    } catch {
      throw refuse(repo.repoId, 'unsafe repo id');
    }
    const parsed = parseRepoFolder(name);
    if (parsed === null || parsed.id !== repo.repoId || parsed.type !== repo.type) throw refuse(name, 'repo folder name does not round-trip');
    this.hubRoot = safe.roots.hubRoot;
    this.folder = join(this.hubRoot, name);
  }

  /** Creates blobs/, snapshots/<commit>/<relDir> and refs/ (one level at a time; may create the repo folder). */
  async ensureDirs(commit: string, relDir: string): Promise<void> {
    const snap = relDir === '' ? this.snapshotDir(commit) : this.snapshotEntry(commit, relDir);
    for (const dir of [join(this.folder, 'blobs'), snap, join(this.folder, 'refs')]) {
      await this.confine(dir, true);
      await this.safe.mkdirp(dir);
    }
  }

  incompletePath(etag: string): string {
    return `${this.blobPath(etag)}.incomplete`;
  }

  /** blobs/<etag>.incomplete: created exclusively (expect null) or resumed when it still matches `expect`. */
  async openIncomplete(etag: string, expect: FileFacts | null): Promise<IncompleteWriter> {
    const p = this.incompletePath(etag);
    await this.confine(p);
    return this.safe.openIncomplete(p, expect);
  }

  /**
   * Renames the verified blobs/<etag>.incomplete to blobs/<etag>, revalidated against
   * `incompleteFacts`. An existing blobs/<etag> (whatever it is) is not replaced: 'already-present', and the
   * .incomplete is left in place for the caller to report. Residual race (SafeFs.rename): Node has no
   * RENAME_NOREPLACE, so a blob created by another downloader between SafeFs's lstat and rename(2) would be replaced;
   * the caller must have verified the .incomplete's hash against `etag` first, so what replaces it is the same content.
   */
  async commitBlob(etag: string, incompleteFacts: FileFacts): Promise<'committed' | 'already-present'> {
    const dest = this.blobPath(etag);
    const src = this.incompletePath(etag);
    if (!isRegular(incompleteFacts)) throw new SafeFsError('IO', src, 'commitBlob moves regular files only');
    await this.confine(src);
    await this.confine(dest);
    if ((await this.facts(dest)) !== null) return 'already-present';
    try {
      await this.safe.rename(src, dest, incompleteFacts);
    } catch (e) {
      // SafeFs checks the destination itself just before the rename: a blob that appeared meanwhile.
      if (e instanceof SafeFsError && e.code === 'EXISTS' && e.path === dest) return 'already-present';
      throw e;
    }
    return 'committed';
  }

  /**
   * snapshots/<commit>/<path> -> a relative symlink to blobs/<etag>, text exactly
   * posix.relative(dirname(entry), blobs/<etag>) as huggingface_hub writes it. The blob must be a regular file, or a
   * link into the shared store whose payload is one (blobSource). The same link already there is 'same'; any other entry is EXISTS and is left unchanged.
   */
  async linkSnapshot(commit: string, path: string, etag: string): Promise<'linked' | 'same'> {
    const entry = this.snapshotEntry(commit, path);
    const text = posix.relative(posix.dirname(`snapshots/${commit}/${path}`), `blobs/${etag}`);
    await this.confine(entry);
    await this.requireBlob(etag);
    const now = await this.facts(entry);
    if (now !== null) {
      if (now.isSymlink && now.linkTarget === text) return 'same';
      throw new SafeFsError('EXISTS', entry, 'a different file is already there');
    }
    await this.safe.symlink(text, entry);
    return 'linked';
  }

  /**
   * The no-symlink fallback: a copy of blobs/<etag> created exclusively at
   * snapshots/<commit>/<path> (O_EXCL: atomic, never replaces anything), then checked (regular file, the blob's size
   * and content hash). An existing regular file with the blob's size and hash is 'same'; any other existing entry is
   * EXISTS (a shorter regular file may be finished with resumeSnapshotCopy). A copy that fails after the entry was
   * created leaves it in place, never removed, and names it in `leftPath` (the Node errno, e.g. ENOSPC, is kept).
   */
  async copySnapshot(commit: string, path: string, etag: string): Promise<'copied' | 'same'> {
    const entry = this.snapshotEntry(commit, path);
    await this.confine(entry);
    const { path: blob, facts: blobFacts } = await this.requireBlob(etag);
    const now = await this.facts(entry);
    if (now !== null) {
      if (isRegular(now) && now.size === blobFacts.size && (await this.hashMatches(entry, now, etag))) return 'same';
      throw new SafeFsError('EXISTS', entry, 'a different file is already there');
    }
    let created = false;
    try {
      await this.safe.copyExclusive(blob, entry, blobFacts, { onCreated: () => { created = true; } });
    } catch (e) {
      // Only a failure after this call's own exclusive create left a partial copy; SafeFs's message then names it
      // already. Before that, whatever is at the entry (if anything) is someone else's and is never named.
      throw new DownloadFsError(e as SafeFsError, (e as SafeFsError).message, created ? entry : null);
    }
    await this.checkCopy(entry, blobFacts, etag);
    return 'copied';
  }

  /**
   * Finishes a snapshot copy that stopped part-way: `expect` (read just before) must name a regular file at
   * snapshots/<commit>/<path> shorter than the blob, whose bytes equal the blob's first bytes (compared by SHA-256),
   * else EXISTS ("a different file is already there", nothing written). The rest of the blob is then appended through
   * SafeFs.appendExisting (lstat + fstat checked, never truncates or replaces) and the whole entry is checked. On
   * failure the entry stays where it is and is named in `leftPath`.
   */
  async resumeSnapshotCopy(commit: string, path: string, etag: string, expect: FileFacts): Promise<'copied'> {
    const entry = this.snapshotEntry(commit, path);
    await this.confine(entry);
    const { path: blob, facts: blobFacts } = await this.requireBlob(etag);
    if (!isRegular(expect) || expect.size >= blobFacts.size) throw new SafeFsError('EXISTS', entry, 'a different file is already there');
    const have = expect.size;
    const mine = createHash('sha256');
    await this.safe.readChunks(entry, expect, (c) => void mine.update(c));
    const theirs = createHash('sha256');
    let seen = 0;
    await this.safe.readChunks(blob, blobFacts, (c) => {
      const part = c.subarray(0, Math.max(0, have - seen));
      theirs.update(part);
      seen += c.length;
    });
    if (mine.digest('hex') !== theirs.digest('hex')) throw new SafeFsError('EXISTS', entry, 'a different file is already there');
    const w = await this.safe.appendExisting(entry, expect);   // refused before writing: nothing to name
    let failure: unknown = null;
    let off = 0;
    try {
      await this.safe.readChunks(blob, blobFacts, async (c) => {
        const from = Math.max(0, have - off);
        off += c.length;
        if (from < c.length) await w.write(c.subarray(from));
      });
    } catch (e) {
      failure = e;
    }
    try {
      await w.close();
    } catch (e) {
      failure ??= e;
    }
    if (failure !== null) {
      const err = failure as SafeFsError; // SafeFs only throws SafeFsError
      throw new DownloadFsError(err, `${err.message}; the partial copy is left at ${entry}`, entry);
    }
    await this.checkCopy(entry, blobFacts, etag);
    return 'copied';
  }

  /** A copy just written must be a regular file with the blob's size and hash; else IO, the copy left and named. */
  private async checkCopy(entry: string, blobFacts: FileFacts, etag: string): Promise<void> {
    const copy = await this.facts(entry);
    if (!isRegular(copy) || copy.size !== blobFacts.size || !(await this.hashMatches(entry, copy, etag))) {
      const err = new SafeFsError('IO', entry, 'the snapshot copy does not match the blob');
      throw new DownloadFsError(err, `${err.message}; it is left at ${entry}`, entry);
    }
  }

  /**
   * refs/<revision> = `commit` (40-hex, no newline, as huggingface_hub writes it), replaced atomically through
   * a temp file named uniquely per attempt, refs/<dir>/.<name>.<8 hex>.hfcm-tmp, created exclusively, and
   * only if the ref is still what was read just before. A 40-hex revision writes no ref and is refused here.
   * The ref moves only from `from`, the commit it named when the download started (null: it was absent).
   * Already `commit`: 'same', nothing written. Absent or naming another commit than expected: 'moved', left as it
   * is (another download moved it on meanwhile, so it never goes back to an older commit). A ref that is not a regular
   * file is EXISTS. A temp file of a failed attempt is left in place, never deleted, and named in the thrown error's
   * message; it never blocks a later attempt, which uses a new name.
   */
  async replaceRef(revision: string, commit: string, from: string | null): Promise<'replaced' | 'same' | 'moved'> {
    if (typeof revision !== 'string' || !safeRef(revision) || isCommitHash(revision)) throw refuse(String(revision), 'not a ref name this app writes');
    if (typeof commit !== 'string' || !COMMIT.test(commit)) throw refuse(String(commit), 'a ref holds a 40-hex commit only');
    if (from !== null && (typeof from !== 'string' || !COMMIT.test(from))) throw refuse(String(from), 'a ref holds a 40-hex commit only');
    const ref = join(this.folder, 'refs', ...revision.split('/'));
    const tmp = join(dirname(ref), `.${basename(ref)}.${randomBytes(4).toString('hex')}.hfcm-tmp`);
    await this.confine(dirname(ref), true);
    await this.confine(ref);
    await this.confine(tmp);
    await this.safe.mkdirp(dirname(ref));
    const current = await this.facts(ref);
    if (current !== null && !isRegular(current)) throw new SafeFsError('EXISTS', ref, `refs/${revision} is not a regular file`);
    const named = current === null ? null : await this.refText(ref);
    if (named === commit) return 'same';
    if (named !== from || (current !== null && named === null)) return 'moved';
    try {
      await this.safe.writeFileAtomic(ref, commit, { tmpPath: tmp, expect: current, keepTmp: true });
    } catch (e) {
      const err = e as SafeFsError; // writeFileAtomic only throws SafeFsError
      const named = new SafeFsError(err.code, ref, err.message, err.errno, err.resolved);
      throw new DownloadFsError(named, `${err.message}; any temp file of this attempt is left at ${tmp}`, tmp);
    }
    return 'replaced';
  }

  /** The commit a regular ref file names (whitespace stripped, as the scanner reads it), or null for any other text. */
  private async refText(ref: string): Promise<string | null> {
    let text: string;
    try {
      text = await this.fs.readFile(ref, 'utf8');
    } catch (e) {
      throw new SafeFsError('IO', ref, String(e), errnoOf(e));
    }
    const t = text.trim();
    return COMMIT.test(t) ? t : null;
  }

  private blobPath(etag: string): string {
    if (typeof etag !== 'string' || !ETAG.test(etag)) throw refuse(String(etag), 'an etag is 40 or 64 lowercase hex');
    return join(this.folder, 'blobs', etag);
  }

  private snapshotDir(commit: string): string {
    if (typeof commit !== 'string' || !COMMIT.test(commit)) throw refuse(String(commit), 'a snapshot is named by a 40-hex commit');
    return join(this.folder, 'snapshots', commit);
  }

  private snapshotEntry(commit: string, path: string): string {
    const dir = this.snapshotDir(commit);
    if (typeof path !== 'string' || !isSafeSiblingPath(path)) throw refuse(String(path), 'unsafe path in the repo');
    return join(dir, ...path.split('/'));
  }

  /**
   * `target` must be strictly inside the repo folder lexically; the folder (when it exists) and every existing
   * component below it on the way to `target` (`target` itself too when `leafDir`) must be a real directory, never a
   * symlink; and realpath of the nearest existing one must stay inside realpath of the folder. When the folder does
   * not exist yet, the hub root must resolve (SafeFs then creates the folder under it). Anything else is CONTAINMENT.
   * Residual race: this check and SafeFs's own resolution (hub-root containment only) are separate passes, so a
   * component swapped to a symlink into another repo folder in between is not seen here. Every write behind it is an
   * exclusive create (mkdir, 'wx', symlink, O_EXCL copy) except the blob and ref renames; it needs a concurrent writer
   * inside the hub acting against this app.
   */
  private async confine(target: string, leafDir = false): Promise<void> {
    if (!isStrictlyInside(target, this.folder)) throw refuse(target, `outside the repo folder ${this.folder}`);
    const top = await this.lstatOrNull(this.folder, target);
    if (top === null) {
      await this.real(this.hubRoot, target);
      return;
    }
    if (top.isSymbolicLink() || !top.isDirectory()) throw refuse(target, `${this.folder} is a symlink or not a directory`);
    const realFolder = await this.real(this.folder, target);
    const segs = relative(this.folder, target).split(sep);
    let cur = this.folder;
    for (const seg of leafDir ? segs : segs.slice(0, -1)) {
      const next = join(cur, seg);
      const st = await this.lstatOrNull(next, target);
      if (st === null) break;
      if (st.isSymbolicLink() || !st.isDirectory()) throw refuse(target, `${next} is a symlink or not a directory`);
      cur = next;
    }
    if (cur !== this.folder && !isStrictlyInside(await this.real(cur, target), realFolder)) {
      throw refuse(target, `${cur} resolves outside the repo folder`);
    }
  }

  private async lstatOrNull(p: string, target: string): Promise<StatLike | null> {
    try {
      return await this.fs.lstat(p);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw refuse(target, `cannot inspect ${p}`, errnoOf(e));
    }
  }

  private async real(p: string, target: string): Promise<string> {
    try {
      return await this.fs.realpath(p);
    } catch (e) {
      throw refuse(target, `cannot resolve ${p}`, errnoOf(e));
    }
  }

  private async facts(p: string): Promise<FileFacts | null> {
    try {
      return await factsOf(this.fs, p);
    } catch (e) {
      throw new SafeFsError('IO', p, String(e), errnoOf(e));
    }
  }

  /**
   * blobs/<etag> (confined): null when nothing is there, else what holds its bytes (see BlobSource). A store link
   * counts only when its target is a store path (<hub>/blobs/<xx>/<64 hex>) that is itself a regular file.
   */
  async blobSource(etag: string): Promise<BlobSource | null> {
    const blob = this.blobPath(etag);
    await this.confine(blob);
    const entry = await this.facts(blob);
    if (entry === null) return null;
    if (entry.isFile && !entry.isSymlink && !entry.isDirectory) return { ok: true, entry, path: blob, facts: entry };
    if (!entry.isSymlink || entry.linkTarget === undefined) return { ok: false, reason: 'unusable' };
    const payload = resolve(dirname(blob), entry.linkTarget);
    if (!isStorePath(this.hubRoot, payload)) return { ok: false, reason: 'unusable' };
    const facts = await this.facts(payload);
    if (facts === null) return { ok: false, reason: 'dangling' };
    return isRegular(facts) ? { ok: true, entry, path: payload, facts } : { ok: false, reason: 'unusable' };
  }

  /** The blob a snapshot entry will name: a usable BlobSource, else STALE (no dangling links). */
  private async requireBlob(etag: string): Promise<{ path: string; facts: FileFacts }> {
    const src = await this.blobSource(etag);
    if (src === null || !src.ok) throw new SafeFsError('STALE', this.blobPath(etag), 'the blob is missing or not a regular file');
    return src;
  }

  /** Content hash of the regular file `p` (the Hub's etag rule: SHA-256 for 64-hex, git blob SHA-1 for 40-hex). */
  private async hashMatches(p: string, facts: FileFacts, etag: string): Promise<boolean> {
    const file = { size: facts.size, etag, lfs: etag.length === 64 };
    const h = hasherFor(file);
    await this.safe.readChunks(p, facts, (chunk) => h.update(chunk));
    return matches(file, h.digestHex());
  }
}
