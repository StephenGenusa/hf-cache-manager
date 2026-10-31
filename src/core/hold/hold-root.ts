import { dirname, join } from 'node:path';
import { isNotFound, readFs, type ReadFs, type StatLike } from '../fsx';

/** The canonical Recently Deleted root for a hub: `<dirname(hub)>/.hf-cache-manager/recently-deleted`. */
export function holdRootFor(hubRoot: string): string {
  return join(dirname(hubRoot), '.hf-cache-manager', 'recently-deleted');
}

export type HoldAvailability = { ok: true; holdRoot: string } | { ok: false; reason: string };

/**
 * Whether hold mode can be offered for `hubRoot`. Read-only: it never creates the hold root.
 * 1. The hub must be a real directory (lstat).
 * 2. `recently-deleted`, then `.hf-cache-manager`: when present, each must be a real directory, never a symlink.
 * 3. The nearest existing of `recently-deleted`, `.hf-cache-manager` and `dirname(hub)` must share the hub's `dev`, so
 *    a hold is a same-device rename (SafeFs.rename never copies; EXDEV would fail the hold).
 * Any unexpected lstat error makes hold unavailable (fails closed); permanent deletion is unaffected.
 */
export async function holdAvailability(hubRoot: string, fs: ReadFs = readFs): Promise<HoldAvailability> {
  const holdRoot = holdRootFor(hubRoot);
  const mgr = dirname(holdRoot);
  const no = (reason: string): HoldAvailability => ({ ok: false, reason });
  const lstatOrNull = async (p: string): Promise<StatLike | null> => {
    try {
      return await fs.lstat(p);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  };
  try {
    const hub = await lstatOrNull(hubRoot);
    if (hub === null) return no('Hub folder not found');
    if (hub.isSymbolicLink()) return no('Hub folder is not a real directory');
    if (!hub.isDirectory()) return no('Hub folder not found');

    const found: StatLike[] = [];
    for (const p of [holdRoot, mgr]) {
      const st = await lstatOrNull(p);
      if (st === null) continue;
      if (st.isSymbolicLink()) return no('Recently Deleted folder is a symlink; refusing to use it');
      if (!st.isDirectory()) return no('Recently Deleted folder is not a directory');
      found.push(st);
    }
    const nearest = found[0] ?? (await lstatOrNull(dirname(hubRoot)));
    if (nearest === null) return no('Hub folder not found');
    if (nearest.dev !== hub.dev) return no('Recently Deleted is on a different drive');
    return { ok: true, holdRoot };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    return no(`Could not check the Recently Deleted folder: ${typeof code === 'string' ? code : String(e)}`);
  }
}
