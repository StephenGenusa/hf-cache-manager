import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { factsMatch, factsOf, nodeFs, readTextSync } from '../../src/core/fsx';
import { normalizeLinkText } from '../../src/core/paths';
import { makeTempRoot, removeTempRoot } from '../helpers/tmp';
import { useCanaries } from '../helpers/canary';

const canaries = useCanaries();

let dir = '';
let f = '';
let g = '';
let l = '';
beforeEach(async () => {
  dir = await makeTempRoot('hfcm-t-');
  canaries.onCleanup(() => removeTempRoot(dir));
  f = join(dir, 'f');
  g = join(dir, 'g');
  l = join(dir, 'l');
});

it('factsOf a regular file', async () => {
  await writeFile(f, 'hello');
  const ff = await factsOf(nodeFs, f);
  expect(ff).toMatchObject({ size: 5, nlink: 1, isFile: true, isDirectory: false, isSymlink: false });
  expect(Number.isInteger(ff!.mtimeMs)).toBe(true);
  expect(ff).not.toHaveProperty('linkTarget');
});
it('hardlinks share dev+ino and report nlink 2', async () => {
  await writeFile(f, 'hello');
  await link(f, g);
  const [a, b] = [await factsOf(nodeFs, f), await factsOf(nodeFs, g)];
  expect([a!.dev, a!.ino, a!.nlink]).toEqual([b!.dev, b!.ino, 2]);
});
it('a symlink is described by lstat, with exact relative link text', async () => {
  await symlink(join('..', '..', 'blobs', 'e'.repeat(64)), l);
  const ff = await factsOf(nodeFs, l);
  expect(ff).toMatchObject({ isSymlink: true, isFile: false, linkTarget: join('..', '..', 'blobs', 'e'.repeat(64)) });
});
it('a dangling symlink still has facts; a missing path is null', async () => {
  await writeFile(f, 'hello');
  await symlink('nowhere', l);
  expect(await factsOf(nodeFs, l)).not.toBeNull();
  expect(await factsOf(nodeFs, join(dir, 'missing'))).toBeNull();
  expect(await factsOf(nodeFs, join(f, 'under-a-file'))).toBeNull(); // ENOTDIR
});
it('factsMatch: equal facts match; nlink may drop but not rise', () => {
  const base = { dev: 1, ino: 2, size: 3, mtimeMs: 4, nlink: 2, isSymlink: false, isDirectory: false, isFile: true };
  expect(factsMatch(base, base)).toBe(true);
  expect(factsMatch({ ...base, nlink: 1 }, base)).toBe(true);
  expect(factsMatch({ ...base, nlink: 3 }, base)).toBe(false);
  expect(factsMatch({ ...base, nlink: 0 }, base)).toBe(false);
  for (const k of ['dev', 'ino', 'size', 'mtimeMs'] as const) expect(factsMatch({ ...base, [k]: 99 }, base)).toBe(false);
  expect(factsMatch({ ...base, isFile: false, isSymlink: true, linkTarget: 'x' }, base)).toBe(false);
  expect(factsMatch({ ...base, linkTarget: 'a' }, { ...base, linkTarget: 'b' })).toBe(false);
});
it('factsMatch: an isDirectory-only flip and a linkTarget defined vs absent both mismatch, in either direction', () => {
  const base = { dev: 1, ino: 2, size: 3, mtimeMs: 4, nlink: 1, isSymlink: false, isDirectory: false, isFile: true };
  expect(factsMatch({ ...base, isDirectory: true }, base)).toBe(false);
  expect(factsMatch(base, { ...base, isDirectory: true })).toBe(false);
  expect(factsMatch({ ...base, linkTarget: 'a' }, base)).toBe(false);
  expect(factsMatch(base, { ...base, linkTarget: 'a' })).toBe(false);
});
it('nodeFs.readFile supports utf8 and buffer forms; statfs reports free blocks', async () => {
  await writeFile(f, 'hello');
  expect(await nodeFs.readFile(f, 'utf8')).toBe('hello');
  expect(Buffer.isBuffer(await nodeFs.readFile(f))).toBe(true);
  const s = await nodeFs.statfs(dir);
  expect(s.bavail * s.bsize).toBeGreaterThan(0);
});
it('normalizeLinkText strips Windows long-path prefixes', () => {
  expect(normalizeLinkText('\\\\?\\C:\\a\\b')).toBe('C:\\a\\b');
  expect(normalizeLinkText('\\\\?\\UNC\\srv\\share')).toBe('\\\\srv\\share');
  expect(normalizeLinkText('../blobs/x')).toBe('../blobs/x');
});
it('readTextSync reads text, follows links, and returns null for missing, oversized or directory paths', async () => {
  await writeFile(f, 'hello');
  expect(readTextSync(f, 100)).toBe('hello');
  expect(readTextSync(f, 5)).toBe('hello');
  await symlink(f, l);
  expect(readTextSync(l, 100)).toBe('hello');
  expect(readTextSync(f, 4)).toBeNull();
  expect(readTextSync(join(dir, 'missing'), 100)).toBeNull();
  expect(readTextSync(dir, 100)).toBeNull();
});
it('readTextSync reads only regular files: a symlink to a directory is null', async () => {
  await mkdir(g);
  await symlink(g, l);
  expect(readTextSync(l, 100)).toBeNull();
});
