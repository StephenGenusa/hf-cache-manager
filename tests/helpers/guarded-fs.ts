import { dirname, isAbsolute } from 'node:path';
import { nodeFs, type FsLike } from '../../src/core/fsx';
import { isUnderTmp } from './tmp';

export class GuardedFsViolation extends Error {
  constructor(readonly path: string, readonly op: string, reason: string) {
    super(`guardedFs refused ${op}(${path}): ${reason}`);
    this.name = 'GuardedFsViolation';
  }
}

/** Nearest existing ancestor (or the path's parent when it exists), resolved through symlinks, must be under tmp. */
async function check(inner: FsLike, p: string, op: string, followLeaf = false): Promise<void> {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new GuardedFsViolation(String(p), op, 'not an absolute path');
  if (p.split('/').includes('..')) throw new GuardedFsViolation(p, op, 'contains a .. segment');
  if (!isUnderTmp(p)) throw new GuardedFsViolation(p, op, 'outside the temp dir');
  // Note: check-then-use is inherently racy (TOCTOU); acceptable for a test-only guard.
  let cur = dirname(p);
  for (;;) {
    try {
      await inner.lstat(cur);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new GuardedFsViolation(p, op, `cannot inspect ${cur}: ${code}`);
      const up = dirname(cur);
      if (up === cur) throw new GuardedFsViolation(p, op, 'no existing ancestor');
      cur = up;
    }
  }
  let real: string;
  try {
    real = await inner.realpath(cur);
  } catch {
    throw new GuardedFsViolation(p, op, `cannot resolve ancestor ${cur}`);
  }
  if (!isUnderTmp(real)) throw new GuardedFsViolation(p, op, `resolves outside the temp dir via ${cur}`);
  if (!followLeaf) return;
  // Leaf-following operations: an existing leaf symlink must resolve inside tmp; dangling ones are refused.
  let st;
  try {
    st = await inner.lstat(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw new GuardedFsViolation(p, op, `cannot inspect leaf: ${code}`);
  }
  if (!st.isSymbolicLink()) return;
  let leaf: string;
  try {
    leaf = await inner.realpath(p);
  } catch {
    throw new GuardedFsViolation(p, op, 'dangling leaf symlink');
  }
  if (!isUnderTmp(leaf)) throw new GuardedFsViolation(p, op, 'leaf symlink resolves outside the temp dir');
}

/** Wraps `inner` so every path argument must be inside the temp dir, lexically and after symlink resolution. */
export function guardedFs(inner: FsLike = nodeFs): FsLike {
  const one = <A extends unknown[], R>(op: string, fn: (p: string, ...rest: A) => Promise<R>, follow = false) =>
    async (p: string, ...rest: A): Promise<R> => {
      await check(inner, p, op, follow);
      return fn(p, ...rest);
    };
  const two = <R>(op: string, fn: (a: string, b: string) => Promise<R>) =>
    async (a: string, b: string): Promise<R> => {
      await check(inner, a, op);
      await check(inner, b, op);
      return fn(a, b);
    };
  const readFile = async (p: string, encoding?: 'utf8'): Promise<Buffer | string> => {
    await check(inner, p, 'readFile', true);
    return encoding ? inner.readFile(p, encoding) : inner.readFile(p);
  };
  return {
    lstat: one('lstat', (p) => inner.lstat(p)),
    stat: one('stat', (p) => inner.stat(p), true),
    readlink: one('readlink', (p) => inner.readlink(p)),
    readdir: one('readdir', (p) => inner.readdir(p), true),
    readFile: readFile as FsLike['readFile'],
    writeFile: one('writeFile', (p, data: string | Uint8Array, opts?: { flag?: 'w' | 'wx'; mode?: number }) =>
      inner.writeFile(p, data, opts), true),
    rename: two('rename', (a, b) => inner.rename(a, b)),
    unlink: one('unlink', (p) => inner.unlink(p)),
    rmdir: one('rmdir', (p) => inner.rmdir(p)),
    mkdir: one('mkdir', (p, opts?: { recursive?: boolean }) => inner.mkdir(p, opts), true),
    // The target text is data, not a path: only the link path is checked.
    symlink: async (target, p, type) => {
      await check(inner, p, 'symlink');
      return inner.symlink(target, p, type);
    },
    link: two('link', (a, b) => inner.link(a, b)),
    open: one('open', (p, flags: 'r' | 'wx' | 'a') => inner.open(p, flags), true),
    realpath: one('realpath', (p) => inner.realpath(p), true),
    statfs: one('statfs', (p) => inner.statfs(p), true),
  };
}
