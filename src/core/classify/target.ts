import path, { basename, dirname, join } from 'node:path';
import type { FileFacts, Repo, SnapshotFile } from '../types';

/** First-hop target of a snapshot entry: a repo blob (64-hex or 40-hex), a plain file, or anything else. */
export type Target = { kind: 'blob'; path: string; facts: FileFacts } | { kind: 'plain' } | { kind: 'other' };

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a path that names a non-LFS (40-hex git-sha1) repo blob: directly in `<folder>/blobs`. */
export function isHex40Blob(repo: Repo, p: string): boolean {
  return dirname(p) === join(repo.folder, 'blobs') && HEX40.test(basename(p));
}

/**
 * 64-hex: the RepoBlob the scanner resolved (blobEtag). Otherwise a symlink whose lexical first hop is a 40-hex
 * otherFile directly in `<folder>/blobs`. Otherwise plain for a regular file, else other (dangling links, links to
 * non-hex files, links outside the repo, special files): those are doomed alone and never pull in a blob.
 */
export function targetOf(repo: Repo, file: SnapshotFile): Target {
  if (file.blobEtag !== null && Object.hasOwn(repo.blobs, file.blobEtag)) {
    const b = repo.blobs[file.blobEtag]!;
    return { kind: 'blob', path: b.path, facts: b.facts };
  }
  const f = file.facts;
  if (f.isSymlink && f.linkTarget !== undefined) {
    const hop = path.resolve(dirname(file.linkPath), f.linkTarget);
    if (isHex40Blob(repo, hop)) {
      const o = repo.otherFiles.find((x) => x.path === hop);
      if (o) return { kind: 'blob', path: o.path, facts: o.facts };
    }
  }
  if (f.isFile && !f.isSymlink) return { kind: 'plain' };
  return { kind: 'other' };
}
