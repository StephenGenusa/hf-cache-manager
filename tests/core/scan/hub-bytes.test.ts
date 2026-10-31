import { describe, expect, it } from 'vitest';
import { hubDiskBytes } from '../../../src/core/scan/hub-bytes';
import type { CacheModel, FileFacts, Repo, RepoBlob, SnapshotFile, StoreFile } from '../../../src/core/types';

const file = (ino: number, size: number, over: Partial<FileFacts> = {}): FileFacts => ({
  dev: 1, ino, size, mtimeMs: 0, nlink: 1, isSymlink: false, isDirectory: false, isFile: true, ...over,
});
const link = (ino: number): FileFacts => file(ino, 60, { isSymlink: true, isFile: false, linkTarget: '../../blobs/x' });

const blob = (etag: string, facts: FileFacts, size = facts.size): RepoBlob =>
  ({ path: `/hub/m/blobs/${etag}`, etag, facts, storePath: null, size, dangling: false });
const snap = (relpath: string, facts: FileFacts): SnapshotFile =>
  ({ relpath, commit: 'c', linkPath: `/hub/m/snapshots/c/${relpath}`, facts, blobEtag: null, isCurrent: true });
const store = (hash: string, facts: FileFacts): StoreFile =>
  ({ path: `/hub/blobs/aa/${hash}`, hash, facts, refsPath: '', refsRaw: [], validRefs: [], lockPresent: false });

function repo(over: Partial<Repo>): Repo {
  return {
    id: 'o/m', type: 'model', folder: '/hub/m', folderName: 'models--o--m', mainCommit: null, snapshots: [], files: [], blobs: {},
    orphanEtags: [], incomplete: [], snapshotDirs: [], folderFacts: file(1, 4096, { isDirectory: true, isFile: false }),
    otherFiles: [], otherDirs: [], ...over,
  };
}
const model = (repos: Repo[], storeFiles: StoreFile[] = []): CacheModel =>
  ({ hubRoot: '/hub', repos, storeMarked: true, store: Object.fromEntries(storeFiles.map((s) => [s.path, s])), scannedAt: 0 });

describe('hubDiskBytes', () => {
  it('is 0 for an empty hub', () => {
    expect(hubDiskBytes(model([]))).toBe(0);
  });

  it('adds the regular files of every repo: blobs, plain snapshot files and other files', () => {
    const r = repo({
      blobs: { a: blob('a', file(10, 1000)), b: blob('b', file(11, 200)) },
      files: [snap('plain.txt', file(12, 30)), snap('model.gguf', link(13))],
      otherFiles: [{ path: '/hub/m/refs/main', facts: file(14, 40) }],
    });
    expect(hubDiskBytes(model([r]))).toBe(1000 + 200 + 30 + 40);
  });

  it('counts a file reached through several hardlinks once, across repos and the shared store', () => {
    const shared = file(20, 5000, { nlink: 3 });
    const r1 = repo({ id: 'o/a', blobs: { a: blob('a', shared) } });
    const r2 = repo({ id: 'o/b', blobs: { a: blob('a', shared) } });
    expect(hubDiskBytes(model([r1, r2], [store('h', shared)]))).toBe(5000);
  });

  it('tells inodes on different devices apart', () => {
    const r = repo({ blobs: { a: blob('a', file(30, 100)), b: blob('b', file(30, 100, { dev: 2 })) } });
    expect(hubDiskBytes(model([r]))).toBe(200);
  });

  it('counts a store payload once and a repo blob that is only a link to it as nothing', () => {
    const r = repo({ blobs: { a: { ...blob('a', link(40), 9000), storePath: '/hub/blobs/aa/h' } } });
    expect(hubDiskBytes(model([r], [store('h', file(41, 9000))]))).toBe(9000);
  });

  it('ignores symlinks and directories, and a store entry that is not a regular file', () => {
    const r = repo({ files: [snap('x', link(50))], otherFiles: [{ path: '/hub/m/d', facts: file(51, 4096, { isDirectory: true, isFile: false }) }] });
    expect(hubDiskBytes(model([r], [store('h', link(52))]))).toBe(0);
  });
});
