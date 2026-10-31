import type { CacheModel, Repo } from '../types';
import { repoFolderName, type RemoteListing } from './remote-repo';

export type FileState =
  | { kind: 'absent' }
  | { kind: 'cached' }
  | { kind: 'partial'; have: number }
  | { kind: 'update' };

function cachedRepo(l: RemoteListing, model: CacheModel): Repo | undefined {
  const name = repoFolderName(l.repoId, l.type);
  return model.repos.find((r) => r.folderName === name);
}

/**
 * The Hub's blob is in the repo at the Hub size: a regular file, or a link into the shared store whose payload,
 * followed exactly one hop as the scanner does, is a regular store file. Dangling or wrong-size blobs are not present.
 */
function hasBlob(repo: Repo, model: CacheModel, etag: string, size: number): boolean {
  const b = repo.blobs[etag];
  if (b !== undefined) {
    if (b.dangling) return false;
    if (b.storePath === null) return b.facts.isFile && !b.facts.isSymlink && b.size === size;
    const payload = model.store[b.storePath];
    return payload !== undefined && payload.facts.isFile && !payload.facts.isSymlink && payload.facts.size === size;
  }
  const path = `${repo.folder}/blobs/${etag}`;
  return repo.otherFiles.some((o) => o.path === path && o.facts.isFile && !o.facts.isSymlink && o.facts.size === size);
}

/**
 * hfu probe_cache semantics, plus partial downloads:
 * cached  - the Hub's blob is present at the Hub size, or snapshots/<commit> itself has the file as a plain copy of the
 *           Hub size (a plain copy in another snapshot is an older revision's file, so the file is an update);
 * partial - blobs/<etag>.incomplete is smaller than the Hub size (an interrupted update is partial too; a larger
 *           or equal one cannot be resumed and is ignored);
 * update  - other snapshots have the file (as links, or as plain copies), and neither the blob nor a partial is present;
 * absent  - none of the above.
 */
export function fileStates(l: RemoteListing, model: CacheModel): Map<string, FileState> {
  const out = new Map<string, FileState>();
  const repo = cachedRepo(l, model);
  const inSnapshots = new Map<string, Repo['files']>();
  const partials = new Map<string, number>();
  if (repo) {
    for (const f of repo.files) {
      const list = inSnapshots.get(f.relpath);
      if (list) list.push(f); else inSnapshots.set(f.relpath, [f]);
    }
    for (const p of repo.incomplete) {
      const base = p.path.slice(p.path.lastIndexOf('/') + 1);
      if (base.endsWith('.incomplete')) partials.set(base.slice(0, -'.incomplete'.length), p.size);
    }
  }
  for (const f of l.files) {
    let state: FileState = { kind: 'absent' };
    if (repo) {
      const found = inSnapshots.get(f.path) ?? [];
      const have = partials.get(f.etag);
      const resumable = have !== undefined && have < f.size;
      if (hasBlob(repo, model, f.etag, f.size)) state = { kind: 'cached' };
      else if (found.some((e) => e.commit === l.commit && e.facts.isFile && !e.facts.isSymlink && e.facts.size === f.size)) state = { kind: 'cached' };
      else if (resumable) state = { kind: 'partial', have };
      else if (found.length > 0) state = { kind: 'update' };
    }
    out.set(f.path, state);
  }
  return out;
}

/** Bytes still to fetch for these paths: full size for absent/update, size - have for partial, 0 for cached. Unknown paths count 0. */
export function requiresBytes(l: RemoteListing, states: Map<string, FileState>, paths: string[]): number {
  const sizes = new Map(l.files.map((f) => [f.path, f.size]));
  let total = 0;
  for (const p of new Set(paths)) {
    const size = sizes.get(p);
    if (size === undefined) continue;
    const s = states.get(p) ?? { kind: 'absent' };
    if (s.kind === 'absent' || s.kind === 'update') total += size;
    else if (s.kind === 'partial') total += Math.max(0, size - s.have);
  }
  return total;
}

/** Files whose etag at the new commit is already a blob of the repo but which snapshots/<commit> does not yet hold. */
export function unchangedLinks(l: RemoteListing, model: CacheModel): Array<{ path: string; etag: string }> {
  const repo = cachedRepo(l, model);
  if (!repo) return [];
  const linked = new Set(repo.files.filter((f) => f.commit === l.commit).map((f) => f.relpath));
  return l.files
    .filter((f) => hasBlob(repo, model, f.etag, f.size) && !linked.has(f.path))
    .map((f) => ({ path: f.path, etag: f.etag }));
}
