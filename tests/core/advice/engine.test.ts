import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advise, effectiveProfile } from '../../../src/core/advice/engine';
import { countedWeights, kvCacheBytes, shapeFromConfig, sumCounted, type ModelShape } from '../../../src/core/advice/shape';
import type { AdviceGroupInput, AdviceInput, AdviceSettings, GroupAdvice, MachineProfile, RepoAdvice } from '../../../src/core/advice/types';
import type { RepoFormat, Tool } from '../../../src/shared/knowledge/rules';
import { KNOWLEDGE } from '../../../src/shared/knowledge';

const GB = 1e9;
const HEADROOM = 1_610_612_736;
const CTX = 32768;

/** A shape whose KV cache at 32K F16 is exactly `kvF16` bytes (q8_0 is 0.53125 of that). */
const shape = (paramCount: number, kvF16 = 0.5 * GB, extra: Partial<ModelShape> = {}): ModelShape => {
  const dim = kvF16 / (2 * CTX * 2);
  return { arch: 'llama', fileType: null, paramCount, expertCount: 0, layers: 1, contextLength: CTX,
    kvLayers: [{ kvHeads: 1, headDimK: dim, headDimV: dim, window: null }], ...extra };
};

const quant = (label: string, bytes: number, s: ModelShape | null, extra: Partial<AdviceGroupInput> = {}): AdviceGroupInput =>
  ({ key: `quant:${label}`, kind: 'quant', label, bytes, relpaths: [`m-${label}.gguf`], shape: s, shards: null, locked: false, ...extra });
const group = (kind: AdviceGroupInput['kind'], label: string, bytes: number, relpaths: string[], extra: Partial<AdviceGroupInput> = {}): AdviceGroupInput =>
  ({ key: `${kind}:${label}`, kind, label, bytes, relpaths, shape: null, shards: null, locked: false, ...extra });

const NVIDIA: MachineProfile = { platform: 'linux', ramBytes: 64 * GB, gpuName: 'RTX 5090', gpuBytes: 24 * GB,
  gpuKind: 'nvidia', computeCap: 8.9, drivesDisplay: false };
const SETTINGS: AdviceSettings = { gpuBytes: null, gpuKind: null, ramBytes: null, drivesDisplay: null,
  context: 32768, kvType: 'f16', tools: null };
const TOOLS: Tool[] = ['llama.cpp', 'lmstudio', 'ollama'];
const GiB = 2 ** 30;
/** An example machine as detection reports it: nvidia-smi reports 24564 MiB, os.totalmem() 64 GiB. */
const REAL: MachineProfile = { ...NVIDIA, gpuBytes: 24564 * 2 ** 20, ramBytes: 64 * GiB };

const input = (groups: AdviceGroupInput[], o: Partial<AdviceInput> = {}): AdviceInput =>
  ({ repoId: 'org/Model-GGUF', format: 'gguf', repoKind: 'gguf', repoShape: null, repoWeights: null, incomplete: false, groups, machine: NVIDIA, settings: SETTINGS, tools: TOOLS, knowledge: KNOWLEDGE, ...o });
const run = (groups: AdviceGroupInput[], o: Partial<AdviceInput> = {}): Record<string, GroupAdvice> =>
  Object.fromEntries(advise(input(groups, o)).groups.map((g) => [g.key.replace(/^[a-z-]+:/, ''), g]));

const P20 = 20e9;   // a 20B model: Q6_K 16.4 GB fits with room, Q8_0 21.25 GB is tight

describe('effectiveProfile', () => {
  it('uses detected values when nothing is overridden', () => {
    expect(effectiveProfile(NVIDIA, SETTINGS)).toEqual({ gpuBytes: 24 * GB, ramBytes: 64 * GB, gpuKind: 'nvidia' });
  });
  it('lets settings win over detection', () => {
    const s = { ...SETTINGS, gpuBytes: 16 * GB, gpuKind: 'other' as const, ramBytes: 32 * GB, drivesDisplay: true };
    expect(effectiveProfile(NVIDIA, s)).toEqual({ gpuBytes: 15 * GB, ramBytes: 32 * GB, gpuKind: 'other' });
  });
  it('takes 1 GB off a GPU that drives the display', () => {
    expect(effectiveProfile({ ...NVIDIA, drivesDisplay: true }, SETTINGS).gpuBytes).toBe(23 * GB);
    expect(effectiveProfile({ ...NVIDIA, drivesDisplay: true }, { ...SETTINGS, drivesDisplay: false }).gpuBytes).toBe(24 * GB);
    expect(effectiveProfile({ ...NVIDIA, gpuBytes: 0.5 * GB, drivesDisplay: true }, SETTINGS).gpuBytes).toBe(0);
  });
  it('uses 75% of RAM on Apple unified memory unless GPU memory is overridden', () => {
    const mac: MachineProfile = { ...NVIDIA, platform: 'darwin', gpuKind: 'apple', gpuName: null, gpuBytes: null };
    expect(effectiveProfile(mac, SETTINGS).gpuBytes).toBe(48 * GB);
    expect(effectiveProfile(mac, { ...SETTINGS, ramBytes: 32 * GB }).gpuBytes).toBe(24 * GB);
    expect(effectiveProfile(mac, { ...SETTINGS, gpuBytes: 40 * GB }).gpuBytes).toBe(40 * GB);
  });
  it('keeps unknown GPU memory unknown, even with the display flag', () => {
    expect(effectiveProfile({ ...NVIDIA, gpuBytes: null, drivesDisplay: true }, SETTINGS).gpuBytes).toBeNull();
  });
});

describe('rule 1: cannot load', () => {
  it('paints a fork-only type red when none of the tools loads it', () => {
    const a = run([quant('XQ', 10 * GB, shape(P20))]).XQ!;
    expect(a.tint).toBe('red');
    expect(a.reason).toBe("Needs IndrasMirror's Xolotl engine, a fork of Strata; none of your tools load it");
  });
  it('finds a fork-only tag inside a longer label and from the header type', () => {
    expect(run([quant('Model-Gyro-4bit', 10 * GB, shape(P20))])['Model-Gyro-4bit']!.tint).toBe('red');
    expect(run([quant('PTQ1_0', 3 * GB, shape(P20, 0.5 * GB, { fileType: 'PTQ1_0' }))]).PTQ1_0!.reason).toContain("PrismML's llama.cpp fork");
  });
  it('is yellow, not red, when a selected tool might load it', () => {
    const a = run([quant('NVFP4', 11 * GB, shape(P20))], { tools: ['lmstudio', 'ollama'] }).NVFP4!;
    expect(a.tint).toBe('yellow');
    expect(a.reason).toBe('Not confirmed to load in LM Studio, Ollama');
    expect(a.explanation).toContain('NVFP4 needs llama.cpp b8967 or newer');
  });
  it('a "not confirmed" caveat does not hide a too-big red', () => {
    const a = run([quant('NVFP4', 100 * GB, shape(200e9))], { tools: ['lmstudio', 'ollama'] }).NVFP4!;
    expect(a).toMatchObject({ tint: 'red', reason: 'Too big for this PC' });
    expect(a.explanation).toContain('Not confirmed to load in LM Studio, Ollama');
    expect(a.explanation).toContain('more than it has');
  });
  it('a fitting "not confirmed" group stays yellow and leaves the green to another file', () => {
    const r = run([quant('NVFP4', 13 * GB, shape(P20)), quant('Q4_K_M', 11.5 * GB, shape(P20))], { tools: ['lmstudio', 'ollama'] });
    expect(r.NVFP4!).toMatchObject({ tint: 'yellow', reason: 'Not confirmed to load in LM Studio, Ollama' });
    expect(r.NVFP4!.explanation).toContain('It fits with');
    expect(r.Q4_K_M!.tint).toBe('green');
  });
  it('a caveat ties with a yellow size reason: the size reason wins', () => {
    const r = run([quant('NVFP4', 19 * GB, shape(P20, 4 * GB)), quant('Q4_K_M', 11.5 * GB, shape(P20))], { tools: ['lmstudio', 'ollama'] });
    expect(r.NVFP4!).toMatchObject({ tint: 'yellow', reason: 'Tight: fits only with a q8_0 KV cache' });
    const alone = run([quant('NVFP4', 13 * GB, shape(P20))], { tools: ['lmstudio', 'ollama'] }).NVFP4!;
    expect(alone).toMatchObject({ tint: 'yellow', reason: 'Not confirmed to load in LM Studio, Ollama' });
    const lower = run([quant('NVFP4', 8 * GB, shape(P20)), quant('Q6_K', 16.4 * GB, shape(P20))], { tools: ['lmstudio', 'ollama'] });
    expect(lower.NVFP4!.reason).toBe('Fits, but Q6_K is better and also fits');
  });
  it('a caveat with missing facts is yellow and says both', () => {
    const a = run([quant('NVFP4', 11 * GB, null)], { tools: ['lmstudio', 'ollama'] }).NVFP4!;
    expect(a).toMatchObject({ tint: 'yellow', reason: 'Not confirmed to load in LM Studio, Ollama' });
    expect(a.explanation).toContain('Model shape unknown: header unreadable.');
    expect(a.explanation).toContain('NVFP4 needs llama.cpp b8967 or newer');
    const b = run([quant('Q4_K_M', 11 * GB, null)], { tools: ['vllm'] }).Q4_K_M!;
    expect(b.explanation).toBe('Model shape unknown: header unreadable. Not confirmed to load in vLLM / SGLang: the guide does not confirm that vLLM / SGLang can load Q4_K_M.');
  });
  it('names the loader a plain GGUF needs when no selected tool loads GGUF', () => {
    const a = run([quant('Q4_K_M', 10 * GB, shape(P20))], { tools: ['tabbyapi'] }).Q4_K_M!;
    expect(a).toMatchObject({ tint: 'red', reason: 'Needs llama.cpp; none of your tools load it' });
  });
  it('still applies with no GPU memory and no shape', () => {
    const m = { ...NVIDIA, gpuBytes: null };
    expect(run([quant('XQ', 10 * GB, null)], { machine: m }).XQ!.tint).toBe('red');
  });
  it('says the tools are missing instead of guessing when none are selected', () => {
    const r = advise(input([quant('Q4_K_M', 10 * GB, shape(P20)), group('draft', 'draft', 1, ['MTP/x.gguf']),
      group('mmproj', 'vision projector (F16)', 1, ['mmproj-F16.gguf'])], { tools: [], format: 'awq' }));
    for (const g of r.groups) expect(g).toMatchObject({ tint: null, reason: 'Pick the tools you use in Settings for advice' });
    expect(advise(input([], { tools: [], repoId: 'org/X-DFlash', format: 'safetensors-16' })).repoLine!.tint).toBeNull();
    expect(advise(input([], { tools: [], repoId: 'org/X-MTP-GGUF' })).repoLine).toBeNull();
    expect(r.repoLine).toMatchObject({ tint: null, reason: 'Pick the tools you use in Settings for advice' });
    expect(r.basis).toContain('no tools chosen');
  });
  it('gives no tint when the file type is unknown', () => {
    const a = run([quant('weird', 10 * GB, shape(P20))]).weird!;
    expect(a).toMatchObject({ tint: null, reason: 'File type unknown: not in the header or the name' });
  });
});

describe('rule 2: too big', () => {
  const P32 = 32e9;
  it('dense: red, would run partly from system RAM', () => {
    const a = run([quant('Q8_0', 36.9 * GB, shape(P32))], { machine: REAL }).Q8_0!;
    expect(a).toMatchObject({ tint: 'red', reason: 'Too big for 24 GB; would run partly from system RAM, slowly' });
    expect(a.explanation).toContain('Your RTX 5090 has 25.8 GB');
  });
  it('MoE that fits in GPU + RAM − 8 GB: yellow', () => {
    const a = run([quant('Q6_K', 30 * GB, shape(P32, 0.5 * GB, { expertCount: 128 }))]).Q6_K!;
    expect(a).toMatchObject({ tint: 'yellow', reason: 'Larger than VRAM; as a MoE it can keep experts in RAM, at lower speed' });
  });
  it('more than GPU + RAM − 8 GB: red, too big for this PC', () => {
    const a = run([quant('Q8_0', 100 * GB, shape(200e9, 0.5 * GB, { expertCount: 128 }))]).Q8_0!;
    expect(a).toMatchObject({ tint: 'red', reason: 'Too big for this PC' });
    expect(run([quant('Q8_0', 80 * GB + 1, shape(200e9))]).Q8_0!.reason).toBe('Too big for this PC');
    expect(run([quant('Q8_0', 80 * GB, shape(200e9, 0.5 * GB, { expertCount: 8 }))]).Q8_0!.tint).toBe('yellow');
  });
  it('F32 that does not fit: red, too big to use on this card', () => {
    const a = run([quant('F32', 30 * GB, shape(7.5e9, 0.5 * GB, { expertCount: 8 }))]).F32!;
    expect(a).toMatchObject({ tint: 'red', reason: 'Too big to use on this card' });
  });
  it('F32 that fits follows the size rules', () => {
    expect(run([quant('F32', 8 * GB, shape(2e9))]).F32!.tint).toBe('green');
  });
  it('names the card by its nominal size, with or without the display margin', () => {
    const big = [quant('Q8_0', 36.9 * GB, shape(32e9))];
    const reason = 'Too big for 24 GB; would run partly from system RAM, slowly';
    expect(run(big, { machine: REAL }).Q8_0!.reason).toBe(reason);
    const shown = run(big, { machine: { ...REAL, drivesDisplay: true } }).Q8_0!;
    expect(shown.reason).toBe(reason);
    expect(shown.facts).toContain('1 GB kept free for the display');
    expect(advise(input(big, { machine: { ...REAL, drivesDisplay: true } })).basis).toContain('RTX 5090 24 GB');
  });
});

describe('rule 3: tight', () => {
  it('fits only with a q8_0 KV cache: yellow', () => {
    // f16: 19 + 4 + 1.61 = 24.61 > 24; q8_0: 19 + 2.125 + 1.61 = 22.74, more than 1 GB spare
    const a = run([quant('Q8_0', 19 * GB, shape(P20, 4 * GB))]).Q8_0!;
    expect(a.tint).toBe('yellow');
    expect(a.reason).toBe('Closest fit, but tight: fits only with a q8_0 KV cache');
    expect(a.explanation).toContain('That is more than it has with an F16 KV cache; it fits with a q8_0 KV cache.');
    const two = run([quant('Q8_0', 19 * GB, shape(P20, 4 * GB)), quant('Q6_K', 18.9 * GB, shape(P20, 4 * GB))]);
    expect(two.Q6_K!.reason).toBe('Tight: fits only with a q8_0 KV cache');
  });
  it('fits with less than 1 GB to spare: tight, needs a shorter context', () => {
    // f16 and q8_0 both leave under 1 GB
    const a = run([quant('Q8_0', 21.5 * GB, shape(P20, 0.5 * GB)), quant('Q6_K', 21.4 * GB, shape(P20, 0.5 * GB))]);
    expect(a.Q6_K!).toMatchObject({ tint: 'yellow', reason: 'Tight: fits only with a shorter context' });
    expect(a.Q8_0!.explanation).toContain('less than 1.0 GB to spare');
  });
  it('fits with f16 but tight, comfortable with q8_0: says q8_0', () => {
    // f16: 18 + 4 + 1.61 = 23.61 (0.39 spare); q8_0: 22.74 → 2.26 spare
    expect(run([quant('Q6_K', 18 * GB, shape(P20, 4 * GB))]).Q6_K!.reason).toBe('Closest fit, but tight: fits only with a q8_0 KV cache');
  });
  it('fits only with q8_0 and a shorter context', () => {
    // f16: 21 + 2 + 1.61 = 24.61 > 24; q8_0: 21 + 1.0625 + 1.61 = 23.67, under 1 GB spare
    expect(run([quant('Q6_K', 21 * GB, shape(P20, 2 * GB))]).Q6_K!.reason)
      .toBe('Closest fit, but tight: fits only with a q8_0 KV cache and a shorter context');
  });
  it('with a q8_0 KV cache selected, a tight file needs a shorter context', () => {
    const s = { ...SETTINGS, kvType: 'q8_0' as const };
    expect(run([quant('Q6_K', 21 * GB, shape(P20, 2 * GB))], { settings: s }).Q6_K!.reason).toBe('Closest fit, but tight: fits only with a shorter context');
    expect(run([quant('Q6_K', 23 * GB, shape(P20, 2 * GB))], { settings: s }).Q6_K!.tint).toBe('red');
    expect(run([quant('Q6_K', 21 * GB, shape(P20, 2 * GB))], { settings: s }).Q6_K!.explanation).toContain('at 32K (q8_0)');
  });
});

describe('rule 4: best pick', () => {
  const groups = (): AdviceGroupInput[] => [
    quant('Q8_0', 21.25 * GB, shape(P20)),        // tight
    quant('Q6_K', 16.4 * GB, shape(P20)),         // fits: 6.56 bpw
    quant('UD-Q4_K_XL', 11.3 * GB, shape(P20)),
    quant('Q4_K_M', 11.5 * GB, shape(P20)),
    quant('IQ2_XXS', 5.15 * GB, shape(P20)),      // 2.06 bpw
  ];
  it('exactly one green: the highest effective bpw that fits comfortably', () => {
    const r = run(groups());
    expect(Object.values(r).filter((a) => a.tint === 'green')).toHaveLength(1);
    expect(r.Q6_K!).toMatchObject({ tint: 'green', reason: 'Best pick: fits with room for 32K context' });
    expect(r.Q6_K!.facts).toContain('6.56 bits per weight');
    expect(r.Q8_0!.reason).toBe('Tight: fits only with a shorter context');
  });
  it('at equal size (within 3%) a dynamic recipe beats a static quant', () => {
    const r = run([quant('Q4_K_M', 11.5 * GB, shape(P20)), quant('UD-Q4_K_XL', 11.3 * GB, shape(P20))]);
    expect(r['UD-Q4_K_XL']!.tint).toBe('green');
    expect(r.Q4_K_M!).toMatchObject({ tint: 'yellow', reason: 'Same size as UD-Q4_K_XL, which is the better recipe; keep one' });
  });
  it('recognises i1, IQ and bartowski _L recipes, but not the standard Q3_K_L', () => {
    for (const label of ['i1-Q4_K_M', 'IQ4_XS', 'Q4_K_L', 'Q3_K_XL']) {
      const r = run([quant('Q4_K_S', 11.5 * GB, shape(P20)), quant(label, 11.3 * GB, shape(P20))]);
      expect(r[label]!.tint, label).toBe('green');
    }
    const r = run([quant('Q3_K_M', 11.5 * GB, shape(P20)), quant('Q3_K_L', 11.3 * GB, shape(P20))]);
    expect(r.Q3_K_M!.tint).toBe('green');
  });
  it('a recipe more than 3% smaller does not beat a static quant', () => {
    const r = run([quant('Q4_K_M', 11.5 * GB, shape(P20)), quant('UD-Q4_K_XL', 11.1 * GB, shape(P20))]);
    expect(r.Q4_K_M!.tint).toBe('green');
    expect(r['UD-Q4_K_XL']!.reason).toBe('Fits, but Q4_K_M is better and also fits');
  });
  it('takes the quant type from the header when it has one', () => {
    const r = run([quant('Model', 16.4 * GB, shape(P20, 0.5 * GB, { fileType: 'Q6_K' }))]);
    expect(r.Model!.tint).toBe('green');
    expect(run([quant('Model', 16.4 * GB, shape(P20, 0.5 * GB, { fileType: 'unknown' }))]).Model!.tint).toBeNull();
  });
});

describe('rule 5: duplicates and lower picks', () => {
  const r = run([
    quant('Q6_K', 16.4 * GB, shape(P20)),
    quant('Q6_K_S', 16.0 * GB, shape(P20)),
    quant('Q4_K_M', 11.5 * GB, shape(P20)),
    quant('IQ2_XXS', 5.15 * GB, shape(P20)),
  ]);
  it('the same-size loser: keep one', () => {
    expect(r.Q6_K_S!).toMatchObject({ tint: 'yellow', reason: 'Same size as Q6_K, which is the better recipe; keep one' });
  });
  it('a smaller file of 3 bpw or more: yellow', () => {
    expect(r.Q4_K_M!).toMatchObject({ tint: 'yellow', reason: 'Fits, but Q6_K is better and also fits' });
  });
  it('under 3 bpw while the best is 4 or more: red', () => {
    expect(r.IQ2_XXS!).toMatchObject({ tint: 'red', reason: 'Much lower quality, and Q6_K fits' });
  });
  it('under 3 bpw while the best is under 4: yellow', () => {
    const p = run([quant('Q3_K_M', 8.6 * GB, shape(P20)), quant('IQ2_XXS', 5.15 * GB, shape(P20))]);
    expect(p.IQ2_XXS!.reason).toBe('Fits, but Q3_K_M is better and also fits');
  });
});

describe('no green when nothing fits comfortably', () => {
  it('a 70B repo on 24 GB: zero greens, one closest fit, honest reds', () => {
    const P70 = 70e9;
    const r = run([
      quant('Q4_K_M', 42 * GB, shape(P70)),
      quant('IQ2_XXS', 18 * GB, shape(P70, 4 * GB)),    // tight
      quant('IQ1_S', 17.9 * GB, shape(P70, 4 * GB)),    // tight, lower bpw
    ]);
    expect(Object.values(r).filter((a) => a.tint === 'green')).toHaveLength(0);
    expect(r.IQ2_XXS!).toMatchObject({ tint: 'yellow', reason: 'Closest fit, but tight: fits only with a q8_0 KV cache' });
    expect(r.IQ1_S!.reason).toBe('Tight: fits only with a q8_0 KV cache');
    expect(r.Q4_K_M!.tint).toBe('red');
  });
});

describe('the guide\'s own picks', () => {
  it('a QAT repo makes Q4_0 the green even when Q8_0 also fits', () => {
    const r = run([quant('Q4_0', 6.9 * GB, shape(12e9)), quant('Q8_0', 12.8 * GB, shape(12e9))], { repoId: 'google/gemma-3-12b-it-qat-q4_0-gguf' });
    expect(r.Q4_0!.tint).toBe('green');
    expect(r.Q8_0!).toMatchObject({ tint: 'yellow', reason: 'Fits, but Q4_0 is better and also fits' });
    expect(r.Q4_0!.explanation).toContain('quantization-aware');
  });
  it('recognises QAT tags in any case', () => {
    const r = run([quant('Q4_0', 6.9 * GB, shape(12e9)), quant('Q8_0', 12.8 * GB, shape(12e9))], { repoId: 'org/model-qad-gguf' });
    expect(r.Q4_0!.tint).toBe('green');
  });
  it('a QAT repo with two Q4_0 files picks between them by the usual order', () => {
    const r = run([quant('Q4_0', 6.9 * GB, shape(12e9)), quant('UD-Q4_0', 6.8 * GB, shape(12e9, 0.5 * GB, { fileType: 'Q4_0' }))],
      { repoId: 'org/Model-QAT-GGUF' });
    expect(r['UD-Q4_0']!.tint).toBe('green');
    expect(r.Q4_0!.reason).toBe('Same size as UD-Q4_0, which is the better recipe; keep one');
  });
  it('a QAT repo whose Q4_0 does not fit falls back to the size order', () => {
    const r = run([quant('Q4_0', 40 * GB, shape(70e9)), quant('IQ2_XXS', 18 * GB, shape(70e9))], { repoId: 'org/Model-QAT-GGUF' });
    expect(r.IQ2_XXS!.tint).toBe('green');
  });
  it('TQ1_0 on NVIDIA: yellow, slow on NVIDIA', () => {
    const r = run([quant('TQ1_0', 4.2 * GB, shape(P20))]);
    expect(r.TQ1_0!).toMatchObject({ tint: 'yellow', reason: 'slow on NVIDIA: no fast CUDA kernels; only good on models trained for them' });
    expect(run([quant('IQ1_M', 4.4 * GB, shape(P20))]).IQ1_M!.reason).toBe('slow on NVIDIA: no fast CUDA kernels');
    expect(run([quant('TQ1_0', 4.2 * GB, shape(P20))], { machine: { ...NVIDIA, gpuKind: 'other' } }).TQ1_0!.tint).toBe('green');
  });
  it('a slow type does not take the green from another file', () => {
    const r = run([quant('TQ2_0', 5.2 * GB, shape(P20)), quant('IQ2_XXS', 5.15 * GB, shape(P20))]);
    expect(r.IQ2_XXS!.tint).toBe('green');
  });
});

describe('FP4 types', () => {
  it('says native FP4 needs an RTX 50-series card, or that the card has it', () => {
    expect(run([quant('MXFP4_MOE', 12 * GB, shape(P20))]).MXFP4_MOE!.explanation).toContain('native FP4 speed needs an RTX 50-series card');
    const m = { ...NVIDIA, computeCap: 12.0 };
    expect(run([quant('MXFP4', 12 * GB, shape(P20))], { machine: m }).MXFP4!.explanation).toContain('your card has native FP4');
    expect(run([quant('NVFP4', 12 * GB, shape(P20))], { machine: { ...m, gpuKind: 'apple' } }).NVFP4!.explanation)
      .toContain('native FP4 speed needs an RTX 50-series card');
  });
  it('an NVIDIA card of unknown compute capability is not assumed to have native FP4', () => {
    const m = { ...NVIDIA, computeCap: null };
    expect(run([quant('MXFP4', 12 * GB, shape(P20))], { machine: m }).MXFP4!.explanation).toContain('native FP4 speed needs an RTX 50-series card');
  });
  it('NVFP4 with llama.cpp: needs b8967 or newer', () => {
    const a = run([quant('NVFP4', 12 * GB, shape(P20))]).NVFP4!;
    expect(a.tint).toBe('green');
    expect(a.explanation).toContain('NVFP4 needs llama.cpp b8967 or newer');
  });
});

describe('mmproj', () => {
  const mm = (prec: string, bytes: number): AdviceGroupInput => group('mmproj', `vision projector (${prec})`, bytes, [`mmproj-${prec}.gguf`]);
  it('F16 + BF16 + F32: F16 green, BF16 duplicate, F32 twice the size', () => {
    const r = run([mm('F16', 0.9 * GB), mm('BF16', 0.9 * GB), mm('F32', 1.8 * GB)]);
    expect(r['vision projector (F16)']!.tint).toBe('green');
    expect(r['vision projector (BF16)']!).toMatchObject({ tint: 'yellow', reason: 'Duplicate of mmproj-F16; you need only one' });
    expect(r['vision projector (F32)']!).toMatchObject({ tint: 'yellow', reason: 'Twice the size of F16 with no visible benefit' });
  });
  it('without F16: BF16, then Q8_0, then the largest other', () => {
    expect(run([mm('Q8_0', 0.5 * GB), mm('BF16', 0.9 * GB)])['vision projector (BF16)']!.tint).toBe('green');
    const r = run([mm('Q4_K', 0.3 * GB), mm('Q8_0', 0.5 * GB)]);
    expect(r['vision projector (Q8_0)']!.tint).toBe('green');
    expect(r['vision projector (Q4_K)']!.reason).toBe('Duplicate of mmproj-Q8_0; you need only one');
    const o = run([mm('Q4_K', 0.3 * GB), group('mmproj', 'vision projector', 0.4 * GB, ['mmproj.gguf'])]);
    expect(o['vision projector']!.tint).toBe('green');
    expect(o['vision projector (Q4_K)']!.reason).toBe('Duplicate of mmproj; you need only one');
  });
  it('a single mmproj: green, needed for images', () => {
    expect(run([mm('BF16', 0.9 * GB)])['vision projector (BF16)']!)
      .toMatchObject({ tint: 'green', reason: 'Needed for images; keep it with the quant you use' });
  });
  it('adds the recommended mmproj to every weight group\'s memory needed', () => {
    const r = run([quant('Q6_K', 16.4 * GB, shape(P20)), mm('F16', 0.9 * GB), mm('F32', 1.8 * GB)]);
    expect(r.Q6_K!.facts).toContain('mmproj 900.0 MB (vision projector (F16))');
    const needed = 16.4 * GB + 0.5 * GB + 0.9 * GB + HEADROOM;
    expect(r.Q6_K!.facts).toContain(`needed ${(needed / GB).toFixed(1)} GB`);
    expect(r.Q6_K!.explanation).toContain('+ 900.0 MB mmproj');
  });
  it('gives a locked mmproj no advice', () => {
    expect(run([group('mmproj', 'vision projector (F16)', 1, ['mmproj-F16.gguf'], { locked: true })])['vision projector (F16)']!.tint).toBeNull();
  });
});

describe('MTP and draft groups', () => {
  const d = group('draft', 'draft', 0.8 * GB, ['MTP/mtp-Q8_0.gguf']);
  it('with llama.cpp: green', () => {
    const a = run([d]).draft!;
    expect(a).toMatchObject({ tint: 'green', reason: 'Runs in llama.cpp with --spec-type draft-mtp; adds some memory' });
    expect(a.facts).toContain('draft 800.0 MB');
  });
  it('without llama.cpp: yellow, unused', () => {
    expect(run([d], { tools: ['lmstudio', 'ollama'] }).draft!)
      .toMatchObject({ tint: 'yellow', reason: "LM Studio and Ollama don't use MTP yet; harmless but unused" });
  });
  it('a -MTP GGUF repo gets the same line for the whole repo', () => {
    expect(advise(input([], { repoId: 'org/Qwen3.8-35B-A3B-MTP-GGUF' })).repoLine!.tint).toBe('green');
    expect(advise(input([], { repoId: 'org/Qwen3.8-MTP-GGUF', tools: ['ollama'] })).repoLine!.tint).toBe('yellow');
    expect(advise(input([], { repoId: 'org/qwen3.8-mtp-gguf' })).repoLine!.tint).toBe('green');
  });
  it('drafter repos: yellow with the runtime, red when no selected tool runs it', () => {
    const a = advise(input([], { repoId: 'org/Qwen3-8B-DFlash2', format: 'unknown' })).repoLine!;
    expect(a).toMatchObject({ tint: 'yellow', reason: 'DFlash drafter for speculative decoding; runs in llama.cpp' });
    expect(a.explanation).toContain('--spec-type draft-dflash');
    const e = advise(input([], { repoId: 'org/Llama-EAGLE-3', format: 'safetensors-16' })).repoLine!;
    expect(e).toMatchObject({ tint: 'red', reason: 'EAGLE drafter for speculative decoding; none of your tools run it' });
  });
});

describe('imatrix files', () => {
  it('yellow: only needed to make your own quants', () => {
    const r = run([group('quant', 'imatrix', 5e6, ['imatrix.gguf']), group('other', 'other files', 5e6, ['imatrix.dat']),
      group('other', 'sub/', 5e6, ['sub/imatrix_unsloth.gguf'])]);
    for (const a of Object.values(r)) expect(a).toMatchObject({ tint: 'yellow', reason: 'Only needed to make your own quants' });
  });
  it('a group that holds other files too gets no imatrix tint', () => {
    expect(run([group('other', 'other files', 5e6, ['imatrix.dat', 'notes.txt'])])['other files']!.tint).toBeNull();
    expect(run([group('other', 'other files', 0, [])])['other files']!.tint).toBeNull();
  });
});

describe('repo line from the format', () => {
  const line = (format: RepoFormat, o: Partial<AdviceInput> = {}): GroupAdvice | null => advise(input([], { format, ...o })).repoLine;
  it('MLX: red off macOS, no tint on macOS', () => {
    expect(line('mlx')).toMatchObject({ tint: 'red', reason: 'MLX is Apple-only; nothing on this Linux PC can load it' });
    expect(line('mlx', { machine: { ...NVIDIA, platform: 'win32' } })!.reason).toBe('MLX is Apple-only; nothing on this Windows PC can load it');
    expect(line('mlx', { machine: { ...NVIDIA, platform: 'darwin' } })!.tint).toBeNull();
    expect(line('mlx', { machine: { ...NVIDIA, platform: 'freebsd' } })!.reason).toBe('MLX is Apple-only; nothing on this freebsd PC can load it');
  });
  it('AWQ: red without vLLM, no tint with it', () => {
    expect(line('awq')).toMatchObject({ tint: 'red', reason: 'Needs vLLM / SGLang or transformers; none of your tools load it' });
    expect(line('awq', { tools: ['vllm'] })).toMatchObject({ tint: null, reason: 'Loads in vLLM / SGLang' });
  });
  it('ONNX: red with the guide\'s words', () => {
    expect(line('onnx')).toMatchObject({ tint: 'red', reason: 'None of your tools load ONNX language models' });
  });
  it('conditional cells are yellow, not red', () => {
    expect(line('safetensors-16')).toMatchObject({ tint: 'yellow', reason: 'Not confirmed to load in llama.cpp, Ollama' });
  });
  it('a format no tool is known to load says so', () => {
    expect(line('exl2', { tools: ['llama.cpp'] })).toMatchObject({ tint: 'red', reason: 'None of your tools load it' });
  });
  it('GGUF and unknown formats get no repo line', () => {
    expect(line('gguf')).toBeNull();
    expect(line('unknown')).toBeNull();
  });
  it('only language-model repos get a format line: adapters, components, datasets and spaces get none', () => {
    for (const repoKind of ['adapter', 'component', 'dataset', 'space'] as const) {
      expect(line('onnx', { repoKind }), repoKind).toBeNull();
      expect(line('fp8', { repoKind, repoId: 'org/FLUX.1-dev-fp8' }), repoKind).toBeNull();
      expect(line('onnx', { repoKind, tools: [] }), repoKind).toBeNull();
    }
    for (const repoKind of ['transformers', 'single-file', 'unknown'] as const) {
      expect(line('onnx', { repoKind }), repoKind).toMatchObject({ tint: 'red', reason: 'None of your tools load ONNX language models' });
    }
    expect(line('onnx', { repoKind: 'transformers', tools: [] })).toMatchObject({ reason: 'Pick the tools you use in Settings for advice' });
    expect(advise(input([], { repoKind: 'gguf', repoId: 'org/Qwen3.8-MTP-GGUF' })).repoLine!.tint).toBe('green');
  });
});

describe('diffusion repos', () => {
  const NOTE = { repoKind: 'diffusion', format: 'unknown', repoId: 'o/Rebels_w6a8s' } as const;
  const line = (o: Partial<AdviceInput>) => advise(input([], { ...NOTE, ...o })).repoLine!;

  it('a ComfyUI signal says packaged for ComfyUI, not diffusion model', () => {
    expect(line({ diffusionSignal: 'comfyui' })).toMatchObject({ tint: null, reason: 'Packaged for ComfyUI, not for language-model tools' });
  });
  it('a diffusion signal says diffusion model', () => {
    expect(line({ diffusionSignal: 'diffusion' })).toMatchObject({ tint: null, reason: 'Diffusion model, not for language-model tools; runs in an app such as ComfyUI' });
  });
  it('is never red, whatever the tools, and needs no tool chosen', () => {
    for (const tools of [[], TOOLS]) expect(line({ tools, diffusionSignal: 'comfyui' }).tint).toBeNull();
  });
  it('gives no fit verdict on a repo far bigger than the card', () => {
    const r = line({ diffusionSignal: 'comfyui', repoWeights: { bytes: 60 * GB, note: null } });
    expect(r.tint).toBeNull();
    expect(r.facts).toEqual([]);
  });
});

describe('missing facts', () => {
  it('no GPU memory: no size tints, says what to set', () => {
    const r = run([quant('Q6_K', 16.4 * GB, shape(P20)), quant('Q4_K_M', 11.5 * GB, shape(P20))], { machine: { ...NVIDIA, gpuBytes: null } });
    for (const a of Object.values(r)) expect(a).toMatchObject({ tint: null, reason: 'Set your GPU memory in Settings for size advice' });
  });
  it('no shape: that group gets no tint', () => {
    const r = run([quant('Q6_K', 16.4 * GB, null), quant('Q4_K_M', 11.5 * GB, shape(P20))]);
    expect(r.Q6_K!).toMatchObject({ tint: null, reason: 'Model shape unknown: header unreadable' });
    expect(r.Q4_K_M!.tint).not.toBe('green');
  });
  it('incomplete shard set gets no size tint', () => {
    const r = run([quant('Q6_K', 16.4 * GB, shape(P20), { shards: { present: 2, expected: 3 } })]);
    expect(r.Q6_K!).toMatchObject({ tint: null, reason: 'Incomplete: 2 of 3 parts present' });
    expect(run([quant('Q6_K', 16.4 * GB, shape(P20), { shards: { present: 3, expected: 3 } })]).Q6_K!.tint).toBe('green');
  });
  it('no parameter count: no size tint, never a guess from the name', () => {
    expect(run([quant('Q6_K', 16.4 * GB, shape(0))]).Q6_K!).toMatchObject({ tint: null, reason: 'Parameter count unknown: header has no tensor sizes' });
  });
});

describe('green only when every weight group was compared', () => {
  const BEST_OF = (n: number): string => `Best of the files that could be checked; ${n} could not be read`;
  it('an unreadable group blocks green: the best of the rest is yellow and the explanation names it', () => {
    const r = run([quant('Q6_K', 16.4 * GB, null), quant('Q4_K_M', 11.5 * GB, shape(P20)), quant('IQ2_XXS', 5.15 * GB, shape(P20))]);
    expect(Object.values(r).filter((a) => a.tint === 'green')).toHaveLength(0);
    expect(r.Q4_K_M!).toMatchObject({ tint: 'yellow', reason: BEST_OF(1) });
    expect(r.Q4_K_M!.explanation).toContain('Could not be read, so not compared: Q6_K.');
    expect(r.Q4_K_M!.facts).toContain('weights 11.5 GB');
    expect(r.IQ2_XXS!.reason).toBe('Much lower quality, and Q4_K_M fits');
  });
  it('counts incomplete shard sets, unknown types and missing parameter counts as not read', () => {
    const r = run([
      quant('Q6_K', 16.4 * GB, shape(P20), { shards: { present: 1, expected: 2 } }),
      quant('weird', 14 * GB, shape(P20)),
      quant('Q5_K_M', 14 * GB, shape(0)),
      quant('Q4_K_M', 11.5 * GB, shape(P20)),
    ]);
    expect(r.Q4_K_M!).toMatchObject({ tint: 'yellow', reason: BEST_OF(3) });
    expect(r.Q4_K_M!.explanation).toContain('Could not be read, so not compared: Q6_K, weird, Q5_K_M.');
  });
  it('a complete shard set, a locked group, an imatrix file and non-weight groups do not block green', () => {
    const r = run([
      quant('Q6_K', 16.4 * GB, shape(P20), { shards: { present: 2, expected: 2 } }),
      quant('Q8_0', 21 * GB, null, { locked: true }),
      quant('imatrix', 1e8, null, { relpaths: ['imatrix.gguf'] }),
      group('mmproj', 'vision projector (F16)', 1e8, ['mmproj-F16.gguf']),
      group('draft', 'draft', 1e8, ['MTP/x.gguf']),
    ]);
    expect(r.Q6_K!.tint).toBe('green');
  });
  it('with nothing comfortable the closest fit stays as it was', () => {
    const r = run([quant('Q4_K_M', 18 * GB, shape(70e9, 4 * GB)), quant('Q6_K', 30 * GB, null)]);
    expect(r.Q4_K_M!.reason).toBe('Closest fit, but tight: fits only with a q8_0 KV cache');
  });
});

describe('display margin and Apple', () => {
  // 21.5 + 0.5 + 1.61 = 23.61: comfortable on 24.61, tight on 23.61
  const g = [quant('Q8_0', 21.5 * GB, shape(P20))];
  it('a GPU driving the display has 1 GB less', () => {
    const m = { ...NVIDIA, gpuBytes: 25 * GB };
    expect(run(g, { machine: m }).Q8_0!.tint).toBe('green');
    const a = run(g, { machine: { ...m, drivesDisplay: true } }).Q8_0!;
    expect(a.tint).toBe('yellow');
    expect(a.explanation).toContain('with 1 GB kept free for the display');
    expect(run(g, { machine: m }).Q8_0!.facts).not.toContain('1 GB kept free for the display');
  });
  it('Apple unified memory uses 75% of RAM', () => {
    const mac: MachineProfile = { platform: 'darwin', ramBytes: 28 * GiB, gpuName: null, gpuBytes: null, gpuKind: 'apple', computeCap: null, drivesDisplay: false };
    const a = run([quant('Q8_0', 21.5 * GB, shape(P20))], { machine: mac }).Q8_0!;
    expect(a).toMatchObject({ tint: 'red', reason: 'Too big for 21 GB; would run partly from system RAM, slowly' });
    expect(a.explanation).toContain('Your Apple unified memory has 22.5 GB');
    expect(run([quant('Q8_0', 21.5 * GB, shape(P20))], { machine: { ...mac, ramBytes: 64 * GB } }).Q8_0!.tint).toBe('green');
  });
});

describe('one judgment for repos of plain weights', () => {
  /** A transformers shape as shapeFromConfig makes it: `layers` full-attention layers of `kv` heads x `dim`. */
  const cfg = (paramCount: number, layers: number, kv = 8, dim = 128, extra: Partial<ModelShape> = {}): ModelShape =>
    ({ arch: 'llama', fileType: 'bfloat16', paramCount, expertCount: 0, layers, contextLength: 131072,
      kvLayers: Array.from({ length: layers }, () => ({ kvHeads: kv, headDimK: dim, headDimV: dim, window: null })), ...extra });
  const B8 = cfg(8e9, 32);
  const B70 = cfg(70e9, 80);
  const B14 = cfg(14e9, 40);
  const rows = (weights: number): AdviceGroupInput[] => [
    group('weights', 'weights', weights, ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors', 'model.safetensors.index.json']),
    group('tokenizer-config', 'tokenizer and config', 1e7, ['config.json', 'tokenizer.json']),
    group('assets', 'model card and assets', 1e4, ['README.md']),
  ];
  const repo = (weights: number, s: ModelShape | null, o: Partial<AdviceInput> = {}): RepoAdvice =>
    advise(input(rows(weights), { repoId: 'org/Llama-3.1-8B-Instruct', format: 'safetensors-16', repoKind: 'transformers', repoShape: s, repoWeights: { bytes: weights, note: null }, machine: REAL, ...o }));
  const line = (weights: number, s: ModelShape | null, o: Partial<AdviceInput> = {}): GroupAdvice => repo(weights, s, o).repoLine!;
  const at80 = { settings: { ...SETTINGS, gpuBytes: 80 * GiB } };

  it('a BF16 8B on 24 GB with llama.cpp, LM Studio and Ollama: yellow, convert to GGUF', () => {
    const a = line(16 * GB, B8);
    expect(a).toMatchObject({ key: 'repo', tint: 'yellow', reason: 'Fits, but your tools need it converted to GGUF; vLLM or transformers can run it as is' });
    expect(a.explanation).toContain('16.0 GB of weights');
    expect(a.facts).toContain('weights 16.0 GB');
    expect(a.facts).toContain('KV cache 4.3 GB (32K context, F16)');
  });
  it('the same with vLLM selected: green, runs here', () => {
    expect(line(16 * GB, B8, { tools: ['vllm'] })).toMatchObject({ tint: 'green', reason: 'Runs here with vLLM / SGLang' });
    expect(line(16 * GB, B8, { tools: ['llama.cpp', 'vllm', 'transformers'] }).reason).toBe('Runs here with vLLM / SGLang, transformers');
  });
  it('the rows keep no tint', () => {
    for (const g of repo(16 * GB, B8, { tools: ['vllm'] }).groups) expect(g).toMatchObject({ tint: null, reason: '—' });
  });
  it('a 70B BF16: red; a GGUF quant would fit only when 70e9 x 4.5 / 8 + KV + headroom fits with 1 GB to spare', () => {
    // 39.4 GB + 10.7 GB KV + 1.6 GB headroom = 51.7 GB: not on 24 GB, yes on 80 GB
    expect(line(140 * GB, B70)).toMatchObject({ tint: 'red', reason: 'Too big for this PC' });
    expect(line(140 * GB, B70, at80)).toMatchObject({ tint: 'red',
      reason: 'Too big for 80 GB as stored (140.0 GB of weights); a GGUF quant of this model would fit' });
    // a 14B (28 GB) on 24 GB: 7.9 GB + 5.4 GB + 1.6 GB fits
    expect(line(28 * GB, B14).reason).toBe('Too big for 24 GB as stored (28.0 GB of weights); a GGUF quant of this model would fit');
    const kv = 80 * 8 * 256 * CTX * 2;
    const edge = 70e9 * 4.5 / 8 + kv + HEADROOM + 1e9;
    expect(line(140 * GB, B70, { settings: { ...SETTINGS, gpuBytes: edge } }).reason).toContain('a GGUF quant of this model would fit');
    expect(line(140 * GB, B70, { settings: { ...SETTINGS, gpuBytes: edge - 1 } }).reason).toBe('Too big for this PC');
  });
  it('too big with no parameter count: says so without the GGUF estimate', () => {
    expect(line(140 * GB, cfg(0, 80)).reason).toBe('Too big for 24 GB as stored (140.0 GB of weights)');
  });
  it('a format red wins over the size; a size red wins over a format caveat', () => {
    expect(line(140 * GB, B70, { format: 'awq' })).toMatchObject({ tint: 'red', reason: 'Needs vLLM / SGLang or transformers; none of your tools load it' });
    const big = line(140 * GB, B70);
    expect(big.tint).toBe('red');
    expect(big.explanation).toContain('need it converted to GGUF');
  });
  it('tight: yellow, says how it would fit', () => {
    // 20 GB + 4.3 GB KV + 1.6 GB = 25.9 GB: over 25.8 GB with F16; 23.9 GB with q8_0 leaves over 1 GB
    const a = line(20 * GB, B8, { tools: ['vllm'] });
    expect(a).toMatchObject({ tint: 'yellow', reason: 'Tight: 20.0 GB of weights on a 24 GB card' });
    expect(a.explanation).toContain('it fits with a q8_0 KV cache');
    expect(a.facts.some((f) => f.startsWith('needed with a q8_0 KV cache'))).toBe(true);
    expect(line(19.5 * GB, B8, { tools: ['vllm'] }).explanation).toContain('it fits with a q8_0 KV cache');
    expect(line(21.5 * GB, B8, { tools: ['vllm'] }).explanation).toContain('a q8_0 KV cache and a shorter context');
    expect(line(21.5 * GB, B8, { tools: ['vllm'], settings: { ...SETTINGS, kvType: 'q8_0' } }).explanation).toContain('it fits with a shorter context');
    // tight ties with the convert caveat: the size reason wins, both explained
    const both = line(20 * GB, B8);
    expect(both.reason).toBe('Tight: 20.0 GB of weights on a 24 GB card');
    expect(both.explanation).toContain('need it converted to GGUF');
  });
  it('MLX on Linux is still red; on macOS it runs in LM Studio and Ollama', () => {
    expect(line(4.5 * GB, B8, { format: 'mlx' })).toMatchObject({ tint: 'red', reason: 'MLX is Apple-only; nothing on this Linux PC can load it' });
    const mac: MachineProfile = { ...REAL, platform: 'darwin', gpuKind: 'apple', gpuName: null, gpuBytes: null };
    expect(line(4.5 * GB, B8, { format: 'mlx', machine: mac })).toMatchObject({ tint: 'green', reason: 'Runs here with LM Studio, Ollama' });
    expect(line(4.5 * GB, B8, { format: 'mlx', machine: mac, tools: ['llama.cpp'] }))
      .toMatchObject({ tint: 'red', reason: 'Needs LM Studio or Ollama; none of your tools load it' });
  });
  it('ONNX language models stay red', () => {
    expect(line(16 * GB, B8, { format: 'onnx' })).toMatchObject({ tint: 'red', reason: 'None of your tools load ONNX language models' });
    expect(line(16 * GB, B8, { format: 'exl2', tools: ['llama.cpp'] })).toMatchObject({ tint: 'red', reason: 'None of your tools load it' });
  });
  it('"not confirmed" is a caveat: yellow at best', () => {
    expect(line(8 * GB, B8, { format: 'fp8', tools: ['transformers'] })).toMatchObject({ tint: 'yellow', reason: 'Not confirmed to load in transformers' });
  });
  it('an unrecognised format: never green, never a format tint', () => {
    expect(line(16 * GB, B8, { format: 'unknown', tools: ['vllm'] })).toMatchObject({ tint: null, reason: 'Fits, but the format is not recognised' });
    expect(line(140 * GB, B70, { format: 'unknown' }).tint).toBe('red');
  });
  it('config.json unreadable or without the layer and head counts: no green, the reason names it', () => {
    const a = line(16 * GB, null, { tools: ['vllm'] });
    expect(a).toMatchObject({ tint: null, reason: 'Model shape unknown: config.json unreadable or missing the layer or head counts' });
    // a format caveat still shows, with the missing fact explained
    const b = line(16 * GB, null);
    expect(b).toMatchObject({ tint: 'yellow', reason: 'Your tools need it converted to GGUF; vLLM or transformers can run it as is' });
    expect(b.explanation).toContain('Model shape unknown');
  });
  it('an incomplete download: no green, the reason names it', () => {
    expect(line(16 * GB, B8, { tools: ['vllm'], incomplete: true }))
      .toMatchObject({ tint: null, reason: 'Incomplete download: some weight files are missing or still downloading' });
  });
  it('no GPU memory: no size advice', () => {
    const m: MachineProfile = { ...REAL, gpuBytes: null, gpuKind: 'other', gpuName: null };
    expect(line(16 * GB, B8, { tools: ['vllm'], machine: m })).toMatchObject({ tint: null, reason: 'Set your GPU memory in Settings for size advice' });
  });
  it('no weight files: no size advice', () => {
    expect(advise(input([], { format: 'safetensors-16', repoKind: 'transformers', repoShape: B8, tools: ['vllm'], machine: REAL })).repoLine)
      .toMatchObject({ tint: null, reason: 'No safetensors or PyTorch weights to size' });
  });
  it('judges the counted weights (repoWeights), not the groups, and shows the duplicates note', () => {
    const NOTE = 'not counted, duplicates of the same weights: pytorch_model-00001-of-00002.bin, pytorch_model-00002-of-00002.bin';
    // a Llama-2-7b-hf-like repo: 13.5 GB of safetensors counted, 13.5 GB of .bin copies left out
    const l7 = cfg(7e9, 32, 32);
    const r = advise(input(rows(27 * GB), { format: 'safetensors-16', repoKind: 'transformers', repoShape: l7, repoWeights: { bytes: 13.5 * GB, note: NOTE },
      tools: ['vllm'], machine: REAL, settings: { ...SETTINGS, context: 8192 } }));
    expect(r.repoLine).toMatchObject({ tint: 'green', reason: 'Runs here with vLLM / SGLang' });
    expect(r.repoLine!.facts).toContain('weights 13.5 GB');
    expect(r.repoLine!.facts).toContain(NOTE);
    // The same repo with only GGUF tools needs converting
    const gguf = advise(input(rows(27 * GB), { format: 'safetensors-16', repoKind: 'transformers', repoShape: l7, repoWeights: { bytes: 13.5 * GB, note: NOTE },
      machine: REAL, settings: { ...SETTINGS, context: 8192 } })).repoLine!;
    expect(gguf).toMatchObject({ tint: 'yellow', reason: 'Fits, but your tools need it converted to GGUF; vLLM or transformers can run it as is' });
  });
  it('at real sizes, counted: counted bytes drive both the size and the parameter estimate', () => {
    const judge = (files: Array<{ relpath: string; bytes: number }>, index: Record<string, unknown>, config: Record<string, unknown>, gpuBytes: number): GroupAdvice => {
      const counted = countedWeights(files, (p) => index[p]);
      return advise(input(rows(files.reduce((n, f) => n + f.bytes, 0)), { format: 'safetensors-16', repoKind: 'transformers', tools: ['vllm'], machine: REAL,
        repoShape: shapeFromConfig(config, counted.bytes), repoWeights: { bytes: counted.bytes, note: counted.note }, incomplete: counted.incomplete,
        settings: { ...SETTINGS, gpuBytes } })).repoLine!;
    };
    const shards = (prefix: string, ext: string, n: number, each: number) =>
      Array.from({ length: n }, (_, i) => ({ relpath: `${prefix}-${String(i + 1).padStart(5, '0')}-of-${String(n).padStart(5, '0')}.${ext}`, bytes: each }));
    const map = (fs: Array<{ relpath: string }>) => ({ weight_map: Object.fromEntries(fs.map((f, i) => [`t${i}`, f.relpath])) });
    // Llama-2-70b-hf-like: 140 GB of safetensors + 140 GB of .bin, both indexed, on an 80 GB card
    const st = shards('model', 'safetensors', 14, 10e9);
    const bin = shards('pytorch_model', 'bin', 14, 10e9);
    const files70 = [...st, ...bin, { relpath: 'model.safetensors.index.json', bytes: 1e5 }, { relpath: 'pytorch_model.bin.index.json', bytes: 1e5 }];
    const l70 = { num_hidden_layers: 80, num_attention_heads: 64, num_key_value_heads: 8, hidden_size: 8192, torch_dtype: 'float16' };
    const big = judge(files70, { 'model.safetensors.index.json': map(st), 'pytorch_model.bin.index.json': map(bin) }, l70, 80 * GiB);
    expect(big).toMatchObject({ tint: 'red', reason: 'Too big for 80 GB as stored (140.0 GB of weights); a GGUF quant of this model would fit' });
    // Mistral-7B-Instruct-v0.3-like: consolidated.safetensors 14.5 GB beside 3 indexed shards of 14.5 GB in all, on 24 GB
    const ms = shards('model', 'safetensors', 3, 14.5e9 / 3);
    const mistral = [{ relpath: 'consolidated.safetensors', bytes: 14.5e9 }, ...ms, { relpath: 'model.safetensors.index.json', bytes: 1e5 }];
    const m7 = { num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, hidden_size: 4096, torch_dtype: 'bfloat16' };
    const fit = judge(mistral, { 'model.safetensors.index.json': map(ms) }, m7, 24 * GiB);
    expect(fit).toMatchObject({ tint: 'green', reason: 'Runs here with vLLM / SGLang' });
    expect(fit.facts).toContain('weights 14.5 GB');
    expect(fit.facts).toContain('not counted, duplicates of the same weights: consolidated.safetensors');
  });
  it('the display margin and the KV type are applied', () => {
    expect(line(18 * GB, B8, { tools: ['vllm'] }).tint).toBe('green');
    expect(line(18 * GB, B8, { tools: ['vllm'], machine: { ...REAL, drivesDisplay: true } }).tint).toBe('yellow');
    const q8 = line(22 * GB, B8, { tools: ['vllm'], settings: { ...SETTINGS, kvType: 'q8_0' } });
    expect(q8.facts).toContain('KV cache 2.3 GB (32K context, q8_0)');
  });

  const pipe = (bytes: number, o: Partial<AdviceInput> = {}): GroupAdvice => advise(input([
    group('component', 'transformer/', bytes, ['transformer/diffusion_pytorch_model.safetensors'], { locked: true }),
    group('component', 'model_index.json', 0, ['model_index.json'], { locked: true }),
    group('assets', 'model card and assets', 1e4, ['README.md']),
  ], { repoId: 'org/FLUX.1-dev', format: 'unknown', repoKind: 'diffusers', repoWeights: { bytes, note: null }, machine: REAL, ...o })).repoLine!;
  it('a diffusers pipeline: size only, no KV cache', () => {
    expect(pipe(23.8 * GB)).toMatchObject({ tint: 'yellow', reason: 'Tight: 23.8 GB of weights on a 24 GB card' });
    expect(pipe(12 * GB)).toMatchObject({ tint: null, reason: 'Fits in 24 GB (12.0 GB of weights; runs in a diffusers app such as ComfyUI)' });
    expect(pipe(30 * GB)).toMatchObject({ tint: 'red', reason: 'Too big for 24 GB as stored (30.0 GB of weights)' });
    expect(pipe(12 * GB).facts.some((f) => f.startsWith('KV cache'))).toBe(false);
    // the tools and the format do not apply to a pipeline
    expect(pipe(12 * GB, { tools: [], format: 'onnx' })).toMatchObject({ tint: null, reason: 'Fits in 24 GB (12.0 GB of weights; runs in a diffusers app such as ComfyUI)' });
    expect(pipe(0)).toMatchObject({ tint: null, reason: 'No safetensors or PyTorch weights to size' });
    expect(pipe(12 * GB, { incomplete: true }).reason).toMatch(/^Incomplete download/);
    expect(pipe(12 * GB, { machine: { ...REAL, gpuBytes: null } }).reason).toBe('Set your GPU memory in Settings for size advice');
  });
  it('at real sizes: an SDXL-like pipeline with fp16 and full-precision copies is judged on the fp16 set', () => {
    const comp = (dir: string, base: string, fp16: number) =>
      countedWeights([{ relpath: `${dir}/${base}.fp16.safetensors`, bytes: fp16 }, { relpath: `${dir}/${base}.safetensors`, bytes: 2 * fp16 }], () => undefined, true);
    const w = sumCounted([comp('unet', 'diffusion_pytorch_model', 5e9), comp('text_encoder', 'model', 0.25e9),
      comp('text_encoder_2', 'model', 1.4e9), comp('vae', 'diffusion_pytorch_model', 0.17e9)]);
    const a = pipe(0, { repoWeights: { bytes: w.bytes, note: w.note } });
    expect(a).toMatchObject({ tint: null, reason: 'Fits in 24 GB (6.8 GB of weights; runs in a diffusers app such as ComfyUI)' });
    expect(a.facts).toContain('not counted, duplicates of the same weights: unet/diffusion_pytorch_model.safetensors, text_encoder/model.safetensors, text_encoder_2/model.safetensors and 1 more');
  });
  it('the pipeline rows keep no tint', () => {
    const r = advise(input([group('component', 'vae/', 1e9, ['vae/x.safetensors'], { locked: true })], { repoKind: 'diffusers', format: 'unknown', machine: REAL }));
    expect(r.groups[0]).toMatchObject({ tint: null, reason: '—' });
  });
  it('a drafter repo keeps its drafter line; no tools still asks for them', () => {
    expect(line(1 * GB, B8, { repoId: 'org/Llama-EAGLE-3' }).reason).toMatch(/^EAGLE drafter/);
    expect(line(16 * GB, B8, { tools: [] }).reason).toBe('Pick the tools you use in Settings for advice');
  });

  it('property: a green repo line is backed by every fact, and rows are never tinted', () => {
    const FORMATS: RepoFormat[] = ['safetensors-16', 'awq', 'fp8', 'mlx', 'onnx', 'exl3', 'unknown'];
    fc.assert(fc.property(
      fc.constantFrom<AdviceInput['repoKind']>('transformers', 'diffusers', 'single-file', 'dataset'),
      fc.constantFrom(...FORMATS), fc.boolean(), fc.boolean(), fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
      fc.integer({ min: 0, max: 2e11 }), fc.constantFrom<Tool[]>(TOOLS, ['vllm'], ['lmstudio'], []),
      (repoKind, format, hasShape, incomplete, gpuGb, weights, tools) => {
        const settings = { ...SETTINGS, gpuBytes: gpuGb === null ? null : gpuGb * GB };
        const machine: MachineProfile = { ...REAL, gpuBytes: null, gpuKind: 'other' };
        const r = advise(input([...rows(weights), group('component', 'unet/', weights, ['unet/x.safetensors'], { locked: true })],
          { repoKind, format, repoShape: hasShape ? B8 : null, repoWeights: { bytes: weights, note: null }, incomplete, settings, machine, tools }));
        for (const g of r.groups) expect(g.tint).toBeNull();
        const l = r.repoLine;
        if (l?.tint === 'green') {
          expect(repoKind).toBe('transformers');
          expect(hasShape && !incomplete && gpuGb !== null && weights > 0).toBe(true);
          expect(l.reason).toMatch(/^Runs here with /);
          expect(l.facts.some((f) => f.startsWith('needed with a q8_0'))).toBe(false);
          const need = weights + kvCacheBytes(B8, CTX, 'f16') + HEADROOM;
          expect(gpuGb! * GB - need).toBeGreaterThanOrEqual(1e9);
        }
        if (repoKind === 'dataset') expect(l).toBeNull();
      }), { numRuns: Number(process.env.FC_NUM_RUNS ?? 200) });
  });
});

describe('groups without advice', () => {
  it('locked, superseded, tokenizer-config and assets: no tint, "—"', () => {
    const r = run([
      group('component', 'vae/', 1e9, ['vae/x.safetensors'], { locked: true }),
      quant('Q6_K', 16.4 * GB, shape(P20), { locked: true }),
      group('superseded', 'superseded (older revision)', 1e9, ['imatrix.dat']),
      group('tokenizer-config', 'tokenizer and config', 1e6, ['tokenizer.json']),
      group('assets', 'model card and assets', 1e4, ['README.md']),
      group('weights', 'weights', 1e9, ['model.safetensors']),
    ]);
    for (const a of Object.values(r)) expect(a).toMatchObject({ tint: null, reason: '—', explanation: '', facts: [] });
  });
});

describe('basis', () => {
  it('says what the advice is based on', () => {
    expect(advise(input([], { machine: REAL })).basis).toBe('Linux · RTX 5090 24 GB · 64 GB RAM · 32K context · llama.cpp, LM Studio, Ollama');
  });
  it('names unknown GPU memory, other platforms and overrides', () => {
    const m: MachineProfile = { ...REAL, platform: 'freebsd', gpuName: null, gpuBytes: null, gpuKind: 'other' };
    expect(advise(input([], { machine: m, settings: { ...SETTINGS, context: 131072 } })).basis)
      .toBe('freebsd · GPU memory not set · 64 GB RAM · 128K context · llama.cpp, LM Studio, Ollama');
    expect(advise(input([], { machine: m, settings: { ...SETTINGS, gpuBytes: 16 * GiB } })).basis).toContain('GPU 16 GB');
    const mac: MachineProfile = { ...m, platform: 'darwin', gpuKind: 'apple' };
    expect(advise(input([], { machine: mac, tools: ['vllm', 'tabbyapi', 'transformers'] })).basis)
      .toBe('macOS · Apple unified memory 48 GB · 64 GB RAM · 32K context · vLLM / SGLang, TabbyAPI, transformers');
  });
});

describe('properties', () => {
  const LABELS = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'UD-Q4_K_XL', 'IQ4_XS', 'IQ2_XXS', 'TQ1_0', 'NVFP4', 'XQ', 'F16', 'imatrix'];
  const arbShape = fc.option(fc.record({
    paramCount: fc.oneof(fc.constant(0), fc.integer({ min: 1e8, max: 2e11 })),
    kv: fc.integer({ min: 0, max: 8e9 }),
    experts: fc.constantFrom(0, 8, 128),
  }), { nil: null });
  const arbGroup = fc.record({
    kind: fc.constantFrom('quant', 'quant', 'quant', 'mmproj', 'draft', 'other') as fc.Arbitrary<AdviceGroupInput['kind']>,
    label: fc.constantFrom(...LABELS),
    bytes: fc.integer({ min: 1e6, max: 1.5e11 }),
    s: arbShape,
    incomplete: fc.boolean(),
  });
  it('0 or 1 green weight group, and no shape means no size tint', () => {
    fc.assert(fc.property(fc.array(arbGroup, { maxLength: 8 }), fc.constantFrom<Tool[]>(TOOLS, ['lmstudio'], ['vllm']), (raw, tools) => {
      const groups = raw.map((g, i): AdviceGroupInput => ({
        key: `${g.kind}:${i}`, kind: g.kind, label: g.label, bytes: g.bytes,
        relpaths: [g.label === 'imatrix' ? 'imatrix.gguf' : `m-${g.label}.gguf`],
        shape: g.s && shape(g.s.paramCount, g.s.kv, { expertCount: g.s.experts }),
        shards: g.incomplete ? { present: 1, expected: 2 } : null, locked: false,
      }));
      const r = advise(input(groups, { tools }));
      const greens = r.groups.filter((a, i) => groups[i]!.kind === 'quant' && a.tint === 'green');
      expect(greens.length).toBeLessThanOrEqual(1);
      const weight = groups.filter((g) => g.kind === 'quant' && g.label !== 'imatrix');
      if (greens.length > 0) {   // a green is backed: every weight group was read and compared
        for (const g of weight) {
          expect(g.shape !== null && g.shape.paramCount > 0 && g.shards === null, g.key).toBe(true);
        }
      }
      for (const a of greens) {   // a green is backed: comfortable fit, no caveat
        expect(a.reason).toBe('Best pick: fits with room for 32K context');
        expect(a.facts.some((f) => f.startsWith('needed with a q8_0'))).toBe(false);
        expect(a.explanation).not.toContain('Not confirmed');
      }
      r.groups.forEach((a, i) => {
        const g = groups[i]!;
        if (g.kind !== 'quant' || (g.shape !== null && g.shards === null)) return;
        if (a.tint !== null) expect(a.reason).toMatch(/none of your tools load it|Not confirmed to load|Only needed to make your own quants/);
      });
    }), { numRuns: Number(process.env.FC_NUM_RUNS ?? 200) });
  });
});
