import { closeSync, constants as fsConstants, openSync, readSync, statSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FileFacts } from './types';
import { normalizeLinkText } from './paths';

export interface StatLike {
  dev: number; ino: number; size: number; mtimeMs: number; nlink: number; mode: number;
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
}
export interface StatFsLike { bsize: number; blocks: number; bfree: number; bavail: number }

/** Read-only async fs surface for read-only consumers (scanner, readers, planners). Rejections carry Node-style `code`. */
export interface ReadFs {
  lstat(p: string): Promise<StatLike>;
  stat(p: string): Promise<StatLike>;
  readlink(p: string): Promise<string>;
  readdir(p: string): Promise<string[]>; // names only, unsorted
  readFile(p: string): Promise<Buffer>;
  readFile(p: string, encoding: 'utf8'): Promise<string>;
  realpath(p: string): Promise<string>;
  statfs(p: string): Promise<StatFsLike>;
}

/**
 * An open regular file (download mode). `write` writes every byte of `chunk` at the current position (the end,
 * for 'a'); `read` returns up to `length` bytes from `position`, fewer only at end of file.
 */
export interface FileHandleLike {
  stat(): Promise<StatLike>;
  read(length: number, position: number): Promise<Uint8Array>;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Minimal async fs surface used by core, including mutators. Rejections carry Node-style `code` (ENOENT, EEXIST, EXDEV, ...). */
export interface FsLike extends ReadFs {
  writeFile(p: string, data: string | Uint8Array, opts?: { flag?: 'w' | 'wx'; mode?: number }): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>; // never takes options
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  symlink(target: string, p: string, type?: 'file' | 'dir' | 'junction'): Promise<void>;
  link(existing: string, newPath: string): Promise<void>;
  /**
   * Opens `p` without following a leaf symlink (O_NOFOLLOW where the platform has it): 'r' read-only, 'wx' creates it
   * exclusively, 'a' appends to an existing file. Never truncates, never removes anything, also on failure.
   */
  open(p: string, flags: 'r' | 'wx' | 'a'): Promise<FileHandleLike>;
}

/** O_NOFOLLOW where the platform has it (not on Windows); SafeFs adds an lstat/fstat identity check everywhere. */
const NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;
const OPEN_FLAGS = {
  r: fsConstants.O_RDONLY | NOFOLLOW,
  wx: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
  a: fsConstants.O_WRONLY | fsConstants.O_APPEND | NOFOLLOW,
} as const;

async function openNoFollow(p: string, flags: 'r' | 'wx' | 'a'): Promise<FileHandleLike> {
  const fh = await fsp.open(p, OPEN_FLAGS[flags]);
  return {
    stat: () => fh.stat(),
    read: async (length, position) => {
      const buf = Buffer.alloc(length);
      let n = 0;
      while (n < length) {
        const { bytesRead } = await fh.read(buf, n, length - n, position + n);
        if (bytesRead === 0) break;
        n += bytesRead;
      }
      return buf.subarray(0, n);
    },
    write: async (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        const { bytesWritten } = await fh.write(chunk, off, chunk.length - off);
        if (bytesWritten <= 0) throw Object.assign(new Error(`EIO: short write (${p})`), { code: 'EIO' });
        off += bytesWritten;
      }
    },
    close: () => fh.close(),
  };
}

export const nodeFs: FsLike = {
  lstat: (p) => fsp.lstat(p),
  stat: (p) => fsp.stat(p),
  readlink: (p) => fsp.readlink(p),
  readdir: (p) => fsp.readdir(p),
  readFile: ((p: string, encoding?: 'utf8') => (encoding ? fsp.readFile(p, encoding) : fsp.readFile(p))) as FsLike['readFile'],
  writeFile: (p, data, opts) => fsp.writeFile(p, data, opts),
  rename: (s, d) => fsp.rename(s, d),
  unlink: (p) => fsp.unlink(p),
  rmdir: (p) => fsp.rmdir(p),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  symlink: (t, p, type) => fsp.symlink(t, p, type),
  link: (e, n) => fsp.link(e, n),
  open: (p, flags) => openNoFollow(p, flags),
  realpath: (p) => fsp.realpath(p),
  statfs: async (p) => {
    const s = await fsp.statfs(p);
    return { bsize: Number(s.bsize), blocks: Number(s.blocks), bfree: Number(s.bfree), bavail: Number(s.bavail) };
  },
};

/**
 * The one exception, see src/main/user-data.ts: ONE non-recursive mkdir (mode 0700) for the app data folder; only src/main/user-data.ts may import it (lint). Callers check the
 * parent first and re-check the result; this is not a general-purpose mutator.
 */
export const mkdirOneLevel = (p: string): Promise<void> => fsp.mkdir(p, { mode: 0o700 }).then(() => undefined);

/** The same object as nodeFs, typed read-only. Read-only modules default their fs parameter to this. */
export const readFs: ReadFs = nodeFs;

export function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function factsOf(fs: ReadFs, p: string): Promise<FileFacts | null> {
  let st: StatLike;
  try {
    st = await fs.lstat(p);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  const facts: FileFacts = {
    dev: st.dev, ino: st.ino, size: st.size, mtimeMs: Math.floor(st.mtimeMs), nlink: st.nlink,
    isSymlink: st.isSymbolicLink(), isDirectory: st.isDirectory(), isFile: st.isFile(),
  };
  if (facts.isSymlink) facts.linkTarget = normalizeLinkText(await fs.readlink(p));
  return facts;
}

/** Shape test for FileFacts read back from untrusted data (a plan, a manifest): finite numbers and booleans. */
export const isFileFacts = (x: unknown): x is FileFacts => {
  const f = x as Record<string, unknown> | null;
  return typeof f === 'object' && f !== null &&
    ['dev', 'ino', 'size', 'mtimeMs', 'nlink'].every((k) => typeof f[k] === 'number' && Number.isFinite(f[k])) &&
    ['isSymlink', 'isDirectory', 'isFile'].every((k) => typeof f[k] === 'boolean') &&
    (f.linkTarget === undefined || typeof f.linkTarget === 'string');
};

/** Revalidation rule: identity fields equal; nlink may only decrease (and stay >= 1). */
export function factsMatch(actual: FileFacts, expect: FileFacts): boolean {
  return (
    actual.dev === expect.dev && actual.ino === expect.ino && actual.size === expect.size &&
    actual.mtimeMs === expect.mtimeMs && actual.isSymlink === expect.isSymlink &&
    actual.isDirectory === expect.isDirectory && actual.isFile === expect.isFile &&
    actual.linkTarget === expect.linkTarget &&
    actual.nlink >= 1 && actual.nlink <= expect.nlink
  );
}

/**
 * Read-only synchronous text read (follows links). Only regular files are read, through an fd with a bounded read of
 * at most maxBytes+1 bytes. Returns null on any error, for non-regular files, or when the content exceeds maxBytes.
 */
export function readTextSync(absPath: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const st = statSync(absPath);
    if (!st.isFile() || st.size > maxBytes) return null;
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > maxBytes) return null;
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Read-only positional reader over one file (opened lazily, read-only). `readAt` returns up to `length` bytes from
 * `offset`; fewer only at end of file. `close` is safe to call without reading.
 */
export function fileReadAt(absPath: string): { readAt: (offset: number, length: number) => Promise<Uint8Array>; close(): Promise<void> } {
  let handle: Promise<fsp.FileHandle> | null = null;
  return {
    readAt: async (offset, length) => {
      handle ??= fsp.open(absPath, 'r');
      const fh = await handle;
      const buf = Buffer.alloc(length);
      let n = 0;
      while (n < length) {
        const { bytesRead } = await fh.read(buf, n, length - n, offset + n);
        if (bytesRead === 0) break;
        n += bytesRead;
      }
      return buf.subarray(0, n);
    },
    close: async () => {
      if (handle === null) return;
      const h = handle;
      handle = null;
      await (await h).close();
    },
  };
}
