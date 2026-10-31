// A model's shape and KV-cache size from its GGUF headers.
import { fileTypeName, type GgufHeader } from '../views/gguf-header';

export interface ModelShape {
  arch: string; fileType: string | null; paramCount: number; expertCount: number;
  layers: number; contextLength: number | null;
  /** One entry per layer that keeps a KV cache. */
  kvLayers: Array<{ kvHeads: number; headDimK: number; headDimV: number; window: number | null }>;
}

/** A positive-or-zero integer from a header value (number or bigint), else null. */
function num(v: unknown, max = Infinity): number | null {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

/** Headers are untrusted: head counts and head dimensions beyond this are not real models. */
const MAX_HEADS = 65536;
const MAX_CONTEXT = 2 ** 31;

/** A scalar, or element i of a per-layer array. */
function at(v: unknown, i: number): number | null {
  return Array.isArray(v) ? num(v[i], MAX_HEADS) : num(v, MAX_HEADS);
}

/** Headers are untrusted: no real model has anywhere near this many layers. */
export const MAX_LAYERS = 4096;

/** undefined when the key is absent, null when present but not a finite non-negative number. */
function opt(kv: Map<string, unknown>, key: string, max = Infinity): number | null | undefined {
  const v = kv.get(key);
  return v === undefined ? undefined : num(v, max);
}

export function shapeFromHeaders(headers: GgufHeader[], shards: { present: number; expected: number } | null): ModelShape | null {
  if (headers.length === 0) return null;
  if (shards && (shards.present < shards.expected || headers.length < shards.expected)) return null;
  const first = headers[0]!;
  const kv = first.kv;
  const arch = kv.get('general.architecture');
  if (typeof arch !== 'string' || arch === '') return null;
  const layers = num(kv.get(`${arch}.block_count`));
  if (layers === null || !Number.isInteger(layers) || layers < 1 || layers > MAX_LAYERS) return null;

  // Per-layer arrays must cover every layer; every element must be a sane count.
  const perLayer = (v: unknown): boolean =>
    !Array.isArray(v) || (v.length >= layers && v.slice(0, layers).every((x) => num(x, MAX_HEADS) !== null));
  const kvHeadsRaw = kv.get(`${arch}.attention.head_count_kv`);
  if (kvHeadsRaw === undefined || (!Array.isArray(kvHeadsRaw) && num(kvHeadsRaw, MAX_HEADS) === null) || !perLayer(kvHeadsRaw)) return null;
  const headCountRaw = kv.get(`${arch}.attention.head_count`);
  if (headCountRaw !== undefined && ((!Array.isArray(headCountRaw) && num(headCountRaw, MAX_HEADS) === null) || !perLayer(headCountRaw))) return null;

  const embedding = opt(kv, `${arch}.embedding_length`);
  const keyLen = opt(kv, `${arch}.attention.key_length`, MAX_HEADS);
  const valLen = opt(kv, `${arch}.attention.value_length`, MAX_HEADS);
  const interval = opt(kv, `${arch}.full_attention_interval`);
  const windowSize = opt(kv, `${arch}.attention.sliding_window`);
  const contextLength = opt(kv, `${arch}.context_length`, MAX_CONTEXT);
  const expertCount = opt(kv, `${arch}.expert_count`);
  if (embedding === null || keyLen === null || valLen === null || interval === null || windowSize === null
    || contextLength === null || expertCount === null) return null;
  const rawPattern = kv.get(`${arch}.attention.sliding_window_pattern`) ?? kv.get(`${arch}.sliding_window_pattern`);
  const pattern = typeof rawPattern === 'bigint' ? Number(rawPattern) : rawPattern;
  if (Array.isArray(pattern) && pattern.length < layers) return null;

  const kvLayers: ModelShape['kvLayers'] = [];
  for (let i = 0; i < layers; i++) {
    if (interval !== undefined && interval > 0 && (i + 1) % interval !== 0) continue;   // hybrid: only attention layers
    const kvHeads = at(kvHeadsRaw, i);
    if (kvHeads === null || kvHeads === 0) continue;
    const heads = at(headCountRaw, i);
    const derived = embedding !== undefined && heads !== null && heads > 0 ? embedding / heads : null;
    const headDimK = keyLen ?? derived;
    const headDimV = valLen ?? derived;
    if (headDimK === null || headDimV === null || headDimK > MAX_HEADS || headDimV > MAX_HEADS) return null;
    const slidingLayer = Array.isArray(pattern) ? pattern[i] === true
      : typeof pattern === 'number' && pattern > 1 ? (i + 1) % pattern !== 0 : false;   // N: every Nth layer is full
    const sliding = slidingLayer && windowSize !== undefined && windowSize > 0;   // a zero window is no window
    kvLayers.push({ kvHeads, headDimK, headDimV, window: sliding ? windowSize : null });
  }

  const ft = kv.get('general.file_type');
  return {
    arch,
    fileType: ft === undefined ? null : fileTypeName(ft),
    paramCount: headers.reduce((sum, h) => sum + h.paramCount, 0),
    expertCount: expertCount ?? 0,
    layers,
    contextLength: contextLength ?? null,
    kvLayers,
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const PARAM_CAP = 1e15;
const DTYPE_BITS: Record<string, number> = { bfloat16: 16, float16: 16, bf16: 16, fp16: 16, float32: 32, fp32: 32 };

/** A config value: undefined when absent or JSON null, null when present but not an integer in 0..max. */
function field(o: Json, key: string, max: number): number | null | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

/**
 * A transformers `config.json` as the same shape. config.json is untrusted: the caps of
 * shapeFromHeaders apply and anything absurd is null. VL models keep the language model's keys in `text_config`.
 * `paramCount` is `num_parameters`, else weightBytes x 8 / the bits of `torch_dtype` (0, unknown, for a quantized
 * checkpoint, whose stored dtype is not the weights' width).
 */
export function shapeFromConfig(config: unknown, weightBytes: number): ModelShape | null {
  if (!isObject(config)) return null;
  const nested = config.text_config;
  if (nested !== undefined && !isObject(nested)) return null;
  const c = config.num_hidden_layers === undefined && nested !== undefined ? nested : config;
  const top = (k: string): unknown => c[k] ?? config[k];

  const layers = field(c, 'num_hidden_layers', MAX_LAYERS);
  const heads = field(c, 'num_attention_heads', MAX_HEADS);
  const kvRaw = field(c, 'num_key_value_heads', MAX_HEADS);
  const headDimRaw = field(c, 'head_dim', MAX_HEADS);
  const hidden = field(c, 'hidden_size', MAX_HEADS * MAX_HEADS);
  const context = field(c, 'max_position_embeddings', MAX_CONTEXT);
  const window = field(c, 'sliding_window', MAX_CONTEXT);
  const local = field(c, 'num_local_experts', MAX_HEADS);
  const experts = local === undefined ? field(c, 'num_experts', MAX_HEADS) : local;
  const nParams = top('num_parameters');
  if (layers === null || layers === undefined || layers < 1 || heads === null || kvRaw === null || headDimRaw === null
    || hidden === null || context === null || window === null || experts === null) return null;
  if (nParams !== undefined && !(typeof nParams === 'number' && Number.isFinite(nParams) && nParams > 0 && nParams <= PARAM_CAP)) return null;

  const kvHeads = kvRaw ?? heads;
  if (kvHeads === undefined || kvHeads < 1 || heads === 0) return null;
  const derived = hidden !== undefined && heads !== undefined ? hidden / heads : undefined;
  const headDim = headDimRaw ?? derived;
  if (headDim === undefined || !Number.isInteger(headDim) || headDim < 1 || headDim > MAX_HEADS) return null;

  const types = c.layer_types;
  if (types !== undefined && (!Array.isArray(types) || types.length < layers || types.slice(0, layers).some((t) => typeof t !== 'string'))) return null;
  const kvLayers: ModelShape['kvLayers'] = [];
  for (let i = 0; i < layers; i++) {
    // A sliding_window without layer_types is not trusted; any other layer type counts in full (an over-estimate).
    const sliding = Array.isArray(types) && types[i] === 'sliding_attention' && window !== undefined && window > 0;
    kvLayers.push({ kvHeads, headDimK: headDim, headDimV: headDim, window: sliding ? window : null });
  }

  const dtypeRaw = top('torch_dtype') ?? top('dtype');
  const dtype = typeof dtypeRaw === 'string' ? dtypeRaw : null;
  const quantized = top('quantization_config') !== undefined || top('quantization') !== undefined;
  const bits = dtype === null || quantized || !Object.hasOwn(DTYPE_BITS, dtype.toLowerCase()) ? undefined : DTYPE_BITS[dtype.toLowerCase()];
  const estimate = bits !== undefined && Number.isFinite(weightBytes) && weightBytes > 0 ? (weightBytes * 8) / bits : 0;
  const modelType = c.model_type;
  return {
    arch: typeof modelType === 'string' && modelType !== '' ? modelType : 'unknown',
    fileType: dtype,
    paramCount: typeof nParams === 'number' ? nParams : estimate,
    expertCount: experts ?? 0,
    layers,
    contextLength: context ?? null,
    kvLayers,
  };
}

const SAFETENSORS = /\.safetensors$/i;
const PT = /\.(bin|pt|pth)$/i;
const MAX_NAMED = 3;

export interface CountedWeights { bytes: number; duplicates: string[]; note: string | null; incomplete: boolean }

/** Diffusers variant tags (`unet/diffusion_pytorch_model.fp16.safetensors`); fp16 is what the apps load for GPU use. */
const VARIANTS = ['fp16', 'bf16', 'fp32', 'fp8', 'non_ema', 'ema'];
const VARIANT_RE = new RegExp(`\\.(${VARIANTS.join('|')})(?=(-\\d+-of-\\d+)?\\.(safetensors|bin|pt|pth)$)`, 'i');
const INDEX_RE = /\.(safetensors|bin)\.index(?:\.([a-z0-9_]+))?\.json$/i;
const variantOf = (relpath: string): string | null => VARIANT_RE.exec(relpath)?.[1]?.toLowerCase() ?? null;
const folderOf = (relpath: string): string => relpath.slice(0, relpath.lastIndexOf('/') + 1);

export function duplicatesNote(dups: readonly string[]): string | null {
  if (dups.length === 0) return null;
  const named = dups.slice(0, MAX_NAMED).join(', ') + (dups.length > MAX_NAMED ? ` and ${dups.length - MAX_NAMED} more` : '');
  return `not counted, duplicates of the same weights: ${named}`;
}

/**
 * Which weight files hold the weights. The counted format is safetensors when any exist, else
 * .bin / .pt / .pth. With `variants` (a diffusers component) one variant counts: fp16, else bf16, else the plain files,
 * else the first variant by name. In each folder, a shard index of the counted format (and variant) names exactly that
 * folder's weight files; a folder without one counts all its files of the format. Every other weight file is a
 * duplicate. A listed file that is missing or empty, or an index without a `weight_map` of strings, is incomplete; an
 * index of another format (a leftover .bin index beside safetensors) is ignored. `readIndex` gives an index's parsed
 * JSON (untrusted), or undefined / null when it cannot be read. Index names are only compared, never resolved.
 */
export function countedWeights(files: ReadonlyArray<{ relpath: string; bytes: number }>, readIndex: (relpath: string) => unknown,
  variants = false): CountedWeights {
  const fmt = files.some((f) => SAFETENSORS.test(f.relpath)) ? 'safetensors' : 'bin';
  const ofFormat = fmt === 'safetensors' ? SAFETENSORS : PT;
  const weights = files.filter((f) => SAFETENSORS.test(f.relpath) || PT.test(f.relpath));
  let pool = weights.filter((f) => ofFormat.test(f.relpath));
  let chosen: string | null | undefined;   // undefined: variants are not told apart
  if (variants) {
    const tags = new Set(pool.map((f) => variantOf(f.relpath)));
    chosen = tags.has('fp16') ? 'fp16' : tags.has('bf16') ? 'bf16' : tags.has(null) ? null : [...tags].sort()[0] ?? null;
    pool = pool.filter((f) => variantOf(f.relpath) === chosen);
  }
  const present = new Set(files.filter((f) => f.bytes > 0).map((f) => f.relpath));
  const listed = new Map<string, Set<string>>();   // folder -> the files its index lists
  let incomplete = false;
  for (const idx of files) {
    const m = INDEX_RE.exec(idx.relpath);
    if (m === null || m[1]!.toLowerCase() !== fmt || (chosen !== undefined && (m[2]?.toLowerCase() ?? null) !== chosen)) continue;
    const dir = folderOf(idx.relpath);
    const set = listed.get(dir) ?? new Set<string>();
    listed.set(dir, set);
    const j = readIndex(idx.relpath);
    const map = isObject(j) ? j.weight_map : undefined;
    const names = isObject(map) ? Object.values(map) : [];
    if (names.length === 0 || names.some((n) => typeof n !== 'string')) { incomplete = true; continue; }
    for (const n of names as string[]) {
      set.add(`${dir}${n}`);
      if (!present.has(`${dir}${n}`)) incomplete = true;
    }
  }
  const counted = pool.filter((f) => listed.get(folderOf(f.relpath))?.has(f.relpath) ?? true);
  const duplicates = weights.filter((f) => !counted.includes(f)).map((f) => f.relpath);
  return { bytes: counted.reduce((n, f) => n + f.bytes, 0), duplicates, note: duplicatesNote(duplicates), incomplete };
}

/** A pipeline's weights: each component folder counted on its own, then summed. */
export function sumCounted(parts: readonly CountedWeights[]): CountedWeights {
  const duplicates = parts.flatMap((p) => p.duplicates);
  return { bytes: parts.reduce((n, p) => n + p.bytes, 0), duplicates, note: duplicatesNote(duplicates), incomplete: parts.some((p) => p.incomplete) };
}

/** Bytes per stored value: f16 is 2, q8_0 is 34 bytes per 32 values. */
const BYTES_PER_VALUE = { f16: 2, q8_0: 1.0625 } as const;

export function kvCacheBytes(s: ModelShape, context: number, kv: 'f16' | 'q8_0'): number {
  let total = 0;
  for (const l of s.kvLayers) {
    const tokens = l.window === null ? context : Math.min(l.window, context);
    total += l.kvHeads * (l.headDimK + l.headDimV) * tokens * BYTES_PER_VALUE[kv];
  }
  return total;
}
