import { describe, expect, it } from 'vitest';
import { isDraft, isGguf, isMmproj, isShard, quantBits, quantLabel, shardInfo } from '../../../src/core/classify/gguf-names';
import { useCanaries } from '../../helpers/canary';

useCanaries();

describe('gguf name predicates', () => {
  it.each([
    ['Qwen3.6-27B-UD-Q4_K_XL.gguf', true], ['BF16/x.GGUF', true], ['x.gguf.part', false], ['README.md', false],
  ])('isGguf(%s)', (p, w) => expect(isGguf(p)).toBe(w));
  it.each([
    ['mmproj-F16.gguf', true], ['vision/MMPROJ-BF16.gguf', true], ['Qwen-mmproj-f32.gguf', true],
    ['mmproj/Qwen3.6-27B-Q8_0.gguf', false],
    ['mmproj-F16.bin', false],
  ])('isMmproj(%s)', (p, w) => expect(isMmproj(p)).toBe(w));
  it.each([
    ['BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', true], ['Qwen3.6-27B-BF16-00002-of-00002.GGUF', true],
    ['x-0001-of-0002.gguf', false], ['x-00001-of-00002-extra.gguf', false],
    ['model-00001-of-00002.safetensors', false],
  ])('isShard(%s) (stem = basename minus 5 chars)', (p, w) => expect(isShard(p)).toBe(w));
  it('shardInfo', () => {
    expect(shardInfo('BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf')).toEqual({ base: 'Qwen3.6-27B-BF16', index: 2, total: 2 });
    expect(shardInfo('Qwen3.6-27B-Q8_0.gguf')).toBeNull();
  });
  it.each([
    ['MTP/Qwen3.6-27B-Q8_0.gguf', true], ['a/MTP/b/x.gguf', true], ['mtp-Qwen3.6-27B-Q4_K_M.gguf', true],
    ['MTP-x.gguf', true],
    ['mtp/x.gguf', false], ['Mtp/x.gguf', false],
    ['x-mtp-Q4.gguf', false], ['MTP.gguf', false],
  ])('isDraft(%s)', (p, w) => expect(isDraft(p)).toBe(w));
});

describe('quantBits and quantLabel', () => {
  it.each([
    ['Qwen3.6-27B-UD-Q4_K_XL.gguf', 4], ['Qwen3.6-27B-Q8_0.gguf', 8], ['Qwen3.6-27B-IQ2_XXS.gguf', 2],
    ['Qwen3.6-27B-TQ1_0.gguf', 1], ['Qwen3.6-27B-CD-Q3_K_M.gguf', 3], ['model.q5_1.GGUF', 5],
    ['Qwen3.6-27B-BF16.gguf', 16], ['mmproj-F16.gguf', 16], ['x_F32.gguf', 16],
    ['BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', null],
    ['gpt-oss-20b-MXFP4.gguf', null], ['Qwen3.6-27B.gguf', null],
    ['x-Q2_K-Q8_0.gguf', 2],
    ['Q4_K_M', 4],
  ])('quantBits(%s) = %s', (p, w) => expect(quantBits(p)).toBe(w));

  describe('quantLabel', () => {
    const W = ['Qwen3.6-27B-UD-Q4_K_XL.gguf', 'Qwen3.6-27B-Q8_0.gguf',
               'BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', 'BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf',
               'UD-IQ2_XXS/Qwen3.6-27B-UD-IQ2_XXS.gguf'];
    it.each([
      [W[0]!, 'UD-Q4_K_XL'], [W[1]!, 'Q8_0'], [W[2]!, 'BF16'], [W[3]!, 'BF16'], [W[4]!, 'UD-IQ2_XXS'],
    ])('%s -> %s', (p, w) => expect(quantLabel(p, W)).toBe(w));
    it('trims the common prefix back to the last - or .', () => {
      const X = ['Qwen3.6-27B-UD-Q4_K_XL.gguf', 'Qwen3.6-27B-UD-Q2_K_XL.gguf'];
      expect(X.map(p => quantLabel(p, X))).toEqual(['Q4_K_XL', 'Q2_K_XL']);
    });
    it('a single weight file is labelled by the text after its last - or .', () =>
      expect(quantLabel('Qwen3.6-27B-UD-Q4_K_XL.gguf', ['Qwen3.6-27B-UD-Q4_K_XL.gguf'])).toBe('Q4_K_XL'));
    it('falls back to the full stem when the remainder is empty', () =>
      expect(quantLabel('model.gguf', ['model.gguf'])).toBe('model'));
    it('a prefix with no - or . trims nothing', () => {
      const Y = ['abcQ4.gguf', 'abcQ8.gguf'];
      expect(Y.map(p => quantLabel(p, Y))).toEqual(['abcQ4', 'abcQ8']);
    });
  });
});
