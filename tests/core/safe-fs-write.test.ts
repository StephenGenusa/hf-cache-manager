import { lstat, mkdir, readdir, readFile, readlink, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factsOf } from '../../src/core/fsx';
import { SafeFs, SafeFsError } from '../../src/core/safe-fs';
import { useCanaries } from '../helpers/canary';
import { failingFs, recordingFs, scriptedFs } from '../helpers/failing-fs';
import { buildFixture, type Fixture } from '../helpers/fixture';

useCanaries();
const one = { holdRoot: true, repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'x.gguf', blob: 'x' }] }] }] };
const expectCode = (code: string) => expect.objectContaining({ name: 'SafeFsError', code });
const tmpLeftovers = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((n) => n.endsWith('.tmp'));

describe('rename', () => {
  it('moves a repo blob into the hold root, same inode', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const src = fx.repo('o/a').blobOf('x.gguf'); const facts = (await factsOf(fx.fs, src))!;
    const dest = join(fx.holdRoot, 'd1', 'models--o--a', 'blobs', basename(src));
    await sfs.mkdirp(dirname(dest));
    await sfs.rename(src, dest, facts);
    await expect(lstat(src)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(dest)).ino).toBe(facts.ino);
  });
  it('moves a whole repo folder as one op', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const dir = fx.repo('o/a').folder; await sfs.mkdirp(join(fx.holdRoot, 'd2'));
    await sfs.rename(dir, join(fx.holdRoot, 'd2', 'models--o--a'), (await factsOf(fx.fs, dir))!);
    expect((await lstat(join(fx.holdRoot, 'd2', 'models--o--a', 'refs', 'main'))).isFile()).toBe(true);
  });
  it('refuses an existing dest and leaves both untouched', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const src = fx.repo('o/a').blobOf('x.gguf'); const dest = join(fx.holdRoot, 'occupied');
    await writeFile(dest, 'other');
    await expect(sfs.rename(src, dest, (await factsOf(fx.fs, src))!)).rejects.toEqual(expectCode('EXISTS'));
    expect(await readFile(dest, 'utf8')).toBe('other');
    expect(await readFile(src)).toEqual(fx.content('x'));
  });
  it('refuses a dest that is a dangling symlink (lstat, not stat)', async () => {
    const fx = await buildFixture(one); const src = fx.repo('o/a').blobOf('x.gguf');
    const dest = join(fx.holdRoot, 'dangling'); await symlink(join(fx.holdRoot, 'nowhere'), dest);
    await expect(new SafeFs(fx.roots, fx.fs).rename(src, dest, (await factsOf(fx.fs, src))!)).rejects.toEqual(expectCode('EXISTS'));
    expect(await readlink(dest)).toBe(join(fx.holdRoot, 'nowhere'));
    expect(await readFile(src)).toEqual(fx.content('x'));
  });
  it.each([
    ['dest outside every root', (fx: Fixture) => fx.outside('stolen')],
    ['dest is the hold root itself', (fx: Fixture) => fx.holdRoot],
    ['dest inside src', (fx: Fixture) => join(fx.repo('o/a').folder, 'blobs', 'inner')],
    ['dest is the hub root itself', (fx: Fixture) => fx.hubRoot],
  ])('CONTAINMENT: %s', async (_n, destOf) => {
    const fx = await buildFixture(one); const src = fx.repo('o/a').folder;
    await expect(new SafeFs(fx.roots, fx.fs).rename(src, destOf(fx), (await factsOf(fx.fs, src))!))
      .rejects.toEqual(expectCode('CONTAINMENT'));
    expect((await lstat(src)).isDirectory()).toBe(true);
  });
  it('CONTAINMENT: dest reaches inside src through a symlinked parent', async () => {
    const fx = await buildFixture(one); const src = fx.repo('o/a').folder;
    await symlink(join(src, 'blobs'), join(fx.hubRoot, 'via'));
    await expect(new SafeFs(fx.roots, fx.fs).rename(src, join(fx.hubRoot, 'via', 'inner'), (await factsOf(fx.fs, src))!))
      .rejects.toEqual(expectCode('CONTAINMENT'));
    expect((await lstat(src)).isDirectory()).toBe(true);
  });
  it('CONTAINMENT: src outside every root', async () => {
    const fx = await buildFixture({ ...one, outside: { f: 'keep' } });
    const src = fx.outside('f');
    await expect(new SafeFs(fx.roots, fx.fs).rename(src, join(fx.holdRoot, 'f'), (await factsOf(fx.fs, src))!))
      .rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await readFile(src, 'utf8')).toBe('keep');
  });
  it('EXDEV is an IO error and nothing is copied (never falls back)', async () => {
    const fx = await buildFixture(one);
    const calls: string[] = [];
    const fake = recordingFs(failingFs(fx.fs, 'rename', 'EXDEV'), calls);
    const src = fx.repo('o/a').blobOf('x.gguf');
    await expect(new SafeFs(fx.roots, fake).rename(src, join(fx.holdRoot, 'b'), (await factsOf(fx.fs, src))!))
      .rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EXDEV' }));
    expect(calls).toContain('rename');
    expect(calls.filter((c) => ['writeFile', 'link', 'symlink', 'unlink', 'mkdir', 'readFile'].includes(c))).toEqual([]);
    expect(await readFile(src)).toEqual(fx.content('x'));
    await expect(lstat(join(fx.holdRoot, 'b'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('STALE when src changed since review', async () => {
    const fx = await buildFixture(one); const src = fx.repo('o/a').file('x.gguf');
    const f = (await factsOf(fx.fs, src))!; await unlink(src); await symlink('../../blobs/zzz', src);
    await expect(new SafeFs(fx.roots, fx.fs).rename(src, join(fx.holdRoot, 'l'), f)).rejects.toEqual(expectCode('STALE'));
    expect(await readlink(src)).toBe('../../blobs/zzz');
  });
  it('STALE when src is missing', async () => {
    const fx = await buildFixture(one); const src = fx.repo('o/a').file('x.gguf');
    const f = (await factsOf(fx.fs, src))!; await unlink(src);
    await expect(new SafeFs(fx.roots, fx.fs).rename(src, join(fx.holdRoot, 'l'), f)).rejects.toEqual(expectCode('STALE'));
  });
  it('a missing dest parent is IO with errno ENOENT, not CONTAINMENT; src untouched', async () => {
    const fx = await buildFixture(one); const src = fx.repo('o/a').blobOf('x.gguf');
    await expect(new SafeFs(fx.roots, fx.fs).rename(src, join(fx.holdRoot, 'no', 'such', 'b'), (await factsOf(fx.fs, src))!))
      .rejects.toEqual(expect.objectContaining({ name: 'SafeFsError', code: 'IO', errno: 'ENOENT' }));
    expect(await readFile(src)).toEqual(fx.content('x'));
  });
  it('errors carry the caller path and the resolved path (in-root symlinked parent: they differ)', async () => {
    const fx = await buildFixture(one); const real = fx.repo('o/a').file('x.gguf');
    await symlink(fx.repo('o/a').snapshotDir(), join(fx.hubRoot, 'via'));
    const src = join(fx.hubRoot, 'via', 'x.gguf');
    const f = (await factsOf(fx.fs, real))!; await unlink(real);
    await expect(new SafeFs(fx.roots, fx.fs).rename(src, join(fx.holdRoot, 'l'), f))
      .rejects.toEqual(expect.objectContaining({ code: 'STALE', path: src, resolved: real }));
    expect(src).not.toBe(real);
  });
});

/** <root>/nest/models is a view root that contains the hub root <root>/nest/models/hf/hub. */
async function nested(hubExists: boolean): Promise<{ fx: Fixture; sfs: SafeFs; models: string; hf: string; hub: string }> {
  const fx = await buildFixture({});
  const models = join(fx.root, 'nest', 'models'); const hf = join(models, 'hf'); const hub = join(hf, 'hub');
  await mkdir(hubExists ? hub : hf, { recursive: true });
  return { fx, sfs: new SafeFs({ hubRoot: hub, viewRoots: [models], holdRoot: null }, fx.fs), models, hf, hub };
}

describe('never acts on an ancestor of another root (nested roots)', () => {
  it('rename refuses a src that contains another root; the hub stays put', async () => {
    const { fx, sfs, models, hf, hub } = await nested(true);
    await expect(sfs.rename(hf, join(models, 'moved'), (await factsOf(fx.fs, hf))!)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect((await lstat(hub)).isDirectory()).toBe(true);
    await expect(lstat(join(models, 'moved'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rename refuses a dest that is an ancestor of a missing root (would create it)', async () => {
    const { fx, models } = await nested(false);
    const sfs = new SafeFs({ hubRoot: join(models, 'gone', 'hub'), viewRoots: [models], holdRoot: null }, fx.fs);
    const src = join(models, 'fresh'); await mkdir(join(src, 'hub'), { recursive: true });
    await expect(sfs.rename(src, join(models, 'gone'), (await factsOf(fx.fs, src))!)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(join(models, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(join(src, 'hub'))).isDirectory()).toBe(true);
  });
  it('rmdirEmpty refuses an empty ancestor of a missing root', async () => {
    const { sfs, hf } = await nested(false);
    await expect(sfs.rmdirEmpty(hf)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect((await lstat(hf)).isDirectory()).toBe(true);
  });
  it('mkdirp, symlink and writeFileAtomic refuse an ancestor of a missing root', async () => {
    const { fx, models } = await nested(false);
    const sfs = new SafeFs({ hubRoot: join(models, 'gone', 'hub'), viewRoots: [models], holdRoot: null }, fx.fs);
    const anc = join(models, 'gone');
    await expect(sfs.mkdirp(anc)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.symlink('x', anc)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.writeFileAtomic(anc, 'x')).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(anc)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('symlink', () => {
  it('creates a link with the exact relative text; refuses existing and outside', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const p = join(fx.repo('o/a').snapshotDir(), 'y.gguf');
    const text = join('..', '..', 'blobs', fx.repo('o/a').etagOf('x.gguf'));
    await sfs.symlink(text, p);
    expect(await readlink(p)).toBe(text);
    await expect(sfs.symlink(text, p)).rejects.toEqual(expectCode('EXISTS'));
    await expect(sfs.symlink(text, fx.outside('l'))).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(fx.outside('l'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses an existing dangling symlink and maps fs failures to IO with errno', async () => {
    const fx = await buildFixture(one); const p = join(fx.repo('o/a').snapshotDir(), 'z');
    await symlink('nowhere', p);
    await expect(new SafeFs(fx.roots, fx.fs).symlink('else', p)).rejects.toEqual(expectCode('EXISTS'));
    expect(await readlink(p)).toBe('nowhere');
    const q = join(fx.repo('o/a').snapshotDir(), 'q');
    await expect(new SafeFs(fx.roots, failingFs(fx.fs, 'symlink', 'EPERM')).symlink('x', q))
      .rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EPERM', path: q }));
  });
});

describe('writeFileAtomic', () => {
  it('creates and replaces a file, leaving no tmp file', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: {} } }); const sfs = new SafeFs(fx.roots, fx.fs);
    const p = fx.viewPath('lmstudio', '.hfhub-state.json');
    await sfs.writeFileAtomic(p, '{\n "version": 1\n}');
    expect(await readFile(p, 'utf8')).toBe('{\n "version": 1\n}');
    await sfs.writeFileAtomic(p, 'v2');
    expect(await readFile(p, 'utf8')).toBe('v2');
    expect(await tmpLeftovers(fx.viewRoots.lmstudio!)).toEqual([]);
  });
  it('refuses to write through a symlink or onto a directory', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: {} }, outside: { 'target.json': 'keep' } });
    const p = fx.viewPath('lmstudio', '.hfhub-state.json'); await symlink(fx.outside('target.json'), p);
    const sfs = new SafeFs(fx.roots, fx.fs);
    await expect(sfs.writeFileAtomic(p, 'x')).rejects.toEqual(expectCode('EXISTS'));
    await expect(sfs.writeFileAtomic(fx.repo('o/a').snapshotDir(), 'x')).rejects.toEqual(expectCode('EXISTS'));
    expect(await readFile(fx.outside('target.json'), 'utf8')).toBe('keep');
    expect(await readlink(p)).toBe(fx.outside('target.json'));
    expect(await tmpLeftovers(fx.viewRoots.lmstudio!)).toEqual([]);
  });
  it('refuses a path outside every root', async () => {
    const fx = await buildFixture({ ...one, outside: { 'f.json': 'keep' } });
    await expect(new SafeFs(fx.roots, fx.fs).writeFileAtomic(fx.outside('f.json'), 'x')).rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await readFile(fx.outside('f.json'), 'utf8')).toBe('keep');
  });
  it('on rename failure the original is unchanged and the tmp file is removed', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: { files: { 's.json': 'old' } } } });
    const p = fx.viewPath('lmstudio', 's.json');
    await expect(new SafeFs(fx.roots, failingFs(fx.fs, 'rename', 'EIO')).writeFileAtomic(p, 'new'))
      .rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EIO', path: p }));
    expect(await readFile(p, 'utf8')).toBe('old');
    expect(await tmpLeftovers(fx.viewRoots.lmstudio!)).toEqual([]);
  });
  it('on tmp write failure nothing is left behind and the original is unchanged', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: { files: { 's.json': 'old' } } } });
    const p = fx.viewPath('lmstudio', 's.json');
    await expect(new SafeFs(fx.roots, failingFs(fx.fs, 'writeFile', 'ENOSPC')).writeFileAtomic(p, 'new'))
      .rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'ENOSPC' }));
    expect(await readFile(p, 'utf8')).toBe('old');
    expect(await tmpLeftovers(fx.viewRoots.lmstudio!)).toEqual([]);
  });
  it('opts.tmpPath names the temp file; no tmp left behind', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: {} } }); const sfs = new SafeFs(fx.roots, fx.fs);
    const p = fx.viewPath('lmstudio', 'state.json'); const tmp = fx.viewPath('lmstudio', 'state.json.mine.tmp');
    const seen: string[] = [];
    const spy = { ...fx.fs, writeFile: (f: string, d: string | Uint8Array, o?: { flag?: 'w' | 'wx'; mode?: number }) => {
      seen.push(f); return fx.fs.writeFile(f, d, o);
    } };
    await new SafeFs(fx.roots, spy).writeFileAtomic(p, 'one', { tmpPath: tmp });
    expect(seen).toEqual([tmp]);
    expect(await readFile(p, 'utf8')).toBe('one');
    await expect(lstat(tmp)).rejects.toMatchObject({ code: 'ENOENT' });
    await sfs.writeFileAtomic(p, 'two', { tmpPath: tmp });
    expect(await readFile(p, 'utf8')).toBe('two');
  });
  it('opts.tmpPath must be contained and in the same directory as p', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: { dirs: ['sub'] } }, outside: { 't.tmp': 'keep' } });
    const sfs = new SafeFs(fx.roots, fx.fs); const p = fx.viewPath('lmstudio', 'state.json');
    await expect(sfs.writeFileAtomic(p, 'x', { tmpPath: fx.outside('t.tmp') })).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.writeFileAtomic(p, 'x', { tmpPath: fx.viewPath('lmstudio', 'sub/t.tmp') })).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.writeFileAtomic(p, 'x', { tmpPath: p })).rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await readFile(fx.outside('t.tmp'), 'utf8')).toBe('keep');
    await expect(lstat(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('an existing tmpPath is refused (exclusive write) and left untouched', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: { files: { 'busy.tmp': 'theirs' } } } });
    const p = fx.viewPath('lmstudio', 'state.json'); const tmp = fx.viewPath('lmstudio', 'busy.tmp');
    await expect(new SafeFs(fx.roots, fx.fs).writeFileAtomic(p, 'x', { tmpPath: tmp })).rejects.toEqual(expectCode('EXISTS'));
    expect(await readFile(tmp, 'utf8')).toBe('theirs');
    await expect(lstat(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.skipIf(process.platform === 'win32')('opts.mode applies to the exclusive temp write and survives the rename', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: {} } });
    const p = fx.viewPath('lmstudio', 'secret.json');
    await new SafeFs(fx.roots, fx.fs).writeFileAtomic(p, 'x', { mode: 0o600 });
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    const q = fx.viewPath('lmstudio', 'other.json');
    await new SafeFs(fx.roots, fx.fs).writeFileAtomic(q, 'x', { mode: 0o640 });
    expect((await stat(q)).mode & 0o777).toBe(0o640 & ~process.umask());
  });
  it('a symlink swapped in at p after the check is replaced, not written through', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: {} }, outside: { 'victim.json': 'keep' } });
    const p = fx.viewPath('lmstudio', 's.json');
    const racing = { ...fx.fs, writeFile: async (f: string, d: string | Uint8Array, o?: { flag?: 'w' | 'wx'; mode?: number }) => {
      await fx.fs.writeFile(f, d, o); await symlink(fx.outside('victim.json'), p);
    } };
    await new SafeFs(fx.roots, racing).writeFileAtomic(p, 'mine');
    expect((await lstat(p)).isFile()).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('mine');
    expect(await readFile(fx.outside('victim.json'), 'utf8')).toBe('keep');
  });
});

describe('mkdirp', () => {
  it('creates nested dirs under the hold root; existing dir is a no-op; file in the way is EXISTS', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const d = join(fx.holdRoot, 'id', 'models--o--a', 'blobs');
    await sfs.mkdirp(d); await sfs.mkdirp(d);
    expect((await lstat(d)).isDirectory()).toBe(true);
    await writeFile(join(fx.holdRoot, 'f'), 'x');
    await expect(sfs.mkdirp(join(fx.holdRoot, 'f', 'g'))).rejects.toEqual(expectCode('EXISTS'));
    await expect(sfs.mkdirp(join(fx.holdRoot, 'f'))).rejects.toEqual(expectCode('EXISTS'));
  });
  it('refuses through a symlinked ancestor that leads outside; nothing is created outside', async () => {
    const fx = await buildFixture({ ...one, outside: { 'o/keep': 'k' } });
    await symlink(fx.outside('o'), join(fx.holdRoot, 'esc'));
    await expect(new SafeFs(fx.roots, fx.fs).mkdirp(join(fx.holdRoot, 'esc', 'new'))).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(new SafeFs(fx.roots, fx.fs).mkdirp(join(fx.holdRoot, 'esc'))).rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await readdir(fx.outside('o'))).toEqual(['keep']);
  });
  it('never creates a missing view root, even as an intermediate', async () => {
    const fx = await buildFixture({ views: { lmstudio: { exists: false } } });
    const roots = { ...fx.roots, viewRoots: [fx.viewRoots.lmstudio!] };
    await expect(new SafeFs(roots, fx.fs).mkdirp(join(fx.viewRoots.lmstudio!, 'o', 'm'))).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(new SafeFs(roots, fx.fs).mkdirp(fx.viewRoots.lmstudio!)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(fx.viewRoots.lmstudio!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['the hub root', (fx: Fixture) => fx.hubRoot],
    ['outside every root', (fx: Fixture) => fx.outside('newdir')],
    ['a dot-dot path', (fx: Fixture) => `${fx.holdRoot}/../../outside/x`],
    ['a relative path', () => 'rel/dir'],
  ])('CONTAINMENT: %s', async (_n, pOf) => {
    const fx = await buildFixture(one);
    await expect(new SafeFs(fx.roots, fx.fs).mkdirp(pOf(fx))).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(fx.outside('newdir'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('creates the canonical hold root (and .hf-cache-manager) but no other root', async () => {
    const fx = await buildFixture({});                        // holdRoot not created
    const sfs = new SafeFs({ ...fx.roots, holdRoot: fx.holdRoot }, fx.fs);
    await sfs.mkdirp(join(fx.holdRoot, 'id'));
    expect((await lstat(join(fx.holdRoot, 'id'))).isDirectory()).toBe(true);
    const odd = join(fx.root, 'hf', 'elsewhere');
    await expect(new SafeFs({ ...fx.roots, holdRoot: odd }, fx.fs).mkdirp(odd)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(new SafeFs({ ...fx.roots, holdRoot: odd }, fx.fs).mkdirp(join(odd, 'id'))).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(odd)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('creates the canonical hold root itself when asked for it exactly', async () => {
    const fx = await buildFixture({});
    await new SafeFs({ ...fx.roots, holdRoot: fx.holdRoot }, fx.fs).mkdirp(fx.holdRoot);
    expect((await lstat(fx.holdRoot)).isDirectory()).toBe(true);
  });
  it('accepts an existing real .hf-cache-manager directory (AppLock made it first)', async () => {
    const fx = await buildFixture({});
    await mkdir(dirname(fx.holdRoot));
    await new SafeFs({ ...fx.roots, holdRoot: fx.holdRoot }, fx.fs).mkdirp(join(fx.holdRoot, 'id'));
    expect((await lstat(join(fx.holdRoot, 'id'))).isDirectory()).toBe(true);
  });
  it('refuses when .hf-cache-manager is a symlink', async () => {
    const fx = await buildFixture({ outside: { 'hcm/x': 'x' } });
    await symlink(fx.outside('hcm'), join(fx.root, 'hf', '.hf-cache-manager'));
    await expect(new SafeFs({ ...fx.roots, holdRoot: fx.holdRoot }, fx.fs).mkdirp(fx.holdRoot))
      .rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(new SafeFs({ ...fx.roots, holdRoot: fx.holdRoot }, fx.fs).mkdirp(join(fx.holdRoot, 'id')))
      .rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await readdir(fx.outside('hcm'))).toEqual(['x']);
  });
  it('refuses when the hold root itself is a symlink leading outside', async () => {
    const fx = await buildFixture({ outside: { 'hold/x': 'x' } });
    await mkdir(dirname(fx.holdRoot));
    await symlink(fx.outside('hold'), fx.holdRoot);
    await expect(new SafeFs({ ...fx.roots, holdRoot: fx.holdRoot }, fx.fs).mkdirp(join(fx.holdRoot, 'id')))
      .rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(new SafeFs({ ...fx.roots, holdRoot: fx.holdRoot }, fx.fs).mkdirp(fx.holdRoot))
      .rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await readdir(fx.outside('hold'))).toEqual(['x']);
  });
  it('maps a mkdir failure to IO with errno', async () => {
    const fx = await buildFixture(one);
    const d = join(fx.holdRoot, 'nope');
    await expect(new SafeFs(fx.roots, failingFs(fx.fs, 'mkdir', 'EACCES')).mkdirp(d))
      .rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EACCES', path: d }));
  });
  it('EXISTS when p itself is a symlink to an in-root directory (never accepted as a directory)', async () => {
    const fx = await buildFixture(one);
    await mkdir(join(fx.holdRoot, 'real'));
    const p = join(fx.holdRoot, 'alias'); await symlink(join(fx.holdRoot, 'real'), p);
    await expect(new SafeFs(fx.roots, fx.fs).mkdirp(p)).rejects.toEqual(expect.objectContaining({ name: 'SafeFsError', code: 'EXISTS', path: p }));
    expect(await readlink(p)).toBe(join(fx.holdRoot, 'real'));
  });
  it('EXISTS when an existing intermediate component is a symlink to an in-root directory; nothing is created', async () => {
    const fx = await buildFixture(one);
    await mkdir(join(fx.holdRoot, 'real', 'deeper'), { recursive: true });
    await symlink(join(fx.holdRoot, 'real'), join(fx.holdRoot, 'alias'));
    const sfs = new SafeFs(fx.roots, fx.fs);
    for (const p of [join(fx.holdRoot, 'alias', 'new', 'leaf'), join(fx.holdRoot, 'alias', 'deeper', 'new'), join(fx.holdRoot, 'alias', 'deeper')]) {
      await expect(sfs.mkdirp(p)).rejects.toEqual(expect.objectContaining({ name: 'SafeFsError', code: 'EXISTS', path: p }));
    }
    expect((await readdir(join(fx.holdRoot, 'real'))).sort()).toEqual(['deeper']);
    expect(await readdir(join(fx.holdRoot, 'real', 'deeper'))).toEqual([]);
  });
  it('tolerates a segment created concurrently as a directory (EEXIST)', async () => {
    const fx = await buildFixture(one); const d = join(fx.holdRoot, 'race', 'leaf');
    const racing = { ...fx.fs, mkdir: async (p: string, o?: { recursive?: boolean }) => {
      await fx.fs.mkdir(p, o); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    } };
    await new SafeFs(fx.roots, racing).mkdirp(d);
    expect((await lstat(d)).isDirectory()).toBe(true);
  });
});

describe('mkdirp options', () => {
  it('created: receives exactly the directories this call made, outermost first, including the hold root', async () => {
    const fx = await buildFixture({});                        // holdRoot not created
    const sfs = new SafeFs({ ...fx.roots, holdRoot: fx.holdRoot }, fx.fs);
    const created: string[] = [];
    await sfs.mkdirp(join(fx.holdRoot, 'id', 'a'), { created });
    expect(created).toEqual([dirname(fx.holdRoot), fx.holdRoot, join(fx.holdRoot, 'id'), join(fx.holdRoot, 'id', 'a')]);
    const again: string[] = [];
    await sfs.mkdirp(join(fx.holdRoot, 'id', 'a', 'b'), { created: again });
    expect(again).toEqual([join(fx.holdRoot, 'id', 'a', 'b')]);
  });
  it('created: on a failure part-way, lists what was made before it', async () => {
    const fx = await buildFixture(one);
    const sfs = new SafeFs(fx.roots, failingFs(fx.fs, 'mkdir', 'EACCES', (p) => p.endsWith(`${'/'}b`)));
    const created: string[] = [];
    await expect(sfs.mkdirp(join(fx.holdRoot, 'a', 'b', 'c'), { created })).rejects.toEqual(expectCode('IO'));
    expect(created).toEqual([join(fx.holdRoot, 'a')]);
  });
  it('exclusive: creates <holdRoot>/<id> (and missing ancestors), refuses an existing one without touching it', async () => {
    const fx = await buildFixture({});
    const sfs = new SafeFs({ ...fx.roots, holdRoot: fx.holdRoot }, fx.fs);
    const dir = join(fx.holdRoot, 'id');
    const created: string[] = [];
    await sfs.mkdirp(dir, { exclusive: true, created });
    expect(created).toEqual([dirname(fx.holdRoot), fx.holdRoot, dir]);
    await writeFile(join(dir, 'manifest.json'), '{}');
    const none: string[] = [];
    await expect(sfs.mkdirp(dir, { exclusive: true, created: none })).rejects.toEqual(expectCode('EXISTS'));
    expect(none).toEqual([]);
    expect(await readdir(dir)).toEqual(['manifest.json']);
  });
  it('exclusive: EEXIST from mkdir of the final segment (a race) is EXISTS, not a merge', async () => {
    const fx = await buildFixture(one);
    const dir = join(fx.holdRoot, 'raced');
    const racy = { ...fx.fs, mkdir: async (p: string) => { await fx.fs.mkdir(p); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); } };
    const created: string[] = [];
    await expect(new SafeFs(fx.roots, racy as typeof fx.fs).mkdirp(dir, { exclusive: true, created })).rejects.toEqual(expectCode('EXISTS'));
    expect(created).toEqual([]);
  });
  it('exclusive: only for a direct child of the hold root', async () => {
    const fx = await buildFixture(one);
    const sfs = new SafeFs(fx.roots, fx.fs);
    await expect(sfs.mkdirp(join(fx.holdRoot, 'a', 'b'), { exclusive: true })).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.mkdirp(join(fx.repo('o/a').folder, 'x'), { exclusive: true })).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(join(fx.holdRoot, 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('exclusive gate and writeFileAtomic expect', () => {
  it('exclusive mkdirp is refused under a hold root that is not the canonical one, even when it exists', async () => {
    const fx = await buildFixture(one);
    const odd = join(fx.root, 'hf', 'elsewhere');
    await mkdir(odd);
    const sfs = new SafeFs({ ...fx.roots, holdRoot: odd }, fx.fs);
    await expect(sfs.mkdirp(join(odd, 'id'), { exclusive: true })).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(join(odd, 'id'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('writeFileAtomic expect: a file whose facts changed is not replaced (STALE, no temp left); null requires absence', async () => {
    const fx = await buildFixture(one);
    const sfs = new SafeFs(fx.roots, fx.fs);
    const p = join(fx.holdRoot, 'state.txt');
    await writeFile(p, 'one');
    const facts = (await factsOf(fx.fs, p))!;
    await unlink(p);
    await writeFile(p, 'two, longer'); // replaced (the inode number may be reused; the size differs)
    await expect(sfs.writeFileAtomic(p, 'mine', { expect: facts })).rejects.toEqual(expectCode('STALE'));
    expect(await readFile(p, 'utf8')).toBe('two, longer');
    await expect(sfs.writeFileAtomic(p, 'mine', { expect: null })).rejects.toEqual(expectCode('STALE'));
    expect(await readFile(p, 'utf8')).toBe('two, longer');
    expect(await tmpLeftovers(fx.holdRoot)).toEqual([]);
    await sfs.writeFileAtomic(p, 'mine', { expect: (await factsOf(fx.fs, p))! });
    expect(await readFile(p, 'utf8')).toBe('mine');
    const q = join(fx.holdRoot, 'new.txt');
    await sfs.writeFileAtomic(q, 'fresh', { expect: null });
    expect(await readFile(q, 'utf8')).toBe('fresh');
  });
});

describe('write ops: failure mapping (coverage gate)', () => {
  it('writeFileAtomic with expect: the re-check lstat failing (EACCES) is IO and the temp file is discarded', async () => {
    const fx = await buildFixture(one); const p = join(fx.hubRoot, 'state.txt');
    await writeFile(p, 'old');
    const facts = (await factsOf(fx.fs, p))!;
    // lstat of p: the existing-entry check (1st), then the expect re-check (2nd)
    const sfs = new SafeFs(fx.roots, scriptedFs(fx.fs, [{ method: 'lstat', nth: 2, code: 'EACCES', pathIncludes: p }]));
    await expect(sfs.writeFileAtomic(p, 'new', { expect: facts })).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EACCES', path: p }));
    expect(await readFile(p, 'utf8')).toBe('old');
    expect(await tmpLeftovers(fx.hubRoot)).toEqual([]);
  });
  it('an lstat failure other than not-found while checking a target is IO (symlink, writeFileAtomic)', async () => {
    const fx = await buildFixture(one); const p = join(fx.hubRoot, 'n');
    const sfs = new SafeFs(fx.roots, scriptedFs(fx.fs, [{ method: 'lstat', nth: 1, code: 'EACCES', pathIncludes: p }]));
    await expect(sfs.symlink('x', p)).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EACCES', path: p, resolved: p }));
    await expect(lstat(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('mkdirp of a root nested inside another root is refused', async () => {
    const { sfs, hub } = await nested(true);
    await expect(sfs.mkdirp(hub)).rejects.toEqual(expect.objectContaining({ code: 'CONTAINMENT', message: expect.stringContaining('refusing to act on a root itself') }));
  });
  it('mkdirp of the canonical hold root when even the hub\'s parent is missing is refused', async () => {
    const fx = await buildFixture({});
    const top = join(fx.root, 'top'); await mkdir(top);
    const hub = join(top, 'a', 'b', 'hub');
    const hold = join(top, 'a', 'b', '.hf-cache-manager', 'recently-deleted');
    const sfs = new SafeFs({ hubRoot: hub, viewRoots: [], holdRoot: hold }, fx.fs);
    await expect(sfs.mkdirp(hold)).rejects.toEqual(expect.objectContaining({ code: 'CONTAINMENT', message: expect.stringContaining(`hold root ancestor ${top} is missing`) }));
    await expect(lstat(join(top, 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('mkdirp: an EEXIST from mkdir with nothing (or a non-directory) there afterwards is EXISTS', async () => {
    const fx = await buildFixture(one); const d = join(fx.hubRoot, 'race');
    const sfs = new SafeFs(fx.roots, scriptedFs(fx.fs, [{ method: 'mkdir', nth: 1, code: 'EEXIST' }]));
    await expect(sfs.mkdirp(d)).rejects.toEqual(expect.objectContaining({ code: 'EXISTS', errno: 'EEXIST', message: expect.stringContaining(`${d} exists and is not a directory`) }));
    const fileThere: typeof fx.fs = { ...fx.fs, mkdir: (async (p: string) => { await writeFile(p, 'x'); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); }) as typeof fx.fs.mkdir };
    await expect(new SafeFs(fx.roots, fileThere).mkdirp(d)).rejects.toEqual(expect.objectContaining({ code: 'EXISTS', errno: 'EEXIST' }));
    expect((await lstat(d)).isFile()).toBe(true);
  });
  it('a SafeFsError thrown by the fs passes through unchanged; a non-Error throw becomes IO with its text', async () => {
    const fx = await buildFixture(one); const p = join(fx.hubRoot, 'f');
    await writeFile(p, 'x');
    const facts = (await factsOf(fx.fs, p))!;
    const own = new SafeFsError('STALE', '/elsewhere', 'from below');
    const throwing = (v: unknown): typeof fx.fs => ({ ...fx.fs, unlink: (async () => { throw v; }) as typeof fx.fs.unlink });
    await expect(new SafeFs(fx.roots, throwing(own)).unlink(p, facts)).rejects.toBe(own);
    await expect(new SafeFs(fx.roots, throwing('boom')).unlink(p, facts))
      .rejects.toEqual(expect.objectContaining({ code: 'IO', message: `IO: boom (${p})`, path: p, resolved: p }));
    expect((await lstat(p)).isFile()).toBe(true);
  });
});

describe('every refusal names its reason (mutation gate)', () => {
  it('messages of the containment, revalidation and write refusals', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const repo = fx.repo('o/a');
    const blob = repo.blobOf('x.gguf'); const facts = (await factsOf(fx.fs, blob))!;
    const link = repo.file('x.gguf'); const linkFacts = (await factsOf(fx.fs, link))!;
    const dir = repo.snapshotDir(); const dirFacts = (await factsOf(fx.fs, dir))!;
    const outside = join(fx.root, 'outside');
    const reason = async (p: () => Promise<unknown>): Promise<string> => p().then(() => 'resolved', (e: unknown) => (e as Error).message);
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => sfs.assertContained(outside), `CONTAINMENT: path is not inside any root (${outside})`],
      [() => sfs.assertContained('rel'), 'CONTAINMENT: path must be absolute and contain no NUL (rel)'],
      [() => sfs.assertContained(`${fx.hubRoot}/./x`), `CONTAINMENT: path must not contain '.' or '..' segments (${fx.hubRoot}/./x)`],
      [() => sfs.unlink(dir, dirFacts), `IO: unlink refuses directories (${dir})`],
      [() => sfs.unlink(blob, { ...facts, size: facts.size + 1 }), `STALE: changed since review (${blob})`],
      [() => sfs.unlink(join(fx.hubRoot, 'gone'), facts), `STALE: missing since review (${join(fx.hubRoot, 'gone')})`],
      [() => sfs.rmdirEmpty(blob), `STALE: not a real directory (${blob})`],
      [() => sfs.rename(dir, join(dir, 'in'), dirFacts), `CONTAINMENT: cannot move ${dir} inside itself (${join(dir, 'in')})`],
      [() => sfs.rename(blob, link, facts), `EXISTS: destination exists (${link})`],
      [() => sfs.symlink('x', link), `EXISTS: path exists (${link})`],
      [() => sfs.writeFileAtomic(link, 'x'), `EXISTS: not a regular file; refusing to write through or over it (${link})`],
      [() => sfs.writeFileAtomic(blob, 'x', { expect: { ...facts, size: 0 } }), `STALE: changed since it was checked (${blob})`],
      [() => sfs.writeFileAtomic(blob, 'x', { tmpPath: join(fx.hubRoot, 'elsewhere.tmp') }),
        `CONTAINMENT: tmpPath must be another name in the same directory as the target (${join(fx.hubRoot, 'elsewhere.tmp')})`],
      [() => sfs.mkdirp(join(fx.hubRoot, 'd'), { exclusive: true }), `CONTAINMENT: an exclusive mkdirp is only for a direct child of the hold root (${join(fx.hubRoot, 'd')})`],
      [() => sfs.mkdirp(outside), `CONTAINMENT: path is not inside any root (${outside})`],
      [() => sfs.mkdirp(join(blob, 'sub')), `EXISTS: ${blob} exists and is not a directory (${join(blob, 'sub')})`],
      [() => sfs.mkdirp(dir, { exclusive: false }).then(() => sfs.mkdirp(join(fx.holdRoot, 'x'), { exclusive: true }))
        .then(() => sfs.mkdirp(join(fx.holdRoot, 'x'), { exclusive: true })), `EXISTS: directory already exists (${join(fx.holdRoot, 'x')})`],
    ];
    for (const [p, msg] of cases) expect(await reason(p)).toBe(msg);
    expect(linkFacts.isSymlink).toBe(true);
  });

  it('mkdirp: a missing view root is never created; a symlinked component is refused; root messages', async () => {
    const fx = await buildFixture(one);
    const view = join(dirname(fx.hubRoot), 'no-view');
    const sfs = new SafeFs({ ...fx.roots, viewRoots: [view] }, fx.fs);
    await expect(sfs.mkdirp(join(view, 'a'))).rejects.toThrow(`CONTAINMENT: root ${view} does not exist and is never created (${join(view, 'a')})`);
    await mkdir(join(fx.hubRoot, 'real'));
    await symlink(join(fx.hubRoot, 'real'), join(fx.hubRoot, 'alias'));
    await expect(sfs.mkdirp(join(fx.hubRoot, 'alias', 'x', 'y'))).rejects.toThrow(`EXISTS: ${join(fx.hubRoot, 'alias')} is a symlink; refusing to traverse it`);
    expect(() => new SafeFs({ hubRoot: 'rel', viewRoots: [], holdRoot: null })).toThrow('CONTAINMENT: hubRoot must be a non-empty absolute path (rel)');
    expect(() => new SafeFs({ hubRoot: '/', viewRoots: [], holdRoot: null })).toThrow('CONTAINMENT: hubRoot must not be a filesystem root (/)');
    await expect(new SafeFs({ ...fx.roots, viewRoots: [dirname(fx.hubRoot)] }, fx.fs).assertContained(fx.hubRoot))
      .rejects.toThrow(`CONTAINMENT: refusing to act on a root itself (${fx.hubRoot})`);
  });
});

describe('SafeFs edge rules (mutation gate)', () => {
  it('errno: only a string code counts; a thrown null is IO too', async () => {
    const fx = await buildFixture(one); const p = join(fx.hubRoot, 'f');
    await writeFile(p, 'x');
    const facts = (await factsOf(fx.fs, p))!;
    const throwing = (v: unknown): typeof fx.fs => ({ ...fx.fs, unlink: (async () => { throw v; }) as typeof fx.fs.unlink });
    const numeric = await new SafeFs(fx.roots, throwing(Object.assign(new Error('odd'), { code: 5 }))).unlink(p, facts).catch((e: unknown) => e);
    expect(numeric).toMatchObject({ code: 'IO', message: `IO: odd (${p})` });
    expect((numeric as SafeFsError).errno).toBeUndefined();
    await expect(new SafeFs(fx.roots, throwing(null)).unlink(p, facts)).rejects.toMatchObject({ code: 'IO', message: `IO: null (${p})` });
  });

  it('create: a view root that cannot be inspected (EACCES) is CONTAINMENT, never walked past', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: {} } });
    const v = fx.viewRoots.lmstudio!;
    const sfs = scriptedFs(fx.fs, [{ method: 'lstat', nth: 1, code: 'EACCES', pathIncludes: v }]);
    await expect(SafeFs.create({ hubRoot: fx.hubRoot, viewRoots: [v], holdRoot: null }, sfs))
      .rejects.toMatchObject({ code: 'CONTAINMENT', errno: 'EACCES', message: `CONTAINMENT: viewRoots[0]: cannot inspect ${v} (${v})` });
  });

  it('writeFileAtomic: expect null refuses an existing file; a foreign temp name is left alone', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const p = join(fx.hubRoot, 'w.txt');
    await writeFile(p, 'there');
    await expect(sfs.writeFileAtomic(p, 'x', { expect: null })).rejects.toMatchObject({ code: 'STALE' });
    expect(await readFile(p, 'utf8')).toBe('there');
    const tmp = join(fx.hubRoot, 'w.txt.mine.tmp');
    await writeFile(tmp, 'someone else');
    await expect(sfs.writeFileAtomic(p, 'x', { tmpPath: tmp })).rejects.toMatchObject({ code: 'EXISTS', errno: 'EEXIST' });
    expect(await readFile(tmp, 'utf8')).toBe('someone else');
  });

  it('mkdirp: the canonical hold root under a parent that resolves elsewhere is refused', async () => {
    const fx = await buildFixture({ repos: one.repos });
    const alias = join(fx.root, 'alias');
    await symlink(fx.root, alias);
    const parent = join(alias, basename(dirname(fx.hubRoot))); // a real directory reached through a symlink
    const hub = join(parent, basename(fx.hubRoot));
    const hold = join(parent, '.hf-cache-manager', 'recently-deleted');
    const sfs = new SafeFs({ hubRoot: hub, viewRoots: [], holdRoot: hold }, fx.fs);
    await expect(sfs.mkdirp(hold)).rejects.toThrow(`CONTAINMENT: ${parent} is a symlink or resolves elsewhere (${hold})`);
  });

  it('mkdirp: the longest containing root decides — a missing view root nested in the hub is never created', async () => {
    const fx = await buildFixture(one);
    const v = join(fx.hubRoot, 'nested-view');
    const sfs = new SafeFs({ ...fx.roots, viewRoots: [v] }, fx.fs);
    await expect(sfs.mkdirp(join(v, 'x'))).rejects.toThrow(`root ${v} does not exist and is never created`);
    await expect(lstat(v)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exclusive mkdirp: an EEXIST race on a missing ancestor is tolerated; only the target itself must be new', async () => {
    const fx = await buildFixture({ repos: one.repos }); // no hold root on disk yet
    const holdRoot = join(dirname(fx.hubRoot), '.hf-cache-manager', 'recently-deleted');
    const D = join(holdRoot, 'D1');
    const racing: typeof fx.fs = { ...fx.fs, mkdir: (async (p: string, o?: unknown) => {
      if (p === holdRoot) { await fx.fs.mkdir(p); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); }
      return fx.fs.mkdir(p, o as never);
    }) as typeof fx.fs.mkdir };
    const created: string[] = [];
    await new SafeFs({ ...fx.roots, holdRoot }, racing).mkdirp(D, { exclusive: true, created });
    expect((await lstat(D)).isDirectory()).toBe(true);
    expect(created).not.toContain(holdRoot);
    expect(created).toContain(D);
  });
});
