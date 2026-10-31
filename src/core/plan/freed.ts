import path, { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { compareStrings } from '../paths';
import { sweepDecision } from '../scan/store';
import type { CacheModel, FileFacts, FreedLine, Repo, RepoBlob, SnapshotFile, StoreFile } from '../types';

/** `.refs` line for a repo blob: POSIX path relative to the hub, e.g. `models--o--a/blobs/<etag>`. */
export function refLine(hubRoot: string, repoBlobPath: string): string {
  const rel = relative(hubRoot, repoBlobPath);
  if (rel === '' || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error(`refLine: ${repoBlobPath} is not under ${hubRoot}`);
  }
  return rel.split(sep).join('/');
}

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

interface LinkRef { repo: Repo; path: string; target: string | null }

/** Model-wide facts storeDoubt needs, independent of the store and of the doomed set. Build once per computeFreed. */
export interface DoubtContext {
  blobs: Array<{ repo: Repo; blob: RepoBlob }>;
  /** Every symlink in files/otherFiles of every repo, with its first hop (scanner rule: abspath, never realpath). */
  links: LinkRef[];
  /** Paths the model knows as real entries (check 3 (i)). */
  realEntries: Set<string>;
  /** `<folder>/blobs` of every repo whose blobs/ the scan saw as a real directory (check 3 (ii)). */
  realBlobDirs: Set<string>;
}

export function doubtContext(model: CacheModel): DoubtContext {
  const blobs = model.repos.flatMap((repo) => Object.values(repo.blobs).map((blob) => ({ repo, blob })));
  const links: LinkRef[] = [];
  const realEntries = new Set<string>(Object.keys(model.store));
  const realBlobDirs = new Set<string>();
  const add = (repo: Repo, p: string, f: FileFacts): void => {
    if (!f.isSymlink) return;
    links.push({ repo, path: p, target: f.linkTarget === undefined ? null : path.resolve(dirname(p), f.linkTarget) });
  };
  for (const repo of model.repos) {
    const blobsDir = join(repo.folder, 'blobs');
    // the scanner lists a non-directory blobs/ entry (e.g. a symlink) as an otherFile and records no RepoBlobs then
    if (!repo.otherFiles.some((o) => o.path === blobsDir)) realBlobDirs.add(blobsDir);
    for (const b of Object.values(repo.blobs)) realEntries.add(b.path);
    for (const file of repo.files) {
      realEntries.add(file.linkPath);
      add(repo, file.linkPath, file.facts);
    }
    for (const o of repo.otherFiles) {
      if (!o.facts.isSymlink) realEntries.add(o.path);
      add(repo, o.path, o.facts);
    }
    for (const d of [...repo.snapshotDirs, ...repo.otherDirs]) realEntries.add(d);
  }
  return { blobs, links, realEntries, realBlobDirs };
}

/** Sorted unique ids of repos holding a non-doomed link of any kind whose first hop is `store.path`. */
function storeHolders(ctx: DoubtContext, store: StoreFile, gone: ReadonlySet<string>): string[] {
  return sortedUnique([
    ...ctx.blobs.filter(({ blob }) => blob.storePath === store.path && !gone.has(blob.path)).map((x) => x.repo.id),
    ...ctx.links.filter((l) => l.target === store.path && !gone.has(l.path)).map((l) => l.repo.id),
  ]);
}

/**
 * SAFETY: `.refs` alone may not see every link to a payload (a payload is freed only
 * with no remaining link of any kind). Returns a warning (the payload must be kept, store-uncertain) when, outside `doomed`
 * (absolute paths):
 *  1. any link of any kind (RepoBlob, snapshot entry or otherFile symlink) has a first hop equal to `store.path` but is
 *     not among the payload's validRefs (the manifest does not know it), or
 *  2. any non-dangling RepoBlob has a `storePath` that is not a key of `model.store` (it may be an alias of this
 *     payload; the planner cannot realpath, so this doubts every sweep), or
 *  3. any snapshot-entry or otherFile symlink has a first hop that is neither (i) a path the model knows as a real
 *     entry (RepoBlob, snapshot entry, non-symlink otherFile, snapshot/other dir, store key; check 1 judges the key
 *     of this store) nor (ii) lexically `<folder>/blobs/<name>` of a repo whose blobs/ is a real directory (so a
 *     dangling link of an interrupted download does not block). An alias prefix, a hop through a symlinked directory
 *     or through a symlink outside the model could reach the payload. Accepted cost: a link to any file outside the
 *     hub blocks every sweep.
 * Returns null when there is no such doubt.
 */
export function storeDoubt(
  model: CacheModel, store: StoreFile, doomed: Iterable<string>, ctx: DoubtContext = doubtContext(model),
): string | null {
  const gone = doomed instanceof Set ? (doomed as Set<string>) : new Set(doomed);
  // A link the manifest knows about (same join-built absolute path sweepDecision matches) is normal sharing.
  const known = new Set((store.validRefs ?? []).map((r) => join(model.hubRoot, ...r.split('/'))));
  const unknown = [
    ...ctx.blobs.filter(({ blob }) => blob.storePath === store.path).map(({ repo, blob }) => ({ repo, path: blob.path })),
    ...ctx.links.filter((l) => l.target === store.path),
  ].filter((l) => !gone.has(l.path) && !known.has(l.path));
  if (unknown.length > 0) {
    return `store payload ${store.hash} kept: linked by ${sortedUnique(unknown.map((x) => x.repo.id)).join(', ')} without a valid .refs line`;
  }
  const alien = ctx.blobs.find(({ blob }) =>
    blob.storePath !== null && !gone.has(blob.path) && !blob.dangling && !Object.hasOwn(model.store, blob.storePath));
  if (alien) {
    return `store payload ${store.hash} kept: ${alien.repo.id} has a blob link to ${alien.blob.storePath} outside the known store`;
  }
  const opaque = ctx.links.find((l) => !gone.has(l.path) && (l.target === null
    || !(ctx.realEntries.has(l.target) || ctx.realBlobDirs.has(dirname(l.target)))));
  if (opaque) {
    return `store payload ${store.hash} kept: ${opaque.repo.id} has a link ${opaque.path} -> ${opaque.target ?? '(unreadable)'} that may reach it`;
  }
  return null;
}

type Entry =
  | { kind: 'blob'; repo: Repo; blob: RepoBlob }
  | { kind: 'snapshot'; repo: Repo; file: SnapshotFile }
  | { kind: 'other'; repo: Repo; facts: FileFacts };

const isRegular = (f: FileFacts): boolean => f.isFile && !f.isSymlink;
const inodeKey = (f: FileFacts): string => `${f.dev}:${f.ino}`;

function indexModel(model: CacheModel): Map<string, Entry> {
  const idx = new Map<string, Entry>();
  for (const repo of model.repos) {
    for (const blob of Object.values(repo.blobs)) idx.set(blob.path, { kind: 'blob', repo, blob });
    for (const file of repo.files) idx.set(file.linkPath, { kind: 'snapshot', repo, file });
    for (const o of repo.otherFiles) idx.set(o.path, { kind: 'other', repo, facts: o.facts });
  }
  return idx;
}

const factsOfEntry = (e: Entry): FileFacts =>
  e.kind === 'blob' ? e.blob.facts : e.kind === 'snapshot' ? e.file.facts : e.facts;

/** First-hop target of a symlink entry (absolute, not realpath'd), or null. */
function firstHop(e: Entry, p: string): string | null {
  if (e.kind === 'snapshot' && e.file.blobEtag !== null) {
    const b = e.repo.blobs[e.file.blobEtag];
    if (b) return b.path;
  }
  const f = factsOfEntry(e);
  return f.isSymlink && f.linkTarget !== undefined ? path.resolve(dirname(p), f.linkTarget) : null;
}

/**
 * Bytes really freed by removing the doomed repo blobs and the other doomed paths, with one
 * line per decision. Every doubt counts 0. Store payloads are counted only when the sweep rules allow their deletion.
 */
export function computeFreed(
  model: CacheModel,
  doomedRepoBlobPaths: string[],
  doomedLinks: string[],
): { bytes: number; lines: FreedLine[] } {
  const idx = indexModel(model);
  const ctx = doubtContext(model);
  const doomed = new Set<string>([...doomedRepoBlobPaths, ...doomedLinks]);
  for (const p of doomed) if (!idx.has(p)) throw new Error('computeFreed: unknown path ' + p);

  const lines: FreedLine[] = [];
  const regular = new Map<string, Array<{ path: string; entry: Entry }>>(); // by inode
  const storeGroups = new Map<string, RepoBlob[]>(); // by storePath

  for (const p of doomed) {
    const e = idx.get(p)!;
    const facts = factsOfEntry(e);
    if (e.kind === 'blob' && e.blob.storePath !== null) {
      const g = storeGroups.get(e.blob.storePath) ?? [];
      g.push(e.blob);
      storeGroups.set(e.blob.storePath, g);
    } else if (isRegular(facts)) {
      const k = inodeKey(facts);
      const g = regular.get(k) ?? [];
      g.push({ path: p, entry: e });
      regular.set(k, g);
    } else {
      const target = firstHop(e, p);
      if (target !== null && doomed.has(target)) continue; // the target's own line covers it
      lines.push({ path: p, bytes: 0, reason: 'link-only' });
    }
  }

  // Regular files: an inode is freed only when every one of its links is doomed.
  if (regular.size > 0) {
    const holders = new Map<string, Array<{ path: string; repoId: string }>>();
    for (const [p, e] of idx) {
      const f = factsOfEntry(e);
      if (!isRegular(f)) continue;
      const k = inodeKey(f);
      if (!regular.has(k)) continue;
      const h = holders.get(k) ?? [];
      h.push({ path: p, repoId: e.repo.id });
      holders.set(k, h);
    }
    for (const [k, group] of regular) {
      group.sort((a, b) => compareStrings(a.path, b.path));
      const facts = factsOfEntry(group[0]!.entry);
      const n = facts.nlink;
      if (group.length >= n) {
        const reason = n === 1 ? (group[0]!.entry.kind === 'snapshot' ? 'plain-file' : 'only-link') : 'hardlink-all-planned';
        group.forEach((g, i) => lines.push({ path: g.path, bytes: i === 0 ? facts.size : 0, reason }));
      } else {
        // Invariant: holders has every key of `regular` (each doomed regular entry is itself an idx entry)
        const sharedWith = sortedUnique(holders.get(k)!.filter((h) => !doomed.has(h.path)).map((h) => h.repoId));
        for (const g of group) lines.push({ path: g.path, bytes: 0, reason: 'hardlink-others-remain', sharedWith });
      }
    }
  }

  // Store-link repo blobs: the payload is counted once, and only when the .refs rule and storeDoubt both allow its deletion.
  const byFolder = new Map(model.repos.map((r) => [r.folderName, r.id]));
  for (const [storePath, group] of storeGroups) {
    const store = Object.hasOwn(model.store, storePath) ? model.store[storePath] : undefined;
    if (!store || group.some((b) => b.dangling)) {
      for (const b of group) lines.push({ path: b.path, bytes: 0, reason: 'store-uncertain' });
      continue;
    }
    if (storeDoubt(model, store, doomed, ctx) !== null) {
      const sharedWith = storeHolders(ctx, store, doomed);
      lines.push({ path: store.path, bytes: 0, reason: 'store-uncertain', ...(sharedWith.length ? { sharedWith } : {}) });
      continue;
    }
    if (store.lockPresent) {
      lines.push({ path: store.path, bytes: 0, reason: 'store-uncertain' });
      continue;
    }
    if (store.facts.nlink > 1) {
      lines.push({ path: store.path, bytes: 0, reason: 'hardlink-others-remain' });
      continue;
    }
    const removing = group.map((b) => b.path);
    const d = sweepDecision(store, removing, model.storeMarked);
    if (d.deletable) {
      lines.push({ path: store.path, bytes: store.facts.size, reason: 'store-unreferenced' });
    } else {
      // filtered against every doomed path, not just `removing`, so a doomed .refs-named link never lists its own repo
      const remaining = (store.validRefs ?? []).filter((r) => !doomed.has(join(model.hubRoot, ...r.split('/'))));
      const sharedWith = sortedUnique(remaining.flatMap((r) => {
        const id = byFolder.get(r.split('/')[0]!); // split always yields a first element
        return id === undefined ? [] : [id];
      }));
      // store lines carry sharedWith only when it is non-empty
      lines.push({ path: store.path, bytes: 0, reason: d.reason, ...(d.reason === 'store-shared' && sharedWith.length ? { sharedWith } : {}) });
    }
  }

  lines.sort((a, b) => compareStrings(a.path, b.path));
  return { bytes: lines.reduce((s, l) => s + l.bytes, 0), lines };
}
