// Recently Deleted: the one lstat walk of a held (or about-to-be-held) repo folder, and the restore content digest
//. manifestFromPlan records the walk as HoldItem.tree, planRestore compares a fresh walk with
// it and puts restoreContentDigest into the restore plan's contentDigest, and the executor's revalidation recomputes the
// digest from the disk immediately before a restore. Read-only: ReadFs only, links are never followed.
// It imports neither the executor nor the manifest module, so both can import it (and MANIFEST_NAME).
import { join } from 'node:path';
import { factsOf, type ReadFs } from '../fsx';
import { hashCanonical } from '../plan/fingerprint';
import type { FileFacts } from '../types';

/** The per-deletion manifest's file name, `<holdRoot>/<deletionId>/manifest.json`. Defined here, not in manifest.ts,
 *  so the executor can use it too (manifest.ts imports the executor; manifest.ts re-exports it). */
export const MANIFEST_NAME = 'manifest.json';

export interface TreeEntry { rel: string; facts: FileFacts }

/**
 * Lstat walk of `dir` (links never followed): every entry below it as a POSIX rel path with its facts, names
 * sorted per directory, each directory's entries right after it. An entry that vanishes during the walk throws an
 * ENOENT-coded error; any other read failure is thrown as it is.
 */
export async function walkTree(fs: ReadFs, dir: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of (await fs.readdir(abs)).sort()) {
      const p = join(abs, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const f = await factsOf(fs, p);
      if (!f) throw Object.assign(new Error(`${p} vanished while recording the folder tree`), { code: 'ENOENT' });
      out.push({ rel: r, facts: f });
      if (f.isDirectory && !f.isSymlink) await walk(p, r);
    }
  };
  await walk(dir, '');
  return out;
}

/**
 * The restore plan's `contentDigest`: hashCanonical of `[{ heldPath, tree: walkTree(heldPath) }]` over the given
 * held repo folders, ordered by heldPath (the order passed in does not matter). planRestore sets it whenever the plan
 * has at least one `restore-rename` with role `repo-folder`, passing exactly those ops' `path`s; the executor
 * recomputes it from the same paths and refuses the plan (STALE) when it differs.
 */
export async function restoreContentDigest(fs: ReadFs, heldFolders: readonly string[]): Promise<string> {
  const walks: Array<{ heldPath: string; tree: TreeEntry[] }> = [];
  for (const heldPath of [...heldFolders].sort()) walks.push({ heldPath, tree: await walkTree(fs, heldPath) });
  return hashCanonical(walks);
}
