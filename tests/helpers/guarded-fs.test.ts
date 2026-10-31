import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstat, symlink } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { useCanaries } from './canary';
import { GuardedFsViolation, guardedFs } from './guarded-fs';
import { tmpBase } from './tmp';

describe('guardedFs', () => {
  const canaries = useCanaries();
  const gfs = guardedFs();

  it('allows paths inside tmp', async () => {
    const p = join(canaries.sandbox, 'ok.txt');
    await gfs.writeFile(p, 'x');
    expect(await gfs.readFile(p, 'utf8')).toBe('x');
  });
  it.each([
    ['read outside', () => gfs.readFile('/etc/hostname')],
    ['write in home', () => gfs.writeFile(join(homedir(), 'hfcm-guard-test'), 'x')],
    ['tmp root itself', () => gfs.readdir(tmpBase())],
    ['.. escape', () => gfs.lstat(join(canaries.sandbox, '..', '..', 'etc'))],
    ['relative path', () => gfs.lstat('package.json')],
    ['rename dest outside', () => gfs.rename(join(canaries.sandbox, 'outside.bin'), join(homedir(), 'x'))],
    ['link newPath outside', () => gfs.link(join(canaries.sandbox, 'outside.bin'), join(homedir(), 'x'))],
  ])('refuses %s', async (_n, call) => {
    await expect(call()).rejects.toBeInstanceOf(GuardedFsViolation);
  });
  it('refuses a path that is lexically inside tmp but resolves outside through a symlinked dir', async () => {
    const esc = join(canaries.sandbox, 'esc');
    await symlink(homedir(), esc);
    await expect(gfs.writeFile(join(esc, 'hfcm-guard-test'), 'x')).rejects.toBeInstanceOf(GuardedFsViolation);
  });
  it('lets symlink() write any target text (targets are data, not paths)', async () => {
    const l = join(canaries.sandbox, 'evil-link');
    await gfs.symlink('/etc/passwd', l);
    expect(await gfs.readlink(l)).toBe('/etc/passwd');
  });

  describe('hardening', () => {
    const missing = join(homedir(), 'hfcm-guard-never-exists');
    const sb = (n: string): string => join(canaries.sandbox, n);

    it.each([
      ['rename source outside', () => gfs.rename(join(homedir(), 'x'), sb('d'))],
      ['link existing outside', () => gfs.link(join(homedir(), 'x'), sb('d'))],
      ['symlink linkPath outside', () => gfs.symlink('t', join(homedir(), 'hfcm-guard-link'))],
    ])('refuses %s', async (_n, call) => {
      await expect(call()).rejects.toBeInstanceOf(GuardedFsViolation);
    });
    it('refuses readFile through a symlinked parent dir', async () => {
      await symlink(homedir(), sb('esc'));
      await expect(gfs.readFile(join(sb('esc'), 'anything'))).rejects.toBeInstanceOf(GuardedFsViolation);
    });
    it('refuses esc/../x where esc is a symlinked dir', async () => {
      await symlink(homedir(), sb('esc'));
      await expect(gfs.writeFile(sb('esc') + '/../x', 'x')).rejects.toBeInstanceOf(GuardedFsViolation);
    });
    it('refuses rename/link destinations escaping through a symlinked dir', async () => {
      await symlink(homedir(), sb('esc'));
      const src = join(canaries.sandbox, 'outside.bin');
      await expect(gfs.rename(src, join(sb('esc'), 'hfcm-guard-r'))).rejects.toBeInstanceOf(GuardedFsViolation);
      await expect(gfs.link(src, join(sb('esc'), 'hfcm-guard-l'))).rejects.toBeInstanceOf(GuardedFsViolation);
    });
    it('refuses leaf-following ops through an in-tmp symlink that points outside', async () => {
      await symlink(missing, sb('dangling'));
      await symlink(homedir(), sb('out'));
      await expect(gfs.writeFile(sb('dangling'), 'x')).rejects.toBeInstanceOf(GuardedFsViolation);
      await expect(gfs.readFile(sb('out'))).rejects.toBeInstanceOf(GuardedFsViolation);
      await expect(gfs.readdir(sb('out'))).rejects.toBeInstanceOf(GuardedFsViolation);
      await expect(gfs.stat(sb('out'))).rejects.toBeInstanceOf(GuardedFsViolation);
      await expect(gfs.realpath(sb('out'))).rejects.toBeInstanceOf(GuardedFsViolation);
      await expect(gfs.statfs(sb('out'))).rejects.toBeInstanceOf(GuardedFsViolation);
      await expect(gfs.mkdir(sb('out'))).rejects.toBeInstanceOf(GuardedFsViolation);
      await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('allows leaf symlinks to inside tmp, and lstat/readlink/unlink of outside-pointing links', async () => {
      await symlink(join(canaries.sandbox, 'outside.bin'), sb('in'));
      expect((await gfs.readFile(sb('in'))).length).toBe(4096);
      await symlink(homedir(), sb('out'));
      expect((await gfs.lstat(sb('out'))).isSymbolicLink()).toBe(true);
      expect(await gfs.readlink(sb('out'))).toBe(homedir());
      await gfs.unlink(sb('out'));
      await expect(lstat(sb('out'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
