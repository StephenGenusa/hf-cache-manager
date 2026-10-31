import { existsSync } from 'node:fs';
import { appendFile, link, lstat, mkdir, readFile, rename, symlink, truncate, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executePlan, isViewOp, sameFacts, type ExecDeps } from '../../../src/core/exec/executor';
import { STALE_MESSAGE } from '../../../src/core/exec/errors';
import { Journal } from '../../../src/core/exec/journal';
import { AppLock } from '../../../src/core/exec/lock';
import { factsOf, type ReadFs } from '../../../src/core/fsx';
import { fingerprintPlan } from '../../../src/core/plan/fingerprint';
import { planDeletion } from '../../../src/core/plan/planner';
import { SafeFs } from '../../../src/core/safe-fs';
import type { CacheModel, DeletionPlan, FileFacts, Op, OpRole, PlanPair, RepoSelection, Selection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { scriptedFs } from '../../helpers/failing-fs';
import { diffTrees, snapshotTree } from '../support/observe';
import { buildTree, f, groupKeyFor, type RepoSpec, type Tree, type TreeSpec } from '../support/scenarios';
import { lmstudioViews, stubViews } from '../support/stub-views';

useCanaries();

const Q4 = 'm-Q4_K_M.gguf';
const gguf = (id: string, extra: Partial<RepoSpec> = {}): RepoSpec => ({
  id,
  snapshots: { c1: { [Q4]: f('blob', `Q4${id}`, 4000), 'm-Q8_0.gguf': f('blob', `Q8${id}`, 8000), 'config.json': f('small', `cfg${id}`, 30) } },
  ...extra,
});
const part = (m: CacheModel, id: string, rel = Q4): RepoSelection =>
  ({ repoId: id, whole: false, groupKeys: [groupKeyFor(m, id, rel)], unlockComponents: false });
const whole = (repoId: string): RepoSelection => ({ repoId, whole: true });
const EMPTY_DIFF = { removed: [], added: [], changed: [] };

interface Ctx { t: Tree; m: CacheModel; pair: PlanPair }

async function setup(
  repos: RepoSpec[] = [gguf('o/a'), gguf('o/b')],
  pick: (m: CacheModel) => RepoSelection[] = (m) => [part(m, 'o/a')],
  spec: Partial<TreeSpec> = {},
  views?: (t: Tree) => Parameters<typeof planDeletion>[0]['views'],
): Promise<Ctx> {
  const t = await buildTree({ repos, ...spec });
  const m = await t.scan();
  const selection: Selection = { repos: pick(m) };
  const pair = await planDeletion({ model: m, selection, roots: t.roots, views: views ? views(t) : stubViews(), now: t.now });
  return { t, m, pair };
}

/** A copy of `plan` with `patch` applied and a fingerprint recomputed for the new content. */
function forge(plan: DeletionPlan, patch: Partial<DeletionPlan>): DeletionPlan {
  const p = { ...structuredClone(plan), ...patch };
  return { ...p, fingerprint: fingerprintPlan(p) };
}

function deps(t: Tree, plan: DeletionPlan, extra: Partial<ExecDeps> = {}): Promise<ExecDeps> {
  return SafeFs.create(t.roots, t.fs).then((safeFs) => {
    let n = 0;
    return {
      safeFs, fs: t.fs, journal: new Journal(t.appData, () => t.now), lock: new AppLock(t.lockDir),
      rescan: () => t.scan(), now: () => t.now,
      diskFree: async () => (n++ === 0 ? 1e12 : 1e12 + plan.freed.bytes),
      ...extra,
    };
  });
}
const run = async (t: Tree, plan: DeletionPlan, extra: Partial<ExecDeps> = {}) => executePlan(plan, await deps(t, plan, extra));

/** `<holdRoot>/<deletionId>` of the setup's hold plan, created: a restore or empty plan works in an existing one. */
async function holdDirFor(t: Tree, pair: PlanPair): Promise<string> {
  const d = join(t.holdRoot, pair.hold!.deletionId!);
  await mkdir(d, { recursive: true });
  return d;
}
/** A hold-mode restore plan of `ops` in the setup's deletion (shape). */
const restoreOf = (pair: PlanPair, ops: Op[]): DeletionPlan => forge(pair.hold!, { purpose: 'restore', selection: null, ops });
/** A permanent empty plan of `ops` in the setup's deletion (shape). */
const emptyOf = (pair: PlanPair, ops: Op[]): DeletionPlan =>
  forge(pair.permanent, { purpose: 'empty', selection: null, holdRoot: pair.hold!.holdRoot, deletionId: pair.hold!.deletionId, ops });

/** Paths a permanent plan removes from disk. */
const opPaths = (plan: DeletionPlan): string[] => plan.ops.map((o) => ('path' in o ? o.path : o.kind === 'store-sweep' ? o.storePath : o.refsPath));
const journalLines = async (t: Tree): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(t.appData, 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const inside = (p: string, root: string): boolean => p.startsWith(root + sep);

describe('executePlan: apply', () => {
  it('permanent: applies ops in order, tree diff equals plan paths, result fields, diskFree from deps.diskFree(hubRoot)', async () => {
    const { t, pair } = await setup();
    const before = await snapshotTree(t.root);
    const asked: string[] = [];
    let n = 0;
    const r = await run(t, pair.permanent, { diskFree: async (p) => { asked.push(p); return n++ === 0 ? 5_000 : 9_000; } });
    const after = await snapshotTree(t.root);
    expect(r).toMatchObject({
      ok: true, planId: pair.permanent.id, appliedOps: pair.permanent.ops.length,
      freedBytesPlanned: pair.permanent.freed.bytes, heldBytes: 0, diskFreeBefore: 5_000, diskFreeAfter: 9_000,
    });
    expect(r.error).toBeUndefined();
    expect(asked).toEqual([t.hub, t.hub]);
    expect(diffTrees(before, after).removed.sort()).toEqual(opPaths(pair.permanent).sort());
    expect(existsSync(join(t.lockDir, 'app.lock'))).toBe(false); // released
  });

  it('permanent whole repo: the folder and everything in it is gone, the other repo is byte-identical', async () => {
    const { t, pair } = await setup(undefined, () => [whole('o/a')]);
    const beforeB = await snapshotTree(t.folder('o/b'));
    const r = await run(t, pair.permanent);
    expect(r).toMatchObject({ ok: true, appliedOps: pair.permanent.ops.length });
    expect(existsSync(t.folder('o/a'))).toBe(false);
    expect(diffTrees(beforeB, await snapshotTree(t.folder('o/b')))).toEqual(EMPTY_DIFF);
  });

  it('hold: links and blobs land under <holdRoot>/<deletionId>/ with the same inode; result freed 0, held = plan.apparentBytes', async () => {
    const { t, pair } = await setup();
    const plan = pair.hold!;
    const renames = plan.ops.filter((o): o is Extract<Op, { kind: 'hold-rename' }> => o.kind === 'hold-rename');
    expect(renames.length).toBeGreaterThan(0);
    const inos = new Map(await Promise.all(renames.map(async (o) => [o.dest, (await lstat(o.path)).ino] as const)));
    const r = await run(t, plan);
    expect(r).toMatchObject({ ok: true, appliedOps: plan.ops.length, freedBytesPlanned: 0, heldBytes: plan.apparentBytes });
    for (const o of renames) {
      expect(inside(o.dest, join(t.holdRoot, plan.deletionId!))).toBe(true);
      expect((await lstat(o.dest)).ino).toBe(inos.get(o.dest));
      expect(existsSync(o.path)).toBe(false);
    }
  });

  it('hold whole repo: the folder is one rename into <holdRoot>/<deletionId>/<folderName>, same inode', async () => {
    const { t, pair } = await setup(undefined, () => [whole('o/a')]);
    const ino = (await lstat(t.folder('o/a'))).ino;
    const r = await run(t, pair.hold!);
    expect(r).toMatchObject({ ok: true, heldBytes: pair.hold!.apparentBytes });
    const dest = join(t.holdRoot, pair.hold!.deletionId!, basename(t.folder('o/a')));
    expect((await lstat(dest)).ino).toBe(ino);
    expect(existsSync(t.folder('o/a'))).toBe(false);
  });

  it('hold: <holdRoot>/<deletionId> exists before beforeFirstOp is called', async () => {
    const { t, pair } = await setup();
    const dir = join(t.holdRoot, pair.hold!.deletionId!);
    let seen: boolean | null = null;
    const r = await run(t, pair.hold!, { hooks: { beforeFirstOp: async () => { seen = (await lstat(dir)).isDirectory(); } } });
    expect(r.ok).toBe(true);
    expect(seen).toBe(true);
  });

  it('o/a with snapshots/ symlinked into o/b — whole-repo permanent and a partial plan leave o/b byte-identical', async () => {
    const b = gguf('o/b');
    // whole repo, planned with the symlink in place: only the link itself is removed
    {
      const t = await buildTree({ repos: [gguf('o/a'), b] });
      await rename(join(t.folder('o/a'), 'snapshots'), join(t.root, 'parked'));
      await symlink('../models--o--b/snapshots', join(t.folder('o/a'), 'snapshots'));
      const m = await t.scan();
      const pair = await planDeletion({ model: m, selection: { repos: [whole('o/a')] }, roots: t.roots, views: stubViews(), now: t.now });
      const beforeB = await snapshotTree(t.folder('o/b'));
      const r = await run(t, pair.permanent);
      expect(r.ok).toBe(true);
      expect(existsSync(t.folder('o/a'))).toBe(false);
      expect(diffTrees(beforeB, await snapshotTree(t.folder('o/b')))).toEqual(EMPTY_DIFF);
    }
    // partial plan made while snapshots/ was real, executed after it became a link into o/b (same relpaths): refused
    {
      const { t, pair } = await setup([gguf('o/a'), b]);
      await rename(join(t.folder('o/a'), 'snapshots'), join(t.root, 'parked'));
      await symlink('../models--o--b/snapshots', join(t.folder('o/a'), 'snapshots'));
      const beforeB = await snapshotTree(t.folder('o/b'));
      const r = await run(t, pair.permanent);
      expect(r.ok).toBe(false);
      expect(r.appliedOps).toBe(0);
      expect(r.error!.code).toBe('STALE');
      expect(diffTrees(beforeB, await snapshotTree(t.folder('o/b')))).toEqual(EMPTY_DIFF);
    }
  });
});

describe('executePlan: containment pre-check', () => {
  async function refuses(t: Tree, plan: DeletionPlan, code = 'CONTAINMENT'): Promise<void> {
    const before = await snapshotTree(t.root);
    const r = await run(t, plan);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe(code);
    expect(r.appliedOps).toBe(0);
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
  }
  const withOp = (plan: DeletionPlan, i: number, patch: Record<string, unknown>): DeletionPlan =>
    forge(plan, { ops: plan.ops.map((o, j) => (j === i ? ({ ...o, ...patch } as Op) : o)) });

  it('inv1: op path outside every root → CONTAINMENT, nothing touched', async () => {
    const { t, pair } = await setup();
    await mkdir(join(t.root, 'elsewhere'));
    await writeFile(join(t.root, 'elsewhere', 'x'), 'precious');
    await refuses(t, withOp(pair.permanent, 0, { path: join(t.root, 'elsewhere', 'x') }));
  });
  it('inv1: op path equal to hubRoot → CONTAINMENT', async () => {
    const { t, pair } = await setup();
    await refuses(t, withOp(pair.permanent, 0, { path: t.hub }));
    const last = pair.permanent.ops.length - 1;
    await refuses(t, forge(pair.permanent, { ops: [...pair.permanent.ops.slice(0, last), { kind: 'rmdir-empty', path: t.hub }] }));
  });
  it('inv1: path through a symlinked dir leading outside → CONTAINMENT', async () => {
    const { t, pair } = await setup();
    await mkdir(join(t.root, 'elsewhere'));
    await writeFile(join(t.root, 'elsewhere', Q4), 'precious');
    // inside a snapshot, so the role table accepts the path and SafeFs's realpath of the parent is what refuses it
    const escape = join(t.folder('o/a'), 'snapshots', 'c1', 'escape');
    await symlink(join(t.root, 'elsewhere'), escape);
    const victim = join(escape, Q4);
    const plan = withOp(pair.permanent, 0, { path: victim, expect: (await factsOf(t.fs, join(t.root, 'elsewhere', Q4)))! });
    const before = await snapshotTree(t.root);
    const r = await run(t, plan);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'CONTAINMENT', path: victim } });
    expect(r.error!.message).toMatch(/resolves outside its root/);
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
    expect(await readFile(join(t.root, 'elsewhere', Q4), 'utf8')).toBe('precious');
  });
  it('inv1: hold dest outside <holdRoot>/<deletionId> → CONTAINMENT; snapshot-link role outside hubRoot → CONTAINMENT', async () => {
    const { t, pair } = await setup();
    const hold = pair.hold!;
    await refuses(t, withOp(hold, 0, { dest: join(t.holdRoot, 'other-deletion', 'x') }));
    await refuses(t, withOp(hold, 0, { dest: join(t.holdRoot, hold.deletionId!) }));
    await mkdir(join(t.lmstudioRoot, 'o'), { recursive: true });
    await writeFile(join(t.lmstudioRoot, 'o', 'x'), 'v');
    const vf = (await factsOf(t.fs, join(t.lmstudioRoot, 'o', 'x')))!;
    await refuses(t, withOp(pair.permanent, 0, { path: join(t.lmstudioRoot, 'o', 'x'), expect: vf }));
    // and the converse: a view role on a hub path
    await refuses(t, withOp(pair.permanent, 0, { role: 'view-link' }));
  });
  it('inv1: mode/kind mismatches → CONTAINMENT (hold op in a permanent plan, unlink in a hold plan, restore in a delete plan)', async () => {
    const { t, pair } = await setup();
    await refuses(t, forge(pair.permanent, { ops: [pair.hold!.ops[0]!, ...pair.permanent.ops.slice(1)] }));
    await refuses(t, forge(pair.hold!, { ops: [pair.permanent.ops[0]!, ...pair.hold!.ops.slice(1)] }));
    const h = pair.hold!.ops[0] as Extract<Op, { kind: 'hold-rename' }>;
    await refuses(t, forge(pair.hold!, { ops: [{ ...h, kind: 'restore-rename' }, ...pair.hold!.ops.slice(1)] }));
  });
  it('inv1: plan roots must equal the SafeFs roots (hub, and hold root in hold mode)', async () => {
    const { t, pair } = await setup();
    await refuses(t, forge(pair.permanent, { hubRoot: join(t.root, 'hub2') }));
    await refuses(t, forge(pair.hold!, { holdRoot: join(t.root, 'elsewhere') }));
    await refuses(t, forge(pair.hold!, { deletionId: '../x' }));
  });
  it('write-file roles — view-state outside a view root, hold-manifest outside <holdRoot>/<deletionId> → CONTAINMENT', async () => {
    const { t, pair } = await setup();
    const vs: Op = { kind: 'write-file', path: join(t.hub, 'state.json'), before: null, after: '{}', role: 'view-state' };
    await refuses(t, forge(pair.permanent, { ops: [vs, ...pair.permanent.ops] }));
    const hm: Op = { kind: 'write-file', path: join(t.holdRoot, 'manifest.json'), before: null, after: '{}', role: 'hold-manifest' };
    await refuses(t, forge(pair.hold!, { ops: [hm, ...pair.hold!.ops] }));
  });
  it('store-sweep refsPath must be storePath + ".refs"; holdDest must stay in <holdRoot>/<deletionId>/store/', async () => {
    const { t, pair } = await setup();
    const storePath = join(t.hub, 'blobs', 'ab', 'ab' + 'c'.repeat(62));
    const facts: FileFacts = { dev: 1, ino: 1, size: 1, mtimeMs: 1, nlink: 1, isSymlink: false, isDirectory: false, isFile: true };
    const sweep = { kind: 'store-sweep' as const, storePath, refsPath: storePath + '.refs', removeRefs: [], expectRefsRaw: [], expect: facts };
    await refuses(t, forge(pair.permanent, { ops: [...pair.permanent.ops, { ...sweep, refsPath: join(t.hub, 'blobs', 'ab', 'other.refs'), payload: 'delete' }] }));
    await refuses(t, forge(pair.permanent, { ops: [...pair.permanent.ops, { ...sweep, storePath: t.blob('o/a', Q4), refsPath: t.blob('o/a', Q4) + '.refs', payload: 'delete' }] }));
    const D = pair.hold!.deletionId!;
    for (const holdDest of [`${D}/../x`, `other/store/ab/x`, `${D}/x`, join(t.holdRoot, D, 'store', 'x')]) {
      await refuses(t, forge(pair.hold!, { ops: [...pair.hold!.ops, { ...sweep, payload: 'hold', holdDest }] }));
    }
    await refuses(t, forge(pair.permanent, { ops: [...pair.permanent.ops, { ...sweep, payload: 'hold', holdDest: `${D}/store/ab/x` }] }));
  });
  it('store-refs-add refsPath must be <hub>/blobs/<xx>/<64hex>.refs (and never in a delete plan)', async () => {
    const { t, pair } = await setup();
    const h = 'ab' + 'c'.repeat(62);
    const bad: Op = { kind: 'store-refs-add', refsPath: join(t.hub, 'blobs', 'zz', `${h}.refs`), addRefs: [], expectRefsRaw: null };
    await holdDirFor(t, pair);
    await refuses(t, restoreOf(pair, [bad]));
    const good: Op = { kind: 'store-refs-add', refsPath: join(t.hub, 'blobs', 'ab', `${h}.refs`), addRefs: [], expectRefsRaw: null };
    await refuses(t, forge(pair.permanent, { ops: [...pair.permanent.ops, good] }));
  });
  it('plan whose fingerprint does not match its content → FINGERPRINT; an expired plan → EXPIRED', async () => {
    const { t, pair } = await setup();
    await refuses(t, { ...pair.permanent, ops: pair.permanent.ops.slice(1) }, 'FINGERPRINT');
    await refuses(t, { ...pair.permanent, fingerprint: 'f'.repeat(64) }, 'FINGERPRINT');
    const before = await snapshotTree(t.root);
    const r = await run(t, pair.permanent, { now: () => pair.permanent.expiresAt });
    expect(r.error!.code).toBe('EXPIRED');
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
  });
  it('a plan with store ops is supported: the sweep runs after the repo blob unlink', async () => {
    const { t, pair } = await setup([{ id: 'o/s', snapshots: { c1: { 'w.safetensors': f('store', 'S', 2000), 'x.safetensors': f('blob', 'X', 100) } } }],
      (m) => [part(m, 'o/s', 'w.safetensors')]);
    const sweep = pair.permanent.ops.find((o) => o.kind === 'store-sweep') as Extract<Op, { kind: 'store-sweep' }>;
    expect(sweep.payload).toBe('delete');
    const r = await run(t, pair.permanent);
    expect(r).toMatchObject({ ok: true, appliedOps: pair.permanent.ops.length });
    expect(existsSync(sweep.storePath)).toBe(false);
    expect(existsSync(sweep.refsPath)).toBe(false);
  });
});

describe('executePlan: lock', () => {
  it('inv8: lock held → LOCKED, nothing touched; the holder keeps its lock', async () => {
    const { t, pair } = await setup();
    const other = new AppLock(t.lockDir);
    await other.acquire(t.now);
    const before = await snapshotTree(t.root);
    const r = await run(t, pair.permanent);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'LOCKED' } });
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
    expect(existsSync(join(t.lockDir, 'app.lock'))).toBe(true);
    await other.release();
  });
});

describe('executePlan: revalidation', () => {
  async function stale(t: Tree, plan: DeletionPlan, path?: string, code = 'STALE'): Promise<void> {
    const before = await snapshotTree(t.root);
    const r = await run(t, plan);
    expect(r.ok).toBe(false);
    expect(r.appliedOps).toBe(0);
    if (code === 'STALE') {
      expect(r.error).toEqual(path === undefined ? { code, message: STALE_MESSAGE } : { code, message: STALE_MESSAGE, path });
    } else {
      expect(r.error!.code).toBe(code);
    }
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
    expect(existsSync(join(t.lockDir, 'app.lock'))).toBe(false);
  }

  it('inv3: mtime changed on a doomed blob → STALE with exact message and path, nothing touched', async () => {
    const { t, pair } = await setup();
    await utimes(t.blob('o/a', Q4), new Date(), new Date(t.now + 5_000));
    await stale(t, pair.permanent, t.blob('o/a', Q4));
  });
  it('inv3: hardlink added to a doomed blob (nlink change) → STALE', async () => {
    const { t, pair } = await setup();
    await link(t.blob('o/a', Q4), join(t.root, 'extra-link'));
    await stale(t, pair.permanent, t.blob('o/a', Q4));
  });
  it('inv3: snapshot link retargeted → STALE', async () => {
    const { t, pair } = await setup();
    const l = t.link('o/a', 'c1', Q4);
    await unlink(l);
    await symlink('../../blobs/' + basename(t.blob('o/a', 'm-Q8_0.gguf')), l);
    await stale(t, pair.permanent, l);
  });
  it('inv3: a new snapshot linking a doomed blob appears after planning → STALE (planner re-derivation)', async () => {
    const { t, pair } = await setup();
    const c2 = join(t.folder('o/a'), 'snapshots', 'c2');
    await mkdir(c2);
    await symlink('../../blobs/' + basename(t.blob('o/a', Q4)), join(c2, Q4));
    await stale(t, pair.permanent);
  });
  it('inv3: a new .incomplete in the repo after planning gives ACTIVE_DOWNLOAD (partial and whole, both modes)', async () => {
    for (const pick of [(m: CacheModel) => [part(m, 'o/a')], () => [whole('o/a')]]) {
      const { t, pair } = await setup(undefined, pick);
      await writeFile(join(t.folder('o/a'), 'blobs', 'e'.repeat(64) + '.incomplete'), 'partial');
      for (const plan of [pair.permanent, pair.hold!]) {
        const before = await snapshotTree(t.root);
        const r = await run(t, plan);
        expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'ACTIVE_DOWNLOAD' } });
        expect(r.error!.message).toContain('o/a');
        expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
      }
    }
  });
  it('inv3: write-file whose current content differs from before → STALE', async () => {
    const { t, pair } = await setup();
    const p = join(t.lmstudioRoot, 'state.json');
    await writeFile(p, 'changed');
    const op: Op = { kind: 'write-file', path: p, before: 'original', after: '{}', role: 'view-state' };
    await stale(t, forge(pair.permanent, { ops: [op, ...pair.permanent.ops] }), p);
    const missing: Op = { kind: 'write-file', path: join(t.lmstudioRoot, 'none.json'), before: 'x', after: '{}', role: 'view-state' };
    await stale(t, forge(pair.permanent, { ops: [missing, ...pair.permanent.ops] }), missing.path);
    const exists: Op = { kind: 'write-file', path: p, before: null, after: '{}', role: 'view-state' };
    await stale(t, forge(pair.permanent, { ops: [exists, ...pair.permanent.ops] }), p);
  });
  it('inv3: whole-repo hold folder replaced by a symlink to a directory → STALE', async () => {
    const { t, pair } = await setup(undefined, () => [whole('o/a')]);
    const folder = t.folder('o/a');
    await rename(folder, join(t.root, 'moved'));
    await symlink(join(t.root, 'moved'), folder);
    await stale(t, pair.hold!, folder);
  });
  it('whole-repo hold — a file added deep inside the folder (folder facts unchanged) → STALE', async () => {
    const { t, pair } = await setup(undefined, () => [whole('o/a')]);
    const folderFacts = await factsOf(t.fs, t.folder('o/a'));
    await writeFile(join(t.folder('o/a'), 'snapshots', 'c1', 'late.txt'), 'arrived after review');
    expect(await factsOf(t.fs, t.folder('o/a'))).toEqual(folderFacts);
    await stale(t, pair.hold!);
  });
  it('whole-repo hold — a deep file rewritten with the same size → STALE', async () => {
    const { t, pair } = await setup(undefined, () => [whole('o/a')]);
    await utimes(t.blob('o/a', 'm-Q8_0.gguf'), new Date(), new Date(t.now + 7_000));
    await stale(t, pair.hold!);
  });
  it('<holdRoot>/<deletionId> already exists → STALE', async () => {
    const { t, pair } = await setup();
    const dir = join(t.holdRoot, pair.hold!.deletionId!);
    await mkdir(dir);
    await stale(t, pair.hold!, dir);
  });
  it('rename dest that already exists → STALE naming the dest', async () => {
    const { t, pair } = await setup();
    const h = pair.hold!.ops.find((o) => o.kind === 'hold-rename') as Extract<Op, { kind: 'hold-rename' }>;
    // a dest outside the deletion dir is CONTAINMENT, so make the dest exist inside it via a forged deletion dir check:
    // revalidation checks dests before the deletion-dir absence, so an existing dest is reported as itself.
    await mkdir(dirname(h.dest), { recursive: true });
    await writeFile(h.dest, 'occupied');
    const before = await snapshotTree(t.root);
    const r = await run(t, pair.hold!);
    expect(r.error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: h.dest });
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
  });
  it('an rmdir-empty target that is a symlink to a directory, or whose parent is one → STALE', async () => {
    const { t, pair } = await setup(undefined, () => [whole('o/a')]);
    const perm = pair.permanent;
    const target = join(t.folder('o/b'), 'snapshots', 'c1');
    const linkDir = join(t.folder('o/a'), 'dirlink');
    await symlink(target, linkDir);
    await stale(t, forge(perm, { ops: [...perm.ops.slice(0, -1), { kind: 'rmdir-empty', path: linkDir }, perm.ops.at(-1)!] }), linkDir);
    const viaLink = join(linkDir, 'sub');
    await mkdir(join(target, 'sub'));
    await stale(t, forge(perm, { ops: [...perm.ops.slice(0, -1), { kind: 'rmdir-empty', path: viaLink }, perm.ops.at(-1)!] }), viaLink);
  });
  it('store-sweep: a ref appended to .refs after planning → STALE', async () => {
    const { t, pair } = await setup([{ id: 'o/s', snapshots: { c1: { 'w.safetensors': f('store', 'S', 2000), 'x.safetensors': f('blob', 'X', 100) } } }],
      (m) => [part(m, 'o/s', 'w.safetensors')]);
    const sweep = pair.permanent.ops.find((o) => o.kind === 'store-sweep') as Extract<Op, { kind: 'store-sweep' }>;
    await appendFile(sweep.refsPath, 'models--o--z/blobs/' + 'd'.repeat(64) + '\n');
    await stale(t, pair.permanent, sweep.refsPath);
  });
  it('rescan rejecting → IO "Could not rescan the cache: <errno>", nothing touched, lock released', async () => {
    const { t, pair } = await setup();
    const before = await snapshotTree(t.root);
    const r = await run(t, pair.permanent, {
      rescan: async () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); },
    });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: 'Could not rescan the cache: EACCES' } });
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
    expect(existsSync(join(t.lockDir, 'app.lock'))).toBe(false);
  });
});

describe('executePlan: dry run', () => {
  it('inv9: dryRun returns ops equal to plan.ops and changes nothing, no journal file, no lock taken', async () => {
    const { t, pair } = await setup();
    const other = new AppLock(t.lockDir, { pid: process.pid });
    for (const plan of [pair.permanent, pair.hold!]) {
      const before = await snapshotTree(t.root);
      let hooked = 0;
      const r = await run(t, plan, { dryRun: true, hooks: { beforeFirstOp: async () => { hooked++; }, afterOp: async () => { hooked++; } } });
      expect(r.ok).toBe(true);
      expect(r.dryRunOps).toEqual(plan.ops);
      expect(r.appliedOps).toBe(0);
      expect(hooked).toBe(0);
      expect(existsSync(join(t.appData, 'journal.jsonl'))).toBe(false);
      expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF); // holdRoot included
    }
    // a dry run does not take the lock, so it works while another operation holds it
    await other.acquire(t.now);
    const r = await run(t, pair.permanent, { dryRun: true });
    expect(r.ok).toBe(true);
    await other.release();
  });
  it('a dry run still refuses a stale plan', async () => {
    const { t, pair } = await setup();
    await utimes(t.blob('o/a', Q4), new Date(), new Date(t.now + 5_000));
    const r = await run(t, pair.permanent, { dryRun: true });
    expect(r.error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: t.blob('o/a', Q4) });
    expect(r.dryRunOps).toBeUndefined();
  });
});

describe('executePlan: journal and failures', () => {
  it('inv7: journal has begin, op/after per op in order, end', async () => {
    const { t, pair } = await setup();
    const plan = pair.permanent;
    const r = await run(t, plan);
    expect(r.ok).toBe(true);
    const lines = await journalLines(t);
    expect(lines.map((l) => l.t)).toEqual(['begin', ...plan.ops.flatMap(() => ['op', 'after']), 'end']);
    expect(lines.every((l) => l.planId === plan.id)).toBe(true);
    const ops = lines.filter((l) => l.t === 'op');
    expect(ops.map((l) => l.i)).toEqual(plan.ops.map((_, i) => i));
    expect(ops.map((l) => l.op)).toEqual(plan.ops);
    expect(lines.filter((l) => l.t === 'after').every((l) => l.ok === true)).toBe(true);
    expect((lines.at(-1)!.result as { ok: boolean }).ok).toBe(true);
  });

  it('permanent failure stops at the first failed op: IO with path, appliedOps = index, later paths still exist, journal end written', async () => {
    const { t, pair } = await setup();
    const plan = pair.permanent;
    const sfs = scriptedFs(t.fs, [{ method: 'unlink', nth: 2, code: 'EACCES' }]);
    const r = await run(t, plan, { safeFs: await SafeFs.create(t.roots, sfs) });
    const failed = plan.ops[1]!;
    expect(r).toMatchObject({ ok: false, appliedOps: 1, error: { code: 'IO', message: 'unlink failed: EACCES', path: (failed as { path: string }).path } });
    expect(existsSync(opPaths(plan)[0]!)).toBe(false);
    for (const p of opPaths(plan).slice(1)) expect(existsSync(p)).toBe(true);
    const lines = await journalLines(t);
    expect(lines.at(-1)).toMatchObject({ t: 'end', result: { ok: false, appliedOps: 1 } });
    expect(lines.filter((l) => l.t === 'after')).toEqual([
      expect.objectContaining({ i: 0, ok: true }), expect.objectContaining({ i: 1, ok: false }),
    ]);
    expect(existsSync(join(t.lockDir, 'app.lock'))).toBe(false);
  });

  it('a SafeFs STALE after the first change is IO "<kind> failed: STALE", never the stale-plan message', async () => {
    const { t, pair } = await setup();
    const plan = pair.permanent;
    const second = plan.ops[1] as Extract<Op, { kind: 'unlink' }>;
    const r = await run(t, plan, {
      hooks: { afterOp: async (_p, i) => { if (i === 0) await utimes(second.path, new Date(), new Date(t.now + 9_000)); } },
    });
    expect(r).toMatchObject({ ok: false, appliedOps: 1, error: { code: 'IO', message: 'unlink failed: STALE', path: second.path } });
    expect(existsSync(second.path)).toBe(true);
  });

  it('rmdir-empty on a non-empty dir becomes a note, run continues ok', async () => {
    const { t, pair } = await setup(undefined, () => [whole('o/a')]);
    const plan = pair.permanent;
    const i = plan.ops.findIndex((o) => o.kind === 'rmdir-empty');
    const dir = (plan.ops[i] as { path: string }).path;
    const r = await run(t, plan, { hooks: { afterOp: async (_p, k) => { if (k === i - 1) await writeFile(join(dir, 'late'), 'x'); } } });
    expect(r).toMatchObject({ ok: true, appliedOps: plan.ops.length });
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringContaining(dir)]));
    expect(await readFile(join(dir, 'late'), 'utf8')).toBe('x');
  });

  it('rmdir-empty of a dir gone at apply time, or ENOTEMPTY from rmdir, is a note and the run continues', async () => {
    const { t, pair } = await setup(undefined, () => [whole('o/a')]);
    const plan = pair.permanent;
    const i = plan.ops.findIndex((o) => o.kind === 'rmdir-empty');
    const dir = (plan.ops[i] as { path: string }).path;
    const next = (plan.ops[i + 1] as { path: string }).path;
    // The race: `next` gains an entry after the executor's emptiness check, so the OS itself answers ENOTEMPTY.
    // Simulated by a read view that reports `next` as empty while a file sits in it.
    const racyFs = Object.assign(Object.create(t.fs) as ReadFs, {
      readdir: async (p: string) => (p === next ? [] : t.fs.readdir(p)),
    });
    const helper = await SafeFs.create(t.roots, t.fs);
    const r = await run(t, plan, {
      fs: racyFs,
      hooks: {
        afterOp: async (_p, k) => {
          if (k === i - 1) await helper.rmdirEmpty(dir); // gone before its own op runs
          if (k === i) await writeFile(join(next, 'raced-in'), 'x');
        },
      },
    });
    expect(r).toMatchObject({ ok: true, appliedOps: plan.ops.length });
    expect(r.notes).toEqual(expect.arrayContaining([`rmdir-empty skipped: ${dir} is already gone`, `rmdir-empty skipped: ${next} is not empty, so it was kept`]));
    expect(await readFile(join(next, 'raced-in'), 'utf8')).toBe('x');
  });

  it('hooks: beforeFirstOp throwing → IO, nothing touched; afterOp called once per op with its index', async () => {
    const { t, pair } = await setup();
    const before = await snapshotTree(t.hub);
    const r = await run(t, pair.permanent, { hooks: { beforeFirstOp: async () => { throw new Error('manifest write failed'); } } });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO' } });
    expect(diffTrees(before, await snapshotTree(t.hub))).toEqual(EMPTY_DIFF);
    const seen: number[] = [];
    const ok = await run(t, pair.permanent, { hooks: { afterOp: async (p, i) => { expect(p.id).toBe(pair.permanent.id); seen.push(i); } } });
    expect(ok.ok).toBe(true);
    expect(seen).toEqual(pair.permanent.ops.map((_, i) => i));
  });

  it('hold: beforeFirstOp throwing leaves no deletion folder behind; hold failure never unlinks in the hub', async () => {
    const { t, pair } = await setup();
    const plan = pair.hold!;
    const r = await run(t, plan, { hooks: { beforeFirstOp: async () => { throw new Error('nope'); } } });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO' } });
    expect(existsSync(join(t.holdRoot, plan.deletionId!))).toBe(false);
    const sfs = scriptedFs(t.fs, [{ method: 'rename', nth: 2, code: 'EXDEV' }]);
    const r2 = await run(t, plan, { safeFs: await SafeFs.create(t.roots, sfs) });
    expect(r2.ok).toBe(false);
    expect(r2.error!.message).not.toBe(STALE_MESSAGE);
    expect(sfs.calls.filter((c) => c.method === 'unlink' && String(c.args[0]).startsWith(t.hub))).toEqual([]);
  });

  it('hold mode: applied view unlinks are reported in notes (irreversible)', async () => {
    const { t, pair } = await setup(undefined, undefined, { lmstudio: [{ rel: 'o/a/m.gguf', repo: 'o/a', file: Q4 }] }, (tt) => lmstudioViews(tt.lmstudioRoot, tt.fs));
    const plan = pair.hold!;
    const view = plan.ops.filter((o) => isViewOp(o));
    expect(view.length).toBe(1);
    const r = await run(t, plan);
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringContaining((view[0] as { path: string }).path)]));
    expect(existsSync((view[0] as { path: string }).path)).toBe(false);
  });
});

describe('sameFacts / isViewOp', () => {
  const base: FileFacts = { dev: 1, ino: 2, size: 3, mtimeMs: 4, nlink: 2, isSymlink: false, isDirectory: false, isFile: true };
  it('sameFacts: every field equal, nlink and linkTarget included; null is never the same', () => {
    expect(sameFacts(base, { ...base })).toBe(true);
    expect(sameFacts(base, null)).toBe(false);
    expect(sameFacts(base, { ...base, nlink: 1 })).toBe(false);
    expect(sameFacts(base, { ...base, nlink: 3 })).toBe(false);
    for (const k of ['dev', 'ino', 'size', 'mtimeMs'] as const) expect(sameFacts(base, { ...base, [k]: 99 })).toBe(false);
    for (const k of ['isSymlink', 'isDirectory', 'isFile'] as const) expect(sameFacts(base, { ...base, [k]: !base[k] })).toBe(false);
    expect(sameFacts({ ...base, linkTarget: 'a' }, { ...base, linkTarget: 'b' })).toBe(false);
    expect(sameFacts({ ...base, linkTarget: 'a' }, base)).toBe(false);
    expect(sameFacts(base, { ...base, linkTarget: 'a' })).toBe(false);
  });
  it('isViewOp: view roles and view-state writes; rmdir-empty only with the view roots given', () => {
    expect(isViewOp({ kind: 'unlink', path: '/v/x', expect: base, role: 'view-link' })).toBe(true);
    expect(isViewOp({ kind: 'unlink', path: '/v/x', expect: base, role: 'view-manifest' })).toBe(true);
    expect(isViewOp({ kind: 'unlink', path: '/h/x', expect: base, role: 'snapshot-link' })).toBe(false);
    expect(isViewOp({ kind: 'write-file', path: '/v/s', before: null, after: '', role: 'view-state' })).toBe(true);
    expect(isViewOp({ kind: 'write-file', path: '/k/m', before: null, after: '', role: 'hold-manifest' })).toBe(false);
    expect(isViewOp({ kind: 'rmdir-empty', path: '/v/d' })).toBe(false);
    expect(isViewOp({ kind: 'rmdir-empty', path: '/v/d' }, ['/v'])).toBe(true);
    expect(isViewOp({ kind: 'rmdir-empty', path: '/h/d' }, ['/v'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Coverage: every refusal of the pre-check, revalidation and re-derivation, and the op-loop edge cases
// ---------------------------------------------------------------------------------------------------------------

type Unlink = Extract<Op, { kind: 'unlink' }>;
type HoldRename = Extract<Op, { kind: 'hold-rename' }>;
const H64 = 'ab' + 'c'.repeat(62);
const errOf = (code: string, message: string): Error => Object.assign(new Error(message), { code });
/** A read view over `base` whose `method` calls on exactly `path` are answered by `fn` (others pass through). */
function readOverride(base: ReadFs, method: 'lstat' | 'readFile' | 'readdir', path: string, fn: (...a: unknown[]) => Promise<unknown>): ReadFs {
  const orig = (base[method] as (...a: unknown[]) => Promise<unknown>).bind(base);
  return Object.assign(Object.create(base) as ReadFs, { [method]: (...a: unknown[]) => (a[0] === path ? fn(...a) : orig(...a)) });
}

describe('executePlan: every pre-check refusal names its reason', () => {
  it('malformed plans and ops → CONTAINMENT with the exact reason and path, nothing touched', async () => {
    const { t, pair } = await setup();
    const P = pair.permanent;
    const H = pair.hold!;
    const u0 = P.ops[0] as Unlink;
    const u1 = P.ops[1] as Unlink;
    const h0 = H.ops[0] as HoldRename;
    const linkP = u0.path;
    const blobP = u1.path;
    const folder = t.folder('o/a');
    const sp = join(t.hub, 'blobs', 'ab', H64);
    const vs = join(t.lmstudioRoot, 'state.json');
    const sweep = { kind: 'store-sweep' as const, storePath: sp, refsPath: sp + '.refs', removeRefs: [], expectRefsRaw: [], expect: u1.expect };
    const DID = H.deletionId!;
    const held = join(t.holdRoot, DID, 'x');
    const ops = (plan: DeletionPlan, o: unknown[], patch: Partial<DeletionPlan> = {}): DeletionPlan => forge(plan, { ...patch, ops: o as Op[] });
    const R = restoreOf(pair, []);
    const cases: Array<[DeletionPlan, string, string?]> = [
      [forge(P, { mode: 'x' as never }), 'unknown plan mode'],
      [forge(P, { purpose: 'x' as never }), 'unknown plan purpose'],
      [forge(H, { holdRoot: null }), 'a hold plan needs a hold root and a deletion id'],
      [forge(H, { deletionId: null }), 'a hold plan needs a hold root and a deletion id'],
      [forge(P, { ops: 'x' as never }), 'the plan has no op list'],
      [ops(P, [null]), 'an op is not an object'],
      [ops(P, [5]), 'an op is not an object'],
      [ops(P, [{ kind: 'chmod', path: linkP }]), 'unknown op kind chmod'],
      [ops(P, [{ ...u0, path: 5 }]), 'unlink path is not a normalised absolute path'],
      [ops(P, [{ ...u0, path: '' }]), 'unlink path is not a normalised absolute path', ''],
      [ops(P, [{ ...u0, path: 'rel/x' }]), 'unlink path is not a normalised absolute path', 'rel/x'],
      [ops(P, [{ ...u0, path: linkP + '\0' }]), 'unlink path is not a normalised absolute path', linkP + '\0'],
      [ops(P, [{ ...u0, path: `${t.hub}/x/../y` }]), 'unlink path is not a normalised absolute path', `${t.hub}/x/../y`],
      [ops(P, [{ ...u0, expect: { ...u0.expect, size: '1' } }]), 'unlink without valid expected facts', linkP],
      [ops(P, [{ ...u0, expect: { ...u0.expect, isFile: 1 } }]), 'unlink without valid expected facts', linkP],
      [ops(P, [{ ...u0, expect: { ...u0.expect, linkTarget: 5 } }]), 'unlink without valid expected facts', linkP],
      [ops(P, [{ ...u0, expect: null }]), 'unlink without valid expected facts', linkP],
      [ops(P, [{ ...u0, path: join(t.hub, 'blobs', 'x') }]), `snapshot-link ${join(t.hub, 'blobs', 'x')} is not inside a repo folder of the hub`],
      [ops(P, [{ ...u0, path: join(t.hub, 'other--x', 'snapshots', 'c', 'f') }]), `snapshot-link ${join(t.hub, 'other--x', 'snapshots', 'c', 'f')} is not inside a repo folder of the hub`],
      [ops(P, [{ ...u0, path: blobP }]), `snapshot-link ${blobP} is not in a snapshot`],
      [ops(P, [{ ...u0, path: join(folder, 'snapshots', 'c1') }]), `snapshot-link ${join(folder, 'snapshots', 'c1')} is not in a snapshot`],
      [ops(P, [{ ...u1, path: linkP }]), `repo-blob ${linkP} is not in the repo's blobs/`],
      [ops(P, [{ ...u1, path: join(folder, 'blobs', 'x', 'y') }]), `repo-blob ${join(folder, 'blobs', 'x', 'y')} is not in the repo's blobs/`],
      [ops(P, [{ ...u1, path: join(folder, 'refs', 'x') }]), `repo-blob ${join(folder, 'refs', 'x')} is not in the repo's blobs/`],
      [ops(P, [{ ...u0, role: 'store-payload' }]), `store-payload ${linkP} is not <hub>/blobs/<xx>/<hash>`],
      [ops(P, [{ ...u0, path: sp, role: 'store-payload' }]), 'a delete plan never unlinks a store-payload'],
      [ops(P, [{ ...u0, role: 'held-item' }]), `held-item ${linkP} is not inside the hold root`],
      [ops(P, [{ ...u0, path: held, role: 'held-item' }]), 'a delete plan never unlinks a held-item'],
      [ops(P, [{ ...u0, role: 'bogus' }]), 'unknown role bogus'],
      [ops(H, [{ ...h0, expect: {} }]), 'hold-rename without valid expected facts', linkP],
      [ops(H, [{ ...h0, role: 'view-link' }]), 'hold-rename of a view-link', linkP],
      [ops(R, [{ kind: 'restore-rename', path: held, dest: blobP, expect: {}, role: 'repo-blob' }]), 'restore-rename without valid expected facts', held],
      [ops(R, [{ kind: 'restore-rename', path: linkP, dest: blobP, expect: u1.expect, role: 'repo-blob' }]), `restore source ${linkP} is not inside the deletion folder`],
      [ops(R, [{ kind: 'restore-rename', path: held, dest: join(t.root, 'x'), expect: u1.expect, role: 'repo-blob' }]),
        `repo-blob ${join(t.root, 'x')} is not inside a repo folder of the hub`],
      [ops(P, [{ kind: 'rmdir-empty', path: join(t.holdRoot, 'R') }]), `rmdir-empty ${join(t.holdRoot, 'R')} is not inside a repo folder or a view root`],
      [ops(P, [{ kind: 'write-file', path: vs, before: null, after: 5, role: 'view-state' }]), 'write-file content is malformed', vs],
      [ops(P, [{ kind: 'write-file', path: vs, before: 5, after: '{}', role: 'view-state' }]), 'write-file content is malformed', vs],
      [ops(P, [{ kind: 'write-file', path: vs, before: null, after: '{}', role: 'x' }]), 'unknown write-file role x', vs],
      [ops(P, [{ kind: 'write-file', path: vs, before: null, after: '{}', role: 'hold-manifest' }]), `hold-manifest ${vs} is not inside the deletion folder`],
      [ops(P, [{ ...sweep, payload: 'delete', expect: {} }]), 'store-sweep without valid expected facts', sp],
      [ops(P, [{ ...sweep, payload: 'delete', expectRefsRaw: null }]), 'store-sweep refs are malformed', sp + '.refs'],
      [ops(P, [{ ...sweep, payload: 'delete', removeRefs: 'x' }]), 'store-sweep refs are malformed', sp + '.refs'],
      [ops(P, [{ ...sweep, payload: 'delete', holdDest: 'x' }]), 'holdDest on a payload that is not held', sp],
      [ops(P, [{ ...sweep, payload: 'keep', holdDest: 'x' }]), 'holdDest on a payload that is not held', sp],
      [ops(H, [{ ...sweep, payload: 'delete' }]), 'a hold plan never deletes a payload', sp],
      [ops(P, [{ ...sweep, payload: 'burn' }]), 'unknown store-sweep payload action', sp],
      [ops(R, [{ kind: 'store-refs-add', refsPath: sp, addRefs: [], expectRefsRaw: null }]), `refsPath ${sp} is not <hub>/blobs/<xx>/<64hex>.refs`],
      [ops(R, [{ kind: 'store-refs-add', refsPath: sp + '.refs', addRefs: 'x', expectRefsRaw: null }]), 'store-refs-add refs are malformed', sp + '.refs'],
      [ops(R, [{ kind: 'store-refs-add', refsPath: sp + '.refs', addRefs: [], expectRefsRaw: 'x' }]), 'store-refs-add refs are malformed', sp + '.refs'],
      // plan-level identity and the deletion id
      [forge(P, { hubRoot: join(t.root, 'hub2') }), 'the plan is for a different hub than this session'],
      [forge(H, { holdRoot: join(t.root, 'hold2') }), 'the plan\'s hold root is not this session\'s hold root'],
      ...([5, '', '.', '..', 'a/b', 'a\\b', 'a\0b'] as unknown[]).map((d): [DeletionPlan, string] =>
        [forge(H, { deletionId: d as string }), 'the deletion id is not one plain path segment']),
      // per-kind path fields
      [ops(H, [{ ...h0, path: 'rel' }]), 'hold-rename path is not a normalised absolute path', 'rel'],
      [ops(H, [{ ...h0, dest: 'rel' }]), 'hold-rename dest is not a normalised absolute path', 'rel'],
      [ops(P, [h0]), 'hold-rename in a plan that is not a hold plan', linkP],
      [ops(H, [{ ...h0, dest: join(t.holdRoot, 'other', 'x') }]), `hold destination ${join(t.holdRoot, 'other', 'x')} is not inside ${join(t.holdRoot, H.deletionId!)}`],
      [ops(H, [u0]), 'a hold plan never unlinks hub entries', linkP],
      [ops(R, [{ kind: 'restore-rename', path: 'rel', dest: blobP, expect: u1.expect, role: 'repo-blob' }]), 'restore-rename path is not a normalised absolute path'],
      [ops(R, [{ kind: 'restore-rename', path: held, dest: 'rel', expect: u1.expect, role: 'repo-blob' }]), 'restore-rename dest is not a normalised absolute path'],
      [ops(P, [{ kind: 'restore-rename', path: held, dest: blobP, expect: u1.expect, role: 'repo-blob' }]), 'restore-rename outside a restore plan', held],
      [ops(P, [{ kind: 'rmdir-empty', path: 'rel' }]), 'rmdir-empty path is not a normalised absolute path'],
      [ops(P, [{ kind: 'write-file', path: 'rel', before: null, after: '{}', role: 'view-state' }]), 'write-file path is not a normalised absolute path'],
      [ops(P, [{ kind: 'write-file', path: join(t.hub, 's.json'), before: null, after: '{}', role: 'view-state' }]), `view-state ${join(t.hub, 's.json')} is not inside a view root`],
      [ops(P, [{ ...u0, role: 'view-link' }]), `view-link ${linkP} is not inside a view root`],
      [ops(P, [{ ...u0, path: join(folder, 'blobs', 'a', 'b') }]), `snapshot-link ${join(folder, 'blobs', 'a', 'b')} is not in a snapshot`],
      [ops(P, [{ ...u0, path: join(dirname(t.hub), 'x'.repeat(basename(t.hub).length), basename(folder), 'snapshots', 'c', 'f') }]),
        `snapshot-link ${join(dirname(t.hub), 'x'.repeat(basename(t.hub).length), basename(folder), 'snapshots', 'c', 'f')} is not inside a repo folder of the hub`],
      [ops(P, [{ ...sweep, storePath: 'rel', payload: 'delete' }]), 'store-sweep storePath is not a normalised absolute path'],
      [ops(P, [{ ...sweep, refsPath: 'rel', payload: 'delete' }]), 'store-sweep refsPath is not a normalised absolute path'],
      [ops(P, [{ ...sweep, storePath: blobP, refsPath: blobP + '.refs', payload: 'delete' }]), `store payload ${blobP} is not <hub>/blobs/<xx>/<hash>`],
      [ops(P, [{ ...sweep, refsPath: sp + '.ref', payload: 'delete' }]), `refsPath ${sp + '.ref'} is not the payload's .refs`],
      [ops(P, [{ ...sweep, payload: 'hold', holdDest: `${H.deletionId!}/store/ab/${H64}` }]), 'a permanent plan never holds a payload', sp],
      [ops(R, [{ kind: 'store-refs-add', refsPath: 'rel', addRefs: [], expectRefsRaw: null }]), 'store-refs-add refsPath is not a normalised absolute path'],
      [ops(R, [{ kind: 'store-refs-add', refsPath: join(t.hub, 'blobs', 'ab', 'abc.refs'), addRefs: [], expectRefsRaw: null }]),
        `refsPath ${join(t.hub, 'blobs', 'ab', 'abc.refs')} is not <hub>/blobs/<xx>/<64hex>.refs`],
      [ops(P, [{ kind: 'store-refs-add', refsPath: sp + '.refs', addRefs: [], expectRefsRaw: null }]), 'a delete plan never adds store references', sp + '.refs'],
      // holdDest: each rule on its own
      ...[5, `${DID}\\store\\ab\\x`, '/abs/x'].map((hd): [DeletionPlan, string] =>
        [ops(H, [{ ...sweep, payload: 'hold', holdDest: hd }]), 'holdDest is not a relative POSIX path']),
      ...[`${DID}/store/ab`, `${DID}/store//x`, `${DID}/store/./x`, `${DID}/store/../x`, `${DID}/store/a\0/x`, `other/store/ab/x`, `${DID}/stash/ab/x`, `${DID}/store/ab/x/y`]
        .map((hd): [DeletionPlan, string] => [ops(H, [{ ...sweep, payload: 'hold', holdDest: hd }]), `holdDest ${hd} is not ${DID}/store/<xx>/<hash>`]),
    ];
    const before = await snapshotTree(t.root);
    for (const [plan, why, path] of cases) {
      const r = await run(t, plan);
      expect(r.ok, why).toBe(false);
      expect(r.error, why).toMatchObject({ code: 'CONTAINMENT', message: `Refused: ${why}`, ...(path === undefined ? {} : { path }) });
    }
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
  });

  it('an empty plan\'s held-item unlink inside its deletion folder passes the pre-check (then STALE: nothing there)', async () => {
    const { t, pair } = await setup();
    const u0 = pair.permanent.ops[0] as Unlink;
    const held = join(await holdDirFor(t, pair), 'x');
    const r = await run(t, emptyOf(pair, [{ ...u0, path: held, role: 'held-item' }]));
    expect(r.error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: held });
  });

  it('a hold-mode restore plan runs in its existing deletion folder: every held item goes back, the emptied folder is removed', async () => {
    const { t, pair } = await setup();
    const H = pair.hold!;
    const hubBefore = await snapshotTree(t.hub);
    expect(await run(t, H)).toMatchObject({ ok: true, appliedOps: H.ops.length });
    const dir = join(t.holdRoot, H.deletionId!);
    const back: Op[] = [];
    for (const o of H.ops) {
      if (o.kind !== 'hold-rename') continue;
      back.push({ kind: 'restore-rename', path: o.dest, dest: o.path, expect: (await factsOf(t.fs, o.dest))!, role: o.role });
    }
    expect(back.length).toBeGreaterThan(0);
    // every directory of the deletion folder, deepest first, the folder itself last
    const dirs: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const n of await t.fs.readdir(d)) if ((await lstat(join(d, n))).isDirectory()) await walk(join(d, n));
      dirs.push(d);
    };
    await walk(dir);
    const restore = restoreOf(pair, [...back, ...dirs.map((d): Op => ({ kind: 'rmdir-empty', path: d }))]);
    const r = await run(t, restore);
    expect(r).toMatchObject({ ok: true, appliedOps: restore.ops.length });
    expect(r.error).toBeUndefined();
    expect(diffTrees(hubBefore, await snapshotTree(t.hub))).toEqual(EMPTY_DIFF);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(t.holdRoot)).toBe(true);
  });

  it('by purpose: a restore or empty plan needs its deletion folder to exist as a real directory, else STALE', async () => {
    const { t, pair } = await setup();
    const dir = join(t.holdRoot, pair.hold!.deletionId!);
    const before = await snapshotTree(t.root);
    for (const plan of [restoreOf(pair, []), emptyOf(pair, [])]) {
      expect((await run(t, plan)).error, plan.purpose).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: dir });
    }
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
    await mkdir(join(t.root, 'real-d'));
    await symlink(join(t.root, 'real-d'), dir);
    for (const plan of [restoreOf(pair, []), emptyOf(pair, [])]) {
      expect((await run(t, plan)).error, plan.purpose).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: dir });
    }
    await unlink(dir);
    await writeFile(dir, 'a file');
    expect((await run(t, emptyOf(pair, []))).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: dir });
    await unlink(dir);
    await mkdir(dir);
    // an existing folder: a restore (hold mode) neither refuses nor re-creates it; the delete plan still refuses it
    expect(await run(t, restoreOf(pair, []))).toMatchObject({ ok: true, appliedOps: 0 });
    expect(existsSync(dir)).toBe(true);
    expect((await run(t, pair.hold!)).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: dir });
  });

  it('restore and empty plans touch only their deletion folder (and, for a restore, the hub items it puts back): every other shape → CONTAINMENT, nothing touched', async () => {
    const { t, pair } = await setup();
    const P = pair.permanent;
    const H = pair.hold!;
    const u0 = P.ops[0] as Unlink;
    const h0 = H.ops[0] as HoldRename;
    const dir = await holdDirFor(t, pair);
    const other = join(t.holdRoot, 'other-deletion');
    await mkdir(other);
    const inDir = join(dir, 'x');
    const facts = u0.expect;
    const sp = join(t.hub, 'blobs', 'ab', H64);
    const refs: Op = { kind: 'store-refs-add', refsPath: sp + '.refs', addRefs: [], expectRefsRaw: null };
    const vs = join(t.lmstudioRoot, 'state.json');
    const vf = join(t.lmstudioRoot, 'o', 'x');
    const sweep: Op = { kind: 'store-sweep', storePath: sp, refsPath: sp + '.refs', removeRefs: [], expectRefsRaw: [], expect: facts, payload: 'keep' };
    const rr = (path: string, dest: string, role: OpRole): Op => ({ kind: 'restore-rename', path, dest, expect: facts, role });
    const cases: Array<[DeletionPlan, string]> = [
      // empty: no hub, view or other-deletion path; unlink and rmdir-empty only
      [emptyOf(pair, [u0]), `an empty plan never unlinks ${u0.path}`],
      [emptyOf(pair, [{ ...u0, path: vf, role: 'view-link' }]), `an empty plan never unlinks ${vf}`],
      [emptyOf(pair, [{ ...u0, path: join(other, 'x'), role: 'held-item' }]), `an empty plan never unlinks ${join(other, 'x')}`],
      [emptyOf(pair, [{ ...u0, path: dir, role: 'held-item' }]), `an empty plan never unlinks ${dir}`],
      [emptyOf(pair, [{ ...u0, path: sp, role: 'store-payload' }]), `an empty plan never unlinks ${sp}`],
      [emptyOf(pair, [{ kind: 'rmdir-empty', path: join(t.folder('o/a'), 'snapshots', 'c1') }]), `rmdir-empty ${join(t.folder('o/a'), 'snapshots', 'c1')} is not inside the deletion folder`],
      [emptyOf(pair, [{ kind: 'rmdir-empty', path: other }]), `rmdir-empty ${other} is not inside the deletion folder`],
      [emptyOf(pair, [{ kind: 'rmdir-empty', path: t.holdRoot }]), `rmdir-empty ${t.holdRoot} is not inside the deletion folder`],
      [emptyOf(pair, [rr(inDir, u0.path, 'snapshot-link')]), 'restore-rename outside a restore plan'],
      [emptyOf(pair, [refs]), 'an empty plan never adds store references'],
      [emptyOf(pair, [{ kind: 'write-file', path: join(dir, 'manifest.json'), before: null, after: '{}', role: 'hold-manifest' }]), 'an empty plan never writes a hold manifest'],
      [emptyOf(pair, [{ kind: 'write-file', path: vs, before: null, after: '{}', role: 'view-state' }]), 'an empty plan never writes view state'],
      [emptyOf(pair, [sweep]), 'an empty plan never sweeps the store'],
      [forge(emptyOf(pair, []), { deletionId: null }), 'an empty plan needs a hold root and a deletion id'],
      [forge(emptyOf(pair, []), { holdRoot: null }), 'an empty plan needs a hold root and a deletion id'],
      // restore: never unlinks anything, never moves anything to the hold root, sources only from its deletion folder
      [restoreOf(pair, [u0]), `a restore plan never unlinks ${u0.path}`],
      [restoreOf(pair, [{ ...u0, path: inDir, role: 'held-item' }]), `a restore plan never unlinks ${inDir}`],
      [restoreOf(pair, [{ ...u0, path: vf, role: 'view-link' }]), `a restore plan never unlinks ${vf}`],
      [restoreOf(pair, [h0]), 'a restore plan never moves anything to the hold root'],
      [restoreOf(pair, [rr(u0.path, join(t.folder('o/a'), 'snapshots', 'c1', 'y'), 'snapshot-link')]), `restore source ${u0.path} is not inside the deletion folder`],
      [restoreOf(pair, [rr(join(other, 'x'), u0.path, 'snapshot-link')]), `restore source ${join(other, 'x')} is not inside the deletion folder`],
      [restoreOf(pair, [rr(dir, u0.path, 'snapshot-link')]), `restore source ${dir} is not inside the deletion folder`],
      [restoreOf(pair, [rr(inDir, vf, 'view-link')]), 'restore-rename of a view-link'],
      [restoreOf(pair, [rr(inDir, join(other, 'y'), 'held-item')]), 'restore-rename of a held-item'],
      [restoreOf(pair, [rr(inDir, join(t.hub, 'blobs', 'x'), 'store-payload')]), `store-payload ${join(t.hub, 'blobs', 'x')} is not <hub>/blobs/<xx>/<hash>`],
      [restoreOf(pair, [rr(inDir, join(t.root, 'x'), 'repo-folder')]), `repo-folder ${join(t.root, 'x')} is not inside a repo folder of the hub`],
      [restoreOf(pair, [{ kind: 'rmdir-empty', path: join(t.folder('o/a'), 'snapshots', 'c1') }]), `rmdir-empty ${join(t.folder('o/a'), 'snapshots', 'c1')} is not inside the deletion folder`],
      [restoreOf(pair, [{ kind: 'rmdir-empty', path: other }]), `rmdir-empty ${other} is not inside the deletion folder`],
      [restoreOf(pair, [{ kind: 'write-file', path: join(other, 'manifest.json'), before: null, after: '{}', role: 'hold-manifest' }]), `hold-manifest ${join(other, 'manifest.json')} is not inside the deletion folder`],
      [restoreOf(pair, [{ kind: 'write-file', path: vs, before: null, after: '{}', role: 'view-state' }]), 'a restore plan never writes view state'],
      [restoreOf(pair, [sweep]), 'a restore plan never sweeps the store'],
    ];
    const before = await snapshotTree(t.root);
    for (const [plan, why] of cases) {
      const r = await run(t, plan);
      expect(r, why).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'CONTAINMENT', message: `Refused: ${why}` } });
    }
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
  });

  it('a restore plan may write its manifest inside <holdRoot>/<deletionId> (hold-manifest role)', async () => {
    const { t, pair } = await setup();
    const p = join(await holdDirFor(t, pair), 'manifest.json');
    const r = await run(t, restoreOf(pair, [{ kind: 'write-file', path: p, before: null, after: '{}', role: 'hold-manifest' }]));
    expect(r).toMatchObject({ ok: true, appliedOps: 1 });
    expect(await readFile(p, 'utf8')).toBe('{}');
  });

  it('a session without a hold root: view ops still run; a start failure has no hold dirs to clean', async () => {
    const roots = (t: Tree) => ({ ...t.roots, holdRoot: null });
    const vsOf = (t: Tree) => join(t.lmstudioRoot, 'state.json');
    const withView = (t: Tree, P: DeletionPlan) => forge(P, { ops: [{ kind: 'write-file', path: vsOf(t), before: null, after: '{}', role: 'view-state' }, ...P.ops] });
    {
      const { t, pair } = await setup();
      const r2 = await run(t, withView(t, pair.permanent), {
        safeFs: await SafeFs.create(roots(t), t.fs), hooks: { beforeFirstOp: async () => { throw new Error('no'); } },
      });
      expect(r2).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: 'Could not prepare the operation: no' } });
      expect(existsSync(vsOf(t))).toBe(false);
    }
    const { t, pair } = await setup();
    const r = await run(t, withView(t, pair.permanent), { safeFs: await SafeFs.create(roots(t), t.fs) });
    expect(r).toMatchObject({ ok: true, appliedOps: pair.permanent.ops.length + 1 });
    expect(await readFile(vsOf(t), 'utf8')).toBe('{}');
  });
});

describe('executePlan: revalidation failures', () => {

  it('an lstat failure other than not-found is IO naming the path; nothing touched', async () => {
    const { t, pair } = await setup();
    const p = (pair.permanent.ops[0] as Unlink).path;
    const r = await run(t, pair.permanent, { fs: readOverride(t.fs, 'lstat', p, async () => { throw errOf('EACCES', 'denied'); }) });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: `Could not check ${p}: EACCES`, path: p } });
    expect(existsSync(p)).toBe(true);
  });

  it('write-file before: a directory, a symlink or an oversized file is STALE; a read error is STALE (gone) or IO', async () => {
    const { t, pair } = await setup();
    const vs = join(t.lmstudioRoot, 'state.json');
    const plan = forge(pair.permanent, { ops: [{ kind: 'write-file', path: vs, before: 'x', after: 'y', role: 'view-state' }, ...pair.permanent.ops] });
    await mkdir(vs);
    expect((await run(t, plan)).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: vs });
    await t.fs.rename(vs, vs + '.d');
    await symlink(join(t.root, 'x'), vs);
    expect((await run(t, plan)).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: vs });
    await unlink(vs);
    await writeFile(vs, '');
    await truncate(vs, 16 * 1024 * 1024 + 1);
    expect((await run(t, plan)).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: vs });
    await writeFile(vs, 'x');
    expect((await run(t, plan, { fs: readOverride(t.fs, 'readFile', vs, async () => { throw errOf('ENOENT', 'gone'); }) })).error)
      .toEqual({ code: 'STALE', message: STALE_MESSAGE, path: vs });
    expect((await run(t, plan, { fs: readOverride(t.fs, 'readFile', vs, async () => { throw errOf('EACCES', 'denied'); }) })).error)
      .toEqual({ code: 'IO', message: `Could not read ${vs}: EACCES`, path: vs });
    expect(await readFile(vs, 'utf8')).toBe('x');
  });

  it('hold: a view file unlink needs a copy — over 16 MiB is IO; a failed or short read is STALE or IO', async () => {
    const { t, pair } = await setup();
    const H = pair.hold!;
    const vf = join(t.lmstudioRoot, 'o', 'big.gguf');
    await mkdir(dirname(vf), { recursive: true });
    await writeFile(vf, '');
    await truncate(vf, 16 * 1024 * 1024 + 1);
    const withView = async (): Promise<DeletionPlan> =>
      forge(H, { ops: [{ kind: 'unlink', path: vf, expect: (await factsOf(t.fs, vf))!, role: 'view-blob' }, ...H.ops] });
    expect((await run(t, await withView())).error)
      .toEqual({ code: 'IO', message: `Cannot keep a copy of ${vf} (larger than 16 MiB) to undo its removal`, path: vf });
    await writeFile(vf, 'view bytes');
    const plan = await withView();
    expect((await run(t, plan, { fs: readOverride(t.fs, 'readFile', vf, async () => { throw errOf('ENOENT', 'gone'); }) })).error)
      .toEqual({ code: 'STALE', message: STALE_MESSAGE, path: vf });
    expect((await run(t, plan, { fs: readOverride(t.fs, 'readFile', vf, async () => { throw errOf('EACCES', 'denied'); }) })).error)
      .toEqual({ code: 'IO', message: `Could not read ${vf}: EACCES`, path: vf });
    expect((await run(t, plan, { fs: readOverride(t.fs, 'readFile', vf, async () => Buffer.from('short')) })).error)
      .toEqual({ code: 'STALE', message: STALE_MESSAGE, path: vf });
    // same length, but the file changed while it was read
    const changing = readOverride(t.fs, 'readFile', vf, async () => {
      const b = await t.fs.readFile(vf);
      await utimes(vf, new Date(), new Date(Date.now() + 60_000));
      return b;
    });
    expect((await run(t, plan, { fs: changing })).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: vf });
    expect(existsSync(vf)).toBe(true);
  });

  it('store ops: a payload changed after planning is STALE; store-refs-add with .refs gone or changed is STALE', async () => {
    const { t, pair } = await setup([{ id: 'o/s', snapshots: { c1: { 'w.safetensors': f('store', 'S', 2000), 'x.safetensors': f('blob', 'X', 100) } } }],
      (m) => [part(m, 'o/s', 'w.safetensors')]);
    const sweep = pair.permanent.ops.find((o) => o.kind === 'store-sweep') as Extract<Op, { kind: 'store-sweep' }>;
    await utimes(sweep.storePath, new Date(), new Date(t.now - 1000));
    expect((await run(t, pair.permanent)).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: sweep.storePath });
    const raw = parseLines(await readFile(sweep.refsPath, 'utf8'));
    await holdDirFor(t, pair);
    const add = (expectRefsRaw: string[] | null): DeletionPlan =>
      restoreOf(pair, [{ kind: 'store-refs-add', refsPath: sweep.refsPath, addRefs: ['models--o--z/blobs/k'], expectRefsRaw }]);
    expect((await run(t, add(['models--o--q/blobs/k']))).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: sweep.refsPath });
    await t.fs.rename(sweep.refsPath, sweep.refsPath + '.away');
    expect((await run(t, add(raw))).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: sweep.refsPath });
  });
});

const parseLines = (text: string): string[] => text.split('\n').filter((l) => l !== '');

describe('executePlan: re-derivation refusals', () => {
  it('a view op after a hub op, a missing selection or digest, an unknown repo on rescan, a planning failure, other warnings → STALE', async () => {
    const lm = { lmstudio: [{ rel: 'o/a/m.gguf', repo: 'o/a', file: Q4 }] };
    const { t, m, pair } = await setup(undefined, undefined, lm, (tt) => lmstudioViews(tt.lmstudioRoot, tt.fs));
    const P = pair.permanent;
    expect(isViewOp(P.ops[0]!)).toBe(true);
    const staleOf = async (plan: DeletionPlan, extra: Partial<ExecDeps> = {}) => {
      const r = await run(t, plan, extra);
      expect(r.error).toEqual({ code: 'STALE', message: STALE_MESSAGE });
      expect(r.appliedOps).toBe(0);
    };
    await staleOf(forge(P, { ops: [...P.ops.slice(1), P.ops[0]!] }));
    await staleOf(forge(P, { selection: null }));
    const noDigest = structuredClone(P) as Partial<DeletionPlan>;
    delete noDigest.contentDigest;
    await staleOf(forge(noDigest as DeletionPlan, {}));
    await staleOf(P, { rescan: async () => ({ ...m, repos: m.repos.filter((r) => r.id !== 'o/a') }) });
    await staleOf(P, { rescan: async () => ({ ...(await t.scan()), hubRoot: join(t.root, 'other-hub') }) });
    // core warnings exist when every file of the repo is selected; the plan's must lead with them
    const all = await setup(undefined, (mm) => [{ repoId: 'o/a', whole: false, unlockComponents: false,
      groupKeys: [...new Set([Q4, 'm-Q8_0.gguf', 'config.json'].map((r) => groupKeyFor(mm, 'o/a', r)))] }]);
    expect(all.pair.permanent.warnings.length).toBeGreaterThan(0);
    const r = await run(all.t, forge(all.pair.permanent, { warnings: ['something else'] }));
    expect(r.error).toEqual({ code: 'STALE', message: STALE_MESSAGE });
    expect(existsSync(t.link('o/a', 'c1', Q4))).toBe(true);
  });
});

describe('executePlan: rmdir-empty at apply time', () => {
  /** A permanent 'empty' plan of one rmdir-empty of <holdRoot>/<deletionId>/c9/sub (created empty). */
  async function rmdirCase() {
    const { t, pair } = await setup();
    const parent = join(await holdDirFor(t, pair), 'c9');
    const dir = join(parent, 'sub');
    await mkdir(dir, { recursive: true });
    const plan = emptyOf(pair, [{ kind: 'rmdir-empty', path: dir }]);
    return { t, plan, parent, dir, gone: `rmdir-empty skipped: ${dir} is already gone` };
  }

  it('the parent gone before the op → a note, ok', async () => {
    const { t, plan, parent, gone } = await rmdirCase();
    const r = await run(t, plan, { hooks: { beforeFirstOp: async () => { await t.fs.rename(parent, join(t.root, 'moved')); } } });
    expect(r).toMatchObject({ ok: true, appliedOps: 1, notes: [gone] });
  });

  it('the target replaced by a symlink before the op → IO "rmdir-empty failed: STALE"; the link is kept', async () => {
    const { t, plan, dir } = await rmdirCase();
    const r = await run(t, plan, { hooks: { beforeFirstOp: async () => { await t.fs.rename(dir, join(t.root, 'moved')); await symlink(join(t.root, 'moved'), dir); } } });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: 'rmdir-empty failed: STALE', path: dir } });
    expect((await lstat(dir)).isSymbolicLink()).toBe(true);
  });

  it('restore/empty: a parent reached through a symlinked ancestor (inside the deletion folder) → IO "rmdir-empty failed: STALE", kept', async () => {
    const { t, pair } = await setup();
    const D = await holdDirFor(t, pair);
    await mkdir(join(D, 'real', 'b', 'sub'), { recursive: true });
    await symlink(join(D, 'real'), join(D, 'a'));
    const dir = join(D, 'a', 'b', 'sub');
    for (const plan of [emptyOf(pair, [{ kind: 'rmdir-empty', path: dir }]), restoreOf(pair, [{ kind: 'rmdir-empty', path: dir }])]) {
      const r = await run(t, plan);
      expect(r, plan.purpose).toMatchObject({ ok: false, appliedOps: 0, error: { path: dir } });
      expect(r.error!.message, plan.purpose).toMatch(/rmdir-empty failed: STALE/);
      expect(existsSync(join(D, 'real', 'b', 'sub')), plan.purpose).toBe(true);
    }
  });

  it('readdir failing at apply time: not found → a note; EACCES → IO', async () => {
    const { t, plan, dir, gone } = await rmdirCase();
    // the first readdir is revalidation's (an empty plan lists every directory it removes); it passes
    const atApply = (code: string) => {
      let n = 0;
      return readOverride(t.fs, 'readdir', dir, async () => { if (n++ === 0) return []; throw errOf(code, 'x'); });
    };
    const r1 = await run(t, plan, { fs: atApply('ENOENT') });
    expect(r1).toMatchObject({ ok: true, notes: [gone] });
    expect(existsSync(dir)).toBe(true);
    const r2 = await run(t, plan, { fs: atApply('EACCES') });
    expect(r2).toMatchObject({ ok: false, error: { code: 'IO', message: 'rmdir-empty failed: EACCES', path: dir } });
    expect(existsSync(dir)).toBe(true);
  });

  it('an empty plan whose directory gains an entry the OS reports (ENOTEMPTY race) → IO, the entry kept', async () => {
    const { t, plan, dir } = await rmdirCase();
    await writeFile(join(dir, 'raced-in'), 'x');
    // every read view of `dir` says empty (revalidation and the apply-time check), so only rmdir(2) itself sees the entry
    const r = await run(t, plan, { fs: readOverride(t.fs, 'readdir', dir, async () => []) });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: 'rmdir-empty failed: ENOTEMPTY', path: dir } });
    expect(await readFile(join(dir, 'raced-in'), 'utf8')).toBe('x');
  });

  it('the directory removed or replaced between the emptiness check and rmdir: gone → a note; a file → IO, kept', async () => {
    const { t, plan, dir, gone } = await rmdirCase();
    /** The second readdir of `dir` (the apply-time emptiness check; the first is revalidation's) runs `act`. */
    const onApply = (act: () => Promise<void>) => {
      let n = 0;
      return readOverride(t.fs, 'readdir', dir, async () => { if (n++ > 0) await act(); return []; });
    };
    const away = onApply(async () => { await t.fs.rename(dir, join(t.root, 'away')); });
    expect(await run(t, plan, { fs: away })).toMatchObject({ ok: true, notes: [gone] });
    await mkdir(dir);
    const replaced = onApply(async () => { await t.fs.rename(dir, join(t.root, 'away2')); await writeFile(dir, 'f'); });
    expect(await run(t, plan, { fs: replaced })).toMatchObject({ ok: false, error: { code: 'IO', message: 'rmdir-empty failed: STALE', path: dir } });
    expect(await readFile(dir, 'utf8')).toBe('f');
  });
});

describe('executePlan: dependency failures', () => {
  it('free space unmeasurable, even with a hostile error object → IO "unknown error"; nothing touched, no lock taken', async () => {
    const { t, pair } = await setup();
    const hostile = { get code(): never { throw new Error('getter'); }, toString(): never { throw new Error('toString'); } };
    const r = await run(t, pair.permanent, { diskFree: async () => { throw hostile; } });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: 'Could not measure free space: unknown error' } });
    const r2 = await run(t, pair.permanent, { diskFree: async () => { throw 'statfs down'; } });
    expect(r2.error!.message).toBe('Could not measure free space: statfs down');
    expect(existsSync(t.link('o/a', 'c1', Q4))).toBe(true);
  });

  it('a plan that cannot be fingerprinted (non-finite number) → FINGERPRINT', async () => {
    const { t, pair } = await setup();
    const r = await run(t, { ...pair.permanent, createdAt: Number.NaN });
    expect(r).toMatchObject({ ok: false, error: { code: 'FINGERPRINT', message: 'The plan does not match what was reviewed.' } });
  });

  it('the lock: acquire failing with an fs error → IO; release failing → a note, the result stands', async () => {
    const { t, pair } = await setup();
    const real = new AppLock(t.lockDir);
    const failing = Object.assign(Object.create(real) as AppLock, { acquire: async () => { throw errOf('EACCES', 'denied'); } });
    const r = await run(t, pair.permanent, { lock: failing });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: 'Could not take the app lock: EACCES' } });
    const sticky = Object.assign(Object.create(real) as AppLock, {
      acquire: (now: number) => real.acquire(now), release: async () => { throw errOf('EBUSY', 'busy'); },
    });
    const ok = await run(t, pair.permanent, { lock: sticky });
    expect(ok).toMatchObject({ ok: true, notes: ['the app lock could not be released: EBUSY'] });
    await real.release();
  });

  it('the journal: begin failing → IO, nothing touched; after(ok) failing → IO "journal failed"; after(error) failing is ignored', async () => {
    const mk = async () => setup();
    {
      const { t, pair } = await mk();
      const j = new Journal(t.appData, () => t.now);
      const r = await run(t, pair.permanent, { journal: Object.assign(Object.create(j) as Journal, { begin: async () => { throw new Error('no journal'); } }) });
      expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: 'no journal' } });
      expect(existsSync(t.link('o/a', 'c1', Q4))).toBe(true);
    }
    {
      const { t, pair } = await mk();
      const j = new Journal(t.appData, () => t.now);
      const r = await run(t, pair.permanent, { journal: Object.assign(Object.create(j) as Journal, { after: async () => { throw errOf('ENOSPC', 'full'); } }) });
      expect(r).toMatchObject({ ok: false, appliedOps: 1, error: { code: 'IO', message: 'journal failed: ENOSPC', path: (pair.permanent.ops[0] as Unlink).path } });
    }
    {
      const { t, pair } = await mk();
      const j = new Journal(t.appData, () => t.now);
      const after = (id: string, i: number, rec: { ok: boolean }) => (rec.ok ? j.after(id, i, rec) : Promise.reject(new Error('ignored')));
      const sfs = scriptedFs(t.fs, [{ method: 'unlink', nth: 1, code: 'EACCES' }]);
      const r = await run(t, pair.permanent, { safeFs: await SafeFs.create(t.roots, sfs), journal: Object.assign(Object.create(j) as Journal, { after }) });
      expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: 'unlink failed: EACCES' } });
    }
  });

  it('an op failing with a plain Error carries the op path (store-refs-add refused by a payload lock)', async () => {
    const { t, pair } = await setup([{ id: 'o/s', snapshots: { c1: { 'w.safetensors': f('store', 'S', 2000), 'x.safetensors': f('blob', 'X', 100) } } }],
      (m) => [part(m, 'o/s', 'w.safetensors')]);
    const sweep = pair.permanent.ops.find((o) => o.kind === 'store-sweep') as Extract<Op, { kind: 'store-sweep' }>;
    const raw = parseLines(await readFile(sweep.refsPath, 'utf8'));
    await writeFile(sweep.storePath + '.lock', '');
    await holdDirFor(t, pair);
    const plan = restoreOf(pair, [{ kind: 'store-refs-add', refsPath: sweep.refsPath, addRefs: ['models--o--z/blobs/k'], expectRefsRaw: raw }]);
    const r = await run(t, plan);
    // a restore is a hold plan: the failure is rolled back (nothing had changed)
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'ROLLED_BACK', path: sweep.refsPath } });
    expect(r.error!.message).toContain('store-refs-add failed: the store payload is locked by another process');
  });

  it('defence in depth: a malformed field read while building the result → IO "Unexpected failure", with the applied count', async () => {
    const { t, pair } = await setup();
    const noFreed = (ops: Op[]): DeletionPlan => {
      const p = structuredClone(emptyOf(pair, ops)) as Partial<DeletionPlan>;
      delete p.freed;
      return forge(p as DeletionPlan, {});
    };
    const held = join(await holdDirFor(t, pair), 'x');
    await writeFile(held, 'held');
    const r0 = await run(t, noFreed([]));
    expect(r0).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO' } });
    expect(r0.error!.message).toMatch(/^Unexpected failure: .+\.$/);
    expect(r0.error!.message).not.toContain('had been applied');
    const r1 = await run(t, noFreed([{ kind: 'unlink', path: held, expect: (await factsOf(t.fs, held))!, role: 'held-item' }]));
    expect(r1).toMatchObject({ ok: false, appliedOps: 1 });
    expect(r1.error!.message).toMatch(/^Unexpected failure: .+\. 1 operation\(s\) had been applied\. See the journal\.$/);
    expect(existsSync(join(t.lockDir, 'app.lock'))).toBe(false);
  });
});

describe('executePlan: view roots that contain other roots, size limits, exact re-derivation (mutation gate)', () => {
  it('a view root containing the hub, the app folder or a hold root still never admits a view op there', async () => {
    const { t, pair } = await setup();
    const top = dirname(t.hub);
    const hold2 = join(top, 'hold2');
    const roots = { hubRoot: t.hub, viewRoots: [t.lmstudioRoot, top], holdRoot: hold2 };
    const P = pair.permanent;
    const u0 = P.ops[0] as Unlink;
    const at = (p: string): DeletionPlan => forge(P, { ops: [{ ...u0, path: p, role: 'view-link' }, ...P.ops] });
    const appDir = join(dirname(t.hub), '.hf-cache-manager');
    for (const p of [t.hub, join(t.hub, 'x'), join(appDir, 'x'), join(hold2, 'x')]) {
      const r = await run(t, at(p), { safeFs: await SafeFs.create(roots, t.fs) });
      expect(r.error, p).toMatchObject({ code: 'CONTAINMENT', message: `Refused: view-link ${p} is not inside a view root` });
    }
    // inside the second view root only, and (with no hold root) where hold2 was: accepted, then STALE (nothing there)
    for (const [p, holdRoot] of [[join(top, 'other', 'x'), hold2], [join(hold2, 'x'), null]] as const) {
      const r = await run(t, at(p), { safeFs: await SafeFs.create({ ...roots, holdRoot }, t.fs) });
      expect(r.error, p).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: p });
    }
  });

  it('only hold mode buffers view files: a permanent plan unlinks one over 16 MiB; hold accepts exactly 16 MiB', async () => {
    const big = async (size: number) => {
      const { t, pair } = await setup();
      const vf = join(t.lmstudioRoot, 'o', 'big.gguf');
      await mkdir(dirname(vf), { recursive: true });
      await writeFile(vf, '');
      await truncate(vf, size);
      const view: Op = { kind: 'unlink', path: vf, expect: (await factsOf(t.fs, vf))!, role: 'view-blob' };
      return { t, pair, vf, withView: (plan: DeletionPlan) => forge(plan, { ops: [view, ...plan.ops] }) };
    };
    const a = await big(16 * 1024 * 1024 + 1);
    const perm = await run(a.t, a.withView(a.pair.permanent));
    expect(perm).toMatchObject({ ok: true, appliedOps: a.pair.permanent.ops.length + 1 });
    expect(existsSync(a.vf)).toBe(false);
    const b = await big(16 * 1024 * 1024);
    const hold = await run(b.t, b.withView(b.pair.hold!));
    expect(hold).toMatchObject({ ok: true, appliedOps: b.pair.hold!.ops.length + 1 });
  });

  it('rmdir-empty revalidation: a regular file, or a missing path, is STALE; the journal is never started', async () => {
    const { t, pair } = await setup();
    const D = await holdDirFor(t, pair);
    const f1 = join(D, 'a-file');
    await writeFile(f1, 'x');
    const before = await snapshotTree(t.root);
    for (const p of [f1, join(D, 'missing')]) {
      const r = await run(t, emptyOf(pair, [{ kind: 'rmdir-empty', path: p }]));
      expect(r.error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: p });
    }
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
  });

  it('store revalidation: a payload gone is STALE; store-refs-add with a changed .refs is refused before the journal starts', async () => {
    const { t, pair } = await setup([{ id: 'o/s', snapshots: { c1: { 'w.safetensors': f('store', 'S', 2000), 'x.safetensors': f('blob', 'X', 100) } } }],
      (m) => [part(m, 'o/s', 'w.safetensors')]);
    const sweep = pair.permanent.ops.find((o) => o.kind === 'store-sweep') as Extract<Op, { kind: 'store-sweep' }>;
    await holdDirFor(t, pair);
    const add = (expectRefsRaw: string[] | null): DeletionPlan =>
      restoreOf(pair, [{ kind: 'store-refs-add', refsPath: sweep.refsPath, addRefs: ['models--o--z/blobs/k'], expectRefsRaw }]);
    const before = await snapshotTree(t.root);
    expect((await run(t, add(['models--o--q/blobs/k']))).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: sweep.refsPath });
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF); // no journal, no lock file
    await t.fs.rename(sweep.storePath, join(t.root, 'payload-away'));
    expect((await run(t, pair.permanent)).error).toEqual({ code: 'STALE', message: STALE_MESSAGE, path: sweep.storePath });
    // a .refs that is absent and expected absent: created
    await t.fs.rename(sweep.refsPath, join(t.root, 'refs-away'));
    expect(await run(t, add(null))).toMatchObject({ ok: true, appliedOps: 1 });
    expect(await readFile(sweep.refsPath, 'utf8')).toBe('models--o--z/blobs/k\n');
  });

  it('re-derivation compares apparentBytes and kept exactly', async () => {
    const { t, pair } = await setup();
    const P = pair.permanent;
    for (const patch of [{ apparentBytes: P.apparentBytes + 1 }, { kept: [] }, { freed: { ...P.freed, bytes: P.freed.bytes + 1 } }]) {
      expect(P.kept.length).toBeGreaterThan(0);
      const r = await run(t, forge(P, patch));
      expect(r.error, JSON.stringify(Object.keys(patch))).toEqual({ code: 'STALE', message: STALE_MESSAGE });
    }
  });
});

describe('executePlan: result and journal details (mutation gate)', () => {
  it('EXPIRED text; a real run has no dryRunOps; a permanent view unlink adds no note; the lock is released only when taken', async () => {
    const { t, pair } = await setup();
    const exp = await run(t, pair.permanent, { now: () => pair.permanent.expiresAt });
    expect(exp.error).toEqual({ code: 'EXPIRED', message: 'This plan expired — please review again.' });
    let released = 0;
    const real = new AppLock(t.lockDir);
    const counting = Object.assign(Object.create(real) as AppLock, { release: async () => { released++; await real.release(); } });
    await run(t, pair.permanent, { lock: counting, dryRun: true });
    await run(t, { ...pair.permanent, fingerprint: 'x' }, { lock: counting });
    expect(released).toBe(0);
    const vf = join(t.lmstudioRoot, 'o', 'v.gguf');
    await mkdir(dirname(vf), { recursive: true });
    await writeFile(vf, 'v');
    const r = await run(t, forge(pair.permanent,
      { ops: [{ kind: 'unlink', path: vf, expect: (await factsOf(t.fs, vf))!, role: 'view-blob' }, ...pair.permanent.ops] }), { lock: counting });
    expect(r).toMatchObject({ ok: true, appliedOps: pair.permanent.ops.length + 1 });
    expect(r.notes).toBeUndefined();
    expect(r.dryRunOps).toBeUndefined();
    expect(released).toBe(1);
  });

  it('journal: a failing before-record is "journal failed"; a failing op records its error; a note is recorded with ok', async () => {
    {
      const { t, pair } = await setup();
      const j = new Journal(t.appData, () => t.now);
      const r = await run(t, pair.permanent, { journal: Object.assign(Object.create(j) as Journal, { before: async () => { throw errOf('ENOSPC', 'full'); } }) });
      expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', message: 'journal failed: ENOSPC' } });
    }
    {
      const { t, pair } = await setup();
      const sfs = scriptedFs(t.fs, [{ method: 'unlink', nth: 1, code: 'EACCES' }]);
      await run(t, pair.permanent, { safeFs: await SafeFs.create(t.roots, sfs) });
      expect((await journalLines(t)).find((l) => l.t === 'after')).toMatchObject({ i: 0, ok: false, error: 'unlink failed: EACCES' });
    }
    {
      const { t, pair } = await setup();
      const dir = join(await holdDirFor(t, pair), 'c9');
      await mkdir(join(dir, 'kept-file-dir'), { recursive: true });
      // a restore that does not unlink its manifest (partial) keeps a non-empty directory as a note (an
      // empty plan or a full restore refuses it instead)
      const r = await run(t, restoreOf(pair, [{ kind: 'rmdir-empty', path: dir }]));
      const note = `rmdir-empty skipped: ${dir} is not empty, so it was kept`;
      expect(r).toMatchObject({ ok: true, notes: [note] });
      expect((await journalLines(t)).find((l) => l.t === 'after')).toEqual(expect.objectContaining({ i: 0, ok: true, note }));
    }
  });
});
