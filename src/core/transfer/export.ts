// Export: copies an ExportSet (export-plan.ts) to a transfer drive through DriveWriter, the only writer.
// Per repo commit: name every file (a plain snapshot copy is hashed first), copy each object that is not complete on the
// drive yet, part by part, then add the manifest last, so an export that stops early shows nothing in Load from USB.
// The cache is only read. Nothing on the drive is read back: a part with its full size is taken as written (its name is
// the hash of the file, so the same name is the same bytes), and a short one is continued from its end.
import { createHash } from 'node:crypto';
import { factsOf, fileReadAt, readFs, type ReadFs } from '../fsx';
import type { FileFacts, RepoType } from '../types';
import { DriveError, DriveWriter } from './drive-writer';
import { partStates, readDrive, READ_CHUNK, transferRoot, type DriveContents, type ObjectRef } from './drive-reader';
import { nameFor, type ExportFile, type ExportRepo, type ExportSet } from './export-plan';
import { PART_SIZE, partPath, partSizes, repoKey, serializeManifest, type TransferFile } from './format';

/** Left free on the drive after an export: file-system bookkeeping (folders, cluster rounding) is not in the byte count. */
export const EXPORT_MARGIN = 64 * 1024 * 1024;

export type ExportFileState = 'queued' | 'hashing' | 'copying' | 'done' | 'failed';
export interface ExportProgress {
  repoId: string; type: RepoType; commit: string; path: string; state: ExportFileState; bytes: number; size: number; error: string | null;
}
export type ExportStop =
  /** The drive filled up. */
  | 'full'
  | 'cancelled'
  /** The drive could not be prepared or went away. */
  | 'drive';
export interface ExportRepoResult {
  repoId: string; type: RepoType; commit: string;
  /** The manifest added, null when nothing new was needed (everything was on the drive already) or the repo failed. */
  manifest: string | null;
  failed: Array<{ path: string; error: string }>;
}
export interface ExportResult {
  /** Every repo was exported in full. */
  ok: boolean;
  repos: ExportRepoResult[];
  /** Why the export stopped before its end, with the text to show; null when it ran to the end. */
  stopped: { why: ExportStop; message: string } | null;
}

export interface ExportDeps {
  volumeRoot: string;
  now: () => number;
  signal: AbortSignal;
  onProgress: (p: ExportProgress) => void;
  fs?: ReadFs;
  /** The part size for objects not on the drive yet (tests use small ones). */
  partSize?: number;
}

export const SOURCE_CHANGED = 'the file changed in the cache while it was being exported';
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const regular = (f: FileFacts | null): f is FileFacts => f !== null && f.isFile && !f.isSymlink;
const same = (a: FileFacts, b: FileFacts | null): boolean => b !== null && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Bytes an object still needs on the drive: 0 when a manifest already names it complete, else what its parts lack. */
async function objectNeeds(root: string, drive: DriveContents | null, o: ObjectRef, fs: ReadFs): Promise<number> {
  if (drive?.objects.has(o.etag)) return 0;
  if (drive === null) return o.size;
  const have = await partStates(root, o, fs);
  return partSizes(o.size, o.partSize).reduce((n, want, i) => {
    const h = have[i] ?? 0;
    return n + (h >= 0 && h <= want ? want - h : want);
  }, 0);
}

/**
 * Bytes the set would still write to the volume (each object once; what is already there counts as zero, a part
 * written part-way counts for its rest). A plain snapshot copy has no name before it is hashed, so it counts in full.
 */
export async function exportNeeds(set: ExportSet, volumeRoot: string, opts: { fs?: ReadFs; partSize?: number } = {}): Promise<{ bytes: number; files: number }> {
  const fs = opts.fs ?? readFs;
  const drive = await readDrive(volumeRoot, fs);
  const root = transferRoot(volumeRoot);
  const seen = new Set<string>();
  let bytes = 0;
  let files = 0;
  for (const repo of set.repos) {
    for (const f of repo.files) {
      if (f.etag === null) {
        bytes += f.size;
        files += 1;
        continue;
      }
      if (seen.has(f.etag)) continue;
      seen.add(f.etag);
      const need = await objectNeeds(root, drive, { etag: f.etag, size: f.size, partSize: opts.partSize ?? PART_SIZE }, fs);
      bytes += need;
      if (need > 0) files += 1;
    }
  }
  return { bytes, files };
}

/** Both hashes of a regular file, read once. */
async function hashFile(path: string, size: number, signal: AbortSignal, onBytes: (n: number) => void): Promise<{ sha256: string; gitSha1: string }> {
  const a = createHash('sha256');
  const b = createHash('sha1').update(`blob ${size}\0`);
  const r = fileReadAt(path);
  try {
    for (let off = 0; off < size;) {
      signal.throwIfAborted();
      const chunk = await r.readAt(off, Math.min(READ_CHUNK, size - off));
      if (chunk.length === 0) throw new Error(SOURCE_CHANGED);
      a.update(chunk);
      b.update(chunk);
      off += chunk.length;
      onBytes(off);
    }
  } finally {
    await r.close();
  }
  return { sha256: a.digest('hex'), gitSha1: b.digest('hex') };
}

class Stopped extends Error {
  constructor(readonly why: ExportStop, message: string) {
    super(message);
  }
}

export async function runExport(set: ExportSet, deps: ExportDeps): Promise<ExportResult> {
  const fs = deps.fs ?? readFs;
  const newPartSize = deps.partSize ?? PART_SIZE;
  const writer = new DriveWriter(deps.volumeRoot);
  const root = writer.root;
  const results: ExportRepoResult[] = [];
  const emit = (repo: ExportRepo, f: ExportFile, state: ExportFileState, bytes: number, error: string | null = null): void => {
    try {
      deps.onProgress({ repoId: repo.repoId, type: repo.type, commit: repo.commit, path: f.path, state, bytes, size: f.size, error });
    } catch {
      // a failing listener never stops an export
    }
  };
  /** Turns what a file's copy threw into a Stopped (the whole export ends) or returns the text (that file failed). */
  const failure = (e: unknown): string => {
    if (deps.signal.aborted) throw new Stopped('cancelled', 'The export was cancelled.');
    if (e instanceof DriveError && e.code === 'FULL') throw new Stopped('full', 'The drive is full. What was copied so far stays on it and is reused by the next export.');
    if (e instanceof DriveError && e.code === 'NO_DRIVE') throw new Stopped('drive', e.message);
    return text(e);
  };

  /** Copies the object's missing bytes from `source`. The source must be the same regular file before and after. */
  const copyObject = async (o: ObjectRef, source: string, onBytes: (n: number) => void): Promise<void> => {
    const before = await factsOf(fs, source);
    if (!regular(before) || before.size !== o.size) throw new Error(SOURCE_CHANGED);
    const sizes = partSizes(o.size, o.partSize);
    const have = await partStates(root, o, fs);
    const r = fileReadAt(source);
    try {
      let start = 0;
      let done = 0;
      for (const [i, want] of sizes.entries()) {
        const h = have[i] ?? 0;
        if (h < 0 || h > want) throw new DriveError('LAYOUT', partPath(o.etag, i), `${partPath(o.etag, i)} on the drive is not a part of this file; remove it from the drive and export again`);
        done += h;
        if (h < want || have[i] === null) {
          const w = await writer.openPart(o.etag, i, h);
          try {
            for (let off = h; off < want;) {
              deps.signal.throwIfAborted();
              const chunk = await r.readAt(start + off, Math.min(READ_CHUNK, want - off));
              if (chunk.length === 0) throw new Error(SOURCE_CHANGED);
              await w.write(chunk);
              off += chunk.length;
              done += chunk.length;
              onBytes(done);
            }
          } catch (e) {
            await w.abandon();
            throw e;
          }
          await w.close();
        }
        start += want;
      }
    } finally {
      await r.close();
    }
    if (!same(before, await factsOf(fs, source))) {
      throw new Error(`${SOURCE_CHANGED}; remove ${partPath(o.etag, 0).replace(/\.\d+$/, '.*')} from the drive and export again`);
    }
  };

  let stopped: ExportResult['stopped'] = null;
  try {
    try {
      await writer.prepare();
    } catch (e) {
      throw new Stopped(e instanceof DriveError && e.code === 'FULL' ? 'full' : 'drive', e instanceof DriveError && e.code === 'FULL' ? 'The drive is full.' : text(e));
    }
    const drive = await readDrive(deps.volumeRoot, fs);
    const objects = new Map<string, ObjectRef>(drive?.objects ?? []);
    const onDrive = new Map((drive?.repos ?? []).map((r) => [r.key, new Map(r.files.map((f) => [f.path, f.etag]))]));

    for (const repo of set.repos) {
      const res: ExportRepoResult = { repoId: repo.repoId, type: repo.type, commit: repo.commit, manifest: null, failed: [] };
      results.push(res);
      const files: TransferFile[] = [];
      for (const f of repo.files) emit(repo, f, 'queued', 0);
      for (const f of repo.files) {
        try {
          deps.signal.throwIfAborted();
          let named: { etag: string; lfs: boolean };
          if (f.etag !== null) named = { etag: f.etag, lfs: f.etag.length === 64 };
          else {
            emit(repo, f, 'hashing', 0);
            const before = await factsOf(fs, f.source);
            if (!regular(before) || before.size !== f.size) throw new Error(SOURCE_CHANGED);
            named = nameFor(await hashFile(f.source, f.size, deps.signal, (n) => emit(repo, f, 'hashing', n)), repo.blobNames);
            if (!same(before, await factsOf(fs, f.source))) throw new Error(SOURCE_CHANGED);
          }
          let o = objects.get(named.etag);
          if (o !== undefined && o.size !== f.size) throw new Error('the drive holds another file under this name; it cannot be added');
          if (o === undefined) {
            o = { etag: named.etag, size: f.size, partSize: newPartSize };
            emit(repo, f, 'copying', 0);
            await copyObject(o, f.source, (n) => emit(repo, f, 'copying', n));
            objects.set(o.etag, o);
          }
          files.push({ path: f.path, size: f.size, etag: named.etag, lfs: named.lfs, partSize: o.partSize });
          emit(repo, f, 'done', f.size);
        } catch (e) {
          const why = failure(e);
          res.failed.push({ path: f.path, error: why });
          emit(repo, f, 'failed', 0, why);
        }
      }
      if (res.failed.length > 0 || files.length === 0) continue;
      // Nothing new for the drive: every file is already listed there for this commit, so no record is added.
      const known = onDrive.get(repoKey(repo));
      if (known !== undefined && files.every((f) => known.get(f.path) === f.etag)) continue;
      try {
        res.manifest = await writer.addManifest(serializeManifest({
          version: 1, repoId: repo.repoId, type: repo.type, commit: repo.commit, ref: repo.ref, exportedAt: deps.now(), files,
        }));
      } catch (e) {
        res.failed.push({ path: '', error: `the export record could not be written: ${failure(e)}` });
      }
    }
  } catch (e) {
    if (!(e instanceof Stopped)) throw e;
    stopped = { why: e.why, message: e.message };
  }
  return { ok: stopped === null && results.length === set.repos.length && results.every((r) => r.failed.length === 0), repos: results, stopped };
}
