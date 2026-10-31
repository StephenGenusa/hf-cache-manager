import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyRepo } from '../../../src/core/classify/classify';
import { PlanError } from '../../../src/core/plan/closure';
import { computeFreed } from '../../../src/core/plan/freed';
import { phaseOf, planCore, type CorePlan, type CoreCtx } from '../../../src/core/plan/planner';
import type { CacheModel, Op, Repo, RepoSelection, Selection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { bytesFreedIfRemoved, snapshotTree, uniqueInodeBytes } from '../support/observe';
import { buildTree, f, groupKeyFor, type RepoSpec, type Tree } from '../support/scenarios';

useCanaries();

const repoOf = (m: CacheModel, id: string): Repo => {
  const r = m.repos.find((x) => x.id === id);
  if (!r) throw new Error(`no repo ${id}`);
  return r;
};
const whole = (repoId: string): RepoSelection => ({ repoId, whole: true });
const ctxOf = (t: Tree): CoreCtx => ({ mode: 'permanent', hubRoot: t.hub, holdRoot: null, deletionId: null, now: t.now });
const plan = (t: Tree, m: CacheModel, ...repos: RepoSelection[]): CorePlan => planCore(m, { repos } as Selection, ctxOf(t));
type Unlink = Extract<Op, { kind: 'unlink' }>;
const unlinks = (core: CorePlan): Unlink[] => core.ops.filter((o): o is Unlink => o.kind === 'unlink');
const rmdirs = (core: CorePlan): string[] =>
  core.ops.filter((o): o is Extract<Op, { kind: 'rmdir-empty' }> => o.kind === 'rmdir-empty').map((o) => o.path);
const sweeps = (core: CorePlan): Array<Extract<Op, { kind: 'store-sweep' }>> =>
  core.ops.filter((o): o is Extract<Op, { kind: 'store-sweep' }> => o.kind === 'store-sweep');
const fsPaths = (core: CorePlan): string[] =>
  core.ops.filter((o) => o.kind === 'unlink' || o.kind === 'rmdir-empty').map((o) => (o as { path: string }).path);
const roleAt = (core: CorePlan, path: string): string | undefined => unlinks(core).find((o) => o.path === path)?.role;

const rich: RepoSpec = {
  id: 'o/a',
  snapshots: {
    c0: { 'old.gguf': f('blob', 'O', 100) },
    c1: { 'sub/m.gguf': f('store', 'S', 2000), 'config.json': f('small', 'C', 50), 'README.md': f('plain', 'R', 30) },
  },
  incomplete: [{ etag: 'e'.repeat(64), ageMs: 3_600_000 }],
  extra: { '.no_exist/c1/tokenizer.json': '' },
};
/** A neighbour repo sharing nothing with o/a: the plan must not touch it. */
const neighbour: RepoSpec = { id: 'o/n', snapshots: { c1: { 'n.gguf': f('blob', 'N', 70) } } };

describe('planCore: whole-repo permanent enumeration', () => {
  it('inv2: op paths equal every entry in the repo folder plus the folder itself, each exactly once', async () => {
    const t = await buildTree({ repos: [rich, neighbour] });
    const m = await t.scan();
    const folder = t.folder('o/a');
    const before = await snapshotTree(folder, t.fs); // excludes the root itself
    const core = plan(t, m, whole('o/a'));
    const paths = fsPaths(core);
    expect(new Set(paths)).toEqual(new Set([...before.keys(), folder]));
    expect(paths).toHaveLength(before.size + 1); // no path twice
    expect(core.ops.filter((o) => o.kind === 'rmdir-empty').at(-1)).toEqual({ kind: 'rmdir-empty', path: folder });
    expect(core.ops.at(-1)).toEqual({ kind: 'rmdir-empty', path: folder });
    // directories go only through rmdir-empty, everything else only through unlink
    for (const o of core.ops) {
      if (o.kind === 'unlink') expect(before.get(o.path)!.type).not.toBe('dir');
      if (o.kind === 'rmdir-empty' && o.path !== folder) expect(before.get(o.path)!.type).toBe('dir');
    }
  });

  it('inv2: every rmdir-empty comes after every op on paths beneath it; dirs deepest first', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const core = plan(t, m, whole('o/a'));
    const paths = core.ops.map((o) => ('path' in o ? o.path : null));
    core.ops.forEach((o, i) => {
      if (o.kind !== 'rmdir-empty') return;
      paths.forEach((p, j) => {
        if (p !== null && p.startsWith(o.path + sep)) expect(j).toBeLessThan(i);
      });
    });
    const dirs = rmdirs(core);
    const depth = (p: string): number => p.split(sep).length;
    for (let i = 1; i < dirs.length; i++) expect(depth(dirs[i - 1]!)).toBeGreaterThanOrEqual(depth(dirs[i]!));
    const phases = core.ops.map(phaseOf);
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
  });

  it('inv2: no hold-rename and no op on a directory other than rmdir-empty', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const core = plan(t, m, whole('o/a'));
    expect(new Set(core.ops.map((o) => o.kind))).toEqual(new Set(['unlink', 'store-sweep', 'rmdir-empty']));
    for (const o of unlinks(core)) expect(o.expect.isDirectory).toBe(false);
    expect(core.ops.some((o) => o.kind === 'unlink' && o.path === t.folder('o/a'))).toBe(false);
  });

  it('a symlinked directory in a snapshot is unlinked, never traversed', async () => {
    const t = await buildTree({ repos: [{ ...rich, outsideDirLink: 'ext' }] });
    const m = await t.scan();
    const core = plan(t, m, whole('o/a'));
    const ext = t.link('o/a', 'c1', 'ext');
    const op = unlinks(core).find((o) => o.path === ext);
    expect(op).toMatchObject({ kind: 'unlink', path: ext, role: 'snapshot-link' });
    expect(op!.expect.isSymlink).toBe(true);
    expect(fsPaths(core).filter((p) => p.startsWith(ext + sep) || p.includes('outside-dir'))).toEqual([]);
    const before = await snapshotTree(t.folder('o/a'), t.fs);
    expect(new Set(fsPaths(core))).toEqual(new Set([...before.keys(), t.folder('o/a')]));
  });

  it('refs/main and .no_exist entries use role repo-folder; 40-hex blobs and .incomplete under blobs/ use repo-blob', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const repo = repoOf(m, 'o/a');
    const folder = t.folder('o/a');
    const core = plan(t, m, whole('o/a'));
    expect(roleAt(core, join(folder, 'refs', 'main'))).toBe('repo-folder');
    expect(roleAt(core, join(folder, '.no_exist', 'c1', 'tokenizer.json'))).toBe('repo-folder');
    expect(roleAt(core, t.blob('o/a', 'config.json'))).toBe('repo-blob'); // 40-hex
    expect(roleAt(core, join(folder, 'blobs', 'e'.repeat(64) + '.incomplete'))).toBe('repo-blob');
    expect(roleAt(core, t.blob('o/a', 'old.gguf', 'c0'))).toBe('repo-blob'); // 64-hex regular
    expect(roleAt(core, t.blob('o/a', 'sub/m.gguf'))).toBe('repo-blob'); // 64-hex store link
    for (const x of repo.files) expect(roleAt(core, x.linkPath)).toBe('snapshot-link');
    // every unlink carries the scanned lstat facts as its expectation
    const factsAt = new Map<string, unknown>([
      ...repo.files.map((x) => [x.linkPath, x.facts] as const),
      ...Object.values(repo.blobs).map((b) => [b.path, b.facts] as const),
      ...repo.otherFiles.map((o) => [o.path, o.facts] as const)]);
    for (const o of unlinks(core)) expect(o.expect).toEqual(factsAt.get(o.path));
    // phase 2 lists blobs/ entries and other files sorted by path
    const p2 = core.ops.filter((o) => phaseOf(o) === 2).map((o) => (o as Unlink).path);
    expect(p2).toEqual([...p2].sort());
    expect(core.doomedRepoBlobPaths).toEqual(
      [...Object.values(repo.blobs).map((b) => b.path), t.blob('o/a', 'config.json')].sort());
  });

  it('whole repo needs no unlock even for a diffusers pipeline; kept is empty', async () => {
    const pipeline: RepoSpec = { id: 'o/p', snapshots: { c1: {
      'model_index.json': f('plain', 'MI', 10), 'vae/diffusion_pytorch_model.safetensors': f('blob', 'V', 100),
      'flux.safetensors': f('blob', 'F', 200) } } };
    const t = await buildTree({ repos: [pipeline] });
    await t.fs.writeFile(t.link('o/p', 'c1', 'model_index.json'), JSON.stringify({ _class_name: 'P', vae: ['diffusers', 'AutoencoderKL'] }));
    const m = await t.scan();
    const core = plan(t, m, whole('o/p'));
    expect(core.kept).toEqual([]);
    expect(core.warnings).toEqual([]);
    expect(unlinks(core).map((o) => o.path)).toContain(t.link('o/p', 'c1', 'vae/diffusion_pytorch_model.safetensors'));
    const before = await snapshotTree(t.folder('o/p'), t.fs);
    expect(new Set(fsPaths(core))).toEqual(new Set([...before.keys(), t.folder('o/p')]));
  });

  it('store-linked blobs in the whole repo produce store-sweep ops (delete when sole ref)', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const core = plan(t, m, whole('o/a'));
    const store = m.store[t.store('S', 2000)]!;
    expect(sweeps(core)).toEqual([{ kind: 'store-sweep', storePath: t.store('S', 2000), refsPath: t.store('S', 2000) + '.refs',
      removeRefs: [`models--o--a/blobs/${t.etag('S', 2000)}`], expectRefsRaw: store.refsRaw, payload: 'delete', expect: store.facts }]);
    const before = await snapshotTree(t.folder('o/a'), t.fs);
    // freed = every inode wholly inside the folder + the swept payload
    expect(core.freed.bytes).toBe(bytesFreedIfRemoved(before, t.folder('o/a')) + 2000);
    const blobSet = new Set(core.doomedRepoBlobPaths);
    expect(core.freed).toEqual(computeFreed(m, core.doomedRepoBlobPaths, unlinks(core).map((o) => o.path).filter((p) => !blobSet.has(p))));
    // Unique-inode sizes of doomed regular files (incl. refs, .incomplete, .no_exist) + the deleted payload
    expect(core.apparentBytes).toBe(uniqueInodeBytes(before) + 2000);
  });

  it('store payload shared with another repo → store-sweep payload keep, not counted', async () => {
    const other: RepoSpec = { id: 'o/b', snapshots: { c1: { 'm.gguf': f('store', 'S', 2000) } } };
    const t = await buildTree({ repos: [rich, other] });
    const m = await t.scan();
    const core = plan(t, m, whole('o/a'));
    expect(sweeps(core).map((s) => s.payload)).toEqual(['keep']);
    const before = await snapshotTree(t.folder('o/a'), t.fs);
    expect(core.apparentBytes).toBe(uniqueInodeBytes(before));
    expect(core.freed.bytes).toBe(bytesFreedIfRemoved(before, t.folder('o/a')));
  });

  it('removes the main snapshot root too (the partial-plan guard does not apply)', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const repo = repoOf(m, 'o/a');
    const core = plan(t, m, whole('o/a'));
    expect(rmdirs(core)).toContain(join(t.folder('o/a'), 'snapshots', repo.mainCommit!));
    expect(rmdirs(core)).toContain(join(t.folder('o/a'), 'snapshots'));
    expect(rmdirs(core)).toContain(join(t.folder('o/a'), 'blobs'));
  });

  it('mixes a whole repo with a partial selection: each repo keeps its own rules', async () => {
    const gguf: RepoSpec = { id: 'o/b', snapshots: { c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 400), 'm-Q8_0.gguf': f('blob', 'Q8', 800) } } };
    const t = await buildTree({ repos: [rich, gguf] });
    const m = await t.scan();
    const core = plan(t, m,
      { repoId: 'o/b', whole: false, groupKeys: [groupKeyFor(m, 'o/b', 'm-Q4_K_M.gguf')], unlockComponents: false }, whole('o/a'));
    const before = await snapshotTree(t.folder('o/a'), t.fs);
    const inA = fsPaths(core).filter((p) => p === t.folder('o/a') || p.startsWith(t.folder('o/a') + sep));
    expect(new Set(inA)).toEqual(new Set([...before.keys(), t.folder('o/a')]));
    const inB = fsPaths(core).filter((p) => p.startsWith(t.folder('o/b') + sep) || p === t.folder('o/b'));
    expect(inB.sort()).toEqual([t.link('o/b', 'c1', 'm-Q4_K_M.gguf'), t.blob('o/b', 'm-Q4_K_M.gguf')].sort());
    expect(core.ops.at(-1)).toEqual({ kind: 'rmdir-empty', path: t.folder('o/a') });
    expect(core.kept.every((k) => k.repoId === 'o/b')).toBe(true);
    const phases = core.ops.map(phaseOf);
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
  });

  it('guard: refuses a model whose enumerated entry does not sit under a scanned real directory, naming the entry', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const repo = repoOf(m, 'o/a');
    const forged = join(t.folder('o/a'), 'snapshots-alias', 'c1', 'x.gguf');
    const bad: CacheModel = { ...m, repos: m.repos.map((r) => (r !== repo ? r : {
      ...r, files: [...r.files, { ...r.files[0]!, linkPath: forged, relpath: 'x.gguf' }] })) };
    expect(() => plan(t, bad, whole('o/a'))).toThrow(forged + ': its parent');
    expect(() => plan(t, bad, whole('o/a'))).toThrow(/is not a real directory of the repo folder/);
  });
});

/** Moves `<folder>/<name>` out of the hub, then replaces it with a symlink to `target` (relative to the folder). */
async function relink(t: Tree, id: string, name: string, target: string): Promise<void> {
  const p = join(t.folder(id), name);
  await t.fs.rename(p, join(t.root, `parked-${name}`));
  await t.fs.symlink(target, p);
}
const b: RepoSpec = { id: 'o/b', snapshots: { c1: { 'b-Q4_K_M.gguf': f('blob', 'B4', 400), 'b-Q8_0.gguf': f('blob', 'B8', 800) } } };
const underB = (t: Tree, p: string): boolean => p === t.folder('o/b') || p.startsWith(t.folder('o/b') + sep);

describe('planCore: symlinked repo subfolders are links, never traversed', () => {
  it('whole repo with snapshots/ linked into another repo: only the link is unlinked (repo-folder), o/b untouched', async () => {
    const t = await buildTree({ repos: [rich, b] });
    await relink(t, 'o/a', 'snapshots', '../models--o--b/snapshots');
    const m = await t.scan();
    const beforeB = await snapshotTree(t.folder('o/b'), t.fs);
    const core = plan(t, m, whole('o/a'));
    const link = join(t.folder('o/a'), 'snapshots');
    expect(roleAt(core, link)).toBe('repo-folder');
    expect(fsPaths(core).filter((p) => p.startsWith(link + sep))).toEqual([]);
    expect(fsPaths(core).filter((p) => underB(t, p))).toEqual([]);
    expect(rmdirs(core)).not.toContain(link);
    const before = await snapshotTree(t.folder('o/a'), t.fs);
    expect(new Set(fsPaths(core))).toEqual(new Set([...before.keys(), t.folder('o/a')]));
    expect(await snapshotTree(t.folder('o/b'), t.fs)).toEqual(beforeB);
  });

  it('whole repo with blobs/ linked into another repo: only the link is unlinked (repo-folder), o/b untouched', async () => {
    const t = await buildTree({ repos: [rich, b] });
    await relink(t, 'o/a', 'blobs', '../models--o--b/blobs');
    const m = await t.scan();
    const beforeB = await snapshotTree(t.folder('o/b'), t.fs);
    const core = plan(t, m, whole('o/a'));
    const link = join(t.folder('o/a'), 'blobs');
    expect(roleAt(core, link)).toBe('repo-folder');
    expect(fsPaths(core).filter((p) => p.startsWith(link + sep))).toEqual([]);
    expect(fsPaths(core).filter((p) => underB(t, p))).toEqual([]);
    expect(sweeps(core)).toEqual([]);
    const before = await snapshotTree(t.folder('o/a'), t.fs);
    expect(new Set(fsPaths(core))).toEqual(new Set([...before.keys(), t.folder('o/a')]));
    expect(await snapshotTree(t.folder('o/b'), t.fs)).toEqual(beforeB);
  });

  it('partial plan with snapshots/ linked into another repo: o/a has no groups, so no op can touch o/b', async () => {
    const t = await buildTree({ repos: [rich, b] });
    await relink(t, 'o/a', 'snapshots', '../models--o--b/snapshots');
    const m = await t.scan();
    expect(repoOf(m, 'o/a').files).toEqual([]);
    expect(classifyRepo(repoOf(m, 'o/a')).groups).toEqual([]);
    for (const g of classifyRepo(repoOf(m, 'o/b')).groups) {
      let err: unknown = null;
      try {
        plan(t, m, { repoId: 'o/a', whole: false, groupKeys: [g.key], unlockComponents: false });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).code).toBe('UNKNOWN_GROUP');
    }
  });
});
