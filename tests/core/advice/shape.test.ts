import { describe, expect, it } from 'vitest';
import { countedWeights, kvCacheBytes, sumCounted, shapeFromConfig, shapeFromHeaders, type ModelShape } from '../../../src/core/advice/shape';
import type { GgufHeader } from '../../../src/core/views/gguf-header';

const hdr = (kv: Record<string, unknown>, paramCount = 100): GgufHeader =>
  ({ version: 3, nTensors: 1n, kv: new Map(Object.entries(kv)), paramCount });
const base = { 'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count': 32,
  'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096 };

describe('shapeFromHeaders', () => {
  it('sums paramCount over shards and reads expert_count (0 when absent)', () => {
    const s = shapeFromHeaders([hdr(base, 10), hdr({}, 5)], { present: 2, expected: 2 })!;
    expect(s.paramCount).toBe(15);
    expect(s.expertCount).toBe(0);
    expect(shapeFromHeaders([hdr({ ...base, 'llama.expert_count': 8n })], null)!.expertCount).toBe(8);
  });
  it('derives head dim from embedding / head_count, or uses key/value_length', () => {
    expect(shapeFromHeaders([hdr(base)], null)!.kvLayers[0]).toMatchObject({ kvHeads: 8, headDimK: 128, headDimV: 128 });
    const s = shapeFromHeaders([hdr({ ...base, 'llama.attention.key_length': 192, 'llama.attention.value_length': 128 })], null)!;
    expect(s.kvLayers[0]).toMatchObject({ headDimK: 192, headDimV: 128 });
  });
  it('uses per-layer head_count_kv arrays', () => {
    const s = shapeFromHeaders([hdr({ ...base, 'llama.block_count': 3, 'llama.attention.head_count_kv': [8, 0, 4] })], null)!;
    expect(s.kvLayers.map((l) => l.kvHeads)).toEqual([8, 4]);
  });
  it('keeps only attention layers for full_attention_interval', () => {
    const s = shapeFromHeaders([hdr({ ...base, 'llama.block_count': 48, 'llama.full_attention_interval': 4 })], null)!;
    expect(s.layers).toBe(48);
    expect(s.kvLayers).toHaveLength(12);
  });
  it('gives sliding layers their window', () => {
    const s = shapeFromHeaders([hdr({ ...base, 'llama.block_count': 3, 'llama.attention.sliding_window': 1024,
      'llama.attention.sliding_window_pattern': [true, true, false] })], null)!;
    expect(s.kvLayers.map((l) => l.window)).toEqual([1024, 1024, null]);
  });
  it('reads a numeric sliding_window_pattern: every Nth layer is full', () => {
    const kv = { ...base, 'llama.block_count': 48, 'llama.attention.sliding_window': 1024, 'llama.attention.sliding_window_pattern': 6 };
    const s = shapeFromHeaders([hdr(kv)], null)!;
    expect(s.kvLayers.filter((l) => l.window === null)).toHaveLength(8);
    expect(s.kvLayers.filter((l) => l.window === 1024)).toHaveLength(40);
    expect(kvCacheBytes(s, 32768, 'f16')).toBe((8 * 32768 + 40 * 1024) * 8 * 256 * 2);
    const one = shapeFromHeaders([hdr({ ...kv, 'llama.attention.sliding_window_pattern': 1 })], null)!;
    expect(one.kvLayers.every((l) => l.window === null)).toBe(true);
  });
  it('accepts the pattern without the attention. prefix', () => {
    const s = shapeFromHeaders([hdr({ ...base, 'llama.block_count': 6, 'llama.attention.sliding_window': 64, 'llama.sliding_window_pattern': 3 })], null)!;
    expect(s.kvLayers.map((l) => l.window)).toEqual([64, 64, null, 64, 64, null]);
  });
  it('rejects hostile layer counts and short or bad arrays', () => {
    const t = (o: Record<string, unknown>) => shapeFromHeaders([hdr({ ...base, ...o })], null);
    expect(t({ 'llama.block_count': 1e12 })).toBeNull();
    expect(t({ 'llama.block_count': 4097 })).toBeNull();
    expect(t({ 'llama.block_count': 4096 })).not.toBeNull();
    expect(t({ 'llama.block_count': 0 })).toBeNull();
    expect(t({ 'llama.block_count': 2.5 })).toBeNull();
    expect(t({ 'llama.attention.head_count_kv': [8, 8] })).toBeNull();
    expect(t({ 'llama.attention.head_count': [32, 32] })).toBeNull();
    expect(t({ 'llama.attention.sliding_window_pattern': [true] })).toBeNull();
    expect(t({ 'llama.attention.head_count_kv': -1 })).toBeNull();
    expect(t({ 'llama.attention.head_count_kv': NaN })).toBeNull();
    expect(t({ 'llama.attention.key_length': -128 })).toBeNull();
    expect(t({ 'llama.context_length': Infinity })).toBeNull();
  });
  it('treats a zero sliding_window as no window, and accepts a bigint pattern', () => {
    const kv = { ...base, 'llama.block_count': 6, 'llama.attention.sliding_window': 0, 'llama.attention.sliding_window_pattern': 3 };
    expect(shapeFromHeaders([hdr(kv)], null)!.kvLayers.every((l) => l.window === null)).toBe(true);
    const big = shapeFromHeaders([hdr({ ...kv, 'llama.attention.sliding_window': 64, 'llama.attention.sliding_window_pattern': 3n })], null)!;
    expect(big.kvLayers.map((l) => l.window)).toEqual([64, 64, null, 64, 64, null]);
  });
  it('rejects absurd head counts, head dims and context lengths', () => {
    const t = (o: Record<string, unknown>) => shapeFromHeaders([hdr({ ...base, ...o })], null);
    expect(t({ 'llama.attention.head_count_kv': 65537 })).toBeNull();
    expect(t({ 'llama.attention.key_length': 65537 })).toBeNull();
    expect(t({ 'llama.context_length': 2 ** 31 + 1 })).toBeNull();
    expect(t({ 'llama.context_length': 2 ** 31 })).not.toBeNull();
  });
  it('reads file type and context length', () => {
    const s = shapeFromHeaders([hdr({ ...base, 'general.file_type': 7, 'llama.context_length': 8192 })], null)!;
    expect(s.fileType).toBe('Q8_0');
    expect(s.contextLength).toBe(8192);
    expect(shapeFromHeaders([hdr(base)], null)!.fileType).toBeNull();
  });
  it('is null when a shard header is missing', () => {
    expect(shapeFromHeaders([hdr(base)], { present: 1, expected: 2 })).toBeNull();
    expect(shapeFromHeaders([hdr(base)], { present: 2, expected: 2 })).toBeNull();
    expect(shapeFromHeaders([], null)).toBeNull();
  });
  it('is null without block_count or head_count_kv', () => {
    const noBlocks: Record<string, unknown> = { ...base };
    const noKv: Record<string, unknown> = { ...base };
    delete noBlocks['llama.block_count'];
    delete noKv['llama.attention.head_count_kv'];
    expect(shapeFromHeaders([hdr(noBlocks)], null)).toBeNull();
    expect(shapeFromHeaders([hdr(noKv)], null)).toBeNull();
  });
});

describe('shapeFromHeaders: unusable headers', () => {
  it('needs a named architecture', () => {
    expect(shapeFromHeaders([hdr({ ...base, 'general.architecture': '' })], null)).toBeNull();
    expect(shapeFromHeaders([hdr({ ...base, 'general.architecture': 7 })], null)).toBeNull();
  });
  it('needs a head dimension: key_length, or embedding_length over head_count', () => {
    const noHeads: Record<string, unknown> = { ...base };
    delete noHeads['llama.attention.head_count'];
    expect(shapeFromHeaders([hdr(noHeads)], null)).toBeNull();
    expect(shapeFromHeaders([hdr({ ...base, 'llama.attention.head_count': 0 })], null)).toBeNull();
    expect(shapeFromHeaders([hdr({ ...noHeads, 'llama.attention.key_length': 128, 'llama.attention.value_length': 128 })], null)!.kvLayers[0])
      .toMatchObject({ headDimK: 128, headDimV: 128 });
  });
  it('rejects a derived head dimension no real model has', () => {
    expect(shapeFromHeaders([hdr({ ...base, 'llama.attention.head_count': 1, 'llama.embedding_length': 65537 })], null)).toBeNull();
    expect(shapeFromHeaders([hdr({ ...base, 'llama.attention.head_count': 1, 'llama.embedding_length': 65536 })], null)).not.toBeNull();
  });
});

describe('kvCacheBytes', () => {
  const layer = { kvHeads: 8, headDimK: 128, headDimV: 128, window: null };
  const shape = (kvLayers: ModelShape['kvLayers']): ModelShape =>
    ({ arch: 'llama', fileType: null, paramCount: 1, expertCount: 0, layers: kvLayers.length, contextLength: null, kvLayers });
  const full = shape(Array.from({ length: 32 }, () => layer));
  it('computes f16 and q8_0', () => {
    expect(kvCacheBytes(full, 32768, 'f16')).toBe(4_294_967_296);
    expect(kvCacheBytes(full, 32768, 'q8_0')).toBe(4_294_967_296 * 0.53125);
  });
  it('limits a sliding layer to min(window, context)', () => {
    const s = shape([{ ...layer, window: 1024 }]);
    expect(kvCacheBytes(s, 32768, 'f16')).toBe(8 * 256 * 1024 * 2);
    expect(kvCacheBytes(s, 512, 'f16')).toBe(8 * 256 * 512 * 2);
  });
});

describe('shapeFromConfig (transformers config.json)', () => {
  const without = (o: Record<string, unknown>, ...keys: string[]): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  const llama = { model_type: 'llama', num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, hidden_size: 4096,
    torch_dtype: 'bfloat16', max_position_embeddings: 131072 };
  it('reads a BF16 8B: 32 layers of 8 KV heads x 128, params estimated from 16-bit weights', () => {
    const s = shapeFromConfig(llama, 16e9)!;
    expect(s).toMatchObject({ arch: 'llama', fileType: 'bfloat16', paramCount: 8e9, expertCount: 0, layers: 32, contextLength: 131072 });
    expect(s.kvLayers).toHaveLength(32);
    expect(s.kvLayers[0]).toEqual({ kvHeads: 8, headDimK: 128, headDimV: 128, window: null });
    expect(kvCacheBytes(s, 32768, 'f16')).toBe(32 * 8 * 256 * 32768 * 2);
  });
  it('estimates params from the dtype: 16 bits for bf16/f16, 32 for f32, unknown otherwise; num_parameters wins', () => {
    expect(shapeFromConfig({ ...llama, torch_dtype: 'float16' }, 16e9)!.paramCount).toBe(8e9);
    expect(shapeFromConfig({ ...llama, torch_dtype: 'float32' }, 32e9)!.paramCount).toBe(8e9);
    expect(shapeFromConfig({ ...llama, torch_dtype: undefined, dtype: 'bfloat16' }, 16e9)!.paramCount).toBe(8e9);
    expect(shapeFromConfig({ ...llama, torch_dtype: 'int8' }, 16e9)!.paramCount).toBe(0);
    expect(shapeFromConfig({ ...llama, torch_dtype: undefined }, 16e9)!).toMatchObject({ paramCount: 0, fileType: null });
    expect(shapeFromConfig({ ...llama, num_parameters: 7.5e9 }, 16e9)!.paramCount).toBe(7.5e9);
  });
  it('a quantized checkpoint gives no estimate: its stored dtype is not the weights\' width', () => {
    expect(shapeFromConfig({ ...llama, quantization_config: { quant_method: 'awq' } }, 5e9)!.paramCount).toBe(0);
    expect(shapeFromConfig({ ...llama, quantization: { bits: 4, group_size: 64 } }, 5e9)!.paramCount).toBe(0);
  });
  it('falls back to num_attention_heads and hidden_size / heads; head_dim wins when given', () => {
    const mha = without(llama, 'num_key_value_heads');
    expect(shapeFromConfig(mha, 16e9)!.kvLayers[0]).toMatchObject({ kvHeads: 32, headDimK: 128 });
    expect(shapeFromConfig({ ...llama, head_dim: 256 }, 16e9)!.kvLayers[0]).toMatchObject({ headDimK: 256, headDimV: 256 });
    expect(shapeFromConfig({ ...llama, head_dim: null }, 16e9)!.kvLayers[0]).toMatchObject({ headDimK: 128 });
  });
  it('reads experts from num_local_experts or num_experts', () => {
    expect(shapeFromConfig({ ...llama, num_local_experts: 8 }, 16e9)!.expertCount).toBe(8);
    expect(shapeFromConfig({ ...llama, num_experts: 128 }, 16e9)!.expertCount).toBe(128);
  });
  it('layer_types give sliding layers the sliding_window; unknown layer types count as full (over-estimate)', () => {
    const s = shapeFromConfig({ ...llama, num_hidden_layers: 4, sliding_window: 1024,
      layer_types: ['sliding_attention', 'full_attention', 'sliding_attention', 'linear_attention'] }, 16e9)!;
    expect(s.kvLayers.map((l) => l.window)).toEqual([1024, null, 1024, null]);
    // without layer_types a sliding_window is not trusted (Qwen2 sets it with use_sliding_window false)
    expect(shapeFromConfig({ ...llama, sliding_window: 1024 }, 16e9)!.kvLayers.every((l) => l.window === null)).toBe(true);
    // no window, or a zero one: the sliding layers count in full
    const none = shapeFromConfig({ ...llama, num_hidden_layers: 2, sliding_window: null, layer_types: ['sliding_attention', 'full_attention'] }, 16e9)!;
    expect(none.kvLayers.map((l) => l.window)).toEqual([null, null]);
    const zero = shapeFromConfig({ ...llama, num_hidden_layers: 2, sliding_window: 0, layer_types: ['sliding_attention', 'full_attention'] }, 16e9)!;
    expect(zero.kvLayers.map((l) => l.window)).toEqual([null, null]);
  });
  it('reads text_config when the top level lacks the keys (VL models)', () => {
    const s = shapeFromConfig({ model_type: 'qwen2_5_vl', torch_dtype: 'bfloat16', text_config: { ...llama, model_type: 'qwen2', torch_dtype: undefined } }, 16e9)!;
    expect(s).toMatchObject({ arch: 'qwen2', layers: 32, paramCount: 8e9 });
    expect(shapeFromConfig({ text_config: llama }, 16e9)!.fileType).toBe('bfloat16');
  });
  it('defaults the arch to "unknown" and the context to null', () => {
    const bare = without(llama, 'model_type', 'max_position_embeddings');
    expect(shapeFromConfig(bare, 16e9)).toMatchObject({ arch: 'unknown', contextLength: null });
  });
  it('is null for anything that is not a usable config', () => {
    for (const bad of [null, 'x', 42, [], {}, { text_config: 'x' }, { text_config: [] }]) expect(shapeFromConfig(bad, 16e9), JSON.stringify(bad)).toBeNull();
    expect(shapeFromConfig(without(llama, 'num_hidden_layers'), 16e9)).toBeNull();
    expect(shapeFromConfig(without(llama, 'num_attention_heads'), 16e9)).toBeNull();   // no head_dim either, so no head dimension
    expect(shapeFromConfig({ ...without(llama, 'num_attention_heads', 'num_key_value_heads'), head_dim: 128 }, 16e9)).toBeNull();   // no KV head count
    expect(shapeFromConfig(without(llama, 'hidden_size'), 16e9)).toBeNull();
  });
  it('config.json is untrusted: absurd values are null, never a huge loop or a tiny estimate', () => {
    const cases: Array<Record<string, unknown>> = [
      { num_hidden_layers: 0 }, { num_hidden_layers: 4097 }, { num_hidden_layers: 1.5 }, { num_hidden_layers: '32' },
      { num_hidden_layers: Infinity }, { num_hidden_layers: -1 },
      { num_key_value_heads: 0 }, { num_key_value_heads: 65537 }, { num_key_value_heads: 2.5 },
      { num_attention_heads: 0 }, { num_attention_heads: 70000 },
      { head_dim: 0 }, { head_dim: 65537 }, { head_dim: -128 }, { head_dim: 'x' },
      { hidden_size: 1e12 }, { hidden_size: 4096.5 }, { hidden_size: 100 },
      { max_position_embeddings: 2 ** 31 + 1 }, { max_position_embeddings: -1 }, { max_position_embeddings: 'x' },
      { num_local_experts: -1 }, { num_experts: 1e9 }, { num_parameters: -5 }, { num_parameters: 'x' },
      { sliding_window: -1, layer_types: Array(32).fill('sliding_attention') }, { sliding_window: 2 ** 31 + 1, layer_types: Array(32).fill('sliding_attention') },
      { sliding_window: 'x', layer_types: Array(32).fill('sliding_attention') },
      { layer_types: 'full_attention' }, { layer_types: ['full_attention'] }, { layer_types: Array(32).fill(1) },
    ];
    for (const c of cases) expect(shapeFromConfig({ ...llama, ...c }, 16e9), JSON.stringify(c)).toBeNull();
    expect(shapeFromConfig(llama, -1)!.paramCount).toBe(0);
    expect(shapeFromConfig(llama, NaN)!.paramCount).toBe(0);
  });
});

describe('countedWeights (one format, the index decides the files)', () => {
  const f = (relpath: string, bytes = 1000) => ({ relpath, bytes });
  const idx = (...files: string[]) => ({ weight_map: Object.fromEntries(files.map((x, i) => [`t${i}`, x])) });
  const st = ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors'];
  const bin = ['pytorch_model-00001-of-00002.bin', 'pytorch_model-00002-of-00002.bin'];
  it('counts the safetensors when both formats exist; the copies are named in the note', () => {
    const r = countedWeights([...st, ...bin].map((x) => f(x)), () => undefined);
    expect(r).toMatchObject({ bytes: 2000, note: 'not counted, duplicates of the same weights: pytorch_model-00001-of-00002.bin, pytorch_model-00002-of-00002.bin', incomplete: false });
  });
  it('counts .bin / .pt / .pth when there are no safetensors', () => {
    expect(countedWeights([f('a.bin'), f('b.pt'), f('c.PTH'), f('README.md')], () => undefined)).toMatchObject({ bytes: 3000, note: null, incomplete: false });
  });
  it('with an index of the counted format: exactly the files it lists; extra files of the format are duplicates', () => {
    const files = [f('consolidated.safetensors', 14.5e9), f(st[0]!, 7e9), f(st[1]!, 7.5e9), f('model.safetensors.index.json', 100)];
    const r = countedWeights(files, (p) => (p === 'model.safetensors.index.json' ? idx(st[0]!, st[1]!, st[1]!) : undefined));
    expect(r).toMatchObject({ bytes: 14.5e9, note: 'not counted, duplicates of the same weights: consolidated.safetensors', incomplete: false });
  });
  it('a shard the index lists that is missing or empty is incomplete', () => {
    const files = [f(st[0]!), f(st[1]!, 0), f('model.safetensors.index.json')];
    expect(countedWeights(files, () => idx(...st)).incomplete).toBe(true);
    expect(countedWeights([f(st[0]!), f('model.safetensors.index.json')], () => idx(...st)).incomplete).toBe(true);
  });
  it('an unreadable index, or one without a weight_map of strings, is incomplete', () => {
    for (const bad of [null, undefined, 'x', [], { weight_map: [] }, { weight_map: null }, { weight_map: { a: 1 } }]) {
      expect(countedWeights([f(st[0]!), f('model.safetensors.index.json')], () => (bad === undefined ? undefined : bad))
        .incomplete, JSON.stringify(bad)).toBe(true);
    }
  });
  it('only the counted format\'s index matters: a leftover .bin index without its .bin files is ignored', () => {
    const files = [f(st[0]!), f(st[1]!), f('model.safetensors.index.json'), f('pytorch_model.bin.index.json')];
    const read = (p: string) => (p === 'model.safetensors.index.json' ? idx(...st) : idx(...bin));
    expect(countedWeights(files, read)).toMatchObject({ bytes: 2000, note: null, incomplete: false });
    // and the .bin index is the one that matters when only .bin is counted
    expect(countedWeights([f(bin[0]!), f('pytorch_model.bin.index.json')], read).incomplete).toBe(true);
  });
  it('indexes in a subfolder name files relative to it; names the index lists are only compared, never trusted as paths', () => {
    const files = [f('sub/model-00001-of-00001.safetensors'), f('sub/model.safetensors.index.json')];
    expect(countedWeights(files, () => idx('model-00001-of-00001.safetensors')).incomplete).toBe(false);
    expect(countedWeights(files, () => idx('../sub/model-00001-of-00001.safetensors')).incomplete).toBe(true);
  });
  it('lists at most three copies by name', () => {
    const many = ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin'].map((x) => f(x));
    expect(countedWeights([f('m.safetensors'), ...many], () => undefined).note).toBe('not counted, duplicates of the same weights: a.bin, b.bin, c.bin and 2 more');
  });
  it('no weight files at all: 0 bytes', () => {
    expect(countedWeights([f('config.json')], () => undefined)).toMatchObject({ bytes: 0, note: null, incomplete: false });
  });
});

it('a torch_dtype naming an Object prototype key gives no estimate', () => {
  for (const d of ['constructor', 'toString', '__proto__']) {
    expect(shapeFromConfig({ num_hidden_layers: 1, num_attention_heads: 1, head_dim: 64, torch_dtype: d }, 16e9)!.paramCount, d).toBe(0);
  }
});

describe('countedWeights for pipeline components (one format, one variant, each folder its own index)', () => {
  const f = (relpath: string, bytes = 1000) => ({ relpath, bytes });
  const idx = (...files: string[]) => ({ weight_map: Object.fromEntries(files.map((x, i) => [`t${i}`, x])) });
  const U = 'unet/diffusion_pytorch_model';
  it('an fp16 variant beside the full-precision file: only the fp16 counts', () => {
    const r = countedWeights([f(`${U}.fp16.safetensors`, 5e9), f(`${U}.safetensors`, 10e9), f('unet/config.json', 100)], () => undefined, true);
    expect(r).toEqual({ bytes: 5e9, duplicates: [`${U}.safetensors`], note: `not counted, duplicates of the same weights: ${U}.safetensors`, incomplete: false });
  });
  it('bf16 when there is no fp16; else the plain file; else the first variant by name', () => {
    expect(countedWeights([f(`${U}.bf16.safetensors`, 2), f(`${U}.safetensors`, 4)], () => undefined, true).bytes).toBe(2);
    expect(countedWeights([f(`${U}.non_ema.safetensors`, 8), f(`${U}.safetensors`, 4)], () => undefined, true).bytes).toBe(4);
    expect(countedWeights([f(`${U}.non_ema.safetensors`, 8), f(`${U}.ema.safetensors`, 6)], () => undefined, true).bytes).toBe(6);
    // without `variants` (transformers) variant tags are not told apart
    expect(countedWeights([f(`${U}.fp16.safetensors`, 2), f(`${U}.safetensors`, 4)], () => undefined).bytes).toBe(6);
    // a component with no weight files (scheduler/): nothing counted
    expect(countedWeights([f('scheduler/scheduler_config.json')], () => undefined, true)).toMatchObject({ bytes: 0, duplicates: [], incomplete: false });
    // a dot in an ordinary name is not a variant
    expect(countedWeights([f('vae/model.v1.safetensors', 3), f('vae/model.safetensors', 4)], () => undefined, true).bytes).toBe(7);
  });
  it('a sharded fp16 variant uses its own index; the plain index (for files not downloaded) is ignored', () => {
    const sh = [`${U}.fp16-00001-of-00002.safetensors`, `${U}.fp16-00002-of-00002.safetensors`];
    const files = [...sh.map((x) => f(x, 2.5e9)), f(`${U}.safetensors.index.fp16.json`), f(`${U}.safetensors.index.json`)];
    const read = (p: string) => (p.endsWith('.fp16.json') ? idx(...sh.map((x) => x.slice('unet/'.length)))
      : idx('diffusion_pytorch_model-00001-of-00002.safetensors'));
    expect(countedWeights(files, read, true)).toMatchObject({ bytes: 5e9, incomplete: false, duplicates: [] });
    expect(countedWeights(files.slice(1), read, true).incomplete).toBe(true);   // a listed fp16 shard is missing
  });
  it('a leftover unet .bin index is not incomplete when the safetensors are counted', () => {
    const r = countedWeights([f(`${U}.fp16.safetensors`, 5e9), f(`${U}.bin.index.json`)], () => idx('diffusion_pytorch_model-00001-of-00002.bin'), true);
    expect(r).toMatchObject({ bytes: 5e9, incomplete: false });
  });
  it('an index covers only its own folder: a root file it does not list still counts', () => {
    const files = [f('model.safetensors', 7), f('sub/model-00001-of-00001.safetensors', 5), f('sub/model.safetensors.index.json')];
    expect(countedWeights(files, () => idx('model-00001-of-00001.safetensors'))).toMatchObject({ bytes: 12, duplicates: [], incomplete: false });
  });
  it('sumCounted adds the components and joins their duplicates', () => {
    const a = countedWeights([f(`${U}.fp16.safetensors`, 5), f(`${U}.safetensors`, 10)], () => undefined, true);
    const b = countedWeights([f('vae/x.fp16.safetensors', 1), f('vae/x.safetensors', 2)], () => undefined, true);
    const c = { bytes: 0, duplicates: [], note: null, incomplete: true };
    expect(sumCounted([a, b, c])).toEqual({ bytes: 6, duplicates: [`${U}.safetensors`, 'vae/x.safetensors'], incomplete: true,
      note: `not counted, duplicates of the same weights: ${U}.safetensors, vae/x.safetensors` });
    expect(sumCounted([])).toEqual({ bytes: 0, duplicates: [], note: null, incomplete: false });
  });
});
