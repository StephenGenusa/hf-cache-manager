import { readTextSync } from '../fsx';
import type { Group, GroupKind, Repo, RepoKind, RepoView, SnapshotFile } from '../types';
import { targetOf } from './target';
import { ggufStem, isDraft, isGguf, isMmproj, isShard, quantLabel, shardInfo } from './gguf-names';

/** Reads a text file (following links). Returns null on any error or when larger than 1 MiB. */
export type ReadText = (absPath: string) => string | null;
export const defaultReadText: ReadText = (p) => readTextSync(p, 1 << 20);

const SMALL_ADAPTER_BYTES = 1_000_000_000;

/** Files of the effective current snapshot, exactly the files the scanner marked isCurrent (see SnapshotFile.isCurrent). */
export function currentFiles(repo: Repo): SnapshotFile[] {
  return repo.files.filter((f) => f.isCurrent);
}

const isRoot = (f: SnapshotFile): boolean => !f.relpath.includes('/');
const lower = (f: SnapshotFile): string => f.relpath.toLowerCase();
const baseName = (f: SnapshotFile): string => f.relpath.slice(f.relpath.lastIndexOf('/') + 1);

/** Blob payload size of a snapshot file: 0 if missing/dangling or an unrecognised link; plain files use their own size. */
export function fileBytes(repo: Repo, f: SnapshotFile): number {
  if (f.blobEtag !== null) {
    const b = repo.blobs[f.blobEtag];
    return b === undefined || b.dangling ? 0 : b.size;
  }
  return f.facts.isFile && !f.facts.isSymlink ? f.facts.size : 0;
}

/** Bytes of a set of files: each blob once (by etag), each plain file once (by dev:ino). */
export function groupBytes(repo: Repo, files: SnapshotFile[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    const id = f.blobEtag !== null ? `b:${f.blobEtag}` : `p:${f.facts.dev}:${f.facts.ino}`;
    if (seen.has(id)) continue;
    seen.add(id);
    total += fileBytes(repo, f);
  }
  return total;
}

function hasStringClassName(f: SnapshotFile, readText: ReadText): boolean {
  const text = readText(f.linkPath);
  if (text === null) return false;
  try {
    const j: unknown = JSON.parse(text);
    return typeof j === 'object' && j !== null && typeof (j as { _class_name?: unknown })._class_name === 'string';
  } catch {
    return false;
  }
}

export function detectKinds(repo: Repo, readText: ReadText = defaultReadText): RepoKind[] {
  const files = currentFiles(repo);
  const root = files.filter(isRoot);
  const rootNamed = (n: string): SnapshotFile | undefined => root.find((f) => f.relpath === n);
  const config = rootNamed('config.json');
  const hasModelIndex = rootNamed('model_index.json') !== undefined;
  const hasAdapterConfig = rootNamed('adapter_config.json') !== undefined;
  const safetensors = files.filter((f) => lower(f).endsWith('.safetensors'));
  const kinds: RepoKind[] = [];

  if (files.some((f) => isGguf(f.relpath))) kinds.push('gguf');
  if (hasModelIndex) kinds.push('diffusers');

  const configIsComponent = config !== undefined && hasStringClassName(config, readText);
  const weights = files.some((f) => /\.(safetensors|bin|pt|pth)$/.test(lower(f)));
  const rootIndex = root.some((f) => /\.(safetensors|bin)\.index\.json$/.test(lower(f)));
  if (config !== undefined && !configIsComponent && (weights || rootIndex)) kinds.push('transformers');

  const loraNamed = files.some((f) => /lora/i.test(baseName(f)));
  if (hasAdapterConfig ||
      (config === undefined && safetensors.every((f) => fileBytes(repo, f) < SMALL_ADAPTER_BYTES) && loraNamed)) {
    kinds.push('adapter');
  }

  if (config === undefined && !hasAdapterConfig && root.some((f) => /\.(safetensors|ckpt|sft)$/.test(lower(f)))) {
    kinds.push('single-file');
  }
  if (configIsComponent && !hasModelIndex) kinds.push('component');

  if (repo.type === 'dataset') kinds.push('dataset');
  else if (repo.type === 'space') kinds.push('space');
  if (kinds.length === 0) kinds.push('unknown');
  return kinds;
}

const GROUP_ORDER: GroupKind[] = ['quant', 'mmproj', 'draft', 'component', 'root-file', 'weights', 'tokenizer-config', 'other', 'assets', 'superseded'];
const ASSET_EXT = /\.(png|jpg|jpeg|gif|webp|svg|bmp|mp4|webm|mov|mp3|wav|flac|ogg)$/i;

const isAsset = (f: SnapshotFile): boolean => !isGguf(f.relpath) && (/^readme(\.|$)/i.test(baseName(f)) || ASSET_EXT.test(f.relpath));

/**
 * mmproj precision label from the stem's trailing token: BF16, F16, F32 or a Qn/IQn quant, upper-cased
 * ("mmproj-F16" -> "F16", "mmproj-Qwen-bf16" -> "BF16"). No recognised precision -> plain "vision projector".
 */
export function mmprojLabel(relpath: string): string {
  const m = /(?:^|[-._])(BF16|F16|F32|(?:UD-)?(?:IQ|TQ|Q)\d[A-Z0-9_]*)$/i.exec(ggufStem(relpath));
  return m ? `vision projector (${(m[1] ?? '').toUpperCase()})` : 'vision projector';
}

const identity = (f: SnapshotFile): string => (f.blobEtag !== null ? `b:${f.blobEtag}` : `p:${f.facts.dev}:${f.facts.ino}`);

function shardStatus(repo: Repo, files: SnapshotFile[]): { present: number; expected: number } | undefined {
  if (!files.some((f) => isShard(f.relpath))) return undefined;
  const present = new Set<number>();
  let expected = 0;
  for (const f of files) {
    const si = shardInfo(f.relpath);
    if (si === null) continue;
    expected = Math.max(expected, si.total);
    const exists = f.blobEtag !== null ? repo.blobs[f.blobEtag] !== undefined && !repo.blobs[f.blobEtag]!.dangling
      : f.facts.isFile && !f.facts.isSymlink;
    if (exists) present.add(si.index);
  }
  return { present: present.size, expected };
}

function makeGroup(repo: Repo, kind: GroupKind, label: string, files: SnapshotFile[]): Group {
  const g: Group = { key: `${kind}:${label}`, kind, label, files, apparentBytes: groupBytes(repo, files), locked: false };
  const shards = kind === 'quant' ? shardStatus(repo, files) : undefined;
  if (shards !== undefined) g.shards = shards;
  return g;
}

function bucket(items: Array<[string, SnapshotFile]>): Map<string, SnapshotFile[]> {
  const m = new Map<string, SnapshotFile[]>();
  for (const [label, f] of items) m.set(label, [...(m.get(label) ?? []), f]);
  return m;
}

const ROOT_CKPT = /\.(safetensors|ckpt|sft)$/i;
const WEIGHT_EXT = /\.(safetensors|bin|pt|pth|ckpt|h5|msgpack|onnx)$/i;
const TOKENIZER_CONFIG_NAMES = new Set([
  'config.json', 'generation_config.json', 'adapter_config.json', 'preprocessor_config.json',
  'special_tokens_map.json', 'added_tokens.json', 'merges.txt', 'chat_template.jinja', 'chat_template.json',
]);
const isWeights = (f: SnapshotFile): boolean => WEIGHT_EXT.test(f.relpath) || lower(f).endsWith('.index.json');
const isTokenizerConfig = (f: SnapshotFile): boolean => {
  const b = baseName(f);
  return TOKENIZER_CONFIG_NAMES.has(b) || /^tokenizer/.test(b) || /^vocab\./.test(b) || /\.(model|tiktoken)$/i.test(b);
};

/** Component folders named by a parseable model_index.json: keys not starting with "_" whose value is an array with a non-null first element. Null when absent or unreadable. */
function modelIndexComponents(repo: Repo, readText: ReadText): Set<string> | null {
  const mi = currentFiles(repo).find((f) => f.relpath === 'model_index.json');
  if (mi === undefined) return null;
  const text = readText(mi.linkPath);
  if (text === null) return null;
  try {
    const j: unknown = JSON.parse(text);
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
    const out = new Set<string>();
    for (const [k, v] of Object.entries(j)) {
      if (!k.startsWith('_') && !k.includes('/') && Array.isArray(v) && v.length > 0 && v[0] !== null && v[0] !== undefined) out.add(k);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Assigns every current file to exactly one group: the first matching rule wins.
 * Order: component, model_index, locked subfolder (unreadable index), asset, GGUF, root-file, weights, tokenizer-config, other-by-folder.
 * The weights and tokenizer-config buckets apply only to transformers, adapter and component model repos,
 * and never when an unreadable model_index.json makes subfolders fail closed.
 * Non-current files (not in currentFiles) whose blob no current file uses go to `superseded`, or, when a ref under
 * refs/ names their snapshot, to an `other` group "Files only in <ref names>".
 */
function buildGroups(repo: Repo, kinds: RepoKind[], readText: ReadText): Group[] {
  const components = modelIndexComponents(repo, readText);
  const rootFileOk = (kinds.includes('diffusers') || kinds.includes('single-file')) &&
    !kinds.some((k) => k === 'transformers' || k === 'adapter' || k === 'component');
  // Fail closed: a model_index.json that is present but unreadable still marks a diffusers pipeline.
  const unreadableIndex = components === null && kinds.includes('diffusers');
  // Datasets and spaces skip the buckets and go straight to other-by-folder (assets still apply).
  const bucketsOk = repo.type === 'model' && !unreadableIndex && kinds.some((k) => k === 'transformers' || k === 'adapter' || k === 'component');
  const acc = new Map<string, { kind: GroupKind; label: string; files: SnapshotFile[]; locked: boolean }>();
  const put = (kind: GroupKind, label: string, f: SnapshotFile, locked = false): void => {
    const key = `${kind}:${label}`;
    const e = acc.get(key);
    if (e) e.files.push(f);
    else acc.set(key, { kind, label, files: [f], locked });
  };
  const gguf: SnapshotFile[] = [];
  const current = currentFiles(repo);
  for (const f of current) {
    const slash = f.relpath.indexOf('/');
    const top = slash < 0 ? '' : f.relpath.slice(0, slash);
    // 1. diffusers component folder
    if (components !== null && top !== '' && components.has(top)) { put('component', `${top}/`, f, true); continue; }
    // 2. model_index.json (only when it parsed, so an unreadable one is not presented as a component)
    if (components !== null && f.relpath === 'model_index.json') { put('component', 'model_index.json', f, true); continue; }
    // 2b. fail closed: with an unreadable index every subfolder file is locked, before the asset and GGUF rules
    if (unreadableIndex && top !== '') { put('other', `${top}/`, f, true); continue; }
    // 3. asset
    if (isAsset(f)) { put('assets', 'model card and assets', f); continue; }
    // 4. GGUF rules
    if (isGguf(f.relpath)) { gguf.push(f); continue; }
    // 5. root-file
    if (isRoot(f) && rootFileOk && ROOT_CKPT.test(f.relpath)) { put('root-file', f.relpath, f); continue; }
    if (unreadableIndex && f.relpath === 'model_index.json') { put('other', 'model_index.json', f, true); continue; }
    // 6. weights and tokenizer-config buckets
    if (bucketsOk && isWeights(f)) { put('weights', 'weights', f); continue; }
    if (bucketsOk && isTokenizerConfig(f)) { put('tokenizer-config', 'tokenizer and config', f); continue; }
    // 7. other-by-folder
    if (slash < 0) put('other', 'other files', f);
    else put('other', `${top}/`, f, unreadableIndex);
  }
  const out: Group[] = [...acc.values()].map((e) => ({ ...makeGroup(repo, e.kind, e.label, e.files), locked: e.locked }));
  const mm = gguf.filter((f) => isMmproj(f.relpath));
  const draft = gguf.filter((f) => !isMmproj(f.relpath) && isDraft(f.relpath));
  const quants = gguf.filter((f) => !isMmproj(f.relpath) && !isDraft(f.relpath));
  const quantPaths = quants.map((f) => f.relpath);
  for (const [label, fs] of bucket(quants.map((f) => [quantLabel(f.relpath, quantPaths), f]))) out.push(makeGroup(repo, 'quant', label, fs));
  // mmproj: one group per precision label; if one label covers different files, fall back to relpath labels.
  for (const [label, fs] of bucket(mm.map((f) => [mmprojLabel(f.relpath), f]))) {
    if (new Set(fs.map(identity)).size === 1) out.push(makeGroup(repo, 'mmproj', label, fs));
    else for (const f of fs) out.push(makeGroup(repo, 'mmproj', `${label} [${f.relpath.replace(/\.gguf$/i, '')}]`, [f]));
  }
  if (draft.length > 0) out.push(makeGroup(repo, 'draft', 'draft', draft));
  // superseded: non-current files whose blob no current file uses. Non-current links to a current blob are in no
  // group; deleting that blob must unlink them too.
  // Blob identity is targetOf's (64-hex RepoBlobs and 40-hex non-LFS blobs alike).
  const currentLinks = new Set(current.map((f) => f.linkPath));
  const currentBlobPaths = new Set(current.flatMap((f) => { const t = targetOf(repo, f); return t.kind === 'blob' ? [t.path] : []; }));
  // A snapshot a ref names (refs/dev of a download @dev) is never an older revision; its files that
  // no current file shares form their own group, "Files only in <ref names>". Unreadable refs (null): nothing is
  // superseded and no ref group is made.
  const byCommit = new Map<string, string[]>();
  for (const r of repo.refs ?? []) byCommit.set(r.commit, [...(byCommit.get(r.commit) ?? []), r.name]);
  const older = repo.files.filter((f) => {
    if (currentLinks.has(f.linkPath)) return false;
    const t = targetOf(repo, f);
    return t.kind !== 'blob' || !currentBlobPaths.has(t.path);
  });
  const superseded = repo.refs === null ? [] : older.filter((f) => !byCommit.has(f.commit));
  const onlyInRef = repo.refs === null ? [] : older.filter((f) => byCommit.has(f.commit));
  for (const [label, fs] of bucket(onlyInRef.map((f) => [`Files only in ${byCommit.get(f.commit)!.join(', ')}`, f]))) out.push(makeGroup(repo, 'other', label, fs));
  if (superseded.length > 0) out.push(makeGroup(repo, 'superseded', 'superseded (older revision)', superseded));
  return out;
}

function sortGroups(groups: Group[]): Group[] {
  return groups.sort((a, b) => {
    const k = GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    if (a.kind === 'quant' && a.apparentBytes !== b.apparentBytes) return a.apparentBytes - b.apparentBytes;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

export function classifyRepo(repo: Repo, readText: ReadText = defaultReadText): RepoView {
  const kinds = detectKinds(repo, readText);
  // Every repo blob once (linked, shared or orphaned; dangling counts 0), plus plain snapshot files once by dev:ino.
  // Partial downloads are counted, not sized.
  let apparentBytes = Object.values(repo.blobs).reduce((n, b) => n + (b.dangling ? 0 : b.size), 0);
  const inodes = new Set<string>();
  for (const f of repo.files) {
    if (f.blobEtag !== null || !f.facts.isFile || f.facts.isSymlink) continue;
    const id = `${f.facts.dev}:${f.facts.ino}`;
    if (inodes.has(id)) continue;
    inodes.add(id);
    apparentBytes += f.facts.size;
  }
  return {
    repoId: repo.id,
    type: repo.type,
    kinds,
    groups: sortGroups(buildGroups(repo, kinds, readText)),
    apparentBytes,
    partialDownloads: repo.incomplete.length,
  };
}
