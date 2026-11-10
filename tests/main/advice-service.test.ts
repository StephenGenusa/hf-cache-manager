import { realpath } from 'node:fs/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MachineProfile } from '../../src/core/advice/types';
import { readFs, type ReadFs } from '../../src/core/fsx';
import { SafeFs } from '../../src/core/safe-fs';
import type { Group, Repo } from '../../src/core/types';
import { headerFiles } from '../../src/main/advice-service';
import { AppSettingsStore, DEFAULT_ADVICE } from '../../src/main/app-settings';
import { createCorePort, type CorePort } from '../../src/main/core-port';
import { inProcessScanRunner } from '../../src/main/scan-client';
import { AppServices, type ServicesDeps } from '../../src/main/services';
import type { ApiResult } from '../../src/shared/api';
import { buildAppFixture, type AppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';
import { buildFixture, type Fixture } from '../helpers/fixture';
import { guardedFs } from '../helpers/guarded-fs';
import { treeDigest } from '../helpers/tree-digest';

useCanaries();
beforeEach(() => expect.hasAssertions());

const Q = 'unsloth/Qwen3.6-27B-GGUF';
const NOW = 1_800_000_000_000;
const GiB = 1024 ** 3;
const NVIDIA_24: MachineProfile = {
  platform: 'linux', ramBytes: 64 * GiB, gpuName: 'Test GPU', gpuBytes: 24 * GiB, gpuKind: 'nvidia', computeCap: 8.9, drivesDisplay: false,
};
const disposers: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const fx of disposers.splice(0)) await fx.dispose(); });

function unwrap<T>(r: ApiResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

type Fx = { root: string; home: string; env: NodeJS.ProcessEnv; userDataDir: string };
function harness(fx: Fx, over: Partial<ServicesDeps> = {}): { svc: AppServices; port: CorePort; deps: ServicesDeps } {
  const port = createCorePort({
    userDataDir: fx.userDataDir, env: fx.env, home: fx.home, offline: true, now: () => NOW,
    makeSafeFs: (roots) => SafeFs.create(roots, guardedFs()),
  });
  const deps: ServicesDeps = {
    env: fx.env, home: fx.home, userDataDir: fx.userDataDir, port, platform: 'linux', now: () => NOW,
    scanRunner: inProcessScanRunner, emitProgress: () => undefined,
    makeUserSafeFs: (dir) => SafeFs.create({ hubRoot: dir, viewRoots: [], holdRoot: null }, guardedFs()),
    ...over,
  };
  return { svc: new AppServices(deps), port, deps };
}
async function app(over: Partial<ServicesDeps> = {}): Promise<{ fx: AppFixture; svc: AppServices; port: CorePort }> {
  const fx = await buildAppFixture();
  disposers.push(fx);
  return { fx, ...harness(fx, over) };
}

// ---------- a minimal GGUF v3 writer (tests only) ----------
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string): Buffer => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
function gguf(kv: Record<string, string | number>, tensors: number[][]): Uint8Array {
  const kvs = Object.entries(kv).map(([k, v]) => (typeof v === 'string'
    ? Buffer.concat([str(k), u32(8), str(v)]) : Buffer.concat([str(k), u32(4), u32(v)])));
  const infos = tensors.map((dims, i) => Buffer.concat([str(`blk.${i}.w`), u32(dims.length), ...dims.map(u64), u32(0), u64(0)]));
  return new Uint8Array(Buffer.concat([Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(kvs.length), ...kvs, ...infos]));
}
const META = {
  'general.architecture': 'llama', 'general.file_type': 7, 'llama.block_count': 4, 'llama.attention.head_count': 8,
  'llama.attention.head_count_kv': 2, 'llama.embedding_length': 512, 'llama.context_length': 8192,
};

async function shardedFixture(): Promise<Fixture & { userDataDir: string }> {
  const fx = await buildFixture({
    repos: [{
      id: 'org/Shard-GGUF', snapshots: [{ files: [
        { path: 'Shard-Q8_0-00002-of-00002.gguf', blob: { key: 's2', content: gguf({}, [[1000, 1000]]) } },
        { path: 'Shard-Q8_0-00001-of-00002.gguf', blob: { key: 's1', content: gguf(META, [[1000, 1000]]) } },
        { path: 'Shard-Q4_0.gguf', blob: { key: 'gone', bytes: 50, storage: 'store', danglingStore: true } },
      ] }],
    }, {
      id: 'org/Awq', snapshots: [{ files: [
        { path: 'model.safetensors', blob: { key: 'aw', bytes: 100 } },
        { path: 'config.json', blob: { key: 'cfg', content: '{"quantization_config":{"quant_method":"awq"}}' } },
      ] }],
    }, {
      id: 'org/Bare', snapshots: [{ files: [
        { path: 'model.safetensors', blob: { key: 'bw', bytes: 100 } },
        { path: 'config.json', blob: { key: 'bad', content: '{not json' } },
      ] }],
    }, {
      id: 'org/Pipe', snapshots: [{ files: [
        { path: 'model_index.json', blob: { key: 'pi', content: '{"_class_name":"StableDiffusionPipeline","unet":["diffusers","UNet2DConditionModel"]}' } },
        { path: 'unet/config.json', blob: { key: 'pu', content: '{}' } },
        { path: 'unet/model.onnx', blob: { key: 'po', bytes: 100 } },
      ] }],
    }, {
      id: 'org/embed', snapshots: [{ files: [
        { path: 'config.json', blob: { key: 'ec', content: '{"architectures":["BertModel"]}' } },
        { path: 'model.safetensors', blob: { key: 'ew', bytes: 100 } },
        { path: 'onnx/model.onnx', blob: { key: 'eo', bytes: 100 } },
      ] }],
    }],
  });
  disposers.push(fx);
  return Object.assign(fx, { userDataDir: fx.root });
}

test('advice(Q): one entry per group of repoDetail(Q), same order; repo parts round-trip; nothing on disk changes', async () => {
  const { fx, svc } = await app({ detectMachine: () => Promise.resolve(NVIDIA_24) });
  const before = await treeDigest(fx.root);
  const detail = unwrap(await svc.repoDetail(Q));
  const adv = unwrap(await svc.advice(Q));
  expect(adv.repoId).toBe(Q);
  expect(adv.groups.map((g) => g.key)).toEqual(detail.groups.map((g) => g.key));
  expect(adv.repoParts.map((p) => p.text).join('')).toBe(Q);
  for (const [i, g] of adv.groups.entries()) {
    const dg = detail.groups[i]!;
    expect(g.labelParts.map((p) => p.text).join('')).toBe(dg.label);
    expect(g.files.map((f) => f.relpath)).toEqual(dg.files.map((f) => f.relpath));
    for (const f of g.files) expect(f.parts.map((p) => p.text).join('')).toBe(f.relpath);
  }
  expect(adv.basis.length).toBeGreaterThan(0);
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('the Q8_0 header is read once across two advice calls (cached by etag) and never during scan', async () => {
  const { fx, svc, port } = await app({ detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const spy = vi.spyOn(port, 'readGgufHeaders');
  unwrap(await svc.scan());
  expect(spy).not.toHaveBeenCalled();
  unwrap(await svc.advice(Q));
  const q8Blob = await realpath(fx.repo(Q).blobOf('Qwen3.6-27B-Q8_0.gguf'));
  const q8 = (): number => spy.mock.calls.filter(([paths]) => paths.length === 1 && paths[0] === q8Blob).length;
  expect(q8()).toBe(1);
  const first = spy.mock.calls.length;
  unwrap(await svc.advice(Q));
  expect(q8()).toBe(1);
  expect(spy.mock.calls.length).toBe(first);
  // the fixture payloads are not GGUF: every weight group's shape is unknown, never guessed from the name
  const adv = unwrap(await svc.advice(Q));
  const q8Group = adv.groups.find((g) => g.key === 'quant:Q8_0')!;
  expect(q8Group.tint).toBeNull();
  expect(q8Group.reason).toContain('Model shape unknown');
});

test('only quant, mmproj and draft groups have headers read', async () => {
  const { svc, port } = await app();
  const spy = vi.spyOn(port, 'readGgufHeaders');
  unwrap(await svc.advice(Q));
  const all = spy.mock.calls.flatMap(([paths]) => paths);
  expect(all.length).toBeGreaterThan(0);
  const detail = unwrap(await svc.repoDetail(Q));
  const readable = detail.groups.filter((g) => ['quant', 'mmproj', 'draft'].includes(g.kind)).length;
  expect(spy.mock.calls.length).toBeLessThanOrEqual(readable);
  expect(spy.mock.calls.length).toBeGreaterThan(0);
});

test('shards are read in shard order (the first carries the metadata); a dangling blob is "Model shape unknown"', async () => {
  const fx = await shardedFixture();
  const { svc, port } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const spy = vi.spyOn(port, 'readGgufHeaders');
  const before = await treeDigest(fx.root);
  const adv = unwrap(await svc.advice('org/Shard-GGUF'));
  expect(adv.basis).toContain('Test GPU');
  const sharded = spy.mock.calls.find(([paths]) => paths.length === 2);
  const r = fx.repo('org/Shard-GGUF');
  expect(sharded?.[0]).toEqual([await realpath(r.blobOf('Shard-Q8_0-00001-of-00002.gguf')), await realpath(r.blobOf('Shard-Q8_0-00002-of-00002.gguf'))]);
  const q8 = adv.groups.find((g) => g.key === 'quant:Q8_0')!;
  expect(q8.reason).not.toContain('Model shape unknown');
  expect(q8.tint).not.toBeNull();
  const q4 = adv.groups.find((g) => g.key === 'quant:Q4_0')!;
  expect(q4.tint).toBeNull();
  expect(q4.reason).toContain('Model shape unknown');
  // the dangling blob is never opened
  expect(spy.mock.calls.every(([paths]) => paths.length === 2)).toBe(true);
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('config.json quantization_config decides the repo format, read the way the classifier reads it', async () => {
  const fx = await shardedFixture();
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  expect(unwrap(await svc.advice('org/Awq')).repoLine).not.toBeNull();
  // unreadable JSON: no quantization_config, format unknown, and no shape: no green, the reason names it
  expect(unwrap(await svc.advice('org/Bare')).repoLine).toMatchObject({
    tint: null, reason: 'Model shape unknown: config.json unreadable or missing the layer or head counts' });
});

test('the repo line follows the classifier: a diffusers pipeline gets size only (no ONNX red), a transformers repo keeps it', async () => {
  const fx = await shardedFixture();
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  expect(unwrap(await svc.repoDetail('org/Pipe')).kinds[0]).toBe('diffusers');
  // its only weights are ONNX, which the counting rule does not count (safetensors, else .bin / .pt / .pth): no size, no red
  expect(unwrap(await svc.advice('org/Pipe')).repoLine).toMatchObject({ tint: null, reason: 'No safetensors or PyTorch weights to size' });
  expect(unwrap(await svc.repoDetail('org/embed')).kinds[0]).toBe('transformers');
  expect(unwrap(await svc.advice('org/embed')).repoLine).toMatchObject({ tint: 'red', reason: 'None of your tools load ONNX language models' });
});

// ---------- one judgment for repos of plain weights ----------
const LLAMA_CONFIG = JSON.stringify({ model_type: 'llama', num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8,
  hidden_size: 4096, torch_dtype: 'bfloat16', max_position_embeddings: 131072 });
const INDEX = JSON.stringify({ metadata: {}, weight_map: {
  'a.weight': 'model-00001-of-00002.safetensors', 'b.weight': 'model-00002-of-00002.safetensors', 'c.weight': 'model-00002-of-00002.safetensors' } });
const BIN_INDEX = JSON.stringify({ weight_map: { 'a.weight': 'pytorch_model-00001-of-00002.bin', 'b.weight': 'pytorch_model-00002-of-00002.bin' } });
const llamaFiles = (key: string, shards: Array<1 | 2>) => [
  { path: 'config.json', blob: { key: `${key}-cfg`, content: LLAMA_CONFIG } },
  { path: 'model.safetensors.index.json', blob: { key: `${key}-idx`, content: INDEX } },
  ...shards.map((n) => ({ path: `model-0000${n}-of-00002.safetensors`, blob: { key: `${key}-w${n}`, bytes: 1000 } })),
  { path: 'tokenizer.json', blob: { key: `${key}-tok`, content: '{}' } },
];
async function plainFixture(): Promise<Fixture & { userDataDir: string }> {
  const fx = await buildFixture({
    repos: [
      { id: 'org/Llama-8B', snapshots: [{ files: llamaFiles('ok', [1, 2]) }] },
      { id: 'org/Llama-2-Both', snapshots: [{ files: [...llamaFiles('both', [1, 2]),
        { path: 'pytorch_model.bin.index.json', blob: { key: 'both-bidx', content: BIN_INDEX } },
        { path: 'pytorch_model-00001-of-00002.bin', blob: { key: 'both-b1', bytes: 1000 } },
        { path: 'pytorch_model-00002-of-00002.bin', blob: { key: 'both-b2', bytes: 1000 } }] }] },
      { id: 'org/Llama-Leftover', snapshots: [{ files: [...llamaFiles('left', [1, 2]),
        { path: 'pytorch_model.bin.index.json', blob: { key: 'left-bidx', content: BIN_INDEX } }] }] },
      { id: 'org/Mistral-7B', snapshots: [{ files: [...llamaFiles('mis', [1, 2]),
        { path: 'consolidated.safetensors', blob: { key: 'mis-cons', bytes: 1500 } }] }] },
      { id: 'org/SDXL', snapshots: [{ files: [
        { path: 'model_index.json', blob: { key: 'sd-mi', content: JSON.stringify({ _class_name: 'StableDiffusionXLPipeline',
          unet: ['diffusers', 'UNet2DConditionModel'], text_encoder: ['transformers', 'CLIPTextModel'], vae: ['diffusers', 'AutoencoderKL'],
          scheduler: ['diffusers', 'EulerDiscreteScheduler'] }) } },
        { path: 'unet/config.json', blob: { key: 'sd-uc', content: '{}' } },
        { path: 'unet/diffusion_pytorch_model.fp16.safetensors', blob: { key: 'sd-u16', bytes: 1000 } },
        { path: 'unet/diffusion_pytorch_model.safetensors', blob: { key: 'sd-u32', bytes: 2000 } },
        { path: 'unet/diffusion_pytorch_model.bin.index.json', blob: { key: 'sd-ubi', content: BIN_INDEX } },
        { path: 'text_encoder/model.fp16.safetensors', blob: { key: 'sd-t16', bytes: 100 } },
        { path: 'text_encoder/model.safetensors', blob: { key: 'sd-t32', bytes: 200 } },
        { path: 'vae/diffusion_pytorch_model.fp16.safetensors', blob: { key: 'sd-v16', bytes: 10 } },
        { path: 'vae/diffusion_pytorch_model.safetensors', blob: { key: 'sd-v32', bytes: 20 } },
        { path: 'scheduler/scheduler_config.json', blob: { key: 'sd-sc', content: '{}' } },
      ] }] },
      { id: 'org/Llama-8B-Missing', snapshots: [{ files: llamaFiles('miss', [1]) }] },
      { id: 'org/Llama-8B-Partial', snapshots: [{ files: llamaFiles('part', [1, 2]) }], incomplete: [{ bytes: 10 }] },
      { id: 'org/Llama-8B-BadIndex', snapshots: [{ files: [...llamaFiles('bad', [1, 2]).filter((f) => f.path !== 'model.safetensors.index.json'),
        { path: 'model.safetensors.index.json', blob: { key: 'bad-idx', content: '{"weight_map": [1]}' } }] }] },
      { id: 'mlx-community/Llama-8B-4bit', snapshots: [{ files: [
        { path: 'config.json', blob: { key: 'mlx-cfg', content: JSON.stringify({ ...JSON.parse(LLAMA_CONFIG), quantization: { bits: 4, group_size: 64 } }) } },
        { path: 'model.safetensors', blob: { key: 'mlx-w', bytes: 1000 } },
      ] }] },
    ],
  });
  disposers.push(fx);
  const userDataDir = join(fx.root, 'userdata');   // as the app fixture does: settings live beside the hub, not in it
  await mkdir(userDataDir);
  return Object.assign(fx, { userDataDir });
}

test('a BF16 transformers repo gets one judgment from config.json: convert to GGUF, or green with vLLM; rows untinted', async () => {
  const fx = await plainFixture();
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const before = await treeDigest(fx.root);
  const adv = unwrap(await svc.advice('org/Llama-8B'));
  expect(adv.repoLine).toMatchObject({ tint: 'yellow', reason: 'Fits, but your tools need it converted to GGUF; vLLM or transformers can run it as is' });
  expect(adv.repoLine!.facts).toContain('KV cache 4.3 GB (32K context, F16)');   // 32 layers x 8 KV heads x 128 from config.json
  for (const g of adv.groups) expect(g.tint).toBeNull();
  expect(await treeDigest(fx.root)).toEqual(before);   // advice reads config.json and the index, never writes
  unwrap(await svc.setAdviceSettings({ ...DEFAULT_ADVICE, tools: ['vllm'] }));
  expect(unwrap(await svc.advice('org/Llama-8B')).repoLine).toMatchObject({ tint: 'green', reason: 'Runs here with vLLM / SGLang' });
});

test('.bin copies beside safetensors are left out; with only GGUF tools the repo needs converting', async () => {
  const fx = await plainFixture();
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const line = unwrap(await svc.advice('org/Llama-2-Both')).repoLine!;
  expect(line).toMatchObject({ tint: 'yellow', reason: 'Fits, but your tools need it converted to GGUF; vLLM or transformers can run it as is' });
  expect(line.facts).toContain('not counted, duplicates of the same weights: pytorch_model-00001-of-00002.bin, pytorch_model-00002-of-00002.bin');
  expect(line.facts).toContain('weights 2.0 kB');   // the two 1000 B safetensors shards the index lists; no .bin, no index bytes
});

test('a leftover .bin index without its .bin files is ignored when the safetensors are counted: green with vLLM', async () => {
  const fx = await plainFixture();
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  unwrap(await svc.setAdviceSettings({ ...DEFAULT_ADVICE, tools: ['vllm'] }));
  expect(unwrap(await svc.advice('org/Llama-Leftover')).repoLine).toMatchObject({ tint: 'green', reason: 'Runs here with vLLM / SGLang' });
});

test('a consolidated.safetensors beside the indexed shards is a duplicate: judged on the shards', async () => {
  const fx = await plainFixture();
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const line = unwrap(await svc.advice('org/Mistral-7B')).repoLine!;
  expect(line.facts).toContain('weights 2.0 kB');
  expect(line.facts).toContain('not counted, duplicates of the same weights: consolidated.safetensors');
});

test('an SDXL-like pipeline counts each component\'s fp16 variant once; a leftover unet .bin index is not incomplete', async () => {
  const fx = await plainFixture();
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  expect(unwrap(await svc.repoDetail('org/SDXL')).kinds[0]).toBe('diffusers');
  const line = unwrap(await svc.advice('org/SDXL')).repoLine!;
  expect(line).toMatchObject({ tint: null, reason: 'Fits in 24 GB (1.1 kB of weights; runs in a diffusers app such as ComfyUI)' });   // 1000 + 100 + 10
  expect(line.facts.some((x) => x.startsWith('not counted, duplicates of the same weights: '))).toBe(true);
});

test('a missing shard, an unreadable index or a .incomplete file means no green, and the reason says so', async () => {
  const fx = await plainFixture();
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  unwrap(await svc.setAdviceSettings({ ...DEFAULT_ADVICE, tools: ['vllm'] }));
  for (const id of ['org/Llama-8B-Missing', 'org/Llama-8B-Partial', 'org/Llama-8B-BadIndex']) {
    expect(unwrap(await svc.advice(id)).repoLine, id).toMatchObject({ tint: null, reason: 'Incomplete download: some weight files are missing or still downloading' });
  }
});

test('MLX on Linux is still red', async () => {
  const fx = await plainFixture();
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  expect(unwrap(await svc.advice('mlx-community/Llama-8B-4bit')).repoLine).toMatchObject({ tint: 'red', reason: 'MLX is Apple-only; nothing on this Linux PC can load it' });
});

test('with qwenGgufHeaders every Qwen quant is read: exactly one green quant, and the other green row is the mmproj', async () => {
  const fx = await buildAppFixture({ qwenGgufHeaders: true });
  disposers.push(fx);
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const adv = unwrap(await svc.advice(Q));
  const quants = adv.groups.filter((g) => g.key.startsWith('quant:'));
  expect(quants.length).toBeGreaterThanOrEqual(4);
  for (const g of quants) expect(g.reason, g.key).not.toMatch(/unknown|could not be read|Incomplete/);
  expect(quants.filter((g) => g.tint === 'green').map((g) => g.key)).toEqual(['quant:BF16']);
  expect(adv.groups.filter((g) => g.tint === 'green' && !g.key.startsWith('quant:')).map((g) => g.key)).toEqual([expect.stringMatching(/^mmproj:/)]);
});

test('headerFiles sorts a group by shard index and refuses a group with a missing or dangling blob', () => {
  const file = (relpath: string, etag: string | null) => ({ relpath, blobEtag: etag }) as Group['files'][number];
  const blob = (p: string, dangling = false) => ({ path: p, dangling }) as Repo['blobs'][string];
  const repo = { blobs: { a: blob('/b/a'), b: blob('/b/b'), c: blob('/b/c', true) } } as unknown as Repo;
  const g = (files: Group['files']) => ({ files }) as Group;
  expect(headerFiles(repo, g([file('x-00002-of-00002.gguf', 'b'), file('x-00001-of-00002.gguf', 'a')])))
    .toEqual({ paths: ['/b/a', '/b/b'], key: 'a\0b' });
  expect(headerFiles(repo, g([file('x.gguf', 'c')]))).toBeNull();
  expect(headerFiles(repo, g([file('x.gguf', 'zz')]))).toBeNull();
  expect(headerFiles(repo, g([]))).toBeNull();
});

test('advice for a repo not in the cache is NOT_FOUND', async () => {
  const { svc } = await app();
  const r = await svc.advice('nobody/nothing');
  expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

test('advice asked before startup detection finishes waits for it and uses the detected GPU', async () => {
  let release!: (m: MachineProfile) => void;
  const pending = new Promise<MachineProfile>((res) => { release = res; });
  const fx = await shardedFixture();
  const { svc } = harness(fx, { detectMachine: () => pending });
  void svc.redetectMachine();
  let settled = false;
  const early = svc.advice('org/Shard-GGUF').then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  expect(settled).toBe(false);   // still waiting for detection
  release(NVIDIA_24);
  const adv = unwrap(await early);
  expect(adv.basis).toContain('Test GPU');
  expect(adv.basis).not.toContain('GPU memory not set');
  expect(adv.groups.find((g) => g.key === 'quant:Q8_0')!.reason).not.toBe('Set your GPU memory in Settings for size advice');
});

test('machineProfile: settings defaults, effective = overrides over detection, defaultTools = llama.cpp + configured views', async () => {
  const { svc } = await app({ detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const p = unwrap(await svc.machineProfile());
  expect(p.settings).toEqual(DEFAULT_ADVICE);
  expect(p.effective).toEqual({ gpuBytes: 24 * GiB, ramBytes: 64 * GiB, gpuKind: 'nvidia' });
  expect(p.defaultTools).toEqual(['llama.cpp', 'lmstudio']);   // the app fixture configures only lmstudio
});

test('setAdviceSettings saves the advice block and keeps autoEmptyDays; overrides change the effective profile', async () => {
  const { fx, svc } = await app({ detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.setAutoEmptyDays(7));
  const s = { ...DEFAULT_ADVICE, gpuBytes: 12 * GiB, tools: ['ollama' as const] };
  const p = unwrap(await svc.setAdviceSettings(s));
  expect(p.settings).toEqual(s);
  expect(p.effective.gpuBytes).toBe(12 * GiB);
  const stored = await new AppSettingsStore(fx.userDataDir).loadChecked();
  expect(stored).toEqual({ settings: { autoEmptyDays: 7, advice: s }, error: null, adviceError: null, downloadsError: null });
});

test('without an injected detector nothing is spawned: the profile has no GPU', async () => {
  const { svc } = await app();
  const p = unwrap(await svc.redetectMachine());
  expect(p.detected).toMatchObject({ platform: 'linux', gpuBytes: null, gpuName: null });
  expect(p.detected.ramBytes).toBeGreaterThan(0);
});

test('redetectMachine runs detection again', async () => {
  const detect = vi.fn(() => Promise.resolve(NVIDIA_24));
  const { svc } = await app({ detectMachine: detect });
  unwrap(await svc.redetectMachine());
  unwrap(await svc.redetectMachine());
  expect(detect).toHaveBeenCalledTimes(2);
});

test('readGgufHeaders keeps the given order and is null when any file is missing or not GGUF', async () => {
  const fx = await shardedFixture();
  const { port } = harness(fx);
  const r = fx.repo('org/Shard-GGUF');
  const s1 = r.blobOf('Shard-Q8_0-00001-of-00002.gguf');
  const s2 = r.blobOf('Shard-Q8_0-00002-of-00002.gguf');
  const both = await port.readGgufHeaders([s1, s2]);
  expect(both?.map((h) => h.kv.get('general.architecture') ?? null)).toEqual(['llama', null]);
  // bytes that are not a usable header are a content fact: null
  expect(await port.readGgufHeaders([s1, fx.repo('org/Awq').blobOf('config.json')])).toBeNull();
  expect(await port.readGgufHeaders([s1, fx.repo('org/Awq').blobOf('model.safetensors')])).toBeNull();
  // an I/O error rejects with its errno code, so the caller can tell it from content
  await expect(port.readGgufHeaders([s1, `${s2}.missing`])).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await port.readGgufHeaders([fx.root])).toBeNull();   // not a regular file: never opened
  expect(await port.readGgufHeaders([])).toEqual([]);
});

test('an I/O error is not cached: that call has no shape, the next one reads again', async () => {
  const fx = await shardedFixture();
  const { svc, port } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const real = port.readGgufHeaders.bind(port);
  const spy = vi.spyOn(port, 'readGgufHeaders')
    .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })))
    .mockImplementation(real);
  const first = unwrap(await svc.advice('org/Shard-GGUF')).groups.find((g) => g.key === 'quant:Q8_0')!;
  expect(first.tint).toBeNull();
  expect(first.reason).toContain('Model shape unknown');
  const second = unwrap(await svc.advice('org/Shard-GGUF')).groups.find((g) => g.key === 'quant:Q8_0')!;
  expect(second.reason).not.toContain('Model shape unknown');
  expect(second.tint).not.toBeNull();
  expect(spy).toHaveBeenCalledTimes(2);
  unwrap(await svc.advice('org/Shard-GGUF'));
  expect(spy).toHaveBeenCalledTimes(2);   // the good read is cached
});

test('a header that is not GGUF is cached (a content fact), so it is read once', async () => {
  const { svc, port } = await app({ detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const spy = vi.spyOn(port, 'readGgufHeaders');
  unwrap(await svc.advice(Q));
  const n = spy.mock.calls.length;
  expect(n).toBeGreaterThan(0);
  await Promise.all(spy.mock.results.map((r) => expect(r.value).resolves.toBeNull()));
  unwrap(await svc.advice(Q));
  expect(spy.mock.calls.length).toBe(n);
});

test('setAdviceSettings never overwrites an unreadable settings.json (SETTINGS, nothing written)', async () => {
  const { fx, svc } = await app();
  const file = join(fx.userDataDir, 'settings.json');
  for (const text of ['{not json', JSON.stringify({ autoEmptyDays: 'soon', advice: DEFAULT_ADVICE })]) {
    await writeFile(file, text);
    const r = await svc.setAdviceSettings({ ...DEFAULT_ADVICE, gpuBytes: 12 * GiB });
    expect(r).toEqual({ ok: false, error: {
      code: 'SETTINGS', message: 'Settings could not be read, so they were not changed. Fix or remove settings.json first.',
    } });
    expect(await readFile(file, 'utf8')).toBe(text);
  }
});

test('machineProfile carries adviceError when the advice block was ignored', async () => {
  const { fx, svc } = await app();
  expect(unwrap(await svc.machineProfile()).adviceError).toBeNull();
  await writeFile(join(fx.userDataDir, 'settings.json'), JSON.stringify({ autoEmptyDays: 7, advice: { ...DEFAULT_ADVICE, context: 4096 } }));
  const p = unwrap(await svc.machineProfile());
  expect(p.adviceError).toContain('advice settings ignored');
  expect(p.settings).toEqual(DEFAULT_ADVICE);
});

test('setAdviceSettings and setAutoEmptyDays at once never lose either change (both orders)', async () => {
  const { fx, svc } = await app();
  const s = { ...DEFAULT_ADVICE, gpuBytes: 12 * GiB };
  for (const order of ['advice-first', 'days-first'] as const) {
    unwrap(await svc.setAutoEmptyDays(14));
    unwrap(await svc.setAdviceSettings(DEFAULT_ADVICE));
    const both = order === 'advice-first'
      ? [svc.setAdviceSettings(s), svc.setAutoEmptyDays(null)] as const
      : [svc.setAutoEmptyDays(null), svc.setAdviceSettings(s)] as const;
    for (const r of await Promise.all(both)) expect(r.ok, order).toBe(true);
    const stored = JSON.parse(await readFile(join(fx.userDataDir, 'settings.json'), 'utf8'));
    expect(stored, order).toEqual({ autoEmptyDays: null, advice: s });
  }
});

test('exactly the blobs of the quant, mmproj and draft groups are read', async () => {
  const { fx, svc, port } = await app();
  const spy = vi.spyOn(port, 'readGgufHeaders');
  unwrap(await svc.advice(Q));
  const read = new Set(spy.mock.calls.flatMap(([paths]) => paths));
  const detail = unwrap(await svc.repoDetail(Q));
  const want = new Set<string>();
  for (const g of detail.groups.filter((x) => ['quant', 'mmproj', 'draft'].includes(x.kind) && !x.locked)) {
    for (const f of g.files) want.add(await realpath(fx.repo(Q).blobOf(f.relpath)));
  }
  expect(read).toEqual(want);
});

test('two advice calls at once read a header once; if that read fails, both get "Model shape unknown"', async () => {
  const fx = await shardedFixture();
  const { svc, port } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  const real = port.readGgufHeaders.bind(port);
  const spy = vi.spyOn(port, 'readGgufHeaders').mockImplementation(real);
  const [a, b] = await Promise.all([svc.advice('org/Shard-GGUF'), svc.advice('org/Shard-GGUF')]);
  expect(unwrap(a)).toEqual(unwrap(b));
  expect(spy).toHaveBeenCalledTimes(1);

  const fx2 = await shardedFixture();
  const h2 = harness(fx2, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await h2.svc.redetectMachine());
  vi.spyOn(h2.port, 'readGgufHeaders').mockImplementation(() => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })));
  const both = await Promise.all([h2.svc.advice('org/Shard-GGUF'), h2.svc.advice('org/Shard-GGUF')]);
  for (const r of both) expect(unwrap(r).groups.find((g) => g.key === 'quant:Q8_0')!.reason).toContain('Model shape unknown');
});

test('a blob that is not a regular file (a FIFO) is never opened', async () => {
  const fx = await shardedFixture();
  const s1 = fx.repo('org/Shard-GGUF').blobOf('Shard-Q8_0-00001-of-00002.gguf');
  const fifoFs = { ...readFs, stat: (async () => ({ isFile: () => false })) as unknown as ReadFs['stat'] };
  const port = createCorePort({ userDataDir: fx.root, env: fx.env, home: fx.home, offline: true, fs: fifoFs });
  expect(await port.readGgufHeaders([s1])).toBeNull();
});

test('a ComfyUI repo gets the packaged-for note and no format advice, end to end from its config.json', async () => {
  const config = JSON.stringify({ quantization: 'w6a8_int8', format: 'w6a8', weight_bits: 6, activation_bits: 8, loader: 'comfyui', library: 'comfy-kitchen' });
  const fx = await buildFixture({ repos: [{ id: 'realrebelai/Rebels_w6a8s', snapshots: [{ files: [
    { path: 'config.json', blob: { key: 'cfg', content: config } },
    { path: 'FLUX/flux3_image_klein_w6a8.safetensors', blob: { key: 'flux', bytes: 1000 } },
  ] }] }] }) as Fixture & { userDataDir: string };
  disposers.push(fx);
  fx.userDataDir = join(fx.root, 'user-data');
  await mkdir(fx.userDataDir, { recursive: true });
  const { svc } = harness(fx, { detectMachine: () => Promise.resolve(NVIDIA_24) });
  unwrap(await svc.redetectMachine());
  unwrap(await svc.scan());
  expect(unwrap(await svc.repoDetail('realrebelai/Rebels_w6a8s')).kinds[0]).toBe('diffusion');
  const adv = unwrap(await svc.advice('realrebelai/Rebels_w6a8s'));
  expect(adv.repoLine).toMatchObject({ tint: null, reason: 'Packaged for ComfyUI, not for language-model tools' });
  expect(adv.groups.map((g) => g.key)).toContain('root-file:FLUX/flux3_image_klein_w6a8.safetensors');
});
