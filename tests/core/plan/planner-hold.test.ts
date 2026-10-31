import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { phaseOf, planCore, type CorePlan, type CoreCtx } from '../../../src/core/plan/planner';
import type { CacheModel, FileFacts, Op, Repo, RepoSelection, Selection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { snapshotTree } from '../support/observe';
import { buildTree, f, groupKeyFor, type RepoSpec, type Tree } from '../support/scenarios';

useCanaries();

const D = '2026-10-25T12-00-00-000Z-0a1b2c3d';
const repoOf = (m: CacheModel, id: string): Repo => {
  const r = m.repos.find((x) => x.id === id);
  if (!r) throw new Error(`no repo ${id}`);
  return r;
};
const linkFactsOf = (m: CacheModel, id: string, commit: string, rel: string): FileFacts => {
  const x = repoOf(m, id).files.find((y) => y.commit === commit && y.relpath === rel);
  if (!x) throw new Error(`no file ${commit}/${rel}`);
  return x.facts;
};
const sel = (repoId: string, groupKeys: string[]): RepoSelection => ({ repoId, whole: false, groupKeys, unlockComponents: false });
const pick = (m: CacheModel, id: string, ...rels: string[]): RepoSelection =>
  sel(id, [...new Set(rels.map((r) => groupKeyFor(m, id, r)))]);
const whole = (repoId: string): RepoSelection => ({ repoId, whole: true });
const holdCtx = (t: Tree, deletionId = D): CoreCtx =>
  ({ mode: 'hold', hubRoot: t.hub, holdRoot: t.holdRoot, deletionId, now: t.now });
const permCtx = (t: Tree): CoreCtx => ({ mode: 'permanent', hubRoot: t.hub, holdRoot: null, deletionId: null, now: t.now });
const hold = (t: Tree, m: CacheModel, ...repos: RepoSelection[]): CorePlan => planCore(m, { repos } as Selection, holdCtx(t));
const perm = (t: Tree, m: CacheModel, ...repos: RepoSelection[]): CorePlan => planCore(m, { repos } as Selection, permCtx(t));
type Sweep = Extract<Op, { kind: 'store-sweep' }>;
type HoldRename = Extract<Op, { kind: 'hold-rename' }>;
const sweeps = (core: CorePlan): Sweep[] => core.ops.filter((o): o is Sweep => o.kind === 'store-sweep');
const renames = (core: CorePlan): HoldRename[] => core.ops.filter((o): o is HoldRename => o.kind === 'hold-rename');
const isInside = (p: string, root: string): boolean => p.startsWith(root + sep) && !relative(root, p).split(sep).includes('..');

const gguf: RepoSpec = { id: 'o/a', snapshots: { c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } };
const storeRepo = (id: string): RepoSpec =>
  ({ id, snapshots: { c1: { 'm-Q4_K_M.gguf': f('store', 'S', 2000), 'm-Q8_0.gguf': f('blob', `Q8${id}`, 8000) } } });
const rich: RepoSpec = {
  id: 'o/a',
  snapshots: {
    c0: { 'old.gguf': f('blob', 'O', 100), 'sub/d-Q2_K.gguf': f('blob', 'D2', 300) },
    c1: { 'sub/m.gguf': f('store', 'S', 2000), 'config.json': f('small', 'C', 50), 'README.md': f('plain', 'R', 30) },
  },
  incomplete: [{ etag: 'e'.repeat(64), ageMs: 3_600_000 }],
  extra: { '.no_exist/c1/tokenizer.json': '' },
};

/** Replaces each hold-rename by the unlink it stands for and each 'hold' payload by 'delete'. */
const asPermanent = (ops: Op[]): Op[] => ops.map((o): Op => {
  if (o.kind === 'hold-rename') return { kind: 'unlink', path: o.path, expect: o.expect, role: o.role };
  if (o.kind === 'store-sweep' && o.payload === 'hold') {
    const rest: Op = { ...o, payload: 'delete' };
    delete (rest as { holdDest?: string }).holdDest;
    return rest;
  }
  return o;
});

describe('planCore: hold mode', () => {
  it('partial hold: each link and blob is a hold-rename keeping its layout under <holdRoot>/D/<folderName>/', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const core = hold(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    const linkFacts = linkFactsOf(m, 'o/a', 'c1', 'm-Q4_K_M.gguf');
    const blob = repoOf(m, 'o/a').blobs[t.etag('Q4', 4000)]!;
    expect(core.ops[0]).toEqual({ kind: 'hold-rename', path: t.link('o/a', 'c1', 'm-Q4_K_M.gguf'),
      dest: join(t.holdRoot, D, 'models--o--a', 'snapshots', 'c1', 'm-Q4_K_M.gguf'), expect: linkFacts, role: 'snapshot-link' });
    expect(core.ops).toEqual([
      core.ops[0],
      { kind: 'hold-rename', path: t.blob('o/a', 'm-Q4_K_M.gguf'),
        dest: join(t.holdRoot, D, 'models--o--a', 'blobs', t.etag('Q4', 4000)), expect: blob.facts, role: 'repo-blob' }]);
    expect(core.ops.some((o) => o.kind === 'unlink')).toBe(false);
  });

  it('partial hold: dest is <holdRoot>/D/<folderName>/<path relative to the folder> for every op, nested paths too', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const core = hold(t, m, pick(m, 'o/a', 'sub/d-Q2_K.gguf', 'old.gguf'));
    expect(renames(core).length).toBeGreaterThan(0);
    for (const o of renames(core)) {
      expect(o.dest).toBe(join(t.holdRoot, D, basename(t.folder('o/a')), relative(t.folder('o/a'), o.path)));
      expect(isInside(o.dest, join(t.holdRoot, D))).toBe(true);
    }
    expect(renames(core).map((o) => o.path)).toContain(t.link('o/a', 'c0', 'sub/d-Q2_K.gguf'));
  });

  it('partial hold: store sole ref → store-sweep payload hold, holdDest D/store/<xx>/<hash>', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const m = await t.scan();
    const storeFile = m.store[t.store('S', 2000)]!;
    const core = hold(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(core.ops.map((o) => o.kind)).toEqual(['hold-rename', 'hold-rename', 'store-sweep']);
    expect(core.ops.at(-1)).toEqual({ kind: 'store-sweep', storePath: t.store('S', 2000), refsPath: t.store('S', 2000) + '.refs',
      removeRefs: [`models--o--a/blobs/${t.etag('S', 2000)}`], expectRefsRaw: [`models--o--a/blobs/${t.etag('S', 2000)}`],
      payload: 'hold', holdDest: posix.join(D, 'store', storeFile.hash.slice(0, 2), storeFile.hash), expect: storeFile.facts });
    // holdRoot-relative posix: joined to holdRoot it lands inside <holdRoot>/D/store/
    const dest = sweeps(core)[0]!.holdDest!;
    expect(dest.includes('\\')).toBe(false);
    expect(isInside(join(t.holdRoot, ...dest.split('/')), join(t.holdRoot, D, 'store'))).toBe(true);
    expect(core.freed.bytes).toBe(2000);
    expect(core.apparentBytes).toBe(2000);
    expect(core.warnings).toEqual([]);
  });

  it('partial hold: a store payload shared with another repo stays put (payload keep, no holdDest)', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a'), storeRepo('o/b')] });
    const m = await t.scan();
    const core = hold(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'));
    expect(sweeps(core)).toHaveLength(1);
    expect(sweeps(core)[0]!.payload).toBe('keep');
    expect('holdDest' in sweeps(core)[0]!).toBe(false);
    expect(core.freed.bytes).toBe(0);
  });

  it('partial hold: emptied snapshot dirs are rmdir-empty in the hub', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const core = hold(t, m, pick(m, 'o/a', 'sub/d-Q2_K.gguf', 'old.gguf'));
    const dirs = core.ops.filter((o): o is Extract<Op, { kind: 'rmdir-empty' }> => o.kind === 'rmdir-empty').map((o) => o.path);
    const snap = (...rest: string[]): string => join(t.folder('o/a'), 'snapshots', ...rest);
    expect(dirs).toEqual([snap('c0', 'sub'), snap('c0')]);
    for (const d of dirs) expect(isInside(d, t.hub)).toBe(true);
    expect(core.ops.at(-1)).toEqual({ kind: 'rmdir-empty', path: snap('c0') });
    const phases = core.ops.map(phaseOf);
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
  });

  it('whole-repo hold: exactly one hold-rename of the folder (role repo-folder, expect = folderFacts, isDirectory true) plus store sweeps', async () => {
    const t = await buildTree({ repos: [rich, { id: 'o/n', snapshots: { c1: { 'n.gguf': f('blob', 'N', 70) } } }] });
    const m = await t.scan();
    const repo = repoOf(m, 'o/a');
    const storeFile = m.store[t.store('S', 2000)]!;
    const core = hold(t, m, whole('o/a'));
    expect(core.ops).toEqual([
      { kind: 'hold-rename', path: t.folder('o/a'), dest: join(t.holdRoot, D, 'models--o--a'), expect: repo.folderFacts, role: 'repo-folder' },
      { kind: 'store-sweep', storePath: t.store('S', 2000), refsPath: t.store('S', 2000) + '.refs',
        removeRefs: [`models--o--a/blobs/${t.etag('S', 2000)}`], expectRefsRaw: storeFile.refsRaw, payload: 'hold',
        holdDest: posix.join(D, 'store', storeFile.hash.slice(0, 2), storeFile.hash), expect: storeFile.facts }]);
    expect(repo.folderFacts.isDirectory).toBe(true);
    expect(repo.folderFacts.isSymlink).toBe(false);
    expect(core.ops.map(phaseOf)).toEqual([2, 3]);
  });

  it('whole-repo hold with snapshots/ linked into another repo: one rename of the folder, nothing under o/b', async () => {
    const b: RepoSpec = { id: 'o/b', snapshots: { c1: { 'b.gguf': f('blob', 'B', 400) } } };
    const t = await buildTree({ repos: [rich, b] });
    const p = join(t.folder('o/a'), 'snapshots');
    await t.fs.rename(p, join(t.root, 'parked-snapshots'));
    await t.fs.symlink('../models--o--b/snapshots', p);
    const m = await t.scan();
    const core = hold(t, m, whole('o/a'));
    expect(renames(core).map((o) => o.path)).toEqual([t.folder('o/a')]);
    for (const o of core.ops) {
      const path = o.kind === 'store-sweep' ? o.storePath : (o as { path: string }).path;
      expect(path.startsWith(t.folder('o/b'))).toBe(false);
    }
  });

  it('whole-repo hold keeps the whole-repo guard (fails closed on an entry outside a scanned real dir)', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const repo = repoOf(m, 'o/a');
    const forged = join(t.folder('o/a'), 'snapshots-alias', 'c1', 'x.gguf');
    const bad: CacheModel = { ...m, repos: m.repos.map((r) => (r !== repo ? r : {
      ...r, files: [...r.files, { ...r.files[0]!, linkPath: forged, relpath: 'x.gguf' }] })) };
    expect(() => hold(t, bad, whole('o/a'))).toThrow(forged + ': its parent');
  });

  it('hold and permanent cores have equal freed and apparentBytes', async () => {
    const other: RepoSpec = { id: 'o/b', snapshots: { c1: { 'm.gguf': f('store', 'S', 2000), 'x.gguf': f('hardlink', 'H', 900) } } };
    const t = await buildTree({ repos: [
      { ...rich, snapshots: { ...rich.snapshots, c2: { 'h.gguf': f('hardlink', 'H', 900), 'q-Q4_K_M.gguf': f('store', 'T', 700) } } },
      other, storeRepo('o/c')] });
    const m = await t.scan();
    const cases: RepoSelection[][] = [
      [pick(m, 'o/a', 'sub/d-Q2_K.gguf', 'old.gguf')],
      [pick(m, 'o/a', 'q-Q4_K_M.gguf', 'h.gguf'), pick(m, 'o/c', 'm-Q4_K_M.gguf')],
      [whole('o/a')],
      [whole('o/a'), pick(m, 'o/c', 'm-Q4_K_M.gguf')],
      [whole('o/b'), whole('o/c')],
    ];
    for (const repos of cases) {
      const h = hold(t, m, ...repos);
      const p = perm(t, m, ...repos);
      expect(h.freed).toEqual(p.freed);
      expect(h.apparentBytes).toBe(p.apparentBytes);
      expect(h.kept).toEqual(p.kept);
      expect(h.warnings).toEqual(p.warnings);
      expect(h.doomedRepoBlobPaths).toEqual(p.doomedRepoBlobPaths);
      // hold sweeps mirror permanent ones, with every 'delete' payload held instead
      expect(sweeps(h).map((s) => s.payload)).toEqual(sweeps(p).map((s) => (s.payload === 'delete' ? 'hold' : s.payload)));
      if (repos.some((r) => r.whole)) continue;
      // a partial hold plan is the permanent plan with each unlink replaced by a hold-rename
      expect(asPermanent(h.ops)).toEqual(p.ops);
    }
  });

  it('a hold plan never contains unlink or a store-sweep with payload delete; every dest is inside <holdRoot>/D', async () => {
    const t = await buildTree({ repos: [rich, storeRepo('o/c')] });
    const m = await t.scan();
    for (const repos of [[whole('o/a'), pick(m, 'o/c', 'm-Q4_K_M.gguf')], [pick(m, 'o/a', 'sub/m.gguf', 'old.gguf')]]) {
      const core = hold(t, m, ...repos);
      expect(core.ops.some((o) => o.kind === 'unlink')).toBe(false);
      expect(sweeps(core).some((s) => s.payload === 'delete')).toBe(false);
      for (const o of renames(core)) expect(isInside(o.dest, join(t.holdRoot, D))).toBe(true);
      for (const s of sweeps(core)) {
        if (s.payload === 'hold') expect(isInside(join(t.holdRoot, ...s.holdDest!.split('/')), join(t.holdRoot, D, 'store'))).toBe(true);
        else expect(s.holdDest).toBeUndefined();
      }
    }
  });

  it('a permanent plan still never contains hold ops even when ctx carries a holdRoot', async () => {
    const t = await buildTree({ repos: [rich] });
    const m = await t.scan();
    const core = planCore(m, { repos: [whole('o/a')] }, { ...holdCtx(t), mode: 'permanent' });
    expect(core.ops.some((o) => o.kind === 'hold-rename' || (o.kind === 'store-sweep' && o.payload === 'hold'))).toBe(false);
    const before = await snapshotTree(t.folder('o/a'), t.fs);
    expect(core.ops.filter((o) => o.kind === 'unlink')).toHaveLength([...before.values()].filter((e) => e.type !== 'dir').length);
  });

  it('hold mode without holdRoot throws', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const s: Selection = { repos: [pick(m, 'o/a', 'm-Q4_K_M.gguf')] };
    const msg = 'hold mode needs holdRoot and deletionId';
    expect(() => planCore(m, s, { ...holdCtx(t), holdRoot: null })).toThrow(msg);
    expect(() => planCore(m, s, { ...holdCtx(t), deletionId: null })).toThrow(msg);
    expect(() => planCore(m, s, { ...holdCtx(t), holdRoot: '' })).toThrow(msg);
    expect(() => planCore(m, s, { ...holdCtx(t), deletionId: '' })).toThrow(msg);
  });

  it('hold mode refuses a deletionId that is not a single plain path segment', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const s: Selection = { repos: [pick(m, 'o/a', 'm-Q4_K_M.gguf')] };
    for (const bad of ['.', '..', 'a/b', 'a\\b', '../x', '/abs']) {
      expect(() => planCore(m, s, holdCtx(t, bad))).toThrow(/deletionId/);
    }
  });

  it('hold mode refuses a relative holdRoot', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const s: Selection = { repos: [pick(m, 'o/a', 'm-Q4_K_M.gguf')] };
    expect(() => planCore(m, s, { ...holdCtx(t), holdRoot: 'relative/hold' })).toThrow(/holdRoot/);
  });
});

describe('planCore hold: guards on crafted models (coverage gate)', () => {
  it('a link outside its repo folder, or a folder whose name escapes the deletion folder, is refused', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const q4 = pick(m, 'o/a', 'm-Q4_K_M.gguf');
    const outside = structuredClone(m);
    const link = repoOf(outside, 'o/a').files.find((x) => x.relpath === 'm-Q4_K_M.gguf')!;
    link.linkPath = join(t.root, 'elsewhere', 'm-Q4_K_M.gguf');
    expect(() => hold(t, outside, q4)).toThrow(`planCore: ${link.linkPath} is not inside its repo folder ${t.folder('o/a')}`);
    // a folder ending in '..' resolves to the hub: every path is "inside" it, but the dest leaves <holdRoot>/D
    const dotdot = structuredClone(m);
    repoOf(dotdot, 'o/a').folder = t.folder('o/a') + sep + '..';
    expect(() => hold(t, dotdot, q4)).toThrow(`is not inside ${join(t.holdRoot, D)}`);
  });

  it('a store payload whose hash is not its file name is refused for a hold', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const m = structuredClone(await t.scan());
    const sp = t.store('S', 2000);
    m.store[sp]!.hash = 'ab';
    expect(() => hold(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'))).toThrow(`planCore: store payload ${sp} is not at <hub>/blobs/<xx>/<hash>`);
    // same prefix and length, different name: only the name check refuses
    const other = basename(sp).slice(0, 2) + (basename(sp).slice(2, 3) === 'f' ? 'e' : 'f') + basename(sp).slice(3);
    m.store[sp]!.hash = other;
    expect(() => hold(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'))).toThrow(`planCore: store payload ${sp} is not at <hub>/blobs/<xx>/<hash>`);
  });

  it('a store payload of another hub is refused for a hold', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const m = structuredClone(await t.scan());
    const sp = t.store('S', 2000);
    const alien = join(t.root, 'other-hub', 'blobs', basename(dirname(sp)), basename(sp));
    m.store[alien] = { ...m.store[sp]!, path: alien, refsPath: alien + '.refs', refsRaw: [], validRefs: [] }; // unreferenced there
    delete m.store[sp];
    for (const b of Object.values(repoOf(m, 'o/a').blobs)) if (b.storePath === sp) b.storePath = alien;
    expect(() => perm(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'))).not.toThrow();
    expect(() => hold(t, m, pick(m, 'o/a', 'm-Q4_K_M.gguf'))).toThrow(`planCore: store payload ${alien} is not at <hub>/blobs/<xx>/<hash>`);
  });

  it('whole-repo hold refuses a repo folder that is not a real directory', async () => {
    const t = await buildTree({ repos: [gguf] });
    const symlinked = structuredClone(await t.scan());
    repoOf(symlinked, 'o/a').folderFacts.isSymlink = true;
    expect(() => hold(t, symlinked, whole('o/a'))).toThrow(`planCore: repo folder ${t.folder('o/a')} is not a real directory`);
    const file = structuredClone(await t.scan());
    repoOf(file, 'o/a').folderFacts.isDirectory = false;
    expect(() => hold(t, file, whole('o/a'))).toThrow('is not a real directory');
    expect(() => perm(t, file, whole('o/a'))).not.toThrow();
  });
});
