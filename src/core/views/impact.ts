// The real ViewImpactProvider: when cached files are deleted, the ops and review lines that clean the LM
// Studio and Ollama views the way a later `hf-xfer sync` prune would. Read-only: it plans, the executor applies.
// Prune semantics only: never tombstones, never creates. Every rule fails closed (an entry is kept and reported):
// - Hub guard: a missing hub, or one without repos, gives a `blocked` line per enabled view and no ops at all.
// - Overlapping view folders (equal realpaths, or one inside the other) block both views, no ops (same rule as sync).
// - A view is planned whole or not at all (V18): its ops are collected locally and kept only when the view completes.
//   A state error (V19 included), a path problem or any unexpected error gives one `blocked` line and no ops.
// - Every op path is built from the realpath'd view root (V17) and passes viewPathProblem and viewPathProblemResolved.
// - Ownership is the state file: only paths an owned key lists are removed, minus paths a surviving key still lists.
// - LM Studio: only symlinks are unlinked; a regular file at an owned path is reported and kept.
// - Ollama: an owned manifest is unlinked only while it is a regular file whose model layer is the owned key's sha256
//   and whose model blob in the view is not a regular file (a regular model blob is Ollama's own download, so the
//   manifest is the user's; removing it would let Ollama garbage-collect the weights).
//   A blob goes only when no manifest left on disk (any registry, after the planned manifest removals) references it;
//   one unreadable manifest keeps every blob. A manifest counts as ours while its model layer is the sha256 of any
//   dropped key that lists it. A non-symlink blob named by an owned sha256, any etag in the cache model, or a
//   projector of the manifests read, or any regular blob above 1 MiB, is a copy of model data and never unlinked.
// - The scan for unowned links to doomed blobs is informational: a folder it cannot read adds a note line only.
// V21 (accepted deviation): an Ollama key with any owned blob link resolving to a doomed blob (typically the shared
//   projector) is dropped entirely (a delete plan cannot rewrite manifests); its lines say so and the next CLI sync
//   re-creates those tags.
// V22 (accepted residual race): referenced digests are read at plan time; the executor revalidates only the op targets.
//   An `ollama pull` inside the 10-minute review window could add a manifest that shares a small layer (template,
//   license) we then unlink; that layer is re-pulled. Config blobs are unique to our own manifests. A stale plan is
//   planned again.
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { HfhubConfig } from '../compat/config';
import { pyCompare, pySort } from '../compat/pyjson';
import { loadState, serializeState, STATE_FILE, StateError, type ViewState } from '../compat/state';
import { factsOf, isNotFound, readFs, type ReadFs } from '../fsx';
import { holdRootFor } from '../hold/hold-root';
import { isStrictlyInside, normalizeLinkText } from '../paths';
import type { CacheModel, FileFacts, Op, SafeRoots, ViewImpactLine, ViewImpactProvider, ViewName } from '../types';
import { isRegularFile, manifestLayerHex, OLLAMA_DOWNLOAD, readManifestText, referencingManifests } from './ollama';
import { removablePaths } from './reconcile';
import { VIEW_ROOTS_OVERLAP, viewPathProblem, viewPathProblemResolved, viewRootsOverlap } from './view-path';
import { walkTree } from './walk';

const VIEWS: readonly ViewName[] = ['lmstudio', 'ollama'];
const HUB_NOTE = 'hub not found or has no repos; view links are not cleaned';
const NOT_CLEANED = 'view links not cleaned';
const DANGLE = 'not created by sync; left in place and will dangle';
const COPY = 'regular file copy of the model in Ollama; left in place';
const LINKS_DELETED = 'a blob link of this entry points at a deleted file';
/** A regular blob above this is weights-sized and never removed (same bound as the Ollama driver). */
const MAX_SMALL_BLOB = 1048576;
const BLOB_RE = /^blobs\/sha256-([^/]+)$/;

/** A view that cannot be cleaned; becomes its one `blocked` line. */
class Blocked extends Error {
  constructor(readonly rel: string, readonly note: string) {
    super(note);
    this.name = 'Blocked';
  }
}

type UnlinkOp = Extract<Op, { kind: 'unlink' }>;
interface Planned { manifests: UnlinkOp[]; unlinks: UnlinkOp[]; lines: ViewImpactLine[]; newState: ViewState; dropped: number; updated: number }

interface Ctx {
  view: ViewName;
  root: string;               // realpath of the view root
  roots: SafeRoots;
  fs: ReadFs;
  model: CacheModel;
  doomed: ReadonlySet<string>;
}

const absOf = (root: string, rel: string): string => join(root, ...rel.split('/'));
const repoIdOf = (key: string): string => (key.includes(':') ? key.slice(0, key.indexOf(':')) : key);
const segments = (p: string): number => p.split(sep).length;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Does the owned key's own model blob (`repo.blobs[sha256].path`, V17) belong to the doomed set? A repo absent from the model is not doomed. */
function modelDoomed(ctx: Ctx, key: string, sha256: string): boolean {
  const repo = ctx.model.repos.find((r) => r.type === 'model' && r.id === repoIdOf(key));
  if (!repo || !Object.hasOwn(repo.blobs, sha256)) return false;
  return ctx.doomed.has(repo.blobs[sha256]!.path);
}

/**
 * Does the link at `linkAbs` (one hop, text `target`) name a doomed repo blob? Tried lexically from the link's folder,
 * from that folder's realpath, and each with the target's folder realpath'd (RepoBlob.path has its folder realpath'd,
 * the leaf not). More matches only report or remove links that would dangle anyway.
 */
async function resolvesToDoomed(ctx: Ctx, linkAbs: string, target: string): Promise<boolean> {
  const text = normalizeLinkText(target);
  const first = [resolve(dirname(linkAbs), text)];
  try {
    first.push(resolve(await ctx.fs.realpath(dirname(linkAbs)), text));
  } catch { /* unresolvable folder: lexical only */ }
  const all = [...first];
  for (const c of first) {
    try {
      all.push(join(await ctx.fs.realpath(dirname(c)), basename(c)));
    } catch { /* the blob folder is gone or unreadable */ }
  }
  return all.some((c) => ctx.doomed.has(c));
}

/** Lexical and resolved containment; anything else blocks the whole view. */
async function checkPath(ctx: Ctx, p: string, rel: string): Promise<void> {
  const problem = viewPathProblem(p, ctx.root, ctx.roots) ?? (await viewPathProblemResolved(ctx.fs, p, ctx.root, ctx.roots));
  if (problem !== null) throw new Blocked(rel, `${problem}; ${NOT_CLEANED}`);
}

async function unlinkOp(ctx: Ctx, rel: string, facts: FileFacts, role: UnlinkOp['role']): Promise<UnlinkOp> {
  const p = absOf(ctx.root, rel);
  await checkPath(ctx, p, rel);
  return { kind: 'unlink', path: p, expect: facts, role };
}

/** removablePaths against the state after the change; one keep-shared line per kept path. */
function split(ctx: Ctx, key: string, candidates: string[], newState: ViewState, lines: ViewImpactLine[]): string[] {
  const { remove, keepShared } = removablePaths(key, candidates, newState);
  for (const k of keepShared) lines.push({ view: ctx.view, path: k.path, action: 'keep-shared', key, note: `also owned by ${k.owners.join(', ')}` });
  return remove;
}

/** path -> first key (code-point order) that removes it. */
function firstOwners(entries: Array<[string, string[]]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, paths] of [...entries].sort((a, b) => pyCompare(a[0], b[0]))) {
    for (const p of paths) if (!out.has(p)) out.set(p, key);
  }
  return out;
}

async function planLmstudio(ctx: Ctx, state: ViewState): Promise<Planned> {
  const lines: ViewImpactLine[] = [];
  const keys = pySort(Object.keys(state.owned));
  const doomedKeys = new Set(keys.filter((k) => modelDoomed(ctx, k, state.owned[k]!.sha256)));
  // A surviving key loses only its symlinks that resolve to a doomed blob (an mmproj-only delete).
  const lost = new Map<string, string[]>();
  for (const k of keys) {
    if (doomedKeys.has(k)) continue;
    const gone: string[] = [];
    for (const rel of state.owned[k]!.paths) {
      const f = await factsOf(ctx.fs, absOf(ctx.root, rel));
      if (f?.linkTarget !== undefined && (await resolvesToDoomed(ctx, absOf(ctx.root, rel), f.linkTarget))) gone.push(rel);
    }
    if (gone.length > 0) lost.set(k, gone);
  }
  const owned: ViewState['owned'] = {};
  for (const k of keys) {
    if (doomedKeys.has(k)) continue;
    const o = state.owned[k]!;
    const gone = lost.get(k);
    owned[k] = gone === undefined ? o : { paths: o.paths.filter((p) => !gone.includes(p)), sha256: o.sha256 };
  }
  const newState: ViewState = { version: 1, owned, tombstones: state.tombstones };
  const removals: Array<[string, string[]]> = [];
  for (const k of keys) {
    const candidates = doomedKeys.has(k) ? state.owned[k]!.paths : lost.get(k);
    if (candidates !== undefined) removals.push([k, split(ctx, k, candidates, newState, lines)]);
  }
  const unlinks: UnlinkOp[] = [];
  for (const [rel, key] of [...firstOwners(removals)].sort((a, b) => pyCompare(a[0], b[0]))) {
    const f = await factsOf(ctx.fs, absOf(ctx.root, rel));
    if (f === null) continue;
    if (!f.isSymlink) {
      lines.push({ view: ctx.view, path: rel, action: 'foreign', key, note: 'regular file at an owned path; left in place' });
      continue;
    }
    unlinks.push(await unlinkOp(ctx, rel, f, 'view-link'));
    lines.push({ view: ctx.view, path: rel, action: 'remove', key });
  }
  return { manifests: [], unlinks, lines, newState, dropped: doomedKeys.size, updated: lost.size };
}

async function planOllama(ctx: Ctx, state: ViewState): Promise<Planned> {
  const lines: ViewImpactLine[] = [];
  const keys = pySort(Object.keys(state.owned));
  const doomedKeys = new Set<string>();
  const viaLink = new Set<string>();
  for (const k of keys) {
    const o = state.owned[k]!;
    if (modelDoomed(ctx, k, o.sha256)) {
      doomedKeys.add(k);
      continue;
    }
    for (const rel of o.paths) {
      if (!BLOB_RE.test(rel)) continue;
      const f = await factsOf(ctx.fs, absOf(ctx.root, rel));
      if (f?.linkTarget !== undefined && (await resolvesToDoomed(ctx, absOf(ctx.root, rel), f.linkTarget))) {
        doomedKeys.add(k);
        viaLink.add(k);
        break;
      }
    }
  }
  const owned: ViewState['owned'] = {};
  for (const k of keys) if (!doomedKeys.has(k)) owned[k] = state.owned[k]!;
  const newState: ViewState = { version: 1, owned, tombstones: state.tombstones };
  const removals: Array<[string, string[]]> = [];
  for (const k of keys) if (doomedKeys.has(k)) removals.push([k, split(ctx, k, state.owned[k]!.paths, newState, lines)]);
  const byPath = [...firstOwners(removals)].sort((a, b) => pyCompare(a[0], b[0]));
  const note = (key: string): { note?: string } => (viaLink.has(key) ? { note: LINKS_DELETED } : {});
  const remove = (rel: string, key: string): void => { lines.push({ view: ctx.view, path: rel, action: 'remove', key, ...note(key) }); };
  const keep = (rel: string, key: string, why: string, action: 'foreign' | 'keep-shared' = 'foreign'): void => {
    lines.push({ view: ctx.view, path: rel, action, key, note: why });
  };

  // Protection: digests that are model data (owned shas, doomed etags, projectors of the manifests read).
  const modelData = new Set<string>(Object.values(state.owned).map((o) => o.sha256.toLowerCase()));
  for (const d of ctx.doomed) modelData.add(basename(d).toLowerCase());
  for (const r of ctx.model.repos) for (const etag of Object.keys(r.blobs)) modelData.add(etag.toLowerCase());

  const manifests: UnlinkOp[] = [];
  for (const [rel, key] of byPath) {
    if (!rel.startsWith('manifests/')) continue;
    const p = absOf(ctx.root, rel);
    const f = await factsOf(ctx.fs, p);
    if (f === null) continue;
    if (!f.isFile || f.isSymlink) {
      keep(rel, key, 'not a regular file; left in place');
      continue;
    }
    let layers: ReturnType<typeof manifestLayerHex> = null;
    try {
      const text = await readManifestText(ctx.fs, p);
      layers = text === null ? null : manifestLayerHex(text);
    } catch { /* unreadable: left in place below */ }
    if (layers === null) {
      keep(rel, key, 'manifest unreadable; left in place');
      continue;
    }
    if (layers.projector !== null) modelData.add(layers.projector);
    // Ours while it still names the model of ANY dropped key that lists it (a manifest can be listed by several).
    const shas = [...doomedKeys].filter((k) => state.owned[k]!.paths.includes(rel)).map((k) => state.owned[k]!.sha256.toLowerCase());
    if (layers.model === null || !shas.includes(layers.model)) {
      keep(rel, key, 'manifest changed by Ollama; left in place');
      continue;
    }
    if (await isRegularFile(ctx.fs, absOf(ctx.root, `blobs/sha256-${layers.model}`))) {
      keep(rel, key, `${OLLAMA_DOWNLOAD}; left in place`);
      continue;
    }
    manifests.push(await unlinkOp(ctx, rel, f, 'view-manifest'));
    remove(rel, key);
  }

  const rest = byPath.filter(([rel]) => !rel.startsWith('manifests/'));
  const refs = rest.some(([rel]) => BLOB_RE.test(rel))
    ? await referencingManifests(ctx.fs, ctx.root, new Set(manifests.map((m) => m.path)))
    : new Map<string, string>();
  const unlinks: UnlinkOp[] = [];
  for (const [rel, key] of rest) {
    const m = BLOB_RE.exec(rel);
    const hex = m === null ? null : m[1]!.toLowerCase();
    if (hex !== null) {
      if (refs === 'unknown') {
        keep(rel, key, 'a manifest is unreadable; blobs kept', 'keep-shared');
        continue;
      }
      const by = refs.get(hex);
      if (by !== undefined) {
        keep(rel, key, `referenced by manifest ${by}`, 'keep-shared');
        continue;
      }
    }
    const f = await factsOf(ctx.fs, absOf(ctx.root, rel));
    if (f === null) continue;
    if (f.isSymlink) {
      unlinks.push(await unlinkOp(ctx, rel, f, 'view-link'));
      remove(rel, key);
    } else if (hex !== null && f.isFile) {
      if (f.size > MAX_SMALL_BLOB || modelData.has(hex)) {
        keep(rel, key, COPY);
        continue;
      }
      unlinks.push(await unlinkOp(ctx, rel, f, 'view-blob'));
      remove(rel, key);
    } else {
      keep(rel, key, 'not a symlink; left in place');
    }
  }
  return { manifests, unlinks, lines, newState, dropped: doomedKeys.size, updated: 0 };
}

/**
 * Folders (strictly inside the root) that are empty once `removed` are gone, deepest first, from a live readdir. A
 * folder is a candidate only while it and every folder up to the root is a real directory (the executor refuses an
 * rmdir-empty of a symlink or under one).
 */
async function emptiedDirs(ctx: Ctx, removed: readonly string[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const p of removed) {
    for (let d = dirname(p); d !== ctx.root && isStrictlyInside(d, ctx.root); d = dirname(d)) dirs.add(d);
  }
  const real = new Set<string>();
  for (const d of dirs) {
    const f = await factsOf(ctx.fs, d);
    if (f !== null && f.isDirectory && !f.isSymlink) real.add(d);
  }
  const chainReal = (d: string): boolean => {
    for (let x = d; x !== ctx.root; x = dirname(x)) if (!real.has(x)) return false;
    return true;
  };
  const gone = new Set(removed);
  const out: string[] = [];
  for (const d of [...dirs].sort((a, b) => segments(b) - segments(a) || pyCompare(a, b))) {
    if (!chainReal(d)) continue;
    const names = await ctx.fs.readdir(d);
    if (names.every((n) => gone.has(join(d, n)))) {
      out.push(d);
      gone.add(d);
    }
  }
  return out;
}

/** Unowned links that point at a doomed blob: reported, never touched. Read last, after the view's ops are planned. */
async function foreignLinks(ctx: Ctx, state: ViewState): Promise<ViewImpactLine[]> {
  const ownedPaths = new Set(Object.values(state.owned).flatMap((o) => o.paths));
  const out: ViewImpactLine[] = [];
  const lm = ctx.view === 'lmstudio';
  const base = lm ? ctx.root : join(ctx.root, 'blobs');
  try {
    for await (const { rel: r, abs, facts } of walkTree(ctx.fs, base, (x) => lm && x === STATE_FILE)) {
      const rel = lm ? r : `blobs/${r}`;
      if (facts.linkTarget === undefined || ownedPaths.has(rel)) continue;
      if (lm ? !(process.platform === 'win32' ? rel.toLowerCase() : rel).endsWith('.gguf') : !/^blobs\/sha256-[^/]+$/.test(rel)) continue;
      if (await resolvesToDoomed(ctx, abs, facts.linkTarget)) out.push({ view: ctx.view, path: rel, action: 'foreign', note: DANGLE });
    }
  } catch (e) {
    // Informational scan only: a folder it cannot read never stops the view's own cleanup.
    out.push({ view: ctx.view, path: '', action: 'foreign', note: `other links to deleted files not checked: ${errText(e)}` });
  }
  return out;
}

async function isDir(fs: ReadFs, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch (e) {
    if (isNotFound(e) || (e as NodeJS.ErrnoException | null)?.code === 'ENOTDIR') return false;
    throw e;
  }
}

/** One view, all or nothing: throws Blocked (or anything else) instead of returning a partial result. */
async function planView(view: ViewName, configured: string, model: CacheModel, doomed: ReadonlySet<string>, fs: ReadFs):
  Promise<{ ops: Op[]; lines: ViewImpactLine[] }> {
  if (!(await isDir(fs, configured))) return { ops: [], lines: [] };
  const root = await fs.realpath(configured);
  const ctx: Ctx = { view, root, fs, model, doomed, roots: { hubRoot: model.hubRoot, viewRoots: [root], holdRoot: holdRootFor(model.hubRoot) } };
  const { raw, state } = await loadState(root, fs);   // StateError (V19 included): blocked by the caller
  const planned = view === 'lmstudio' ? await planLmstudio(ctx, state) : await planOllama(ctx, state);
  const unlinks = [...planned.manifests, ...planned.unlinks];
  const ops: Op[] = [...unlinks];
  for (const d of await emptiedDirs(ctx, unlinks.map((o) => o.path))) {
    await checkPath(ctx, d, d.slice(root.length + 1).split(sep).join('/'));
    ops.push({ kind: 'rmdir-empty', path: d });
  }
  const lines = [...planned.lines];
  const after = serializeState(planned.newState);
  if (raw !== null && planned.dropped + planned.updated > 0 && after !== raw) {
    const statePath = join(root, STATE_FILE);
    await checkPath(ctx, statePath, STATE_FILE);
    ops.push({ kind: 'write-file', path: statePath, before: raw, after, role: 'view-state' });
    lines.push({ view, path: STATE_FILE, action: 'state-update', note: `drop ${planned.dropped} keys, update ${planned.updated}` });
  }
  lines.push(...(await foreignLinks(ctx, state)));
  return { ops, lines };
}

export function createViewImpactProvider(config: HfhubConfig, fs: ReadFs = readFs): ViewImpactProvider {
  return {
    async impactFor(model: CacheModel, doomedRepoBlobPaths: string[]): Promise<{ ops: Op[]; lines: ViewImpactLine[] }> {
      const enabled = VIEWS.filter((v) => config.views[v].root !== null);
      const blocked = (view: ViewName, path: string, note: string): ViewImpactLine => ({ view, path, action: 'blocked', note });
      let hubOk: boolean;
      try {
        hubOk = (await fs.lstat(model.hubRoot)).isDirectory() && model.repos.length > 0;
      } catch {
        hubOk = false;
      }
      if (!hubOk) return { ops: [], lines: enabled.map((v) => blocked(v, '', HUB_NOTE)) };
      if (await viewRootsOverlap(fs, enabled.map((v) => config.views[v].root))) {   // never rejects
        return { ops: [], lines: enabled.map((v) => blocked(v, '', VIEW_ROOTS_OVERLAP)) };
      }
      const doomed = new Set(doomedRepoBlobPaths);
      const ops: Op[] = [];
      const lines: ViewImpactLine[] = [];
      for (const view of enabled) {
        try {
          const r = await planView(view, config.views[view].root!, model, doomed, fs);
          ops.push(...r.ops);
          lines.push(...r.lines);
        } catch (e) {
          lines.push(e instanceof Blocked ? blocked(view, e.rel, e.note)
            : e instanceof StateError ? blocked(view, STATE_FILE, `state file unreadable: ${e.message}; ${NOT_CLEANED}`)
              : blocked(view, '', `unexpected error: ${errText(e)}; ${NOT_CLEANED}`));
        }
      }
      return { ops, lines };
    },
  };
}
