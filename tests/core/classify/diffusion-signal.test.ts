import { describe, expect, it } from 'vitest';
import { diffusionSignal, loraTagged, readFrontMatter } from '../../../src/core/classify/diffusion-signal';

const readme = (front: string): string => `---\n${front}\n---\n# Card\n`;

describe('readFrontMatter', () => {
  it('reads a block tag list and a pipeline tag', () => {
    expect(readFrontMatter(readme('pipeline_tag: text-to-image\ntags:\n  - comfyui\n  - "low-vram"\nlicense: other')))
      .toEqual({ pipelineTag: 'text-to-image', libraryName: null, tags: ['comfyui', 'low-vram'] });
  });
  it('reads an inline tag list and a library name', () => {
    expect(readFrontMatter(readme("library_name: diffusers\ntags: [Comfyui, 'w6a8']")))
      .toEqual({ pipelineTag: null, libraryName: 'diffusers', tags: ['comfyui', 'w6a8'] });
  });
  it('reads a README with CRLF line ends and a byte order mark', () => {
    expect(readFrontMatter('﻿---\r\npipeline_tag: text-to-video\r\n---\r\nbody').pipelineTag).toBe('text-to-video');
  });
  it('ignores a README with no front matter, or front matter never closed', () => {
    const none = { pipelineTag: null, libraryName: null, tags: [] };
    expect(readFrontMatter('# pipeline_tag: text-to-image')).toEqual(none);
    expect(readFrontMatter('---\npipeline_tag: text-to-image\n')).toEqual(none);
  });
  it('does not read keys from the body after the front matter', () => {
    expect(readFrontMatter(`${readme('license: mit')}pipeline_tag: text-to-image\n`).pipelineTag).toBeNull();
  });
  it('a nested key is not a top-level one', () => {
    expect(readFrontMatter(readme('widget:\n  pipeline_tag: text-to-image')).pipelineTag).toBeNull();
  });
  it('a list under another key is not the tag list', () => {
    expect(readFrontMatter(readme('language:\n  - comfyui\ntags:\n  - a')).tags).toEqual(['a']);
  });
});

describe('diffusionSignal', () => {
  const REBELS = JSON.stringify({ quantization: 'w6a8_int8', format: 'w6a8', weight_bits: 6, activation_bits: 8, loader: 'comfyui', library: 'comfy-kitchen' });

  it.each([
    ['config names the ComfyUI loader', REBELS, null, 'comfyui'],
    ['config names only comfy-kitchen', '{"library":"comfy-kitchen"}', null, 'comfyui'],
    ['README tag comfyui, no config', null, readme('tags:\n  - comfyui'), 'comfyui'],
    ['README tag comfy-kitchen', null, readme('tags: [comfy-kitchen]'), 'comfyui'],
    ['comfyui wins over a diffusion tag', null, readme('tags: [diffusion-single-file, comfyui]'), 'comfyui'],
    ['README tag diffusion-single-file', null, readme('tags: [diffusion-single-file]'), 'diffusion'],
    ['text-to-image', null, readme('pipeline_tag: text-to-image'), 'diffusion'],
    ['image-to-image', null, readme('pipeline_tag: image-to-image'), 'diffusion'],
    ['text-to-video', null, readme('pipeline_tag: text-to-video'), 'diffusion'],
    ['image-to-video', null, readme('pipeline_tag: image-to-video'), 'diffusion'],
    ['library diffusers', null, readme('library_name: diffusers'), 'diffusion'],
    ['a config with no model facts does not block the README', '{}', readme('pipeline_tag: text-to-image'), 'diffusion'],
  ])('%s', (_n, config, card, want) => expect(diffusionSignal(config, card)).toBe(want));

  it.each([
    ['nothing to read', null, null],
    ['language model card', null, readme('pipeline_tag: text-generation')],
    ['W6A8 in the tags proves nothing: vLLM language models carry it too', null, readme('tags: [w6a8, quantized]')],
    ['a transformers model_type outranks README tags', '{"model_type":"qwen3_5"}', readme('tags: [comfyui]')],
    ['transformers architectures outrank README tags', '{"architectures":["X"]}', readme('pipeline_tag: text-to-image')],
    ['a diffusers component config outranks README tags', '{"_class_name":"AutoencoderKL"}', readme('pipeline_tag: text-to-image')],
    ['an unparseable config blocks the README', '{oops', readme('tags: [comfyui]')],
    ['a config that is not an object blocks the README', '[1]', readme('tags: [comfyui]')],
    ['a non-string loader is not a signal', '{"loader":1}', null],
    ['another loader is not a signal', '{"loader":"vllm"}', null],
  ])('none: %s', (_n, config, card) => expect(diffusionSignal(config, card)).toBeNull());
});

describe('loraTagged', () => {
  it.each([
    ['README tag, no config', null, readme('tags: [lora]'), true],
    ['tag in any case, with a pipeline tag', null, readme('pipeline_tag: text-to-image\ntags:\n  - LoRA'), true],
    ['beats a ComfyUI README tag', null, readme('tags: [comfyui, lora]'), true],
    ['a config with no model facts does not block it', '{}', readme('tags: [lora]'), true],
    ['no tag', null, readme('tags: [text-to-image]'), false],
    ['no README', null, null, false],
    ['a config naming the ComfyUI loader outranks it', '{"loader":"comfyui"}', readme('tags: [lora]'), false],
    ['a transformers model_type outranks it', '{"model_type":"gemma4"}', readme('tags: [lora]'), false],
    ['an unparseable config blocks it', '{oops', readme('tags: [lora]'), false],
  ])('%s', (_n, config, card, want) => expect(loraTagged(config, card)).toBe(want));
});
