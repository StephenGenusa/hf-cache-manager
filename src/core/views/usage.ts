// Read-only usage index: which LM Studio paths and Ollama tags use each cached file (etag). Reads through ReadFs only;
// a disabled, missing or unreadable view contributes nothing and never throws.
import { resolve } from 'node:path';
import { isPyMap, pyLoads, pySort, type PyJson } from '../compat/pyjson';
import type { HfhubConfig } from '../compat/config';
import { readFs, type ReadFs } from '../fsx';
import { normalizeLinkText } from '../paths';
import type { CacheModel, UsageIndex } from '../types';
import { readManifestText } from './ollama';
import { MT } from './registry';
import { walkTree } from './walk';

const SHA_PREFIX = 'sha256:';

/** `manifests/`-relative POSIX path to a tag name (`hf.co/o/n/t` -> `hf.co/o/n:t`, `registry.ollama.ai/library/n/t` -> `n:t`). */
export function tagName(rel: string): string {
  const i = rel.lastIndexOf('/');
  if (i < 0) return rel;
  const head = rel.slice(0, i);
  const tag = rel.slice(i + 1);
  if (head.startsWith('registry.ollama.ai/library/') && head.indexOf('/', 'registry.ollama.ai/library/'.length) < 0) {
    return `${head.slice('registry.ollama.ai/library/'.length)}:${tag}`;
  }
  if (head.startsWith('registry.ollama.ai/')) return `${head.slice('registry.ollama.ai/'.length)}:${tag}`;
  return `${head}:${tag}`;
}

/** Digests (hex, lower-case) of the model and projector layers of a manifest; [] for anything not understood. */
function usedDigests(text: string): string[] {
  let j: PyJson;
  try {
    j = pyLoads(text);
  } catch {
    return [];
  }
  if (!isPyMap(j)) return [];
  const layers = j.get('layers');
  if (!Array.isArray(layers)) return [];
  const out: string[] = [];
  for (const l of layers) {
    if (!isPyMap(l)) continue;
    const mt = l.get('mediaType');
    const d = l.get('digest');
    if ((mt === MT.model || mt === MT.projector) && typeof d === 'string' && d.startsWith(SHA_PREFIX)) out.push(d.slice(SHA_PREFIX.length).toLowerCase());
  }
  return out;
}

export async function buildUsageIndex(config: HfhubConfig, model: CacheModel, fs: ReadFs = readFs): Promise<UsageIndex> {
  const byBlobPath = new Map<string, string>();
  const etags = new Set<string>();
  for (const repo of model.repos) {
    if (repo.type !== 'model') continue;
    for (const [etag, b] of Object.entries(repo.blobs)) {
      byBlobPath.set(resolve(b.path), etag.toLowerCase());
      etags.add(etag.toLowerCase());
    }
  }
  const lm = new Map<string, Set<string>>();
  const ol = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, etag: string, v: string): void => {
    const s = m.get(etag) ?? new Set<string>();
    s.add(v);
    m.set(etag, s);
  };

  const lmRoot = config.views.lmstudio.root;
  if (lmRoot !== null && byBlobPath.size > 0) {
    try {
      for await (const { rel, abs, facts } of walkTree(fs, lmRoot)) {
        if (!facts.isSymlink) continue;
        try {
          const etag = byBlobPath.get(resolve(abs, '..', normalizeLinkText(await fs.readlink(abs))));
          if (etag !== undefined) add(lm, etag, rel);
        } catch { /* unreadable link: not counted */ }
      }
    } catch { /* unreadable view: contributes what was read */ }
  }

  const olRoot = config.views.ollama.root;
  if (olRoot !== null && etags.size > 0) {
    const mroot = resolve(olRoot, 'manifests');
    try {
      for await (const { rel, abs, facts } of walkTree(fs, mroot)) {
        if (!facts.isFile || facts.isSymlink) continue;
        try {
          const text = await readManifestText(fs, abs);
          if (text === null) continue; // oversize: skipped unread
          for (const hex of new Set(usedDigests(text))) {
            if (etags.has(hex)) add(ol, hex, tagName(rel));
          }
        } catch { /* unreadable manifest: not counted */ }
      }
    } catch { /* unreadable view: contributes what was read */ }
  }

  const out: UsageIndex = {};
  for (const etag of new Set([...lm.keys(), ...ol.keys()])) {
    out[etag] = { lmstudio: pySort(lm.get(etag) ?? []), ollama: pySort(ol.get(etag) ?? []) };
  }
  return out;
}
