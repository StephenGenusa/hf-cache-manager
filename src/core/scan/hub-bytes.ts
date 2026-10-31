import type { CacheModel, FileFacts } from '../types';

/**
 * The space the hub takes on disk: the size of every regular file the scan saw (repo blobs, plain snapshot files, other
 * repo files, shared-store payloads), each inode counted once, so hardlinked and store-shared files are not doubled.
 * Symlinks and directories add nothing.
 */
export function hubDiskBytes(model: CacheModel): number {
  const sizes = new Map<string, number>();
  const add = (f: FileFacts): void => {
    if (f.isFile) sizes.set(`${f.dev}:${f.ino}`, f.size);
  };
  for (const r of model.repos) {
    for (const b of Object.values(r.blobs)) add(b.facts);
    for (const f of r.files) add(f.facts);
    for (const o of r.otherFiles) add(o.facts);
  }
  for (const s of Object.values(model.store)) add(s.facts);
  let total = 0;
  for (const n of sizes.values()) total += n;
  return total;
}
