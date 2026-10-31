import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executePlan, type ExecDeps } from '../../../src/core/exec/executor';
import { STALE_MESSAGE } from '../../../src/core/exec/errors';
import { Journal } from '../../../src/core/exec/journal';
import { AppLock } from '../../../src/core/exec/lock';
import {
  applyStoreRefsAdd, applyStoreSweep, confirmSweepDeletable, hubDownloadActive, refsText, StoreStaleError, writeRefs, type StoreSweepCtx, type StoreUndo,
} from '../../../src/core/exec/store-ops';
import { factsOf } from '../../../src/core/fsx';
import { fingerprintPlan } from '../../../src/core/plan/fingerprint';
import { ACTIVE_WINDOW_MS, planDeletion } from '../../../src/core/plan/planner';
import { SafeFs } from '../../../src/core/safe-fs';
import type { CacheModel, DeletionPlan, Op, PlanPair, RepoSelection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { scriptedFs } from '../../helpers/failing-fs';
import { diffTrees, snapshotTree } from '../support/observe';
import { buildTree, f, groupKeyFor, type RepoSpec, type Tree } from '../support/scenarios';
import { stubViews } from '../support/stub-views';

useCanaries();

type Sweep = Extract<Op, { kind: 'store-sweep' }>;
const W = 'w.safetensors';
const EMPTY_DIFF = { removed: [], added: [], changed: [] };
/** A repo whose `w.safetensors` is a shared-store file `S` (plus a plain blob so the repo is not wholly selected). */
const storeRepo = (id: string): RepoSpec => ({ id, snapshots: { c1: { [W]: f('store', 'S', 2000), 'x.safetensors': f('blob', `X${id}`, 100) } } });
const part = (m: CacheModel, id: string, rel = W): RepoSelection =>
  ({ repoId: id, whole: false, groupKeys: [groupKeyFor(m, id, rel)], unlockComponents: false });

interface Ctx { t: Tree; pair: PlanPair }
async function setup(repos: RepoSpec[], before?: (t: Tree) => Promise<void>): Promise<Ctx> {
  const t = await buildTree({ repos });
  await before?.(t);
  const m = await t.scan();
  const pair = await planDeletion({ model: m, selection: { repos: [part(m, 'o/a')] }, roots: t.roots, views: stubViews(), now: t.now });
  return { t, pair };
}
const sweepOf = (plan: DeletionPlan): Sweep => {
  const s = plan.ops.filter((o): o is Sweep => o.kind === 'store-sweep');
  expect(s).toHaveLength(1);
  return s[0]!;
};
/** Index of the op that runs just before the sweep. */
const beforeSweep = (plan: DeletionPlan): number => plan.ops.findIndex((o) => o.kind === 'store-sweep') - 1;

async function deps(t: Tree, extra: Partial<ExecDeps> = {}): Promise<ExecDeps> {
  return {
    safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, journal: new Journal(t.appData, () => t.now), lock: new AppLock(t.lockDir),
    rescan: () => t.scan(), now: () => t.now, diskFree: async () => 1e12, ...extra,
  };
}
const run = async (t: Tree, plan: DeletionPlan, extra: Partial<ExecDeps> = {}) => executePlan(plan, await deps(t, extra));
const afterIndex = (i: number, fn: () => Promise<void>): Partial<ExecDeps> =>
  ({ hooks: { afterOp: async (_p, k) => { if (k === i) await fn(); } } });
const forge = (plan: DeletionPlan, patch: Partial<DeletionPlan>): DeletionPlan => {
  const p = { ...structuredClone(plan), ...patch };
  return { ...p, fingerprint: fingerprintPlan(p) };
};
/** A permanent restore plan of `ops` in the deletion folder D1 (created), so a failure is not rolled back. */
async function restorePlan(t: Tree, plan: DeletionPlan, ops: Op[]): Promise<DeletionPlan> {
  await mkdir(join(t.holdRoot, 'D1'), { recursive: true });
  // A restore plan is always hold mode
  return forge(plan, { mode: 'hold', purpose: 'restore', selection: null, holdRoot: t.holdRoot, deletionId: 'D1', ops });
}
const relTo = (t: Tree, p: string): string => relative(t.hub, p).split('\\').join('/');

describe('store-sweep through executePlan', () => {
  it('sole ref, payload delete: payload and .refs removed after the repo blob unlink', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const plan = pair.permanent;
    const sweep = sweepOf(plan);
    expect(sweep.payload).toBe('delete');
    const sfs = scriptedFs(t.fs, []);
    const r = await run(t, plan, { safeFs: await SafeFs.create(t.roots, sfs) });
    expect(r).toMatchObject({ ok: true, appliedOps: plan.ops.length });
    expect(r.notes).toBeUndefined();
    expect(existsSync(sweep.storePath)).toBe(false);
    expect(existsSync(sweep.refsPath)).toBe(false);
    const unlinks = sfs.calls.filter((c) => c.method === 'unlink').map((c) => String(c.args[0]));
    const blob = t.blob('o/a', W);
    expect(unlinks.indexOf(blob)).toBeGreaterThanOrEqual(0);
    expect(unlinks.indexOf(sweep.storePath)).toBeGreaterThan(unlinks.indexOf(blob));
    expect(unlinks.indexOf(sweep.refsPath)).toBeGreaterThan(unlinks.indexOf(sweep.storePath));
  });

  it('shared, payload keep: .refs rewritten to exactly the other repo line + "\\n", payload untouched', async () => {
    const { t, pair } = await setup([storeRepo('o/a'), storeRepo('o/b')]);
    const sweep = sweepOf(pair.permanent);
    expect(sweep.payload).toBe('keep');
    const ino = (await lstat(sweep.storePath)).ino;
    const r = await run(t, pair.permanent);
    expect(r.ok).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(`models--o--b/blobs/${t.etag('S', 2000)}\n`);
    expect((await lstat(sweep.storePath)).ino).toBe(ino);
  });

  it('payload hold: payload renamed to <holdRoot>/<holdDest> (same inode), .refs removed', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const plan = pair.hold!;
    const sweep = sweepOf(plan);
    expect(sweep.payload).toBe('hold');
    const ino = (await lstat(sweep.storePath)).ino;
    const r = await run(t, plan);
    expect(r).toMatchObject({ ok: true, appliedOps: plan.ops.length });
    const dest = join(t.holdRoot, ...sweep.holdDest!.split('/'));
    expect(dest.startsWith(join(t.holdRoot, plan.deletionId!, 'store') + '/')).toBe(true);
    expect((await lstat(dest)).ino).toBe(ino);
    expect(existsSync(sweep.storePath)).toBe(false);
    expect(existsSync(sweep.refsPath)).toBe(false);
  });

  it('rewrite uses tmp "<hash>.refs.<8hex>.tmp" and mode 0o666', async () => {
    const { t, pair } = await setup([storeRepo('o/a'), storeRepo('o/b')]);
    const sweep = sweepOf(pair.permanent);
    const sfs = scriptedFs(t.fs, []);
    const r = await run(t, pair.permanent, { safeFs: await SafeFs.create(t.roots, sfs) });
    expect(r.ok).toBe(true);
    const writes = sfs.calls.filter((c) => c.method === 'writeFile');
    expect(writes).toHaveLength(1);
    const tmp = String(writes[0]!.args[0]);
    expect(tmp).toMatch(/\.refs\.[0-9a-f]{8}\.tmp$/);
    expect(dirname(tmp)).toBe(dirname(sweep.refsPath));
    expect(basename(tmp).startsWith(basename(sweep.refsPath) + '.')).toBe(true);
    expect(writes[0]!.args[2]).toEqual({ flag: 'wx', mode: 0o666 });
    const renames = sfs.calls.filter((c) => c.method === 'rename');
    expect(renames.map((c) => c.args)).toEqual([[tmp, sweep.refsPath]]);
    expect(existsSync(tmp)).toBe(false);
  });

  it('lock file appears before the sweep → payload and .refs untouched, note "locked"; ExecResult.notes carries it', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const plan = pair.permanent;
    const sweep = sweepOf(plan);
    const refsBefore = await readFile(sweep.refsPath, 'utf8');
    const r = await run(t, plan, afterIndex(beforeSweep(plan), () => writeFile(sweep.storePath + '.lock', '')));
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([expect.stringMatching(/kept: .*locked/)]);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(refsBefore);
    // the journal end record carries the note too
    const lines = (await readFile(join(t.appData, 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { t: string; result?: { notes?: string[] } });
    expect(lines.at(-1)!.result!.notes).toEqual(r.notes);
  });

  it('a fresh .incomplete anywhere in the hub before the sweep → note "kept: download in progress", no change', async () => {
    const { t, pair } = await setup([storeRepo('o/a'), { id: 'o/c', snapshots: { c1: { 'y.bin': f('blob', 'Y', 50) } } }]);
    const plan = pair.permanent;
    const sweep = sweepOf(plan);
    const refsBefore = await readFile(sweep.refsPath, 'utf8');
    const partial = join(t.folder('o/c'), 'blobs', 'e'.repeat(64) + '.incomplete');
    const r = await run(t, plan, afterIndex(beforeSweep(plan), () => writeFile(partial, 'x')));
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([expect.stringContaining('kept: download in progress')]);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(refsBefore);
  });

  it('another repo links the payload between revalidation and sweep → payload kept, .refs rewritten to the valid refs, note', async () => {
    const z = `models--o--z/blobs/${'d'.repeat(64)}`;
    // a stale .refs line (its link does not exist) at planning time: the payload is unreferenced once o/a is gone
    const { t, pair } = await setup([storeRepo('o/a')], async (tt) => { await appendFile(tt.store('S', 2000) + '.refs', `${z}\n`); });
    const plan = pair.permanent;
    const sweep = sweepOf(plan);
    expect(sweep.payload).toBe('delete');
    const ino = (await lstat(sweep.storePath)).ino;
    const linkPath = join(t.hub, ...z.split('/'));
    const r = await run(t, plan, afterIndex(beforeSweep(plan), async () => {
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(relative(dirname(linkPath), sweep.storePath), linkPath);
    }));
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([expect.stringContaining('still referenced')]);
    expect((await lstat(sweep.storePath)).ino).toBe(ino);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(`${z}\n`);
  });

  it('refs unreadable at sweep time → untouched, note', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const plan = pair.permanent;
    const sweep = sweepOf(plan);
    const refsBefore = await readFile(sweep.refsPath, 'utf8');
    // revalidation reads .refs once (call 1); the sweep's fresh read is call 2
    const sfs = scriptedFs(t.fs, [{ method: 'readFile', nth: 2, code: 'EACCES', pathIncludes: '.refs' }]);
    const r = await run(t, plan, { fs: sfs });
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([expect.stringMatching(/kept: .*unreadable/)]);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(refsBefore);
  });

  it('planned keep but now unreferenced → payload untouched (never more than the plan), note', async () => {
    const { t, pair } = await setup([storeRepo('o/a'), storeRepo('o/b')]);
    const plan = pair.permanent;
    const sweep = sweepOf(plan);
    expect(sweep.payload).toBe('keep');
    const refsBefore = await readFile(sweep.refsPath, 'utf8');
    const r = await run(t, plan, afterIndex(beforeSweep(plan), () => unlink(t.blob('o/b', W))));
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([expect.stringContaining('the plan said keep')]);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(refsBefore);
  });

  it('inv3: a ref appended to .refs after planning gives STALE', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.permanent);
    await appendFile(sweep.refsPath, `models--o--z/blobs/${'d'.repeat(64)}\n`);
    const before = await snapshotTree(t.root);
    const r = await run(t, pair.permanent);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE', message: STALE_MESSAGE, path: sweep.refsPath } });
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
  });

  it('a ref appended between revalidation and the sweep (after a change) → IO "store-sweep failed: refs changed…", payload untouched', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const plan = pair.permanent;
    const sweep = sweepOf(plan);
    const extra = `models--o--z/blobs/${'d'.repeat(64)}\n`;
    const r = await run(t, plan, afterIndex(beforeSweep(plan), () => appendFile(sweep.refsPath, extra)));
    expect(r).toMatchObject({ ok: false, appliedOps: beforeSweep(plan) + 1, error: { code: 'IO', path: sweep.refsPath } });
    expect(r.error!.message).toMatch(/^store-sweep failed: refs changed/);
    expect(r.error!.message).not.toBe(STALE_MESSAGE);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect((await readFile(sweep.refsPath, 'utf8')).endsWith(extra)).toBe(true);
  });

  it('.refs gone (ENOENT) at sweep time → IO "store-sweep failed: refs changed…", payload untouched', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const plan = pair.permanent;
    const sweep = sweepOf(plan);
    const r = await run(t, plan, afterIndex(beforeSweep(plan), () => unlink(sweep.refsPath)));
    expect(r).toMatchObject({ ok: false, error: { code: 'IO', path: sweep.refsPath } });
    expect(r.error!.message).toMatch(/^store-sweep failed: refs changed/);
    expect(existsSync(sweep.storePath)).toBe(true);
  });

  it('hold mode — a StoreStaleError at the sweep is rolled back (ROLLED_BACK, never the stale-plan message)', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const plan = pair.hold!;
    const sweep = sweepOf(plan);
    const r = await run(t, plan, afterIndex(beforeSweep(plan), () => utimes(sweep.storePath, new Date(), new Date(t.now + 9_000))));
    expect(r).toMatchObject({ ok: false, error: { code: 'ROLLED_BACK', path: sweep.storePath } });
    expect(r.error!.message).toMatch(/store-sweep failed: payload changed/);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(existsSync(sweep.refsPath)).toBe(true);
  });

  it('payload facts changed between revalidation and the sweep → IO, payload untouched', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const plan = pair.permanent;
    const sweep = sweepOf(plan);
    const r = await run(t, plan, afterIndex(beforeSweep(plan), () => utimes(sweep.storePath, new Date(), new Date(t.now + 9_000))));
    expect(r).toMatchObject({ ok: false, error: { code: 'IO', path: sweep.storePath } });
    expect(r.error!.message).toMatch(/^store-sweep failed: payload changed/);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(existsSync(sweep.refsPath)).toBe(true);
  });

  it('a dry run of a plan with a store sweep records it and changes nothing', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const before = await snapshotTree(t.root);
    const r = await run(t, pair.permanent, { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.dryRunOps).toEqual(pair.permanent.ops);
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual(EMPTY_DIFF);
  });
});

describe('applyStoreSweep (direct)', () => {
  async function ctxOf(t: Tree, extra: Partial<StoreSweepCtx> = {}): Promise<StoreSweepCtx> {
    return { safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, hubRoot: t.hub, holdRoot: t.holdRoot, activeDownload: async () => false, ...extra };
  }

  it('removeRefs entries absent from .refs are tolerated; undo records the exact .refs text before the change', async () => {
    const { t, pair } = await setup([storeRepo('o/a'), storeRepo('o/b')]);
    const sweep = sweepOf(pair.permanent);
    await unlink(t.blob('o/a', W)); // what the earlier op would have done
    const text = await readFile(sweep.refsPath, 'utf8');
    const op: Sweep = { ...sweep, removeRefs: [...sweep.removeRefs, `models--o--q/blobs/${'1'.repeat(64)}`] };
    const seen: unknown[] = [];
    const r = await applyStoreSweep(op, await ctxOf(t, { onUndo: (u) => seen.push(u) }));
    expect(r.note).toBeUndefined();
    const after = `models--o--b/blobs/${t.etag('S', 2000)}\n`;
    expect(r.undo).toEqual({ refsBefore: text, payloadMovedTo: null, refsAfter: after, refsPending: { before: text, after } });
    expect(seen).toEqual([r.undo]);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(`models--o--b/blobs/${t.etag('S', 2000)}\n`);
  });

  it('a doomed line that is a live link again at sweep time is kept (never removes a valid ref), payload kept', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.permanent);
    // the repo blob was not removed (e.g. re-linked): its line is still valid
    const r = await applyStoreSweep(sweep, await ctxOf(t));
    expect(r.note).toMatch(/still referenced/);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(`${relTo(t, t.blob('o/a', W))}\n`);
  });

  it('activeDownload is asked after the fresh read and true keeps everything', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.permanent);
    await unlink(t.blob('o/a', W));
    const text = await readFile(sweep.refsPath, 'utf8');
    let asked = 0;
    const r = await applyStoreSweep(sweep, await ctxOf(t, { activeDownload: async () => { asked++; return true; } }));
    expect(asked).toBe(1);
    expect(r).toEqual({ note: expect.stringContaining('kept: download in progress'), undo: { refsBefore: null, payloadMovedTo: null } });
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(text);
  });

  it('unmarked store → kept with a note; changed payload → StoreStaleError before any write', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.permanent);
    await unlink(t.blob('o/a', W));
    await writeFile(join(t.hub, 'blobs', '.huggingface-shared-blobs'), '0\n');
    expect((await applyStoreSweep(sweep, await ctxOf(t))).note).toMatch(/kept: .*not marked/);
    await writeFile(join(t.hub, 'blobs', '.huggingface-shared-blobs'), '1\n');
    await expect(applyStoreSweep({ ...sweep, expect: { ...sweep.expect, size: sweep.expect.size + 1 } }, await ctxOf(t)))
      .rejects.toBeInstanceOf(StoreStaleError);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(existsSync(sweep.refsPath)).toBe(true);
  });

  it('.refs changing between the fresh read and the text read → StoreStaleError, nothing written by the op', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.permanent);
    await unlink(t.blob('o/a', W));
    const extra = `models--o--z/blobs/${'d'.repeat(64)}\n`;
    let n = 0;
    const racing = Object.assign(Object.create(t.fs) as typeof t.fs, {
      readFile: (async (p: string, enc?: 'utf8') => {
        if (p === sweep.refsPath && ++n === 2) await appendFile(p, extra); // after readStoreFile's read
        return enc ? t.fs.readFile(p, enc) : t.fs.readFile(p);
      }) as typeof t.fs.readFile,
    });
    await expect(applyStoreSweep(sweep, await ctxOf(t, { fs: racing }))).rejects.toThrow(/refs changed/);
    expect(n).toBe(2);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect((await readFile(sweep.refsPath, 'utf8')).endsWith(extra)).toBe(true);
  });

  it('no-write paths leave the undo record empty and unregistered — keep with canonical .refs, plan said keep', async () => {
    const { t, pair } = await setup([storeRepo('o/a'), storeRepo('o/b')]);
    const sweep = sweepOf(pair.permanent);
    await unlink(t.blob('o/a', W));
    const bLine = `models--o--b/blobs/${t.etag('S', 2000)}`;
    await writeFile(sweep.refsPath, `${bLine}\n`); // already canonical: nothing to rewrite
    const seen: unknown[] = [];
    const r1 = await applyStoreSweep({ ...sweep, expectRefsRaw: [bLine] }, await ctxOf(t, { onUndo: (u) => seen.push(u) }));
    expect(r1).toEqual({ undo: { refsBefore: null, payloadMovedTo: null } });
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(`${bLine}\n`);
    // now unreferenced, but the plan said keep: still no write
    await unlink(t.blob('o/b', W));
    const r2 = await applyStoreSweep({ ...sweep, expectRefsRaw: [bLine] }, await ctxOf(t, { onUndo: (u) => seen.push(u) }));
    expect(r2).toEqual({ note: expect.stringContaining('the plan said keep'), undo: { refsBefore: null, payloadMovedTo: null } });
    expect(seen).toEqual([]);
    expect(existsSync(sweep.storePath)).toBe(true);
  });

  it('hold rename failing after mkdirp → undo registered but empty (refsBefore and payloadMovedTo null), created dirs recorded', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.hold!);
    await unlink(t.blob('o/a', W));
    const text = await readFile(sweep.refsPath, 'utf8');
    const sfs = scriptedFs(t.fs, [{ method: 'rename', nth: 1, code: 'EXDEV' }]);
    const seen: Array<{ refsBefore: string | null; payloadMovedTo: string | null }> = [];
    const createdDirs: string[] = [];
    await expect(applyStoreSweep(sweep, await ctxOf(t, { safeFs: await SafeFs.create(t.roots, sfs), onUndo: (u) => seen.push(u), createdDirs })))
      .rejects.toThrow(/EXDEV/);
    expect(seen).toEqual([{ refsBefore: null, payloadMovedTo: null }]);
    expect(createdDirs.length).toBeGreaterThan(0);
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(text);
  });

  it('a delete sets refsBefore only once .refs is unlinked; a rewrite only once it is written', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.permanent);
    await unlink(t.blob('o/a', W));
    const text = await readFile(sweep.refsPath, 'utf8');
    // .refs unlink fails after the payload is gone: refsBefore stays null
    const sfs = scriptedFs(t.fs, [{ method: 'unlink', nth: 1, code: 'EACCES', pathIncludes: '.refs' }]);
    const seen: Array<{ refsBefore: string | null; payloadMovedTo: string | null }> = [];
    await expect(applyStoreSweep(sweep, await ctxOf(t, { safeFs: await SafeFs.create(t.roots, sfs), onUndo: (u) => seen.push(u) })))
      .rejects.toThrow(/EACCES/);
    expect(seen).toEqual([{ refsBefore: null, payloadMovedTo: null, refsPending: { before: text, after: null } }]); // attempted, not done
    expect(existsSync(sweep.storePath)).toBe(false);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(text);
  });

  it('hold: records payloadMovedTo and the directories it created', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.hold!);
    await unlink(t.blob('o/a', W));
    const createdDirs: string[] = [];
    const r = await applyStoreSweep(sweep, await ctxOf(t, { createdDirs }));
    const dest = join(t.holdRoot, ...sweep.holdDest!.split('/'));
    expect(r.undo.payloadMovedTo).toBe(dest);
    expect(createdDirs[0]).toBe(dirname(dest));
    expect(createdDirs).toContain(join(t.holdRoot, pair.hold!.deletionId!));
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(sweep.refsPath)).toBe(false);
  });
});

describe('hubDownloadActive', () => {
  it('only <hub>/*/blobs/*.incomplete younger than ACTIVE_WINDOW_MS counts; NaN mtime and unreadable dirs count as active', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    expect(await hubDownloadActive(t.hub, t.fs, t.now)).toBe(false);
    const p = join(t.folder('o/a'), 'blobs', 'e'.repeat(64) + '.incomplete');
    await writeFile(p, 'x');
    await utimes(p, new Date(), new Date(t.now - 3_600_000));
    expect(await hubDownloadActive(t.hub, t.fs, t.now)).toBe(false);
    await utimes(p, new Date(), new Date(t.now - 60_000));
    expect(await hubDownloadActive(t.hub, t.fs, t.now)).toBe(true);
    await utimes(p, new Date(), new Date(t.now - 3_600_000));
    expect(await hubDownloadActive(t.hub, t.fs, Number.NaN)).toBe(true);
    const eacces = scriptedFs(t.fs, [{ method: 'readdir', nth: 1, code: 'EACCES', pathIncludes: 'blobs' }]);
    expect(await hubDownloadActive(t.hub, eacces, t.now)).toBe(true);
  });
});

describe('writeRefs / refsText', () => {
  it('sorted (by code point), unique, each line + "\\n"', async () => {
    expect(refsText(['b', 'a', 'b', 'Z'])).toBe('Z\na\nb\n');
    expect(refsText([])).toBe('');
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const refs = t.store('S', 2000) + '.refs';
    const sfs = scriptedFs(t.fs, []);
    await writeRefs(await SafeFs.create(t.roots, sfs), refs, ['models--o--b/blobs/x', 'models--o--a/blobs/x']);
    expect(await readFile(refs, 'utf8')).toBe('models--o--a/blobs/x\nmodels--o--b/blobs/x\n');
    const w = sfs.calls.find((c) => c.method === 'writeFile')!;
    expect(String(w.args[0])).toMatch(new RegExp(`^${refs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]{8}\\.tmp$`));
    expect(w.args[2]).toEqual({ flag: 'wx', mode: 0o666 });
  });
});

describe('store-refs-add', () => {
  it('union sorted; missing refs file is created; raw mismatch → IO "refs changed"', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const safeFs = await SafeFs.create(t.roots, t.fs);
    const ctx = { safeFs, fs: t.fs, hubRoot: t.hub };
    const refs = t.store('S', 2000) + '.refs';
    const text = await readFile(refs, 'utf8');
    const a = text.trim();
    // union sorted with the existing lines
    const r1 = await applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--0/blobs/k', a], expectRefsRaw: [a] }, ctx);
    expect(r1.undo).toEqual({ refsBefore: text, payloadMovedTo: null, refsAfter: `models--o--0/blobs/k\n${a}\n`,
      refsPending: { before: text, after: `models--o--0/blobs/k\n${a}\n` } });
    expect(await readFile(refs, 'utf8')).toBe(`models--o--0/blobs/k\n${a}\n`);
    // missing refs file is created
    await unlink(refs);
    const r2 = await applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: [a], expectRefsRaw: null }, ctx);
    expect(r2.undo).toEqual({ refsBefore: null, payloadMovedTo: null, refsAfter: `${a}\n`, refsPending: { before: null, after: `${a}\n` } });
    expect(await readFile(refs, 'utf8')).toBe(`${a}\n`);
    // raw mismatch → refused before any write
    await expect(applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--9/blobs/k'], expectRefsRaw: null }, ctx))
      .rejects.toThrow(/refs changed/);
    expect(await readFile(refs, 'utf8')).toBe(`${a}\n`);
    // malformed lines are refused
    await expect(applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: ['a\nb'], expectRefsRaw: [a] }, ctx)).rejects.toThrow(/malformed/);
    expect(await readFile(refs, 'utf8')).toBe(`${a}\n`);
    expect(await factsOf(t.fs, refs)).not.toBeNull();
  });

  it('the undo record is registered before the write, with refsPending; refsBefore/refsAfter only once it succeeded', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const refs = t.store('S', 2000) + '.refs';
    const text = await readFile(refs, 'utf8');
    const a = text.trim();
    const after = `models--o--0/blobs/k\n${a}\n`;
    const op: Op = { kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--0/blobs/k'], expectRefsRaw: [a] };
    // the write fails before taking effect: the record says only what was about to happen
    const seen: StoreUndo[] = [];
    const failing = await SafeFs.create(t.roots, scriptedFs(t.fs, [{ method: 'rename', nth: 1, code: 'EIO', pathIncludes: refs }]));
    await expect(applyStoreRefsAdd(op as Extract<Op, { kind: 'store-refs-add' }>, { safeFs: failing, fs: t.fs, hubRoot: t.hub, onUndo: (u) => seen.push(structuredClone(u)) }))
      .rejects.toThrow(/EIO/);
    expect(seen).toEqual([{ refsBefore: null, payloadMovedTo: null, refsPending: { before: text, after } }]);
    expect(await readFile(refs, 'utf8')).toBe(text);
    // success: the same record object is then completed
    const live: StoreUndo[] = [];
    const r = await applyStoreRefsAdd(op as Extract<Op, { kind: 'store-refs-add' }>,
      { safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, hubRoot: t.hub, onUndo: (u) => live.push(u) });
    expect(live).toHaveLength(1);
    expect(live[0]).toBe(r.undo);
    expect(r.undo).toEqual({ refsBefore: text, payloadMovedTo: null, refsAfter: after, refsPending: { before: text, after } });
  });

  it('a lock file for the payload refuses before any write', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const refs = t.store('S', 2000) + '.refs';
    const text = await readFile(refs, 'utf8');
    await writeFile(t.store('S', 2000) + '.lock', '');
    const seen: unknown[] = [];
    await expect(applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--0/blobs/k'], expectRefsRaw: [text.trim()] },
      { safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, hubRoot: t.hub, onUndo: (u) => seen.push(u) })).rejects.toThrow(/locked/);
    expect(seen).toEqual([]);
    expect(await readFile(refs, 'utf8')).toBe(text);
  });

  it('through executePlan (restore purpose, always hold mode): raw changed after a prior op → rolled back, refs left as changed', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const refs = t.store('S', 2000) + '.refs';
    const raw = (await readFile(refs, 'utf8')).trim();
    const sub = join(t.holdRoot, 'D1', 'sub');
    await mkdir(sub, { recursive: true });
    const first: Op = { kind: 'rmdir-empty', path: sub };
    const add: Op = { kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--0/blobs/k'], expectRefsRaw: [raw] };
    const plan = await restorePlan(t, pair.permanent, [first, add]);
    const r = await run(t, plan, afterIndex(0, () => appendFile(refs, 'models--o--z/blobs/q\n')));
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'ROLLED_BACK', path: refs } });
    expect(r.error!.message).toMatch(/^Restore from Recently Deleted failed: store-refs-add failed: refs changed/);
    expect(existsSync(sub)).toBe(true);                                       // the rmdir-empty was undone
    expect(await readFile(refs, 'utf8')).toBe(`${raw}\nmodels--o--z/blobs/q\n`);
    // the same refusal with no op applied yet: rolled back with nothing to undo; only the hook's own append changed
    {
      const { t: t1, pair: p1 } = await setup([storeRepo('o/a')]);
      const refs1 = t1.store('S', 2000) + '.refs';
      const raw1 = (await readFile(refs1, 'utf8')).trim();
      const only = await restorePlan(t1, p1.permanent,
        [{ kind: 'store-refs-add', refsPath: refs1, addRefs: ['models--o--0/blobs/k'], expectRefsRaw: [raw1] }]);
      const before = await snapshotTree(t1.hub);
      let hooked = false;
      const r0 = await run(t1, only, { hooks: { beforeFirstOp: async () => { hooked = true; await appendFile(refs1, 'models--o--y/blobs/q\n'); } } });
      expect(hooked).toBe(true); // revalidation passed; the refusal came from the op itself
      expect(r0).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'ROLLED_BACK', path: refs1 } });
      const d = diffTrees(before, await snapshotTree(t1.hub));
      expect(d).toEqual({ removed: [], added: [], changed: [refs1] }); // only the hook's own append
      expect(await readFile(refs1, 'utf8')).toBe(`${raw1}\nmodels--o--y/blobs/q\n`);
    }
    // and without the interference it applies
    const t2 = await setup([storeRepo('o/a')]);
    const refs2 = t2.t.store('S', 2000) + '.refs';
    const raw2 = (await readFile(refs2, 'utf8')).trim();
    const plan2 = await restorePlan(t2.t, t2.pair.permanent,
      [{ kind: 'store-refs-add', refsPath: refs2, addRefs: ['models--o--0/blobs/k'], expectRefsRaw: [raw2] }]);
    const r2 = await run(t2.t, plan2);
    expect(r2).toMatchObject({ ok: true, appliedOps: 1 });
    expect(await readFile(refs2, 'utf8')).toBe(`models--o--0/blobs/k\n${raw2}\n`);
  });
});

describe('store ops: failure paths (coverage gate)', () => {
  async function ctxOf(t: Tree, extra: Partial<StoreSweepCtx> = {}): Promise<StoreSweepCtx> {
    return { safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, hubRoot: t.hub, holdRoot: t.holdRoot, activeDownload: async () => false, ...extra };
  }
  /** A permanent sole-ref sweep after its repo blob is gone, with the .refs text it will read. */
  async function soleRef() {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.permanent);
    await unlink(t.blob('o/a', W));
    return { t, pair, sweep, text: await readFile(sweep.refsPath, 'utf8') };
  }
  const keptNote = (sweep: Sweep, why: string) =>
    ({ note: `store payload ${basename(sweep.storePath)} kept: ${why}`, undo: { refsBefore: null, payloadMovedTo: null } });

  it('.refs that cannot be lstat\'d (EACCES) at the fresh read → kept "unreadable", nothing written', async () => {
    const { t, sweep, text } = await soleRef();
    const sfs = scriptedFs(t.fs, [{ method: 'lstat', nth: 1, code: 'EACCES', pathIncludes: sweep.refsPath }]);
    expect(await applyStoreSweep(sweep, await ctxOf(t, { fs: sfs }))).toEqual(keptNote(sweep, 'its .refs file is unreadable'));
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(text);
  });

  it('refs that cannot be validated (a ref line lstat fails with EACCES) → kept, nothing written', async () => {
    const { t, sweep, text } = await soleRef();
    const sfs = scriptedFs(t.fs, [{ method: 'lstat', nth: 1, code: 'EACCES', pathIncludes: t.blob('o/a', W) }]);
    expect(await applyStoreSweep(sweep, await ctxOf(t, { fs: sfs }))).toEqual(keptNote(sweep, 'its .refs file could not be validated'));
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(text);
  });

  it('the .refs text read failing: ENOENT → StoreStaleError (gone), EACCES → kept "unreadable"', async () => {
    const { t, sweep, text } = await soleRef();
    const enoent = scriptedFs(t.fs, [{ method: 'readFile', nth: 2, code: 'ENOENT', pathIncludes: sweep.refsPath }]);
    const err = await applyStoreSweep(sweep, await ctxOf(t, { fs: enoent })).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StoreStaleError);
    expect(err).toMatchObject({ path: sweep.refsPath, message: 'refs changed since review: the .refs file is gone' });
    const eacces = scriptedFs(t.fs, [{ method: 'readFile', nth: 2, code: 'EACCES', pathIncludes: sweep.refsPath }]);
    expect(await applyStoreSweep(sweep, await ctxOf(t, { fs: eacces }))).toEqual(keptNote(sweep, 'its .refs file is unreadable'));
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(text);
  });

  it('a keep sweep whose doomed line is a live link again → note naming only that line; .refs rewritten canonically', async () => {
    const { t, pair } = await setup([storeRepo('o/a'), storeRepo('o/b')]);
    const sweep = sweepOf(pair.permanent);
    expect(sweep.payload).toBe('keep');
    // o/a's blob was not removed: its line stays valid
    const r = await applyStoreSweep(sweep, await ctxOf(t));
    expect(r.note).toBe(`store payload ${basename(sweep.storePath)} kept: it is still referenced by ${sweep.removeRefs.join(', ')}`);
    expect(existsSync(sweep.storePath)).toBe(true);
  });

  it('a .refs already gone after the payload is removed is not unlinked again (missing_ok)', async () => {
    const { t, sweep } = await soleRef();
    // lstat of .refs: fresh read, readStoreFile, re-check, then the missing_ok check (4th) reports it gone
    const sfs = scriptedFs(t.fs, [{ method: 'lstat', nth: 4, code: 'ENOENT', pathIncludes: sweep.refsPath }]);
    const seen: unknown[] = [];
    const r = await applyStoreSweep(sweep, await ctxOf(t, { fs: sfs, onUndo: (u) => seen.push(u) }));
    expect(r).toEqual({ undo: { refsBefore: null, payloadMovedTo: null } });
    expect(seen).toEqual([r.undo]);
    expect(existsSync(sweep.storePath)).toBe(false);
    expect(existsSync(sweep.refsPath)).toBe(true); // it was really still there: never unlinked without a fresh lstat
  });

  it('a hold sweep without a hold root or holdDest throws before touching the payload', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.hold!);
    await unlink(t.blob('o/a', W));
    await expect(applyStoreSweep(sweep, await ctxOf(t, { holdRoot: null }))).rejects.toThrow('a held payload needs a hold root and a holdDest');
    const noDest: Sweep = { ...sweep };
    delete noDest.holdDest;
    await expect(applyStoreSweep(noDest, await ctxOf(t))).rejects.toThrow('a held payload needs a hold root and a holdDest');
    expect(existsSync(sweep.storePath)).toBe(true);
    expect(existsSync(sweep.refsPath)).toBe(true);
  });

  it('store-refs-add refuses a path that is not .refs, and a .refs that is not a regular file', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const ctx = { safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, hubRoot: t.hub };
    const refs = t.store('S', 2000) + '.refs';
    await expect(applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: t.store('S', 2000), addRefs: ['models--o--0/blobs/k'], expectRefsRaw: null }, ctx))
      .rejects.toThrow('not a .refs path');
    await unlink(refs);
    await symlink(join(t.root, 'elsewhere.refs'), refs);
    const err = await applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--0/blobs/k'], expectRefsRaw: null }, ctx)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StoreStaleError);
    expect(err).toMatchObject({ path: refs, message: 'refs changed since review: not a regular file' });
    await unlink(refs);
    await mkdir(refs);
    await expect(applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--0/blobs/k'], expectRefsRaw: null }, ctx))
      .rejects.toThrow('not a regular file');
  });

  it('hubDownloadActive: an unreadable hub is active; an .incomplete that vanishes is skipped, one that cannot be lstat\'d is active', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    expect(await hubDownloadActive(t.hub, scriptedFs(t.fs, [{ method: 'readdir', nth: 1, code: 'EACCES' }]), t.now)).toBe(true);
    const p = join(t.folder('o/a'), 'blobs', 'e'.repeat(64) + '.incomplete');
    await writeFile(p, 'x');
    await utimes(p, new Date(), new Date(t.now - 3_600_000));
    expect(await hubDownloadActive(t.hub, scriptedFs(t.fs, [{ method: 'lstat', nth: 1, code: 'ENOENT', pathIncludes: '.incomplete' }]), t.now)).toBe(false);
    await utimes(p, new Date(), new Date(t.now - 60_000)); // active, but vanished: skipped
    expect(await hubDownloadActive(t.hub, scriptedFs(t.fs, [{ method: 'lstat', nth: 1, code: 'ENOENT', pathIncludes: '.incomplete' }]), t.now)).toBe(false);
    await utimes(p, new Date(), new Date(t.now - 3_600_000));
    expect(await hubDownloadActive(t.hub, scriptedFs(t.fs, [{ method: 'lstat', nth: 1, code: 'EACCES', pathIncludes: '.incomplete' }]), t.now)).toBe(true);
  });
});

describe('store ops: exactness (mutation gate)', () => {
  async function ctxOf(t: Tree, extra: Partial<StoreSweepCtx> = {}): Promise<StoreSweepCtx> {
    return { safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, hubRoot: t.hub, holdRoot: t.holdRoot, activeDownload: async () => false, ...extra };
  }
  const staleOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as StoreStaleError);

  it('the planned raw lines must match exactly (length and content); a payload gone or a .refs re-check failing is stale', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.permanent);
    await unlink(t.blob('o/a', W));
    const line = sweep.expectRefsRaw[0]!;
    for (const expectRefsRaw of [[], [line, line], ['models--o--z/blobs/q']]) {
      const e = await staleOf(applyStoreSweep({ ...sweep, expectRefsRaw }, await ctxOf(t)));
      expect(e).toBeInstanceOf(StoreStaleError);
      expect(e).toMatchObject({ name: 'StoreStaleError', path: sweep.refsPath, message: 'refs changed since review' });
    }
    // the third lstat of .refs (after the text read) failing
    const e3 = await staleOf(applyStoreSweep(sweep, await ctxOf(t, { fs: scriptedFs(t.fs, [{ method: 'lstat', nth: 3, code: 'EACCES', pathIncludes: sweep.refsPath }]) })));
    expect(e3).toMatchObject({ path: sweep.refsPath, message: 'refs changed since review' });
    await t.fs.rename(sweep.storePath, join(t.root, 'away'));
    expect(await staleOf(applyStoreSweep(sweep, await ctxOf(t)))).toMatchObject({ path: sweep.storePath, message: 'payload changed since review' });
  });

  it('notes list every remaining ref, comma-separated', async () => {
    const { t, pair } = await setup([storeRepo('o/a'), storeRepo('o/b'), storeRepo('o/c')]);
    const sweep = sweepOf(pair.permanent);
    const others = [`models--o--b/blobs/${t.etag('S', 2000)}`, `models--o--c/blobs/${t.etag('S', 2000)}`];
    const r = await applyStoreSweep({ ...sweep, payload: 'delete' }, await ctxOf(t));
    expect(r.note).toBe(`store payload ${basename(sweep.storePath)} kept: it is still referenced by ${[relTo(t, t.blob('o/a', W)), ...others].sort().join(', ')}`);
  });

  it('hold without createdDirs works, and createdDirs gets exactly the directories made, deepest first', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    const sweep = sweepOf(pair.hold!);
    await unlink(t.blob('o/a', W));
    const createdDirs: string[] = [];
    await applyStoreSweep(sweep, await ctxOf(t, { createdDirs }));
    const dest = join(t.holdRoot, ...sweep.holdDest!.split('/'));
    expect(createdDirs).toEqual([dirname(dest), dirname(dirname(dest)), dirname(dirname(dirname(dest)))]);
    const again = await setup([storeRepo('o/a')]);
    const s2 = sweepOf(again.pair.hold!);
    await unlink(again.t.blob('o/a', W));
    await expect(applyStoreSweep(s2, await ctxOf(again.t))).resolves.toMatchObject({ undo: { payloadMovedTo: join(again.t.holdRoot, ...s2.holdDest!.split('/')) } });
  });

  it('store-refs-add: malformed lines refused; empty lines dropped; a .refs appearing during the read is stale', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const ctx = { safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, hubRoot: t.hub };
    const refs = t.store('S', 2000) + '.refs';
    const a = (await readFile(refs, 'utf8')).trim();
    for (const addRefs of [[''], [5], ['ok/x', 'a\rb'], ['ok/x', '']] as unknown[][]) {
      await expect(applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: addRefs as string[], expectRefsRaw: [a] }, ctx)).rejects.toThrow('malformed reference line');
    }
    await writeFile(refs, `${a}\n\n`);
    await applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--0/blobs/k'], expectRefsRaw: [a, ''] }, ctx);
    expect(await readFile(refs, 'utf8')).toBe(`models--o--0/blobs/k\n${a}\n`);
    await unlink(refs);
    let n = 0;
    const appearing = Object.assign(Object.create(t.fs) as typeof t.fs, {
      lstat: (async (p: string) => {
        if (p === refs && n++ === 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        if (p === refs && n === 2) await writeFile(refs, `${a}\n`);
        return t.fs.lstat(p);
      }) as typeof t.fs.lstat,
    });
    await expect(applyStoreRefsAdd({ kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--0/blobs/k'], expectRefsRaw: null }, { ...ctx, fs: appearing }))
      .rejects.toThrow('refs changed since review');
  });

  it('hubDownloadActive: exactly ACTIVE_WINDOW_MS old is no longer active', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const p = join(t.folder('o/a'), 'blobs', 'e'.repeat(64) + '.incomplete');
    await writeFile(p, 'x');
    const m = (await lstat(p)).mtimeMs;
    expect(await hubDownloadActive(t.hub, t.fs, m + ACTIVE_WINDOW_MS)).toBe(false);
    expect(await hubDownloadActive(t.hub, t.fs, m + ACTIVE_WINDOW_MS - 1)).toBe(true);
  });
});

describe('confirmSweepDeletable (re-check right before a payload is removed or held)', () => {
  it('null only for a marked, unlocked regular store file with known, empty refs at a store path', async () => {
    const t = await buildTree({ repos: [storeRepo('o/a')] });
    const base = (await t.scan()).store[t.store('S', 2000)]!;
    const ok = { ...base, validRefs: [] as string[], refsRaw: [] as string[] };
    expect(confirmSweepDeletable(ok, true)).toBeNull();
    const refused = 'its references could not be confirmed (store-uncertain)';
    expect(confirmSweepDeletable(ok, false)).toBe(refused);
    expect(confirmSweepDeletable({ ...ok, lockPresent: true }, true)).toBe(refused);
    expect(confirmSweepDeletable({ ...ok, validRefs: null }, true)).toBe(refused);
    expect(confirmSweepDeletable({ ...ok, refsRaw: null }, true)).toBe(refused);
    expect(confirmSweepDeletable({ ...ok, facts: { ...ok.facts, isSymlink: true } }, true)).toBe(refused);
    expect(confirmSweepDeletable({ ...ok, path: join(t.hub, 'blobs', 'zz', 'x') }, true)).toBe(refused);
    expect(confirmSweepDeletable({ ...ok, validRefs: ['models--o--a/blobs/x'] }, true)).toBe('its references could not be confirmed (store-shared)');
  });

  it('a refusal at that point keeps the payload and .refs untouched and registers no undo', async () => {
    const { t, pair } = await setup([storeRepo('o/a')]);
    for (const plan of [pair.permanent, pair.hold!]) {
      const sweep = sweepOf(plan);
      if (existsSync(t.blob('o/a', W))) await unlink(t.blob('o/a', W));
      const text = await readFile(sweep.refsPath, 'utf8');
      const seen: unknown[] = [];
      const r = await applyStoreSweep(sweep, {
        safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, hubRoot: t.hub, holdRoot: t.holdRoot, activeDownload: async () => false,
        onUndo: (u) => seen.push(u), confirmDeletable: () => 'a lock appeared',
      });
      expect(r).toEqual({ note: `store payload ${basename(sweep.storePath)} kept: a lock appeared`, undo: { refsBefore: null, payloadMovedTo: null } });
      expect(seen).toEqual([]);
      expect(existsSync(sweep.storePath)).toBe(true);
      expect(await readFile(sweep.refsPath, 'utf8')).toBe(text);
    }
  });
});
