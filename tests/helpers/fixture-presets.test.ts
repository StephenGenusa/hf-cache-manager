import { expect, it } from 'vitest';
import { useCanaries } from './canary';
import {
  assetFiles, buildFixture, diffusersFiles, draftFiles, ggufFiles, mmprojFiles, transformersFiles,
} from './fixture';

useCanaries();
const paths = (fs: Array<{ path: string }>): string[] => fs.map((f) => f.path);

it('ggufFiles', () => {
  expect(paths(ggufFiles('M', ['Q4_K_M', { label: 'UD-Q8_K_XL', shards: 3, missing: [2] }]))).toEqual([
    'M-Q4_K_M.gguf', 'UD-Q8_K_XL/M-UD-Q8_K_XL-00001-of-00003.gguf', 'UD-Q8_K_XL/M-UD-Q8_K_XL-00003-of-00003.gguf']);
  expect(paths(ggufFiles('M', [{ label: 'Q2', dir: 'sub' }]))).toEqual(['sub/M-Q2.gguf']);
});
it('mmprojFiles', () => {
  expect(paths(mmprojFiles('M', ['F16', 'BF16']))).toEqual(['mmproj-F16.gguf', 'mmproj-BF16.gguf']);
});
it('draftFiles', () => {
  expect(paths(draftFiles('M', ['Q8_0'], 'dir'))).toEqual(['MTP/M-Q8_0.gguf']);
  expect(paths(draftFiles('M', ['Q8_0'], 'prefix'))).toEqual(['mtp-M-Q8_0.gguf']);
});
it('diffusersFiles', () => {
  expect(paths(diffusersFiles('F', ['transformer', 'vae', 'text_encoder', 'tokenizer', 'scheduler']))).toEqual([
    'model_index.json',
    'transformer/config.json', 'transformer/diffusion_pytorch_model.safetensors',
    'vae/config.json', 'vae/diffusion_pytorch_model.safetensors',
    'text_encoder/config.json', 'text_encoder/model.safetensors',
    'tokenizer/tokenizer_config.json', 'tokenizer/vocab.json',
    'scheduler/scheduler_config.json']);
});
it('transformersFiles', () => {
  expect(paths(transformersFiles('T', { shards: 2 }))).toEqual([
    'config.json', 'generation_config.json', 'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors',
    'model.safetensors.index.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json']);
  expect(paths(transformersFiles('T', { tokenizer: false }))).toEqual(['config.json', 'generation_config.json', 'model.safetensors']);
});
it('assetFiles', () => {
  expect(paths(assetFiles('A'))).toEqual(['README.md', '.gitattributes', 'images/example.png']);
});
it('preset json/md files use git-sha1 etags, weights sha256', async () => {
  const fx = await buildFixture({ repos: [{ id: 'o/t', snapshots: [{ files: transformersFiles('T') }] }] });
  expect(fx.repo('o/t').etagOf('config.json')).toMatch(/^[0-9a-f]{40}$/);
  expect(fx.repo('o/t').etagOf('model.safetensors')).toMatch(/^[0-9a-f]{64}$/);
});
it('model_index.json lists every component', () => {
  const files = diffusersFiles('F', ['transformer', 'vae']);
  const idx = files.find((f) => f.path === 'model_index.json')!;
  const content = (idx as { blob: { content: string } }).blob.content;
  expect(JSON.parse(content)).toEqual({ _class_name: 'FluxPipeline', _diffusers_version: '0.30.0',
    transformer: ['diffusers', 'Component'], vae: ['diffusers', 'Component'] });
});
