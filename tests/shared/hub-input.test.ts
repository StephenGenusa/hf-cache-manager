import { describe, expect, test } from 'vitest';
import { encodeRevision, isCommitHash, parseHubInput, safeRef } from '../../src/shared/hub-input';

const ok = (repoId: string, type: string, revision = 'main') => ({ repoId, type, revision });

describe('parseHubInput', () => {
  test.each([
    ['https://huggingface.co/zai-org/GLM-OCR', ok('zai-org/GLM-OCR', 'model')],
    ['https://huggingface.co/zai-org/GLM-OCR/tree/main/x', ok('zai-org/GLM-OCR', 'model')],
    ['https://huggingface.co/zai-org/GLM-OCR/blob/main/a.json', ok('zai-org/GLM-OCR', 'model')],
    ['https://huggingface.co/zai-org/GLM-OCR?foo=bar#frag', ok('zai-org/GLM-OCR', 'model')],
    ['https://hf.co/a/b', ok('a/b', 'model')],
    ['https://www.huggingface.co/a/b', ok('a/b', 'model')],
    ['HTTPS://WWW.HF.CO/a/b', ok('a/b', 'model')],
    ['https://huggingface.co/datasets/d/n', ok('d/n', 'dataset')],
    ['https://huggingface.co/spaces/s/n', ok('s/n', 'space')],
    ['https://huggingface.co/models/m/n', ok('m/n', 'model')],
    // pasted without the scheme: the host is stripped, never read as the namespace
    ['huggingface.co/abenzerps/Nanbeige4.3-33B-GSQ-RCO-GGUF', ok('abenzerps/Nanbeige4.3-33B-GSQ-RCO-GGUF', 'model')],
    ['www.huggingface.co/a/b/tree/main/x', ok('a/b', 'model')],
    ['HF.co/a/b?x=1#f', ok('a/b', 'model')],
    ['huggingface.co/datasets/d/n', ok('d/n', 'dataset')],
    ['datasets/d/n', ok('d/n', 'dataset')],
    ['spaces/s/n', ok('s/n', 'space')],
    ['models/m/n', ok('m/n', 'model')],
    ['  unsloth/Qwen3.6-35B-A3B-GGUF  ', ok('unsloth/Qwen3.6-35B-A3B-GGUF', 'model')],
    ['org/name@refs/pr/1', ok('org/name', 'model', 'refs/pr/1')],
    ['org/name@feature/x', ok('org/name', 'model', 'feature/x')],
    ['datasets/d/n@v1', ok('d/n', 'dataset', 'v1')],
  ])('%s', (input, expected) => expect(parseHubInput(input)).toEqual(expected));

  test('not a Hugging Face URL', () =>
    expect(parseHubInput('https://example.com/a/b')).toEqual({
      error: "Not a Hugging Face URL: 'https://example.com/a/b'",
    }));

  test('invalid path format', () =>
    expect(parseHubInput('justname')).toEqual({
      error:
        "Invalid Hugging Face path format: 'justname'\nExpected: <namespace>/<name> (e.g. unsloth/Qwen3.6-35B-A3B-GGUF)",
    }));

  test('bad name characters and prefix-only inputs are invalid', () => {
    for (const bad of ['a b/c', 'datasets/onlyone', '', 'a/b c', 'a$/b', './b', '../b', 'a/.', 'a/..', 'datasets/../x', 'huggingface.co/onlyone', 'hf.co'])
      expect(parseHubInput(bad), bad).toHaveProperty('error');
  });

  test('empty or unsafe revision is rejected', () => {
    for (const bad of ['a/b@', 'a/b@../x', 'a/b@/x', 'a/b@x y'])
      expect(parseHubInput(bad), bad).toHaveProperty('error');
  });
});

describe('revision helpers', () => {
  test('encodeRevision encodes each segment', () => {
    expect(encodeRevision('refs/pr/1')).toBe('refs/pr/1');
    expect(encodeRevision('a b/c')).toBe('a%20b/c');
    expect(encodeRevision('x#y?z')).toBe('x%23y%3Fz');
  });
  test('isCommitHash is exactly 40 hex', () => {
    expect(isCommitHash('a'.repeat(40))).toBe(true);
    expect(isCommitHash('A1'.repeat(20))).toBe(true);
    expect(isCommitHash('a'.repeat(39))).toBe(false);
    expect(isCommitHash('a'.repeat(41))).toBe(false);
    expect(isCommitHash('g'.repeat(40))).toBe(false);
    expect(isCommitHash('main')).toBe(false);
  });
  test('safeRef', () => {
    expect(safeRef('../x')).toBe(false);
    expect(safeRef('a/../b')).toBe(false);
    expect(safeRef('/abs')).toBe(false);
    expect(safeRef('a b')).toBe(false);
    expect(safeRef('')).toBe(false);
    for (const bad of ['a//b', 'a/', './a', 'a/./b', '.', '..']) expect(safeRef(bad), bad).toBe(false);
    expect(safeRef('a.b/c..d')).toBe(false);
    expect(safeRef('refs/pr/1')).toBe(true);
    expect(safeRef('v1.0_x-y')).toBe(true);
  });
});
