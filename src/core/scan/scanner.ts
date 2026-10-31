import { basename, dirname, join, resolve, sep } from 'node:path';
import { factsOf, readFs, type ReadFs } from '../fsx';
import type { CacheModel, FileFacts, Repo, RepoBlob, RepoType, SnapshotFile, StoreFile } from '../types';
import { readStoreMarker, readStorePayload } from './store';

const PREFIXES: Record<string, RepoType> = { models: 'model', datasets: 'dataset', spaces: 'space' };
const CANARY = '.hfcm-canary'; // fixture canary: never part of the model

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/** `<type>s--<org>--<name>` -> `org/name`. */
export function parseRepoFolder(name: string): { id: string; type: RepoType } | null {
  const parts = name.split('--');
  const prefix = parts[0] ?? '';
  if (!Object.prototype.hasOwnProperty.call(PREFIXES, prefix)) return null;
  const id = parts.slice(1).join('/');
  if (id === '') return null;
  return { id, type: PREFIXES[prefix]! };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isRealDir = (f: FileFacts | null): boolean => f !== null && f.isDirectory && !f.isSymlink;

/** refs/main stripped; null when absent, empty, or when `<folder>/refs` is not a real directory (never read through a link). */
async function readMain(folder: string, fs: ReadFs): Promise<string | null> {
  if (!isRealDir(await factsOf(fs, join(folder, 'refs')))) return null;
  try {
    const raw = (await fs.readFile(join(folder, 'refs', 'main'), 'utf8')).trim();
    return raw === '' ? null : raw;
  } catch (e) {
    const c = errCode(e);
    if (c === 'ENOENT' || c === 'ENOTDIR' || c === 'EISDIR') return null;
    throw e;
  }
}

/** A ref file is a few bytes (a 40-hex commit); anything much larger is not read. */
const MAX_REF_BYTES = 4096;

/**
 * Every regular file under refs/ (refs/main, branches, refs/pr/N) with the commit it names, stripped,
 * sorted by name. Real directories only (a symlinked refs/ or subfolder is never followed); symlinked files and dot
 * files (a ref temp file such as .main.<8 hex>.hfcm-tmp) are skipped, and so are blank or oversized files.
 * Any error reading refs/ (EACCES, ...) gives null, "unknown", and the scan goes on.
 */
async function readRefs(folder: string, fs: ReadFs): Promise<Array<{ name: string; commit: string }> | null> {
  const out: Array<{ name: string; commit: string }> = [];
  const walk = async (dir: string, rel: string[]): Promise<void> => {
    if (!isRealDir(await factsOf(fs, dir))) return;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      const c = errCode(e);
      if (c === 'ENOENT' || c === 'ENOTDIR') return;
      throw e;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      const f = await factsOf(fs, p);
      if (f === null || f.isSymlink) continue;
      if (f.isDirectory) {
        await walk(p, [...rel, name]);
        continue;
      }
      if (!f.isFile || f.size > MAX_REF_BYTES) continue;
      let raw: string;
      try {
        raw = (await fs.readFile(p, 'utf8')).trim();
      } catch (e) {
        if (errCode(e) === 'ENOENT') continue;   // removed meanwhile
        throw e;
      }
      if (raw !== '') out.push({ name: [...rel, name].join('/'), commit: raw });
    }
  };
  try {
    await walk(join(folder, 'refs'), []);
  } catch {
    return null;
  }
  return out.sort((x, y) => cmp(x.name, y.name));
}

/**
 * Real (non-symlink) directories under snapshots/, ordered main first, then mtime newest first, ties by name. Empty
 * unless `<folder>/snapshots` is itself a real directory: a symlinked snapshots/ is never followed (it is an otherFile).
 */
async function snapshotOrder(folder: string, main: string | null, fs: ReadFs): Promise<string[]> {
  const dir = join(folder, 'snapshots');
  if (!isRealDir(await factsOf(fs, dir))) return [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    const c = errCode(e);
    if (c === 'ENOENT' || c === 'ENOTDIR') return [];
    throw e;
  }
  const found: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    const f = await factsOf(fs, join(dir, name));
    if (f && f.isDirectory && !f.isSymlink) found.push({ name, mtimeMs: f.mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || cmp(a.name, b.name));
  const order = found.map((s) => s.name);
  if (main !== null) {
    const i = order.indexOf(main);
    if (i > 0) order.unshift(...order.splice(i, 1));
  }
  return order;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** realpath, or the input itself when the path does not exist. */
async function realpathOrSelf(p: string, fs: ReadFs): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch (e) {
    const c = errCode(e);
    if (c === 'ENOENT' || c === 'ENOTDIR' || c === 'ELOOP') return p;
    throw e;
  }
}

/**
 * Walk every snapshot with lstat, never following links. Files are ordered by snapshot order, then relpath.
 * isCurrent marks the effective current snapshot: the first snapshot in order (main first when it exists) that has at
 * least one file. An empty or missing named snapshot is skipped, so an interrupted update never hides the only copy.
 */
async function walkSnapshots(
  folder: string, snapshots: string[], fs: ReadFs,
): Promise<{ files: SnapshotFile[]; snapshotDirs: string[] }> {
  const files: SnapshotFile[] = [];
  const dirs: string[] = [];
  const blobsDir = await realpathOrSelf(join(folder, 'blobs'), fs);
  for (const commit of snapshots) {
    const snapRoot = join(folder, 'snapshots', commit);
    const found: SnapshotFile[] = [];
    const walk = async (dir: string, rel: string[]): Promise<void> => {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (e) {
        if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return;
        throw e;
      }
      for (const name of names) {
        const p = join(dir, name);
        const facts = await factsOf(fs, p);
        if (!facts) continue;
        if (facts.isDirectory && !facts.isSymlink) {
          dirs.push(p);
          await walk(p, [...rel, name]);
          continue;
        }
        let blobEtag: string | null = null;
        if (facts.isSymlink && facts.linkTarget !== undefined) {
          const target = resolve(dirname(p), facts.linkTarget);
          const base = basename(target);
          if (HEX64.test(base) && (await realpathOrSelf(dirname(target), fs)) === blobsDir) blobEtag = base;
        }
        found.push({ relpath: [...rel, name].join('/'), commit, linkPath: p, facts, blobEtag, isCurrent: false });
      }
    };
    dirs.push(snapRoot);
    await walk(snapRoot, []);
    found.sort((a, b) => cmp(a.relpath, b.relpath));
    files.push(...found);
  }
  const effective = files[0]?.commit;
  for (const f of files) f.isCurrent = f.commit === effective;
  dirs.sort(deepestFirst);
  return { files, snapshotDirs: dirs };
}

const depth = (p: string): number => p.split(sep).length;
const deepestFirst = (a: string, b: string): number => depth(b) - depth(a) || cmp(a, b);

async function readdirOrEmpty(dir: string, fs: ReadFs): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort(cmp);
  } catch (e) {
    const c = errCode(e);
    if (c === 'ENOENT' || c === 'ENOTDIR') return [];
    throw e;
  }
}

/**
 * Entries directly in `<folder>/blobs` (only when it is a real directory; a symlinked blobs/ is never followed).
 * 64-hex regular files and symlinks are repo blobs; regular files named `*.incomplete` are partial downloads.
 */
async function scanBlobs(
  folder: string, files: SnapshotFile[], fs: ReadFs,
): Promise<Pick<Repo, 'blobs' | 'orphanEtags' | 'incomplete'>> {
  const blobs: Record<string, RepoBlob> = {};
  const incomplete: Repo['incomplete'] = [];
  const lexical = join(folder, 'blobs');
  if (!isRealDir(await factsOf(fs, lexical))) return { blobs, orphanEtags: [], incomplete };
  const blobsDir = await realpathOrSelf(lexical, fs); // realpath the directory, never the leaf
  for (const name of await readdirOrEmpty(lexical, fs)) {
    const p = join(blobsDir, name);
    const facts = await factsOf(fs, p);
    if (!facts) continue;
    if (HEX64.test(name)) {
      if (facts.isFile && !facts.isSymlink) {
        blobs[name] = { path: p, etag: name, facts, storePath: null, size: facts.size, dangling: false };
      } else if (facts.isSymlink && facts.linkTarget !== undefined) {
        const storePath = resolve(dirname(p), facts.linkTarget); // one hop, abspath, not realpath
        let size = 0;
        let dangling = false;
        try {
          size = (await fs.stat(p)).size;
        } catch (e) {
          const c = errCode(e);
          if (c !== 'ENOENT' && c !== 'ENOTDIR' && c !== 'ELOOP') throw e;
          dangling = true;
        }
        blobs[name] = { path: p, etag: name, facts, storePath, size, dangling };
      }
    } else if (name.endsWith('.incomplete') && facts.isFile && !facts.isSymlink) {
      incomplete.push({ path: p, size: facts.size, mtimeMs: facts.mtimeMs });
    }
  }
  const linked = new Set(files.map((f) => f.blobEtag));
  const orphanEtags = Object.keys(blobs).filter((e) => !linked.has(e)).sort(cmp);
  incomplete.sort((a, b) => cmp(a.path, b.path));
  return { blobs, orphanEtags, incomplete };
}

/**
 * Full lstat walk of the repo folder. Descends real directories only, never symlinks. Every non-directory
 * entry that is neither a snapshot entry nor a repo blob is an otherFile; every directory not in snapshotDirs is an otherDir.
 */
async function walkOther(
  folder: string, known: Set<string>, snapshotDirs: Set<string>, fs: ReadFs,
): Promise<Pick<Repo, 'otherFiles' | 'otherDirs'>> {
  const otherFiles: Repo['otherFiles'] = [];
  const otherDirs: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdirOrEmpty(dir, fs)) {
      const p = join(dir, name);
      const facts = await factsOf(fs, p);
      if (!facts) continue;
      if (isRealDir(facts)) {
        if (!snapshotDirs.has(p)) otherDirs.push(p);
        await walk(p);
      } else if (!known.has(p)) {
        otherFiles.push({ path: p, facts });
      }
    }
  };
  await walk(folder);
  otherFiles.sort((a, b) => cmp(a.path, b.path));
  otherDirs.sort(deepestFirst);
  return { otherFiles, otherDirs };
}

/** Every store-shaped regular-file payload under `<hub>/blobs/<xx>/`, keyed by path, whether or not the store is marked. */
async function scanStore(root: string, fs: ReadFs): Promise<Record<string, StoreFile>> {
  const store: Record<string, StoreFile> = {};
  const blobs = join(root, 'blobs');
  if (!isRealDir(await factsOf(fs, blobs))) return store;
  for (const xx of await readdirOrEmpty(blobs, fs)) {
    if (xx.startsWith(CANARY) || !/^[0-9a-f]{2}$/.test(xx)) continue;
    const dir = join(blobs, xx);
    if (!isRealDir(await factsOf(fs, dir))) continue;
    for (const name of await readdirOrEmpty(dir, fs)) {
      if (name.startsWith(CANARY) || !HEX64.test(name)) continue;
      const sf = await readStorePayload(root, join(dir, name), fs); // marker read once, below
      if (sf) store[sf.path] = sf;
    }
  }
  return store;
}

/**
 * Read-only scan of the hub. `hubRoot` in the result is its realpath, and every path emitted
 * is built from that string so later exact-string comparisons match.
 */
export async function scanHub(hubRoot: string, fs: ReadFs = readFs): Promise<CacheModel> {
  const scannedAt = Date.now();
  const root = await fs.realpath(hubRoot); // ENOENT propagates
  const names = (await fs.readdir(root)).filter((n) => !n.startsWith(CANARY)).sort(cmp);
  const repos: Repo[] = [];
  for (const folderName of names) {
    const parsed = parseRepoFolder(folderName);
    if (!parsed) continue;
    const folder = join(root, folderName);
    const folderFacts = await factsOf(fs, folder);
    if (!folderFacts || !folderFacts.isDirectory || folderFacts.isSymlink) continue;
    try {
      const mainCommit = await readMain(folder, fs);
      const refs = await readRefs(folder, fs);
      const snapshots = await snapshotOrder(folder, mainCommit, fs);
      const walked = await walkSnapshots(folder, snapshots, fs);
      const blobPart = await scanBlobs(folder, walked.files, fs);
      const known = new Set([...walked.files.map((f) => f.linkPath), ...Object.values(blobPart.blobs).map((b) => b.path)]);
      const other = await walkOther(folder, known, new Set(walked.snapshotDirs), fs);
      repos.push({
        ...parsed,
        folder,
        folderName,
        mainCommit,
        refs,
        snapshots,
        files: walked.files,
        ...blobPart,
        snapshotDirs: walked.snapshotDirs,
        folderFacts,
        ...other,
      });
    } catch (e) {
      if (errCode(e) === 'ENOENT') continue; // vanished mid-scan
      throw e;
    }
  }
  const storeMarked = await readStoreMarker(root, fs);
  return { hubRoot: root, repos, storeMarked, store: await scanStore(root, fs), scannedAt };
}
