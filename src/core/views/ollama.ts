// Ollama view driver, everything except `create` (injected). Deletion safety, all fail-closed:
// - every mutation goes through viewFs after a resolved containment check; a missing `ctx.expect(rel)` means the
//   path is left in place with a warning (same contract as the LM Studio driver);
// - an owned manifest is dropped only while its model layer is the owned sha (passed in from the state) AND that model's
//   blob in the view is not a regular file: a regular model blob is Ollama's own download (`ollama pull hf.co/...`), so
//   the manifest is the user's and dropping it would let Ollama garbage-collect the weights;
// - a non-symlink blob
//   named by the owned sha, or by the projector of a readable owned manifest, is a full copy and is never unlinked;
// - blobs are removed only AFTER the manifests, and only when a fresh read of every manifest left on disk (any
//   registry) proves nothing references them. One unreadable or unparseable manifest means 'unknown': every blob is kept
//   (the CLI skips such a manifest instead, which could delete a blob that manifest still uses);
// - digests are compared lower-cased, so a manifest with upper-case hex still protects its blob.
// Deviations in the safe direction: there is no `prepare_update` (the CLI unlinks owned aliases before create; here
// create overwrites them in place, so a skipped create leaves them as they were); `foreign` ignores symlinked manifests.
import { dirname, join } from 'node:path';
import { pySort } from '../compat/pyjson';
import { withinView, type OwnedEntry } from '../compat/state';
import { factsMatch, factsOf, isNotFound, readFs, type ReadFs } from '../fsx';
import { SafeFsError } from '../safe-fs';
import type { FileFacts } from '../types';
import { mmprojFor } from './entries';
import { blobRel, manifestRel, MT } from './registry';
import { viewPathProblemResolved } from './view-path';
import { SkipEntry, type ApplyCtx, type Desired, type ForeignEntry, type GgufEntry, type LinkSpec, type Presence, type ViewDriver } from './view-types';
import { linkIntoHub, removeEmptyParents, viewFs, walkTree } from './walk';

export { blobRel };

const QUANT = /(?:^|[-._])((?:UD-)?(?:IQ|Q|TQ)\d[A-Za-z0-9_]*|BF16|F16|F32|MXFP4(?:_MOE)?)$/i;
const TAG_OK = /^[A-Za-z0-9._-]+$/;

/** Python `re.sub(r"[^A-Za-z0-9._-]", "_", s)` works per code point; the `u` flag keeps that (one `_` per astral char). */
export const safeTag = (s: string): string => s.replace(/[^A-Za-z0-9._-]/gu, '_');

export function deriveTags(repoEntries: GgufEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  const byRepo = new Map<string, GgufEntry[]>();
  for (const e of repoEntries) {
    if (e.isMmproj || e.isShard) continue;
    byRepo.set(e.repoId, [...(byRepo.get(e.repoId) ?? []), e]);
  }
  for (const es of byRepo.values()) {
    for (const e of es) {
      const stem = e.basename.toLowerCase().endsWith('.gguf') ? e.basename.slice(0, -'.gguf'.length) : e.basename;
      const m = QUANT.exec(stem);
      out.set(e.key, m?.[1] !== undefined && TAG_OK.test(m[1]) ? m[1] : safeTag(e.basename));
    }
    const used = new Map<string, number>();
    for (const e of es) {
      const k = out.get(e.key)!.toLowerCase();
      used.set(k, (used.get(k) ?? 0) + 1);
    }
    for (const e of es) {
      if (used.get(out.get(e.key)!.toLowerCase())! > 1) out.set(e.key, safeTag(e.relpath.replaceAll('/', '_')));
    }
  }
  return out;
}

export function aliasManifestPath(alias: string): string {
  const i = alias.indexOf(':');
  const name = i < 0 ? alias : alias.slice(0, i);
  const tag = i < 0 ? '' : alias.slice(i + 1);
  const j = name.lastIndexOf('/');
  const ns = j < 0 ? '' : name.slice(0, j);
  const short = j < 0 ? name : name.slice(j + 1);
  return `manifests/registry.ollama.ai/${ns === '' ? 'library' : ns}/${short}/${tag === '' ? 'latest' : tag}`;
}

// ---------- manifests ----------
interface Layer { mediaType: string; digest: string }
interface Manifest { layers: Layer[]; configDigest: string | null }

const isDigest = (x: unknown): x is string => typeof x === 'string' && x.startsWith('sha256:');
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Strict parse: an object whose `layers` is an array of {mediaType, digest} strings. null when it is anything else. */
function parseManifest(text: string): Manifest | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(j) || !Array.isArray(j.layers)) return null;
  const layers: Layer[] = [];
  for (const l of j.layers as unknown[]) {
    if (!isRecord(l) || typeof l.mediaType !== 'string' || !isDigest(l.digest)) return null;
    layers.push({ mediaType: l.mediaType, digest: l.digest });
  }
  const c = j.config;
  if (c === undefined || c === null) return { layers, configDigest: null };
  if (!isRecord(c) || !isDigest(c.digest)) return null;
  return { layers, configDigest: c.digest };
}

/** Manifests above this are never read (same cap as the state file). */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** Text of a regular-file manifest, or null when its stat size exceeds the cap (checked before reading). */
export async function readManifestText(fs: ReadFs, abs: string): Promise<string | null> {
  if ((await fs.stat(abs)).size > MAX_MANIFEST_BYTES) return null;
  return fs.readFile(abs, 'utf8');
}

/** Every digest reaching here came from `parseManifest`, which requires the `sha256:` prefix. */
const hexOf = (digest: string): string => digest.slice(7).toLowerCase();

/**
 * Config plus all layer digests (hex, lower-case) of every file under `<root>/manifests/`, from a fresh read, each
 * mapped to the first manifest (`manifests/...`, walk order) that uses it. `exclude` holds absolute manifest paths that
 * are skipped unread (the ones a plan removes). Anything else not provably understood (unreadable or unparseable file,
 * a symlinked folder or dangling link) gives 'unknown'.
 */
export async function referencingManifests(
  fs: ReadFs, root: string, exclude: ReadonlySet<string> = new Set(),
): Promise<Map<string, string> | 'unknown'> {
  const out = new Map<string, string>();
  const mroot = join(root, 'manifests');
  const add = (digest: string, rel: string): void => {
    const hex = hexOf(digest);
    if (!out.has(hex)) out.set(hex, rel);
  };
  try {
    for await (const { rel, abs, facts } of walkTree(fs, mroot)) {
      if (facts.isDirectory && !facts.isSymlink) continue;
      if (exclude.has(abs)) continue;
      // Never open anything that is not provably a regular file (a FIFO would block forever).
      if (facts.isSymlink ? !(await fs.stat(abs)).isFile() : !facts.isFile) return 'unknown';
      const text = await readManifestText(fs, abs);
      const m = text === null ? null : parseManifest(text);
      if (m === null) return 'unknown';
      for (const l of m.layers) add(l.digest, `manifests/${rel}`);
      if (m.configDigest !== null) add(m.configDigest, `manifests/${rel}`);
    }
  } catch {
    return 'unknown';
  }
  return out;
}

/** The digest set of `referencingManifests` (same `exclude` and 'unknown' rules). */
export async function referencedDigests(
  fs: ReadFs, root: string, exclude?: ReadonlySet<string>,
): Promise<Set<string> | 'unknown'> {
  const m = await referencingManifests(fs, root, exclude);
  return m === 'unknown' ? m : new Set(m.keys());
}

/** CLI `is_file()`: follows symlinks; a dangling link, a directory or any error is false. */
async function isFileFollowing(fs: ReadFs, abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isFile();
  } catch {
    return false;
  }
}

/** lstat first; only a regular file is ever opened. A symlink or any other type is 'notfile' (never read, so no FIFO hang). */
async function readManifest(fs: ReadFs, abs: string): Promise<Manifest | 'missing' | 'wrong' | 'notfile'> {
  const facts = await factsOf(fs, abs);
  if (facts === null || (facts.isDirectory && !facts.isSymlink)) return 'missing';
  if (facts.isSymlink || !facts.isFile) return 'notfile';
  try {
    const text = await readManifestText(fs, abs);
    return (text === null ? null : parseManifest(text)) ?? 'wrong';
  } catch (e) {
    return isNotFound(e) ? 'missing' : 'wrong';
  }
}

const firstLayer = (m: Manifest, mediaType: string): string | undefined => m.layers.find((l) => l.mediaType === mediaType)?.digest;

/** Model and projector layer digests (hex, lower-case) of a manifest text; null when it does not parse strictly. */
export function manifestLayerHex(text: string): { model: string | null; projector: string | null } | null {
  const m = parseManifest(text);
  if (m === null) return null;
  const hex = (d: string | undefined): string | null => (d === undefined ? null : hexOf(d));
  return { model: hex(firstLayer(m, MT.model)), projector: hex(firstLayer(m, MT.projector)) };
}
const nameOf = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

/** Why a manifest whose model blob is a regular file is never removed (the review line and warning text). */
export const OLLAMA_DOWNLOAD = 'model downloaded by Ollama';

/** lstat: a regular file, not a symlink. Absent is false; any other error propagates (the caller then keeps everything). */
export async function isRegularFile(fs: ReadFs, abs: string): Promise<boolean> {
  const f = await factsOf(fs, abs);
  return f !== null && f.isFile && !f.isSymlink;
}

/**
 * The model digest (hex, lower-case) of a manifest text whose model blob in the view is a regular file, i.e. a model
 * the user downloaded with Ollama; null when the text does not parse, has no model layer, or its blob is not a regular
 * file. Such a manifest is never overwritten with another model (the weights would become garbage for Ollama).
 */
export async function pulledModel(fs: ReadFs, root: string, text: string): Promise<string | null> {
  const model = manifestLayerHex(text)?.model ?? null;
  return model !== null && (await isRegularFile(fs, join(root, 'blobs', `sha256-${model}`))) ? model : null;
}

/** A regular blob above 1 MiB is a weights-sized file, never removed. */
const MAX_SMALL_BLOB = 1048576;
const BLOB_RE = /^blobs\/sha256-([^/]+)$/;

type Status = 'ok' | 'wrong' | 'missing';

export function ollamaDriver(
  root: string, hubRoot: string, aliases: Record<string, string>,
  create: (d: Desired, ctx: ApplyCtx, prev?: OwnedEntry) => Promise<string[]>, fs: ReadFs = readFs,
): ViewDriver {
  const abs = (rel: string): string => join(root, ...rel.split('/'));

  const linkStatus = async (l: LinkSpec): Promise<{ status: Status; facts: FileFacts | null }> => {
    const facts = await factsOf(fs, abs(l.path));
    if (facts === null) return { status: 'missing', facts };
    if (facts.linkTarget !== undefined) {
      const cur = facts.linkTarget;
      return { status: cur === l.target || nameOf(cur) === nameOf(l.target) ? 'ok' : 'wrong', facts };
    }
    return { status: facts.isFile ? 'ok' : 'missing', facts };   // a regular file is Ollama's own download: adopted
  };

  const manifestStatus = async (d: Desired): Promise<Status> => {
    const o = d.ollama!;
    const m = await readManifest(fs, abs(o.manifestPath));
    if (m === 'notfile') return 'wrong';
    if (m === 'missing' || m === 'wrong') return m;
    const modelOk = firstLayer(m, MT.model) === `sha256:${d.sha256}`;
    const projOk = firstLayer(m, MT.projector) === (o.mmproj === null ? undefined : `sha256:${o.mmproj.sha256}`);
    return modelOk && projOk ? 'ok' : 'wrong';
  };

  /** Common gate of every deletion: resolved containment, then facts that still match the plan's. null = leave in place. */
  const guarded = async (rel: string, ctx: ApplyCtx, accept: (f: FileFacts) => boolean, what: string): Promise<{ p: string; expect: FileFacts } | null> => {
    const p = abs(rel);
    const problem = await viewPathProblemResolved(ctx.fs, p, root, ctx.safeFs.roots);
    if (problem !== null) {
      ctx.warnings.push(`${rel}: ${problem}; not removed`);
      return null;
    }
    const facts = await factsOf(ctx.fs, p);
    if (facts === null) return null;
    if (!accept(facts)) {
      ctx.warnings.push(`${rel}: ${what}; left in place`);
      return null;
    }
    const expect = ctx.expect(rel);
    if (expect === null || expect === undefined || !factsMatch(facts, expect)) {
      ctx.warnings.push(`${rel}: changed since preview; left in place`);
      return null;
    }
    return { p, expect };
  };

  const unlinkChecked = async (rel: string, g: { p: string; expect: FileFacts }, ctx: ApplyCtx): Promise<boolean> => {
    try {
      await viewFs(ctx.safeFs, root, ctx.fs).unlink(g.p, g.expect);
    } catch (e) {
      if (e instanceof SafeFsError && e.code !== 'IO') {
        ctx.warnings.push(`${rel}: ${e.code === 'STALE' ? 'changed since preview' : e.message}; left in place`);
        return false;
      }
      if (e instanceof SkipEntry) {
        ctx.warnings.push(`${rel}: ${e.message}; left in place`);
        return false;
      }
      throw e;
    }
    await removeEmptyParents(ctx, root, g.p);
    return true;
  };

  const notDir = (f: FileFacts): boolean => f.isSymlink || f.isFile;

  return {
    name: 'ollama',
    root,

    desired(entries: GgufEntry[], warnings: string[]): Desired[] {
      const out: Desired[] = [];
      const tags = deriveTags(entries);
      for (const e of entries) {
        if (e.isMmproj) continue;
        if (e.isShard) {
          warnings.push(`[ollama] ${e.key}: sharded GGUF not supported by Ollama; skipped`);
          continue;
        }
        const mm = mmprojFor(entries, e.repoId);
        const tag = tags.get(e.key)!;
        const manifestPath = manifestRel(e.repoId, tag);
        const links: LinkSpec[] = [{ path: blobRel(e.sha256), primary: true, target: e.blobPath }];
        if (mm !== null && blobRel(mm.sha256) !== links[0]!.path) links.push({ path: blobRel(mm.sha256), primary: false, target: mm.blobPath });
        const aliasPaths = Object.entries(aliases).filter(([, key]) => key === e.key).map(([a]) => aliasManifestPath(a));
        // A path the state file's within-view check would reject (a `..` segment) is never desired.
        const outside = [manifestPath, ...aliasPaths].find((p) => !withinView(p));
        if (outside !== undefined) {
          warnings.push(`[ollama] ${e.key}: view path ${outside} lies outside the view; skipped`);
          continue;
        }
        out.push({
          key: e.key, repoId: e.repoId, sha256: e.sha256,
          paths: pySort(new Set([...links.map((l) => l.path), manifestPath, ...aliasPaths])),
          links, ollama: { entry: e, mmproj: mm, tag, manifestPath, aliasPaths },
        });
      }
      return out;
    },

    async presence(d: Desired): Promise<Presence> {
      const o = d.ollama!;
      const links = [];
      for (const l of d.links) links.push({ l, ...(await linkStatus(l)) });
      const manifest = await manifestStatus(d);
      const statuses: Status[] = [...links.map((x) => x.status), manifest];
      for (const a of o.aliasPaths) {
        statuses.push(await isFileFollowing(fs, abs(a)) ? 'ok' : 'missing');
      }
      if (statuses.includes('wrong')) return 'wrong';
      if (manifest !== 'ok' || links.find((x) => x.l.primary)?.status !== 'ok') return 'absent';
      return statuses.every((s) => s === 'ok') ? 'correct' : 'partial';
    },

    async isStale(d: Desired, owned: OwnedEntry): Promise<boolean> {
      const m = await readManifest(fs, abs(d.ollama!.manifestPath));
      if (typeof m === 'string') return false;
      const model = firstLayer(m, MT.model);
      if (model === undefined || (model !== `sha256:${owned.sha256}` && model !== `sha256:${d.sha256}`)) return false;
      // A manifest whose model blob is a regular file is Ollama's own download; an update would overwrite it.
      if (await isRegularFile(fs, abs(blobRel(hexOf(model))))) return false;
      for (const l of d.links) {
        const { status, facts } = await linkStatus(l);
        if (status !== 'wrong') continue;
        if (facts?.linkTarget === undefined || !linkIntoHub(dirname(abs(l.path)), facts.linkTarget, hubRoot)) return false;
      }
      return true;
    },

    async foreignReason(d: Desired): Promise<string | undefined> {
      const m = await readManifest(fs, abs(d.ollama!.manifestPath));
      const model = typeof m === 'string' ? undefined : firstLayer(m, MT.model);
      if (model === undefined || !(await isRegularFile(fs, abs(blobRel(hexOf(model)))))) return undefined;
      return `${d.ollama!.manifestPath}: ${OLLAMA_DOWNLOAD}; not replaced`;
    },

    async foreign(ownedPaths: ReadonlySet<string>): Promise<ForeignEntry[]> {
      const out: ForeignEntry[] = [];
      for await (const { rel, abs: p, facts } of walkTree(fs, join(root, 'manifests'))) {
        const full = `manifests/${rel}`;
        const parts = rel.split('/');
        if (!facts.isFile || facts.isSymlink || parts.length < 2 || ownedPaths.has(full)) continue;
        let m: Manifest | null;
        try {
          const text = await readManifestText(fs, p);
          m = text === null ? null : parseManifest(text);
        } catch {
          continue;
        }
        const digest = m === null ? undefined : firstLayer(m, MT.model);
        if (digest === undefined || !digest.startsWith('sha256:') || !/^[A-Za-z0-9]+$/.test(digest.slice(7))) continue;
        const blob = await factsOf(fs, abs(blobRel(digest.slice(7))));
        if (blob === null || !blob.isFile || blob.isSymlink) continue;
        out.push({ key: `ollama:${parts.slice(0, -1).join('/')}:${parts[parts.length - 1]}`, path: full, target: blobRel(digest.slice(7)) });
      }
      return out;
    },

    create,

    async remove(paths: string[], ctx: ApplyCtx, sha256: string): Promise<string[]> {
      const removed: string[] = [];
      const owned = sha256.toLowerCase();                 // the owned key's model sha, from the state (never inferred)
      const manifests = paths.filter((r) => r.startsWith('manifests/'));
      const rest = paths.filter((r) => !r.startsWith('manifests/'));
      const projectors = new Set<string>();              // projector digests of the owned manifests still readable
      for (const rel of manifests) {
        const g = await guarded(rel, ctx, (f) => f.isFile && !f.isSymlink, 'not a regular file');
        if (g === null) continue;
        const m = await readManifest(ctx.fs, g.p).catch(() => 'wrong' as const);
        if (typeof m === 'string') {
          ctx.warnings.push(`${rel}: manifest unreadable; left in place`);
          continue;
        }
        const proj = firstLayer(m, MT.projector);
        if (proj !== undefined) projectors.add(hexOf(proj));
        const model = firstLayer(m, MT.model);
        if (model === undefined || hexOf(model) !== owned) {
          ctx.warnings.push(`${rel}: manifest changed by Ollama; left in place`);
          continue;
        }
        if (await isRegularFile(ctx.fs, abs(blobRel(owned)))) {
          ctx.warnings.push(`${rel}: ${OLLAMA_DOWNLOAD}; left in place`);
          continue;
        }
        if (await unlinkChecked(rel, g, ctx)) removed.push(rel);
      }
      let referenced: Set<string> | 'unknown' | null = null;
      let warnedUnknown = false;
      for (const rel of rest) {
        const m = BLOB_RE.exec(rel);
        if (m !== null) {
          referenced ??= await referencedDigests(ctx.fs, root);
          if (referenced === 'unknown') {
            if (!warnedUnknown) ctx.warnings.push('unreadable manifest on disk; blobs kept');
            warnedUnknown = true;
            continue;
          }
          if (referenced.has(m[1]!.toLowerCase())) continue;   // still used by a manifest: keep, silently
          const g = await guarded(rel, ctx, notDir, 'not a file');
          if (g === null) continue;
          if (!g.expect.isSymlink && (g.expect.size > MAX_SMALL_BLOB || m[1]!.toLowerCase() === owned || projectors.has(m[1]!.toLowerCase()))) {
            ctx.warnings.push(`${rel}: regular file copy of the model; left in place`);
            continue;
          }
          if (await unlinkChecked(rel, g, ctx)) removed.push(rel);
          continue;
        }
        const g = await guarded(rel, ctx, (f) => f.isSymlink, 'not a symlink');
        if (g !== null && (await unlinkChecked(rel, g, ctx))) removed.push(rel);
      }
      return removed;
    },
  };
}

