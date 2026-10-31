// The shared app fixture for Tasks 3-7 and 13 (plan 06). It must not import vitest: callers pass their own
// CanaryContext (Playwright) or rely on the vitest one (`useCanaries()` in the calling test file).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanaryContext } from './canary-core';
import { buildFixture, type BlobSpec, type FileSpec, type Fixture } from './fixture';

export const COMMIT = 'a3f9c1e5b2d4f6a8c0e1f3a5b7d9e1f3a5b7c9d1';

const Q = 'unsloth/Qwen3.6-27B-GGUF';
const FLUX = 'black-forest-labs/FLUX.1-dev';
const MODEL_INDEX = JSON.stringify({
  _class_name: 'FluxPipeline',
  transformer: ['diffusers', 'FluxTransformer2DModel'],
  vae: ['diffusers', 'AutoencoderKL'],
  text_encoder: ['transformers', 'CLIPTextModel'],
  tokenizer: ['transformers', 'CLIPTokenizer'],
  scheduler: ['diffusers', 'FlowMatchEulerDiscreteScheduler'],
});

/** Payload bytes per file. model_index.json is real JSON naming the five components, so its size is its length (the brief's 10 cannot hold that). */
export const SIZES = {
  qUdQ4: 1760, qQ8: 2870, qBf16a: 4990, qBf16b: 390, qQ6: 2210, qMmproj: 90, qReadme: 20, qImage: 30,
  fluxIndex: Buffer.byteLength(MODEL_INDEX), fluxTransformer: 100, fluxVae: 50, fluxVaeConfig: 5, fluxTextEncoder: 40,
  fluxTokenizer: 5, fluxScheduler: 5, fluxSingle: 300,
  sharedConfig: 5, sharedPayload: 500, dupeConfig: 5, tiny: 120, partialIncomplete: 40,
} as const;

export interface AppFixture extends Fixture {
  lmstudioRoot: string;
  userDataDir: string;
  configFile: string;
}

export interface AppFixtureOptions {
  massRemovalState?: boolean;
  /** Canary context; defaults to the current vitest one. */
  canaries?: CanaryContext;
  /** See BuildOptions.rootPrefix (`hfcm-e2e-`). */
  rootPrefix?: 'hfcm-fx-' | 'hfcm-e2e-';
  /** Every Qwen GGUF quant file carries a tiny valid GGUF header (same sizes), so keep advice can read every shape. Default off. */
  qwenGgufHeaders?: boolean;
}

/**
 * A tiny valid GGUF v3 header (magic, counts, a few KV pairs unless `meta` is false, one tensor info per entry of
 * `tensors`) zero-padded to `size` bytes, so the keep-advice reader finds a model shape. Only the Qwen quant files carry
 * it, and only with `qwenGgufHeaders`; every size stays as in SIZES. A later shard passes `meta: false`.
 */
export function tinyGgufHeader(size: number, fileType = 7, tensors: number[] = [4096, 4096], meta = true): Uint8Array {
  const parts: Buffer[] = [];
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (t: string): Buffer => Buffer.concat([u64(Buffer.byteLength(t)), Buffer.from(t)]);
  const kvStr = (k: string, v: string): Buffer => Buffer.concat([str(k), u32(8), str(v)]);
  const kvU32 = (k: string, v: number): Buffer => Buffer.concat([str(k), u32(4), u32(v)]);
  const kvs = !meta ? [] : [
    kvStr('general.architecture', 'llama'), kvU32('general.file_type', fileType), kvU32('llama.block_count', 2),
    kvU32('llama.attention.head_count', 4), kvU32('llama.attention.head_count_kv', 2), kvU32('llama.embedding_length', 64),
    kvU32('llama.context_length', 4096),
  ];
  const tensor = (name: string, dim: number): Buffer => Buffer.concat([str(name), u32(1), u64(dim), u32(8), u64(0)]);
  parts.push(Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(kvs.length), ...kvs, ...tensors.map((d, i) => tensor(`blk.${i}.w`, d)));
  const head = Buffer.concat(parts);
  if (head.length > size) throw new Error('tiny GGUF header does not fit');
  return Buffer.concat([head, Buffer.alloc(size - head.length)]);
}

const w = (path: string, bytes: number, key?: string, storage?: BlobSpec['storage']): FileSpec => ({
  path, blob: { key: key ?? `${path}`, bytes, ...(storage ? { storage } : {}) },
});
const text = (path: string, content: string): FileSpec => ({ path, blob: { key: path, content } });

export async function buildAppFixture(opts: AppFixtureOptions = {}): Promise<AppFixture> {
  const hdr = opts.qwenGgufHeaders === true;
  /** A Qwen quant file: zeros of `bytes`, or with `qwenGgufHeaders` a tiny header of that size (same blob key). */
  const qw = (path: string, bytes: number, key: string, header: () => Uint8Array): FileSpec =>
    hdr ? { path, blob: { key, content: header() } } : w(path, bytes, key);
  const q6 = (path: string): FileSpec => ({ path, blob: { key: 'q6k-shared', storage: 'hardlink',
    ...(hdr ? { content: tinyGgufHeader(SIZES.qQ6, 18) } : { bytes: SIZES.qQ6 }) } });
  const qWeights = [
    qw('Qwen3.6-27B-UD-Q4_K_XL.gguf', SIZES.qUdQ4, 'q:ud', () => tinyGgufHeader(SIZES.qUdQ4, 15)),
    qw('Qwen3.6-27B-Q8_0.gguf', SIZES.qQ8, 'q:q8', () => tinyGgufHeader(SIZES.qQ8, 7)),
    qw('BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', SIZES.qBf16a, 'q:bf1', () => tinyGgufHeader(SIZES.qBf16a, 32, [4096])),
    qw('BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf', SIZES.qBf16b, 'q:bf2', () => tinyGgufHeader(SIZES.qBf16b, 32, [4096], false)),
    q6('Qwen3.6-27B-Q6_K.gguf'), w('mmproj-F16.gguf', SIZES.qMmproj, 'q:mm'), w('README.md', SIZES.qReadme, 'q:readme'), w('images/a.png', SIZES.qImage, 'q:img'),
  ];
  const fluxFiles = [
    text('model_index.json', MODEL_INDEX),
    ...[1, 2, 3].map((n) => w(`transformer/diffusion_pytorch_model-0000${n}-of-00003.safetensors`, SIZES.fluxTransformer, `f:t${n}`)),
    w('vae/diffusion_pytorch_model.safetensors', SIZES.fluxVae, 'f:vae'), w('vae/config.json', SIZES.fluxVaeConfig, 'f:vaec'),
    w('text_encoder/model.safetensors', SIZES.fluxTextEncoder, 'f:te'), w('tokenizer/vocab.json', SIZES.fluxTokenizer, 'f:tok'),
    w('scheduler/scheduler_config.json', SIZES.fluxScheduler, 'f:sch'), w('flux1-dev.safetensors', SIZES.fluxSingle, 'f:single'),
  ];
  const shared = (path: string): FileSpec => ({ path, blob: { key: 'shared-payload', bytes: SIZES.sharedPayload, storage: 'store' } });
  const snap = (files: FileSpec[]) => [{ commit: COMMIT, files }];

  const owned = (r: { etagOf(id: string, rel: string): string }, file: string): { paths: string[]; sha256: string } => ({
    paths: [`${Q}/${file}`, `${Q}/mmproj-F16.gguf`], sha256: r.etagOf(Q, file),
  });
  const fx = await buildFixture({
    repos: [
      { id: Q, snapshots: snap(qWeights) },
      { id: FLUX, snapshots: snap(fluxFiles) },
      { id: 'org/shared-a', snapshots: snap([w('config.json', SIZES.sharedConfig, 'sa:c'), shared('model.safetensors')]) },
      { id: 'org/shared-b', snapshots: snap([w('config.json', SIZES.sharedConfig, 'sb:c'), shared('model.safetensors')]) },
      { id: 'org/dupe', snapshots: snap([w('config.json', SIZES.dupeConfig, 'd:c'), q6('model.safetensors')]) },
      { id: 'bartowski/tiny-GGUF', snapshots: snap([w('tiny-Q4_K_M.gguf', SIZES.tiny, 'tiny')]) },
      { id: 'org/partial', snapshots: snap([]), incomplete: [{ bytes: SIZES.partialIncomplete, mtimeMs: Date.now() - 86_400_000 }] },
    ],
    views: { lmstudio: opts.massRemovalState === true
      ? {
          links: { 'gone/repo/x.gguf': { raw: join('/', 'nonexistent-hub', 'models--gone--repo', 'blobs', 'f'.repeat(64)) } },
          state: { version: 1, owned: { 'gone/repo:x.gguf': { paths: ['gone/repo/x.gguf'], sha256: 'f'.repeat(64) } }, tombstones: {} },
        }
      : {
          links: {
            [`${Q}/Qwen3.6-27B-UD-Q4_K_XL.gguf`]: { repo: Q, file: 'Qwen3.6-27B-UD-Q4_K_XL.gguf' },
            [`${Q}/Qwen3.6-27B-Q8_0.gguf`]: { repo: Q, file: 'Qwen3.6-27B-Q8_0.gguf' },
            [`${Q}/mmproj-F16.gguf`]: { repo: Q, file: 'mmproj-F16.gguf' },
          },
          files: { 'bartowski/tiny-GGUF/tiny-Q4_K_M.gguf': 'user file\n' },
          state: (r) => ({ version: 1, tombstones: {}, owned: {
            [`${Q}:Qwen3.6-27B-UD-Q4_K_XL.gguf`]: owned(r, 'Qwen3.6-27B-UD-Q4_K_XL.gguf'),
            [`${Q}:Qwen3.6-27B-Q8_0.gguf`]: owned(r, 'Qwen3.6-27B-Q8_0.gguf'),
          } }),
        } },
  }, { ...(opts.canaries ? { canaries: opts.canaries } : {}), ...(opts.rootPrefix ? { rootPrefix: opts.rootPrefix } : {}) });

  const lmstudioRoot = fx.viewRoots.lmstudio!;
  const userDataDir = join(fx.root, 'userdata');
  const configFile = join(fx.root, 'config', 'config.toml');
  await mkdir(userDataDir, { recursive: true });
  await mkdir(join(fx.root, 'config'), { recursive: true });
  await writeFile(configFile, `[views.lmstudio]\nroot = "${lmstudioRoot.replaceAll('\\', '/')}"\n`);
  fx.env.HFHUB_CONFIG = configFile;
  return Object.assign(fx, { lmstudioRoot, userDataDir, configFile });
}
