import { beforeEach, expect, test } from 'vitest';
import { access, lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nodeFs } from '../../src/core/fsx';
import { ensureUserDataDir } from '../../src/main/user-data';
import { useCanaries } from '../helpers/canary';
import { makeTempRoot, removeTempRoot } from '../helpers/tmp';
import { afterEach } from 'vitest';

useCanaries();
beforeEach(() => expect.hasAssertions());
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await removeTempRoot(r); });
async function root(): Promise<string> {
  const r = await makeTempRoot('hfcm-t-');
  roots.push(r);
  return r;
}
const fs = { lstat: nodeFs.lstat, mkdir: (p: string) => nodeFs.mkdir(p) };

test('an existing real folder is fine and untouched', async () => {
  const r = await root();
  await mkdir(join(r, 'ud'));
  expect(await ensureUserDataDir(join(r, 'ud'), fs)).toBeNull();
});

test('a missing folder is created one level deep under a real parent', async () => {
  const r = await root();
  expect(await ensureUserDataDir(join(r, 'ud'), fs)).toBeNull();
  await access(join(r, 'ud'));
  expect(await readdir(r)).toEqual(['ud']);
});

test('a missing parent is refused and nothing is created (no recursive create)', async () => {
  const r = await root();
  expect(await ensureUserDataDir(join(r, 'a', 'ud'), fs)).toContain('parent');
  expect(await readdir(r)).toEqual([]);
});

test('a symlinked parent is refused', async () => {
  const r = await root();
  await mkdir(join(r, 'real'));
  await symlink(join(r, 'real'), join(r, 'link'));
  expect(await ensureUserDataDir(join(r, 'link', 'ud'), fs)).toContain('parent');
  expect(await readdir(join(r, 'real'))).toEqual([]);
});

test('a symlinked or file target is refused', async () => {
  const r = await root();
  await mkdir(join(r, 'real'));
  await symlink(join(r, 'real'), join(r, 'ud'));
  expect(await ensureUserDataDir(join(r, 'ud'), fs)).toContain('not a folder');
  await writeFile(join(r, 'f'), 'x');
  expect(await ensureUserDataDir(join(r, 'f'), fs)).toContain('not a folder');
});

test('a parent that is a file is refused', async () => {
  const r = await root();
  await writeFile(join(r, 'f'), 'x');
  expect(await ensureUserDataDir(join(r, 'f', 'ud'), fs)).toContain('parent');
});

test('a target swapped for a symlink after the mkdir is refused (re-check)', async () => {
  const r = await root();
  await mkdir(join(r, 'real'));
  const swapping = {
    lstat: nodeFs.lstat,
    mkdir: async (p: string): Promise<void> => { await symlink(join(r, 'real'), p); },
  };
  expect(await ensureUserDataDir(join(r, 'ud'), swapping)).toContain('not a folder');
});

test('an lstat error other than not-found is reported', async () => {
  const boom = { lstat: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })), mkdir: () => Promise.resolve() };
  expect(await ensureUserDataDir('/x/ud', boom as never)).toContain('denied');
});

test('a mkdir failure is reported, an EEXIST race falls to the re-check', async () => {
  const r = await root();
  const failing = { lstat: nodeFs.lstat, mkdir: () => Promise.reject(Object.assign(new Error('nope'), { code: 'EACCES' })) };
  expect(await ensureUserDataDir(join(r, 'ud'), failing)).toContain('nope');
  const race = { lstat: nodeFs.lstat, mkdir: async (p: string): Promise<void> => { await mkdir(p); throw Object.assign(new Error('exists'), { code: 'EEXIST' }); } };
  expect(await ensureUserDataDir(join(r, 'ud2'), race)).toBeNull();
});

test('the default mkdir creates the folder private (0700, umask can only remove bits)', async () => {
  const r = await root();
  expect(await ensureUserDataDir(join(r, 'ud'), { lstat: nodeFs.lstat })).toBeNull();
  const st = await lstat(join(r, 'ud'));
  expect(st.isDirectory()).toBe(true);
  expect(st.mode & 0o077).toBe(0);
  expect(st.mode & 0o700).toBe(0o700 & ~process.umask());
});
