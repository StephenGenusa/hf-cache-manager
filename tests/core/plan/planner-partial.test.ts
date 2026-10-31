import { basename, dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyRepo } from '../../../src/core/classify/classify';
import { computeFreed } from '../../../src/core/plan/freed';
import { ACTIVE_WINDOW_MS, phaseOf, planCore, type CorePlan, type CoreCtx } from '../../../src/core/plan/planner';
import type { CacheModel, FileFacts, Op, Repo, RepoSelection, Selection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { buildTree, f, groupKeyFor, type RepoSpec, type Tree, type TreeSpec } from '../support/scenarios';

useCanaries();

const repoOf = (m: CacheModel, id: string): Repo => {
  const r = m.repos.find((x) => x.id === id);
  if (!r) throw new Error(`no repo ${id}`);
  return r;
};
const linkFacts = (m: CacheModel, id: string, commit: string, rel: string): FileFacts => {
  const x = repoOf(m, id).files.find((y) => y.commit === commit && y.relpath === rel);
  if (!x) throw new Error(`no file ${commit}/${rel}`);
  return x.facts;
};
const labelOf = (m: CacheModel, id: string, key: string): string =>
  classifyRepo(repoOf(m, id)).groups.find((g) => g.key === key)!.label;
const sel = (repoId: string, groupKeys: string[]): RepoSelection => ({ repoId, whole: false, groupKeys, unlockComponents: false });
const ctxOf = (t: Tree): CoreCtx => ({ mode: 'permanent', hubRoot: t.hub, holdRoot: null, deletionId: null, now: t.now });
const plan = (t: Tree, m: CacheModel, ...repos: RepoSelection[]): CorePlan => planCore(m, { repos } as Selection, ctxOf(t));
/** Selects the groups containing `rels` (any snapshot) in one repo. */
const pick = (m: CacheModel, id: string, ...rels: string[]): RepoSelection =>
  sel(id, [...new Set(rels.map((r) => groupKeyFor(m, id, r)))]);
const sweeps = (core: CorePlan): Array<Extract<Op, { kind: 'store-sweep' }>> =>
  core.ops.filter((o): o is Extract<Op, { kind: 'store-sweep' }> => o.kind === 'store-sweep');
const rmdirs = (core: CorePlan): string[] =>
  core.ops.filter((o): o is Extract<Op, { kind: 'rmdir-empty' }> => o.kind === 'rmdir-empty').map((o) => o.path);
const depth = (p: string): number => p.split(sep).length;

const gguf: RepoSpec = { id: 'o/a', snapshots: { c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } };
/** o/a's Q4 quant lives in the shared store; Q8 is a plain blob so the snapshot dir never empties. */
const storeRepo = (id: string): RepoSpec =>
  ({ id, snapshots: { c1: { 'm-Q4_K_M.gguf': f('store', 'S', 2000), 'm-Q8_0.gguf': f('blob', `Q8${id}`, 8000) } } });

describe('planCore: permanent partial ops', () => {
  it('ops for one quant: unlink link (snapshot-link) then unlink blob (repo-blob) with lstat expect', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    const blob = repoOf(m, 'o/a').blobs[t.etag('Q4', 4000)]!;
    expect(core.ops).toEqual([
      { kind: 'unlink', path: t.link('o/a', 'c1', 'm-Q4_K_M.gguf'), expect: linkFacts(m, 'o/a', 'c1', 'm-Q4_K_M.gguf'), role: 'snapshot-link' },
      { kind: 'unlink', path: t.blob('o/a', 'm-Q4_K_M.gguf'), expect: blob.facts, role: 'repo-blob' } ]);
    expect(core.freed.bytes).toBe(4000);
    expect(core.apparentBytes).toBe(4000);
    expect(core.kept).toEqual([{ repoId: 'o/a', groupKey: groupKeyFor(m, 'o/a', 'm-Q8_0.gguf'), label: expect.any(String), bytes: 8000 }]);
    expect(core.doomedRepoBlobPaths).toEqual([t.blob('o/a', 'm-Q4_K_M.gguf')]);
    expect(core.warnings).toEqual([]);
  });

  it('inv5: ops are phase-ordered (views, links, blobs, store, dirs) and rmdir-empty is deepest first', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: {
        c0: { 'sub/d-Q2_K.gguf': f('blob', 'D', 300) },
        c1: { 'sub/d-Q2_K.gguf': f('blob', 'D', 300), 'm-Q4_K_M.gguf': f('store', 'S', 2000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } },
      { id: 'o/b', snapshots: { c1: { 'deep/er/x-Q4_K_M.gguf': f('store', 'S', 2000), 'x-Q8_0.gguf': f('blob', 'X8', 800) } } } ] });
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'sub/d-Q2_K.gguf', 'm-Q4_K_M.gguf'), pick(m, 'o/b', 'deep/er/x-Q4_K_M.gguf'));
    const phases = core.ops.map(phaseOf);
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
    expect(new Set(phases)).toEqual(new Set([1, 2, 3, 4]));
    const dirs = rmdirs(core);
    for (let i = 1; i < dirs.length; i++) expect(depth(dirs[i - 1]!)).toBeGreaterThanOrEqual(depth(dirs[i]!));
    const snap = (id: string, c: string, ...rest: string[]): string => join(t.folder(id), 'snapshots', c, ...rest);
    expect(new Set(dirs)).toEqual(new Set([
      snap('o/a', 'c0', 'sub'), snap('o/a', 'c0'), snap('o/a', 'c1', 'sub'), snap('o/b', 'c1', 'deep', 'er'), snap('o/b', 'c1', 'deep')]));
    // links: o/a (selection order) before o/b, each sorted by path
    const links = core.ops.filter((o) => phaseOf(o) === 1).map((o) => (o as { path: string }).path);
    expect(links).toEqual([
      ...[t.link('o/a', 'c0', 'sub/d-Q2_K.gguf'), t.link('o/a', 'c1', 'sub/d-Q2_K.gguf'), t.link('o/a', 'c1', 'm-Q4_K_M.gguf')].sort(),
      t.link('o/b', 'c1', 'deep/er/x-Q4_K_M.gguf')]);
    expect(sweeps(core)).toHaveLength(1);
    expect(sweeps(core)[0]!.payload).toBe('delete');
  });

  it('phaseOf maps every op kind and role to its phase', () => {
    const e = { dev: 0, ino: 0, size: 0, mtimeMs: 0, nlink: 1, isSymlink: true, isDirectory: false, isFile: false };
    const u = (role: Extract<Op, { kind: 'unlink' }>['role']): Op => ({ kind: 'unlink', path: '/p', expect: e, role });
    expect([u('view-link'), u('view-manifest'), u('view-blob')].map(phaseOf)).toEqual([0, 0, 0]);
    expect(phaseOf({ kind: 'write-file', path: '/p', before: null, after: '', role: 'view-state' })).toBe(0);
    expect(phaseOf(u('snapshot-link'))).toBe(1);
    expect([u('repo-blob'), u('repo-folder'), u('held-item')].map(phaseOf)).toEqual([2, 2, 2]);
    expect(phaseOf(u('store-payload'))).toBe(3);
    expect(phaseOf({ kind: 'restore-rename', path: '/p', dest: '/d', expect: e, role: 'repo-blob' })).toBe(2);
    expect(phaseOf({ kind: 'restore-rename', path: '/p', dest: '/d', expect: e, role: 'view-link' })).toBe(0);
    expect(phaseOf({ kind: 'hold-rename', path: '/p', dest: '/d', expect: e, role: 'repo-folder' })).toBe(2);
    expect(phaseOf({ kind: 'store-sweep', storePath: '/s', refsPath: '/s.refs', removeRefs: [], expectRefsRaw: [], payload: 'keep', expect: e })).toBe(3);
    expect(phaseOf({ kind: 'store-refs-add', refsPath: '/s.refs', addRefs: [], expectRefsRaw: null })).toBe(3);
    expect(phaseOf({ kind: 'rmdir-empty', path: '/d' })).toBe(4);
  });

  it('emptied snapshot subdir gets rmdir-empty; a still-occupied snapshot dir does not', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: {
      'sub/d-Q2_K.gguf': f('blob', 'D', 300), 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000) } } }] });
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'sub/d-Q2_K.gguf'));
    expect(rmdirs(core)).toEqual([join(t.folder('o/a'), 'snapshots', 'c1', 'sub')]);
    expect(core.ops.at(-1)).toEqual({ kind: 'rmdir-empty', path: join(t.folder('o/a'), 'snapshots', 'c1', 'sub') });
  });

  it('an already-empty snapshot dir with no doomed descendant gets no rmdir-empty', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: {
      'sub/d-Q2_K.gguf': f('blob', 'D', 300), 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000) } } }] });
    const empty = join(t.folder('o/a'), 'snapshots', 'c1', 'empty');
    await t.fs.mkdir(empty);
    const m = await t.scan();
    expect(repoOf(m, 'o/a').snapshotDirs).toContain(empty);
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(rmdirs(core)).toEqual([]);
  });

  it('store sole ref → store-sweep payload delete with exact fields', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const m = await t.scan();
    const storeFile = m.store[t.store('S', 2000)]!;
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(core.ops.at(-1)).toEqual({ kind: 'store-sweep', storePath: t.store('S', 2000), refsPath: t.store('S', 2000) + '.refs',
      removeRefs: [`models--o--a/blobs/${t.etag('S', 2000)}`], expectRefsRaw: [`models--o--a/blobs/${t.etag('S', 2000)}`],
      payload: 'delete', expect: storeFile.facts });
    expect(core.ops.map((o) => o.kind)).toEqual(['unlink', 'unlink', 'store-sweep']);
    expect(core.freed.bytes).toBe(2000);
    expect(core.apparentBytes).toBe(2000);
    expect(core.warnings).toEqual([]);
  });

  it('store shared with another repo → store-sweep payload keep, freed 0', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a'), storeRepo('o/b')] });
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(sweeps(core)).toEqual([{ kind: 'store-sweep', storePath: t.store('S', 2000), refsPath: t.store('S', 2000) + '.refs',
      removeRefs: [`models--o--a/blobs/${t.etag('S', 2000)}`], expectRefsRaw: m.store[t.store('S', 2000)]!.refsRaw,
      payload: 'keep', expect: m.store[t.store('S', 2000)]!.facts }]);
    expect(core.freed).toEqual({ bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-shared', sharedWith: ['o/b'] }] });
    expect(core.apparentBytes).toBe(0); // A kept payload is not counted
  });

  it('two selected repos sharing one store file → one store-sweep with both removeRefs, sorted', async () => {
    const t = await buildTree({ repos: [storeRepo('o/b'), storeRepo('o/a')] });
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/b', 'm-Q4_K_M.gguf'), pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    const s = sweeps(core);
    expect(s).toHaveLength(1);
    expect(s[0]!.removeRefs).toEqual([`models--o--a/blobs/${t.etag('S', 2000)}`, `models--o--b/blobs/${t.etag('S', 2000)}`]);
    expect(s[0]!.payload).toBe('delete');
    expect(core.freed.bytes).toBe(2000);
    expect(core.apparentBytes).toBe(2000);
    // phase 2 follows selection order: o/b's blob before o/a's
    expect(core.ops.filter((o) => phaseOf(o) === 2).map((o) => (o as { path: string }).path))
      .toEqual([t.blob('o/b', 'm-Q4_K_M.gguf'), t.blob('o/a', 'm-Q4_K_M.gguf')]);
  });

  it('store lock present → no store-sweep, 0 store-uncertain, warning mentions the hash', async () => {
    const t = await buildTree({ storeLocks: [{ id: 'S', size: 2000 }], repos: [storeRepo('o/a')] });
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(sweeps(core)).toEqual([]);
    expect(core.freed).toEqual({ bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-uncertain' }] });
    expect(core.warnings).toHaveLength(1);
    expect(core.warnings[0]).toContain(basename(t.store('S', 2000)));
    expect(core.apparentBytes).toBe(0);
    // the repo blob link itself still goes
    expect(core.ops.map((o) => (o as { path: string }).path)).toEqual([t.link('o/a', 'c1', 'm-Q4_K_M.gguf'), t.blob('o/a', 'm-Q4_K_M.gguf')]);
  });

  it('store unmarked or refs missing → no store-sweep op', async () => {
    const unmarked = await buildTree({ storeMarked: false, repos: [storeRepo('o/a')] });
    let m = await unmarked.scan();
    let core = plan(unmarked, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(sweeps(core)).toEqual([]);
    expect(core.freed.bytes).toBe(0);
    expect(core.warnings.some((w) => w.includes(basename(unmarked.store('S', 2000))))).toBe(true);

    const noRefs = await buildTree({ repos: [storeRepo('o/a')] });
    await noRefs.fs.unlink(noRefs.store('S', 2000) + '.refs');
    m = await noRefs.scan();
    core = plan(noRefs, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(sweeps(core)).toEqual([]);
    expect(core.freed.bytes).toBe(0);
    expect(core.warnings.some((w) => w.includes(basename(noRefs.store('S', 2000))))).toBe(true);
  });

  it('a non-RepoBlob link to the payload missing from .refs → no store-sweep op, warning', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a'), { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    const direct = t.link('o/b', 'c1', 'direct.gguf');
    await t.fs.symlink(relative(dirname(direct), t.store('S', 2000)), direct);
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(sweeps(core)).toEqual([]);
    expect(core.freed.bytes).toBe(0);
    expect(core.warnings).toHaveLength(1);
    expect(core.warnings[0]).toContain(basename(t.store('S', 2000)));
  });

  it('active .incomplete elsewhere in the hub (age 60_000) → no store-sweep, warning "download in progress"', async () => {
    const spec = (ageMs: number): TreeSpec => ({ repos: [storeRepo('o/a'),
      { id: 'o/b', incomplete: [{ etag: 'e'.repeat(64), ageMs }], snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    const t = await buildTree(spec(60_000));
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(sweeps(core)).toEqual([]);
    expect(core.freed).toEqual({ bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'store-uncertain' }] });
    expect(core.warnings).toHaveLength(1);
    expect(core.warnings[0]).toContain('download in progress');
    expect(core.warnings[0]).toContain(basename(t.store('S', 2000)));

    // an .incomplete older than the window is not active
    const old = await buildTree(spec(ACTIVE_WINDOW_MS + 60_000));
    const m2 = await old.scan();
    const core2 = plan(old, m2, pick(m2, 'o/a', 'm-Q4_K_M.gguf'));
    expect(sweeps(core2).map((s) => s.payload)).toEqual(['delete']);
    expect(core2.warnings).toEqual([]);
  });

  it('refused links produce a warning "<rel> kept: same content as <other> in unselected group <label>" and a kept entry', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: {
      'm-Q4_K_M.gguf': f('blob', 'SAME', 5000), 'm-Q8_0.gguf': f('blob', 'SAME', 5000) } } }] });
    const m = await t.scan();
    const q4 = groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf');
    const q8 = groupKeyFor(m, 'o/a', 'm-Q8_0.gguf');
    const core = plan(t, m, sel('o/a', [q4]));
    expect(core.ops).toEqual([]);
    expect(core.freed).toEqual({ bytes: 0, lines: [] });
    expect(core.warnings).toEqual([`m-Q4_K_M.gguf kept: same content as m-Q8_0.gguf in unselected group ${labelOf(m, 'o/a', q8)}`]);
    expect(core.kept).toHaveLength(2);
    expect(core.kept).toContainEqual({ repoId: 'o/a', groupKey: q8, label: labelOf(m, 'o/a', q8), bytes: 5000 });
    expect(core.kept).toContainEqual({ repoId: 'o/a', groupKey: q4, label: `${labelOf(m, 'o/a', q4)} (partly kept)`, bytes: 5000 });
  });

  it('an unselected group that loses an older-snapshot link keeps an entry for its remaining files', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'old.gguf': f('blob', 'O', 100) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } }] });
    const m = await t.scan();
    const sup = groupKeyFor(m, 'o/a', 'old.gguf');
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(core.ops.filter((o) => phaseOf(o) === 1)).toHaveLength(2);
    expect(core.kept).toContainEqual({ repoId: 'o/a', groupKey: sup, label: labelOf(m, 'o/a', sup), bytes: 100 });
    expect(core.kept).toContainEqual({ repoId: 'o/a', groupKey: groupKeyFor(m, 'o/a', 'm-Q8_0.gguf'), label: expect.any(String), bytes: 8000 });
    expect(core.kept).toHaveLength(2);
  });

  it('selecting every file of a repo warns to use Delete entire repo', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf', 'm-Q8_0.gguf'));
    expect(core.warnings).toHaveLength(1);
    expect(core.warnings[0]).toContain('o/a');
    expect(core.warnings[0]).toContain('Delete entire repo');
    expect(core.kept).toEqual([]);
    expect(rmdirs(core)).toEqual([]); // the main snapshot root stays
  });

  it('never removes the main snapshot root; its emptied subdirs and emptied non-main roots still go', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'old.gguf': f('blob', 'O', 100) },
      c1: { 'sub/d-Q2_K.gguf': f('blob', 'D', 300), 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000) } } }] });
    const m = await t.scan();
    expect(repoOf(m, 'o/a').mainCommit).toBe('c1');
    const snap = (...rest: string[]): string => join(t.folder('o/a'), 'snapshots', ...rest);
    const main = plan(t, m, pick(m, 'o/a', 'sub/d-Q2_K.gguf', 'm-Q4_K_M.gguf'));
    expect(main.ops.filter((o) => phaseOf(o) === 1)).toHaveLength(2);
    expect(rmdirs(main)).toEqual([snap('c1', 'sub')]);
    const old = plan(t, m, pick(m, 'o/a', 'old.gguf'));
    expect(rmdirs(old)).toEqual([snap('c0')]);
  });

  it('store payload with other hard links → no store-sweep op, warning "other hard links"', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    await t.fs.link(t.store('S', 2000), join(t.root, 'elsewhere'));
    const m = await t.scan();
    expect(m.store[t.store('S', 2000)]!.facts.nlink).toBe(2);
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(sweeps(core)).toEqual([]);
    expect(core.freed).toEqual({ bytes: 0, lines: [{ path: t.store('S', 2000), bytes: 0, reason: 'hardlink-others-remain' }] });
    expect(core.warnings).toEqual([`store payload ${basename(t.store('S', 2000))} kept: it has other hard links`]);
    expect(core.apparentBytes).toBe(0);
  });

  it('freed equals computeFreed(model, doomedRepoBlobPaths, doomed non-blob paths)', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: {
        c0: { 'config.json': f('small', 'CFG', 300) },
        c1: { 'm-Q4_K_M.gguf': f('hardlink', 'H', 3000), 'config.json': f('small', 'CFG', 300), 'README.md': f('plain', 'R', 30),
          'm-Q8_0.gguf': f('store', 'S', 2000), 'm-Q2_K.gguf': f('blob', 'Q2', 200) } } },
      { id: 'o/b', snapshots: { c1: { 'm-Q4_K_M.gguf': f('hardlink', 'H', 3000), 'm-Q8_0.gguf': f('blob', 'B8', 800) } } } ] });
    const m = await t.scan();
    const core = plan(t, m,
      pick(m, 'o/a', 'm-Q4_K_M.gguf', 'config.json', 'README.md', 'm-Q8_0.gguf'), pick(m, 'o/b', 'm-Q4_K_M.gguf'));
    const unlinked = core.ops.filter((o): o is Extract<Op, { kind: 'unlink' }> => o.kind === 'unlink').map((o) => o.path);
    const blobs = new Set(core.doomedRepoBlobPaths);
    expect(core.doomedRepoBlobPaths.every((p) => unlinked.includes(p))).toBe(true);
    expect(core.doomedRepoBlobPaths).toContain(t.blob('o/a', 'config.json')); // 40-hex blob
    expect(core.freed).toEqual(computeFreed(m, core.doomedRepoBlobPaths, unlinked.filter((p) => !blobs.has(p))));
    // hardlink H (both repos, counted once) + config blob + README + store payload
    expect(core.freed.bytes).toBe(3000 + 300 + 30 + 2000);
    // Unique inodes of doomed regular files + deleted payload
    expect(core.apparentBytes).toBe(3000 + 300 + 30 + 2000);
  });

  it('a doomed hardlinked blob whose other link remains counts in apparentBytes but not freed', async () => {
    const t = await buildTree({ repos: [
      { id: 'o/a', snapshots: { c1: { 'm-Q4_K_M.gguf': f('hardlink', 'H', 3000), 'm-Q8_0.gguf': f('blob', 'A8', 80) } } },
      { id: 'o/b', snapshots: { c1: { 'm-Q4_K_M.gguf': f('hardlink', 'H', 3000) } } } ] });
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(core.freed.bytes).toBe(0);
    expect(core.apparentBytes).toBe(3000);
  });

  it('refuses a mismatched hub (hold mode inputs: planner-hold.test.ts)', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const q4 = pick(m, 'o/a', 'm-Q4_K_M.gguf');
    expect(() => planCore(m, { repos: [q4] }, { ...ctxOf(t), mode: 'hold', holdRoot: t.holdRoot, deletionId: 'D', hubRoot: t.hub + '-other' }))
      .toThrow(/hub/);
    expect(() => planCore(m, { repos: [q4] }, { ...ctxOf(t), hubRoot: t.hub + '-other' })).toThrow(/hub/);
  });
});

describe('planCore: store kept warnings (coverage gate)', () => {
  /** o/a's Q4 store link planned alone, on a copy of the scanned model edited by `edit`. */
  async function storeCase(edit: (m: CacheModel, t: Tree) => void, repos: RepoSpec[] = [storeRepo('o/a')], ids = ['o/a']) {
    const t = await buildTree({ repos });
    const m = structuredClone(await t.scan());
    const selection = ids.map((id) => pick(m, id, 'm-Q4_K_M.gguf'));
    edit(m, t);
    return { t, core: plan(t, m, ...selection), name: basename(t.store('S', 2000)) };
  }
  const blobOf = (m: CacheModel, t: Tree, id: string) => repoOf(m, id).blobs[t.etag('S', 2000)]!;

  it('every link to the payload dangling → no sweep and no warning (nothing left to keep)', async () => {
    const { core } = await storeCase((m, t) => { blobOf(m, t, 'o/a').dangling = true; });
    expect(sweeps(core)).toEqual([]);
    expect(core.warnings).toEqual([]);
  });

  it('only some links dangling → warning "a link to it is dangling"', async () => {
    const { core, name } = await storeCase((m, t) => { blobOf(m, t, 'o/b').dangling = true; },
      [storeRepo('o/a'), storeRepo('o/b')], ['o/a', 'o/b']);
    expect(sweeps(core)).toEqual([]);
    expect(core.warnings).toEqual([`store payload ${name} kept: a link to it is dangling`]);
  });

  it('a payload missing from model.store → warning naming the store path (by its basename)', async () => {
    let sp = '';
    const { core, name } = await storeCase((m, t) => { sp = t.store('S', 2000); delete m.store[sp]; });
    expect(sweeps(core)).toEqual([]);
    expect(core.warnings).toEqual([`store payload ${name} kept: ${sp} is not a known store file`]);
  });

  it('exact warnings for unmarked store, missing refs, unvalidated refs and any other uncertainty', async () => {
    const unmarked = await storeCase((m) => { m.storeMarked = false; });
    expect(unmarked.core.warnings).toEqual([`store payload ${unmarked.name} kept: the shared store is not marked as in use`]);
    const noRefs = await storeCase((m, t) => { m.store[t.store('S', 2000)]!.refsRaw = null; });
    expect(noRefs.core.warnings).toEqual([`store payload ${noRefs.name} kept: its .refs file is missing or unreadable`]);
    const unvalidated = await storeCase((m, t) => { m.store[t.store('S', 2000)]!.validRefs = null; });
    expect(sweeps(unvalidated.core)).toEqual([]);
    expect(unvalidated.core.warnings).toEqual([`store payload ${unvalidated.name} kept: its .refs file could not be validated`]);
    const notFile = await storeCase((m, t) => { m.store[t.store('S', 2000)]!.facts.isFile = false; });
    expect(sweeps(notFile.core)).toEqual([]);
    expect(notFile.core.warnings).toEqual([`store payload ${notFile.name} kept: its references are uncertain`]);
  });
});

describe('planCore: kept bytes and crafted models (coverage gate)', () => {
  it('kept group bytes: a link to nothing counts 0, a dangling blob 0, a hardlinked plain pair once', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: {
      'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000), 'm-Q2_K.gguf': f('blob', 'Q2', 200),
      'm-Q6_K-00001-of-00002.gguf': f('plain', 'P1', 70), 'm-Q6_K-00002-of-00002.gguf': f('plain', 'P2', 70) } } }] });
    const m = structuredClone(await t.scan());
    const repo = repoOf(m, 'o/a');
    const file = (rel: string) => repo.files.find((x) => x.relpath === rel)!;
    // A symlink whose first hop is outside the repo (target kind 'other'); its blob is dangling
    Object.assign(file('m-Q8_0.gguf'), { blobEtag: null });
    file('m-Q8_0.gguf').facts.linkTarget = '/nowhere/x';
    repo.blobs[t.etag('Q2', 200)]!.dangling = true;
    // the two Q6 shards are one inode
    const p1 = file('m-Q6_K-00001-of-00002.gguf').facts;
    Object.assign(file('m-Q6_K-00002-of-00002.gguf').facts, { dev: p1.dev, ino: p1.ino });
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    const bytesOf = (rel: string) => core.kept.find((k) => k.groupKey === groupKeyFor(m, 'o/a', rel))!.bytes;
    expect(bytesOf('m-Q8_0.gguf')).toBe(0);
    expect(bytesOf('m-Q2_K.gguf')).toBe(0);
    expect(bytesOf('m-Q6_K-00001-of-00002.gguf')).toBe(70);
  });

  it('an old-revision link to the doomed blob is in no group: it is doomed with the blob and adds no kept entry', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'old.gguf': f('blob', 'Q4', 4000) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } }] });
    const m = await t.scan();
    expect(() => groupKeyFor(m, 'o/a', 'old.gguf')).toThrow('no group contains old.gguf');
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(core.ops.filter((o) => phaseOf(o) === 1)).toHaveLength(2);
    expect(core.kept).toEqual([{ repoId: 'o/a', groupKey: groupKeyFor(m, 'o/a', 'm-Q8_0.gguf'), label: expect.any(String), bytes: 8000 }]);
  });

  it('a repo without refs/main: an emptied snapshot root may go', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = structuredClone(await t.scan());
    repoOf(m, 'o/a').mainCommit = null;
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf', 'm-Q8_0.gguf'));
    expect(rmdirs(core)).toEqual([join(t.folder('o/a'), 'snapshots', 'c1')]);
  });

  it('whole repo: a path listed twice is refused', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = structuredClone(await t.scan());
    const repo = repoOf(m, 'o/a');
    expect(repo.otherFiles.length).toBeGreaterThan(0);
    repo.otherFiles.push(structuredClone(repo.otherFiles[0]!));
    expect(() => plan(t, m, { repoId: 'o/a', whole: true })).toThrow(`planCore: ${repo.otherFiles[0]!.path} is listed twice in o/a`);
  });
});

describe('planCore: boundaries and exact warnings (mutation gate)', () => {
  it('an .incomplete exactly ACTIVE_WINDOW_MS old is no longer active for the store sweep', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a'), { id: 'o/b', incomplete: [{ etag: 'e'.repeat(64), ageMs: 3_600_000 }], snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    const m = structuredClone(await t.scan());
    repoOf(m, 'o/b').incomplete[0]!.mtimeMs = t.now - ACTIVE_WINDOW_MS;
    expect(sweeps(plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'))).map((s) => s.payload)).toEqual(['delete']);
    repoOf(m, 'o/b').incomplete[0]!.mtimeMs = t.now - ACTIVE_WINDOW_MS + 1;
    expect(plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf')).warnings).toEqual([`store payload ${basename(t.store('S', 2000))} kept: download in progress`]);
  });

  it('exact warnings: locked payload; a link the manifest does not know', async () => {
    const locked = await buildTree({ storeLocks: [{ id: 'S', size: 2000 }], repos: [storeRepo('o/a')] });
    const m1 = await locked.scan();
    expect(plan(locked, m1, pick(m1, 'o/a', 'm-Q4_K_M.gguf')).warnings).toEqual([`store payload ${basename(locked.store('S', 2000))} kept: it is locked by another process`]);
    const t = await buildTree({ repos: [storeRepo('o/a'), { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'X', 10) } } }] });
    const direct = t.link('o/b', 'c1', 'direct.gguf');
    await t.fs.symlink(relative(dirname(direct), t.store('S', 2000)), direct);
    const m = await t.scan();
    expect(plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf')).warnings).toEqual([`store payload ${basename(t.store('S', 2000))} kept: linked by o/b without a valid .refs line`]);
  });

  it('a non-main snapshot dir that keeps one file is not rmdir-emptied', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'old.gguf': f('blob', 'O', 100) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } }] });
    const m = await t.scan();
    const core = plan(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(core.ops.filter((o) => phaseOf(o) === 1)).toHaveLength(2);
    expect(rmdirs(core)).toEqual([]);
  });
});

describe('planCore: blobs shared across ref-named and older snapshots', () => {
  /** main=c1; refs/dev=c2; refs/refs/pr/1=c3; c2 and c3 share blob B; c2 and c0 (no ref) share blob D; E only in c2. */
  const refsHub: TreeSpec = { repos: [{ id: 'o/a', main: 'c1', snapshots: {
    c0: { 'old.gguf': f('blob', 'D', 300) },
    c1: { 'a-Q4_K_M.gguf': f('blob', 'A', 1000) },
    c2: { 'shared.gguf': f('blob', 'B', 200), 'olddev.gguf': f('blob', 'D', 300), 'own.gguf': f('blob', 'E', 50) },
    c3: { 'shared.gguf': f('blob', 'B', 200) } },
    extra: { 'refs/dev': 'c2', 'refs/refs/pr/1': 'c3' } }] };

  it('"Files only in dev": only own.gguf goes; b and d are kept with warnings; kept and freed match the ops', async () => {
    const t = await buildTree(refsHub);
    const m = await t.scan();
    const core = plan(t, m, sel('o/a', ['other:Files only in dev']));
    const own = repoOf(m, 'o/a').blobs[t.etag('E', 50)]!;
    expect(core.ops).toEqual([
      { kind: 'unlink', path: t.link('o/a', 'c2', 'own.gguf'), expect: linkFacts(m, 'o/a', 'c2', 'own.gguf'), role: 'snapshot-link' },
      { kind: 'unlink', path: own.path, expect: own.facts, role: 'repo-blob' }]);
    expect(core.doomedRepoBlobPaths).toEqual([own.path]);
    expect(core.freed.bytes).toBe(50);
    expect(core.apparentBytes).toBe(50);
    expect(core.kept).toEqual([
      { repoId: 'o/a', groupKey: groupKeyFor(m, 'o/a', 'a-Q4_K_M.gguf'), label: expect.any(String), bytes: 1000 },
      { repoId: 'o/a', groupKey: 'other:Files only in dev', label: 'Files only in dev (partly kept)', bytes: 500 },
      { repoId: 'o/a', groupKey: 'other:Files only in refs/pr/1', label: 'Files only in refs/pr/1', bytes: 200 },
      { repoId: 'o/a', groupKey: 'superseded:superseded (older revision)', label: 'superseded (older revision)', bytes: 300 }]);
    expect(core.warnings).toEqual([
      'olddev.gguf kept: same content as old.gguf in unselected group superseded (older revision)',
      'shared.gguf kept: same content as shared.gguf in unselected group Files only in refs/pr/1']);
  });

  it('a blocker in no group of a ref-named snapshot, and further places, are named in the warning', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', main: 'c1', snapshots: {
      c0: { 'x.gguf': f('blob', 'X', 10) },
      c1: { 'a-Q4_K_M.gguf': f('blob', 'A', 1000), 'a-Q8_0.gguf': f('blob', 'Q8', 2000) },
      c2: { 'a-Q4_K_M.gguf': f('blob', 'A', 1000), 'x.gguf': f('blob', 'X', 10) },
      c3: { 'x.gguf': f('blob', 'X', 10) } }, extra: { 'refs/dev': 'c2', 'refs/pr': 'c3' } }] });
    const m = await t.scan();
    const core = plan(t, m, sel('o/a', [groupKeyFor(m, 'o/a', 'a-Q4_K_M.gguf'), 'other:Files only in pr']));
    expect(core.ops).toEqual([]);
    expect(core.freed.bytes).toBe(0);
    expect(core.warnings).toEqual([
      'a-Q4_K_M.gguf kept: same content as a-Q4_K_M.gguf in snapshot c2 (dev)',
      'x.gguf kept: same content as x.gguf in unselected group superseded (older revision); also in unselected group Files only in dev']);
  });
});
