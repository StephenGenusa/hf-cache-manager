// Ollama `create` (hfhub/views/ollama.py `create`, hfhub/ollama_registry.py `patch_manifest`,
// `synth_manifest`, `_finish`). Manifests and the config blob are written byte-identical to the CLI's: compact JSON,
// ensure_ascii, insertion order (Maps from pyLoads), and the config digest is the sha256 of exactly those bytes.
//
// All-or-nothing: Phase A does everything that can throw SkipEntry (collisions, registry and GGUF reads, blob digests,
// every precondition of every write, every mkdirp) and writes nothing to the view except the registry cache the
// CLI also writes. Phase B then only writes. Deviation (V20): a symlink or directory where a file must be written is a
// SkipEntry (the CLI writes through it). Deviation: colliding registry-cache basenames are skipped with a
// warning, never written; the CLI synthesises both entries. Covered by unit tests, deliberately not by a golden case.
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isPyMap, pyDumpsCompact, pyLoads, pySort, type PyJson } from '../compat/pyjson';
import { factsMatch, factsOf, isNotFound } from '../fsx';
import { SafeFsError } from '../safe-fs';
import type { OwnedEntry } from '../compat/state';
import type { FileFacts } from '../types';
import type { GgufHeader } from './gguf-header';
import { fileTypeName, sizeLabel } from './gguf-header';
import { OLLAMA_DOWNLOAD, pulledModel, readManifestText } from './ollama';
import { blobRel, MT, registryBlob, registryConfig, registryManifest, type RegistryCtx } from './registry';
import { CreateIncomplete, SkipEntry, type ApplyCtx, type Desired } from './view-types';
import { ensureParent, linkIntoHub, viewFs } from './walk';

export interface LayerRef { sha256: string; size: number }

const SHA_DIGEST = /^sha256:[0-9a-f]{64}$/;

const deepClone = (v: PyJson): PyJson => {
  if (Array.isArray(v)) return v.map(deepClone);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, deepClone(x)] as [string, PyJson]));
  return v;
};

const layerMap = (ref: LayerRef, mediaType: string): Map<string, PyJson> =>
  new Map<string, PyJson>([['digest', `sha256:${ref.sha256}`], ['mediaType', mediaType], ['size', ref.size]]);

/** The manifest's `layers` as Maps with a string mediaType; anything else is a registry response we cannot patch. */
function layersOf(manifest: Map<string, PyJson>): Array<Map<string, PyJson>> {
  const layers = manifest.get('layers');
  if (!Array.isArray(layers)) throw new SkipEntry('registry manifest has no layers array; skipped');
  return layers.map((l) => {
    if (!isPyMap(l) || typeof l.get('mediaType') !== 'string') throw new SkipEntry('registry manifest has a malformed layer; skipped');
    return l;
  });
}

/** The registry's layers other than the model and projector (`small_layers`), digests checked to be `sha256:<64 hex>`. */
export function smallLayers(manifest: Map<string, PyJson>): Array<{ digest: string; layer: Map<string, PyJson> }> {
  return layersOf(manifest).filter((l) => l.get('mediaType') !== MT.model && l.get('mediaType') !== MT.projector).map((layer) => {
    const digest = layer.get('digest');
    if (typeof digest !== 'string' || !SHA_DIGEST.test(digest)) throw new SkipEntry(`registry layer digest ${String(digest)} is not sha256:<64 hex>; skipped`);
    return { digest, layer };
  });
}

/**
 * The registry manifest with our model layer (and projector) swapped in: the model layer is replaced in place, a registry
 * projector is replaced or dropped, and a new projector is inserted at index 1. Other layers are copied. Config is untouched.
 */
export function patchManifest(reg: Map<string, PyJson>, model: LayerRef, projector: LayerRef | null): Map<string, PyJson> {
  const m = deepClone(reg) as Map<string, PyJson>;
  const layers: PyJson[] = [];
  let seenProjector = false;
  for (const l of layersOf(m)) {
    const mediaType = l.get('mediaType');
    if (mediaType === MT.model) layers.push(layerMap(model, MT.model));
    else if (mediaType === MT.projector) {
      seenProjector = true;
      if (projector !== null) layers.push(layerMap(projector, MT.projector));
    } else layers.push(new Map(l));
  }
  if (projector !== null && !seenProjector) layers.splice(1, 0, layerMap(projector, MT.projector));
  m.set('layers', layers);
  return m;
}

/** Python `str(v)` for the scalar kinds a GGUF architecture can plausibly be. */
const pyStr = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return 'unknown';
};

/** The manifest and config of a model Ollama has no registry entry for, built from the GGUF header. */
export function synthesise(h: GgufHeader, model: LayerRef, projector: LayerRef | null): { manifest: Map<string, PyJson>; config: Map<string, PyJson> } {
  const arch = pyStr(h.kv.get('general.architecture') ?? 'unknown');
  const ft = h.kv.get('general.file_type');
  const isInt = typeof ft === 'number' || typeof ft === 'bigint' || typeof ft === 'boolean';
  const config = new Map<string, PyJson>([
    ['model_format', 'gguf'], ['model_family', arch], ['model_families', [arch]], ['model_type', sizeLabel(h.paramCount)],
    ['file_type', isInt ? fileTypeName(ft) : 'unknown'], ['architecture', 'amd64'], ['os', 'linux'],
  ]);
  const layers: PyJson[] = [layerMap(model, MT.model)];
  if (projector !== null) layers.push(layerMap(projector, MT.projector));
  const manifest = new Map<string, PyJson>([['schemaVersion', 2], ['mediaType', MT.manifest], ['layers', layers]]);
  return { manifest, config };
}

/**
 * Sets config.rootfs (`type`, `diff_ids` in place, creating `rootfs` last when absent), serialises it, and points the
 * manifest's `config` at those bytes. Inputs are not modified.
 */
export function finish(manifest: Map<string, PyJson>, config: Map<string, PyJson>): { manifestText: string; cfgBytes: Uint8Array; cfgDigest: string } {
  const m = deepClone(manifest) as Map<string, PyJson>;
  const c = deepClone(config) as Map<string, PyJson>;
  const layers = m.get('layers');
  if (!Array.isArray(layers)) throw new SkipEntry('manifest has no layers array; skipped');
  const digests = layers.map((l) => {
    const d = isPyMap(l) ? l.get('digest') : undefined;
    if (typeof d !== 'string') throw new SkipEntry('manifest layer has no digest; skipped');
    return d;
  });
  if (!c.has('rootfs')) c.set('rootfs', new Map<string, PyJson>());
  const rootfs = c.get('rootfs');
  if (!isPyMap(rootfs)) throw new SkipEntry('registry config rootfs is not an object; skipped');
  rootfs.set('type', 'layers');
  rootfs.set('diff_ids', digests);
  const cfgBytes = new TextEncoder().encode(pyDumpsCompact(c));
  const cfgDigest = `sha256:${createHash('sha256').update(cfgBytes).digest('hex')}`;
  m.set('config', new Map<string, PyJson>([['digest', cfgDigest], ['mediaType', MT.config], ['size', cfgBytes.length]]));
  return { manifestText: pyDumpsCompact(m), cfgBytes, cfgDigest };
}

/**
 * What to do with an existing alias manifest (hfhub/views/ollama.py `_alias_action`): `skip` when it is already exactly our
 * text, `write` when it is parseable and its model layer is `ourModelDigest` (`sha256:<hex>`) or, on an update of a key
 * that owns this alias, `prevModelDigest` (the model the key owned before), else `refuse`.
 */
export function aliasAction(existingText: string, manifestText: string, ourModelDigest: string, prevModelDigest: string | null = null): 'write' | 'skip' | 'refuse' {
  if (existingText === manifestText) return 'skip';
  let parsed: PyJson;
  try {
    parsed = pyLoads(existingText);
  } catch {
    return 'refuse';
  }
  if (!isPyMap(parsed)) return 'refuse';
  const layers = parsed.get('layers');
  if (!Array.isArray(layers)) return 'refuse';
  for (const l of layers) {
    if (!isPyMap(l)) return 'refuse';
    if (l.get('mediaType') === MT.model) {
      const digest = l.get('digest');
      return digest === ourModelDigest || (prevModelDigest !== null && digest === prevModelDigest) ? 'write' : 'refuse';
    }
  }
  return 'refuse';
}

export interface OllamaCreateDeps {
  registry: Omit<RegistryCtx, 'safeFs'>;
  hubRoot: string;
  readGguf: (abs: string) => Promise<GgufHeader>;
  /** `registryCollisions(entries)`: key -> warning. Colliding keys are never written. */
  collisions: Map<string, string>;
}

type LinkPlan = { path: string; rel: string; target: string; action: 'keep' | 'create' | 'replace'; expect: FileFacts | null };

export function makeOllamaCreate(deps: OllamaCreateDeps): (d: Desired, ctx: ApplyCtx, prev?: OwnedEntry) => Promise<string[]> {
  const root = deps.registry.root;
  const abs = (rel: string): string => join(root, ...rel.split('/'));
  const decoder = new TextDecoder('utf-8', { fatal: true });

  return async (d, ctx, prev) => {
    const o = d.ollama;
    if (o === undefined) throw new Error(`${d.key}: not an Ollama entry`);
    const collision = deps.collisions.get(d.key);
    if (collision !== undefined) throw new SkipEntry(`registry cache key collision: ${collision}`);
    const rctx: RegistryCtx = { ...deps.registry, safeFs: ctx.safeFs };
    const { repoId, relpath } = o.entry;
    const model: LayerRef = { sha256: o.entry.sha256, size: o.entry.size };
    const projector: LayerRef | null = o.mmproj === null ? null : { sha256: o.mmproj.sha256, size: o.mmproj.size };

    // ---- Phase A: nothing below writes to the view ----
    const small: Array<{ rel: string; bytes: Uint8Array | null }> = [];   // bytes null = already on disk
    let manifest: Map<string, PyJson>;
    let cfgBytes: Uint8Array;
    let cfgDigest: string;
    let manifestText: string;
    const reg = await registryManifest(rctx, repoId, relpath);
    if (reg !== null) {
      const layers = smallLayers(reg);
      const configRef = reg.get('config');
      const configDigest = isPyMap(configRef) ? configRef.get('digest') : undefined;
      if (typeof configDigest !== 'string') throw new SkipEntry(`${repoId}: registry manifest has no config digest; skipped`);
      const raw = await registryConfig(rctx, repoId, relpath, configDigest);
      let parsed: PyJson;
      try {
        parsed = pyLoads(raw.length === 0 ? '{}' : decoder.decode(raw));   // a cached empty config counts as {}
      } catch {
        throw new SkipEntry(`${repoId}: registry config is not valid JSON; skipped`);
      }
      if (!isPyMap(parsed)) throw new SkipEntry(`${repoId}: registry config is not an object; skipped`);
      const seen = new Set<string>();
      for (const { digest } of layers) {
        const rel = blobRel(digest.slice(7));
        if (seen.has(rel)) continue;
        seen.add(rel);
        small.push({ rel, bytes: (await existsFollowing(ctx, abs(rel))) ? null : await registryBlob(rctx, repoId, digest) });
      }
      manifest = patchManifest(reg, model, projector);
      ({ manifestText, cfgBytes, cfgDigest } = finish(manifest, parsed));
    } else {
      let header: GgufHeader;
      try {
        header = await deps.readGguf(o.entry.blobPath);
      } catch (e) {
        throw new SkipEntry(`${d.key}: cannot read the GGUF header (${e instanceof Error ? e.message : String(e)}); skipped`);
      }
      const synth = synthesise(header, model, projector);
      ({ manifestText, cfgBytes, cfgDigest } = finish(synth.manifest, synth.config));
      ctx.warnings.push(`${d.key}: not on the Hub registry; model relies on its embedded chat template`);
    }
    const cfgRel = blobRel(cfgDigest.slice(7));

    // Never overwrite a manifest (hf.co or alias) naming another model whose blob is a regular file: that is the
    // user's own Ollama download, and once no manifest names it Ollama garbage-collects the weights.
    const pulledOther = async (rel: string): Promise<boolean> => {
      const facts = await factsOf(ctx.fs, abs(rel));
      if (facts === null || !facts.isFile || facts.isSymlink) return false;
      let text: string | null;
      try {
        text = await readManifestText(ctx.fs, abs(rel));
      } catch {
        throw new SkipEntry(`${rel}: cannot be read to check its model; skipped`);
      }
      if (text === null) throw new SkipEntry(`${rel}: too large to check; skipped`);
      const pulled = await pulledModel(ctx.fs, root, text);
      return pulled !== null && pulled !== model.sha256.toLowerCase();
    };
    if (await pulledOther(o.manifestPath)) throw new SkipEntry(`${o.manifestPath}: ${OLLAMA_DOWNLOAD}; not replaced`);

    // Files to write: layers and config blob only when absent (never overwritten), the hf.co manifest always.
    const toWrite: Array<{ rel: string; data: string | Uint8Array; blob: boolean }> = [];
    for (const s of small) if (s.bytes !== null) toWrite.push({ rel: s.rel, data: s.bytes, blob: true });
    if (!small.some((s) => s.rel === cfgRel) && !(await existsFollowing(ctx, abs(cfgRel)))) toWrite.push({ rel: cfgRel, data: cfgBytes, blob: true });
    toWrite.push({ rel: o.manifestPath, data: manifestText, blob: false });

    // Links: unlink a wrong link into the hub (needs the plan's facts), create what is missing, leave the rest.
    const links: LinkPlan[] = [];
    for (const l of d.links) {
      const p = abs(l.path);
      const facts = await factsOf(ctx.fs, p);
      let action: LinkPlan['action'] = facts === null ? 'create' : 'keep';
      let expect: FileFacts | null = null;
      if (facts?.linkTarget !== undefined) {
        const cur = facts.linkTarget;
        const wrong = cur !== l.target && cur.slice(cur.lastIndexOf('/') + 1) !== l.target.slice(l.target.lastIndexOf('/') + 1);
        if (wrong && linkIntoHub(dirname(p), cur, deps.hubRoot)) {
          expect = ctx.expect(l.path) ?? null;
          if (expect === null || !factsMatch(facts, expect)) throw new SkipEntry(`${l.path}: changed since preview; skipped`);
          action = 'replace';
        } else if (wrong) ctx.warnings.push(`${l.path}: points elsewhere (not into the cache); left in place`);
      }
      links.push({ path: p, rel: l.path, target: l.target, action, expect });
    }

    // Aliases (read-only decisions): refused aliases are warned about and not owned. On an update, an alias the key
    // owned that still names its previous model is ours to overwrite (replaced in Phase B, never unlinked first).
    const ourModel = `sha256:${model.sha256}`;
    const aliasRels: string[] = [];
    const aliasWrites: string[] = [];
    const refusals: string[] = [];
    for (const rel of o.aliasPaths) {
      const facts = await factsOf(ctx.fs, abs(rel));
      let action: 'write' | 'skip' | 'refuse' = 'write';
      if (facts !== null) {
        action = 'refuse';
        if (facts.isFile && !facts.isSymlink) {
          try {
            const prevModel = prev !== undefined && prev.paths.includes(rel) ? `sha256:${prev.sha256}` : null;
            action = aliasAction(await ctx.fs.readFile(abs(rel), 'utf8'), manifestText, ourModel, prevModel);
          } catch {
            action = 'refuse';   // unreadable (OSError in the CLI)
          }
        }
      }
      if (action === 'write' && (await pulledOther(rel))) {
        refusals.push(`${d.key}: alias ${rel} names a ${OLLAMA_DOWNLOAD}; not overwritten`);
        continue;
      }
      if (action === 'refuse') refusals.push(`${d.key}: alias ${rel} exists and belongs to another model; not overwritten`);
      else {
        aliasRels.push(rel);
        if (action === 'write') aliasWrites.push(rel);
      }
    }

    // Preconditions of every write, then every mkdirp, all before the first write. The facts seen here become the
    // `expect` of the manifest and alias writes whenever the plan has none, so a file that appears or changes between
    // this check and the write is STALE instead of overwritten.
    const seenFacts = new Map<string, FileFacts | null>();
    for (const w of toWrite) seenFacts.set(w.rel, await requireWritable(ctx, abs(w.rel), w.rel));
    for (const rel of aliasWrites) seenFacts.set(rel, await requireWritable(ctx, abs(rel), rel));
    for (const l of links) if (l.action !== 'keep') await ensureParent(ctx, root, l.path);
    for (const w of toWrite) await ensureParent(ctx, root, abs(w.rel));
    for (const rel of aliasWrites) await ensureParent(ctx, root, abs(rel));

    // ---- Phase B: writes only ----
    ctx.warnings.push(...refusals);
    const vfs = viewFs(ctx.safeFs, root, ctx.fs);
    const written: string[] = [];
    // The plan's null means "must be absent" and is kept; only an undefined (no plan entry) falls back to Phase-A facts.
    const planned = (rel: string): { expect: FileFacts | null } => {
      const e = ctx.expect(rel);
      return { expect: e === undefined ? (seenFacts.get(rel) ?? null) : e };
    };
    let current = '';
    try {
      for (const w of toWrite.filter((x) => x.blob)) {
        current = w.rel;
        await vfs.writeFileAtomic(abs(w.rel), w.data, { expect: null });
        written.push(w.rel);
      }
      for (const l of links) {
        if (l.action === 'keep') continue;
        current = l.rel;
        if (l.expect !== null) {
          await vfs.unlink(l.path, l.expect);
          written.push(l.rel);   // the old link is gone from here on
        }
        await vfs.symlink(l.target, l.path);
        if (!written.includes(l.rel)) written.push(l.rel);
      }
      current = o.manifestPath;
      await vfs.writeFileAtomic(abs(o.manifestPath), manifestText, planned(o.manifestPath));
      written.push(o.manifestPath);
      for (const rel of aliasWrites) {
        current = rel;
        await vfs.writeFileAtomic(abs(rel), manifestText, planned(rel));
        written.push(rel);
      }
    } catch (e) {
      // SkipEntry keeps meaning "nothing written"; after the first write the failure is CreateIncomplete.
      if (written.length > 0) throw new CreateIncomplete(written, e);
      if (e instanceof SafeFsError && e.code !== 'IO') throw new SkipEntry(`${current}: ${e.message}; skipped`);
      throw e;
    }

    return pySort(new Set([...small.map((s) => s.rel), ...d.links.map((l) => l.path), cfgRel, o.manifestPath, ...aliasRels]));
  };
}

/** CLI `Path.exists()`: follows symlinks; a dangling link is false. A directory counts as existing. */
async function existsFollowing(ctx: ApplyCtx, p: string): Promise<boolean> {
  try {
    await ctx.fs.stat(p);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/** A file we are about to write must be absent or a regular file; a symlink or directory there is a SkipEntry. */
async function requireWritable(ctx: ApplyCtx, p: string, rel: string): Promise<FileFacts | null> {
  const facts = await factsOf(ctx.fs, p);
  if (facts !== null && (facts.isSymlink || !facts.isFile)) throw new SkipEntry(`${rel}: a symlink or folder is in the way; skipped`);
  return facts;
}
