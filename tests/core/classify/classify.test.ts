import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyRepo, currentFiles, detectKinds, fileBytes, groupBytes, mmprojLabel } from '../../../src/core/classify/classify';
import { scanHub } from '../../../src/core/scan/scanner';
import type { Repo, RepoType } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { guardedFs } from '../../helpers/guarded-fs';
import { hex, hubBuilder } from '../../helpers/hub-builder';
import { buildTree, f as spec } from '../support/scenarios';

useCanaries();

async function scanOne(id: string, files: Record<string, string | number>, type: RepoType = 'model'): Promise<Repo> {
  const hb = await hubBuilder();
  const rb = hb.repo(id, type);
  await rb.files('c1', files);
  await rb.main('c1');
  const m = await scanHub(hb.hub);
  const r = m.repos.find((x) => x.id === id);
  if (!r) throw new Error('no repo');
  return r;
}

const REBELS_CONFIG = JSON.stringify({ quantization: 'w6a8_int8', format: 'w6a8', weight_bits: 6, activation_bits: 8, loader: 'comfyui', library: 'comfy-kitchen' });
const CARD = (front: string): string => `---\n${front}\n---\n# Card\n`;

describe('detectKinds', () => {
  it.each([
    ['GGUF collection', 'unsloth/Qwen3.6-27B-GGUF', { 'Qwen3.6-27B-Q8_0.gguf': 800, 'README.md': '# q' }, ['gguf']],
    ['FLUX pipeline + root checkpoints', 'black-forest-labs/FLUX.1-dev', {
      'model_index.json': JSON.stringify({ _class_name: 'FluxPipeline', vae: ['diffusers', 'AutoencoderKL'], transformer: ['diffusers', 'FluxTransformer2DModel'], scheduler: ['diffusers', 'FlowMatchEulerDiscreteScheduler'] }),
      'flux1-dev.safetensors': 2300, 'ae.safetensors': 300, 'vae/config.json': '{}', 'vae/diffusion_pytorch_model.safetensors': 160,
      'transformer/config.json': '{}', 'scheduler/scheduler_config.json': '{}' },
    ['diffusers', 'single-file']],
    ['transformers', 'Qwen/Qwen3-32B', { 'config.json': '{"model_type":"qwen3"}', 'model-00001-of-00002.safetensors': 500,
      'model-00002-of-00002.safetensors': 400, 'model.safetensors.index.json': '{}', 'tokenizer.json': '{}' }, ['transformers']],
    ['transformers via .bin', 'o/old', { 'config.json': '{}', 'pytorch_model.bin': 300 }, ['transformers']],
    ['LoRA adapter (adapter_config.json)', 'o/qwen3-lora', { 'adapter_config.json': '{"peft_type":"LORA"}', 'adapter_model.safetensors': 40 }, ['adapter']],
    ['LoRA by naming, small, no config', 'o/flux-style-lora', { 'flux-style-lora.safetensors': 30 }, ['adapter', 'single-file']],
    ['single-file checkpoint', 'o/sd15', { 'v1-5-pruned-emaonly.safetensors': 400, 'v1-5-pruned-emaonly.ckpt': 400 }, ['single-file']],
    ['VAE component', 'madebyollin/sdxl-vae-fp16-fix', { 'config.json': '{"_class_name":"AutoencoderKL"}',
      'diffusion_pytorch_model.safetensors': 160, 'sdxl_vae.safetensors': 160 }, ['component']],
    ['unknown', 'o/misc', { 'notes/a.txt': 'a' }, ['unknown']],
    ['LoRA by README tag, plain file name', 'o/pixel', { 'README.md': CARD('pipeline_tag: text-to-image\nlibrary_name: diffusers\ntags: [lora]'), 'pixel_style_v2.safetensors': 40 }, ['adapter', 'single-file']],
    ['LoRA by README tag, in folders', 'o/packed', { 'README.md': CARD('tags: [lora]'), 'flux/a.safetensors': 40 }, ['adapter']],
    ['a lora tag on a language model changes nothing', 'o/llm', { 'config.json': '{"model_type":"gemma4"}', 'README.md': CARD('tags: [lora]'), 'model.safetensors': 40 }, ['transformers']],
    ['a lora tag on a GGUF repo changes nothing', 'o/g-GGUF', { 'README.md': CARD('tags: [lora]'), 'x-Q4_K_M.gguf': 40 }, ['gguf']],
    ['a lora tag with no weights changes nothing', 'o/card2', { 'README.md': CARD('tags: [lora]') }, ['unknown']],
    ['a lora tag on a ComfyUI-config repo stays diffusion', 'o/c', { 'config.json': '{"loader":"comfyui"}', 'README.md': CARD('tags: [lora]'), 'A/x.safetensors': 40 }, ['diffusion']],
    ['ComfyUI bundle: root config names the loader, weights in folders', 'realrebelai/Rebels_w6a8s', { 'config.json': REBELS_CONFIG,
      'FLUX/flux3_image_klein_w6a8.safetensors': 40, 'QWEN/qwen_image_2.1_w6a8.safetensors': 50 }, ['diffusion']],
    ['root checkpoint, README says text-to-image', 'o/dit', { 'README.md': CARD('pipeline_tag: text-to-image'), 'dit-w4a8.safetensors': 40 }, ['diffusion']],
    ['W6A8 language model stays transformers', 'o/llm-W6A8', { 'config.json': '{"model_type":"gemma4"}', 'README.md': CARD('tags: [w6a8, comfyui]'), 'model.safetensors': 40 }, ['transformers']],
    ['no signal stays single-file', 'o/ckpt', { 'README.md': CARD('license: mit'), 'ckpt.safetensors': 40 }, ['single-file']],
    ['a signal without weights is not a model', 'o/card', { 'README.md': CARD('pipeline_tag: text-to-image') }, ['unknown']],
    ['GGUF stays primary', 'o/image-GGUF', { 'README.md': CARD('tags: [comfyui]'), 'x-Q4_K_M.gguf': 40, 'y.safetensors': 40 }, ['gguf', 'single-file']],
    ['a pipeline stays diffusers', 'o/pipe', { 'model_index.json': JSON.stringify({ _class_name: 'P' }), 'README.md': CARD('pipeline_tag: text-to-image'), 'z.safetensors': 40 }, ['diffusers', 'single-file']],
    ['an adapter stays an adapter', 'o/style', { 'adapter_config.json': '{}', 'README.md': CARD('pipeline_tag: text-to-image'), 'adapter_model.safetensors': 40 }, ['adapter']],
    ['a LoRA by name stays an adapter', 'o/style-lora', { 'README.md': CARD('pipeline_tag: text-to-image'), 'style-lora.safetensors': 40 }, ['adapter', 'single-file']],
  ])('%s', async (_n, id, files, kinds) => expect(detectKinds(await scanOne(id, files as Record<string, string | number>))).toEqual(kinds));

  it('dataset and space kinds sit at their precedence position', async () => {
    expect(detectKinds(await scanOne('HuggingFaceFW/fineweb', { 'data/000.parquet': 10 }, 'dataset'))).toEqual(['dataset']);
    expect(detectKinds(await scanOne('o/demo', { 'app.py': 'x', 'm.gguf': 5 }, 'space'))).toEqual(['gguf', 'space']);
    expect(detectKinds(await scanOne('o/demo2', { 'app.py': 'x' }, 'space'))).toEqual(['space']);
  });

  it('only current-snapshot files decide kinds', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/two');
    await rb.files('c1', { 'x.gguf': 5 });
    await rb.files('c2', { 'config.json': '{}', 'model.safetensors': 9 });
    await rb.main('c2');
    const r = (await scanHub(hb.hub)).repos[0]!;
    expect(currentFiles(r).map((f) => f.relpath).sort()).toEqual(['config.json', 'model.safetensors']);
    expect(detectKinds(r)).toEqual(['transformers']);
  });

  it('unparseable config.json is treated as having no _class_name', async () => {
    const r = await scanOne('o/bad', { 'config.json': 'not json', 'model.safetensors': 9 });
    expect(detectKinds(r)).toEqual(['transformers']);
  });

  it('uses the injected readText', async () => {
    const r = await scanOne('o/inj', { 'config.json': '{}', 'model.safetensors': 9 });
    expect(detectKinds(r, () => '{"_class_name":"AutoencoderKL"}')).toEqual(['component']);
    expect(detectKinds(r, () => null)).toEqual(['transformers']);
  });

  it('classifyRepo returns a RepoView with kinds, type and partial count', async () => {
    const r = await scanOne('o/sd15', { 'a.safetensors': 400 });
    const v = classifyRepo(r);
    expect(v).toMatchObject({ repoId: 'o/sd15', type: 'model', kinds: ['single-file'], partialDownloads: 0 });
  });
});

const QWEN = 'unsloth/Qwen3.6-27B-GGUF';
const qwenFiles: Record<string, string | number> = {
  'Qwen3.6-27B-UD-Q4_K_XL.gguf': 400,
  'Qwen3.6-27B-Q8_0.gguf': 800,
  'BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf': 1000,
  'BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf': 900,
  'mmproj-F16.gguf': 60,
  'mmproj-BF16.gguf': 61,
  'MTP/Qwen3.6-27B-MTP-Q8_0.gguf': 30,
  'README.md': '# Qwen3.6',
  'Qwen3.6-27B-Q4_K_M-00001-of-00003.gguf': 100,
  'Qwen3.6-27B-Q4_K_M-00003-of-00003.gguf': 100,
};
const groupsOf = (v: ReturnType<typeof classifyRepo>, kind: string): Array<[string, number]> =>
  v.groups.filter((g) => g.kind === kind).map((g) => [g.key, g.apparentBytes]);

describe('GGUF groups', () => {
  it('one group per quant, sorted by size then label, shards merged', async () => {
    const v = classifyRepo(await scanOne(QWEN, qwenFiles));
    const q = v.groups.filter((g) => g.kind === 'quant');
    expect(q.map((g) => [g.key, g.apparentBytes, g.files.length, g.shards])).toEqual([
      ['quant:Q4_K_M', 200, 2, { present: 2, expected: 3 }],
      ['quant:UD-Q4_K_XL', 400, 1, undefined],
      ['quant:Q8_0', 800, 1, undefined],
      ['quant:BF16', 1900, 2, { present: 2, expected: 2 }],
    ]);
    expect(q.every((g) => g.locked === false)).toBe(true);
  });

  it('mmproj files are one group each, labelled by precision', async () => {
    const v = classifyRepo(await scanOne(QWEN, qwenFiles));
    expect(groupsOf(v, 'mmproj')).toEqual([['mmproj:vision projector (BF16)', 61], ['mmproj:vision projector (F16)', 60]]);
  });

  it('mmprojLabel: F16, F32, BF16, quantised, and no-precision fallback', () => {
    expect(mmprojLabel('mmproj-F16.gguf')).toBe('vision projector (F16)');
    expect(mmprojLabel('x/mmproj-F32.gguf')).toBe('vision projector (F32)');
    expect(mmprojLabel('mmproj-Model-bf16.gguf')).toBe('vision projector (BF16)');
    expect(mmprojLabel('mmproj-Model-Q8_0.gguf')).toBe('vision projector (Q8_0)');
    expect(mmprojLabel('mmproj.gguf')).toBe('vision projector');
    expect(mmprojLabel('mmproj-model.gguf')).toBe('vision projector');
  });

  it('mmproj with F16 and F32 are separately deletable; same label on different blobs falls back to relpath', async () => {
    const r = await scanOne('o/vl-GGUF', { 'm-Q8_0.gguf': 5, 'mmproj-F16.gguf': 10, 'mmproj-F32.gguf': 20, 'a/mmproj-model.gguf': 3, 'b/mmproj-model.gguf': 4 });
    expect(groupsOf(classifyRepo(r), 'mmproj')).toEqual([
      ['mmproj:vision projector (F16)', 10],
      ['mmproj:vision projector (F32)', 20],
      ['mmproj:vision projector [a/mmproj-model]', 3],
      ['mmproj:vision projector [b/mmproj-model]', 4],
    ]);
  });

  it('draft/MTP files form one draft group', async () =>
    expect(groupsOf(classifyRepo(await scanOne(QWEN, qwenFiles)), 'draft')).toEqual([['draft:draft', 30]]));

  it('README goes to assets, not to a quant', async () => {
    const v = classifyRepo(await scanOne(QWEN, qwenFiles));
    // '# Qwen3.6' is 9 bytes
    expect(groupsOf(v, 'assets')).toEqual([['assets:model card and assets', 9]]);
  });

  it('groups appear in kind order', async () =>
    expect([...new Set(classifyRepo(await scanOne(QWEN, qwenFiles)).groups.map((g) => g.kind))]).toEqual(['quant', 'mmproj', 'draft', 'assets']));

  it('a shard whose blob is dangling is not present', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo(QWEN);
    await rb.files('c1', { 'Qwen3.6-27B-Q4_K_M-00001-of-00003.gguf': 100, 'Qwen3.6-27B-Q8_0.gguf': 8 });
    const etag = hex('dangling');
    await rb.storeLink(etag, hex('missing-store-file'));
    await rb.link('c1', 'Qwen3.6-27B-Q4_K_M-00003-of-00003.gguf', etag);
    await rb.main('c1');
    const m = await scanHub(hb.hub);
    const g = classifyRepo(m.repos[0]!).groups.find((x) => x.key === 'quant:Q4_K_M')!;
    expect(g.shards).toEqual({ present: 1, expected: 3 });
    expect(g.apparentBytes).toBe(100);
  });

  it('a blob linked by two relpaths counts once in a group and in the repo', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo(QWEN);
    const etags = await rb.files('c1', { 'Qwen3.6-27B-Q8_0.gguf': 800, 'Qwen3.6-27B-Q4_0.gguf': 400 });
    await rb.link('c1', 'copy/Qwen3.6-27B-Q8_0.gguf', etags['Qwen3.6-27B-Q8_0.gguf']!);
    await rb.main('c1');
    const v = classifyRepo((await scanHub(hb.hub)).repos[0]!);
    const g = v.groups.find((x) => x.key === 'quant:Q8_0')!;
    expect(g.files.length).toBe(2);
    expect(g.apparentBytes).toBe(800);
    expect(v.apparentBytes).toBe(1200);
  });

  it('every current file is in exactly one group', async () => {
    const r = await scanOne(QWEN, { ...qwenFiles, 'config.json': '{}', 'img/a.png': 4, 'LICENSE': 'x' });
    const v = classifyRepo(r);
    const all = v.groups.filter((g) => g.kind !== 'superseded').flatMap((g) => g.files.map((f) => f.linkPath));
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(currentFiles(r).map((f) => f.linkPath).sort());
  });

  it('fileBytes and groupBytes: plain files by dev:ino, dangling and other links are 0', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/plain');
    await rb.plain('c1', 'a.gguf', 'abcd');
    await rb.main('c1');
    const r = (await scanHub(hb.hub)).repos[0]!;
    const f = r.files[0]!;
    expect(fileBytes(r, f)).toBe(4);
    expect(groupBytes(r, [f, f])).toBe(4);
    expect(fileBytes(r, { ...f, facts: { ...f.facts, isFile: false, isSymlink: true } })).toBe(0);
    expect(fileBytes(r, { ...f, blobEtag: hex('nope') })).toBe(0);
  });
});

const FLUX = 'black-forest-labs/FLUX.1-dev';
const modelIndex = JSON.stringify({
  _class_name: 'FluxPipeline', _diffusers_version: '0.30.0',
  scheduler: ['diffusers', 'FlowMatchEulerDiscreteScheduler'], text_encoder: ['transformers', 'CLIPTextModel'],
  text_encoder_2: ['transformers', 'T5EncoderModel'], tokenizer: ['transformers', 'CLIPTokenizer'],
  tokenizer_2: ['transformers', 'T5TokenizerFast'], transformer: ['diffusers', 'FluxTransformer2DModel'],
  vae: ['diffusers', 'AutoencoderKL'], safety_checker: [null, null],
});
const fluxFiles: Record<string, string | number> = {
  'model_index.json': modelIndex,
  'flux1-dev.safetensors': 2300, 'ae.safetensors': 300,
  'transformer/config.json': '{}',
  'transformer/diffusion_pytorch_model-00001-of-00003.safetensors': 1000,
  'transformer/diffusion_pytorch_model-00002-of-00003.safetensors': 1000,
  'transformer/diffusion_pytorch_model-00003-of-00003.safetensors': 380,
  'transformer/diffusion_pytorch_model.safetensors.index.json': '{}',
  'vae/config.json': '{}', 'vae/diffusion_pytorch_model.safetensors': 160,
  'text_encoder/model.safetensors': 240,
  'text_encoder_2/model-00001-of-00002.safetensors': 500, 'text_encoder_2/model-00002-of-00002.safetensors': 450,
  'tokenizer/vocab.json': 9, 'tokenizer_2/spiece.model': 7,
  'scheduler/scheduler_config.json': '{}',
  'README.md': '# FLUX', 'dev_grid.jpg': 50, 'LICENSE.md': 'lic',
};
const group = (v: ReturnType<typeof classifyRepo>, key: string) => {
  const g = v.groups.find((x) => x.key === key);
  if (!g) throw new Error(`no group ${key}`);
  return g;
};

describe('diffusers components and root-file groups', () => {
  it('one locked component group per listed, present subfolder', async () => {
    const v = classifyRepo(await scanOne(FLUX, fluxFiles));
    expect(v.groups.filter((g) => g.kind === 'component').map((g) => [g.key, g.locked, g.files.length])).toEqual([
      ['component:model_index.json', true, 1],
      ['component:scheduler/', true, 1], ['component:text_encoder/', true, 1], ['component:text_encoder_2/', true, 2],
      ['component:tokenizer/', true, 1], ['component:tokenizer_2/', true, 1], ['component:transformer/', true, 5],
      ['component:vae/', true, 2],
    ]);
    expect(group(v, 'component:transformer/').apparentBytes).toBe(2384);
  });

  it('null-valued and underscore keys are not components', async () => {
    const v = classifyRepo(await scanOne(FLUX, fluxFiles));
    expect(v.groups.some((g) => g.label === 'safety_checker/' || g.label === '_class_name/')).toBe(false);
  });

  it('a listed component without files gets no group', async () => {
    const r = await scanOne('o/p', { 'model_index.json': JSON.stringify({ vae: ['d', 'V'], unet: ['d', 'U'] }), 'vae/config.json': '{}' });
    expect(classifyRepo(r).groups.filter((g) => g.kind === 'component').map((g) => g.key)).toEqual(['component:model_index.json', 'component:vae/']);
  });

  it('root single-file checkpoints alongside the pipeline get their own root-file groups', async () => {
    const v = classifyRepo(await scanOne(FLUX, fluxFiles));
    expect(v.groups.filter((g) => g.kind === 'root-file').map((g) => [g.key, g.apparentBytes, g.locked]))
      .toEqual([['root-file:ae.safetensors', 300, false], ['root-file:flux1-dev.safetensors', 2300, false]]);
  });

  it('README and media go to assets; LICENSE to other', async () => {
    const v = classifyRepo(await scanOne(FLUX, fluxFiles));
    expect(group(v, 'assets:model card and assets').files.map((f) => f.relpath)).toEqual(['README.md', 'dev_grid.jpg']);
    expect(group(v, 'other:other files').files.map((f) => f.relpath)).toEqual(['LICENSE.md']);
  });

  it('a subfolder not listed in model_index.json is grouped as other by folder; its image is an asset', async () => {
    const v = classifyRepo(await scanOne(FLUX, { ...fluxFiles, 'extras/notes.txt': 'n', 'extras/x.png': 3 }));
    expect(group(v, 'other:extras/').files.map((f) => f.relpath)).toEqual(['extras/notes.txt']);
    expect(group(v, 'assets:model card and assets').files.map((f) => f.relpath)).toContain('extras/x.png');
  });

  it('an image inside a component folder stays in the component group', async () => {
    const v = classifyRepo(await scanOne(FLUX, { ...fluxFiles, 'vae/preview.png': 3 }));
    expect(group(v, 'component:vae/').files.map((f) => f.relpath)).toContain('vae/preview.png');
  });

  it('an unreadable model_index.json yields no component groups; folders fall to other', async () => {
    const v2 = classifyRepo(await scanOne(FLUX, fluxFiles), () => null);
    expect(v2.groups.some((g) => g.kind === 'component')).toBe(false);
    expect(v2.groups.some((g) => g.key === 'other:vae/')).toBe(true);
  });

  it('root checkpoints in a transformers repo are not root-file groups', async () => {
    const v = classifyRepo(await scanOne('o/t', { 'config.json': '{"model_type":"x"}', 'model.safetensors': 9 }));
    expect(v.groups.some((g) => g.kind === 'root-file')).toBe(false);
    expect(v.groups.some((g) => g.kind === 'root-file')).toBe(false);
  });

  it('unreadable model_index.json fails closed: subfolder and index groups are locked, root files are not', async () => {
    const v = classifyRepo(await scanOne(FLUX, { ...fluxFiles, 'extras/x.png': 3 }), () => null);
    expect(v.groups.some((g) => g.kind === 'component')).toBe(false);
    expect(group(v, 'other:vae/').locked).toBe(true);
    expect(group(v, 'other:transformer/').locked).toBe(true);
    expect(group(v, 'other:model_index.json').locked).toBe(true);
    expect(group(v, 'other:model_index.json').files.map((f) => f.relpath)).toEqual(['model_index.json']);
    expect(group(v, 'other:other files').locked).toBe(false);
    expect(group(v, 'assets:model card and assets').locked).toBe(false);
    expect(v.groups.filter((g) => g.kind === 'root-file').every((g) => !g.locked)).toBe(true);
  });

  it('unreadable model_index.json locks subfolder assets and GGUF files too; root assets and GGUF are unchanged', async () => {
    const files = { ...fluxFiles, 'vae/README.md': 'r', 'transformer/x-Q4_K_M.gguf': 4, 'README.md': 'r', 'y-Q8_0.gguf': 8 };
    const v = classifyRepo(await scanOne(FLUX, files), () => null);
    expect(group(v, 'other:vae/').locked).toBe(true);
    expect(group(v, 'other:vae/').files.map((f) => f.relpath)).toContain('vae/README.md');
    expect(group(v, 'other:transformer/').locked).toBe(true);
    expect(group(v, 'other:transformer/').files.map((f) => f.relpath)).toContain('transformer/x-Q4_K_M.gguf');
    const assets = group(v, 'assets:model card and assets');
    expect(assets.locked).toBe(false);
    expect(assets.files.map((f) => f.relpath)).toContain('README.md');
    expect(assets.files.map((f) => f.relpath)).not.toContain('vae/README.md');
    expect(v.groups.filter((g) => g.kind === 'quant').flatMap((g) => g.files.map((f) => f.relpath))).toEqual(['y-Q8_0.gguf']);
    const r = classifyRepo(await scanOne(FLUX, files));
    expect(group(r, 'component:vae/').files.map((f) => f.relpath)).toContain('vae/README.md');
    expect(group(r, 'component:transformer/').files.map((f) => f.relpath)).toContain('transformer/x-Q4_K_M.gguf');
  });

  it('a readable model_index.json leaves other-by-folder groups unlocked', async () => {
    const v = classifyRepo(await scanOne(FLUX, { ...fluxFiles, 'extras/notes.txt': 'n' }));
    expect(group(v, 'other:extras/').locked).toBe(false);
  });

  it('README-named gguf files are GGUF, not assets', async () => {
    const v = classifyRepo(await scanOne('o/x-GGUF', { 'README.gguf': 5, 'readme.Q4_K_M.gguf': 6, 'README.md': 'r' }));
    const assets = group(v, 'assets:model card and assets');
    expect(assets.locked).toBe(false);
    expect(assets.files.map((f) => f.relpath)).toContain('README.md');
    expect(assets.files.map((f) => f.relpath)).not.toContain('vae/README.md');
    expect(v.groups.filter((g) => g.kind === 'quant').flatMap((g) => g.files.map((f) => f.relpath)).sort()).toEqual(['README.gguf', 'readme.Q4_K_M.gguf']);
  });

  it('every current file is in exactly one group (diffusers)', async () => {
    const r = await scanOne(FLUX, { ...fluxFiles, 'extras/notes.txt': 'n', 'extras/x.png': 3 });
    for (const rt of [undefined, () => null] as const) {
      const v = classifyRepo(r, rt);
      const all = v.groups.flatMap((g) => g.files.map((f) => f.linkPath));
      expect(new Set(all).size).toBe(all.length);
      expect(all.sort()).toEqual(currentFiles(r).map((f) => f.linkPath).sort());
    }
  });
});

const keysAndFiles = (v: ReturnType<typeof classifyRepo>): Array<[string, string[]]> =>
  v.groups.map((g) => [g.key, g.files.map((f) => f.relpath)]);
const snapDir = (folder: string, commit: string): string => join(folder, 'snapshots', commit);

const QWEN32 = 'Qwen/Qwen3-32B';
const qwen32Files: Record<string, string | number> = {
  'config.json': '{"model_type":"qwen3"}', 'generation_config.json': '{}',
  'model-00001-of-00002.safetensors': 500, 'model-00002-of-00002.safetensors': 400,
  'model.safetensors.index.json': '{}', 'tokenizer.json': '{}', 'tokenizer_config.json': '{}', 'vocab.json': '{}',
  'merges.txt': 'm', 'LICENSE': 'l', 'README.md': '# q',
};
const LORA = 'o/qwen3-lora';
const loraFiles = { 'adapter_config.json': '{"peft_type":"LORA"}', 'adapter_model.safetensors': 40 };
const VAE = 'madebyollin/sdxl-vae-fp16-fix';
const vaeFiles = { 'config.json': '{"_class_name":"AutoencoderKL"}', 'diffusion_pytorch_model.safetensors': 160, 'sdxl_vae.safetensors': 160 };
const FINEWEB = 'HuggingFaceFW/fineweb';
const finewebFiles = { 'data/CC-MAIN-2024-10/000_00000.parquet': 10, 'sample/10BT/000.parquet': 5, 'dataset_info.json': '{}' };

/** c1 (older) and c2 (main): c1 has its own Q8_0, shares Q6_K's blob with c2, and has a plain notes.txt. */
async function supersededRepo(): Promise<Repo> {
  const hb = await hubBuilder();
  const rb = hb.repo('unsloth/Qwen3.6-27B-GGUF');
  const cur = await rb.files('c2', { 'Qwen3.6-27B-Q8_0.gguf': 800, 'Qwen3.6-27B-Q6_K.gguf': 600 });
  const eOld = hex('eOld');
  await rb.blob(eOld, 790);
  await rb.link('c1', 'Qwen3.6-27B-Q8_0.gguf', eOld);
  await rb.link('c1', 'Qwen3.6-27B-Q6_K.gguf', cur['Qwen3.6-27B-Q6_K.gguf']!);
  await rb.plain('c1', 'notes.txt', 'hello');
  await rb.main('c2');
  return (await scanHub(hb.hub)).repos[0]!;
}

describe('transformers, adapter and component buckets; other-by-folder', () => {
  it('transformers: weights / tokenizer and config / other', async () => {
    const v = classifyRepo(await scanOne(QWEN32, qwen32Files));
    expect(keysAndFiles(v)).toEqual([
      ['weights:weights', ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors', 'model.safetensors.index.json']],
      ['tokenizer-config:tokenizer and config', ['config.json', 'generation_config.json', 'merges.txt', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json']],
      ['other:other files', ['LICENSE']],
      ['assets:model card and assets', ['README.md']],
    ]);
    expect(group(v, 'weights:weights').apparentBytes).toBe(902);
    expect(v.kinds).toEqual(['transformers']);
  });

  it('transformers: subfolder files, every weight extension and tokenizer basename', async () => {
    const v = classifyRepo(await scanOne('o/t2', {
      'config.json': '{}', 'pytorch_model.bin': 3, 'a.pt': 1, 'a.pth': 1, 'a.ckpt': 1, 'tf_model.h5': 1, 'flax_model.msgpack': 1,
      'onnx/model.onnx': 2, 'pytorch_model.bin.index.json': '{}', 'preprocessor_config.json': '{}', 'special_tokens_map.json': '{}',
      'added_tokens.json': '{}', 'chat_template.jinja': 'j', 'chat_template.json': '{}', 'spiece.model': 1, 'cl100k.tiktoken': 1,
      'vocab.txt': 'v', 'tokenizer.model': 1, 'onnx/config.json': '{}', 'onnx/notes.txt': 'n', 'original/params.json': '{}',
    }));
    expect(keysAndFiles(v)).toEqual([
      ['weights:weights', ['a.ckpt', 'a.pt', 'a.pth', 'flax_model.msgpack', 'onnx/model.onnx', 'pytorch_model.bin', 'pytorch_model.bin.index.json', 'tf_model.h5']],
      ['tokenizer-config:tokenizer and config', ['added_tokens.json', 'chat_template.jinja', 'chat_template.json', 'cl100k.tiktoken', 'config.json',
        'onnx/config.json', 'preprocessor_config.json', 'special_tokens_map.json', 'spiece.model', 'tokenizer.model', 'vocab.txt']],
      ['other:onnx/', ['onnx/notes.txt']],
      ['other:original/', ['original/params.json']],
    ]);
  });

  it('LoRA adapter uses the same buckets', async () => {
    const v = classifyRepo(await scanOne(LORA, loraFiles));
    expect(keysAndFiles(v)).toEqual([['weights:weights', ['adapter_model.safetensors']], ['tokenizer-config:tokenizer and config', ['adapter_config.json']]]);
  });

  it('sdxl-vae component repo: weights and config, nothing locked', async () => {
    const v = classifyRepo(await scanOne(VAE, vaeFiles));
    expect(keysAndFiles(v)).toEqual([['weights:weights', ['diffusion_pytorch_model.safetensors', 'sdxl_vae.safetensors']], ['tokenizer-config:tokenizer and config', ['config.json']]]);
    expect(v.groups.every((g) => !g.locked)).toBe(true);
  });

  it('unknown and dataset repos group by top-level folder, root files as "other files"', async () => {
    const v = classifyRepo(await scanOne(FINEWEB, finewebFiles, 'dataset'));
    expect(v.groups.map((g) => g.key)).toEqual(['other:data/', 'other:other files', 'other:sample/']);
    const u = classifyRepo(await scanOne('o/misc', { 'notes/a.txt': 'a', 'config.json': '{}', 'w.onnx': 1 }));
    expect(keysAndFiles(u)).toEqual([['other:notes/', ['notes/a.txt']], ['other:other files', ['config.json', 'w.onnx']]]);
  });

  it('GGUF and diffusers repos do not use the weights / tokenizer buckets', async () => {
    const g = classifyRepo(await scanOne(QWEN, { ...qwenFiles, 'config.json': '{}', 'tokenizer.json': '{}' }));
    expect(g.groups.some((x) => x.kind === 'weights' || x.kind === 'tokenizer-config')).toBe(false);
    expect(group(g, 'other:other files').files.map((f) => f.relpath)).toEqual(['config.json', 'tokenizer.json']);
    const d = classifyRepo(await scanOne(FLUX, { ...fluxFiles, 'extras/config.json': '{}', 'extras/w.safetensors': 1 }));
    expect(group(d, 'other:extras/').files.map((f) => f.relpath)).toEqual(['extras/config.json', 'extras/w.safetensors']);
    expect(d.groups.some((x) => x.kind === 'weights' || x.kind === 'tokenizer-config')).toBe(false);
  });
});

describe('superseded and the effective current snapshot', () => {
  it('superseded: non-current files whose blob no current file uses', async () => {
    const v = classifyRepo(await supersededRepo());
    const s = group(v, 'superseded:superseded (older revision)');
    expect(s.files.map((f) => [f.commit, f.relpath])).toEqual([['c1', 'Qwen3.6-27B-Q8_0.gguf'], ['c1', 'notes.txt']]);
    expect(s.apparentBytes).toBe(790 + 5);
    expect(s.files.every((f) => !f.isCurrent)).toBe(true);
    expect(s.locked).toBe(false);
    expect(v.groups[v.groups.length - 1]!.kind).toBe('superseded');
  });

  it('superseded uses blob identity for 40-hex (non-LFS) blobs too', async () => {
    const t = await buildTree({ repos: [{ id: 'o/s-GGUF', snapshots: {
      c0: { 'config.json': spec('small', 'CFG', 30), 'changed.json': spec('small', 'OLD', 20), 'm-Q8_0.gguf': spec('blob', 'Q', 8) },
      c1: { 'config.json': spec('small', 'CFG', 30), 'changed.json': spec('small', 'NEW', 20), 'm-Q8_0.gguf': spec('blob', 'Q', 8) } } }] });
    const repo = (await t.scan()).repos[0]!;
    const v = classifyRepo(repo);
    const s = group(v, 'superseded:superseded (older revision)');
    expect(s.files.map((x) => [x.commit, x.relpath])).toEqual([['c0', 'changed.json']]);
    const grouped = v.groups.flatMap((g) => g.files.map((x) => x.linkPath));
    expect(grouped).not.toContain(t.link('o/s-GGUF', 'c0', 'config.json'));
    expect(grouped).not.toContain(t.link('o/s-GGUF', 'c0', 'm-Q8_0.gguf'));
  });

  it('a snapshot a ref names (a download @dev) is never superseded; main stays the current one', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/dev-GGUF');
    const cur = await rb.files('c1', { 'm-Q8_0.gguf': 8 });
    await rb.files('c2', { 'm-Q4_K_M.gguf': 4, 'notes/a.txt': 'a' });
    await rb.link('c2', 'm-Q8_0.gguf', cur['m-Q8_0.gguf']!);   // dev shares main's blob here: in no group (as for superseded)
    await rb.files('c0', { 'm-Q2_K.gguf': 2 });   // an old revision no ref names
    await rb.main('c1');
    await writeFile(join(rb.folder, 'refs', 'dev'), 'c2');
    await mkdir(join(rb.folder, 'refs', 'feature'), { recursive: true });
    await writeFile(join(rb.folder, 'refs', 'feature', 'y'), 'c2');
    const repo = (await scanHub(hb.hub)).repos[0]!;
    const v = classifyRepo(repo);
    expect(currentFiles(repo).map((f) => [f.commit, f.relpath])).toEqual([['c1', 'm-Q8_0.gguf']]);
    expect(group(v, 'superseded:superseded (older revision)').files.map((f) => [f.commit, f.relpath])).toEqual([['c0', 'm-Q2_K.gguf']]);
    // The files only dev has are their own group, selectable like any other
    const only = group(v, 'other:Files only in dev, feature/y');
    expect(only).toMatchObject({ kind: 'other', label: 'Files only in dev, feature/y', locked: false });
    expect(only.files.map((f) => [f.commit, f.relpath])).toEqual([['c2', 'm-Q4_K_M.gguf'], ['c2', 'notes/a.txt']]);
    expect(only.apparentBytes).toBe(4 + 1);
    expect(v.groups.map((g) => g.kind).slice(-2)).toEqual(['other', 'superseded']);
  });

  it('with unreadable refs (null) no snapshot is superseded and no ref group is made', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/unk-GGUF');
    await rb.files('c1', { 'm-Q8_0.gguf': 8 });
    await rb.files('c0', { 'm-Q2_K.gguf': 2 });
    await rb.main('c1');
    const repo = { ...(await scanHub(hb.hub)).repos[0]!, refs: null };
    const v = classifyRepo(repo);
    expect(v.groups.some((g) => g.kind === 'superseded' || g.label.startsWith('Files only in'))).toBe(false);
  });

  it('a repo downloaded @dev only (refs/dev, no main) shows its files as current, not superseded', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/only-dev-GGUF');
    await rb.files('c2', { 'm-Q4_K_M.gguf': 4, 'README.md': 'r' });
    await mkdir(join(rb.folder, 'refs'), { recursive: true });
    await writeFile(join(rb.folder, 'refs', 'dev'), 'c2');
    const repo = (await scanHub(hb.hub)).repos[0]!;
    const v = classifyRepo(repo);
    expect(currentFiles(repo).map((f) => f.relpath)).toEqual(['README.md', 'm-Q4_K_M.gguf']);
    expect(v.groups.some((g) => g.kind === 'superseded')).toBe(false);
  });

  it('no superseded group when every non-current link uses a current blob', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/x-GGUF');
    const e = await rb.files('c2', { 'm-Q8_0.gguf': 8 });
    await rb.link('c1', 'm-Q8_0.gguf', e['m-Q8_0.gguf']!);
    await rb.main('c2');
    const v = classifyRepo((await scanHub(hb.hub)).repos[0]!);
    expect(v.groups.some((g) => g.kind === 'superseded')).toBe(false);
  });

  it('effective current snapshot falls back to newest when refs/main names a missing snapshot', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/fb-GGUF');
    await rb.files('c1', { 'm-Q8_0.gguf': 8 });
    await rb.plain('c1', 'old.txt', 'o');
    await rb.files('c2', { 'm-Q8_0.gguf': 9 });
    await rb.plain('c2', 'notes.txt', 'nn');
    await rb.plain('c2', 'sub/n.txt', 'n');
    await rb.main('c9');
    await hb.touch(snapDir(rb.folder, 'c1'), 1000);
    await hb.touch(snapDir(rb.folder, 'c2'), 2000);
    const repo = (await scanHub(hb.hub)).repos[0]!;
    expect(repo.files.filter((f) => f.isCurrent).map((f) => [f.commit, f.relpath]))
      .toEqual([['c2', 'm-Q8_0.gguf'], ['c2', 'notes.txt'], ['c2', 'sub/n.txt']]);
    const cur = currentFiles(repo);
    expect(cur.map((f) => f.relpath)).toEqual(['m-Q8_0.gguf', 'notes.txt', 'sub/n.txt']);
    expect(cur.every((f) => f.commit === 'c2')).toBe(true);
    const v = classifyRepo(repo);
    const sup = v.groups.find((g) => g.kind === 'superseded')!;
    expect(sup.files.map((f) => [f.commit, f.relpath])).toEqual([['c1', 'm-Q8_0.gguf'], ['c1', 'old.txt']]);
    const grouped = v.groups.filter((g) => g.kind !== 'superseded').flatMap((g) => g.files.map((f) => f.linkPath));
    expect(grouped.sort()).toEqual(cur.map((f) => f.linkPath).sort());
  });

  it('effective current snapshot: an empty named snapshot is treated like a missing one', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/empty-main-GGUF');
    await rb.files('c1', { 'm-Q8_0.gguf': 8 });
    await rb.plain('c1', 'old.txt', 'o');
    await rb.files('c2', { 'm-Q8_0.gguf': 9 });
    await rb.plain('c2', 'notes.txt', 'nn');
    await guardedFs().mkdir(snapDir(rb.folder, 'c3'), { recursive: true });
    await rb.main('c3');
    await hb.touch(snapDir(rb.folder, 'c1'), 1000);
    await hb.touch(snapDir(rb.folder, 'c2'), 2000);
    const repo = (await scanHub(hb.hub)).repos[0]!;
    expect(repo.snapshots).toEqual(['c3', 'c2', 'c1']);
    expect(repo.files.filter((f) => f.isCurrent).map((f) => [f.commit, f.relpath]))
      .toEqual([['c2', 'm-Q8_0.gguf'], ['c2', 'notes.txt']]);
    const cur = currentFiles(repo);
    expect(cur.map((f) => [f.commit, f.relpath])).toEqual([['c2', 'm-Q8_0.gguf'], ['c2', 'notes.txt']]);
    const v = classifyRepo(repo);
    expect(group(v, 'superseded:superseded (older revision)').files.map((f) => [f.commit, f.relpath]))
      .toEqual([['c1', 'm-Q8_0.gguf'], ['c1', 'old.txt']]);
    const grouped = v.groups.filter((g) => g.kind !== 'superseded').flatMap((g) => g.files.map((f) => f.linkPath));
    expect(grouped.sort()).toEqual(cur.map((f) => f.linkPath).sort());
  });

  it('datasets and spaces skip the weights / tokenizer buckets', async () => {
    for (const type of ['dataset', 'space'] as const) {
      const v = classifyRepo(await scanOne('o/ds', { 'config.json': '{}', 'x.safetensors': 9, 'README.md': 'r', 'sub/tokenizer.json': '{}' }, type));
      expect(keysAndFiles(v)).toEqual([
        ['other:other files', ['config.json', 'x.safetensors']],
        ['other:sub/', ['sub/tokenizer.json']],
        ['assets:model card and assets', ['README.md']],
      ]);
    }
  });

  it('effective current snapshot: no refs/main uses the newest snapshot; no snapshots gives []', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/nomain');
    await rb.plain('c1', 'a.txt', 'a');
    await rb.plain('c2', 'b.txt', 'b');
    await hb.touch(snapDir(rb.folder, 'c1'), 2000);
    await hb.touch(snapDir(rb.folder, 'c2'), 1000);
    const hb2 = await hubBuilder();
    const rb2 = hb2.repo('o/empty');
    await rb2.blob(hex('orphan'), 7);
    const [repo] = (await scanHub(hb.hub)).repos;
    const [empty] = (await scanHub(hb2.hub)).repos;
    expect(currentFiles(repo!).map((f) => [f.commit, f.relpath])).toEqual([['c1', 'a.txt']]);
    expect(currentFiles(empty!)).toEqual([]);
    expect(classifyRepo(empty!)).toMatchObject({ groups: [], apparentBytes: 7 });
  });

  it('every repo file is in exactly one group or is a non-current link to a current blob', async () => {
    const r = await supersededRepo();
    const v = classifyRepo(r);
    const all = v.groups.flatMap((g) => g.files.map((f) => f.linkPath));
    expect(new Set(all).size).toBe(all.length);
    const ungrouped = r.files.filter((f) => !all.includes(f.linkPath));
    expect(ungrouped.map((f) => [f.commit, f.relpath])).toEqual([['c1', 'Qwen3.6-27B-Q6_K.gguf']]);
  });
});

describe('RepoView totals', () => {
  it('RepoView totals: each unique repo blob once (incl. orphans and shared), plain files by inode, partials counted', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/r');
    const e1 = hex('e1'); const e2 = hex('e2'); const e3 = hex('e3'); const e4 = hex('e4');
    await rb.blob(e1, 400);
    await rb.link('c2', 'a.bin', e1);
    await rb.link('c2', 'b/a.bin', e1);
    const h2 = hex('store-e2');
    await hb.marker();
    await hb.store(h2, 800, null);
    await rb.storeLink(e2, h2);
    await rb.link('c2', 'big.gguf', e2);
    await rb.blob(e3, 50);
    await rb.storeLink(e4, hex('missing-store-file'));
    await rb.link('c2', 'gone.gguf', e4);
    const readme = await rb.plain('c1', 'README', 'x'.repeat(10));
    await hb.hardlink(readme, join(snapDir(rb.folder, 'c2'), 'README'));
    await rb.incomplete(hex('i1'), 3);
    await rb.incomplete(hex('i2'), 4);
    await rb.main('c2');
    const repo = (await scanHub(hb.hub)).repos[0]!;
    expect(repo.orphanEtags).toEqual([e3]);
    const v = classifyRepo(repo);
    expect(v).toMatchObject({ repoId: 'o/r', type: 'model', apparentBytes: 400 + 800 + 50 + 0 + 10, partialDownloads: 2 });
  });

  it('a RepoView is deterministic for the same Repo', async () => {
    for (const r of [await supersededRepo(), await scanOne(QWEN32, qwen32Files), await scanOne(FLUX, fluxFiles)]) {
      expect(classifyRepo(r)).toEqual(classifyRepo(r));
    }
  });

  it('group keys are unique within every fixture repo', async () => {
    const repos = [
      await scanOne(QWEN, qwenFiles), await scanOne(FLUX, { ...fluxFiles, 'extras/notes.txt': 'n', 'extras/x.png': 3 }),
      await scanOne(QWEN32, qwen32Files), await scanOne(LORA, loraFiles), await scanOne(VAE, vaeFiles),
      await scanOne(FINEWEB, finewebFiles, 'dataset'), await supersededRepo(),
    ];
    const allViews = repos.flatMap((r) => [classifyRepo(r), classifyRepo(r, () => null)]);
    for (const v of allViews) expect(new Set(v.groups.map((g) => g.key)).size).toBe(v.groups.length);
  });
});

describe('diffusion repo groups', () => {
  it('lists each weight file as its own group, with its own size', async () => {
    const v = classifyRepo(await scanOne('realrebelai/Rebels_w6a8s', {
      'config.json': REBELS_CONFIG, 'README.md': CARD('license: other'),
      'FLUX/flux3_image_klein_w6a8.safetensors': 40, 'KREA/krea2_turbo_w6a8.safetensors': 90,
    }));
    const rows = v.groups.map((g) => [g.kind, g.label, g.apparentBytes, g.locked]);
    expect(rows).toEqual([
      ['root-file', 'FLUX/flux3_image_klein_w6a8.safetensors', 40, false],
      ['root-file', 'KREA/krea2_turbo_w6a8.safetensors', 90, false],
      ['other', 'other files', REBELS_CONFIG.length, false],
      ['assets', 'model card and assets', CARD('license: other').length, false],
    ]);
  });
  it('keeps a sharded checkpoint and its index together', async () => {
    const v = classifyRepo(await scanOne('o/sharded', {
      'config.json': '{"loader":"comfyui"}',
      'A/m-00001-of-00002.safetensors': 10, 'A/m-00002-of-00002.safetensors': 20, 'A/m.safetensors.index.json': '{}',
      'B/n.safetensors': 30,
    }));
    const weights = v.groups.filter((g) => g.kind === 'root-file');
    expect(weights.map((g) => [g.label, g.files.length])).toEqual([['A/m.safetensors', 3], ['B/n.safetensors', 1]]);
  });
});

describe('LoRA repo groups', () => {
  const rows = async (files: Record<string, string | number>) => classifyRepo(await scanOne('o/loras', files)).groups
    .filter((g) => g.kind !== 'assets').map((g) => [g.kind, g.label, g.apparentBytes]);

  it('a pack at the root lists each LoRA on its own', async () => {
    expect(await rows({ 'a-lora.safetensors': 40, 'b-lora.safetensors': 50 })).toEqual([
      ['root-file', 'a-lora.safetensors', 40], ['root-file', 'b-lora.safetensors', 50],
    ]);
  });
  it('a pack in folders lists each LoRA on its own', async () => {
    expect(await rows({ 'flux/a-lora.safetensors': 40, 'wan/b-lora.safetensors': 50 })).toEqual([
      ['root-file', 'flux/a-lora.safetensors', 40], ['root-file', 'wan/b-lora.safetensors', 50],
    ]);
  });
  it('a PEFT adapter keeps its weights and config as they were: they only work together', async () => {
    expect(await rows({ 'adapter_config.json': '{}', 'adapter_model.safetensors': 40, 'other_model.safetensors': 50 })).toEqual([
      ['weights', 'weights', 90], ['tokenizer-config', 'tokenizer and config', 2],
    ]);
  });
});
