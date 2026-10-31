import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyRepo } from '../../../src/core/classify/classify';
import { useCanaries } from '../../helpers/canary';
import { scriptedFs } from '../../helpers/failing-fs';
import { bytesFreedIfRemoved, danglingLinks, diffTrees, snapshotTree, uniqueInodeBytes } from './observe';
import { buildTree, f, groupKeyFor, scanTolerant, tolerantFs } from './scenarios';
import { GuardedFsViolation } from '../../helpers/guarded-fs';
import { lmstudioViews, stubViews } from './stub-views';

useCanaries();

describe('buildTree', () => {
  it('hardlink files share one inode across repos', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 'm.gguf': f('hardlink', 'H', 3000) } } },
      { id: 'o/b', snapshots: { c1: { 'm.gguf': f('hardlink', 'H', 3000) } } } ] });
    const m = await t.scan();
    const [a, b] = m.repos.map((r) => Object.values(r.blobs)[0]!.facts);
    expect(a!.ino).toBe(b!.ino);
    expect(a!.nlink).toBe(2);
    const tree = await snapshotTree(t.hub);
    // hub-wide totals also include the fixture canary and refs/main files, so measure the blobs dirs
    expect(uniqueInodeBytes(tree, join(t.folder('o/a'), 'blobs'))).toBe(3000);
    expect(uniqueInodeBytes(tree, join(t.folder('o/b'), 'blobs'))).toBe(3000);
  });

  it('store files carry one .refs line per repo blob', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'm.gguf': f('store', 'S', 2000) } } }] });
    expect(await readFile(t.store('S', 2000) + '.refs', 'utf8')).toBe(`models--o--a/blobs/${t.etag('S', 2000)}\n`);
    expect(await readFile(join(t.hub, 'blobs', '.huggingface-shared-blobs'), 'utf8')).toBe('1\n');
    const m = await t.scan();
    expect(m.storeMarked).toBe(true);
    expect(Object.keys(m.store)).toEqual([t.store('S', 2000)]);
  });

  it('content, etag and store hash follow the content rules', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: {
      'b.bin': f('blob', 'B', 10), 's.gguf': f('store', 'S', 7), 'p.txt': f('plain', 'P', 5), 'tiny.json': f('small', 'T', 4) } } }] });
    const bytes = (id: string, n: number): string => `${id}|`.repeat(n).slice(0, n);
    expect(await readFile(t.blob('o/a', 'b.bin'), 'utf8')).toBe(bytes('B', 10));
    expect(t.etag('B', 10)).toBe(createHash('sha256').update(bytes('B', 10)).digest('hex'));
    expect(t.store('S', 7).endsWith(createHash('sha256').update('xet:' + bytes('S', 7)).digest('hex'))).toBe(true);
    expect(await readFile(t.link('o/a', 'c1', 'p.txt'), 'utf8')).toBe(bytes('P', 5));
    expect(t.etag('T', 4)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('exposes roots, lockDir, appData and the guarded fs', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    expect(t.hub).toBe(t.roots.hubRoot);
    expect(t.roots.viewRoots).toEqual([t.lmstudioRoot]);
    expect(t.roots.holdRoot).toBe(t.holdRoot);
    expect((await t.fs.lstat(t.holdRoot)).isDirectory()).toBe(true);
    expect(t.lockDir).toBe(join(dirname(t.hub), '.hf-cache-manager'));
    expect((await t.fs.lstat(t.appData)).isDirectory()).toBe(true);
    await expect(t.fs.writeFile('/etc/hfcm-nope', 'x')).rejects.toThrow(/guardedFs/);
  });

  it('incomplete blobs get mtime = now - ageMs, extra files and storeMarked=false apply', async () => {
    const t = await buildTree({ storeMarked: false, repos: [{ id: 'o/a', extra: { 'refs/dev': 'abc' },
      incomplete: [{ etag: 'e1', ageMs: 5 * 60_000 }],
      snapshots: { c1: { 's.gguf': f('store', 'S', 20) } } }] });
    const m = await t.scan();
    expect(m.storeMarked).toBe(false);
    expect(await readFile(join(t.folder('o/a'), 'refs', 'dev'), 'utf8')).toBe('abc');
    const inc = m.repos[0]!.incomplete[0]!;
    expect(inc.path).toBe(join(t.folder('o/a'), 'blobs', 'e1.incomplete'));
    expect(Math.abs(t.now - inc.mtimeMs - 5 * 60_000)).toBeLessThan(2000);
  });

  it('main defaults to the last snapshot; lmstudio links resolve to the repo blob', async () => {
    const t = await buildTree({
      repos: [{ id: 'o/a', snapshots: { c1: { 'm.gguf': f('blob', 'A', 11) }, c2: { 'm.gguf': f('blob', 'B', 12) } } }],
      lmstudio: [{ rel: 'pub/a/m.gguf', repo: 'o/a', file: 'm.gguf' }],
    });
    const m = await t.scan();
    expect(m.repos[0]!.mainCommit).toBe('c2');
    const link = join(t.lmstudioRoot, 'pub', 'a', 'm.gguf');
    expect((await t.fs.readlink(link))).toBe(t.blob('o/a', 'm.gguf'));
    expect(t.blob('o/a', 'm.gguf', 'c1')).toBe(join(t.folder('o/a'), 'blobs', t.etag('A', 11)));
  });

  it('groupKeyFor finds the classified group of a file', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'a-Q4_K_M.gguf': f('blob', 'Q', 50) } } }] });
    const m = await t.scan();
    const key = groupKeyFor(m, 'o/a', 'a-Q4_K_M.gguf');
    expect(classifyRepo(m.repos[0]!).groups.map((g) => g.key)).toContain(key);
    expect(() => groupKeyFor(m, 'o/a', 'nope')).toThrow();
  });

  it('scanTolerant scans a dangling store link that t.scan() refuses', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 9) } } }] });
    await t.fs.unlink(t.store('S', 9));
    await expect(t.scan()).rejects.toBeInstanceOf(GuardedFsViolation);
    const m = await scanTolerant(t);
    expect(m.repos[0]!.blobs[t.etag('S', 9)]).toMatchObject({ dangling: true, size: 0 });
  });

  it('tolerantFs stat still rejects every other guarded-fs refusal', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    const fs = tolerantFs(t);
    await expect(fs.stat('relative/x')).rejects.toBeInstanceOf(GuardedFsViolation);
    await expect(fs.stat(`${t.hub}/../hub`)).rejects.toBeInstanceOf(GuardedFsViolation);
    await expect(fs.stat(t.blob('o/a', 'x.gguf'))).resolves.toMatchObject({ size: 10 });
    await expect(fs.stat(join(t.hub, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' }); // the real OS error
  });

  it('storeLocks writes a .lock beside the store payload', async () => {
    const t = await buildTree({ storeLocks: [{ id: 'S', size: 9 }],
      repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 9) } } }] });
    expect((await t.fs.lstat(t.store('S', 9) + '.lock')).isFile()).toBe(true);
  });
});

describe('observe', () => {
  it('snapshotTree never follows a symlinked directory', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', outsideDirLink: 'ext', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    const tree = await snapshotTree(t.hub);
    expect(tree.get(t.link('o/a', 'c1', 'ext'))!.type).toBe('symlink');
    expect([...tree.keys()].some((p) => p.startsWith(t.link('o/a', 'c1', 'ext') + sep))).toBe(false);
  });

  it('bytesFreedIfRemoved counts an inode only when all its links are inside the subtree', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 'm.gguf': f('hardlink', 'H', 3000), 'p.gguf': f('blob', 'P', 100) } } },
      { id: 'o/b', snapshots: { c1: { 'm.gguf': f('hardlink', 'H', 3000) } } } ] });
    const tree = await snapshotTree(t.hub);
    expect(bytesFreedIfRemoved(tree, t.folder('o/a'))).toBe(100 + 2); // + refs/main ('c1')
    expect(bytesFreedIfRemoved(tree, t.folder('o/b'))).toBe(2); // refs/main only; the shared inode has a link in o/a
    expect(bytesFreedIfRemoved(tree, t.hub)).toBe(uniqueInodeBytes(tree, t.hub));
    expect(uniqueInodeBytes(tree, t.folder('o/a'))).toBe(3102);
  });

  it('danglingLinks lists symlinks whose target is gone', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    expect(await danglingLinks(t.hub)).toEqual([]);
    await t.fs.unlink(t.blob('o/a', 'x.gguf'));
    expect(await danglingLinks(t.hub)).toEqual([t.link('o/a', 'c1', 'x.gguf')]);
  });

  it("diffTrees ignoreIno 'dirs+links' tolerates recreated dirs and links but not files", async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    const before = await snapshotTree(t.hub);
    const link = t.link('o/a', 'c1', 'x.gguf');
    const target = await t.fs.readlink(link);
    await t.fs.symlink(target, link + '.new'); // both exist, so the new inode differs
    await t.fs.rename(link + '.new', link);
    expect(diffTrees(before, await snapshotTree(t.hub)).changed).toEqual([link]);
    expect(diffTrees(before, await snapshotTree(t.hub), { ignoreIno: 'dirs+links' })).toEqual({ removed: [], added: [], changed: [] });
    const blob = t.blob('o/a', 'x.gguf');
    await t.fs.unlink(blob);
    await t.fs.writeFile(blob, 'tampered!!');
    expect(diffTrees(before, await snapshotTree(t.hub), { ignoreIno: 'dirs+links' }).changed).toEqual([blob]);
  });
});

describe('stub views', () => {
  it('stubViews records doomed paths and returns the configured ops and lines', async () => {
    const line = { view: 'lmstudio' as const, path: 'a', action: 'remove' as const };
    const v = stubViews({ lines: [line] });
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    expect(await v.impactFor(await t.scan(), ['/p1', '/p2'])).toEqual({ ops: [], lines: [line] });
    expect(v.calls).toEqual([['/p1', '/p2']]);
  });

  it('lmstudioViews unlinks every symlink whose target text equals a doomed path', async () => {
    const t = await buildTree({
      repos: [{ id: 'o/a', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10), 'y.gguf': f('blob', 'Y', 11) } } }],
      lmstudio: [{ rel: 'p/x.gguf', repo: 'o/a', file: 'x.gguf' }, { rel: 'p/y.gguf', repo: 'o/a', file: 'y.gguf' }],
    });
    const r = await lmstudioViews(t.lmstudioRoot, t.fs).impactFor(await t.scan(), [t.blob('o/a', 'x.gguf')]);
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]).toMatchObject({ kind: 'unlink', path: join(t.lmstudioRoot, 'p', 'x.gguf'), role: 'view-link' });
    expect(r.lines).toEqual([{ view: 'lmstudio', path: 'p/x.gguf', action: 'remove' }]);
  });
});

describe('scriptedFs', () => {
  it('fails the nth matching call with the given code and records calls', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10), 'y.gguf': f('blob', 'Y', 11) } } }] });
    const fs = scriptedFs(t.fs, [{ method: 'unlink', nth: 2, code: 'EACCES', pathIncludes: 'snapshots' }]);
    const a = t.link('o/a', 'c1', 'x.gguf');
    const b = t.link('o/a', 'c1', 'y.gguf');
    await fs.unlink(t.blob('o/a', 'x.gguf')); // does not match pathIncludes
    await fs.unlink(a); // 1st match passes
    await expect(fs.unlink(b)).rejects.toMatchObject({ code: 'EACCES' }); // 2nd fails
    await fs.unlink(b); // only the nth fails
    expect(fs.calls.map((c) => c.method)).toEqual(['unlink', 'unlink', 'unlink', 'unlink']);
    expect(fs.calls[2]!.args[0]).toBe(b);
  });
});
