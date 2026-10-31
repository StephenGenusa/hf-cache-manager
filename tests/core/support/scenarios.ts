// The ONLY file that adapts tests/helpers/fixture.ts (buildFixture) to the declarative tree shape.
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { classifyRepo } from '../../../src/core/classify/classify';
import type { FsLike, ReadFs } from '../../../src/core/fsx';
import { scanHub } from '../../../src/core/scan/scanner';
import type { CacheModel, RepoType, SafeRoots } from '../../../src/core/types';
import { GuardedFsViolation } from '../../helpers/guarded-fs';
import { buildFixture, type FileSpec as FxFile, type FixtureSpec, type RepoSpec as FxRepo } from '../../helpers/fixture';

export type FileKind = 'blob' | 'store' | 'hardlink' | 'plain' | 'small';
export interface FileSpec { kind: FileKind; id: string; size: number }
export const f = (kind: FileKind, id: string, size: number): FileSpec => ({ kind, id, size });

export interface RepoSpec {
  id: string; type?: RepoType; main?: string | null;                 // default: last snapshot key
  snapshots: Record<string /*commit*/, Record<string /*relpath*/, FileSpec>>;
  incomplete?: Array<{ etag: string; ageMs: number }>;               // blobs/<etag>.incomplete, mtime = now - ageMs
  extra?: Record<string /*folder-relative posix*/, string /*content*/>;
  outsideDirLink?: string;                                           // relpath in main snapshot -> symlink to an outside dir holding a canary
}
export interface TreeSpec {
  repos: RepoSpec[]; storeMarked?: boolean /*default true*/; storeLocks?: Array<{ id: string; size: number }>;
  lmstudio?: Array<{ rel: string; repo: string; file: string }>;    // absolute link -> repo blob of that file in main
}
export interface Tree {
  root: string; hub: string; holdRoot: string; lmstudioRoot: string; appData: string; lockDir: string; now: number;
  roots: SafeRoots;
  fs: FsLike;                                                        // the fixture's guarded fs
  scan(): Promise<CacheModel>;
  folder(repoId: string): string; link(repoId: string, commit: string, rel: string): string;
  blob(repoId: string, rel: string, commit?: string): string;       // one-hop repo blob path
  store(id: string, size: number): string; etag(id: string, size: number): string;
  dispose(): Promise<void>;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const bytesOf = (id: string, size: number): string => `${id}|`.repeat(Math.ceil(size / (id.length + 1))).slice(0, size);
const keyOf = (id: string, size: number): string => `${id}|${size}`;

function fxFile(path: string, s: FileSpec): FxFile {
  const content = bytesOf(s.id, s.size);
  const key = keyOf(s.id, s.size);
  switch (s.kind) {
    case 'plain': return { path, plain: content };
    case 'blob': return { path, blob: { key, content, storage: 'plain' } };
    case 'hardlink': return { path, blob: { key, content, storage: 'hardlink' } };
    case 'small': return { path, blob: { key, content, storage: 'plain', etag: 'git-sha1' } };
    case 'store': return { path, blob: { key, content, storage: 'store', xetHash: sha256('xet:' + content) } };
  }
}

export async function buildTree(spec: TreeSpec): Promise<Tree> {
  const now = Date.now();
  let needOutside = false;
  const repos: FxRepo[] = spec.repos.map((r) => {
    const commits = Object.keys(r.snapshots);
    const mainIdx = r.main === null ? null : r.main === undefined ? commits.length - 1 : commits.indexOf(r.main);
    if (mainIdx === -1) throw new Error(`${r.id}: main ${String(r.main)} is not a snapshot key`);
    if (r.outsideDirLink !== undefined) needOutside = true;
    return {
      id: r.id,
      ...(r.type ? { type: r.type } : {}),
      main: mainIdx,
      snapshots: commits.map((commit) => ({
        commit,
        files: Object.entries(r.snapshots[commit]!).map(([p, s]) => fxFile(p, s)),
      })),
      ...(r.incomplete ? { incomplete: r.incomplete.map((i) => ({ name: i.etag, bytes: 16, mtimeMs: now - i.ageMs })) } : {}),
    };
  });
  const usesStore = spec.repos.some((r) => Object.values(r.snapshots).some((s) => Object.values(s).some((x) => x.kind === 'store')));
  const fxSpec: FixtureSpec = {
    repos,
    holdRoot: true,
    views: { lmstudio: {
      links: Object.fromEntries((spec.lmstudio ?? []).map((l) => [l.rel, { repo: l.repo, file: l.file }])),
    } },
    ...(needOutside ? { outside: { 'outside-dir/canary.txt': 'canary\n' } } : {}),
    ...(spec.storeMarked === false && (usesStore || spec.storeLocks) ? { store: { marker: null } } : {}),
  };
  const fx = await buildFixture(fxSpec);
  try {
    for (const r of spec.repos) {
      const h = fx.repo(r.id);
      for (const [rel, content] of Object.entries(r.extra ?? {})) {
        const p = join(h.folder, ...rel.split('/'));
        await fx.fs.mkdir(dirname(p), { recursive: true });
        await fx.fs.writeFile(p, content);
      }
      if (r.outsideDirLink !== undefined) {
        const p = join(h.snapshotDir(), ...r.outsideDirLink.split('/'));
        await fx.fs.mkdir(dirname(p), { recursive: true });
        await fx.fs.symlink(fx.outside('outside-dir'), p);
      }
    }
    for (const l of spec.storeLocks ?? []) {
      const p = fx.storePath(keyOf(l.id, l.size)) + '.lock';
      await fx.fs.mkdir(dirname(p), { recursive: true });
      await fx.fs.writeFile(p, '');
    }
    const appData = join(fx.root, 'app-data');
    await fx.fs.mkdir(appData, { recursive: true });
    const lmstudioRoot = fx.viewRoots.lmstudio!;
    return {
      root: fx.root, hub: fx.hubRoot, holdRoot: fx.holdRoot, lmstudioRoot, appData,
      lockDir: join(dirname(fx.hubRoot), '.hf-cache-manager'), now,
      roots: fx.roots, fs: fx.fs,
      scan: () => scanHub(fx.hubRoot, fx.fs),
      folder: (id) => fx.repo(id).folder,
      link: (id, commit, rel) => join(fx.repo(id).snapshotDir(commit), ...rel.split('/')),
      blob: (id, rel, commit) => fx.repo(id).blobOf(rel, commit),
      store: (id, size) => fx.storePath(keyOf(id, size)),
      etag: (id, size) => fx.etag(keyOf(id, size)),
      dispose: () => fx.dispose(),
    };
  } catch (e) {
    await fx.dispose();
    throw e;
  }
}

/**
 * A ReadFs over `t.fs` that converts exactly one guarded-fs refusal, `stat()` of a dangling leaf symlink, into the
 * ENOENT the OS would return, so the scanner can mark such links dangling. Every call still goes through `t.fs`;
 * every other refusal and error propagates unchanged.
 */
export function tolerantFs(t: Tree): ReadFs {
  return Object.assign(Object.create(t.fs) as ReadFs, {
    stat: async (p: string) => {
      try {
        return await t.fs.stat(p);
      } catch (e) {
        if (e instanceof GuardedFsViolation && e.message.endsWith(': dangling leaf symlink')) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' });
        }
        throw e;
      }
    },
  });
}

/** `t.scan()` through `tolerantFs(t)`: use it when the tree holds dangling symlinks the scanner must stat. */
export function scanTolerant(t: Tree): Promise<CacheModel> {
  return scanHub(t.hub, tolerantFs(t));
}

/** Key of the classified group containing `relpath` (any snapshot) in repo `repoId`; throws when none does. */
export function groupKeyFor(model: CacheModel, repoId: string, relpath: string): string {
  const repo = model.repos.find((r) => r.id === repoId);
  if (!repo) throw new Error(`unknown repo ${repoId}`);
  const g = classifyRepo(repo).groups.find((x) => x.files.some((file) => file.relpath === relpath));
  if (!g) throw new Error(`${repoId}: no group contains ${relpath}`);
  return g.key;
}
