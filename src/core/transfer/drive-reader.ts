// Reads a transfer folder (see format.ts). Read-only: nothing here writes, and nothing read from the drive is trusted.
// Manifests pass parseManifest; a file counts as on the drive only when every part of its object is a regular file of
// exactly the expected size (a symlink is never a part). The bytes themselves are not checked here: an import hashes
// every file against its etag before it enters the cache.
import { join } from 'node:path';
import { fileReadAt, isNotFound, readFs, type ReadFs } from '../fsx';
import {
  FORMAT_FILE, FORMAT_TEXT, MANIFESTS_DIR, MAX_MANIFEST_BYTES, TRANSFER_DIR, mergeManifests, parseManifest, partPath, partSizes, repoKey,
  type TransferFile, type TransferManifest, type TransferRepo,
} from './format';

/** Manifests read from one drive; the rest are counted in a note. */
export const MAX_MANIFESTS = 20_000;
/** Bytes per read when streaming an object. */
export const READ_CHUNK = 1024 * 1024;

/** What an object is: enough to find and size its parts. */
export type ObjectRef = Pick<TransferFile, 'etag' | 'size' | 'partSize'>;

/** One repo commit on the drive. `files` holds only the files whose objects are complete; `incomplete` names the others. */
export interface DriveRepo extends TransferRepo { key: string; bytes: number; incomplete: string[] }
export interface DriveContents {
  repos: DriveRepo[];
  /** Why something on the drive was left out (unreadable manifests, conflicting exports). For display. */
  notes: string[];
  /** Every complete object a manifest names, by etag: an export reuses these and never writes them again. */
  objects: Map<string, ObjectRef>;
}

export const transferRoot = (volumeRoot: string): string => join(volumeRoot, TRANSFER_DIR);
const at = (root: string, rel: string): string => join(root, ...rel.split('/'));

/** The volume has a transfer folder this version reads: a real directory holding FORMAT with exactly "1\n". */
export async function hasTransfer(volumeRoot: string, fs: ReadFs = readFs): Promise<boolean> {
  const root = transferRoot(volumeRoot);
  try {
    const dir = await fs.lstat(root);
    if (!dir.isDirectory() || dir.isSymbolicLink()) return false;
    const st = await fs.lstat(join(root, FORMAT_FILE));
    return st.isFile() && !st.isSymbolicLink() && st.size === FORMAT_TEXT.length && (await fs.readFile(join(root, FORMAT_FILE), 'utf8')) === FORMAT_TEXT;
  } catch {
    return false;
  }
}

/**
 * The size of each part the object should have, in order: null when the part is absent. A part that is there but is not
 * a regular file (a folder, a link) is reported as -1, which never equals an expected size.
 */
export async function partStates(root: string, o: ObjectRef, fs: ReadFs = readFs): Promise<Array<number | null>> {
  const out: Array<number | null> = [];
  const n = partSizes(o.size, o.partSize).length;
  for (let i = 0; i < n; i += 1) {
    try {
      const st = await fs.lstat(at(root, partPath(o.etag, i)));
      out.push(st.isFile() && !st.isSymbolicLink() ? st.size : -1);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      out.push(null);
    }
  }
  return out;
}

/** Every part is on the drive at its full size. */
export async function objectComplete(root: string, o: ObjectRef, fs: ReadFs = readFs): Promise<boolean> {
  const want = partSizes(o.size, o.partSize);
  const have = await partStates(root, o, fs);
  return want.every((n, i) => have[i] === n);
}

/** The drive's repos, or null when the volume has no transfer folder (see hasTransfer). */
export async function readDrive(volumeRoot: string, fs: ReadFs = readFs): Promise<DriveContents | null> {
  if (!(await hasTransfer(volumeRoot, fs))) return null;
  const root = transferRoot(volumeRoot);
  const notes: string[] = [];
  let names: string[] = [];
  try {
    names = (await fs.readdir(join(root, MANIFESTS_DIR))).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  if (names.length > MAX_MANIFESTS) {
    notes.push(`The drive holds ${names.length} exports; only the first ${MAX_MANIFESTS} were read.`);
    names = names.slice(0, MAX_MANIFESTS);
  }
  const manifests: TransferManifest[] = [];
  let unreadable = 0;
  for (const name of names) {
    const p = join(root, MANIFESTS_DIR, name);
    try {
      const st = await fs.lstat(p);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_MANIFEST_BYTES) throw new Error('not a manifest file');
      const parsed = parseManifest(await fs.readFile(p, 'utf8'), name);
      if (!parsed.ok) throw new Error(parsed.error);
      manifests.push(parsed.manifest);
    } catch {
      unreadable += 1;
    }
  }
  if (unreadable > 0) notes.push(`${unreadable} export record${unreadable === 1 ? '' : 's'} on the drive could not be read and ${unreadable === 1 ? 'was' : 'were'} left out.`);
  const merged = mergeManifests(manifests);
  for (const key of merged.conflicts) notes.push(`Two exports of ${key} disagree; the newer one was left out.`);

  const checked = new Map<string, boolean>();
  const objects = new Map<string, ObjectRef>();
  const repos: DriveRepo[] = [];
  for (const r of merged.repos) {
    const files: TransferFile[] = [];
    const incomplete: string[] = [];
    for (const f of r.files) {
      let ok = checked.get(f.etag);
      if (ok === undefined) {
        // An object two repos share must be the same object in both; the first one read decides.
        const known = objects.get(f.etag);
        ok = known === undefined ? await objectComplete(root, f, fs) : known.size === f.size && known.partSize === f.partSize;
        checked.set(f.etag, ok);
        if (ok && known === undefined) objects.set(f.etag, { etag: f.etag, size: f.size, partSize: f.partSize });
      } else if (ok) {
        const known = objects.get(f.etag)!;
        ok = known.size === f.size && known.partSize === f.partSize;
      }
      if (ok) files.push(f);
      else incomplete.push(f.path);
    }
    repos.push({ ...r, files, incomplete, key: repoKey(r), bytes: files.reduce((n, f) => n + f.size, 0) });
  }
  return { repos, notes, objects };
}

/**
 * The object's bytes from `fromByte` to its end, part after part. A part that ends early (the drive was changed, or
 * pulled) fails the read; `signal` stops it between chunks. Handles are closed on every way out.
 */
export async function* openObject(root: string, o: ObjectRef, fromByte: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > o.size) throw new Error(`cannot read from byte ${String(fromByte)} of ${o.size}`);
  const sizes = partSizes(o.size, o.partSize);
  let start = 0;
  for (const [i, size] of sizes.entries()) {
    const end = start + size;
    if (fromByte < end) {
      const r = fileReadAt(at(root, partPath(o.etag, i)));
      try {
        for (let off = Math.max(0, fromByte - start); off < size;) {
          signal?.throwIfAborted();
          const chunk = await r.readAt(off, Math.min(READ_CHUNK, size - off));
          if (chunk.length === 0) throw new Error(`${partPath(o.etag, i)} on the drive is shorter than expected`);
          off += chunk.length;
          yield chunk;
        }
      } finally {
        await r.close();
      }
    }
    start = end;
  }
}

/** Up to `length` bytes of the object from `offset` (fewer only at its end). Each call opens and closes what it reads. */
export async function readObjectAt(root: string, o: ObjectRef, offset: number, length: number): Promise<Uint8Array> {
  const want = Math.max(0, Math.min(length, o.size - offset));
  const out = Buffer.alloc(want);
  let n = 0;
  if (want > 0) {
    for await (const chunk of openObject(root, o, offset)) {
      const take = Math.min(chunk.length, want - n);
      out.set(chunk.subarray(0, take), n);
      n += take;
      if (n >= want) break;
    }
  }
  return out.subarray(0, n);
}
