// Tells a diffusion or ComfyUI repo from a language model using only downloaded files. Both files are untrusted.
// A W#A# name is never a signal: vLLM language models carry the same labels.

/** 'comfyui': the repo says it is packaged for ComfyUI (it may hold a text encoder). 'diffusion': it says it is a diffusion model. */
export type DiffusionSignal = 'comfyui' | 'diffusion';

export interface FrontMatter { pipelineTag: string | null; libraryName: string | null; tags: string[] }

const COMFY_TAGS: ReadonlySet<string> = new Set(['comfyui', 'comfy-kitchen']);
const DIFFUSION_PIPELINES: ReadonlySet<string> = new Set([
  'text-to-image', 'image-to-image', 'text-to-video', 'image-to-video', 'video-to-video', 'unconditional-image-generation',
]);
/** Keys only a real transformers or diffusers component config has; its loader decides, not the model card. */
const MODEL_CONFIG_KEYS = ['model_type', 'architectures', '_class_name'];

const scalar = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim().toLowerCase();

/** The fields we use of a model card's YAML front matter: top-level keys only, without a YAML library. */
export function readFrontMatter(text: string): FrontMatter {
  const out: FrontMatter = { pipelineTag: null, libraryName: null, tags: [] };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return out;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return out;
  let inTags = false;
  for (const line of lines.slice(1, end)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item !== null) {
      if (inTags) out.tags.push(scalar(item[1]!));
      continue;
    }
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m === null) {
      if (!line.startsWith(' ')) inTags = false;
      continue;
    }
    const [, key, value] = m as unknown as [string, string, string];
    inTags = key === 'tags' && value.trim() === '';
    if (key === 'pipeline_tag') out.pipelineTag = scalar(value);
    else if (key === 'library_name') out.libraryName = scalar(value);
    else if (key === 'tags') {
      const inline = /^\[(.*)\]\s*$/.exec(value.trim());
      if (inline !== null) out.tags = inline[1]!.split(',').map(scalar).filter((t) => t !== '');
    }
  }
  return out;
}

function parseConfig(text: string): Record<string, unknown> | null {
  try {
    const j: unknown = JSON.parse(text);
    return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What config.json alone decides. 'card': nothing, so the model card may. 'none': it rules the card out. */
function configSays(configText: string | null): 'comfyui' | 'none' | 'card' {
  if (configText === null) return 'card';
  const config = parseConfig(configText);
  if (config === null) return 'none';
  if (config['loader'] === 'comfyui' || config['library'] === 'comfy-kitchen') return 'comfyui';
  return MODEL_CONFIG_KEYS.some((k) => config[k] !== undefined) ? 'none' : 'card';
}

/** Whether the model card tags this repo as a LoRA. LoRA cards often say text-to-image too, so this is asked before diffusionSignal. */
export function loraTagged(configText: string | null, readmeText: string | null): boolean {
  return configSays(configText) === 'card' && readmeText !== null && readFrontMatter(readmeText).tags.includes('lora');
}

/** `configText` and `readmeText` are null when the file is absent. A wrong guess would hide advice on a language model, so anything unclear is null. */
export function diffusionSignal(configText: string | null, readmeText: string | null): DiffusionSignal | null {
  const fromConfig = configSays(configText);
  if (fromConfig === 'comfyui') return 'comfyui';
  if (fromConfig === 'none' || readmeText === null) return null;
  const card = readFrontMatter(readmeText);
  if (card.tags.some((t) => COMFY_TAGS.has(t))) return 'comfyui';
  if (card.tags.includes('diffusion-single-file') || card.libraryName === 'diffusers') return 'diffusion';
  return card.pipelineTag !== null && DIFFUSION_PIPELINES.has(card.pipelineTag) ? 'diffusion' : null;
}
