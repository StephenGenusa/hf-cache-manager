/** Pure GGUF file-name predicates on POSIX repo relpaths. No filesystem access. */

function baseName(relpath: string): string {
  const i = relpath.lastIndexOf('/');
  return i >= 0 ? relpath.slice(i + 1) : relpath;
}

export function isGguf(relpath: string): boolean {
  return baseName(relpath).toLowerCase().endsWith('.gguf');
}

export function isMmproj(relpath: string): boolean {
  return isGguf(relpath) && baseName(relpath).toLowerCase().includes('mmproj');
}

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})$/s;

export function shardInfo(relpath: string): { base: string; index: number; total: number } | null {
  if (!isGguf(relpath)) return null;
  const m = SHARD_RE.exec(baseName(relpath).slice(0, -5));
  if (!m) return null;
  return { base: m[1] ?? '', index: Number(m[2]), total: Number(m[3]) };
}

export function isShard(relpath: string): boolean {
  return shardInfo(relpath) !== null;
}

export function isDraft(relpath: string): boolean {
  const parts = relpath.split('/');
  if (parts.slice(0, -1).includes('MTP')) return true;
  return baseName(relpath).toLowerCase().startsWith('mtp-');
}

/** Basename minus a case-insensitive ".gguf"; otherwise the basename. */
export function ggufStem(relpath: string): string {
  const b = baseName(relpath);
  return b.toLowerCase().endsWith('.gguf') ? b.slice(0, -5) : b;
}

/** Quantization bit width from the file name; null when none is recognised. */
export function quantBits(relpath: string): number | null {
  const stem = ggufStem(relpath);
  if (/(?:^|[-._])(BF16|F16|F32)$/i.test(stem)) return 16;
  const m = /(?:^|[-._])(?:UD-|CD-)?(?:IQ|Q|TQ)(\d)/i.exec(stem);
  return m ? Number(m[1]) : null;
}

/**
 * The hfu grouping label of `relpath` among `weightRelpaths` (the repo's non-mmproj,
 * non-draft GGUF relpaths, which must include relpath). Shards of one quant share a label.
 */
export function quantLabel(relpath: string, weightRelpaths: readonly string[]): string {
  const stemOf = (p: string): string => shardInfo(p)?.base ?? ggufStem(p);
  const stems = weightRelpaths.map(stemOf);
  let lcp = stems[0] ?? '';
  for (const s of stems) {
    let i = 0;
    while (i < lcp.length && i < s.length && lcp.charCodeAt(i) === s.charCodeAt(i)) i++;
    lcp = lcp.slice(0, i);
  }
  const cut = Math.max(lcp.lastIndexOf('-'), lcp.lastIndexOf('.'));
  const prefix = cut >= 0 ? lcp.slice(0, cut + 1) : '';
  const own = stemOf(relpath);
  return own.slice(prefix.length).replace(/^[-._]+/, '') || own;
}
