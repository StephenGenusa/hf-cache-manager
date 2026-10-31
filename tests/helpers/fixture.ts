import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { FsLike } from '../../src/core/fsx';
import { nodeFs } from '../../src/core/fsx';
import type { RepoType, SafeRoots } from '../../src/core/types';
import type { CanaryContext } from './canary-core';
import { guardedFs } from './guarded-fs';
import { makeTempRoot, removeTempRoot, setMtime } from './tmp';

// ---------- spec (declarative; plain data so property tests can generate it) ----------
export interface FixtureSpec {
  repos?: RepoSpec[];
  blobs?: Record<string, BlobSpec>;
  store?: StoreSpec;
  hubMissing?: boolean;
  holdRoot?: boolean;
  views?: { lmstudio?: ViewSpec; ollama?: ViewSpec };
  config?: ConfigSpec | { raw: string };
  token?: string;
  outside?: Record<string, string>;
}

export interface BlobSpec {
  bytes?: number;
  content?: string | Uint8Array;
  etag?: 'sha256' | 'git-sha1';
  storage?: 'plain' | 'hardlink' | 'store';
  extraLinks?: number;
  xetHash?: string;
  refs?: 'auto' | 'missing' | 'not-a-file' | string[];
  refsExtra?: string[];
  lock?: false | 'lock' | 'soft';
  danglingStore?: boolean;
}
export type BlobRef = string | ({ key: string } & BlobSpec);

export interface RepoSpec {
  id: string;
  type?: RepoType;
  snapshots: SnapshotSpec[];
  main?: number | null | { raw: string };
  orphans?: BlobRef[];
  incomplete?: Array<{ name?: string; bytes?: number; mtimeMs?: number }>;
  blobsExtra?: Record<string, string>;
}
export interface SnapshotSpec {
  commit?: string;
  mtimeMs?: number;
  files: FileSpec[];
}
export type FileSpec =
  | { path: string; blob?: BlobRef }
  | { path: string; plain: string | number }
  | { path: string; dir: true }
  | { path: string; rawLink: string };

export interface StoreSpec { marker?: string | null }

export type LinkTo = { repo: string; file: string; commit?: string } | { raw: string };
export interface ViewSpec {
  exists?: boolean;
  links?: Record<string, LinkTo>;
  files?: Record<string, string | ((r: FixtureResolver) => string)>;
  dirs?: string[];
  state?: object | ((r: FixtureResolver) => object) | { raw: string };
}
export interface ConfigSpec {
  lmstudio?: boolean | string;
  ollama?: boolean | string;
  aliases?: Record<string, string>;
}
export interface FixtureResolver {
  hubRoot: string;
  etag(key: string): string;
  etagOf(repoId: string, relpath: string, commit?: string): string;
  repoBlobPath(repoId: string, etag: string): string;
}

// ---------- built fixture ----------
export interface RepoHandle {
  id: string; type: RepoType; folder: string; folderName: string;
  commits: string[];
  mainCommit: string | null;
  snapshotDir(commit?: string): string;
  file(relpath: string, commit?: string): string;
  etagOf(relpath: string, commit?: string): string;
  blobPath(etag: string): string;
  blobOf(relpath: string, commit?: string): string;
  incomplete: string[];
}
export interface TreeEntry {
  path: string; type: 'file' | 'dir' | 'symlink';
  dev: number; ino: number; size: number; nlink: number;
  linkTarget?: string; sha256?: string;
}
export interface Fixture extends FixtureResolver {
  root: string;
  hubRoot: string;
  home: string;
  hfHome: string;
  env: NodeJS.ProcessEnv;
  configPath: string | null;
  viewRoots: { lmstudio: string | null; ollama: string | null };
  holdRoot: string;
  roots: SafeRoots;
  fs: FsLike;
  canaries: string[];
  repo(id: string): RepoHandle;
  xetHash(key: string): string;
  storePath(key: string): string;
  refsPath(key: string): string;
  content(key: string): Buffer;
  outside(rel: string): string;
  viewPath(view: 'lmstudio' | 'ollama', rel: string): string;
  extraLinks(key: string): string[];
  snapshotTree(): Promise<Map<string, TreeEntry>>;
  diskUsage(): Promise<number>;
  dispose(): Promise<void>;
}

export const BASE_MTIME_MS = 1_760_000_000_000;

const sha256Hex = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export function contentFor(key: string, bytes: number): Buffer {
  const unit = `${key}\n`;
  return Buffer.from(unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes));
}

interface BlobEntry { spec: BlobSpec; content: Buffer; etag: string }

function makeEntry(key: string, spec: BlobSpec): BlobEntry {
  const content =
    spec.content !== undefined
      ? Buffer.from(spec.content)
      : contentFor(key, spec.bytes ?? 64);
  const etag =
    spec.etag === 'git-sha1'
      ? createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest('hex')
      : sha256Hex(content);
  return { spec, content, etag };
}

function buildRegistry(spec: FixtureSpec): Map<string, BlobEntry> {
  const reg = new Map<string, BlobEntry>();
  for (const [k, s] of Object.entries(spec.blobs ?? {})) reg.set(k, makeEntry(k, s));
  const refs: BlobRef[] = [];
  const bare = (rp: RepoSpec, f: FileSpec): BlobRef | undefined =>
    'plain' in f || 'dir' in f || 'rawLink' in f ? undefined : (f.blob ?? `${rp.id}:${f.path}`);
  for (const rp of spec.repos ?? []) {
    for (const sn of rp.snapshots) for (const f of sn.files) { const b = bare(rp, f); if (b !== undefined) refs.push(b); }
    refs.push(...(rp.orphans ?? []));
  }
  for (const r of refs) {
    if (typeof r === 'string') continue;
    const { key, ...rest } = r;
    const have = reg.get(key);
    if (have && !isDeepStrictEqual(have.spec, rest)) throw new Error(`conflicting BlobSpec for key ${key}`);
    if (!have) reg.set(key, makeEntry(key, rest));
  }
  for (const r of refs) if (typeof r === 'string' && !reg.has(r)) reg.set(r, makeEntry(r, {}));
  return reg;
}

export interface BuildOptions {
  /** Canary context to protect the fixture with; defaults to the current vitest one (Playwright passes its own). */
  canaries?: CanaryContext;
  /** The temp root prefix; E2E runs use `hfcm-e2e-` so the root is the run dir the app's E2E guard requires. */
  rootPrefix?: 'hfcm-fx-' | 'hfcm-e2e-';
}

export async function buildFixture(spec: FixtureSpec, opts: BuildOptions = {}): Promise<Fixture> {
  // Dynamic import keeps vitest out of the module graph for non-vitest callers that pass their own context.
  const canary = opts.canaries ?? (await import('./canary')).currentCanaries();
  if (!canary) throw new Error('buildFixture requires useCanaries() in this test file');
  if (spec.hubMissing && (spec.repos?.length ?? 0) > 0) throw new Error('hubMissing cannot be combined with repos');
  for (const rp of spec.repos ?? []) {
    if (typeof rp.main === 'number' && (!Number.isInteger(rp.main) || rp.main < 0 || rp.main >= rp.snapshots.length)) {
      throw new Error(`${rp.id}: main index ${rp.main} out of range`);
    }
  }
  const reg = buildRegistry(spec);
  const entryOf = (key: string): BlobEntry => {
    const e = reg.get(key);
    if (!e) throw new Error(`unknown blob key ${key}`);
    return e;
  };

  const root = await makeTempRoot(opts.rootPrefix ?? 'hfcm-fx-');
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    await canary.releaseUnder(root, protectedPaths); // throws on tampering; fixture stays undisposed
    disposed = true;
    await removeTempRoot(root);
  };
  canary.onCleanup(dispose);

  const fs = guardedFs(nodeFs);
  const hubRoot = join(root, 'hf', 'hub');
  const home = join(root, 'home');
  const hfHome = join(root, 'hf-home');
  const holdRoot = join(root, 'hf', '.hf-cache-manager', 'recently-deleted');
  const outside = (rel: string): string => join(root, 'outside', rel);
  const protectedPaths: string[] = [];
  const extra = new Map<string, string[]>();
  const writeAt = async (p: string, data: string | Uint8Array): Promise<void> => {
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  };
  const canaryFile = async (p: string): Promise<void> => {
    await writeAt(p, 'canary\n');
    protectedPaths.push(p);
  };

  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(hfHome, { recursive: true });
  await canaryFile(join(root, 'hf', '.hfcm-canary'));
  if (!spec.hubMissing) {
    await fs.mkdir(hubRoot, { recursive: true });
    await canaryFile(join(hubRoot, '.hfcm-canary'));
  }
  await canaryFile(outside('canary.bin'));
  for (const [rel, text] of Object.entries(spec.outside ?? {})) {
    await writeAt(outside(rel), text);
    protectedPaths.push(outside(rel));
  }
  if (spec.holdRoot) await fs.mkdir(holdRoot, { recursive: true });
  if (spec.token !== undefined) await writeAt(join(hfHome, 'token'), spec.token);

  // ---------- repos ----------
  const handles = new Map<string, RepoHandle>();
  const linkEtags = new Map<string, Map<string, string>>(); // `${id}\0${commit}` -> relpath -> etag
  const firstHardlink = new Map<string, string>();
  const storeLinks = new Map<string, Set<string>>(); // key -> `${folderName}/blobs/${etag}`
  const xetOf = (key: string): string => entryOf(key).spec.xetHash ?? sha256Hex(`xet:${key}`);
  const storeFile = (key: string): string => {
    const h = xetOf(key);
    return join(hubRoot, 'blobs', h.slice(0, 2), h);
  };
  const folderOf = (id: string, type: RepoType): string => `${type}s--${id.replaceAll('/', '--')}`;

  for (const rp of spec.repos ?? []) {
    const type = rp.type ?? 'model';
    const folderName = folderOf(rp.id, type);
    const folder = join(hubRoot, folderName);
    const blobsDir = join(folder, 'blobs');
    await fs.mkdir(blobsDir, { recursive: true });
    await fs.mkdir(join(folder, 'refs'), { recursive: true });
    await fs.mkdir(join(folder, 'snapshots'), { recursive: true });
    const written = new Set<string>();

    const placeBlob = async (key: string): Promise<string> => {
      const e = entryOf(key);
      const dest = join(blobsDir, e.etag);
      if (written.has(e.etag)) return e.etag;
      written.add(e.etag);
      const storage = e.spec.storage ?? 'plain';
      if (storage === 'store') {
        await fs.symlink(relative(blobsDir, storeFile(key)), dest);
        const set = storeLinks.get(key) ?? new Set<string>();
        set.add(`${folderName}/blobs/${e.etag}`);
        storeLinks.set(key, set);
        return e.etag;
      }
      const first = firstHardlink.get(key);
      if (storage === 'hardlink' && first !== undefined) {
        await fs.link(first, dest);
        return e.etag;
      }
      await fs.writeFile(dest, e.content);
      if (storage === 'hardlink') firstHardlink.set(key, dest);
      if (!extra.has(key)) {
        const links: string[] = [];
        for (let n = 1; n <= (e.spec.extraLinks ?? 0); n++) {
          const p = outside(join('hardlinks', `${key}-${n}`));
          await fs.mkdir(dirname(p), { recursive: true });
          await fs.link(dest, p);
          links.push(p);
          protectedPaths.push(p);
        }
        extra.set(key, links);
      }
      return e.etag;
    };

    const commits = rp.snapshots.map((s, i) => s.commit ?? sha256Hex(`commit:${rp.id}:${i}`).slice(0, 40));
    const mtimes: Array<[string, number]> = [];
    for (const [i, sn] of rp.snapshots.entries()) {
      const commit = commits[i]!;
      const snapDir = join(folder, 'snapshots', commit);
      await fs.mkdir(snapDir, { recursive: true });
      const map = new Map<string, string>();
      linkEtags.set(`${rp.id}\0${commit}`, map);
      for (const f of sn.files) {
        const target = join(snapDir, f.path);
        if ('dir' in f) {
          await fs.mkdir(target, { recursive: true });
        } else if ('plain' in f) {
          await writeAt(target, typeof f.plain === 'number' ? contentFor(f.path, f.plain) : f.plain);
        } else if ('rawLink' in f) {
          await fs.mkdir(dirname(target), { recursive: true });
          await fs.symlink(f.rawLink, target);
        } else {
          const ref = f.blob ?? `${rp.id}:${f.path}`;
          const etag = await placeBlob(typeof ref === 'string' ? ref : ref.key);
          const depth = f.path.split('/').length;
          await fs.mkdir(dirname(target), { recursive: true });
          await fs.symlink(join('..', ...Array<string>(depth).fill('..'), 'blobs', etag), target);
          map.set(f.path, etag);
        }
      }
      mtimes.push([snapDir, sn.mtimeMs ?? BASE_MTIME_MS - i * 3_600_000]);
    }
    for (const o of rp.orphans ?? []) await placeBlob(typeof o === 'string' ? o : o.key);
    const incomplete: string[] = [];
    for (const [i, inc] of (rp.incomplete ?? []).entries()) {
      const p = join(blobsDir, `${inc.name ?? sha256Hex(`incomplete:${rp.id}:${i}`)}.incomplete`);
      await fs.writeFile(p, contentFor('incomplete', inc.bytes ?? 32));
      await setMtime(p, inc.mtimeMs ?? Date.now());
      incomplete.push(p);
    }
    for (const [name, text] of Object.entries(rp.blobsExtra ?? {})) await writeAt(join(blobsDir, name), text);

    let mainCommit: string | null = null;
    const main = rp.main === undefined ? 0 : rp.main;
    if (main !== null && typeof main === 'object') {
      await fs.writeFile(join(folder, 'refs', 'main'), main.raw);
      mainCommit = main.raw.trim() || null;
    } else if (main !== null && commits[main] !== undefined) {
      mainCommit = commits[main]!;
      await fs.writeFile(join(folder, 'refs', 'main'), mainCommit);
    }
    for (const [p, ms] of mtimes) await setMtime(p, ms); // after all contents are written

    const snapshotDir = (c?: string): string => join(folder, 'snapshots', c ?? mainCommit ?? commits[0] ?? '');
    const etagOf = (relpath: string, c?: string): string => {
      const commit = c ?? mainCommit ?? commits[0] ?? '';
      const e = linkEtags.get(`${rp.id}\0${commit}`)?.get(relpath);
      if (e === undefined) throw new Error(`${rp.id}@${commit}: ${relpath} is not a blob link`);
      return e;
    };
    const blobPath = (etag: string): string => join(blobsDir, etag);
    handles.set(rp.id, {
      id: rp.id, type, folder, folderName, commits, mainCommit, snapshotDir,
      file: (relpath, c) => join(snapshotDir(c), relpath),
      etagOf,
      blobPath,
      blobOf: (relpath, c) => blobPath(etagOf(relpath, c)),
      incomplete,
    });
  }

  // ---------- shared Xet store ----------
  const storeKeys = [...reg.entries()].filter(([, e]) => e.spec.storage === 'store').map(([k]) => k);
  if (storeKeys.length > 0 || spec.store) {
    const blobsRoot = join(hubRoot, 'blobs');
    await fs.mkdir(blobsRoot, { recursive: true });
    const marker = spec.store?.marker === undefined ? '1\n' : spec.store.marker;
    if (marker !== null) await fs.writeFile(join(blobsRoot, '.huggingface-shared-blobs'), marker);
    for (const key of storeKeys) {
      const e = entryOf(key);
      const payload = storeFile(key);
      await fs.mkdir(dirname(payload), { recursive: true });
      if (!e.spec.danglingStore) await fs.writeFile(payload, e.content);
      const refs = e.spec.refs ?? 'auto';
      const refsFile = `${payload}.refs`;
      if (refs === 'not-a-file') await fs.mkdir(refsFile, { recursive: true });
      else if (refs !== 'missing') {
        const lines = refs === 'auto'
          ? [...new Set([...(storeLinks.get(key) ?? []), ...(e.spec.refsExtra ?? [])])].sort()
          : refs;
        await fs.writeFile(refsFile, lines.map((l) => `${l}\n`).join(''));
      }
      if (e.spec.lock === 'lock') await fs.writeFile(`${payload}.lock`, '');
      else if (e.spec.lock === 'soft') await fs.writeFile(`${payload}.lock.soft`, '');
    }
  }

  const repo = (id: string): RepoHandle => {
    const h = handles.get(id);
    if (!h) throw new Error(`unknown repo ${id}`);
    return h;
  };
  const resolver: FixtureResolver = {
    hubRoot,
    etag: (key) => entryOf(key).etag,
    etagOf: (id, relpath, commit) => repo(id).etagOf(relpath, commit),
    repoBlobPath: (id, etag) => repo(id).blobPath(etag),
  };

  // ---------- views ----------
  // Each existing view root gets a protected `.hfcm-canary`: scanner/reconcile tests must ignore it.
  const viewRoots: { lmstudio: string | null; ollama: string | null } = {
    lmstudio: spec.views?.lmstudio ? join(root, 'lmstudio', 'models') : null,
    ollama: spec.views?.ollama ? join(root, 'ollama', 'models') : null,
  };
  const existingViewRoots: string[] = [];
  const viewPath = (view: 'lmstudio' | 'ollama', rel: string): string => {
    const base = viewRoots[view];
    if (base === null) throw new Error(`view ${view} is not in the spec`);
    return rel === '' ? base : join(base, ...rel.split('/'));
  };
  for (const view of ['lmstudio', 'ollama'] as const) {
    const vs = spec.views?.[view];
    const vroot = viewRoots[view];
    if (!vs || vroot === null || vs.exists === false) continue;
    existingViewRoots.push(vroot);
    await fs.mkdir(vroot, { recursive: true });
    await canaryFile(join(vroot, '.hfcm-canary'));
    for (const d of vs.dirs ?? []) await fs.mkdir(viewPath(view, d), { recursive: true });
    for (const [rel, f] of Object.entries(vs.files ?? {})) await writeAt(viewPath(view, rel), typeof f === 'function' ? f(resolver) : f);
    for (const [rel, to] of Object.entries(vs.links ?? {})) {
      const p = viewPath(view, rel);
      const text = 'raw' in to ? to.raw : resolver.repoBlobPath(to.repo, resolver.etagOf(to.repo, to.file, to.commit));
      await fs.mkdir(dirname(p), { recursive: true });
      await fs.symlink(text, p);
    }
    if (vs.state !== undefined) {
      const st = typeof vs.state === 'function' ? vs.state(resolver) : vs.state;
      const keys = Object.keys(st);
      const text = keys.length === 1 && keys[0] === 'raw' && typeof (st as { raw: unknown }).raw === 'string'
        ? (st as { raw: string }).raw
        : JSON.stringify(st, null, 1); // json.dumps(indent=1), no trailing newline; non-ASCII not escaped (use {raw} for goldens)
      await writeAt(viewPath(view, '.hfhub-state.json'), text);
    }
  }

  // ---------- config.toml ----------
  let configPath: string | null = null;
  if (spec.config) {
    configPath = join(home, '.config', 'hfhub', 'config.toml');
    let text: string;
    if ('raw' in spec.config) text = spec.config.raw;
    else {
      const q = (v: string): string => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
      const rootOf = (view: 'lmstudio' | 'ollama', v: boolean | string | undefined): string | null => {
        if (v === undefined || v === false) return null;
        if (typeof v === 'string') return v;
        const r = viewRoots[view];
        if (r === null) throw new Error(`config.${view} is true but views.${view} is not in the spec`);
        return r;
      };
      const sections: string[] = [];
      for (const view of ['lmstudio', 'ollama'] as const) {
        const r = rootOf(view, spec.config[view]);
        if (r !== null) sections.push(`[views.${view}]\nroot = ${q(r)}\n`);
      }
      const aliases = Object.entries(spec.config.aliases ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (aliases.length > 0) sections.push(`[views.ollama.aliases]\n${aliases.map(([k, v]) => `${q(k)} = ${q(v)}\n`).join('')}`);
      text = sections.join('\n');
    }
    await writeAt(configPath, text);
  }
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, HF_HUB_CACHE: hubRoot, HF_HOME: hfHome };
  if (configPath) env.HFHUB_CONFIG = configPath;

  await canary.protect(protectedPaths);

  // Reads bypass the guard (it checks the parent of a path, and root's parent is the tmp base); writes never do.
  const snapshotTree = async (): Promise<Map<string, TreeEntry>> => {
    const out = new Map<string, TreeEntry>();
    const walk = async (dir: string): Promise<void> => {
      for (const name of (await nodeFs.readdir(dir)).sort()) {
        const p = join(dir, name);
        const st = await nodeFs.lstat(p);
        const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
        const t: TreeEntry = { path: p, type, dev: st.dev, ino: st.ino, size: st.size, nlink: st.nlink };
        if (type === 'symlink') t.linkTarget = await nodeFs.readlink(p);
        if (type === 'file') t.sha256 = sha256Hex(await nodeFs.readFile(p));
        out.set(p, t);
        if (type === 'dir') await walk(p);
      }
    };
    await walk(root);
    return out;
  };

  return {
    root, hubRoot, home, hfHome, env, configPath,
    viewRoots,
    holdRoot,
    roots: { hubRoot, viewRoots: existingViewRoots, holdRoot: spec.holdRoot ? holdRoot : null },
    fs,
    canaries: protectedPaths,
    repo,
    etag: resolver.etag,
    etagOf: resolver.etagOf,
    repoBlobPath: resolver.repoBlobPath,
    xetHash: xetOf,
    storePath: storeFile,
    refsPath: (key) => `${storeFile(key)}.refs`,
    content: (key) => entryOf(key).content,
    outside,
    viewPath,
    extraLinks: (key) => extra.get(key) ?? [],
    snapshotTree,
    diskUsage: async () => {
      const seen = new Set<string>();
      let total = 0;
      for (const t of (await snapshotTree()).values()) {
        if (t.type !== 'file' || seen.has(`${t.dev}:${t.ino}`)) continue;
        seen.add(`${t.dev}:${t.ino}`);
        total += t.size;
      }
      return total;
    },
    dispose,
  };
}

export function diffTrees(
  before: Map<string, TreeEntry>,
  after: Map<string, TreeEntry>,
): { removed: string[]; added: string[]; changed: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  for (const [p, b] of before) {
    const a = after.get(p);
    if (!a) removed.push(p);
    else if (
      a.type !== b.type || a.ino !== b.ino || a.sha256 !== b.sha256 || a.linkTarget !== b.linkTarget ||
      (b.type !== 'dir' && a.size !== b.size) // directory size is nondeterministic on tmpfs
    ) changed.push(p);
  }
  for (const p of after.keys()) if (!before.has(p)) added.push(p);
  return { removed: removed.sort(), added: added.sort(), changed: changed.sort() };
}

// ---------- presets ----------
export interface QuantSpec { label: string; shards?: number; missing?: number[]; bytes?: number; dir?: string; storage?: BlobSpec['storage'] }
const SIZE_DEFAULT = 64;
const textFile = (base: string, path: string, content: string): FileSpec => ({
  path, blob: { key: `${base}:${path}`, content, etag: 'git-sha1' },
});
const weightFile = (base: string, path: string, bytes: number, storage?: BlobSpec['storage']): FileSpec => ({
  path, blob: { key: `${base}:${path}`, bytes, etag: 'sha256', ...(storage ? { storage } : {}) },
});
const pad = (n: number, w = 5): string => String(n).padStart(w, '0');

export function ggufFiles(base: string, quants: Array<string | QuantSpec>): FileSpec[] {
  const out: FileSpec[] = [];
  for (const q of quants) {
    const spec: QuantSpec = typeof q === 'string' ? { label: q } : q;
    const bytes = spec.bytes ?? SIZE_DEFAULT;
    if (spec.shards === undefined) {
      const name = `${base}-${spec.label}.gguf`;
      out.push(weightFile(base, spec.dir ? `${spec.dir}/${name}` : name, bytes, spec.storage));
      continue;
    }
    const dir = spec.dir ?? spec.label;
    for (let n = 1; n <= spec.shards; n++) {
      if (spec.missing?.includes(n)) continue;
      out.push(weightFile(base, `${dir}/${base}-${spec.label}-${pad(n)}-of-${pad(spec.shards)}.gguf`, bytes, spec.storage));
    }
  }
  return out;
}
export function mmprojFiles(base: string, labels: string[]): FileSpec[] {
  return labels.map((l) => weightFile(base, `mmproj-${l}.gguf`, SIZE_DEFAULT));
}
export function draftFiles(base: string, labels: string[], style: 'dir' | 'prefix'): FileSpec[] {
  return labels.map((l) => weightFile(base, style === 'dir' ? `MTP/${base}-${l}.gguf` : `mtp-${base}-${l}.gguf`, SIZE_DEFAULT));
}
export function diffusersFiles(
  base: string, components: string[], opts?: { pipelineClass?: string; weightBytes?: number },
): FileSpec[] {
  const wb = opts?.weightBytes ?? 256;
  const index: Record<string, unknown> = { _class_name: opts?.pipelineClass ?? 'FluxPipeline', _diffusers_version: '0.30.0' };
  for (const c of components) index[c] = ['diffusers', 'Component'];
  const out: FileSpec[] = [textFile(base, 'model_index.json', JSON.stringify(index, null, 2))];
  for (const c of components) {
    if (c.startsWith('scheduler')) out.push(textFile(base, `${c}/scheduler_config.json`, '{"_class_name":"Scheduler"}'));
    else if (c.startsWith('tokenizer')) {
      out.push(textFile(base, `${c}/tokenizer_config.json`, '{}'), textFile(base, `${c}/vocab.json`, '{}'));
    } else if (c.startsWith('text_encoder')) {
      out.push(textFile(base, `${c}/config.json`, '{"_class_name":"Component"}'), weightFile(base, `${c}/model.safetensors`, wb));
    } else {
      out.push(
        textFile(base, `${c}/config.json`, c.startsWith('vae') ? '{"_class_name":"AutoencoderKL"}' : '{"_class_name":"Component"}'),
        weightFile(base, `${c}/diffusion_pytorch_model.safetensors`, wb),
      );
    }
  }
  return out;
}
export function transformersFiles(
  base: string, opts?: { shards?: number; tokenizer?: boolean; weightBytes?: number },
): FileSpec[] {
  const shards = opts?.shards ?? 1;
  const wb = opts?.weightBytes ?? 256;
  const out: FileSpec[] = [
    textFile(base, 'config.json', '{"architectures":["LlamaForCausalLM"],"model_type":"llama"}'),
    textFile(base, 'generation_config.json', '{}'),
  ];
  if (shards > 1) {
    for (let n = 1; n <= shards; n++) out.push(weightFile(base, `model-${pad(n)}-of-${pad(shards)}.safetensors`, wb));
    out.push(textFile(base, 'model.safetensors.index.json', '{"metadata":{},"weight_map":{}}'));
  } else out.push(weightFile(base, 'model.safetensors', wb));
  if (opts?.tokenizer ?? true) {
    out.push(textFile(base, 'tokenizer.json', '{}'), textFile(base, 'tokenizer_config.json', '{}'), textFile(base, 'special_tokens_map.json', '{}'));
  }
  return out;
}
export function assetFiles(base: string): FileSpec[] {
  return [
    textFile(base, 'README.md', `# ${base}\n`),
    textFile(base, '.gitattributes', '*.gguf filter=lfs diff=lfs merge=lfs -text\n'),
    weightFile(base, 'images/example.png', 128),
  ];
}
export function ollamaBlobRel(etag: string): string { return `blobs/sha256-${etag}`; }
