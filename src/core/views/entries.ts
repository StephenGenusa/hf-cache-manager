// GGUF entry extraction and mmproj choice, mirroring hfhub/cache.py scan().
import { pyCompare } from '../compat/pyjson';
import { isMmproj, isShard } from '../classify/gguf-names';
import type { CacheModel } from '../types';
import type { GgufEntry } from './view-types';

const hasGgufSuffix = (relpath: string): boolean =>
  (process.platform === 'win32' ? relpath.toLowerCase() : relpath).endsWith('.gguf');

const baseOf = (relpath: string): string => relpath.slice(relpath.lastIndexOf('/') + 1);

export function ggufEntries(model: CacheModel): GgufEntry[] {
  const out: GgufEntry[] = [];
  for (const repo of model.repos) {
    if (repo.type !== 'model') continue;
    const seen = new Set<string>();
    for (const commit of repo.snapshots) {
      for (const f of repo.files) {
        if (f.commit !== commit || !f.facts.isSymlink || !hasGgufSuffix(f.relpath) || seen.has(f.relpath)) continue;
        const blob = f.blobEtag === null ? undefined : repo.blobs[f.blobEtag];
        // The CLI marks `seen` only after the blob check: a dangling main link lets an older snapshot's file win.
        if (!blob || blob.dangling || !(blob.facts.isFile || blob.storePath !== null)) continue;
        seen.add(f.relpath);
        out.push({
          key: `${repo.id}:${f.relpath}`,
          repoId: repo.id,
          folderName: repo.folderName,
          relpath: f.relpath,
          basename: baseOf(f.relpath),
          blobPath: blob.path,
          sha256: blob.etag,
          size: blob.size,
          isMmproj: isMmproj(f.relpath),
          isShard: isShard(f.relpath),
          isCurrent: repo.mainCommit !== null && f.commit === repo.mainCommit,
        });
      }
    }
  }
  return out.sort((a, b) => pyCompare(a.key, b.key));
}

const PREFERENCE = ['F16', 'BF16', 'F32'] as const;
const tokens = (basename: string): Set<string> =>
  new Set(basename.split(/[-_.]/).filter((t) => t !== '').map((t) => t.toUpperCase()));

export function mmprojFor(entries: GgufEntry[], repoId: string): GgufEntry | null {
  const candidates = entries.filter((e) => e.repoId === repoId && e.isMmproj).sort((a, b) => pyCompare(a.relpath, b.relpath));
  for (const pref of PREFERENCE) {
    const hit = candidates.find((e) => tokens(e.basename).has(pref));
    if (hit) return hit;
  }
  return candidates[0] ?? null;
}
