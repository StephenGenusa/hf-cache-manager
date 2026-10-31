import { link, lstat, mkdir, readdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factsOf, type FsLike } from '../../src/core/fsx';
import { SafeFs, SafeFsError, segmentSplit } from '../../src/core/safe-fs';
import { useCanaries } from '../helpers/canary';
import { failingFs, scriptedFs } from '../helpers/failing-fs';
import { buildFixture } from '../helpers/fixture';

const canaries = useCanaries();
const one = { repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'x.gguf', blob: 'x' }, { path: 'e', dir: true as const }] }] }] };
const expectCode = (code: string) => expect.objectContaining({ name: 'SafeFsError', code });
const handleOf = (h: Awaited<ReturnType<FsLike['open']>>, over: Partial<Awaited<ReturnType<FsLike['open']>>>) => ({ ...h, ...over });

describe('constructor', () => {
  it.each([['/'], [''], ['relative/hub'], ['/tmp/x\0y']])('refuses hub root %j', (r) => {
    expect(() => new SafeFs({ hubRoot: r, viewRoots: [], holdRoot: null })).toThrow(expect.objectContaining({ code: 'CONTAINMENT' }));
  });
  it('refuses a filesystem-root view root', () => {
    expect(() => new SafeFs({ hubRoot: '/tmp/x', viewRoots: ['/'], holdRoot: null })).toThrow(expect.objectContaining({ code: 'CONTAINMENT' }));
  });
  it.each([['/'], [''], ['rel'], ['/tmp/..']])('refuses %j as a view root and as a hold root', (r) => {
    expect(() => new SafeFs({ hubRoot: '/tmp/x', viewRoots: [r], holdRoot: null })).toThrow(expectCode('CONTAINMENT'));
    expect(() => new SafeFs({ hubRoot: '/tmp/x', viewRoots: [], holdRoot: r })).toThrow(expectCode('CONTAINMENT'));
  });
  it('the thrown error is a SafeFsError carrying the offending path', () => {
    let err: unknown;
    try {
      new SafeFs({ hubRoot: '/tmp/x', viewRoots: [], holdRoot: '/' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SafeFsError);
    expect(err).toMatchObject({ code: 'CONTAINMENT', path: '/' });
  });
  it('exposes normalised roots read-only', () => {
    const sfs = new SafeFs({ hubRoot: '/tmp/x/hub/', viewRoots: ['/tmp/v/'], holdRoot: '/tmp/x/.hf-cache-manager/recently-deleted' });
    expect(sfs.roots).toEqual({ hubRoot: '/tmp/x/hub', viewRoots: ['/tmp/v'], holdRoot: '/tmp/x/.hf-cache-manager/recently-deleted' });
    expect(Object.isFrozen(sfs.roots)).toBe(true);
    expect(Object.isFrozen(sfs.roots.viewRoots)).toBe(true);
  });
});

describe('resolveContained / assertContained', () => {
  it('returns realpath(parent)/basename and never follows the leaf', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    await symlink(fx.repo('o/a').folder, join(fx.hubRoot, 'alias'));
    expect(await sfs.resolveContained(join(fx.hubRoot, 'alias', 'refs', 'main'))).toBe(join(fx.repo('o/a').folder, 'refs', 'main'));
    const l = fx.repo('o/a').file('x.gguf');
    expect(await sfs.resolveContained(l)).toBe(l);
    await expect(sfs.assertContained(l)).resolves.toBeUndefined();
  });
  it('allows paths that do not exist yet, including missing parents', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const p = join(fx.hubRoot, 'models--new--x', 'snapshots', 'c', 'f.bin');
    expect(await sfs.resolveContained(p)).toBe(p);
    await expect(sfs.assertContained(p)).resolves.toBeUndefined();
  });
  it('a missing path under a symlinked dir that escapes is CONTAINMENT', async () => {
    const fx = await buildFixture({ ...one, outside: { 'victim/file.bin': 'precious' } });
    await symlink(fx.outside('victim'), join(fx.hubRoot, 'models--evil--x'));
    const sfs = new SafeFs(fx.roots, fx.fs);
    await expect(sfs.assertContained(join(fx.hubRoot, 'models--evil--x', 'new', 'deeper.bin'))).rejects.toEqual(expectCode('CONTAINMENT'));
  });
  it('a dangling symlink ancestor is CONTAINMENT (cannot be resolved)', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    await symlink(fx.outside('not-there'), join(fx.hubRoot, 'dangling'));
    await expect(sfs.assertContained(join(fx.hubRoot, 'dangling', 'f'))).rejects.toEqual(expectCode('CONTAINMENT'));
  });
  it('an ancestor that cannot be inspected is CONTAINMENT with errno (fail closed)', async () => {
    const fx = await buildFixture(one);
    const sfs = new SafeFs(fx.roots, failingFs(fx.fs, 'realpath', 'EACCES'));
    await expect(sfs.assertContained(fx.repo('o/a').file('x.gguf'))).rejects.toEqual(
      expect.objectContaining({ code: 'CONTAINMENT', errno: 'EACCES' }));
  });
  it('an ancestor whose lstat fails with other than ENOENT is CONTAINMENT, not treated as missing', async () => {
    const fx = await buildFixture(one); const snap = fx.repo('o/a').snapshotDir();
    const sfs = new SafeFs(fx.roots, failingFs(fx.fs, 'lstat', 'EACCES', (p) => p === snap));
    await expect(sfs.assertContained(join(snap, 'x.gguf'))).rejects.toEqual(expect.objectContaining({ code: 'CONTAINMENT', errno: 'EACCES' }));
  });
  it('EACCES on an ancestor met while walking up from a missing parent is CONTAINMENT naming it', async () => {
    const fx = await buildFixture(one); const snap = fx.repo('o/a').snapshotDir();
    const sfs = new SafeFs(fx.roots, failingFs(fx.fs, 'lstat', 'EACCES', (p) => p === snap));
    const p = join(snap, 'missing', 'deeper', 'x.gguf');
    await expect(sfs.assertContained(p)).rejects.toEqual(expect.objectContaining({
      code: 'CONTAINMENT', errno: 'EACCES', path: p, message: `CONTAINMENT: cannot inspect ${snap} (${p})` }));
  });
  it('refuses NUL, "." and ".." segments, relative paths and non-strings', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    for (const p of [`${fx.hubRoot}/a\0b`, `${fx.hubRoot}/./models--o--a`, `${fx.hubRoot}/models--o--a/..`,
      `${fx.hubRoot}/x/../models--o--a`, 'hf/hub/models--o--a', '', 42 as unknown as string]) {
      await expect(sfs.assertContained(p)).rejects.toEqual(expectCode('CONTAINMENT'));
    }
  });
  it('refuses every root itself, including a root given with a trailing slash', async () => {
    const fx = await buildFixture({ ...one, holdRoot: true, views: { lmstudio: {} } });
    const nested = join(fx.hubRoot, 'nested-view');
    await mkdir(nested);
    const sfs = new SafeFs({ hubRoot: fx.hubRoot + '/', viewRoots: [fx.roots.viewRoots[0]!, nested + '/'], holdRoot: fx.holdRoot }, fx.fs);
    for (const r of [fx.hubRoot, nested, fx.roots.viewRoots[0]!, fx.holdRoot]) {
      await expect(sfs.assertContained(r)).rejects.toEqual(expectCode('CONTAINMENT'));
      await expect(sfs.rmdirEmpty(r)).rejects.toEqual(expectCode('CONTAINMENT'));
    }
    expect((await lstat(nested)).isDirectory()).toBe(true);
    expect((await lstat(fx.holdRoot)).isDirectory()).toBe(true);
  });
  it('a view root that contains the hub: a view path whose parent resolves into the hub is refused', async () => {
    const fx = await buildFixture(one);
    const viewRoot = dirname(fx.hubRoot);
    await symlink(join(fx.repo('o/a').folder, 'blobs'), join(viewRoot, 'vlink'));
    const sfs = new SafeFs({ ...fx.roots, viewRoots: [viewRoot] }, fx.fs);
    const p = join(viewRoot, 'vlink', fx.repo('o/a').etagOf('x.gguf'));
    await expect(sfs.unlink(p, (await factsOf(fx.fs, p))!)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect((await lstat(fx.repo('o/a').blobOf('x.gguf'))).isFile()).toBe(true);
    // the hub path itself is still fine, and picks the hub (the longest root)
    await expect(sfs.assertContained(fx.repo('o/a').blobOf('x.gguf'))).resolves.toBeUndefined();
  });
  it('refuses the parent of a root and the filesystem root', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    await expect(sfs.assertContained(dirname(fx.hubRoot))).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.assertContained('/')).rejects.toEqual(expectCode('CONTAINMENT'));
  });
  it('a path inside the hold root is contained when holdRoot is set, refused when null', async () => {
    const fx = await buildFixture({ ...one, holdRoot: true });
    const p = join(fx.holdRoot, 'd1', 'f');
    await expect(new SafeFs(fx.roots, fx.fs).assertContained(p)).resolves.toBeUndefined();
    await expect(new SafeFs({ ...fx.roots, holdRoot: null }, fx.fs).assertContained(p)).rejects.toEqual(expectCode('CONTAINMENT'));
  });
});

describe('unlink', () => {
  it('removes a snapshot link and leaves the blob byte-identical', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const l = fx.repo('o/a').file('x.gguf');
    await sfs.unlink(l, (await factsOf(fx.fs, l))!);
    await expect(lstat(l)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(fx.repo('o/a').blobOf('x.gguf'))).toEqual(fx.content('x'));
  });
  it('refuses the hub root, a path outside all roots, relative and dot-dot paths', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const facts = (await factsOf(fx.fs, fx.outside('canary.bin')))!;
    await expect(sfs.unlink(fx.hubRoot, facts)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.unlink(fx.outside('canary.bin'), facts)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.unlink(join(canaries.sandbox, 'outside.bin'), facts)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.unlink('hf/hub/models--o--a/blobs/x', facts)).rejects.toEqual(expectCode('CONTAINMENT'));
    const l = fx.repo('o/a').file('x.gguf');
    // Built literally; path.join would normalise the '..' away.
    const dotdot = `${fx.hubRoot}/models--o--a/../models--o--a/snapshots/${fx.repo('o/a').commits[0]!}/x.gguf`;
    await expect(sfs.unlink(dotdot, (await factsOf(fx.fs, l))!)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect((await lstat(l)).isSymbolicLink()).toBe(true);
  });
  it('refuses when a parent dir inside the hub is a symlink to outside', async () => {
    const fx = await buildFixture({ ...one, outside: { 'victim/file.bin': 'precious' } });
    await symlink(fx.outside('victim'), join(fx.hubRoot, 'models--evil--x'));
    const sfs = new SafeFs(fx.roots, fx.fs);
    const p = join(fx.hubRoot, 'models--evil--x', 'file.bin');
    await expect(sfs.unlink(p, (await factsOf(fx.fs, fx.outside('victim/file.bin')))!)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await readFile(fx.outside('victim/file.bin'), 'utf8')).toBe('precious');
  });
  it('a leaf symlink to outside is unlinked as a link; the outside target is untouched', async () => {
    const fx = await buildFixture({ ...one, outside: { 'target.bin': 'keep' } });
    const l = join(fx.repo('o/a').snapshotDir(), 'evil');
    await symlink(fx.outside('target.bin'), l);
    await new SafeFs(fx.roots, fx.fs).unlink(l, (await factsOf(fx.fs, l))!);
    await expect(lstat(l)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(fx.outside('target.bin'), 'utf8')).toBe('keep');
  });
  it('a leaf symlink to a directory is unlinked as a link; the directory and its contents are untouched', async () => {
    const fx = await buildFixture({ ...one, outside: { 'd/keep': 'k' } });
    const l = join(fx.repo('o/a').snapshotDir(), 'dirlink');
    await symlink(fx.outside('d'), l);
    await new SafeFs(fx.roots, fx.fs).unlink(l, (await factsOf(fx.fs, l))!);
    await expect(lstat(l)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(fx.outside('d/keep'), 'utf8')).toBe('k');
  });
  it('refuses a view path whose parent resolves into the hub (same-root rule)', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: {} } });
    await symlink(join(fx.repo('o/a').folder, 'blobs'), fx.viewPath('lmstudio', 'o'));
    const p = fx.viewPath('lmstudio', join('o', fx.repo('o/a').etagOf('x.gguf')));
    await expect(new SafeFs(fx.roots, fx.fs).unlink(p, (await factsOf(fx.fs, p))!)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect((await lstat(fx.repo('o/a').blobOf('x.gguf'))).isFile()).toBe(true);
  });
  it.each([
    ['size changed', async (p: string) => { await unlink(p); await symlink('../../blobs/' + 'f'.repeat(64) + 'x', p); }],
    // Create the replacement under a temp name, then rename it over, so the inode cannot be reused.
    ['inode changed', async (p: string) => { const t = await readlink(p); await symlink(t, p + '.new'); await rename(p + '.new', p); }],
    ['link retargeted', async (p: string) => { await unlink(p); await symlink('../../blobs/' + 'f'.repeat(64), p); }],
    ['missing', async (p: string) => { await unlink(p); }],
    ['replaced by a dir', async (p: string) => { await unlink(p); await mkdir(p); }],
  ])('STALE when %s since review', async (_n, mutate) => {
    const fx = await buildFixture(one); const l = fx.repo('o/a').file('x.gguf');
    const expectFacts = (await factsOf(fx.fs, l))!;
    await mutate(l);
    const before = await factsOf(fx.fs, l);
    await expect(new SafeFs(fx.roots, fx.fs).unlink(l, expectFacts)).rejects.toEqual(expectCode('STALE'));
    expect(await factsOf(fx.fs, l)).toEqual(before);
  });
  it('hardlink sibling removed earlier: nlink drop is allowed; a new link is STALE', async () => {
    const fx = await buildFixture({ blobs: { w: { storage: 'hardlink' } }, repos: [
      { id: 'o/a', snapshots: [{ files: [{ path: 'w', blob: 'w' }] }] },
      { id: 'o/b', snapshots: [{ files: [{ path: 'w', blob: 'w' }] }] }] });
    const sfs = new SafeFs(fx.roots, fx.fs);
    const [a, b] = [fx.repo('o/a').blobOf('w'), fx.repo('o/b').blobOf('w')];
    const [fa, fb] = [(await factsOf(fx.fs, a))!, (await factsOf(fx.fs, b))!];
    await sfs.unlink(a, fa);
    await sfs.unlink(b, fb);                                  // nlink 2 -> 1: still allowed
    await expect(lstat(b)).rejects.toMatchObject({ code: 'ENOENT' });
    const fx2 = await buildFixture(one); const blob = fx2.repo('o/a').blobOf('x.gguf');
    const f1 = (await factsOf(fx2.fs, blob))!;
    await link(blob, fx2.outside('sneaky'));
    await expect(new SafeFs(fx2.roots, fx2.fs).unlink(blob, f1)).rejects.toEqual(expectCode('STALE'));
    expect((await lstat(blob)).isFile()).toBe(true);
  });
  it('refuses directories', async () => {
    const fx = await buildFixture(one); const d = fx.repo('o/a').file('e');
    await expect(new SafeFs(fx.roots, fx.fs).unlink(d, (await factsOf(fx.fs, d))!)).rejects.toEqual(expectCode('IO'));
    expect((await lstat(d)).isDirectory()).toBe(true);
  });
  it('maps an fs failure to IO with errno and the path; the file survives', async () => {
    const fx = await buildFixture(one); const l = fx.repo('o/a').file('x.gguf');
    const sfs = new SafeFs(fx.roots, failingFs(fx.fs, 'unlink', 'EPERM'));
    await expect(sfs.unlink(l, (await factsOf(fx.fs, l))!)).rejects.toEqual(
      expect.objectContaining({ name: 'SafeFsError', code: 'IO', errno: 'EPERM', path: l }));
    expect((await lstat(l)).isSymbolicLink()).toBe(true);
  });
  it('an lstat failure during revalidation is IO, and nothing is removed', async () => {
    const fx = await buildFixture(one); const l = fx.repo('o/a').file('x.gguf');
    const sfs = new SafeFs(fx.roots, failingFs(fx.fs, 'lstat', 'EACCES', (p) => p === l));
    await expect(sfs.unlink(l, (await factsOf(fx.fs, l))!)).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EACCES' }));
    expect((await lstat(l)).isSymbolicLink()).toBe(true);
  });
});

describe('rmdirEmpty', () => {
  it('removes an empty dir; refuses non-empty without touching children', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    await sfs.rmdirEmpty(fx.repo('o/a').file('e'));
    await expect(lstat(fx.repo('o/a').file('e'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(sfs.rmdirEmpty(fx.repo('o/a').snapshotDir())).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: expect.stringMatching(/^(ENOTEMPTY|EEXIST)$/) }));
    expect((await lstat(fx.repo('o/a').file('x.gguf'))).isSymbolicLink()).toBe(true);
  });
  it('refuses a symlink-to-dir, a missing dir and a root', async () => {
    const fx = await buildFixture({ ...one, outside: { 'd/keep': 'k' } }); const sfs = new SafeFs(fx.roots, fx.fs);
    const l = join(fx.repo('o/a').folder, 'ln'); await symlink(fx.outside('d'), l);
    await expect(sfs.rmdirEmpty(l)).rejects.toEqual(expectCode('STALE'));
    expect((await lstat(l)).isSymbolicLink()).toBe(true);
    await expect(sfs.rmdirEmpty(join(fx.repo('o/a').folder, 'nope'))).rejects.toEqual(expectCode('STALE'));
    await expect(sfs.rmdirEmpty(fx.hubRoot)).rejects.toEqual(expectCode('CONTAINMENT'));
  });
  it('refuses a symlink to an empty dir inside the hub, leaving both', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const l = join(fx.repo('o/a').folder, 'ln-e'); await symlink(fx.repo('o/a').file('e'), l);
    await expect(sfs.rmdirEmpty(l)).rejects.toEqual(expectCode('STALE'));
    expect((await lstat(l)).isSymbolicLink()).toBe(true);
    expect((await lstat(fx.repo('o/a').file('e'))).isDirectory()).toBe(true);
  });
  it('refuses a regular file', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    await expect(sfs.rmdirEmpty(fx.repo('o/a').blobOf('x.gguf'))).rejects.toEqual(expectCode('STALE'));
    expect((await lstat(fx.repo('o/a').blobOf('x.gguf'))).isFile()).toBe(true);
  });
});

describe('SafeFs.create (realpath\'d roots)', () => {
  it('realpaths a symlinked hub root and view root; the hold root resolves through its nearest existing ancestor', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: {} } });
    const alias = join(fx.root, 'alias');
    await symlink(dirname(fx.hubRoot), alias); // <root>/alias -> <root>/hf
    const viewAlias = join(fx.root, 'view-alias');
    await symlink(fx.viewRoots.lmstudio!, viewAlias);
    const missingHold = join(alias, 'not-yet', 'recently-deleted');
    const sfs = await SafeFs.create({ hubRoot: join(alias, 'hub'), viewRoots: [viewAlias], holdRoot: missingHold }, fx.fs);
    expect(sfs.roots).toEqual({
      hubRoot: fx.hubRoot, viewRoots: [fx.viewRoots.lmstudio!], holdRoot: join(dirname(fx.hubRoot), 'not-yet', 'recently-deleted'),
    });
    // the realpath'd roots make containment work for real paths
    await expect(sfs.assertContained(join(fx.hubRoot, 'x'))).resolves.toBeUndefined();
  });
  it('keeps already-real roots unchanged, holdRoot null stays null, and a missing view root resolves via its ancestor', async () => {
    const fx = await buildFixture(one);
    const missingView = join(dirname(fx.hubRoot), 'no-view-here');
    const sfs = await SafeFs.create({ hubRoot: fx.hubRoot, viewRoots: [missingView], holdRoot: null }, fx.fs);
    expect(sfs.roots).toEqual({ hubRoot: fx.hubRoot, viewRoots: [missingView], holdRoot: null });
  });
  it('a missing or dangling hub root is CONTAINMENT; the constructor checks still apply', async () => {
    const fx = await buildFixture(one);
    await expect(SafeFs.create({ hubRoot: join(fx.root, 'nope'), viewRoots: [], holdRoot: null }, fx.fs)).rejects.toThrow(expectCode('CONTAINMENT'));
    await expect(SafeFs.create({ hubRoot: 'relative', viewRoots: [], holdRoot: null }, fx.fs)).rejects.toThrow(expectCode('CONTAINMENT'));
    const dangling = join(fx.root, 'dangling');
    await symlink(join(fx.root, 'gone'), dangling);
    await expect(SafeFs.create({ hubRoot: fx.hubRoot, viewRoots: [], holdRoot: join(dangling, 'x') }, fx.fs)).rejects.toThrow(expectCode('CONTAINMENT'));
  });
});

describe('constructor and create: malformed and unresolvable roots (coverage gate)', () => {
  it('a non-string root is CONTAINMENT carrying String(root); a non-array viewRoots is CONTAINMENT', () => {
    expect(() => new SafeFs({ hubRoot: 7 as unknown as string, viewRoots: [], holdRoot: null }))
      .toThrow(expect.objectContaining({ code: 'CONTAINMENT', path: '7' }));
    expect(() => new SafeFs({ hubRoot: '/tmp/x', viewRoots: '/tmp/v' as unknown as string[], holdRoot: null }))
      .toThrow(expect.objectContaining({ code: 'CONTAINMENT', path: '/tmp/v', message: 'CONTAINMENT: viewRoots must be an array (/tmp/v)' }));
  });
  it('segmentSplit: both slashes on win32, only "/" elsewhere', () => {
    expect('a\\b/c'.split(segmentSplit('win32'))).toEqual(['a', 'b', 'c']);
    expect('a\\b/c'.split(segmentSplit('linux'))).toEqual(['a\\b', 'c']);
  });
  it('create: a view root whose existing ancestor cannot be realpath\'d is CONTAINMENT (not re-wrapped)', async () => {
    const fx = await buildFixture({ ...one, views: { lmstudio: {} } });
    const sfs = scriptedFs(fx.fs, [{ method: 'realpath', nth: 1, code: 'EACCES', pathIncludes: fx.viewRoots.lmstudio! }]);
    const err = await SafeFs.create({ hubRoot: fx.hubRoot, viewRoots: [fx.viewRoots.lmstudio!], holdRoot: null }, sfs).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFsError);
    expect(err).toMatchObject({ code: 'CONTAINMENT', path: fx.viewRoots.lmstudio!, errno: 'EACCES', message: expect.stringContaining('viewRoots[0] cannot be resolved') });
  });
  it('create: a view root with no existing ancestor at all is CONTAINMENT', async () => {
    const fx = await buildFixture(one);
    const view = join(fx.root, 'v');
    const err = await SafeFs.create({ hubRoot: fx.hubRoot, viewRoots: [view], holdRoot: null }, failingFs(fx.fs, 'lstat', 'ENOENT'))
      .then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONTAINMENT', path: view, message: expect.stringContaining('viewRoots[0] has no existing ancestor') });
  });
  it('resolveContained: a path with no existing ancestor is CONTAINMENT', async () => {
    const fx = await buildFixture(one);
    const sfs = new SafeFs(fx.roots, failingFs(fx.fs, 'lstat', 'ENOENT'));
    await expect(sfs.assertContained(join(fx.hubRoot, 'a', 'b'))).rejects.toThrow(expect.objectContaining({ code: 'CONTAINMENT', message: expect.stringContaining('no existing ancestor') }));
  });
});

describe('openIncomplete (download mode)', () => {
  const setup = async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const blobs = dirname(fx.repo('o/a').blobOf('x.gguf'));
    return { fx, sfs, p: join(blobs, 'e1.incomplete'), blobs };
  };
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('appendExisting resumes any regular file through the same checks (no suffix rule, never creates)', async () => {
    const { fx, sfs, blobs } = await setup();
    const q = join(blobs, 'copy.bin');
    await writeFile(q, 'abc');
    const facts = (await factsOf(fx.fs, q))!;
    const w = await sfs.appendExisting(q, facts);
    expect(w.startSize).toBe(3);
    await w.write(enc('def'));
    expect((await w.close()).size).toBe(6);
    expect(await readFile(q, 'utf8')).toBe('abcdef');
    await expect(sfs.appendExisting(q, facts)).rejects.toEqual(expectCode('STALE'));
    await expect(sfs.appendExisting(join(blobs, 'none.bin'), facts)).rejects.toEqual(expectCode('STALE'));
    await expect(sfs.appendExisting(fx.outside('canary.bin'), facts)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await readFile(q, 'utf8')).toBe('abcdef');
  });
  it('a resume or append is refused for a file with other hard links (EXISTS), nothing written', async () => {
    const { fx, sfs, blobs, p } = await setup();
    await writeFile(p, 'abc');
    const other = join(blobs, 'other-name.bin');
    await link(p, other);
    const facts = (await factsOf(fx.fs, p))!;
    expect(facts.nlink).toBe(2);
    await expect(sfs.openIncomplete(p, facts)).rejects.toEqual(expectCode('EXISTS'));
    await expect(sfs.appendExisting(other, (await factsOf(fx.fs, other))!)).rejects.toEqual(expectCode('EXISTS'));
    expect(await readFile(p, 'utf8')).toBe('abc');
  });
  it('creates exclusively, writes through the fd, and close returns the final facts', async () => {
    const { fx, sfs, p } = await setup();
    const w = await sfs.openIncomplete(p, null);
    expect(w.startSize).toBe(0);
    await w.write(enc('abc'));
    await w.write(enc('def'));
    const facts = await w.close();
    expect(await readFile(p, 'utf8')).toBe('abcdef');
    expect(facts).toEqual(await factsOf(fx.fs, p));
    expect(facts.size).toBe(6);
  });
  it('appends to a partial file whose lstat and fstat match the expected facts', async () => {
    const { sfs, p } = await setup();
    const w1 = await sfs.openIncomplete(p, null);
    await w1.write(enc('abc'));
    const first = await w1.close();
    const w2 = await sfs.openIncomplete(p, first);
    expect(w2.startSize).toBe(3);
    await w2.write(enc('de'));
    const second = await w2.close();
    expect(await readFile(p, 'utf8')).toBe('abcde');
    expect(second).toMatchObject({ ino: first.ino, dev: first.dev, size: 5 });
  });
  it('expect null refuses an existing file (EXISTS) and leaves it unchanged', async () => {
    const { sfs, p } = await setup();
    await writeFile(p, 'theirs');
    await expect(sfs.openIncomplete(p, null)).rejects.toEqual(expectCode('EXISTS'));
    expect(await readFile(p, 'utf8')).toBe('theirs');
  });
  it('append is STALE when the size or the inode changed, or the file is gone; nothing is written', async () => {
    const { fx, sfs, p, blobs } = await setup();
    await writeFile(p, 'abc');
    const facts = (await factsOf(fx.fs, p))!;
    await writeFile(p, 'abcd');
    await expect(sfs.openIncomplete(p, facts)).rejects.toEqual(expectCode('STALE'));
    expect(await readFile(p, 'utf8')).toBe('abcd');
    const other = join(blobs, 'other');
    await writeFile(other, 'xyz');
    const now = (await factsOf(fx.fs, p))!;
    await rename(p, join(blobs, 'kept'));
    await rename(other, p); // same size, other inode
    await expect(sfs.openIncomplete(p, now)).rejects.toEqual(expectCode('STALE'));
    await expect(sfs.openIncomplete(p, { ...now, dev: now.dev + 1 })).rejects.toEqual(expectCode('STALE'));
    expect(await readFile(p, 'utf8')).toBe('xyz');
    await rename(p, other);
    await expect(sfs.openIncomplete(p, now)).rejects.toEqual(expectCode('STALE'));
    await expect(lstat(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never opens through a symlinked .incomplete, for create or append (EXISTS), and the target is untouched', async () => {
    const fx = await buildFixture({ ...one, outside: { 'victim.bin': 'precious' } });
    const sfs = new SafeFs(fx.roots, fx.fs);
    const p = join(dirname(fx.repo('o/a').blobOf('x.gguf')), 'e2.incomplete');
    await symlink(fx.outside('victim.bin'), p);
    const victim = (await factsOf(fx.fs, fx.outside('victim.bin')))!;
    await expect(sfs.openIncomplete(p, null)).rejects.toEqual(expectCode('EXISTS'));
    await expect(sfs.openIncomplete(p, victim)).rejects.toEqual(expectCode('EXISTS'));
    await expect(sfs.openIncomplete(p, (await factsOf(fx.fs, p))!)).rejects.toEqual(expectCode('EXISTS'));
    expect(await readFile(fx.outside('victim.bin'), 'utf8')).toBe('precious');
  });
  it('a directory at the path is EXISTS', async () => {
    const { fx, sfs, p } = await setup();
    await mkdir(p);
    await expect(sfs.openIncomplete(p, (await factsOf(fx.fs, p))!)).rejects.toEqual(expectCode('EXISTS'));
  });
  it('only *.incomplete names inside a root, never through ., ..', async () => {
    const { fx, sfs, blobs } = await setup();
    await expect(sfs.openIncomplete(join(blobs, 'e1'), null)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.openIncomplete(join(blobs, '.incomplete'), null)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.openIncomplete(join(blobs, 'e1.incomplete.x'), null)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.openIncomplete(fx.outside('e.incomplete'), null)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.openIncomplete(`${blobs}/../blobs/e.incomplete`, null)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect((await readdir(blobs)).filter((n) => n.endsWith('.incomplete'))).toEqual([]);
  });
  it('an fd whose fstat does not match the expected facts is closed and STALE', async () => {
    const { fx, p } = await setup();
    await writeFile(p, 'abc');
    const facts = (await factsOf(fx.fs, p))!;
    let closed = 0;
    const fs: FsLike = { ...fx.fs, open: async (q, flags) => {
      const h = await fx.fs.open(q, flags);
      return handleOf(h, {
        stat: async () => ({ ...(await h.stat()), ino: facts.ino + 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }),
        close: async () => { closed++; await h.close(); },
      });
    } };
    await expect(new SafeFs(fx.roots, fs).openIncomplete(p, facts)).rejects.toEqual(expectCode('STALE'));
    expect(closed).toBe(1);
    const notFile: FsLike = { ...fx.fs, open: async (q, flags) => {
      const h = await fx.fs.open(q, flags);
      return handleOf(h, { stat: async () => { const s = await h.stat(); return { ...s, dev: s.dev, ino: s.ino, size: s.size, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }; } });
    } };
    await expect(new SafeFs(fx.roots, notFile).openIncomplete(p, facts)).rejects.toEqual(expectCode('STALE'));
    expect(await readFile(p, 'utf8')).toBe('abc');
  });
  it('fstat failing at open is IO and the fd is closed', async () => {
    const { fx, p } = await setup();
    let closed = 0;
    const fs: FsLike = { ...fx.fs, open: async (q, flags) => {
      const h = await fx.fs.open(q, flags);
      return handleOf(h, {
        stat: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
        close: async () => { closed++; await h.close(); },
      });
    } };
    await expect(new SafeFs(fx.roots, fs).openIncomplete(p, null)).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EIO' }));
    expect(closed).toBe(1);
  });
  it('a close failing on a failure path does not hide the original error', async () => {
    const { fx, p } = await setup();
    const fs: FsLike = { ...fx.fs, open: async (q, flags) => {
      const h = await fx.fs.open(q, flags);
      return handleOf(h, {
        stat: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
        close: async () => { await h.close(); throw Object.assign(new Error('EBADF'), { code: 'EBADF' }); },
      });
    } };
    await expect(new SafeFs(fx.roots, fs).openIncomplete(p, null)).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EIO' }));
  });
  it('a partial file that vanishes between the lstat and the append open is STALE', async () => {
    const { fx, p } = await setup();
    await writeFile(p, 'abc');
    const facts = (await factsOf(fx.fs, p))!;
    await expect(new SafeFs(fx.roots, failingFs(fx.fs, 'open', 'ENOENT')).openIncomplete(p, facts)).rejects.toEqual(expectCode('STALE'));
  });
  it('open failing (EACCES) is IO; a create racing another creator (EEXIST) is EXISTS', async () => {
    const { fx, p } = await setup();
    await expect(new SafeFs(fx.roots, failingFs(fx.fs, 'open', 'EACCES')).openIncomplete(p, null))
      .rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EACCES' }));
    await expect(new SafeFs(fx.roots, failingFs(fx.fs, 'open', 'EEXIST')).openIncomplete(p, null)).rejects.toEqual(expectCode('EXISTS'));
  });
  it('write or close after close is IO; a failed write is IO', async () => {
    const { fx, sfs, p } = await setup();
    const w = await sfs.openIncomplete(p, null);
    await w.close();
    await expect(w.write(enc('x'))).rejects.toEqual(expectCode('IO'));
    await expect(w.close()).rejects.toEqual(expectCode('IO'));
    const q = p.replace('e1', 'e3');
    const fs: FsLike = { ...fx.fs, open: async (r, flags) => handleOf(await fx.fs.open(r, flags), {
      write: async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); },
    }) };
    const w2 = await new SafeFs(fx.roots, fs).openIncomplete(q, null);
    await expect(w2.write(enc('x'))).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'ENOSPC' }));
    await w2.close();
  });
  it('close: an fstat or close failure is IO (the fd is still closed); a path replaced while writing is STALE', async () => {
    const { fx, p, blobs } = await setup();
    let closed = 0;
    const statFails: FsLike = { ...fx.fs, open: async (q, flags) => {
      const h = await fx.fs.open(q, flags);
      let n = 0;
      return handleOf(h, {
        stat: async () => { if (++n > 1) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return h.stat(); },
        close: async () => { closed++; await h.close(); },
      });
    } };
    const w = await new SafeFs(fx.roots, statFails).openIncomplete(p, null);
    await expect(w.close()).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EIO' }));
    expect(closed).toBe(1);
    const q = join(blobs, 'e4.incomplete');
    const closeFails: FsLike = { ...fx.fs, open: async (r, flags) => {
      const h = await fx.fs.open(r, flags);
      return handleOf(h, { close: async () => { await h.close(); throw Object.assign(new Error('EIO'), { code: 'EIO' }); } });
    } };
    const w2 = await new SafeFs(fx.roots, closeFails).openIncomplete(q, null);
    await expect(w2.close()).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EIO' }));
    const r = join(blobs, 'e5.incomplete');
    const w3 = await new SafeFs(fx.roots, fx.fs).openIncomplete(r, null);
    await w3.write(enc('mine'));
    await rename(r, join(blobs, 'moved'));
    await writeFile(r, 'swapped in');
    await expect(w3.close()).rejects.toEqual(expectCode('STALE'));
    expect(await readFile(r, 'utf8')).toBe('swapped in');
    const s = join(blobs, 'e6.incomplete');
    const w4 = await new SafeFs(fx.roots, fx.fs).openIncomplete(s, null);
    await rename(s, join(blobs, 'moved2'));
    await expect(w4.close()).rejects.toEqual(expectCode('STALE'));
    const t = join(blobs, 'e7.incomplete');
    const w5 = await new SafeFs(fx.roots, failingFs(fx.fs, 'lstat', 'EACCES', (x) => x === t)).openIncomplete(t, null);
    await expect(w5.close()).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EACCES' }));
    const u = join(blobs, 'e8.incomplete');
    const w6 = await new SafeFs(fx.roots, fx.fs).openIncomplete(u, null);
    await rename(u, join(blobs, 'moved3'));
    await mkdir(u);
    await expect(w6.close()).rejects.toEqual(expectCode('STALE'));
  });
});

describe('copyExclusive (the no-symlink snapshot fallback)', () => {
  const setup = async (extra = {}) => {
    const fx = await buildFixture({ ...one, ...extra }); const sfs = new SafeFs(fx.roots, fx.fs);
    const src = fx.repo('o/a').blobOf('x.gguf');
    return { fx, sfs, src, facts: (await factsOf(fx.fs, src))!, dest: join(fx.repo('o/a').snapshotDir(), 'copy.gguf') };
  };
  it('copies the blob to a new file; the source is untouched', async () => {
    const { fx, sfs, src, facts, dest } = await setup();
    await sfs.copyExclusive(src, dest, facts);
    expect(await readFile(dest)).toEqual(await readFile(src));
    const d = (await lstat(dest));
    expect(d.isFile()).toBe(true);
    expect(d.ino).not.toBe(facts.ino);
    expect(await factsOf(fx.fs, src)).toEqual(facts);
  });
  it('an existing dest (a file, a dangling symlink) is EXISTS and unchanged', async () => {
    const { fx, sfs, src, facts, dest } = await setup();
    await writeFile(dest, 'theirs');
    await expect(sfs.copyExclusive(src, dest, facts)).rejects.toEqual(expectCode('EXISTS'));
    expect(await readFile(dest, 'utf8')).toBe('theirs');
    const link = join(dirname(dest), 'dangling.gguf');
    await symlink(fx.outside('nothing-here'), link);
    await expect(sfs.copyExclusive(src, link, facts)).rejects.toEqual(expectCode('EXISTS'));
    await expect(lstat(fx.outside('nothing-here'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('a source that changed since it was checked is STALE; nothing is copied', async () => {
    const { sfs, src, facts, dest } = await setup();
    await expect(sfs.copyExclusive(src, dest, { ...facts, size: facts.size + 1 })).rejects.toEqual(expectCode('STALE'));
    await expect(lstat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('copies regular files only (IO), and both paths must be contained (CONTAINMENT)', async () => {
    const { fx, sfs, src, facts, dest } = await setup();
    await expect(sfs.copyExclusive(src, dest, { ...facts, isFile: false, isSymlink: true })).rejects.toEqual(expectCode('IO'));
    await expect(sfs.copyExclusive(src, dest, { ...facts, isFile: false, isDirectory: true })).rejects.toEqual(expectCode('IO'));
    await expect(sfs.copyExclusive(src, dest, { ...facts, isSymlink: true })).rejects.toEqual(expectCode('IO'));
    await expect(sfs.copyExclusive(src, dest, { ...facts, isDirectory: true })).rejects.toEqual(expectCode('IO'));
    await expect(sfs.copyExclusive(src, fx.outside('copy.bin'), facts)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(sfs.copyExclusive(fx.outside('canary.bin'), dest, facts)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(fx.outside('copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('a dest created between the check and the open (EEXIST) is EXISTS; a source that cannot be opened is IO', async () => {
    const { fx, src, facts, dest } = await setup();
    await expect(new SafeFs(fx.roots, failingFs(fx.fs, 'open', 'EEXIST', (p) => p === dest)).copyExclusive(src, dest, facts))
      .rejects.toEqual(expect.objectContaining({ code: 'EXISTS', path: dest }));
    await expect(new SafeFs(fx.roots, failingFs(fx.fs, 'open', 'EACCES', (p) => p === src)).copyExclusive(src, dest, facts))
      .rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EACCES' }));
    await expect(lstat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('a source swapped after the check (fstat ino mismatch, or not a file) is STALE before any dest is created', async () => {
    const { fx, src, facts, dest } = await setup();
    for (const over of [{ ino: facts.ino + 1 }, { isFile: () => false }]) {
      let closed = 0;
      const fs: FsLike = { ...fx.fs, open: async (q, flags) => {
        const h = await fx.fs.open(q, flags);
        if (flags !== 'r') return h;
        return handleOf(h, {
          stat: async () => { const st = await h.stat(); return { ...st, dev: st.dev, ino: st.ino, size: st.size, isFile: () => st.isFile(), isDirectory: () => false, isSymbolicLink: () => false, ...over }; },
          close: async () => { closed++; await h.close(); },
        });
      } };
      await expect(new SafeFs(fx.roots, fs).copyExclusive(src, dest, facts)).rejects.toEqual(expectCode('STALE'));
      expect(closed).toBe(1);
      await expect(lstat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it('a failure mid-copy (a failing write on the dest fd) leaves the partial dest in place and names it', async () => {
    const { fx, src, facts, dest } = await setup();
    let closed = 0;
    const fs: FsLike = { ...fx.fs, open: async (q, flags) => {
      const h = await fx.fs.open(q, flags);
      if (flags !== 'wx') return h;
      return handleOf(h, {
        write: async (chunk) => {
          await h.write(chunk.subarray(0, 3));
          throw Object.assign(new Error('ENOSPC: no space'), { code: 'ENOSPC' });
        },
        close: async () => { closed++; await h.close(); },
      });
    } };
    const err = await new SafeFs(fx.roots, fs).copyExclusive(src, dest, facts).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'IO', errno: 'ENOSPC', path: dest }));
    expect((err as Error).message).toContain(`partial copy is left at ${dest}`);
    expect(closed).toBe(1);
    expect(await readFile(dest)).toEqual((await readFile(src)).subarray(0, 3)); // still there, never removed
    expect(await factsOf(fx.fs, src)).toEqual(facts);
  });
  it('a failing read of the source or a failing close of the dest is IO; the partial dest stays', async () => {
    const { fx, src, facts, dest } = await setup();
    const readFails: FsLike = { ...fx.fs, open: async (q, flags) => {
      const h = await fx.fs.open(q, flags);
      return flags === 'r' ? handleOf(h, { read: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }) : h;
    } };
    await expect(new SafeFs(fx.roots, readFails).copyExclusive(src, dest, facts)).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EIO', path: dest }));
    expect((await lstat(dest)).size).toBe(0);
    const dest2 = join(dirname(dest), 'copy2.gguf');
    const closeFails: FsLike = { ...fx.fs, open: async (q, flags) => {
      const h = await fx.fs.open(q, flags);
      return flags === 'wx' ? handleOf(h, { close: async () => { await h.close(); throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }) : h;
    } };
    const err = await new SafeFs(fx.roots, closeFails).copyExclusive(src, dest2, facts).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'IO', errno: 'EIO', path: dest2 }));
    expect((err as Error).message).toContain(dest2);
    expect(await readFile(dest2)).toEqual(await readFile(src));
  });
  it('copies a file larger than one chunk', async () => {
    const fx = await buildFixture({ repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'big.bin', blob: { key: 'big', bytes: 9 * 1024 * 1024 + 5 } }] }] }] });
    const src = fx.repo('o/a').blobOf('big.bin'); const dest = join(fx.repo('o/a').snapshotDir(), 'copy.bin');
    await new SafeFs(fx.roots, fx.fs).copyExclusive(src, dest, (await factsOf(fx.fs, src))!);
    expect((await readFile(dest)).equals(await readFile(src))).toBe(true);
  });
});

describe('readChunks (read-only, pinned to the checked inode)', () => {
  it('streams the file; a changed file is STALE; a failing read is IO; outside the roots is CONTAINMENT', async () => {
    const fx = await buildFixture(one); const sfs = new SafeFs(fx.roots, fx.fs);
    const p = fx.repo('o/a').blobOf('x.gguf'); const facts = (await factsOf(fx.fs, p))!;
    const got: Uint8Array[] = [];
    await sfs.readChunks(p, facts, (c) => { got.push(c); });
    const later: number[] = [];
    await sfs.readChunks(p, facts, async (c) => { await new Promise((r) => setTimeout(r, 1)); later.push(c.length); });
    expect(later.reduce((a, b) => a + b, 0)).toBe(facts.size);   // an async callback is awaited before the read ends
    expect(Buffer.concat(got)).toEqual(await readFile(p));
    await expect(sfs.readChunks(p, { ...facts, size: facts.size + 1 }, () => undefined)).rejects.toEqual(expectCode('STALE'));
    const readFails: FsLike = { ...fx.fs, open: async (q, flags) => handleOf(await fx.fs.open(q, flags), {
      read: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
    }) };
    await expect(new SafeFs(fx.roots, readFails).readChunks(p, facts, () => undefined)).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EIO' }));
    await expect(sfs.readChunks(fx.outside('canary.bin'), facts, () => undefined)).rejects.toEqual(expectCode('CONTAINMENT'));
  });
});

describe('writeFileAtomic keepTmp (download mode : a ref temp that fails is left and reported)', () => {
  it('a failed rename or a STALE check leaves the temp file in place', async () => {
    const fx = await buildFixture(one);
    const refs = join(fx.repo('o/a').folder, 'refs');
    const ref = join(refs, 'main'); const tmp = join(refs, '.main.hfcm-tmp');
    const before = await readFile(ref, 'utf8');
    const sfs = new SafeFs(fx.roots, failingFs(fx.fs, 'rename', 'EIO'));
    await expect(sfs.writeFileAtomic(ref, 'c'.repeat(40), { tmpPath: tmp, keepTmp: true })).rejects.toEqual(expectCode('IO'));
    expect(await readFile(tmp, 'utf8')).toBe('c'.repeat(40));
    expect(await readFile(ref, 'utf8')).toBe(before);
    const tmp2 = join(refs, '.other.hfcm-tmp');
    await expect(new SafeFs(fx.roots, fx.fs).writeFileAtomic(ref, 'd'.repeat(40), { tmpPath: tmp2, keepTmp: true, expect: null }))
      .rejects.toEqual(expectCode('STALE'));
    expect(await readFile(tmp2, 'utf8')).toBe('d'.repeat(40));
    expect(await readFile(ref, 'utf8')).toBe(before);
  });
});
