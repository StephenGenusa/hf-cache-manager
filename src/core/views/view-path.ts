// The containment predicate for view mutations. Shared by the deletion planner and the view drivers; it imports
// nothing from plan/ so the view layer does not depend on the planner.
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { ReadFs } from '../fsx';
import { holdRootFor } from '../hold/hold-root';
import { isStrictlyInside } from '../paths';
import type { SafeRoots } from '../types';

/**
 * `p` must be a normalized absolute path strictly inside `viewRoot` (one root, or any of several) and never at or
 * inside the hub, this hub's app folder `<dirname(hub)>/.hf-cache-manager`, or `roots.holdRoot`. Lexical only.
 * Returns why not, or null.
 */
export function viewPathProblem(p: string, viewRoot: string | readonly string[], roots: SafeRoots): string | null {
  if (!isAbsolute(p) || normalize(p) !== p) return 'path is not a normalized absolute path';
  const viewRoots = typeof viewRoot === 'string' ? [viewRoot] : viewRoot;
  if (!viewRoots.some((v) => isStrictlyInside(p, v))) return 'path is not strictly inside a view root';
  const excluded = [roots.hubRoot, dirname(holdRootFor(roots.hubRoot)), ...(roots.holdRoot === null ? [] : [roots.holdRoot])];
  for (const r of excluded) {
    if (p === r || isStrictlyInside(p, r)) return `path is inside ${r}`;
  }
  return null;
}

/** realpath of the nearest existing ancestor of `dir`, with the missing segments appended. */
async function resolveDir(fs: ReadFs, dir: string): Promise<string> {
  const missing: string[] = [];
  let cur = dir;
  for (;;) {
    try {
      return join(await fs.realpath(cur), ...missing);
    } catch (e) {
      const up = dirname(cur);
      if (up === cur) throw e;
      missing.unshift(basename(cur));
      cur = up;
    }
  }
}

/**
 * The lexical check, then the same check on the resolved path: realpath of the parent directory (the leaf is never
 * resolved) joined with the basename, against the realpath of the view root. A symlinked folder inside the view root
 * therefore cannot lead to the hub, the app folder or the hold root. An unresolvable path is refused.
 */
export async function viewPathProblemResolved(
  fs: ReadFs, p: string, viewRoot: string, roots: SafeRoots,
): Promise<string | null> {
  const lexical = viewPathProblem(p, viewRoot, roots);
  if (lexical !== null) return lexical;
  try {
    const resolved = join(await resolveDir(fs, dirname(p)), basename(p));
    return viewPathProblem(resolved, await fs.realpath(viewRoot), roots);
  } catch {
    return 'path cannot be resolved';
  }
}

/** The reason both views are refused when their folders overlap (sync and deletion cleanup alike). */
export const VIEW_ROOTS_OVERLAP = 'LM Studio and Ollama folders overlap; fix config.toml';

/**
 * Do two of the configured view roots resolve to the same folder, or one inside another? Then one view's state file,
 * cleanup and rmdir-empty ops would act on the other's files, so callers refuse both views. Null roots and roots that
 * cannot be resolved (missing; callers skip or report those themselves) take no part.
 */
export async function viewRootsOverlap(fs: ReadFs, roots: ReadonlyArray<string | null>): Promise<boolean> {
  return (await overlappingRoots(fs, roots)).some(Boolean);
}

/** Pairwise form of `viewRootsOverlap` for any number of roots: per input position, does that root overlap another? */
export async function overlappingRoots(fs: ReadFs, roots: ReadonlyArray<string | null>): Promise<boolean[]> {
  const real: Array<string | null> = [];
  for (const r of roots) {
    if (r === null) {
      real.push(null);
      continue;
    }
    try {
      real.push(await fs.realpath(r));
    } catch {
      real.push(null);   // not resolvable: not a usable root
    }
  }
  return real.map((a, i) => a !== null && real.some((b, j) => i !== j && b !== null && (a === b || isStrictlyInside(a, b) || isStrictlyInside(b, a))));
}
