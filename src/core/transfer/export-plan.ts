// What an export would copy: the selected repos and groups of the scanned cache, as one list of files per repo commit,
// each with the regular file that holds its bytes. Pure: it reads the CacheModel only, never the disk or the drive.
import { basename, dirname, join, resolve } from 'node:path';
import { classifyRepo } from '../classify/classify';
import { isSafeSiblingPath } from '../download/remote-repo';
import { compareStrings } from '../paths';
import { isCommitHash, safeRef } from '../../shared/hub-input';
import type { CacheModel, Repo, RepoType, RepoView, Selection, SnapshotFile } from '../types';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * One file to export. `source` is the regular file with the bytes (the blob, or the shared-store payload it links to,
 * or the snapshot entry itself when that is a plain copy). `etag` is null for a plain copy: its name in blobs/ is not
 * known until the bytes are hashed (see `nameFor`).
 */
export interface ExportFile { path: string; size: number; etag: string | null; source: string }
/** `blobNames`: every name in the repo's blobs/ folder that is a hash; a plain copy is matched against it by content. */
export interface ExportRepo {
  repoId: string; type: RepoType; commit: string; ref: string | null; files: ExportFile[]; blobNames: string[];
}
export interface ExportSkip { repoId: string; path: string; reason: string }
export interface ExportSet { repos: ExportRepo[]; skipped: ExportSkip[] }

export const SKIP_MISSING = 'its data is missing from the cache';
export const SKIP_NOT_BLOB = 'it is not a file of the cache (a link that does not lead to a blob)';
export const SKIP_PATH = 'its path cannot be stored';

type Classify = (repo: Repo) => RepoView;

function sourceOf(model: CacheModel, repo: Repo, f: SnapshotFile): Omit<ExportFile, 'path'> | string {
  if (f.blobEtag !== null) {
    const b = repo.blobs[f.blobEtag];
    if (b === undefined || b.dangling) return SKIP_MISSING;
    if (b.storePath !== null) {
      const payload = model.store[b.storePath];
      return payload !== undefined && payload.facts.isFile && !payload.facts.isSymlink
        ? { size: payload.facts.size, etag: f.blobEtag, source: b.storePath } : SKIP_MISSING;
    }
    return b.facts.isFile && !b.facts.isSymlink ? { size: b.size, etag: f.blobEtag, source: b.path } : SKIP_MISSING;
  }
  if (f.facts.isSymlink) {
    // A file that is not LFS: a link to blobs/<40 hex>, which the scanner lists among the repo's other files.
    if (f.facts.linkTarget === undefined) return SKIP_NOT_BLOB;
    const target = resolve(dirname(f.linkPath), f.facts.linkTarget);
    if (!HEX40.test(basename(target)) || dirname(target) !== join(repo.folder, 'blobs')) return SKIP_NOT_BLOB;
    const blob = repo.otherFiles.find((o) => o.path === target);
    return blob !== undefined && blob.facts.isFile && !blob.facts.isSymlink
      ? { size: blob.facts.size, etag: basename(target), source: target } : SKIP_MISSING;
  }
  return f.facts.isFile ? { size: f.facts.size, etag: null, source: f.linkPath } : SKIP_NOT_BLOB;
}

/** The ref an import should give the commit: `main` when it names it, else the first other ref that does, else none. */
function refFor(repo: Repo, commit: string): string | null {
  const named = (repo.refs ?? []).filter((r) => r.commit === commit && safeRef(r.name) && !isCommitHash(r.name)).map((r) => r.name);
  if (named.includes('main') || repo.mainCommit === commit) return 'main';
  return named.sort(compareStrings)[0] ?? null;
}

/**
 * The selection as export sets. A whole repo is every file of every snapshot; otherwise the files of the named groups.
 * A file that cannot be exported is listed in `skipped` with the reason and the rest goes ahead. An unknown repo or
 * group, or a repo id that two repo types share, is an error: the selection is not what the user saw.
 */
export function exportSet(model: CacheModel, selection: Selection, classify: Classify = classifyRepo): ExportSet | { error: string } {
  const repos: ExportRepo[] = [];
  const skipped: ExportSkip[] = [];
  for (const sel of selection.repos) {
    const matches = model.repos.filter((r) => r.id === sel.repoId);
    if (matches.length === 0) return { error: `${sel.repoId} is no longer in the cache.` };
    if (matches.length > 1) return { error: `${sel.repoId} is the name of more than one repo (a model and a dataset or space); it cannot be exported.` };
    const repo = matches[0]!;
    let chosen: SnapshotFile[];
    if (sel.whole) chosen = repo.files;
    else {
      const groups = classify(repo).groups;
      chosen = [];
      for (const key of sel.groupKeys) {
        const g = groups.find((x) => x.key === key);
        if (g === undefined) return { error: `${sel.repoId} no longer has the group ${key}.` };
        chosen.push(...g.files);
      }
    }
    const blobNames = [
      ...Object.keys(repo.blobs).filter((n) => HEX64.test(n)),
      ...repo.otherFiles.filter((o) => dirname(o.path) === join(repo.folder, 'blobs') && HEX40.test(basename(o.path))).map((o) => basename(o.path)),
    ].sort(compareStrings);
    const byCommit = new Map<string, Map<string, ExportFile>>();
    for (const f of chosen) {
      if (!isSafeSiblingPath(f.relpath) || !HEX40.test(f.commit)) {
        skipped.push({ repoId: repo.id, path: f.relpath, reason: SKIP_PATH });
        continue;
      }
      const src = sourceOf(model, repo, f);
      if (typeof src === 'string') {
        skipped.push({ repoId: repo.id, path: f.relpath, reason: src });
        continue;
      }
      const files = byCommit.get(f.commit) ?? new Map<string, ExportFile>();
      files.set(f.relpath, { path: f.relpath, ...src });
      byCommit.set(f.commit, files);
    }
    for (const [commit, files] of [...byCommit].sort((a, b) => compareStrings(a[0], b[0]))) {
      repos.push({
        repoId: repo.id, type: repo.type, commit, ref: refFor(repo, commit), blobNames,
        files: [...files.values()].sort((a, b) => compareStrings(a.path, b.path)),
      });
    }
  }
  return { repos, skipped };
}

/**
 * The etag a plain snapshot copy is exported under, from the two hashes of its bytes: the one that names a blob of the
 * repo (SHA-256 for an LFS file, the git blob id for any other). When neither does (huggingface_hub without symlinks
 * keeps no blob at all), the SHA-256 is used: the file then lands as an LFS blob on the other machine, where its bytes
 * and its snapshot path are right and only the blob's name may differ from the Hub's.
 */
export function nameFor(hashes: { sha256: string; gitSha1: string }, blobNames: readonly string[]): { etag: string; lfs: boolean } {
  if (blobNames.includes(hashes.sha256)) return { etag: hashes.sha256, lfs: true };
  if (blobNames.includes(hashes.gitSha1)) return { etag: hashes.gitSha1, lfs: false };
  return { etag: hashes.sha256, lfs: true };
}
