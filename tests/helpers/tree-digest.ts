import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Digest of a tree, never following links. Key: POSIX relpath. Value: 'dir' | `link:${text}` |
 * `file:${size}:${ino}:${sha256}` | `refs:${sorted lines joined by \n}` ('*.refs' files: line order is not preserved
 * by sweep/restore). Names starting '.hfcm-canary' are skipped.
 */
export async function treeDigest(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(abs: string, rel: string): Promise<void> {
    for (const name of (await readdir(abs)).sort()) {
      if (name.startsWith('.hfcm-canary')) continue;
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(p);
      if (st.isSymbolicLink()) out[r] = `link:${await readlink(p)}`;
      else if (st.isDirectory()) {
        out[r] = 'dir';
        await walk(p, r);
      } else {
        const buf = await readFile(p);
        if (name.endsWith('.refs')) {
          const lines = buf.toString('utf8').split('\n');
          if (lines[lines.length - 1] === '') lines.pop();
          out[r] = `refs:${lines.sort().join('\n')}`;
        } else {
          out[r] = `file:${st.size}:${st.ino}:${createHash('sha256').update(buf).digest('hex')}`;
        }
      }
    }
  }
  await walk(root, '');
  return out;
}
