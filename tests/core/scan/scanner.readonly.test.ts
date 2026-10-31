import { mkdir, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFs, type ReadFs } from '../../../src/core/fsx';
import { scanHub } from '../../../src/core/scan/scanner';
import type { CacheModel } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { folderName, hex, hubBuilder } from '../../helpers/hub-builder';
import { treeDigest } from '../../helpers/tree-digest';

useCanaries();

/** The ReadFs surface (src/core/fsx.ts): the only methods the scanner may call. */
export const READ_METHODS = new Set(['lstat', 'stat', 'readlink', 'readdir', 'readFile', 'realpath', 'statfs']);

const MUTATORS = Object.keys(nodeFs).filter((k) => !READ_METHODS.has(k)); // every FsLike mutator

/**
 * Read-only guard plus path rewriting. The scanner is given a virtual hub path that does not exist; every path
 * argument under `virtual` is mapped to `real` before reaching node fs, and realpath results are mapped back. A call
 * that bypasses this proxy (a helper using its own default readFs) therefore hits a non-existent path.
 * Every non-READ_METHODS access is recorded in `violations` before throwing, so a swallowed throw still fails.
 */
function guardedProxy(calls: string[], violations: string[], virtual: string, real: string): ReadFs {
  const toReal = (a: unknown) => (typeof a === 'string' && (a === virtual || a.startsWith(virtual + sep)) ? real + a.slice(virtual.length) : a);
  const toVirtual = (a: string) => (a === real || a.startsWith(real + sep) ? virtual + a.slice(real.length) : a);
  return new Proxy(nodeFs, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof v !== 'function') return v;
      const name = String(k);
      if (!READ_METHODS.has(name)) {
        violations.push(name);
        throw new Error(`scanner called mutating fs method ${name}`);
      }
      return async (...a: unknown[]) => {
        calls.push(name);
        const r = await (v as (...x: unknown[]) => unknown).apply(t, a.map(toReal));
        return name === 'realpath' ? toVirtual(r as string) : r;
      };
    },
  }) as unknown as ReadFs;
}

const byId = (m: CacheModel, id: string) => {
  const r = m.repos.find((x) => x.id === id);
  if (!r) throw new Error(`no repo ${id}`);
  return r;
};

const H = hex('q8-store-payload');
const Q = 'unsloth/Qwen3.6-27B-GGUF';

async function buildRealisticHub() {
  const hb = await hubBuilder();
  await hb.marker();
  const q = hb.repo(Q);
  await q.main('c2');
  await q.files('c2', {
    'Qwen3.6-27B-UD-Q4_K_XL.gguf': 400,
    'BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf': 1000,
    'BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf': 900,
    'mmproj-F16.gguf': 60,
    'README.md': '# Qwen',
  });
  const etagQ8 = hex('q8-etag');
  const S = await hb.store(H, 800, [`${folderName(Q)}/blobs/${etagQ8}`]);
  await q.storeLink(etagQ8, H);
  await q.link('c2', 'Qwen3.6-27B-Q8_0.gguf', etagQ8);
  await q.file('c1', 'Qwen3.6-27B-Q8_0.gguf', 790);

  // hostile branches
  await q.blob(hex('orphan'), 33); // orphan blob (no snapshot link)
  await q.incomplete(hex('partial'), 11); // partial download
  await q.blob('not-a-hex-name', 5); // non-hex blob name
  await writeFile(S + '.lock', ''); // lock next to a store payload
  await writeFile(join(q.folder, 'stray.txt'), 'x'); // stray root file
  await mkdir(join(q.folder, 'stray-dir')); // stray root dir
  await mkdir(join(q.folder, 'snapshots', 'c0-empty'), { recursive: true }); // empty snapshot dir

  const w = hb.repo('Qwen/Qwen3-32B');
  await w.main('c1');
  await w.files('c1', {
    'config.json': '{}',
    'model-00001-of-00002.safetensors': 500,
    'model-00002-of-00002.safetensors': 400,
    'model.safetensors.index.json': '{}',
    'tokenizer.json': '{}',
  });

  const f = hb.repo('black-forest-labs/FLUX.1-dev');
  await f.main('c1');
  await f.files('c1', {
    'model_index.json': '{"_class_name":"FluxPipeline","transformer":["diffusers","FluxTransformer2DModel"],"vae":["diffusers","AutoencoderKL"]}',
    'flux1-dev.safetensors': 2300,
    'ae.safetensors': 300,
    'transformer/config.json': '{}',
    'transformer/diffusion_pytorch_model-00001-of-00003.safetensors': 1000,
    'transformer/diffusion_pytorch_model-00002-of-00003.safetensors': 1000,
    'transformer/diffusion_pytorch_model-00003-of-00003.safetensors': 380,
    'transformer/diffusion_pytorch_model.safetensors.index.json': '{}',
    'vae/config.json': '{}',
    'vae/diffusion_pytorch_model.safetensors': 160,
    'text_encoder/model.safetensors': 240,
    'text_encoder_2/model-00001-of-00002.safetensors': 500,
    'text_encoder_2/model-00002-of-00002.safetensors': 450,
    'tokenizer/vocab.json': 9,
    'tokenizer_2/spiece.model': 7,
    'scheduler/scheduler_config.json': '{}',
    'README.md': '# FLUX',
    'dev_grid.jpg': 50,
    'LICENSE.md': 'lic',
  });

  const v = hb.repo('madebyollin/sdxl-vae-fp16-fix');
  await v.main('c1');
  await v.files('c1', {
    'config.json': '{"_class_name":"AutoencoderKL"}',
    'diffusion_pytorch_model.safetensors': 300,
    'sdxl_vae.safetensors': 300,
  });

  const d = hb.repo('HuggingFaceFW/fineweb', 'dataset');
  await d.main('c1');
  await d.file('c1', 'data/CC-MAIN-2024-10/000_00000.parquet', 200);
  return { hb, S, etagQ8 };
}

describe('scanner is read-only', () => {
  it('scanHub changes nothing, calls only read methods and never bypasses the passed fs', async () => {
    const { hb } = await buildRealisticHub();
    const before = await treeDigest(hb.root);
    const virtual = join(hb.root, 'virtual-hub-does-not-exist');
    const calls: string[] = [];
    const violations: string[] = [];
    const fs = guardedProxy(calls, violations, virtual, hb.hub);
    const viaProxy = await scanHub(virtual, fs);
    expect(violations).toEqual([]);
    expect(await treeDigest(hb.root)).toEqual(before);
    for (const m of ['lstat', 'readdir', 'readFile', 'realpath', 'readlink']) expect(calls).toContain(m);

    // A bypassing helper would have hit the non-existent virtual path; the model must equal a direct scan.
    const direct = await scanHub(hb.hub);
    const norm = (m: CacheModel, from: string) =>
      JSON.parse(JSON.stringify({ ...m, scannedAt: 0 }).split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(hb.hub).slice(1, -1)));
    expect(norm(viaProxy, virtual)).toEqual(norm(direct, hb.hub));
    expect(viaProxy.repos).toHaveLength(5);
    expect(Object.keys(viaProxy.store)).toHaveLength(1);
    expect(Object.values(viaProxy.store)[0]!.validRefs).toHaveLength(1);
    expect(viaProxy.hubRoot).toBe(virtual);
  });

  it('a realistic hub scans to the expected shape', async () => {
    const { hb, S, etagQ8 } = await buildRealisticHub();
    const m = await scanHub(hb.hub);
    expect(m.repos.map((r) => r.id)).toEqual([
      'HuggingFaceFW/fineweb', 'Qwen/Qwen3-32B', 'black-forest-labs/FLUX.1-dev',
      'madebyollin/sdxl-vae-fp16-fix', 'unsloth/Qwen3.6-27B-GGUF',
    ]);
    const q = byId(m, Q);
    expect(q.mainCommit).toBe('c2');
    expect(q.snapshots[0]).toBe(q.mainCommit);
    expect(q.blobs[etagQ8]!.storePath).toBe(S);
    expect(m.store[S]!.validRefs).toEqual([`${folderName(Q)}/blobs/${etagQ8}`]);
  });

  it('covers all eight FsLike mutators', () => expect(MUTATORS).toHaveLength(8));
  it.each(MUTATORS)('the guard records and rejects %s', (name) => {
    const violations: string[] = [];
    const fs = guardedProxy([], violations, '/v', '/r');
    expect(() => (fs as unknown as Record<string, unknown>)[name]).toThrow(`scanner called mutating fs method ${name}`);
    expect(violations).toEqual([name]);
  });
});
