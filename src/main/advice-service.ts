// Keep advice over IPC: builds the engine's input from a scanned repo and
// maps its output to DTOs. GGUF headers are read only here, only when advice is asked for (never during a scan), read-only
// through the port, and cached by the group's blob etags: blobs are content-addressed, so a cached shape never goes stale.
import { advise, effectiveProfile } from '../core/advice/engine';
import { countedWeights, shapeFromConfig, shapeFromHeaders, sumCounted, type CountedWeights, type ModelShape } from '../core/advice/shape';
import type { AdviceGroupInput, AdviceSettings, GroupAdvice, MachineProfile } from '../core/advice/types';
import { currentFiles, defaultReadText, fileBytes, repoDiffusionSignal, type ReadText } from '../core/classify/classify';
import { shardInfo } from '../core/classify/gguf-names';
import type { HfhubConfig } from '../core/compat/config';
import type { Group, Repo, RepoView, SnapshotFile } from '../core/types';
import type { GgufHeader } from '../core/views/gguf-header';
import type { GroupAdviceDTO, MachineProfileDTO, NamePartDTO, RepoAdviceDTO } from '../shared/api';
import { KNOWLEDGE } from '../shared/knowledge';
import { nameParts } from '../shared/knowledge/name-parts';
import { detectFormat, type Tool } from '../shared/knowledge/rules';

/** Group kinds whose files are GGUF weights with a header worth reading. */
export const HEADER_KINDS: ReadonlySet<Group['kind']> = new Set(['quant', 'mmproj', 'draft']);

/** A machine nothing was detected on: RAM from the OS, no GPU. Used before detection finishes and when it cannot run. */
export function undetectedMachine(platform: NodeJS.Platform, ramBytes: number): MachineProfile {
  return { platform, ramBytes, gpuName: null, gpuBytes: null, gpuKind: 'other', computeCap: null, drivesDisplay: false };
}

/** What `settings.tools` null means: llama.cpp always, plus each view config.toml configures. */
export function defaultTools(config: HfhubConfig | null): Tool[] {
  const tools: Tool[] = ['llama.cpp'];
  if (config?.views.lmstudio.root != null) tools.push('lmstudio');
  if (config?.views.ollama.root != null) tools.push('ollama');
  return tools;
}

export function profileDto(machine: MachineProfile, settings: AdviceSettings, adviceError: string | null, config: HfhubConfig | null): MachineProfileDTO {
  return { detected: machine, settings, adviceError, effective: effectiveProfile(machine, settings), defaultTools: defaultTools(config) };
}

/**
 * The files whose headers make a group's shape, first shard first (the first carries the metadata), with
 * the cache key: the group's sorted etag list. null when any file has no live blob (a plain file, a missing or dangling
 * blob): nothing is opened and the shape is unknown.
 */
export function headerFiles(repo: Repo, group: Group): { paths: string[]; key: string } | null {
  if (group.files.length === 0) return null;
  const files = [...group.files].sort((a, b) =>
    (shardInfo(a.relpath)?.index ?? 0) - (shardInfo(b.relpath)?.index ?? 0) || (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
  const paths: string[] = [];
  const etags: string[] = [];
  for (const f of files) {
    if (f.blobEtag === null || !Object.hasOwn(repo.blobs, f.blobEtag)) return null;
    const blob = repo.blobs[f.blobEtag]!;
    if (blob.dangling) return null;
    paths.push(blob.path);
    etags.push(f.blobEtag);
  }
  return { paths, key: [...etags].sort().join('\0') };
}

/** The current snapshot's root config.json as a JSON object, read as the classifier reads it; any problem is null. */
export function configJson(repo: Repo, readText: ReadText = defaultReadText): Record<string, unknown> | null {
  const config = currentFiles(repo).find((f) => f.relpath === 'config.json');
  if (config === undefined) return null;
  return parseObject(readText(config.linkPath));
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const j: unknown = JSON.parse(text);
    return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One unit's weight files counted (countedWeights), each index read as the classifier reads text, parsed as untrusted JSON. */
function countFiles(repo: Repo, files: readonly SnapshotFile[], readText: ReadText, variants: boolean): CountedWeights {
  return countedWeights(files.map((f) => ({ relpath: f.relpath, bytes: fileBytes(repo, f) })),
    (rel) => parseObject(readText(files.find((f) => f.relpath === rel)!.linkPath)), variants);
}

/**
 * The weights the judgment counts. A transformers repo: its `weights` groups as one unit. A diffusers
 * pipeline: each component folder on its own (one format, one variant, its own index), summed. Other kinds: null.
 */
export function repoWeights(repo: Repo, view: RepoView, readText: ReadText = defaultReadText): CountedWeights | null {
  const of = (kind: Group['kind']): Group[] => view.groups.filter((g) => g.kind === kind);
  if (view.kinds[0] === 'transformers') return countFiles(repo, of('weights').flatMap((g) => g.files), readText, false);
  if (view.kinds[0] === 'diffusers') return sumCounted(of('component').map((g) => countFiles(repo, g.files, readText, true)));
  return null;
}

/** Shapes by sorted etag list. Holds the promise, so two advice calls at once read a header once. Only content facts
 *  are kept (a shape, or null for bytes that are not a usable header); a read that failed with an I/O error is dropped. */
export type ShapeCache = Map<string, Promise<ModelShape | null>>;

export interface AdviceRequest {
  repo: Repo;
  view: RepoView;
  machine: MachineProfile;
  settings: AdviceSettings;
  config: HfhubConfig | null;
  readHeaders: (paths: readonly string[]) => Promise<GgufHeader[] | null>;
  cache: ShapeCache;
  readText?: ReadText;
}

async function shapeOf(req: AdviceRequest, g: Group): Promise<ModelShape | null> {
  if (!HEADER_KINDS.has(g.kind) || g.locked) return null;
  const files = headerFiles(req.repo, g);
  if (files === null) return null;
  const cached = req.cache.get(files.key);
  if (cached !== undefined) return cached.catch(() => null);   // a shared read that fails is unknown here too
  const shards = g.shards ?? null;
  const shape = req.readHeaders(files.paths).then((h) => (h === null ? null : shapeFromHeaders(h, shards)));
  req.cache.set(files.key, shape);
  try {
    return await shape;
  } catch {
    // an I/O error is not a fact of the content: unknown for this call, read again on the next one
    if (req.cache.get(files.key) === shape) req.cache.delete(files.key);
    return null;
  }
}

const parts = (text: string): NamePartDTO[] => nameParts(text, KNOWLEDGE).map((p) => ({ text: p.text, entryId: p.entryId, looksLikeTag: p.looksLikeTag }));

function toDto(a: GroupAdvice, g: Group | null): GroupAdviceDTO {
  return {
    key: a.key, tint: a.tint, reason: a.reason, explanation: a.explanation, facts: [...a.facts],
    labelParts: g === null ? [] : parts(g.label),
    files: g === null ? [] : g.files.map((f) => ({ relpath: f.relpath, parts: parts(f.relpath) })),
  };
}

export async function repoAdvice(req: AdviceRequest): Promise<RepoAdviceDTO> {
  const { repo, view } = req;
  const groups: AdviceGroupInput[] = [];
  for (const g of view.groups) {
    groups.push({
      key: g.key, kind: g.kind, label: g.label, bytes: g.apparentBytes, relpaths: g.files.map((f) => f.relpath),
      shape: await shapeOf(req, g), shards: g.shards ?? null, locked: g.locked,
    });
  }
  const repoKind = view.kinds[0] ?? 'unknown';
  const config = configJson(repo, req.readText);
  const detected = detectFormat({ repoId: repo.id, relpaths: currentFiles(repo).map((f) => f.relpath), quantizationConfig: config?.quantization_config ?? null });
  // A transformers checkpoint whose readable config.json declares no quantization holds plain 16/32-bit weights.
  const plain = repoKind === 'transformers' && config !== null && config.quantization_config === undefined && config.quantization === undefined;
  const format = detected === 'unknown' && plain ? 'safetensors-16' : detected;
  const readText = req.readText ?? defaultReadText;
  const counted = repoWeights(repo, view, readText);
  const out = advise({
    repoId: repo.id, format, repoKind, groups, machine: req.machine, settings: req.settings,
    repoShape: repoKind === 'transformers' && config !== null ? shapeFromConfig(config, counted!.bytes) : null,
    repoWeights: counted === null ? null : { bytes: counted.bytes, note: counted.note },
    incomplete: counted !== null && (view.partialDownloads > 0 || counted.incomplete),
    diffusionSignal: repoKind === 'diffusion' ? repoDiffusionSignal(repo, readText) : null,
    tools: req.settings.tools ?? defaultTools(req.config), knowledge: KNOWLEDGE,
  });
  return {
    repoId: repo.id, repoParts: parts(repo.id), basis: out.basis,
    repoLine: out.repoLine === null ? null : toDto(out.repoLine, null),
    groups: out.groups.map((a, i) => toDto(a, view.groups[i]!)),
  };
}
