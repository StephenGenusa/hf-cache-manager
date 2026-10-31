// Tree helpers shared by the view drivers. Nothing here is recursive on the filesystem: removals are one
// SafeFs.unlink / rmdirEmpty at a time, and `walkTree` is read-only and never descends a symlink.
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { pySort } from '../compat/pyjson';
import { factsOf, isNotFound, readFs, type ReadFs } from '../fsx';
import { isStrictlyInside, normalizeLinkText } from '../paths';
import { viewPathProblemResolved } from './view-path';
import { SafeFsError, type SafeFs } from '../safe-fs';
import type { FileFacts } from '../types';
import { SkipEntry, type ApplyCtx } from './view-types';

/**
 * Depth-first walk in code-point order (the CLI's `sorted(rglob)`): yields directories, files and symlinks, and never
 * descends a symlink (a symlinked directory is yielded as a symlink). `skip(rel)` drops an entry and its subtree.
 * A missing root yields nothing; an entry that vanishes mid-walk is ignored.
 */
export async function* walkTree(
  fs: ReadFs, root: string, skip?: (rel: string) => boolean,
): AsyncGenerator<{ rel: string; abs: string; facts: FileFacts }> {
  async function* level(dirAbs: string, dirRel: string): AsyncGenerator<{ rel: string; abs: string; facts: FileFacts }> {
    let names: string[];
    try {
      names = await fs.readdir(dirAbs);
    } catch (e) {
      if (isNotFound(e)) return;
      throw e;
    }
    for (const name of pySort(names)) {
      const rel = dirRel === '' ? name : `${dirRel}/${name}`;
      if (skip?.(rel) === true) continue;
      const abs = join(dirAbs, name);
      const facts = await factsOf(fs, abs);
      if (facts === null) continue;
      yield { rel, abs, facts };
      if (facts.isDirectory && !facts.isSymlink) yield* level(abs, rel);
    }
  }
  yield* level(root, '');
}

/** CLI `inside_root`: realpath(dirname(abs)) is realpath(root) or strictly inside it. The leaf itself is never resolved. */
export async function insideRoot(fs: ReadFs, root: string, abs: string): Promise<boolean> {
  try {
    const real = await fs.realpath(root);
    const parent = await fs.realpath(dirname(abs));
    return parent === real || isStrictlyInside(parent, real);
  } catch {
    return false; // missing, dangling, looping or unreadable: not provably inside, so not touched
  }
}

const skipMessage = (root: string, abs: string, why: string): string => `${relative(root, abs).split(sep).join('/')}: ${why}; skipped`;

export interface ViewFs {
  unlink(p: string, expect: FileFacts): Promise<void>;
  rmdirEmpty(p: string): Promise<void>;
  symlink(target: string, p: string): Promise<void>;
  mkdirp(p: string): Promise<void>;
  /** `opts.expect`: the facts the file must still have (null = must be absent), else STALE; omitted = unconditional. */
  writeFileAtomic(p: string, data: string | Uint8Array, opts?: { expect?: FileFacts | null }): Promise<void>;
}

/**
 * SafeFs for one view root. Every mutator first applies `viewPathProblemResolved` (the lexical predicate `assertViewOps` uses, then the same on the resolved parent), so a
 * state-listed path that reaches the hub, the hold area or another root is never mutated; it throws a SkipEntry.
 */
export function viewFs(safeFs: SafeFs, root: string, fs: ReadFs = readFs): ViewFs {
  const guard = async (p: string): Promise<void> => {
    const problem = await viewPathProblemResolved(fs, p, root, safeFs.roots);
    if (problem !== null) throw new SkipEntry(skipMessage(root, p, problem));
  };
  return {
    unlink: async (p, expect) => { await guard(p); await safeFs.unlink(p, expect); },
    rmdirEmpty: async (p) => { await guard(p); await safeFs.rmdirEmpty(p); },
    symlink: async (target, p) => { await guard(p); await safeFs.symlink(target, p); },
    mkdirp: async (p) => { await guard(p); await safeFs.mkdirp(p); },
    writeFileAtomic: async (p, data, opts) => { await guard(p); await safeFs.writeFileAtomic(p, data, opts?.expect === undefined ? {} : { expect: opts.expect }); },
  };
}

/**
 * V20: makes `dirname(abs)` inside the view root. A no-op when that is the root itself (mkdirp refuses a root). Any SafeFs
 * refusal (a symlinked folder it will not traverse, a file in the way, containment) becomes a SkipEntry so the entry is
 * skipped with a warning; this deviates from the CLI, which follows symlinked folders. Run in the check phase of `create`.
 */
export async function ensureParent(ctx: ApplyCtx, root: string, abs: string): Promise<void> {
  const parent = dirname(abs);
  if (parent === root) return;
  try {
    await viewFs(ctx.safeFs, root, ctx.fs).mkdirp(parent);
  } catch (e) {
    if (e instanceof SafeFsError) throw new SkipEntry(skipMessage(root, abs, e.message));
    throw e;
  }
}

/**
 * Removes empty directories from `dirname(abs)` upward, never the root and never outside it. One non-recursive
 * rmdirEmpty per level; stops at the first directory that is not empty or cannot be removed. Never throws: an I/O error
 * other than ENOENT/ENOTEMPTY/EEXIST is reported as a warning.
 */
export async function removeEmptyParents(ctx: ApplyCtx, root: string, abs: string): Promise<void> {
  const fs = viewFs(ctx.safeFs, root, ctx.fs);
  for (let d = dirname(abs); d !== root && isStrictlyInside(d, root); d = dirname(d)) {
    try {
      await fs.rmdirEmpty(d);
    } catch (e) {
      if (e instanceof SafeFsError && e.code === 'IO' && !QUIET_ERRNO.has(e.errno ?? '')) {
        ctx.warnings.push(skipMessage(root, d, `could not remove empty folder (${e.message})`).replace('; skipped', '; left in place'));
      }
      return;
    }
  }
}

const QUIET_ERRNO: ReadonlySet<string> = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST']);

/**
 * CLI `link_into_hub`: does the link text, resolved against its folder `dirAbs`, lie inside the hub (dangling
 * counts)? Deviation (V33): only the realpath'd hub is compared; the CLI also accepts normpath(configured hub). The
 * difference can only turn a "stale" decision into "wrong"/foreign, which leaves the user's link untouched.
 */
export function linkIntoHub(dirAbs: string, rawTarget: string, hubRoot: string): boolean {
  const text = normalizeLinkText(rawTarget);
  const where = normalize(isAbsolute(text) ? text : join(dirAbs, text));
  const hub = resolve(hubRoot);
  return where.startsWith(hub.endsWith(sep) ? hub : hub + sep);
}
