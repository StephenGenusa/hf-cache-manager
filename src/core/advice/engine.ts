// The keep-advice engine. Pure: takes file facts, never paths on disk, so download mode
// can run it on files that are not downloaded yet. Advice only colours rows; nothing here selects or deletes.
import { formatBytes } from '../../shared/format';
import { nameParts } from '../../shared/knowledge/name-parts';
import {
  CANNOT_LOAD, DRAFTERS, MMPROJ_ORDER, QAT_TOKENS, SLOW_ON_NVIDIA, formatSupport, ggufTypeSupport,
  type Platform, type Support, type Tool,
} from '../../shared/knowledge/rules';
import type { Knowledge } from '../../shared/knowledge/types';
import type { RepoKind } from '../types';
import { kvCacheBytes } from './shape';
import type {
  AdviceGroupInput, AdviceInput, AdviceSettings, GpuKind, GroupAdvice, MachineProfile, RepoAdvice, Tint,
} from './types';

export type { AdviceGroupInput, AdviceInput, GroupAdvice, RepoAdvice } from './types';

// Fixed constants of the advice rules.
const HEADROOM = 1_610_612_736;        // 1.5 GiB
const COMFORT = 1e9;                   // "comfortable" = at least 1 GB to spare
const MOE_RAM_RESERVE = 8e9;           // MoE rule: GPU + RAM − 8 GB
const SAME_SIZE = 0.03;                // within 3%
const LOW_BPW = 3;
const HIGH_BPW = 4;
const DISPLAY_MARGIN = 1e9;
const APPLE_SHARE = 0.75;              // usable unified memory
const NATIVE_FP4_CC = 12;

const TOOL_NAMES: Record<Tool, string> = {
  'llama.cpp': 'llama.cpp', lmstudio: 'LM Studio', ollama: 'Ollama', vllm: 'vLLM / SGLang', tabbyapi: 'TabbyAPI',
  transformers: 'transformers',
};
const ALL_TOOLS = Object.keys(TOOL_NAMES) as Tool[];
const PLATFORM_NAMES: Partial<Record<Platform, string>> = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' };
const NO_TOOLS = 'Pick the tools you use in Settings for advice';
const NONE = (key: string): GroupAdvice => ({ key, tint: null, reason: '—', explanation: '', facts: [] });
const advice = (key: string, tint: Tint | null, reason: string, explanation = '', facts: string[] = []): GroupAdvice =>
  ({ key, tint, reason, explanation, facts });
const names = (tools: Tool[], sep = ', '): string => tools.map((t) => TOOL_NAMES[t]).join(sep);
/** Hardware capacities read the way vendors label them (GiB written "GB": a 24564 MiB card is "24 GB"). */
const gb = (bytes: number): number => Math.round(bytes / 2 ** 30);
const sameSize = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_SIZE * Math.max(a, b);

/** GPU memory before the display margin: settings, else Apple's share of RAM, else detection. */
function cardBytes(m: MachineProfile, s: AdviceSettings, gpuKind: GpuKind, ramBytes: number): number | null {
  return s.gpuBytes ?? (gpuKind === 'apple' ? APPLE_SHARE * ramBytes : m.gpuBytes);
}

export function effectiveProfile(m: MachineProfile, s: AdviceSettings): { gpuBytes: number | null; ramBytes: number; gpuKind: GpuKind } {
  const gpuKind = s.gpuKind ?? m.gpuKind;
  const ramBytes = s.ramBytes ?? m.ramBytes;
  const card = cardBytes(m, s, gpuKind, ramBytes);
  const display = s.drivesDisplay ?? m.drivesDisplay;
  return { gpuBytes: card !== null && display ? Math.max(0, card - DISPLAY_MARGIN) : card, ramBytes, gpuKind };
}

/** "yes" when a selected tool loads it, "no" when every one is a definite no, else the unconfirmed tools. */
function loadVerdict(tools: Tool[], support: (t: Tool) => Support): { kind: 'yes'; yes: Tool[] } | { kind: 'no' } | { kind: 'unknown'; unknown: Tool[] } {
  const yes = tools.filter((t) => support(t) === 'yes');
  if (yes.length > 0) return { kind: 'yes', yes };
  const unknown = tools.filter((t) => support(t) === 'unknown');
  return unknown.length > 0 ? { kind: 'unknown', unknown } : { kind: 'no' };
}

const isImatrix = (relpath: string): boolean => {
  const b = relpath.slice(relpath.lastIndexOf('/') + 1).toLowerCase();
  return b === 'imatrix.gguf' || b === 'imatrix.dat' || (b.startsWith('imatrix_') && b.endsWith('.gguf'));
};
const imatrixOnly = (g: AdviceGroupInput): boolean => g.relpaths.length > 0 && g.relpaths.every(isImatrix);

/** Name tokens split on separators (underscores kept, so `Q4_K_M` and `PTQ1_0` stay whole). */
const tokens = (s: string): string[] => s.split(/[-. /]+/).filter(Boolean);

interface Label { type: string | null; recipe: boolean }

/** Quant type from the header when it names one, else from the label's parts; recipes always from the label. */
function readLabel(g: AdviceGroupInput, k: Knowledge): Label {
  const parts = nameParts(g.label, k);
  const typePart = parts.find((p) => p.entryId !== null && (p.entryId.startsWith('quant-type:') || p.entryId === 'recipe:_L'));
  const labelType = typePart ? typePart.text.toUpperCase() : null;
  const header = g.shape?.fileType;
  const type = header !== undefined && header !== null && header !== 'unknown' ? header.toUpperCase() : labelType;
  const dynamic = parts.some((p) => p.entryId === 'recipe:UD-' || p.entryId === 'recipe:i1');
  // bartowski _L / _XL: the standard type with Q8_0 embeddings; Q3_K_L is a plain llama.cpp type.
  const bartowski = labelType !== null && /^Q\d_K_X?L$/.test(labelType) && labelType !== 'Q3_K_L';
  return { type, recipe: dynamic || bartowski || (type?.startsWith('IQ') ?? false) };
}

interface Ctx {
  input: AdviceInput; gpu: number | null; ram: number; gpuKind: GpuKind; display: boolean; gpuName: string;
  /** The card's nominal memory, before the display margin: what the basis line and rule 2 show. */
  card: number | null;
  ctxK: string; kvName: string; mm: { bytes: number; label: string } | null; qat: boolean;
  /** Labels of the weight groups whose shape, shard set or type could not be read: while any exist, nothing is green. */
  unread: string[];
}

interface Sized {
  g: AdviceGroupInput; label: Label; bpw: number; needSel: number; needQ8: number; spare: number;
  /** null when it fits with the selected KV cache and at least 1 GB to spare. */
  tightHow: string | null; base: string; facts: string[];
  /** Rule 1's "not confirmed" yellow: the group keeps its size advice but can never be green. */
  caveat: Caveat | null;
}

interface Caveat { reason: string; sentence: string; note: string }

const RANK = { green: 1, yellow: 2, red: 3 } as const;
const rank = (t: Tint | null): number => (t === null ? 0 : RANK[t]);

/** The worse of the size/pick advice and the caveat; on a tie the size/pick reason; both sentences explained. */
function withCaveat(a: GroupAdvice, cv: Caveat | null): GroupAdvice {
  if (cv === null) return a;
  const first = a.explanation !== '' ? a.explanation : `${a.reason}.${cv.note ? ` ${cv.note}` : ''}`;
  const worse = rank(a.tint) >= rank('yellow');
  return advice(a.key, worse ? a.tint : 'yellow', worse ? a.reason : cv.reason, `${first} ${cv.sentence}`, a.facts);
}

const FP4 = new Set(['MXFP4', 'MXFP4_MOE', 'NVFP4']);

function fp4Note(type: string | null, c: Ctx): string {
  if (type === null || !FP4.has(type)) return '';
  const native = c.gpuKind === 'nvidia' && (c.input.machine.computeCap ?? 0) >= NATIVE_FP4_CC;
  const speed = native ? ' FP4 type: your card has native FP4.' : ' FP4 type: native FP4 speed needs an RTX 50-series card.';
  return type === 'NVFP4' ? `${speed} NVFP4 needs llama.cpp b8967 or newer; LM Studio and Ollama support is not confirmed.` : speed;
}

type Step = { done: GroupAdvice } | { sized: Sized };

/** The label, the fork-only blocker it names (if any) and the type rule 1 judges: the blocker's token, else the type. */
function typeOf(g: AdviceGroupInput, knowledge: Knowledge): { label: Label; blocker: (typeof CANNOT_LOAD)[number] | undefined; subject: string | null } {
  const label = readLabel(g, knowledge);
  const labelTokens = tokens(g.label).map((t) => t.toUpperCase());
  const blocker = CANNOT_LOAD.find((b) => labelTokens.includes(b.token.toUpperCase()) || label.type === b.token.toUpperCase());
  return { label, blocker, subject: blocker?.token ?? label.type };
}

/** A weight group whose facts are incomplete (shards missing, no shape, no parameter count, no type): never compared. */
function unreadable(g: AdviceGroupInput, knowledge: Knowledge): boolean {
  if (g.shards !== null && g.shards.present < g.shards.expected) return true;
  if (g.shape === null || !(g.shape.paramCount > 0)) return true;
  return typeOf(g, knowledge).subject === null;
}

/** Rule 1, then the size rules; a rule-1 caveat is folded into whatever the size rules say. */
function quantStep(g: AdviceGroupInput, c: Ctx): Step {
  const { tools, knowledge } = c.input;
  const { label, blocker, subject } = typeOf(g, knowledge);
  if (subject === null) return { done: advice(g.key, null, 'File type unknown: not in the header or the name') };
  const note = fp4Note(label.type, c).trim();
  // Rule 1: red only when every selected tool is a definite no.
  const load = loadVerdict(tools, (t) => ggufTypeSupport(subject, t));
  if (load.kind === 'no') {
    const needs = blocker?.needs ?? 'llama.cpp';
    return { done: advice(g.key, 'red', `Needs ${needs}; none of your tools load it`,
      `${g.label} needs ${needs}. None of ${names(tools)} loads it.`) };
  }
  const caveat: Caveat | null = load.kind === 'unknown'
    ? { reason: `Not confirmed to load in ${names(load.unknown)}`, note,
      sentence: `Not confirmed to load in ${names(load.unknown)}: the guide does not confirm that ${names(load.unknown)} can load ${subject}.` }
    : null;
  const step = sizeStep(g, c, label, note, caveat);
  return 'done' in step ? { done: withCaveat(step.done, caveat) } : step;
}

/** The missing-fact cases and rules 2–3 for one quant group that rule 1 did not rule out. */
function sizeStep(g: AdviceGroupInput, c: Ctx, label: Label, note: string, caveat: Caveat | null): Step {
  // Missing facts: no size tint, and the reason says what is missing.
  if (c.gpu === null) return { done: advice(g.key, null, 'Set your GPU memory in Settings for size advice') };
  if (g.shards !== null && g.shards.present < g.shards.expected) {
    return { done: advice(g.key, null, `Incomplete: ${g.shards.present} of ${g.shards.expected} parts present`) };
  }
  if (g.shape === null) return { done: advice(g.key, null, 'Model shape unknown: header unreadable') };
  if (!(g.shape.paramCount > 0)) return { done: advice(g.key, null, 'Parameter count unknown: header has no tensor sizes') };

  const ctx = c.input.settings.context;
  const kvSel = kvCacheBytes(g.shape, ctx, c.input.settings.kvType);
  const kvQ8 = kvCacheBytes(g.shape, ctx, 'q8_0');
  const mmBytes = c.mm?.bytes ?? 0;
  const needSel = g.bytes + kvSel + mmBytes + HEADROOM;
  const needQ8 = g.bytes + kvQ8 + mmBytes + HEADROOM;
  const bpw = (g.bytes * 8) / g.shape.paramCount;
  const facts = [
    `weights ${formatBytes(g.bytes)}`, `KV cache ${formatBytes(kvSel)} (${c.ctxK} context, ${c.kvName})`,
    ...(c.mm ? [`mmproj ${formatBytes(c.mm.bytes)} (${c.mm.label})`] : []),
    `headroom ${formatBytes(HEADROOM)}`, `needed ${formatBytes(needSel)}`, `budget ${formatBytes(c.gpu)}`,
    ...(c.display ? ['1 GB kept free for the display'] : []),
    `${bpw.toFixed(2)} bits per weight`,
  ];
  const base = `${g.label} needs about ${formatBytes(g.bytes)} of weights + ${formatBytes(kvSel)} KV cache at ${c.ctxK} (${c.kvName})`
    + (c.mm ? ` + ${formatBytes(c.mm.bytes)} mmproj` : '')
    + ` + ${formatBytes(HEADROOM)} headroom = ${formatBytes(needSel)}. Your ${c.gpuName} has ${formatBytes(c.gpu)}`
    + `${c.display ? ' to use, with 1 GB kept free for the display' : ''}.${note ? ` ${note}` : ''}`;

  // Rule 2: too big even with a q8_0 KV cache.
  if (needQ8 > c.gpu) {
    const why = `${base} That is more than it has, even with a q8_0 KV cache (${formatBytes(needQ8)}).`;
    if (g.bytes > c.gpu + c.ram - MOE_RAM_RESERVE) return { done: advice(g.key, 'red', 'Too big for this PC', why, facts) };
    if (label.type === 'F32') return { done: advice(g.key, 'red', 'Too big to use on this card', why, facts) };
    if (g.shape.expertCount > 0) {
      return { done: advice(g.key, 'yellow', 'Larger than VRAM; as a MoE it can keep experts in RAM, at lower speed', why, facts) };
    }
    return { done: advice(g.key, 'red', `Too big for ${gb(c.card!)} GB; would run partly from system RAM, slowly`, why, facts) };
  }
  // Rule 3: tight. Say what makes it fit comfortably.
  const spare = c.gpu - needSel;
  let tightHow: string | null = null;
  if (spare < COMFORT) {
    const q8Comfortable = c.input.settings.kvType === 'f16' && c.gpu - needQ8 >= COMFORT;
    tightHow = q8Comfortable ? 'a q8_0 KV cache' : needSel > c.gpu ? 'a q8_0 KV cache and a shorter context' : 'a shorter context';
    facts.push(`needed with a q8_0 KV cache ${formatBytes(needQ8)}`);
  }
  const sized: Sized = { g, label, bpw, needSel, needQ8, spare, tightHow, base, facts, caveat };
  // The guide's own picks: types with no fast CUDA kernels are never the pick on NVIDIA.
  if (c.gpuKind === 'nvidia' && label.type !== null && SLOW_ON_NVIDIA.includes(label.type)) {
    const ternary = label.type.startsWith('TQ') ? '; only good on models trained for them' : '';
    return { done: advice(g.key, 'yellow', `slow on NVIDIA: no fast CUDA kernels${ternary}`, `${base} ${label.type} has no fast CUDA kernels.`, facts) };
  }
  return { sized };
}

/** Rule 4: highest effective bpw; within 3% a recipe beats a static quant; a QAT repo's Q4_0 first. */
function pick(pool: Sized[], qat: boolean): Sized | null {
  if (qat) {
    const q40 = pick(pool.filter((s) => s.label.type === 'Q4_0'), false);
    if (q40) return q40;
  }
  const byBpw = [...pool].sort((a, b) => b.bpw - a.bpw);
  const top = byBpw[0];
  if (!top || top.label.recipe) return top ?? null;
  return byBpw.find((s) => s.label.recipe && sameSize(s.g.bytes, top.g.bytes)) ?? top;
}

function sizedAdvice(s: Sized, c: Ctx, best: Sized | null, closest: Sized | null): GroupAdvice {
  const { g, facts } = s;
  const qatNote = c.qat && best?.label.type === 'Q4_0' ? ' This repo is quantization-aware trained for Q4_0, so its Q4_0 file is the guide\'s pick.' : '';
  if (s.tightHow !== null) {
    // Not fitting with the selected KV cache yet passing rule 2 means the selected one is F16.
    const now = s.needSel > c.gpu! ? 'That is more than it has with an F16 KV cache'
      : `That leaves less than ${formatBytes(COMFORT)} to spare`;
    const how = `${s.base} ${now}; it fits with ${s.tightHow}.`;
    const prefix = s === closest ? 'Closest fit, but tight' : 'Tight';
    return advice(g.key, 'yellow', `${prefix}: fits only with ${s.tightHow}`, how, facts);
  }
  const spare = `${s.base} It fits with ${formatBytes(s.spare)} to spare.`;
  if (s === best && c.unread.length > 0) {
    // Green needs every weight group compared; this is only the best of those that could be read.
    return advice(g.key, 'yellow', `Best of the files that could be checked; ${c.unread.length} could not be read`,
      `${spare} At ${s.bpw.toFixed(2)} effective bits per weight it is the best of the files that could be checked. `
      + `Could not be read, so not compared: ${c.unread.join(', ')}.${qatNote}`, facts);
  }
  if (s === best) {
    return advice(g.key, 'green', `Best pick: fits with room for ${c.ctxK} context`,
      `${spare} At ${s.bpw.toFixed(2)} effective bits per weight it is the best file here that fits.${qatNote}`, facts);
  }
  // A caveat group is only out of the pick because of its caveat: with no best pick, or ranking above it, the caveat
  // alone gives the tint (rule 5 would wrongly call the pick better).
  if (best === null || (s.caveat !== null && s.bpw >= best.bpw)) return advice(g.key, null, 'Fits', spare, facts);
  const b = best;
  if (sameSize(g.bytes, b.g.bytes)) {
    return advice(g.key, 'yellow', `Same size as ${b.g.label}, which is the better recipe; keep one`, `${spare} ${b.g.label} is about the same size and the better recipe.`, facts);
  }
  if (s.bpw < LOW_BPW && b.bpw >= HIGH_BPW) {
    return advice(g.key, 'red', `Much lower quality, and ${b.g.label} fits`, `${spare} Under ${LOW_BPW} effective bits per weight loses much quality; ${b.g.label} fits at ${b.bpw.toFixed(2)}.`, facts);
  }
  return advice(g.key, 'yellow', `Fits, but ${b.g.label} is better and also fits`, `${spare} ${b.g.label} is the better pick and also fits.${qatNote}`, facts);
}

const precisionOf = (label: string): string | null => /\(([^)]+)\)/.exec(label)?.[1] ?? null;

/** F16, then BF16, then Q8_0, then the largest other. */
function recommendMmproj(mm: AdviceGroupInput[]): AdviceGroupInput | null {
  for (const p of MMPROJ_ORDER) {
    const hit = mm.find((g) => precisionOf(g.label) === p);
    if (hit) return hit;
  }
  return [...mm].sort((a, b) => b.bytes - a.bytes)[0] ?? null;
}

function mmprojAdvice(g: AdviceGroupInput, rec: AdviceGroupInput, count: number): GroupAdvice {
  const facts = [`mmproj ${formatBytes(g.bytes)}`];
  if (g === rec) {
    return count === 1
      ? advice(g.key, 'green', 'Needed for images; keep it with the quant you use', 'The vision projector lets the model read images.', facts)
      : advice(g.key, 'green', 'Needed for images; keep it with the quant you use', 'The recommended vision projector of this repo; the size advice counts it.', facts);
  }
  if (precisionOf(g.label) === 'F32') {
    return advice(g.key, 'yellow', 'Twice the size of F16 with no visible benefit', 'An F32 projector is twice the size of F16 for no visible gain.', facts);
  }
  const recName = precisionOf(rec.label);
  const name = recName === null ? 'mmproj' : `mmproj-${recName}`;
  return advice(g.key, 'yellow', `Duplicate of ${name}; you need only one`, `Keep one vision projector; ${rec.label} is the recommended one.`, facts);
}

const MTP_NOTE = DRAFTERS.find((d) => d.token === 'MTP')!.note;
function mtpAdvice(key: string, tools: Tool[], facts: string[], extra: string): GroupAdvice {
  return tools.includes('llama.cpp')
    ? advice(key, 'green', 'Runs in llama.cpp with --spec-type draft-mtp; adds some memory', `${MTP_NOTE}.${extra}`, facts)
    : advice(key, 'yellow', "LM Studio and Ollama don't use MTP yet; harmless but unused", `${MTP_NOTE}.${extra}`, facts);
}

/** Primary kinds that may be language models; diffusers pipelines, adapters, components, datasets and spaces are not. */
const LM_KINDS: ReadonlySet<RepoKind> = new Set(['gguf', 'transformers', 'single-file', 'unknown']);

/** Rule 1's red for a repo format: MLX off macOS, ONNX language models, or the tools that would load it. */
function cannotLoad(c: Ctx): GroupAdvice {
  const { format, machine } = c.input;
  const key = 'repo';
  if (format === 'mlx' && machine.platform !== 'darwin') {
    const where = PLATFORM_NAMES[machine.platform] ?? machine.platform;
    return advice(key, 'red', `MLX is Apple-only; nothing on this ${where} PC can load it`, 'MLX runs only on Apple Silicon Macs.');
  }
  if (format === 'onnx') return advice(key, 'red', 'None of your tools load ONNX language models', 'No selected tool loads ONNX language models.');
  const needs = ALL_TOOLS.filter((t) => formatSupport(format, t, machine.platform) === 'yes');
  return needs.length > 0
    ? advice(key, 'red', `Needs ${names(needs, ' or ')}; none of your tools load it`, `Tools that load this format: ${names(needs)}.`)
    : advice(key, 'red', 'None of your tools load it', 'No known tool loads this format.');
}

/** What the format adds to a repo judgment: the tools that load it as stored, else a yellow caveat (or none, unrecognised). */
interface FormatPart { tint: 'yellow' | null; yes: Tool[]; fits: string; alone: string; sentence: string }

const GGUF_TOOLS: ReadonlySet<Tool> = new Set(['llama.cpp', 'lmstudio', 'ollama']);
const CONVERT = 'need it converted to GGUF; vLLM or transformers can run it as is';

/** The format first. A red ends the judgment; "not confirmed" is a caveat (yellow at best). */
function formatPart(c: Ctx): GroupAdvice | FormatPart {
  const { format, tools, machine } = c.input;
  if (format === 'unknown') {
    return { tint: null, yes: [], fits: 'Fits, but the format is not recognised', alone: '', sentence: 'The format is not recognised, so there is no advice on which tool loads it.' };
  }
  const load = loadVerdict(tools, (t) => formatSupport(format, t, machine.platform));
  if (load.kind === 'yes') return { tint: null, yes: load.yes, fits: '', alone: '', sentence: '' };
  if (format === 'safetensors-16' && tools.every((t) => GGUF_TOOLS.has(t))) {
    return { tint: 'yellow', yes: [], fits: `Fits, but your tools ${CONVERT}`, alone: `Your tools ${CONVERT}`,
      sentence: `${names(tools)} do not load it as stored: they ${CONVERT}.` };
  }
  if (load.kind === 'no') return cannotLoad(c);
  const reason = `Not confirmed to load in ${names(load.unknown)}`;
  return { tint: 'yellow', yes: [], fits: reason, alone: reason,
    sentence: `${reason}: it is not confirmed that ${names(load.unknown)} can load this format.` };
}

interface SizePart { tint: Tint | null; reason: string; explanation: string; facts: string[]; fine: boolean }

/**
 * The size of a repo of plain weights: the counted weights (`repoWeights`), plus the KV cache
 * from config.json (none for a pipeline) and the headroom. Missing facts give no tint and say what is missing.
 */
function sizePart(c: Ctx, pipeline: boolean): SizePart {
  const { settings, incomplete, repoShape, repoWeights } = c.input;
  const unknown = (reason: string): SizePart => ({ tint: null, reason, explanation: '', facts: [], fine: false });
  if (c.gpu === null) return unknown('Set your GPU memory in Settings for size advice');
  if (incomplete) return unknown('Incomplete download: some weight files are missing or still downloading');
  const weights = repoWeights?.bytes ?? 0;
  const note = repoWeights?.note ?? null;
  if (!(weights > 0)) return unknown('No safetensors or PyTorch weights to size');
  const shape = pipeline ? null : repoShape;
  if (!pipeline && shape === null) return unknown('Model shape unknown: config.json unreadable or missing the layer or head counts');

  const kvSel = shape === null ? 0 : kvCacheBytes(shape, settings.context, settings.kvType);
  const kvQ8 = shape === null ? 0 : kvCacheBytes(shape, settings.context, 'q8_0');
  const needSel = weights + kvSel + HEADROOM;
  const needQ8 = weights + kvQ8 + HEADROOM;
  const w = formatBytes(weights);
  const card = gb(c.card!);
  const facts = [
    `weights ${w}`, ...(shape === null ? [] : [`KV cache ${formatBytes(kvSel)} (${c.ctxK} context, ${c.kvName})`]),
    `headroom ${formatBytes(HEADROOM)}`, `needed ${formatBytes(needSel)}`, `budget ${formatBytes(c.gpu)}`,
    ...(c.display ? ['1 GB kept free for the display'] : []),
    ...(note === null ? [] : [note]),
  ];
  const base = `This ${pipeline ? 'pipeline' : 'model'} needs about ${w} of weights`
    + (shape === null ? '' : ` + ${formatBytes(kvSel)} KV cache at ${c.ctxK} (${c.kvName})`)
    + ` + ${formatBytes(HEADROOM)} headroom = ${formatBytes(needSel)}. Your ${c.gpuName} has ${formatBytes(c.gpu)}`
    + `${c.display ? ' to use, with 1 GB kept free for the display' : ''}.`;

  if (needQ8 > c.gpu) {
    const why = `${base} That is more than it has${shape === null ? '' : `, even with a q8_0 KV cache (${formatBytes(needQ8)})`}.`;
    const stored = `Too big for ${card} GB as stored (${w} of weights)`;
    if (shape === null || !(shape.paramCount > 0)) return { tint: 'red', reason: stored, explanation: why, facts, fine: false };
    // A 4-bit estimate: parameters x 4.5 bits, with the same KV cache and headroom, and 1 GB to spare.
    const q4 = (shape.paramCount * 4.5) / 8;
    const q4Need = q4 + kvSel + HEADROOM;
    const est = `a 4-bit GGUF quant (about ${formatBytes(q4)} at 4.5 bits per weight) would need about ${formatBytes(q4Need)}`;
    return q4Need + COMFORT <= c.gpu
      ? { tint: 'red', reason: `${stored}; a GGUF quant of this model would fit`, explanation: `${why} As GGUF, ${est}, which fits.`, facts, fine: false }
      : { tint: 'red', reason: 'Too big for this PC', explanation: `${why} Even ${est}.`, facts, fine: false };
  }
  const spare = c.gpu - needSel;
  if (spare < COMFORT) {
    const now = needSel > c.gpu ? 'That is more than it has with an F16 KV cache' : `That leaves less than ${formatBytes(COMFORT)} to spare`;
    let how = '';
    if (shape !== null) {
      const q8Comfortable = settings.kvType === 'f16' && c.gpu - needQ8 >= COMFORT;
      how = `; it fits with ${q8Comfortable ? 'a q8_0 KV cache' : needSel > c.gpu ? 'a q8_0 KV cache and a shorter context' : 'a shorter context'}`;
      facts.push(`needed with a q8_0 KV cache ${formatBytes(needQ8)}`);
    }
    return { tint: 'yellow', reason: `Tight: ${w} of weights on a ${card} GB card`, explanation: `${base} ${now}${how}.`, facts, fine: false };
  }
  return { tint: null, reason: `Fits in ${card} GB (${w} of weights)`, explanation: `${base} It fits with ${formatBytes(spare)} to spare.`, facts, fine: true };
}

const sentences = (...xs: string[]): string => xs.filter((x) => x !== '').join(' ');

/** One judgment for a transformers repo: green only for a comfortable fit in a format a selected tool loads. */
function weightsLine(c: Ctx): GroupAdvice {
  const fmt = formatPart(c);
  if ('key' in fmt) return fmt;
  const size = sizePart(c, false);
  const key = 'repo';
  if (size.fine) {
    return fmt.yes.length > 0
      ? advice(key, 'green', `Runs here with ${names(fmt.yes)}`, `${size.explanation} ${names(fmt.yes)} load this format as stored.`, size.facts)
      : advice(key, fmt.tint, fmt.fits, sentences(size.explanation, fmt.sentence), size.facts);
  }
  // The worse of format and size wins; on a tie the size reason; both explained.
  return rank(size.tint) >= rank(fmt.tint)
    ? advice(key, size.tint, size.reason, sentences(size.explanation !== '' ? size.explanation : `${size.reason}.`, fmt.sentence), size.facts)
    : advice(key, fmt.tint, fmt.alone, sentences(`${size.reason}.`, fmt.sentence), size.facts);
}

function repoLine(c: Ctx): GroupAdvice | null {
  const { repoId, format, tools, machine, repoKind } = c.input;
  const key = 'repo';
  if (repoKind === 'diffusers') {   // A pipeline gets the size part only; LM tools and formats do not apply
    const s = sizePart(c, true);
    const reason = s.fine ? s.reason.replace(/\)$/, '; runs in a diffusers app such as ComfyUI)') : s.reason;
    return advice(key, s.tint, reason, s.explanation, s.facts);
  }
  if (!LM_KINDS.has(repoKind)) return null;
  if (tools.length === 0) return format === 'gguf' || format === 'unknown' ? null : advice(key, null, NO_TOOLS);
  const nameTokens = tokens(repoId.slice(repoId.lastIndexOf('/') + 1));
  const drafter = DRAFTERS.find((d) => d.token !== 'MTP' && nameTokens.some((t) => new RegExp(`^${d.token}\\d*$`, 'i').test(t)));
  if (drafter) {
    const runs = drafter.runsIn.filter((t) => tools.includes(t));
    return runs.length > 0
      ? advice(key, 'yellow', `${drafter.token} drafter for speculative decoding; runs in ${names(runs)}`, drafter.note)
      : advice(key, 'red', `${drafter.token} drafter for speculative decoding; none of your tools run it`, drafter.note);
  }
  if (format === 'gguf' && nameTokens.some((t) => t.toUpperCase() === 'MTP')) return mtpAdvice(key, tools, [], ' This repo keeps the MTP layers in its GGUF files.');
  if (repoKind === 'transformers') return weightsLine(c);
  if (format === 'gguf' || format === 'unknown') return null;
  if (format === 'mlx' && machine.platform === 'darwin') {
    return advice(key, null, 'MLX runs on Apple Silicon in LM Studio and Ollama', 'MLX is Apple\'s own format.');
  }
  const load = loadVerdict(tools, (t) => formatSupport(format, t, machine.platform));
  if (load.kind === 'yes') return advice(key, null, `Loads in ${names(load.yes)}`);
  if (load.kind === 'unknown') {
    return advice(key, 'yellow', `Not confirmed to load in ${names(load.unknown)}`, `It is not confirmed that ${names(load.unknown)} can load this format.`);
  }
  return cannotLoad(c);
}

function basis(c: Ctx): string {
  const { machine, settings, tools } = c.input;
  const gpu = c.card === null ? 'GPU memory not set' : `${c.gpuName} ${gb(c.card)} GB`;
  return [PLATFORM_NAMES[machine.platform] ?? machine.platform, gpu, `${gb(c.ram)} GB RAM`, `${settings.context / 1024}K context`,
    tools.length > 0 ? names(tools) : 'no tools chosen'].join(' · ');
}

export function advise(input: AdviceInput): RepoAdvice {
  const { machine, settings, tools, groups } = input;
  const prof = effectiveProfile(machine, settings);
  const display = settings.drivesDisplay ?? machine.drivesDisplay;
  const mmGroups = groups.filter((g) => g.kind === 'mmproj' && !g.locked);
  const rec = recommendMmproj(mmGroups);
  const nameTokens = tokens(input.repoId.slice(input.repoId.lastIndexOf('/') + 1).replace(/_/g, ' '));
  const c: Ctx = {
    input, gpu: prof.gpuBytes, card: cardBytes(machine, settings, prof.gpuKind, prof.ramBytes), ram: prof.ramBytes, gpuKind: prof.gpuKind, display,
    gpuName: machine.gpuName ?? (prof.gpuKind === 'apple' ? 'Apple unified memory' : 'GPU'),
    ctxK: `${settings.context / 1024}K`, kvName: settings.kvType === 'f16' ? 'F16' : 'q8_0',
    mm: rec ? { bytes: rec.bytes, label: rec.label } : null,
    qat: nameTokens.some((t) => QAT_TOKENS.some((q) => q.toLowerCase() === t.toLowerCase())),
    unread: groups.filter((g) => g.kind === 'quant' && !g.locked && !imatrixOnly(g) && unreadable(g, input.knowledge))
      .map((g) => g.label),
  };

  const out = new Map<string, GroupAdvice>();
  const sized: Sized[] = [];
  for (const g of groups) {
    if (g.locked || g.kind === 'superseded') out.set(g.key, NONE(g.key));
    else if (imatrixOnly(g)) {
      out.set(g.key, advice(g.key, 'yellow', 'Only needed to make your own quants', 'An importance matrix is used when quantizing; running the model never needs it.', [`imatrix ${formatBytes(g.bytes)}`]));
    } else if (g.kind === 'mmproj') out.set(g.key, tools.length === 0 ? advice(g.key, null, NO_TOOLS) : mmprojAdvice(g, rec!, mmGroups.length));
    else if (g.kind !== 'quant' && g.kind !== 'draft') out.set(g.key, NONE(g.key));
    else if (tools.length === 0) out.set(g.key, advice(g.key, null, NO_TOOLS));
    else if (g.kind === 'draft') out.set(g.key, mtpAdvice(g.key, tools, [`draft ${formatBytes(g.bytes)}`], ` Adds about ${formatBytes(g.bytes)} to the memory needed when used.`));
    else {
      const step = quantStep(g, c);
      if ('done' in step) out.set(g.key, step.done);
      else sized.push(step.sized);
    }
  }
  // Only a comfortable fit can be green; with none, the best tight one is the closest fit.
  // A "not confirmed" group never takes the one green slot (or the closest-fit label).
  const clean = sized.filter((s) => s.caveat === null);
  const best = pick(clean.filter((s) => s.tightHow === null), c.qat);
  const closest = best === null ? pick(clean, c.qat) : null;
  for (const s of sized) out.set(s.g.key, withCaveat(sizedAdvice(s, c, best, closest), s.caveat));

  return {
    groups: groups.map((g) => out.get(g.key)!),
    repoLine: repoLine(c),
    basis: basis(c),
  };
}
