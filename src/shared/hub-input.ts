// Hub input parsing: a port of hfu.py's parse_hf_input plus an optional @revision.
// No Node types here: this file is shared with the renderer.

export type HubRepoType = 'model' | 'dataset' | 'space';

const HF_HOSTS = ['huggingface.co', 'hf.co'];
const TYPE_PREFIXES: Record<string, HubRepoType> = { datasets: 'dataset', models: 'model', spaces: 'space' };
const NAME_PART = /^[\p{L}\p{N}_\-.]+$/u;

const validName = (p: string): boolean => p !== '.' && p !== '..' && NAME_PART.test(p);

export function isCommitHash(rev: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(rev);
}

/** A revision usable as a ref name: no `..`, not absolute, only safe characters. */
export function safeRef(rev: string): boolean {
  return (
    rev.length > 0 &&
    !rev.includes('..') &&
    /^[A-Za-z0-9._/-]+$/.test(rev) &&
    rev.split('/').every((seg) => seg !== '' && seg !== '.')
  );
}

export function encodeRevision(rev: string): string {
  return rev.split('/').map(encodeURIComponent).join('/');
}

export function parseHubInput(
  text: string,
): { repoId: string; type: HubRepoType; revision: string } | { error: string } {
  const trimmed = text.trim();
  // a URL pasted without its scheme ("huggingface.co/org/name") is a URL, never a namespace named after the host
  const bare = /^(?:www\.)?([^/?#@:]+)(?=[/?#]|$)/i.exec(trimmed);
  const input = bare && HF_HOSTS.includes((bare[1] ?? '').toLowerCase()) ? `https://${trimmed}` : trimmed;
  let path = input;
  let revision = 'main';
  const url = /^[^/?#]*:\/\/([^/?#]*)([^?#]*)/.exec(input);
  if (url) {
    const host = (url[1] ?? '').toLowerCase().replace(/^www\./, '');
    if (!HF_HOSTS.includes(host)) return { error: `Not a Hugging Face URL: '${text}'` };
    path = url[2] ?? '';
  } else {
    const at = input.indexOf('@');
    if (at >= 0) {
      path = input.slice(0, at);
      revision = input.slice(at + 1);
    }
  }

  const parts = path.split('/').filter((p) => p);
  let type: HubRepoType = 'model';
  const prefixed = TYPE_PREFIXES[parts[0] ?? ''];
  if (prefixed && Object.hasOwn(TYPE_PREFIXES, parts[0] ?? '')) {
    type = prefixed;
    parts.shift();
  }

  const [ns, name] = parts;
  if (ns === undefined || name === undefined || !validName(ns) || !validName(name)) {
    return {
      error:
        `Invalid Hugging Face path format: '${text}'\n` +
        'Expected: <namespace>/<name> (e.g. unsloth/Qwen3.6-35B-A3B-GGUF)',
    };
  }
  if (!safeRef(revision)) return { error: `Invalid revision: '${revision}'` };
  return { repoId: `${ns}/${name}`, type, revision };
}
