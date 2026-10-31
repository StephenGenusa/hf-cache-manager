import { expect, test } from 'vitest';
import {
  CANNOT_LOAD,
  DRAFTERS,
  MMPROJ_ORDER,
  QAT_TOKENS,
  SLOW_ON_NVIDIA,
  detectFormat,
  formatSupport,
  ggufTypeSupport,
  type RepoFormat,
  type Support,
  type Tool,
} from '../../src/shared/knowledge/rules';

test.each<[string, Tool, Support]>([
  ['Q4_K_M', 'ollama', 'yes'],
  ['IQ3_XS', 'lmstudio', 'yes'],
  ['Q4_K_M', 'tabbyapi', 'no'],
  ['Q4_K_M', 'vllm', 'unknown'],
  ['NVFP4', 'llama.cpp', 'yes'],
  ['NVFP4', 'lmstudio', 'unknown'],
  ['NVFP4', 'ollama', 'unknown'],
  ['MXFP4', 'lmstudio', 'unknown'],
  ['MXFP4', 'ollama', 'yes'],
  ['MXFP4', 'vllm', 'unknown'],
  ['PTQ1_0', 'llama.cpp', 'no'],
  ['PQ2_0', 'ollama', 'no'],
  ['TQ1_0', 'llama.cpp', 'yes'],
  ['PTQ1_0', 'lmstudio', 'no'],
  ['XQ', 'ollama', 'no'],
  ['PTQ1_0', 'vllm', 'unknown'],
  ['PTQ1_0', 'tabbyapi', 'unknown'],
  ['PTQ1_0', 'transformers', 'unknown'],
  ['Q1_0', 'llama.cpp', 'yes'],
  ['Q2_0', 'lmstudio', 'unknown'],
])('ggufTypeSupport(%s, %s) is %s', (t, tool, want) => expect(ggufTypeSupport(t, tool)).toBe(want));

test.each<[RepoFormat, Tool, NodeJS.Platform, Support]>([
  ['mlx', 'lmstudio', 'linux', 'no'],
  ['mlx', 'lmstudio', 'darwin', 'yes'],
  ['mlx', 'ollama', 'win32', 'no'],
  ['awq', 'vllm', 'linux', 'yes'],
  ['awq', 'ollama', 'linux', 'no'],
  ['gptq', 'transformers', 'linux', 'yes'],
  ['exl3', 'tabbyapi', 'linux', 'yes'],
  ['exl3', 'vllm', 'linux', 'no'],
  ['fp8', 'transformers', 'linux', 'unknown'],
  ['gguf', 'llama.cpp', 'linux', 'yes'],
  ['mlx', 'llama.cpp', 'linux', 'no'],
  ['mlx', 'vllm', 'win32', 'no'],
  ['mlx', 'vllm', 'darwin', 'unknown'],
  ['safetensors-16', 'llama.cpp', 'linux', 'unknown'],
  ['safetensors-16', 'ollama', 'linux', 'unknown'],
  ['safetensors-16', 'tabbyapi', 'linux', 'unknown'],
  ['nvfp4-st', 'llama.cpp', 'linux', 'unknown'],
  ['nvfp4-st', 'transformers', 'linux', 'unknown'],
  ['exl3', 'transformers', 'linux', 'unknown'],
  ['gguf', 'vllm', 'linux', 'unknown'],
  ['onnx', 'llama.cpp', 'linux', 'no'],
  ['unknown', 'vllm', 'linux', 'unknown'],
])('formatSupport(%s, %s, %s) is %s', (f, tool, p, want) =>
  expect(formatSupport(f, tool, p)).toBe(want));

test('constants', () => {
  expect(MMPROJ_ORDER).toEqual(['F16', 'BF16', 'Q8_0']);
  expect(SLOW_ON_NVIDIA).toEqual(['TQ1_0', 'TQ2_0', 'IQ1_M']);
  expect(QAT_TOKENS).toEqual(['qat', 'QAT', 'qat-q4_0', 'QAD']);
  expect(CANNOT_LOAD.map((c) => c.token)).toEqual(
    expect.arrayContaining(['XQ', 'VQ', 'Strata', 'NInfer', 'prefiller', 'Gyro', 'PTQ1_0', 'PQ2_0']),
  );
  expect(CANNOT_LOAD.map((c) => c.token)).not.toContain('Q4_0_4_4');
  expect(DRAFTERS.map((d) => d.token)).toEqual(['MTP', 'DFlash', 'DSpark', 'EAGLE']);
});

const d = (repoId: string, relpaths: string[] = [], quantizationConfig: unknown = null) =>
  detectFormat({ repoId, relpaths, quantizationConfig });

test.each<[RepoFormat, RepoFormat]>([
  [d('mlx-community/X-4bit'), 'mlx'],
  [d('a/X-MLX'), 'mlx'],
  [d('a/X', [], { quant_method: 'awq' }), 'awq'],
  [d('a/X', [], { quant_method: 'gptq' }), 'gptq'],
  [d('a/X', [], { quant_method: 'fp8' }), 'fp8'],
  [d('a/X', [], { quant_method: 'bitsandbytes' }), 'bnb'],
  [d('a/X', [], { quant_method: 'exl3' }), 'exl3'],
  [d('a/X', [], { quant_method: 'modelopt', quant_algo: 'NVFP4' }), 'nvfp4-st'],
  [d('a/X-FP8', [], { quant_method: 'compressed-tensors' }), 'fp8'],
  [d('a/X', [], { quant_method: 'compressed-tensors' }), 'unknown'],
  [d('a/X', ['onnx/model.onnx']), 'onnx'],
  [d('a/X', ['a/b.gguf']), 'gguf'],
  [d('a/X-AWQ'), 'awq'],
  [d('a/X-GPTQ-Int4'), 'gptq'],
  [d('a/X-EXL3-4.0bpw'), 'exl3'],
  [d('a/X-NVFP4'), 'nvfp4-st'],
  [d('a/X', ['model.safetensors']), 'unknown'],
  [d('a/X'), 'unknown'],
])('detectFormat case %#', (got, want) => expect(got).toBe(want));

test('drafters run where the guide says', () => {
  expect(DRAFTERS.find((x) => x.token === 'EAGLE')?.runsIn).toEqual(['vllm']);
  expect(DRAFTERS.find((x) => x.token === 'MTP')?.runsIn).toEqual(['llama.cpp']);
});
test('detectFormat precedence and edge cases', () => {
  expect(d('a/X-GGUF', ['mmproj-F16.gguf'])).toBe('unknown');
  expect(d('mlx-community/X', [], { bits: 4, group_size: 64 })).toBe('mlx');
  expect(d('a/X', ['m.gguf'], { quant_method: 'awq' })).toBe('awq');
});
