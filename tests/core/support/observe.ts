import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { nodeFs, type ReadFs } from '../../../src/core/fsx';
import { diffTrees as fixtureDiffTrees, type TreeEntry } from '../../helpers/fixture';

export type { TreeEntry };

/** lstat walk of `root` (the root itself excluded); never follows symlinks. Keys are absolute paths. */
export async function snapshotTree(root: string, fs: ReadFs = nodeFs): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await fs.readdir(dir)).sort()) {
      const p = join(dir, name);
      const st = await fs.lstat(p);
      const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
      const e: TreeEntry = { path: p, type, dev: st.dev, ino: st.ino, size: st.size, nlink: st.nlink };
      if (type === 'symlink') e.linkTarget = await fs.readlink(p);
      if (type === 'file') e.sha256 = createHash('sha256').update(await fs.readFile(p)).digest('hex');
      out.set(p, e);
      if (type === 'dir') await walk(p);
    }
  };
  await walk(root);
  return out;
}

export interface DiffOptions { ignoreIno?: 'dirs+links' }

/** The fixture's diffTrees; with `ignoreIno: 'dirs+links'` inode numbers of dirs and symlinks are ignored (files still compare ino). */
export function diffTrees(
  a: Map<string, TreeEntry>, b: Map<string, TreeEntry>, opts?: DiffOptions,
): { removed: string[]; added: string[]; changed: string[] } {
  if (opts?.ignoreIno !== 'dirs+links') return fixtureDiffTrees(a, b);
  const norm = (m: Map<string, TreeEntry>): Map<string, TreeEntry> =>
    new Map([...m].map(([p, e]) => [p, e.type === 'file' ? e : { ...e, ino: 0 }]));
  return fixtureDiffTrees(norm(a), norm(b));
}

const within = (p: string, under: string): boolean => p === under || p.startsWith(under.endsWith('/') ? under : under + '/');

/** Sum of sizes of regular files, each inode counted once; limited to entries at or under `under` when given. */
export function uniqueInodeBytes(t: Map<string, TreeEntry>, under?: string): number {
  const seen = new Set<string>();
  let total = 0;
  for (const [p, e] of t) {
    if (e.type !== 'file' || (under !== undefined && !within(p, under))) continue;
    const key = `${e.dev}:${e.ino}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += e.size;
  }
  return total;
}

/** Bytes released by removing `subtree`: a regular-file inode counts only when every one of its links (nlink) is inside it. */
export function bytesFreedIfRemoved(t: Map<string, TreeEntry>, subtree: string): number {
  const inside = new Map<string, { size: number; nlink: number; links: number }>();
  for (const [p, e] of t) {
    if (e.type !== 'file' || !within(p, subtree)) continue;
    const key = `${e.dev}:${e.ino}`;
    const cur = inside.get(key) ?? { size: e.size, nlink: e.nlink, links: 0 };
    cur.links += 1;
    inside.set(key, cur);
  }
  let total = 0;
  for (const v of inside.values()) if (v.links >= v.nlink) total += v.size;
  return total;
}

/** Absolute paths of symlinks under `root` whose target no longer exists. Sorted; never descends into symlinks. */
export async function danglingLinks(root: string, fs: ReadFs = nodeFs): Promise<string[]> {
  const out: string[] = [];
  for (const [p, e] of await snapshotTree(root, fs)) {
    if (e.type !== 'symlink') continue;
    try {
      await fs.stat(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') out.push(p);
      else throw err;
    }
  }
  return out.sort();
}
