import { basename, dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeFreed, refLine, storeDoubt } from '../../../src/core/plan/freed';
import type { CacheModel, Repo } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { bytesFreedIfRemoved, snapshotTree } from '../support/observe';
import { buildTree, f, scanTolerant, type Tree } from '../support/scenarios';

useCanaries();

const repoOf = (m: CacheModel, id: string): Repo => {
  const r = m.repos.find((x) => x.id === id);
  if (!r) throw new Error(`no repo ${id}`);
  return r;
};
/** Every non-dir path of a repo, split the way the planner splits them. */
function wholeRepo(m: CacheModel, id: string): { blobs: string[]; links: string[] } {
  const r = repoOf(m, id);
  const HEX40 = /^[0-9a-f]{40}$/;
  const blobsDir = join(r.folder, 'blobs');
  const blobs = Object.values(r.blobs).map((b) => b.path);
  const links = r.files.map((x) => x.linkPath);
  for (const o of r.otherFiles) {
    if (dirname(o.path) === blobsDir && HEX40.test(o.path.slice(blobsDir.length + 1))) blobs.push(o.path);
    else links.push(o.path);
  }
  return { blobs, links };
}
const storeTree = (): Promise<Tree> => buildTree({ repos: [
  { id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } },
  { id: 'o/b', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } } ] });

describe('refLine', () => {
  it('is the posix path relative to the hub', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 20) } } }] });
    expect(refLine(t.hub, t.blob('o/a', 's.gguf'))).toBe(`models--o--a/blobs/${t.etag('S', 20)}`);
    expect(() => refLine(t.hub, '/elsewhere/x')).toThrow();
  });
});

describe('computeFreed: regular files', () => {
  it('sole regular blob: size, only-link', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'q.gguf': f('blob', 'Q', 4000) } } }] });
    const m = await t.scan();
    const blob = t.blob('o/a', 'q.gguf');
    expect(computeFreed(m, [blob], [t.link('o/a', 'c1', 'q.gguf')])).toEqual({
      bytes: 4000, lines: [{ path: blob, bytes: 4000, reason: 'only-link' }],
    });
  });

  it('hardlinked across repos, one planned: 0, hardlink-others-remain, sharedWith [o/b]', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 'm.gguf': f('hardlink', 'H', 3000) } } },
      { id: 'o/b', snapshots: { c1: { 'm.gguf': f('hardlink', 'H', 3000) } } } ] });
    const m = await t.scan();
    const blob = t.blob('o/a', 'm.gguf');
    expect(computeFreed(m, [blob], [])).toEqual({
      bytes: 0, lines: [{ path: blob, bytes: 0, reason: 'hardlink-others-remain', sharedWith: ['o/b'] }],
    });
  });

  it('hardlinked across repos, both planned: counted once, hardlink-all-planned', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 'm.gguf': f('hardlink', 'H', 3000) } } },
      { id: 'o/b', snapshots: { c1: { 'm.gguf': f('hardlink', 'H', 3000) } } } ] });
    const m = await t.scan();
    const [p1, p2] = [t.blob('o/a', 'm.gguf'), t.blob('o/b', 'm.gguf')].sort();
    expect(computeFreed(m, [p2!, p1!], [])).toEqual({ bytes: 3000, lines: [
      { path: p1, bytes: 3000, reason: 'hardlink-all-planned' },
      { path: p2, bytes: 0, reason: 'hardlink-all-planned' },
    ] });
  });

  it('hardlink to a file outside the model: 0, sharedWith []', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'q.gguf': f('blob', 'Q', 4000) } } }] });
    const blob = t.blob('o/a', 'q.gguf');
    await t.fs.link(blob, join(t.root, 'elsewhere'));
    const m = await t.scan();
    expect(computeFreed(m, [blob], [])).toEqual({
      bytes: 0, lines: [{ path: blob, bytes: 0, reason: 'hardlink-others-remain', sharedWith: [] }],
    });
  });

  it('plain snapshot file: size, plain-file', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'p.txt': f('plain', 'P', 500) } } }] });
    const m = await t.scan();
    const p = t.link('o/a', 'c1', 'p.txt');
    expect(computeFreed(m, [], [p])).toEqual({ bytes: 500, lines: [{ path: p, bytes: 500, reason: 'plain-file' }] });
  });

  it('40-hex blob from otherFiles: size, only-link; its snapshot link adds no line', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 't.json': f('small', 'T', 40) } } }] });
    const m = await t.scan();
    const blob = t.blob('o/a', 't.json');
    expect(repoOf(m, 'o/a').otherFiles.map((o) => o.path)).toContain(blob);
    expect(computeFreed(m, [blob], [t.link('o/a', 'c1', 't.json')])).toEqual({
      bytes: 40, lines: [{ path: blob, bytes: 40, reason: 'only-link' }],
    });
  });

  it('symlink snapshot link to a doomed blob adds no line; a link to a non-blob target adds 0 link-only', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', outsideDirLink: 'ext',
      snapshots: { c1: { 'q.gguf': f('blob', 'Q', 4000) } } }] });
    const m = await t.scan();
    const blob = t.blob('o/a', 'q.gguf');
    const ext = t.link('o/a', 'c1', 'ext');
    expect(computeFreed(m, [blob], [t.link('o/a', 'c1', 'q.gguf'), ext])).toEqual({ bytes: 4000, lines: [
      { path: blob, bytes: 4000, reason: 'only-link' },
      { path: ext, bytes: 0, reason: 'link-only' },
    ].sort((a, b) => (a.path < b.path ? -1 : 1)) });
    // the link alone (its blob not doomed) frees nothing
    expect(computeFreed(m, [], [t.link('o/a', 'c1', 'q.gguf')])).toEqual({ bytes: 0, lines: [
      { path: t.link('o/a', 'c1', 'q.gguf'), bytes: 0, reason: 'link-only' } ] });
  });

  it('duplicate inputs count once; bytes equals sum of line bytes; lines sorted by path', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: {
      'q.gguf': f('blob', 'Q', 4000), 'r.gguf': f('blob', 'R', 300), 'p.txt': f('plain', 'P', 50) } } }] });
    const m = await t.scan();
    const q = t.blob('o/a', 'q.gguf');
    const r = t.blob('o/a', 'r.gguf');
    const p = t.link('o/a', 'c1', 'p.txt');
    const out = computeFreed(m, [r, q, r, q], [p, p]);
    expect(out.bytes).toBe(4350);
    expect(out.bytes).toBe(out.lines.reduce((s, l) => s + l.bytes, 0));
    expect(out.lines.map((l) => l.path)).toEqual([q, r, p].sort());
    expect(new Set(out.lines.map((l) => l.path)).size).toBe(out.lines.length);
  });

  it('whole repo: .incomplete counted once, matches the observed bytes released', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', extra: { 'refs/dev': 'abc' },
      incomplete: [{ etag: 'e1', ageMs: 60 * 60_000 }],
      snapshots: { c1: { 'q.gguf': f('blob', 'Q', 4000), 'p.txt': f('plain', 'P', 50), 't.json': f('small', 'T', 40) } } }] });
    const m = await t.scan();
    const { blobs, links } = wholeRepo(m, 'o/a');
    const out = computeFreed(m, blobs, links);
    const observed = bytesFreedIfRemoved(await snapshotTree(t.hub, t.fs), t.folder('o/a'));
    expect(out.bytes).toBe(observed);
    expect(out.lines.filter((l) => l.path.endsWith('.incomplete'))).toEqual([
      { path: join(t.folder('o/a'), 'blobs', 'e1.incomplete'), bytes: 16, reason: 'only-link' } ]);
  });

  it('unknown path throws', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'q.gguf': f('blob', 'Q', 10) } } }] });
    const m = await t.scan();
    expect(() => computeFreed(m, ['/nope'], [])).toThrow('computeFreed: unknown path /nope');
    expect(() => computeFreed(m, [], ['/nope'])).toThrow('computeFreed: unknown path /nope');
    expect(() => computeFreed(m, [t.store('Q', 10)], [])).toThrow('computeFreed: unknown path');
  });
});

describe('computeFreed: shared store', () => {
  it('store sole ref: store-unreferenced, line path is the store payload', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } }] });
    const m = await t.scan();
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [t.link('o/a', 'c1', 's.gguf')])).toEqual({
      bytes: 2000, lines: [{ path: t.store('S', 2000), bytes: 2000, reason: 'store-unreferenced' }],
    });
  });

  it('store ref of another repo: 0, store-shared, sharedWith [o/b]', async () => {
    const t = await storeTree();
    const m = await t.scan();
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [])).toEqual({
      bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-shared', sharedWith: ['o/b'] }],
    });
  });

  it('another repo links the payload but .refs lacks its line (check 1): 0, store-uncertain, sharedWith [o/b]', async () => {
    const t = await storeTree();
    await t.fs.writeFile(t.store('S', 2000) + '.refs', `models--o--a/blobs/${t.etag('S', 2000)}\n`);
    const m = await t.scan();
    expect(repoOf(m, 'o/b').blobs[t.etag('S', 2000)]!.storePath).toBe(t.store('S', 2000));
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [])).toEqual({
      bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-uncertain', sharedWith: ['o/b'] }],
    });
  });

  it('store ref of another repo that is not a RepoBlob: 0, store-shared, sharedWith [o/b]', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } },
      { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } } ] });
    // a non-64-hex link in o/b/blobs that .refs names: a valid reference, invisible as a RepoBlob
    const alias = join(t.folder('o/b'), 'blobs', 'alias');
    await t.fs.symlink(relative(dirname(alias), t.store('S', 2000)), alias);
    await t.fs.writeFile(t.store('S', 2000) + '.refs', `models--o--a/blobs/${t.etag('S', 2000)}\nmodels--o--b/blobs/alias\n`);
    const m = await t.scan();
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [])).toEqual({
      bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-shared', sharedWith: ['o/b'] }],
    });
  });

  it('a non-RepoBlob link in another repo\'s blobs/ to the payload, missing from .refs: kept, 0 store bytes', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } },
      { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } } ] });
    const alias = join(t.folder('o/b'), 'blobs', 'alias');
    await t.fs.symlink(relative(dirname(alias), t.store('S', 2000)), alias);
    const m = await t.scan();
    expect(m.store[t.store('S', 2000)]!.validRefs).toEqual([`models--o--a/blobs/${t.etag('S', 2000)}`]);
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [t.link('o/a', 'c1', 's.gguf')])).toEqual({
      bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-uncertain', sharedWith: ['o/b'] }],
    });
  });

  it('a snapshot link pointing straight into the store (not via blobs/), missing from .refs: kept, 0 store bytes', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } },
      { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } } ] });
    const direct = t.link('o/b', 'c1', 'direct.gguf');
    await t.fs.symlink(relative(dirname(direct), t.store('S', 2000)), direct);
    const m = await t.scan();
    expect(repoOf(m, 'o/b').files.find((x) => x.linkPath === direct)!.blobEtag).toBeNull();
    const out = computeFreed(m, [t.blob('o/a', 's.gguf')], []);
    expect(out.bytes).toBe(0);
    expect(out.lines).toEqual([{ path: t.store('S', 2000), bytes: 0, reason: 'store-uncertain', sharedWith: ['o/b'] }]);
    // the same link doomed too: nothing else reaches the payload, so it is freed
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [direct]).lines).toContainEqual(
      { path: t.store('S', 2000), bytes: 2000, reason: 'store-unreferenced' });
  });

  it('sharedWith never lists a doomed link and is omitted when empty (store-shared kept by a doomed .refs link)', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } }] });
    const alias = join(t.folder('o/a'), 'blobs', 'alias');
    await t.fs.symlink(relative(dirname(alias), t.store('S', 2000)), alias);
    await t.fs.writeFile(t.store('S', 2000) + '.refs', `models--o--a/blobs/${t.etag('S', 2000)}\nmodels--o--a/blobs/alias\n`);
    const m = await t.scan();
    const out = computeFreed(m, [t.blob('o/a', 's.gguf')], [alias]);
    expect(out.bytes).toBe(0);
    expect(out.lines).toContainEqual({ path: t.store('S', 2000), bytes: 0, reason: 'store-shared' });
  });

  it('both repos planned: payload counted once', async () => {
    const t = await storeTree();
    const m = await t.scan();
    expect(computeFreed(m, [t.blob('o/a', 's.gguf'), t.blob('o/b', 's.gguf')], [])).toEqual({
      bytes: 2000, lines: [{ path: t.store('S', 2000), bytes: 2000, reason: 'store-unreferenced' }],
    });
  });

  it('stale .refs line naming a repo blob that is no longer a store link does not keep the payload', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } },
      { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } } ] });
    await t.fs.writeFile(t.store('S', 2000) + '.refs',
      `models--o--a/blobs/${t.etag('S', 2000)}\nmodels--o--b/blobs/${t.etag('X', 10)}\n`);
    const m = await t.scan();
    expect(m.store[t.store('S', 2000)]!.refsRaw).toHaveLength(2);
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [])).toEqual({
      bytes: 2000, lines: [{ path: t.store('S', 2000), bytes: 2000, reason: 'store-unreferenced' }],
    });
  });

  it('refs missing → 0 store-uncertain', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } }] });
    await t.fs.unlink(t.store('S', 2000) + '.refs');
    const m = await t.scan();
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [])).toEqual({
      bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-uncertain' }],
    });
  });

  it('marker absent → 0 store-uncertain', async () => {
    const t = await buildTree({ storeMarked: false,
      repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } }] });
    const m = await t.scan();
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [])).toEqual({
      bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-uncertain' }],
    });
  });

  it('store lock present → 0 store-uncertain', async () => {
    const t = await buildTree({ storeLocks: [{ id: 'S', size: 2000 }],
      repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } }] });
    const m = await t.scan();
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [])).toEqual({
      bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-uncertain' }],
    });
  });

  it('dangling store link → 0 store-uncertain, line path is the repo blob; never counts RepoBlob.size', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } }] });
    await t.fs.unlink(t.store('S', 2000));
    const m = await scanTolerant(t);
    const blob = t.blob('o/a', 's.gguf');
    expect(repoOf(m, 'o/a').blobs[t.etag('S', 2000)]!.dangling).toBe(true);
    expect(computeFreed(m, [blob], [])).toEqual({ bytes: 0, lines: [{ path: blob, bytes: 0, reason: 'store-uncertain' }] });
  });

  it('store payload with nlink 2 → 0 hardlink-others-remain', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } }] });
    await t.fs.link(t.store('S', 2000), join(t.root, 'elsewhere'));
    const m = await t.scan();
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [])).toEqual({
      bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'hardlink-others-remain' }],
    });
  });

  it('alias fixture: a repo blob linking the payload via an aliased path, with no .refs line, keeps it', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } },
      { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } } ] });
    const store = t.store('S', 2000);
    const aliasDir = join(t.root, 'alias-dir');
    await t.fs.symlink(dirname(store), aliasDir);
    const aliasBlob = join(t.folder('o/b'), 'blobs', t.etag('S', 2000));
    await t.fs.symlink(join(aliasDir, basename(store)), aliasBlob);
    const m = await t.scan();
    const rb = repoOf(m, 'o/b').blobs[t.etag('S', 2000)]!;
    expect(rb.dangling).toBe(false);
    expect(rb.storePath).not.toBe(store);
    expect(m.store[store]!.validRefs).toEqual([`models--o--a/blobs/${t.etag('S', 2000)}`]); // .refs alone says deletable
    const out = computeFreed(m, [t.blob('o/a', 's.gguf')], [t.link('o/a', 'c1', 's.gguf')]);
    expect(out.bytes).toBe(0);
    expect(out.lines).toEqual([{ path: store, bytes: 0, reason: 'store-uncertain' }]);
  });
});

describe('computeFreed: non-RepoBlob links that may reach the payload by another route (check 3)', () => {
  /** o/a holds store S (doomed below); o/b holds a plain blob plus whatever `extra` adds to its snapshot c1. */
  async function aliasCase(extra: (t: Tree, store: string, link: string) => Promise<void>): Promise<{ t: Tree; m: CacheModel }> {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } },
      { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } } ] });
    await extra(t, t.store('S', 2000), t.link('o/b', 'c1', 'alias.gguf'));
    return { t, m: await scanTolerant(t) };
  }
  const doomS = (t: Tree, m: CacheModel) => computeFreed(m, [t.blob('o/a', 's.gguf')], [t.link('o/a', 'c1', 's.gguf')]);
  const kept = (t: Tree) => ({ bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-uncertain' }] });

  it('(a) absolute linkTarget through a symlinked alias of the hub path → kept', async () => {
    const { t, m } = await aliasCase(async (t, store, link) => {
      const hubAlias = join(t.root, 'hub-alias');
      await t.fs.symlink(t.hub, hubAlias);
      await t.fs.symlink(join(hubAlias, relative(t.hub, store)), link);
    });
    expect(doomS(t, m)).toEqual(kept(t));
  });

  it('(b) first hop through a symlinked directory → kept', async () => {
    const { t, m } = await aliasCase(async (t, store, link) => {
      const dirAlias = join(t.root, 'dir-alias');
      await t.fs.symlink(dirname(store), dirAlias);
      await t.fs.symlink(join(dirAlias, basename(store)), link);
    });
    expect(doomS(t, m)).toEqual(kept(t));
  });

  it("(b') snapshot entry that is a dir symlink into the store prefix dir → kept", async () => {
    const { t, m } = await aliasCase(async (t, store, link) => {
      await t.fs.symlink(relative(dirname(link), dirname(store)), link);
    });
    expect(doomS(t, m)).toEqual(kept(t));
  });

  it('(c) link to a symlink outside the model that points at the payload → kept', async () => {
    const { t, m } = await aliasCase(async (t, store, link) => {
      const hop = join(t.root, 'outside-link');
      await t.fs.symlink(store, hop);
      await t.fs.symlink(hop, link);
    });
    expect(doomS(t, m)).toEqual(kept(t));
  });

  it('no false positive: a dangling normal snapshot link to blobs/<missing etag> in another repo does not block', async () => {
    const { t, m } = await aliasCase(async (t, _store, link) => {
      await t.fs.symlink(join('..', '..', 'blobs', 'f'.repeat(64)), link);
    });
    expect(doomS(t, m)).toEqual({ bytes: 2000, lines: [
      { path: t.store('S', 2000), bytes: 2000, reason: 'store-unreferenced' }] });
  });

  it('accepted conservative cost: a snapshot link to an external regular file (outside the hub) blocks every sweep', async () => {
    const { t, m } = await aliasCase(async (t, _store, link) => {
      const ext = join(t.root, 'external.bin');
      await t.fs.writeFile(ext, 'x');
      await t.fs.symlink(ext, link);
    });
    expect(doomS(t, m)).toEqual(kept(t));
    expect(storeDoubt(m, m.store[t.store('S', 2000)]!, [t.blob('o/a', 's.gguf')])).toContain(t.link('o/b', 'c1', 'alias.gguf'));
  });
});

describe('storeDoubt', () => {
  it('null when no non-doomed RepoBlob reaches the payload', async () => {
    const t = await storeTree();
    const m = await t.scan();
    const s = m.store[t.store('S', 2000)]!;
    expect(storeDoubt(m, s, new Set([t.blob('o/a', 's.gguf'), t.blob('o/b', 's.gguf')]))).toBeNull();
  });

  it('null when a non-doomed RepoBlob with storePath === store.path is among validRefs (normal sharing)', async () => {
    const t = await storeTree();
    const m = await t.scan();
    expect(storeDoubt(m, m.store[t.store('S', 2000)]!, new Set([t.blob('o/a', 's.gguf')]))).toBeNull();
  });

  it('a warning naming the hash when a non-doomed RepoBlob has storePath === store.path but no valid ref', async () => {
    const t = await storeTree();
    await t.fs.writeFile(t.store('S', 2000) + '.refs', `models--o--a/blobs/${t.etag('S', 2000)}\n`);
    const m = await t.scan();
    const s = m.store[t.store('S', 2000)]!;
    const w = storeDoubt(m, s, new Set([t.blob('o/a', 's.gguf')]));
    expect(w).toContain(s.hash);
    expect(w).toContain('o/b');
  });

  it('a warning when any non-doomed, non-dangling RepoBlob has a storePath outside model.store; dangling ones are ignored', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 's.gguf': f('store', 'S', 2000) } } },
      { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } } ] });
    const other = join(t.root, 'other-file');
    await t.fs.writeFile(other, 'x');
    const blobsB = join(t.folder('o/b'), 'blobs');
    await t.fs.symlink(join(t.root, 'missing'), join(blobsB, 'a'.repeat(64)));
    let m = await scanTolerant(t);
    const doomed = new Set([t.blob('o/a', 's.gguf')]);
    expect(storeDoubt(m, m.store[t.store('S', 2000)]!, doomed)).toBeNull(); // dangling: ignored
    await t.fs.symlink(other, join(blobsB, 'b'.repeat(64)));
    m = await scanTolerant(t);
    const w = storeDoubt(m, m.store[t.store('S', 2000)]!, doomed);
    expect(w).toContain(m.store[t.store('S', 2000)]!.hash);
    expect(computeFreed(m, [...doomed], []).bytes).toBe(0);
  });
});

describe('computeFreed / storeDoubt: crafted models (coverage gate)', () => {
  it('a link whose text could not be read: doomed alone it is 0 link-only; elsewhere it doubts the payload', async () => {
    const t = await storeTree();
    const m = structuredClone(await t.scan());
    const linkA = repoOf(m, 'o/a').files[0]!;
    linkA.blobEtag = null;
    delete linkA.facts.linkTarget;
    expect(computeFreed(m, [], [linkA.linkPath])).toEqual({ bytes: 0, lines: [{ path: linkA.linkPath, bytes: 0, reason: 'link-only' }] });
    const linkB = repoOf(m, 'o/b').files[0]!;
    delete linkB.facts.linkTarget;
    const store = m.store[t.store('S', 2000)]!;
    expect(storeDoubt(m, store, [t.blob('o/a', 's.gguf'), linkA.linkPath]))
      .toBe(`store payload ${store.hash} kept: o/b has a link ${linkB.linkPath} -> (unreadable) that may reach it`);
  });

  it('a valid ref of a folder the model has no repo for keeps the payload shared, with no sharedWith', async () => {
    const t = await storeTree();
    const m = structuredClone(await t.scan());
    m.repos = m.repos.filter((r) => r.id !== 'o/b');
    expect(computeFreed(m, [t.blob('o/a', 's.gguf')], [])).toEqual({
      bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-shared' }],
    });
  });
});
