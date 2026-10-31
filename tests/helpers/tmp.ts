import { mkdtemp, realpath, lstat, readdir, chmod, unlink, rmdir, utimes } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

let cachedBase: string | null = null;

export function tmpBase(): string {
  cachedBase ??= realpathSync(tmpdir());
  return cachedBase;
}

export function isUnderTmp(p: string): boolean {
  const rel = relative(tmpBase(), resolve(p));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + '/') && !isAbsolute(rel);
}

export async function makeTempRoot(prefix: 'hfcm-fx-' | 'hfcm-canary-' | 'hfcm-t-' | 'hfcm-e2e-'): Promise<string> {
  const dir = await mkdtemp(join(tmpBase(), prefix));
  return realpath(dir);
}

/** Removes `dir` and everything under it; symlinks are unlinked, never followed. */
export async function removeTree(dir: string): Promise<void> {
  if (!(await lstat(dir)).isDirectory()) throw new Error(`removeTempRoot refuses ${dir}: not a real directory`);
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) {
    const child = join(dir, name);
    const st = await lstat(child);
    if (st.isDirectory()) await removeTree(child);
    else await unlink(child); // files and symlinks (never followed)
  }
  await rmdir(dir);
}

export async function removeTempRoot(root: string): Promise<void> {
  if (dirname(root) !== tmpBase() || !basename(root).startsWith('hfcm-')) {
    throw new Error(`removeTempRoot refuses ${root}`);
  }
  let st;
  try {
    st = await lstat(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (st.isDirectory()) await removeTree(root);
  else await unlink(root);
}

export async function setMtime(p: string, mtimeMs: number): Promise<void> {
  if (!isUnderTmp(p)) throw new Error(`setMtime refuses ${p}: outside tmp`);
  await utimes(p, mtimeMs / 1000, mtimeMs / 1000);
}
