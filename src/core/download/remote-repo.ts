import type { FileFacts, Repo, RepoBlob, RepoType, SnapshotFile } from '../types';

declare const verified: unique symbol;

/**
 * A Hub revision listing that has passed the safety gate. Only toRemoteListing builds one: `files` holds only
 * files with a safe path, a hex etag and a safe integer size.
 */
export interface RemoteListing {
  readonly [verified]: true;
  repoId: string;
  type: RepoType;
  commit: string;
  files: Array<{ path: string; size: number; etag: string; lfs: boolean }>;
  /** Paths with no Hub size or etag: never downloaded, never grouped. */
  unverifiable: string[];
  /** Paths refused for an unsafe path, a malformed etag or size, or a duplicate. Never used in any path. */
  refused: string[];
}

export interface RawListing {
  repoId: string;
  type: RepoType;
  commit: string;
  files: Array<{ path: string; size: number | null; etag: string | null; lfs: boolean }>;
}

/** Root of the in-memory synthetic repos. Never a real directory; nothing reads or writes it. */
export const REMOTE_ROOT = '/hub-remote';

const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9._])?$/;
const ETAG = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMIT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** models--org--name (inverse of the scanner's parseRepoFolder). Throws on ids that would not round-trip. */
export function repoFolderName(repoId: string, type: RepoType): string {
  const segs = repoId.split('/');
  if (segs.length > 2 || segs.some((s) => !SEGMENT.test(s) || s.includes('--'))) {
    throw new Error(`unsafe repo id: ${JSON.stringify(repoId)}`);
  }
  return `${type}s--${segs.join('--')}`;
}

/** A sibling path that is safe to join under a snapshot: relative POSIX, no empty or dot segments, no backslash or NUL. */
export function isSafeSiblingPath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The only way to make a RemoteListing: sorts raw Hub siblings into verified files, unverifiable and refused paths. */
export function toRemoteListing(raw: RawListing): RemoteListing {
  const files: RemoteListing['files'] = [];
  const unverifiable: string[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const f of raw.files) {
    if (!isSafeSiblingPath(f.path) || seen.has(f.path)) {
      refused.push(f.path);
      continue;
    }
    if (f.size === null || f.etag === null) {
      unverifiable.push(f.path);
      seen.add(f.path);
    } else if (!ETAG.test(f.etag) || !Number.isSafeInteger(f.size) || f.size < 0) {
      refused.push(f.path);
    } else {
      seen.add(f.path);
      files.push({ path: f.path, size: f.size, etag: f.etag, lfs: f.lfs });
    }
  }
  return { repoId: raw.repoId, type: raw.type, commit: raw.commit, files, unverifiable, refused } as RemoteListing;
}

const factsFor = (size: number, dir: boolean): FileFacts => ({
  dev: 0, ino: 0, size, mtimeMs: 0, nlink: 1,
  isSymlink: false, isDirectory: dir, isFile: !dir,
});

/**
 * Synthetic in-memory Repo for the classifier: one snapshot named after the commit, every file current, blobs by
 * etag, all regular files. Paths sit under REMOTE_ROOT and are never touched on disk. Pass a ReadText that
 * returns null (or serves listing content) to classifyRepo.
 */
export function remoteRepo(l: RemoteListing): Repo {
  if (!COMMIT.test(l.commit)) throw new Error(`unsafe commit: ${JSON.stringify(l.commit)}`);
  const folderName = repoFolderName(l.repoId, l.type);
  const folder = `${REMOTE_ROOT}/${folderName}`;
  const blobs: Record<string, RepoBlob> = {};
  const files: SnapshotFile[] = [];
  for (const f of l.files) {
    if (blobs[f.etag] === undefined) {
      blobs[f.etag] = {
        path: `${folder}/blobs/${f.etag}`, etag: f.etag, facts: factsFor(f.size, false),
        storePath: null, size: f.size, dangling: false,
      };
    }
    files.push({
      relpath: f.path, commit: l.commit, linkPath: `${folder}/snapshots/${l.commit}/${f.path}`,
      facts: factsFor(f.size, false), blobEtag: f.etag, isCurrent: true,
    });
  }
  return {
    id: l.repoId, type: l.type, folder, folderName, mainCommit: l.commit, snapshots: [l.commit], files, blobs,
    orphanEtags: [], incomplete: [], snapshotDirs: [], folderFacts: factsFor(0, true), otherFiles: [], otherDirs: [],
  };
}
