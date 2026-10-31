// Hand-written rules the GGUF quant guide's tables cannot encode.
// Cells the guide marks "Not confirmed", or "if its bundled llama.cpp is new enough", are 'unknown'.

export type Tool = 'llama.cpp' | 'lmstudio' | 'ollama' | 'vllm' | 'tabbyapi' | 'transformers';
// Mirrors NodeJS.Platform; shared code is built without Node types.
export type Platform =
  | 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32'
  | 'cygwin' | 'netbsd';
export type Support = 'yes' | 'no' | 'unknown';
export type RepoFormat =
  | 'gguf' | 'mlx' | 'onnx' | 'safetensors-16' | 'fp8' | 'awq' | 'gptq' | 'exl3' | 'exl2'
  | 'bnb' | 'nvfp4-st' | 'unknown';

// Files that do not load in stock llama.cpp, LM Studio or Ollama (PTQ1_0, PQ2_0 among them).
// The removed Q4_0_4_4 / Q4_0_4_8 / Q4_0_8_8 types are deliberately absent.
export const CANNOT_LOAD: ReadonlyArray<{ token: string; needs: string }> = [
  { token: 'XQ', needs: "IndrasMirror's Xolotl engine, a fork of Strata" },
  { token: 'VQ', needs: 'The ds4-dfm-rs runtime from the YoungAi recipe' },
  { token: 'Strata', needs: 'The Strata engine, which splits big MoE models across GPU, CPU and SSD' },
  { token: 'NInfer', needs: "The NInfer engine, built for one RTX 5090, with its own .ninfer files" },
  { token: 'prefiller', needs: "ISTA's disaggregated llama.cpp fork" },
  { token: 'Gyro', needs: "AgentionAI's trellis-coded format" },
  { token: 'PTQ1_0', needs: "PrismML's llama.cpp fork" },
  { token: 'PQ2_0', needs: "PrismML's llama.cpp fork" },
];

// Brief-mandated preference order, best first. The guide names only mmproj-F16.gguf ("Picking a file"); it states no order.
export const MMPROJ_ORDER: readonly string[] = ['F16', 'BF16', 'Q8_0'];

// Speculative decoding tags (MTP: --spec-type draft-mtp; DFlash: draft-dflash;
// DSpark: draft-dspark; EAGLE: vLLM and SGLang).
export const DRAFTERS: ReadonlyArray<{ token: string; runsIn: Tool[]; note: string }> = [
  { token: 'MTP', runsIn: ['llama.cpp'], note: 'Multi-token prediction layers kept in the GGUF; use --spec-type draft-mtp' },
  { token: 'DFlash', runsIn: ['llama.cpp'], note: 'Drafter only; --spec-type draft-dflash, but not every DFlash drafter runs there yet' },
  { token: 'DSpark', runsIn: ['llama.cpp'], note: "Liquid AI's drafter for LFM2.5; --spec-type draft-dspark" },
  { token: 'EAGLE', runsIn: ['vllm'], note: 'Drafter that predicts the next hidden state; supported in vLLM and SGLang' },
];

// TQ1_0 and TQ2_0 have no CUDA kernels. IQ1_M has "No fast CUDA matrix kernel".
export const SLOW_ON_NVIDIA: readonly string[] = ['TQ1_0', 'TQ2_0', 'IQ1_M'];

// `qat-q4_0` (Google) and the training tags (QAT, QAD).
export const QAT_TOKENS: readonly string[] = ['qat', 'QAT', 'qat-q4_0', 'QAD'];

// Tool support for "GGUF K and I-quants" (generic GGUF types), with the per-type overrides below.
const GGUF_GENERIC: Record<Tool, Support> = {
  'llama.cpp': 'yes',
  lmstudio: 'yes',
  ollama: 'yes',
  vllm: 'unknown', // "Experimental plugin"
  tabbyapi: 'no',
  transformers: 'yes', // opens it, dequantized to 16-bit
};
// Tool support for "GGUF MXFP4".
const GGUF_MXFP4: Record<Tool, Support> = {
  'llama.cpp': 'yes',
  lmstudio: 'unknown', // "if its bundled llama.cpp is new enough"
  ollama: 'yes', // gpt-oss
  vllm: 'unknown',
  tabbyapi: 'no',
  transformers: 'unknown',
};
// Tool support for "GGUF NVFP4" (llama.cpp b8967 and newer).
const GGUF_NVFP4: Record<Tool, Support> = {
  'llama.cpp': 'yes',
  lmstudio: 'unknown',
  ollama: 'unknown',
  vllm: 'unknown',
  tabbyapi: 'no',
  transformers: 'no',
};

/** Quant types and the tools that load them. */
export function ggufTypeSupport(type: string, tool: Tool): Support {
  const t = type.toUpperCase();
  // Fork-only types that stock llama.cpp rejects.
  // The guide says stock llama.cpp, LM Studio and Ollama reject them; for other tools it says nothing.
  if (CANNOT_LOAD.some((c) => c.token.toUpperCase() === t)) {
    return tool === 'llama.cpp' || tool === 'lmstudio' || tool === 'ollama' ? 'no' : 'unknown';
  }
  if (t === 'NVFP4') return GGUF_NVFP4[tool];
  if (t === 'MXFP4' || t === 'MXFP4_MOE') return GGUF_MXFP4[tool];
  // Q1_0 and Q2_0 are new in 2026, so bundled builds may be too old.
  if (t === 'Q1_0' || t === 'Q2_0') {
    return tool === 'llama.cpp' ? 'yes' : GGUF_GENERIC[tool] === 'yes' ? 'unknown' : GGUF_GENERIC[tool];
  }
  return GGUF_GENERIC[tool];
}

type Row = Record<Tool, Support>;
const row = (l: Support, m: Support, o: Support, v: Support, t: Support, x: Support): Row => ({
  'llama.cpp': l, lmstudio: m, ollama: o, vllm: v, tabbyapi: t, transformers: x,
});

// Rule for every conditional cell of the tool table ("After conversion to GGUF", "Convert to GGUF
// NVFP4", "Import with a Modelfile", "After EXL3 conversion", "Through a plugin", "Quantize on load only",
// "if ... new enough", "Not confirmed"): 'unknown', never 'no', so a file the user can convert or import is not
// painted red.
// Tool support per format (llama.cpp, LM Studio, Ollama, vLLM, TabbyAPI, transformers), MLX and ONNX included.
const FORMAT_TABLE: Partial<Record<RepoFormat, Row>> = {
  gguf: row('yes', 'yes', 'yes', 'unknown', 'no', 'yes'),
  onnx: row('no', 'no', 'no', 'no', 'no', 'unknown'), // "None of your tools load ONNX language models"
  'safetensors-16': row('unknown', 'no', 'unknown', 'yes', 'unknown', 'yes'), // llama.cpp: after conversion; Ollama: Modelfile; TabbyAPI: after EXL3 conversion
  fp8: row('no', 'no', 'no', 'yes', 'no', 'unknown'), // transformers needs compute 9.0 or newer
  awq: row('no', 'no', 'no', 'yes', 'no', 'yes'),
  gptq: row('no', 'no', 'no', 'yes', 'no', 'yes'),
  'nvfp4-st': row('unknown', 'no', 'unknown', 'yes', 'no', 'unknown'), // llama.cpp: convert to GGUF NVFP4; Ollama: import code exists; transformers: quantize on load only
  exl3: row('no', 'no', 'no', 'no', 'yes', 'unknown'), // transformers: through a plugin
  exl2: row('no', 'no', 'no', 'no', 'unknown', 'no'), // TabbyAPI (old backend) is listed as its loader; not confirmed it still works
  bnb: row('no', 'no', 'no', 'yes', 'no', 'yes'),
};

/**
 * MLX loads in LM Studio and Ollama only on Apple Silicon. Spec:
 * "MLX is Apple-only", so off macOS it is 'no' for every tool. On darwin we cannot tell Intel from Apple
 * Silicon and accept 'yes'.
 */
export function formatSupport(f: RepoFormat, tool: Tool, platform: Platform): Support {
  if (f === 'mlx') {
    if (platform !== 'darwin') return 'no';
    if (tool === 'lmstudio' || tool === 'ollama') return 'yes';
    return tool === 'llama.cpp' || tool === 'tabbyapi' ? 'no' : 'unknown';
  }
  return FORMAT_TABLE[f]?.[tool] ?? 'unknown';
}

const parts = (s: string): string[] => s.split(/[^A-Za-z0-9.]+/).filter(Boolean).map((p) => p.toUpperCase());

// Formats are told apart by the quantization_config section of config.json, or by the repo name.
function fromQuantConfig(qc: unknown, nameTokens: string[]): RepoFormat {
  if (typeof qc !== 'object' || qc === null) return 'unknown';
  const o = qc as Record<string, unknown>;
  const method = typeof o.quant_method === 'string' ? o.quant_method.toLowerCase() : '';
  const algo = typeof o.quant_algo === 'string' ? o.quant_algo.toUpperCase() : '';
  const byName = (): RepoFormat => {
    if (nameTokens.includes('NVFP4')) return 'nvfp4-st';
    if (nameTokens.some((p) => p.startsWith('FP8'))) return 'fp8';
    if (nameTokens.includes('AWQ')) return 'awq';
    if (nameTokens.includes('GPTQ')) return 'gptq';
    return 'unknown';
  };
  if (method === 'awq') return 'awq';
  if (method === 'gptq') return 'gptq';
  if (method === 'fp8' || method === 'fbgemm_fp8') return 'fp8';
  if (method === 'nvfp4') return 'nvfp4-st';
  if (method === 'bitsandbytes' || method.startsWith('bnb')) return 'bnb';
  if (method === 'exl3') return 'exl3';
  if (method === 'exl2') return 'exl2';
  if (method === 'modelopt') {
    if (algo.includes('NVFP4')) return 'nvfp4-st';
    if (algo.includes('FP8')) return 'fp8';
    return byName();
  }
  if (method === 'compressed-tensors') return byName(); // holds many schemes, so only the name decides
  return 'unknown';
}

export function detectFormat(input: {
  repoId: string;
  relpaths: string[];
  quantizationConfig: unknown | null;
}): RepoFormat {
  const nameTokens = parts(input.repoId.split('/').pop() ?? '');
  const fromConfig = fromQuantConfig(input.quantizationConfig, nameTokens);
  if (fromConfig !== 'unknown') return fromConfig;
  const lower = input.relpaths.map((p) => p.toLowerCase());
  if (lower.some((p) => p.endsWith('.gguf') && !p.includes('mmproj'))) return 'gguf';
  if (lower.some((p) => p.endsWith('.onnx'))) return 'onnx';
  if (input.repoId.toLowerCase().startsWith('mlx-community/') || nameTokens.includes('MLX')) return 'mlx';
  if (nameTokens.includes('NVFP4')) return 'nvfp4-st';
  if (nameTokens.some((p) => p.startsWith('EXL3'))) return 'exl3';
  if (nameTokens.some((p) => p.startsWith('EXL2'))) return 'exl2';
  if (nameTokens.includes('AWQ')) return 'awq';
  if (nameTokens.includes('GPTQ')) return 'gptq';
  if (nameTokens.some((p) => p.startsWith('FP8'))) return 'fp8';
  return 'unknown';
}
