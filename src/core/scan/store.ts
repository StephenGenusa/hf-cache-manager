import path, { isAbsolute, join, relative, sep } from 'node:path';
import { readFs, type ReadFs } from '../fsx';
import { normalizeLinkText } from '../paths';
import type { FileFacts, FreedReason, StoreFile } from '../types';

export const STORE_MARKER = '.huggingface-shared-blobs';

const HASH = /^[0-9a-f]{64}$/;

/** The marker counts only as a regular file (not a link) whose bytes are exactly "1\n". Any doubt is false. */
export async function readStoreMarker(hubRoot: string, fs: ReadFs = readFs): Promise<boolean> {
  const p = join(hubRoot, 'blobs', STORE_MARKER);
  try {
    const st = await fs.lstat(p);
    if (!st.isFile()) return false;
    return (await fs.readFile(p)).equals(Buffer.from('1\n'));
  } catch {
    return false;
  }
}

/** Split on "\n", dropping only the final empty element. No trimming. */
export function parseRefs(raw: string): string[] {
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** `<hub>/blobs/<xx>/<64 lowercase hex>` with xx = hash[:2]. */
export function isStorePath(hubRoot: string, p: string): boolean {
  const rel = relative(join(hubRoot, 'blobs'), p);
  if (rel === '' || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  if (parts.length !== 2) return false;
  const [xx = '', hash = ''] = parts;
  return HASH.test(hash) && xx === hash.slice(0, 2);
}

const CANDIDATE_PREFIX = /^(datasets|kernels|models|spaces)--./;
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/**
 * As `_read_valid_manifest_references`. Returns null (uncertain) as soon as any error other than ENOENT occurs.
 * Deliberately does not use factsOf/isNotFound: those treat ENOTDIR as missing; here only ENOENT is missing.
 */
export async function validRefsFor(
  hubRoot: string,
  storePath: string,
  lines: string[],
  fs: ReadFs = readFs,
): Promise<string[] | null> {
  hubRoot = path.resolve(hubRoot); // Abspath both before comparing
  storePath = path.resolve(storePath);
  const kept: string[] = [];
  for (const line of lines) {
    if (line.includes('\r') || line.includes('\n')) continue;
    if (path.posix.isAbsolute(line) || path.win32.isAbsolute(line)) continue;
    if (line.split(/[\\/]/).includes('..')) continue;
    const normalized = path.posix.normalize(line);
    // On Windows Python's PurePath splits on both separators; keep POSIX behaviour elsewhere.
    const parts = process.platform === 'win32' ? normalized.split(/[\\/]/) : normalized.split('/');
    if (parts.length !== 3 || !CANDIDATE_PREFIX.test(parts[0] ?? '') || parts[1] !== 'blobs' || parts[2] === '') continue;
    const candidate = join(hubRoot, ...parts);
    let isLink: boolean;
    try {
      isLink = (await fs.lstat(candidate)).isSymbolicLink();
    } catch (e) {
      if (errCode(e) === 'ENOENT') continue;
      return null;
    }
    if (!isLink) continue;
    let text: string;
    try {
      text = normalizeLinkText(await fs.readlink(candidate));
    } catch (e) {
      if (errCode(e) === 'ENOENT') continue;
      return null;
    }
    const target = path.resolve(path.dirname(candidate), text); // abspath only, never realpath
    if (target === storePath && !kept.includes(line)) kept.push(line);
  }
  return kept;
}

/** True if `<store>.lock` or `<store>.lock.soft` exists as anything. Any outcome but ENOENT counts as present. */
export async function lockPresent(storePath: string, fs: ReadFs = readFs): Promise<boolean> {
  for (const p of [storePath + '.lock', storePath + '.lock.soft']) {
    try {
      await fs.lstat(p);
      return true;
    } catch (e) {
      if (errCode(e) !== 'ENOENT') return true; // Only ENOENT means absent
    }
  }
  return false;
}

/**
 * Fresh read of one store file. `store` is null if `storePath` is not store-shaped or not an lstat regular file.
 * The executor calls this again immediately before a sweep ("re-reads .refs").
 */
export async function readStoreFile(
  hubRoot: string,
  storePath: string,
  fs: ReadFs = readFs,
): Promise<{ storeMarked: boolean; store: StoreFile | null }> {
  const storeMarked = await readStoreMarker(hubRoot, fs);
  const store = await readStorePayload(hubRoot, storePath, fs);
  return { storeMarked, store };
}

/** Like readStoreFile but without re-reading the marker (for the scanner's per-payload loop). */
export async function readStorePayload(hubRoot: string, storePath: string, fs: ReadFs = readFs): Promise<StoreFile | null> {
  hubRoot = path.resolve(hubRoot);
  storePath = path.resolve(storePath);
  if (!isStorePath(hubRoot, storePath)) return null;
  let facts: FileFacts;
  try {
    const st = await fs.lstat(storePath);
    if (!st.isFile()) return null;
    facts = {
      dev: st.dev, ino: st.ino, size: st.size, mtimeMs: Math.floor(st.mtimeMs), nlink: st.nlink,
      isSymlink: false, isDirectory: false, isFile: true,
    };
  } catch {
    return null;
  }
  const refsPath = storePath + '.refs';
  let refsRaw: string[] | null = null;
  try {
    if ((await fs.lstat(refsPath)).isFile()) refsRaw = parseRefs(await fs.readFile(refsPath, 'utf8'));
  } catch {
    refsRaw = null; // missing or unreadable: never delete
  }
  const validRefs = refsRaw === null ? null : await validRefsFor(hubRoot, storePath, refsRaw, fs);
  return {
    path: storePath,
    hash: path.basename(storePath),
    facts,
    refsPath,
    refsRaw,
    validRefs,
    lockPresent: await lockPresent(storePath, fs),
  };
}

const hubOf = (p: string): string => path.dirname(path.dirname(path.dirname(p)));

/**
 * May this store payload be deleted once the repo blobs in `removing` (absolute RepoBlob.path
 * strings) are gone? Pure. Every doubt returns store-uncertain, checked in this order.
 */
export function sweepDecision(
  store: StoreFile,
  removing: string[],
  storeMarked: boolean,
): { deletable: boolean; reason: FreedReason } {
  const uncertain = { deletable: false, reason: 'store-uncertain' as const };
  if (!storeMarked) return uncertain;
  if (store.refsRaw === null || store.validRefs === null) return uncertain;
  if (store.lockPresent) return uncertain;
  if (!store.facts.isFile || store.facts.isSymlink) return uncertain;
  const hub = hubOf(store.path);
  if (!isStorePath(hub, store.path)) return uncertain;
  const doomed = new Set(removing);
  const allGone = store.validRefs.every((r) => doomed.has(join(hub, ...r.split('/'))));
  return allGone
    ? { deletable: true, reason: 'store-unreferenced' }
    : { deletable: false, reason: 'store-shared' };
}
