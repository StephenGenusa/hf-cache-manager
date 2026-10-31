import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { lstat, mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { useCanaries } from './canary';
import { isUnderTmp, makeTempRoot, removeTempRoot, tmpBase } from './tmp';

const canaries = useCanaries();

// Replace `target` with new bytes/link under a new inode: create under a temp name, then rename over.
async function replaceFile(target: string, content: string): Promise<void> {
  const tmp = `${target}.new`;
  await writeFile(tmp, content);
  await rename(tmp, target);
}
async function replaceLink(target: string, text: string): Promise<void> {
  const tmp = `${target}.new`;
  await symlink(text, tmp);
  await rename(tmp, target);
}

it('plants default outside canaries in a sandbox under tmp', async () => {
  expect(isUnderTmp(canaries.sandbox)).toBe(true);
  expect(basename(canaries.sandbox)).toMatch(/^hfcm-canary-/);
  const paths = canaries.records().map((r) => relative(canaries.sandbox, r.path)).sort();
  expect(paths).toEqual(['link-to-outside', 'nested/deep/outside.txt', 'outside.bin']);
  expect(await canaries.verify()).toEqual([]);
});

it('detects deletion, content change, replacement and retargeting', async () => {
  const f = await canaries.plant('a.txt', 'A');
  const g = await canaries.plant('g.txt', 'G');
  const l = join(canaries.sandbox, 'link-to-outside');
  await writeFile(f, 'B'); // same inode, new bytes
  await replaceFile(g, 'G'); // same bytes, new inode
  await replaceLink(l, 'nested');
  const v = await canaries.verify();
  expect(v).toContain(`${f}: content changed`);
  expect(v).toContain(`${g}: replaced (inode changed)`);
  expect(v).toContain(`${l}: replaced (inode changed)`);
  expect(v).toContain(`${l}: link target changed`);
  // restore so afterEach passes
  await writeFile(f, 'A');
  await canaries.protect([g]);
  await replaceLink(l, 'outside.bin');
  await canaries.protect([l]);
});

it('reports a type change', async () => {
  const p = await canaries.plant('t.txt', 'x');
  await unlink(p);
  await symlink('x', p);
  expect(await canaries.verify()).toEqual([`${p}: type changed`]);
  await unlink(p);
  await writeFile(p, 'x');
  await canaries.protect([p]);
});

it('reports a missing canary', async () => {
  const p = await canaries.plant('gone.txt', 'x');
  await unlink(p);
  expect(await canaries.verify()).toEqual([`${p}: missing`]);
  await writeFile(p, 'x');
  await canaries.protect([p]);
});

it('refuses to plant outside tmp', async () => {
  await expect(canaries.plant(join(homedir(), 'hfcm-should-not-exist'))).rejects.toThrow(/outside tmp/);
});

const cleanupOrder: number[] = [];

it('registers cleanups (they run LIFO in afterEach)', async () => {
  canaries.onCleanup(async () => void cleanupOrder.push(1));
  canaries.onCleanup(async () => void cleanupOrder.push(2));
  expect(cleanupOrder).toEqual([]);
});

it('ran the previous test cleanups LIFO', () => {
  expect(cleanupOrder).toEqual([2, 1]);
});

it('removeTempRoot refuses anything that is not an hfcm- child of tmp', async () => {
  await expect(removeTempRoot(tmpBase())).rejects.toThrow(/refuses/);
  await expect(removeTempRoot(homedir())).rejects.toThrow(/refuses/);
  await expect(removeTempRoot(join(canaries.sandbox, 'nested'))).rejects.toThrow(/refuses/);
});

it('removeTempRoot removes a tree without following symlinks out of it', async () => {
  const root = await makeTempRoot('hfcm-t-');
  await mkdir(join(root, 'd/e'), { recursive: true });
  await writeFile(join(root, 'd/e/f'), 'x');
  await symlink(canaries.sandbox, join(root, 'd/escape')); // dir symlink to the canary sandbox
  await removeTempRoot(root);
  await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  // canaries still intact: verified by afterEach
});
