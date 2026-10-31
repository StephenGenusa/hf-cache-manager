// Hold-mode rollback (plan ; –7).
// Every tree is real (temp dir, real symlinks), every fs is the fixture's guarded t.fs, and faults are injected
// with scriptedFs over t.fs, hooks, or a wrapped journal.
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { appendFile, link as hardLink, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  executePlan, failurePath, holdDirOf, reverseGuarded, rollbackError, rollbackIndices, sameItem, toFailure, unexpectedFailureMessage, type ExecDeps,
} from '../../../src/core/exec/executor';
import { STALE_MESSAGE } from '../../../src/core/exec/errors';
import { Journal } from '../../../src/core/exec/journal';
import { AppLock } from '../../../src/core/exec/lock';
import { factsOf } from '../../../src/core/fsx';
import { fingerprintPlan } from '../../../src/core/plan/fingerprint';
import { planDeletion } from '../../../src/core/plan/planner';
import { SafeFs, SafeFsError, type AttemptHook } from '../../../src/core/safe-fs';
import type { CacheModel, DeletionPlan, FileFacts, Op, PlanPair, RepoSelection, Selection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { scriptedFs, type ScriptedRule } from '../../helpers/failing-fs';
import { diffTrees, snapshotTree, type TreeEntry } from '../support/observe';
import { buildTree, f, groupKeyFor, type RepoSpec, type Tree, type TreeSpec } from '../support/scenarios';
import { lmstudioViews, stubViews } from '../support/stub-views';

useCanaries();

const Q4 = 'm-Q4_K_M.gguf';
const S1 = 'q4/m-Q4_K_M-00001-of-00002.gguf';
const S2 = 'q4/m-Q4_K_M-00002-of-00002.gguf';
const EMPTY = { removed: [], added: [], changed: [] };
const gguf = (id: string): RepoSpec => ({
  id, snapshots: { c1: { [Q4]: f('blob', `Q4${id}`, 4000), 'm-Q8_0.gguf': f('blob', `Q8${id}`, 8000), 'config.json': f('small', `cfg${id}`, 30) } },
});
/** o/a: a two-shard Q4 in q4/ (shard 2 in the shared store), so its hold plan has a view link, 2 snapshot links,
 *  2 repo blobs, a held store payload and an rmdir-empty. With `shared`, o/b holds the same store payload. */
const mixedRepos = (shared = false): RepoSpec[] => [
  { id: 'o/a', snapshots: { c1: { [S1]: f('blob', 'A1', 4000), [S2]: f('store', 'A2', 3000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000), 'config.json': f('small', 'cfg', 30) } } },
  { id: 'o/b', snapshots: { c1: { 'x.gguf': f('blob', 'B', 100), ...(shared ? { 'y.gguf': f('store', 'A2', 3000) } : {}) } } },
];
const part = (m: CacheModel, id: string, rel: string): RepoSelection =>
  ({ repoId: id, whole: false, groupKeys: [groupKeyFor(m, id, rel)], unlockComponents: false });

interface Ctx { t: Tree; pair: PlanPair; plan: DeletionPlan; holdDir: string }

async function setup(
  repos: RepoSpec[], pick: (m: CacheModel) => RepoSelection[], spec: Partial<TreeSpec> = {}, withViews = false,
  beforePlan?: (t: Tree) => Promise<void>,
): Promise<Ctx> {
  const t = await buildTree({ repos, ...spec });
  if (beforePlan) await beforePlan(t);
  const m = await t.scan();
  const selection: Selection = { repos: pick(m) };
  const views = withViews ? lmstudioViews(t.lmstudioRoot, t.fs) : stubViews();
  const pair = await planDeletion({ model: m, selection, roots: t.roots, views, now: t.now });
  const plan = pair.hold!;
  return { t, pair, plan, holdDir: join(t.holdRoot, plan.deletionId!) };
}
const mixed = (shared = false, beforePlan?: (t: Tree) => Promise<void>): Promise<Ctx> =>
  setup(mixedRepos(shared), (m) => [part(m, 'o/a', S1)], { lmstudio: [{ rel: 'o/a/m.gguf', repo: 'o/a', file: S1 }] }, true, beforePlan);
const mixedWhole = (): Promise<Ctx> =>
  setup(mixedRepos(), () => [{ repoId: 'o/a', whole: true }], { lmstudio: [{ rel: 'o/a/m.gguf', repo: 'o/a', file: S1 }] }, true);

/** A copy of `plan` with `patch` applied and a fingerprint recomputed for the new content. */
function forge(plan: DeletionPlan, patch: Partial<DeletionPlan>): DeletionPlan {
  const p = { ...structuredClone(plan), ...patch };
  return { ...p, fingerprint: fingerprintPlan(p) };
}

async function deps(t: Tree, extra: Partial<ExecDeps> = {}): Promise<ExecDeps> {
  return {
    safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs, journal: new Journal(t.appData, () => t.now), lock: new AppLock(t.lockDir),
    rescan: () => t.scan(), now: () => t.now, diskFree: async () => 1e12, ...extra,
  };
}
const run = async (t: Tree, plan: DeletionPlan, extra: Partial<ExecDeps> = {}) => executePlan(plan, await deps(t, extra));
/** run with SafeFs over scriptedFs(t.fs, rules) (the scripted fs wraps the guarded fs). */
async function runScripted(t: Tree, plan: DeletionPlan, rules: ScriptedRule[], extra: Partial<ExecDeps> = {}) {
  const sfs = scriptedFs(t.fs, rules);
  const r = await run(t, plan, { safeFs: await SafeFs.create(t.roots, sfs), ...extra });
  return { r, sfs };
}
const failAfter = (k: number): Partial<ExecDeps> =>
  ({ hooks: { afterOp: async (_p, i) => { if (i === k) throw new Error(`injected failure after op ${k}`); } } });
const journalLines = async (t: Tree): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(t.appData, 'journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
type Kind<K extends Op['kind']> = Extract<Op, { kind: K }>;
const opsOf = <K extends Op['kind']>(plan: DeletionPlan, kind: K): Array<Kind<K>> => plan.ops.filter((o): o is Kind<K> => o.kind === kind);
const indexOf = (plan: DeletionPlan, kind: Op['kind'], n = 0): number => plan.ops.map((o, i) => (o.kind === kind ? i : -1)).filter((i) => i >= 0)[n]!;
const lockFree = (t: Tree): boolean => !existsSync(join(t.lockDir, 'app.lock'));
/** FsLike methods that never remove an entry; every other recorded call (unlink, the directory remover) removes one. */
const KEEPS = new Set(['lstat', 'stat', 'readlink', 'readdir', 'readFile', 'writeFile', 'rename', 'mkdir', 'symlink', 'link', 'realpath']);
/** A SafeFs whose `nth` rmdirEmpty under `under` fails with IO `code` (the op's own SafeFs call; nothing removed). */
function failingRmdirEmpty(real: SafeFs, under: string, nth: number, code: string): SafeFs {
  let n = 0;
  return new Proxy(real, { get: (target, k, recv) => (k !== 'rmdirEmpty' ? Reflect.get(target, k, recv) as unknown
    : async (p: string, hook?: AttemptHook) => {
      if (p.startsWith(under) && ++n === nth) throw new SafeFsError('IO', p, `${code}: injected`, code); // refused before acting
      return target.rmdirEmpty(p, hook);
    }) });
}

/**
 * The hub is exactly as before (dir and symlink inodes ignored, since the rollback recreates removed dirs; files
 * still compare inode). The only allowed change: a `.refs` the rollback rewrote has a new inode with identical bytes.
 */
function expectHubRestored(before: Map<string, TreeEntry>, after: Map<string, TreeEntry>): void {
  const d = diffTrees(before, after, { ignoreIno: 'dirs+links' });
  expect(d.removed).toEqual([]);
  expect(d.added).toEqual([]);
  for (const p of d.changed) {
    expect(p.endsWith('.refs')).toBe(true);
    expect(after.get(p)).toMatchObject({ type: 'file', sha256: before.get(p)!.sha256, size: before.get(p)!.size });
  }
}
/** Nothing but (possibly) empty directories left under the hold root, and the deletion folder is gone. */
async function expectHoldEmpty(t: Tree, holdDir: string): Promise<void> {
  expect([...(await snapshotTree(t.holdRoot)).values()].filter((e) => e.type !== 'dir')).toEqual([]);
  expect(existsSync(holdDir)).toBe(false);
}

describe('hold rollback', () => {
  it('inv6: EXDEV on the 3rd hold-rename → ROLLED_BACK, hub and views byte-identical, no files under holdRoot, unlink never called on the hub', async () => {
    const { t, plan, holdDir } = await setup(mixedRepos(), (m) => [part(m, 'o/a', S1)]);
    const renames = opsOf(plan, 'hold-rename');
    expect(renames.length).toBe(4);
    const beforeHub = await snapshotTree(t.hub);
    const beforeViews = await snapshotTree(t.lmstudioRoot);
    const { r, sfs } = await runScripted(t, plan, [{ method: 'rename', nth: 3, code: 'EXDEV', pathIncludes: holdDir }]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(r.error!.message).toContain('EXDEV');
    expect(r.error!.message).toContain(renames[2]!.path);
    expect(r.error!.path).toBe(renames[2]!.path);
    expect(r.error!.message).not.toContain(STALE_MESSAGE);
    expect(diffTrees(beforeHub, await snapshotTree(t.hub), { ignoreIno: 'dirs+links' })).toEqual(EMPTY);
    expect(diffTrees(beforeHub, await snapshotTree(t.hub))).toEqual(EMPTY); // nothing recreated here: even dir inodes match
    expect(diffTrees(beforeViews, await snapshotTree(t.lmstudioRoot))).toEqual(EMPTY);
    await expectHoldEmpty(t, holdDir);
    expect(sfs.calls.filter((c) => c.method === 'unlink' && String(c.args[0]).startsWith(t.hub))).toEqual([]);
    expect(sfs.calls.filter((c) => ['copyFile', 'cp', 'writeFile', 'open'].includes(c.method) && String(c.args[0]).startsWith(t.hub))).toEqual([]);
    expect(r.heldBytes).toBe(0);
    expect(lockFree(t)).toBe(true);
    // the moved items came back with the same inodes
    for (const o of renames.slice(0, 2)) expect((await lstat(o.path)).ino).toBe(o.expect.ino);
  });

  it('inv6: failure after a store-sweep restores the payload and the exact .refs bytes', async () => {
    const { t, plan, holdDir } = await mixed();
    const sweep = opsOf(plan, 'store-sweep')[0]!;
    expect(sweep.payload).toBe('hold');
    const before = await snapshotTree(t.hub);
    const refsBytes = await readFile(sweep.refsPath);
    const r = await run(t, plan, failAfter(indexOf(plan, 'store-sweep')));
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(r.error!.message).toContain('injected failure after op');
    expect((await lstat(sweep.storePath)).ino).toBe(sweep.expect.ino);
    expect(await readFile(sweep.refsPath)).toEqual(refsBytes);
    expectHubRestored(before, await snapshotTree(t.hub));
    await expectHoldEmpty(t, holdDir);
  });

  it('inv6: a shared payload kept by the sweep — the rewritten .refs gets back its exact earlier bytes (unsorted, as found)', async () => {
    // .refs written by someone in reverse order: huggingface_hub's rewrite sorts; the rollback must restore the original
    const { t, plan, holdDir } = await mixed(true, async (tt) => {
      const refs = tt.store('A2', 3000) + '.refs';
      const lines = (await readFile(refs, 'utf8')).trim().split('\n').sort().reverse();
      expect(lines.length).toBe(2);
      await writeFile(refs, lines.map((l) => `${l}\n`).join(''));
    });
    const sweep = opsOf(plan, 'store-sweep')[0]!;
    expect(sweep.payload).toBe('keep');
    const refsBytes = await readFile(sweep.refsPath, 'utf8');
    const before = await snapshotTree(t.hub);
    let rewritten = '';
    const k = indexOf(plan, 'store-sweep');
    const r = await run(t, plan, { hooks: { afterOp: async (_p, i) => {
      if (i === k) { rewritten = await readFile(sweep.refsPath, 'utf8'); throw new Error('boom'); }
    } } });
    expect(rewritten).not.toBe(refsBytes); // the sweep really rewrote it
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(refsBytes);
    expectHubRestored(before, await snapshotTree(t.hub));
    await expectHoldEmpty(t, holdDir);
  });

  it('inv6: a sweep failing part-way (payload held, .refs unlink fails) → the payload is renamed back, .refs never rewritten', async () => {
    const { t, plan, holdDir } = await mixed();
    const sweep = opsOf(plan, 'store-sweep')[0]!;
    const refsIno = (await lstat(sweep.refsPath)).ino;
    const before = await snapshotTree(t.hub);
    const { r, sfs } = await runScripted(t, plan, [{ method: 'unlink', nth: 1, code: 'EACCES', pathIncludes: '.refs' }]);
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(r.error!.path).toBe(sweep.refsPath);
    expect(diffTrees(before, await snapshotTree(t.hub), { ignoreIno: 'dirs+links' })).toEqual(EMPTY); // .refs: same inode
    expect((await lstat(sweep.refsPath)).ino).toBe(refsIno);
    expect(sfs.calls.filter((c) => c.method === 'writeFile')).toEqual([]);
    await expectHoldEmpty(t, holdDir);
  });

  it('failure after view unlinks (symlink, regular file) and a view rmdir-empty → view root byte-identical, ROLLED_BACK', async () => {
    const { t, plan, holdDir } = await mixed();
    const link = opsOf(plan, 'unlink')[0]!;
    expect(link.role).toBe('view-link');
    const target = await readlink(link.path);
    // a regular view file and the view folder emptied by the link removal, both ahead of the hub ops
    const file = join(dirname(link.path), 'notes.txt');
    await writeFile(file, 'view file bytes\n');
    // pins the inode, so the re-created file cannot reuse it (the diff below then always sees the change)
    await hardLink(file, join(t.root, 'pin-inode'));
    const fileOp: Op = { kind: 'unlink', path: file, expect: (await factsOf(t.fs, file))!, role: 'view-manifest' };
    const rmdirOp: Op = { kind: 'rmdir-empty', path: dirname(link.path) };
    const forged = forge(plan, { ops: [link, fileOp, rmdirOp, ...plan.ops.slice(1)] });
    const beforeHub = await snapshotTree(t.hub);
    const beforeViews = await snapshotTree(t.lmstudioRoot);
    const r = await run(t, forged, failAfter(forged.ops.length - 2)); // after the store sweep
    expect(r.error!.code, r.error!.message).toBe('ROLLED_BACK');
    expect(diffTrees(beforeViews, await snapshotTree(t.lmstudioRoot), { ignoreIno: 'dirs+links' })).toEqual({ removed: [], added: [], changed: [file] });
    expect(await readFile(file, 'utf8')).toBe('view file bytes\n'); // same bytes; a re-created file has a new inode
    expect(await readlink(link.path)).toBe(target);
    expectHubRestored(beforeHub, await snapshotTree(t.hub));
    await expectHoldEmpty(t, holdDir);
    const lines = await journalLines(t);
    expect(lines.find((l) => l.t === 'after' && l.i === 2)).not.toHaveProperty('note'); // the view folder really was removed
    const rb = lines.filter((l) => l.t === 'rollback' && [0, 1, 2].includes(l.i as number));
    expect(rb.map((l) => [l.i, l.ok])).toEqual([[2, true], [1, true], [0, true]]);
  });

  it('a view entry that cannot be restored (something else now at its path) → IO listing it; the rest still reversed', async () => {
    const { t, plan, holdDir } = await mixed();
    const link = opsOf(plan, 'unlink')[0]!;
    const beforeHub = await snapshotTree(t.hub);
    const r = await run(t, plan, { hooks: { afterOp: async (_p, i) => {
      if (i === 0) await writeFile(link.path, 'someone else');
      if (i === 2) throw new Error('boom');
    } } });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toMatch(/^Rollback incomplete: afterOp hook failed: boom/);
    expect(r.error!.message).toContain(`the view entry ${link.path} was not restored`);
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringContaining(`not rolled back: the view entry ${link.path}`)]));
    expect(await readFile(link.path, 'utf8')).toBe('someone else'); // never overwritten
    expectHubRestored(beforeHub, await snapshotTree(t.hub));
    await expectHoldEmpty(t, holdDir);
  });

  it('a view symlink re-creation failing inside SafeFs → IO naming it, hub restored', async () => {
    const { t, plan, holdDir } = await mixed();
    const link = opsOf(plan, 'unlink')[0]!;
    const beforeHub = await snapshotTree(t.hub);
    const { r } = await runScripted(t, plan, [{ method: 'symlink', nth: 1, code: 'EACCES', pathIncludes: link.path }], failAfter(3));
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toContain(`the view entry ${link.path} was not restored`);
    expect(r.error!.message).toContain('EACCES');
    expect(existsSync(link.path)).toBe(false);
    expectHubRestored(beforeHub, await snapshotTree(t.hub));
    await expectHoldEmpty(t, holdDir);
  });

  it('inv6: failure on the 2nd rmdir-empty recreates the first dir and renames everything back', async () => {
    const deep = 'q4/a/m-Q4_K_M-00001-of-00002.gguf';
    const { t, plan, holdDir } = await setup(
      [{ id: 'o/a', snapshots: { c1: { [deep]: f('blob', 'D1', 4000), 'q4/a/m-Q4_K_M-00002-of-00002.gguf': f('blob', 'D2', 4000), 'config.json': f('small', 'c', 30) } } }],
      (m) => [part(m, 'o/a', deep)],
    );
    const rmdirs = opsOf(plan, 'rmdir-empty');
    expect(rmdirs.map((o) => basename(o.path))).toEqual(['a', 'q4']);
    const before = await snapshotTree(t.hub);
    const r = await run(t, plan, { safeFs: failingRmdirEmpty(await SafeFs.create(t.roots, t.fs), t.hub, 2, 'EACCES') });
    expect(r.error).toMatchObject({ code: 'ROLLED_BACK', path: rmdirs[1]!.path });
    expect((await lstat(rmdirs[0]!.path)).isDirectory()).toBe(true);
    // The recreated dir may get a new inode (the filesystem may also reuse the old one), so dir inodes are ignored
    expect(diffTrees(before, await snapshotTree(t.hub), { ignoreIno: 'dirs+links' })).toEqual(EMPTY);
    await expectHoldEmpty(t, holdDir);
  });

  it('inv6: failure after a write-file restores before (or removes the file when before was null)', async () => {
    const { t, plan, holdDir } = await setup([gguf('o/a'), gguf('o/b')], (m) => [part(m, 'o/a', Q4)]);
    const fresh = join(t.lmstudioRoot, 'state-new.json');
    const old = join(t.lmstudioRoot, 'state-old.json');
    await writeFile(old, 'old state\n');
    const forged = forge(plan, { ops: [
      { kind: 'write-file', path: fresh, before: null, after: 'new\n', role: 'view-state' },
      { kind: 'write-file', path: old, before: 'old state\n', after: 'rewritten\n', role: 'view-state' },
      ...plan.ops,
    ] });
    const beforeHub = await snapshotTree(t.hub);
    const { r, sfs } = await runScripted(t, forged, [{ method: 'rename', nth: 2, code: 'EXDEV', pathIncludes: holdDir }]);
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(existsSync(fresh)).toBe(false);
    expect(await readFile(old, 'utf8')).toBe('old state\n');
    // the only unlink of the run is the file this run created
    expect(sfs.calls.filter((c) => c.method === 'unlink').map((c) => c.args[0])).toEqual([fresh]);
    expectHubRestored(beforeHub, await snapshotTree(t.hub));
    await expectHoldEmpty(t, holdDir);
  });

  it('a written file changed by someone else after the write is left alone → IO "Rollback incomplete" naming it', async () => {
    const { t, plan } = await setup([gguf('o/a'), gguf('o/b')], (m) => [part(m, 'o/a', Q4)]);
    const fresh = join(t.lmstudioRoot, 'state-new.json');
    const forged = forge(plan, { ops: [{ kind: 'write-file', path: fresh, before: null, after: 'new\n', role: 'view-state' }, ...plan.ops] });
    const beforeHub = await snapshotTree(t.hub);
    const r = await run(t, forged, { hooks: { afterOp: async (_p, i) => {
      if (i === 0) await writeFile(fresh, 'someone else\n');
      if (i === 2) throw new Error('boom');
    } } });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toMatch(/^Rollback incomplete: /);
    expect(r.error!.message).toContain(`${fresh} was not restored`);
    expect(await readFile(fresh, 'utf8')).toBe('someone else\n');
    expectHubRestored(beforeHub, await snapshotTree(t.hub)); // the renames were still reversed
  });

  it('inv6: never falls back to unlink of a held item when rename fails (forward and reverse renames failing)', async () => {
    const { t, plan, holdDir } = await setup(mixedRepos(), (m) => [part(m, 'o/a', S1)]);
    const renames = opsOf(plan, 'hold-rename');
    // forward: the 3rd hold-rename fails; reverse: both moved-back renames fail too
    const rules: ScriptedRule[] = [
      { method: 'rename', nth: 3, code: 'EXDEV', pathIncludes: holdDir },
      { method: 'rename', nth: 2, code: 'EXDEV', pathIncludes: renames[0]!.dest },
      { method: 'rename', nth: 2, code: 'EPERM', pathIncludes: renames[1]!.dest },
    ];
    const { r, sfs } = await runScripted(t, plan, rules);
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toMatch(/^Rollback incomplete: /);
    // nothing removed anywhere, except empty dirs this run created under the hold root
    expect(sfs.calls.filter((c) => c.method === 'unlink')).toEqual([]);
    expect(sfs.calls.filter((c) => !KEEPS.has(c.method) && !String(c.args[0]).startsWith(t.holdRoot))).toEqual([]);
    expect(sfs.calls.filter((c) => ['copyFile', 'cp', 'writeFile', 'open'].includes(c.method))).toEqual([]);
    for (const o of renames.slice(0, 2)) {
      expect((await lstat(o.dest)).ino).toBe(o.expect.ino); // still held, intact
      expect(r.error!.message).toContain(`${o.dest} is still in Recently Deleted (it belongs at ${o.path})`);
      expect(r.notes).toEqual(expect.arrayContaining([expect.stringContaining(o.dest)]));
    }
    expect(existsSync(renames[2]!.path)).toBe(true);
    expect(lockFree(t)).toBe(true);
  });

  it('a failing reverse rename → IO "Rollback incomplete…", remaining reversals still attempted, journal has rollback records', async () => {
    const { t, plan, holdDir } = await mixed();
    const renames = opsOf(plan, 'hold-rename');
    const stuck = renames[0]!; // reversed last of the renames: the ones after it are reversed first, the view after it
    const k = indexOf(plan, 'rmdir-empty');
    const before = await snapshotTree(t.hub);
    const { r } = await runScripted(t, plan, [{ method: 'rename', nth: 2, code: 'EACCES', pathIncludes: stuck.dest }], failAfter(k));
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toMatch(/^Rollback incomplete: afterOp hook failed: injected failure after op \d+/);
    expect(r.error!.message).toContain(`${stuck.dest} is still in Recently Deleted (it belongs at ${stuck.path})`);
    expect(r.error!.message).toContain('EACCES');
    // everything else is back; the stuck link is intact in the hold dir, and the dirs holding it were kept
    const d = diffTrees(before, await snapshotTree(t.hub), { ignoreIno: 'dirs+links' });
    expect(d.removed).toEqual([stuck.path]);
    expect(d.added).toEqual([]);
    expect(await readlink(stuck.dest)).toBe(stuck.expect.linkTarget);
    expect(existsSync(holdDir)).toBe(true);
    expect([...(await snapshotTree(t.holdRoot)).values()].filter((e) => e.type !== 'dir').map((e) => e.path)).toEqual([stuck.dest]);
    const rb = (await journalLines(t)).filter((l) => l.t === 'rollback');
    const iStuck = plan.ops.indexOf(stuck);
    expect(rb.map((l) => l.i)).toEqual(plan.ops.map((_, i) => i).reverse()); // every op, in reverse order
    expect(rb.find((l) => l.i === iStuck)).toMatchObject({ ok: false, error: expect.stringContaining('EACCES') });
    for (const l of rb) if (l.i !== iStuck && l.i !== indexOf(plan, 'unlink')) expect(l.ok).toBe(true);
    const end = (await journalLines(t)).at(-1)!;
    expect(end).toMatchObject({ t: 'end', result: { ok: false, error: { code: 'IO' } } });
    expect(lockFree(t)).toBe(true);
  });

  it('rollback removes the empty dirs it created under <holdRoot>/<deletionId>; a non-empty one (manifest) is kept', async () => {
    const { t, plan, holdDir } = await mixed();
    const r = await run(t, plan, failAfter(indexOf(plan, 'store-sweep')));
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(existsSync(holdDir)).toBe(false);
    expect((await lstat(t.holdRoot)).isDirectory()).toBe(true); // the hold root itself is never removed
    expect(await t.fs.readdir(t.holdRoot)).toEqual([]);

    const c2 = await mixed();
    const manifest = join(c2.holdDir, 'manifest.json');
    const r2 = await run(c2.t, c2.plan, {
      hooks: { beforeFirstOp: async () => { await writeFile(manifest, '{}'); }, afterOp: failAfter(indexOf(c2.plan, 'store-sweep')).hooks!.afterOp! },
    });
    expect(r2.error!.code).toBe('ROLLED_BACK');
    expect(await t.fs.readdir(c2.holdDir)).toEqual(['manifest.json']); // everything else under it was removed
    expect(await readFile(manifest, 'utf8')).toBe('{}');
  });
});

describe('failure at every op index of a mixed hold plan (links, blobs, store sweep, rmdir, view)', () => {
  const check = async (c: Ctx, inject: (plan: DeletionPlan) => Partial<ExecDeps> | Promise<Partial<ExecDeps>>, label: string): Promise<void> => {
    const before = await snapshotTree(c.t.hub);
    const beforeViews = await snapshotTree(c.t.lmstudioRoot);
    const r = await run(c.t, c.plan, await inject(c.plan));
    expect(r.ok, label).toBe(false);
    expect(r.error!.code, `${label}: ${r.error!.message}`).toBe('ROLLED_BACK');
    expectHubRestored(before, await snapshotTree(c.t.hub));
    expect(diffTrees(beforeViews, await snapshotTree(c.t.lmstudioRoot), { ignoreIno: 'dirs+links' }), label).toEqual(EMPTY);
    await expectHoldEmpty(c.t, c.holdDir);
    expect(lockFree(c.t)).toBe(true);
  };
  it('afterOp throwing after op i, for every i (partial plan and whole repo)', async () => {
    for (const make of [mixed, mixedWhole]) {
      const n = (await make()).plan.ops.length;
      expect(n).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < n; i++) await check(await make(), () => failAfter(i), `after op ${i}`);
    }
    const kinds = (await mixed()).plan.ops.map((o) => o.kind);
    expect(new Set(kinds)).toEqual(new Set(['unlink', 'hold-rename', 'store-sweep', 'rmdir-empty']));
  });
  it('the journal before-record failing at op i, for every i ≥ 1', async () => {
    const n = (await mixed()).plan.ops.length;
    for (let i = 1; i < n; i++) {
      const c = await mixed();
      const journal = new Journal(c.t.appData, () => c.t.now);
      const wrapped = Object.assign(Object.create(journal) as Journal, {
        before: (id: string, k: number, op: Op) => (k === i ? Promise.reject(new Error('ENOSPC: disk full')) : journal.before(id, k, op)),
      });
      await check(c, () => ({ journal: wrapped }), `journal before ${i}`);
    }
  });
  it('the op itself failing inside SafeFs (EXDEV / EACCES), for each hub-changing op', async () => {
    const rules = (c: Ctx): ScriptedRule[] => [
      ...opsOf(c.plan, 'hold-rename').map((o) => ({ method: 'rename', nth: 1, code: 'EXDEV', pathIncludes: o.dest })),
      { method: 'rename', nth: 1, code: 'EXDEV', pathIncludes: join(c.holdDir, 'store') },  // the held payload
      { method: 'unlink', nth: 1, code: 'EACCES', pathIncludes: '.refs' },                // the sweep, after the payload moved
    ];
    const count = rules(await mixed()).length;
    expect(count).toBe(6);
    for (let k = 0; k < count; k++) {
      const c = await mixed();
      const rule = rules(c)[k]!;
      await check(c, async () => ({ safeFs: await SafeFs.create(c.t.roots, scriptedFs(c.t.fs, [rule])) }), `${rule.method} ${rule.pathIncludes}`);
    }
    // the rmdir-empty itself failing (its SafeFs call)
    const c = await mixed();
    await check(c, async () => ({ safeFs: failingRmdirEmpty(await SafeFs.create(c.t.roots, c.t.fs), c.t.hub, 1, 'EACCES') }), 'rmdir-empty');
  });
});

describe('lock release, start-phase failures, exclusive deletion folder', () => {
  it('the rollback itself throwing → IO "Rollback incomplete", executePlan resolves, the lock is released', async () => {
    const { t, plan } = await mixed();
    const real = await SafeFs.create(t.roots, t.fs);
    let armed = false;
    // A SafeFs whose roots cannot be read once the failure happened: the rollback cannot even start
    const hostile = new Proxy(real, { get: (target, k, recv) => {
      if (armed && k === 'roots') throw new Error('roots unavailable');
      return Reflect.get(target, k, recv) as unknown;
    } });
    const r = await run(t, plan, {
      safeFs: hostile,
      hooks: { afterOp: async (_p, i) => { if (i === 2) { armed = true; throw new Error('boom'); } } },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'IO' } });
    expect(r.error!.message).toMatch(/^Rollback incomplete: afterOp hook failed: boom; the rollback itself failed \(roots unavailable\)/);
    expect(r.error!.message).toContain(join(t.holdRoot, plan.deletionId!));
    expect(lockFree(t)).toBe(true);
  });

  it('a journal and diskFree that throw synchronously still give a result and release the lock', async () => {
    const { t, plan } = await mixed();
    const journal = new Journal(t.appData, () => t.now);
    const bad = Object.assign(Object.create(journal) as Journal, {
      rollback: () => { throw new Error('journal gone'); },
      end: () => { throw new Error('journal gone'); },
    });
    let n = 0;
    const r = await run(t, plan, { journal: bad, diskFree: async () => { if (n++ > 0) throw new Error('statfs'); return 1; }, ...failAfter(1) });
    expect(r.error!.code).toBe('ROLLED_BACK'); // the disk is fully restored; the missing records are notes
    expect(r.notes).toEqual(expect.arrayContaining([
      expect.stringContaining('journal rollback record'), expect.stringContaining('journal end record'), expect.stringContaining('free space'),
    ]));
    expect(lockFree(t)).toBe(true);
  });

  it('mkdirp of the deletion folder failing → IO (never the stale-plan message), hub untouched, no folder left', async () => {
    const { t, plan, holdDir } = await mixed();
    const before = await snapshotTree(t.root);
    const { r } = await runScripted(t, plan, [{ method: 'mkdir', nth: 1, code: 'EACCES', pathIncludes: plan.deletionId! }]);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO' } });
    expect(r.error!.message).toMatch(/^Could not prepare the operation: .*EACCES/);
    expect(r.error!.message).not.toContain(STALE_MESSAGE);
    expect(existsSync(holdDir)).toBe(false);
    const d = diffTrees(before, await snapshotTree(t.root));
    expect(d.removed).toEqual([]);
    expect(d.changed.filter((p) => !p.startsWith(t.appData))).toEqual([]);
    expect(d.added.filter((p) => !p.startsWith(t.appData))).toEqual([]);
    expect(lockFree(t)).toBe(true);
  });

  it('a deletion folder appearing after revalidation → IO, never merged into, its content untouched, hub untouched', async () => {
    const { t, plan, holdDir } = await mixed();
    const before = await snapshotTree(t.hub);
    const r = await run(t, plan, {
      rescan: async () => {
        await mkdir(holdDir);
        await writeFile(join(holdDir, 'manifest.json'), 'someone else');
        return t.scan();
      },
    });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', path: holdDir } });
    expect(r.error!.message).toMatch(/^Could not prepare the operation: EXISTS: directory already exists/);
    expect(await t.fs.readdir(holdDir)).toEqual(['manifest.json']);
    expect(await readFile(join(holdDir, 'manifest.json'), 'utf8')).toBe('someone else');
    expect(diffTrees(before, await snapshotTree(t.hub))).toEqual(EMPTY);
    expect(lockFree(t)).toBe(true);
  });

  it('a failing op whose rename took effect anyway is still moved back', async () => {
    const { t, plan, holdDir } = await mixed();
    const target = opsOf(plan, 'hold-rename')[1]!;
    const base = t.fs;
    // rename succeeds on disk, then reports an error
    const liar = { ...base, rename: async (a: string, b: string) => {
      await base.rename(a, b);
      if (b === target.dest) throw Object.assign(new Error('EIO: reported after the fact'), { code: 'EIO' });
    } };
    const before = await snapshotTree(t.hub);
    const r = await run(t, plan, { safeFs: await SafeFs.create(t.roots, liar as typeof base) });
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect((await lstat(target.path)).ino).toBe(target.expect.ino);
    expectHubRestored(before, await snapshotTree(t.hub));
    await expectHoldEmpty(t, holdDir);
  });

  it('a permanent plan is never rolled back (failure stays IO with the op path)', async () => {
    const { t, pair } = await mixed();
    const r = await run(t, pair.permanent, failAfter(1));
    expect(r.error!.code).toBe('IO');
    expect((await journalLines(t)).filter((l) => l.t === 'rollback')).toEqual([]);
  });
});

describe('captured facts, took-effect failing ops, appliedOps', () => {
  /** A ReadFs over t.fs that, once armed, replaces `p` (tmp + rename, same text) right after reading it. */
  const replacingFs = (t: Tree, p: string, armed: () => boolean) => Object.assign(Object.create(t.fs) as typeof t.fs, {
    readFile: (async (q: string, enc?: 'utf8') => {
      const out = enc ? await t.fs.readFile(q, enc) : await t.fs.readFile(q);
      if (armed() && q === p) {
        await writeFile(`${p}.swap`, out);
        await rename(`${p}.swap`, p);
      }
      return out;
    }) as typeof t.fs.readFile,
  });

  it('finding 1: a written file replaced between the read and the unlink is not removed → IO naming it', async () => {
    const { t, plan, holdDir } = await setup(mixedRepos(), (m) => [part(m, 'o/a', S1)]);
    const fresh = join(t.lmstudioRoot, 'state-new.json');
    const forged = forge(plan, { ops: [{ kind: 'write-file', path: fresh, before: null, after: 'new\n', role: 'view-state' }, ...plan.ops] });
    let armed = false;
    const beforeHub = await snapshotTree(t.hub);
    const r = await run(t, forged, {
      fs: replacingFs(t, fresh, () => armed),
      hooks: { afterOp: async (_p, i) => { if (i === 2) { armed = true; throw new Error('boom'); } } },
    });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toContain(`${fresh} was not restored`);
    expect(await readFile(fresh, 'utf8')).toBe('new\n'); // the replacement is still there
    expectHubRestored(beforeHub, await snapshotTree(t.hub));
    await expectHoldEmpty(t, holdDir);
  });

  it('finding 1: a written file replaced between the read and the restore is not overwritten → IO naming it', async () => {
    const { t, plan } = await setup(mixedRepos(), (m) => [part(m, 'o/a', S1)]);
    const old = join(t.lmstudioRoot, 'state-old.json');
    await writeFile(old, 'old\n');
    const forged = forge(plan, { ops: [{ kind: 'write-file', path: old, before: 'old\n', after: 'rewritten\n', role: 'view-state' }, ...plan.ops] });
    let armed = false;
    const r = await run(t, forged, {
      fs: replacingFs(t, old, () => armed),
      hooks: { afterOp: async (_p, i) => { if (i === 2) { armed = true; throw new Error('boom'); } } },
    });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toContain(`${old} was not restored`);
    expect(await readFile(old, 'utf8')).toBe('rewritten\n');
  });

  /** A copy of t.fs whose `method` on `p` performs the call and then reports `code` (once). */
  const lying = (t: Tree, method: 'unlink' | 'rename', match: (a: string, b?: string) => boolean) => {
    let done = false;
    const base = t.fs;
    const orig = base[method] as (...a: string[]) => Promise<void>;
    return { ...base, [method]: async (...a: string[]) => {
      await orig.apply(base, a);
      if (!done && match(a[0]!, a[1])) { done = true; throw Object.assign(new Error('EIO: reported after the fact'), { code: 'EIO' }); }
    } } as typeof base;
  };
  const expectFullyBack = async (c: Ctx, r: Awaited<ReturnType<typeof run>>, beforeHub: Map<string, TreeEntry>, beforeViews: Map<string, TreeEntry>) => {
    expect(r.error!.code, r.error!.message).toBe('ROLLED_BACK');
    expect(r.appliedOps).toBe(0); // finding 4
    expectHubRestored(beforeHub, await snapshotTree(c.t.hub));
    expect(diffTrees(beforeViews, await snapshotTree(c.t.lmstudioRoot), { ignoreIno: 'dirs+links' })).toEqual(EMPTY);
    await expectHoldEmpty(c.t, c.holdDir);
  };

  it('finding 3: a view unlink that took effect but reported an error is re-created', async () => {
    const c = await mixed();
    const link = opsOf(c.plan, 'unlink')[0]!;
    const [bh, bv] = [await snapshotTree(c.t.hub), await snapshotTree(c.t.lmstudioRoot)];
    const r = await run(c.t, c.plan, { safeFs: await SafeFs.create(c.t.roots, lying(c.t, 'unlink', (a) => a === link.path)) });
    expect(r.error!.path).toBe(link.path);
    await expectFullyBack(c, r, bh, bv);
  });

  it('finding 3: an rmdir-empty that took effect but reported an error is recreated', async () => {
    const c = await mixed();
    const [bh, bv] = [await snapshotTree(c.t.hub), await snapshotTree(c.t.lmstudioRoot)];
    const real = await SafeFs.create(c.t.roots, c.t.fs);
    const liar = new Proxy(real, { get: (target, k, recv) => (k !== 'rmdirEmpty' ? Reflect.get(target, k, recv) as unknown
      : async (p: string, hook?: AttemptHook) => { await target.rmdirEmpty(p, hook); throw new SafeFsError('IO', p, 'EIO: after the fact', 'EIO'); }) });
    const r = await run(c.t, c.plan, { safeFs: liar });
    expect(r.error!.path).toBe(opsOf(c.plan, 'rmdir-empty')[0]!.path);
    await expectFullyBack(c, r, bh, bv);
  });

  it("finding 3: the sweep's .refs unlink that took effect but reported an error is restored (exact bytes)", async () => {
    const c = await mixed();
    const sweep = opsOf(c.plan, 'store-sweep')[0]!;
    const bytes = await readFile(sweep.refsPath, 'utf8');
    const [bh, bv] = [await snapshotTree(c.t.hub), await snapshotTree(c.t.lmstudioRoot)];
    const r = await run(c.t, c.plan, { safeFs: await SafeFs.create(c.t.roots, lying(c.t, 'unlink', (a) => a === sweep.refsPath)) });
    expect(await readFile(sweep.refsPath, 'utf8')).toBe(bytes);
    await expectFullyBack(c, r, bh, bv);
  });

  it('finding 3: a write-file that took effect but reported an error is reversed', async () => {
    const c = await mixed();
    const fresh = join(c.t.lmstudioRoot, 'state-new.json');
    const forged = forge(c.plan, { ops: [{ kind: 'write-file', path: fresh, before: null, after: 'new\n', role: 'view-state' }, ...c.plan.ops] });
    const [bh, bv] = [await snapshotTree(c.t.hub), await snapshotTree(c.t.lmstudioRoot)];
    const r = await run(c.t, forged, { safeFs: await SafeFs.create(c.t.roots, lying(c.t, 'rename', (_a, b) => b === fresh)) });
    expect(existsSync(fresh)).toBe(false);
    await expectFullyBack(c, r, bh, bv);
  });

  it('finding 3: a failing write-file that did not take effect is left alone (no rollback record for it)', async () => {
    const c = await mixed();
    const fresh = join(c.t.lmstudioRoot, 'state-new.json');
    const forged = forge(c.plan, { ops: [{ kind: 'write-file', path: fresh, before: null, after: 'new\n', role: 'view-state' }, ...c.plan.ops] });
    const { r } = await runScripted(c.t, forged, [{ method: 'writeFile', nth: 1, code: 'ENOSPC' }]);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'ROLLED_BACK' } });
    expect(existsSync(fresh)).toBe(false);
    expect((await journalLines(c.t)).filter((l) => l.t === 'rollback')).toEqual([]);
  });
});

describe('only an attempted syscall can have taken effect', () => {
  it('a view entry removed by someone else after review → the unlink is refused (STALE), not re-created, IO naming it', async () => {
    const c = await mixed();
    const link = opsOf(c.plan, 'unlink')[0]!;
    const beforeHub = await snapshotTree(c.t.hub);
    const sfs = scriptedFs(c.t.fs, []);
    // removed between rederive (rescan) and the op: SafeFs.unlink's revalidation refuses it
    const r = await run(c.t, c.plan, {
      safeFs: await SafeFs.create(c.t.roots, sfs),
      rescan: async () => { const m = await c.t.scan(); await unlink(link.path); return m; },
    });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toMatch(/^Rollback incomplete: unlink failed: STALE/);
    expect(r.error!.message).toContain(`${link.path} was changed by something else after the review, so it was left as it is`);
    expect(existsSync(link.path)).toBe(false); // never re-created
    expect(sfs.calls.filter((call) => call.method === 'symlink' || call.method === 'unlink')).toEqual([]);
    expectHubRestored(beforeHub, await snapshotTree(c.t.hub));
    await expectHoldEmpty(c.t, c.holdDir);
  });

  it('rmdir-empty refused because its parent is no longer a real directory → nothing created, IO naming it', async () => {
    const deep = 'q4/a/m-Q4_K_M-00001-of-00002.gguf';
    const { t, plan } = await setup(
      [{ id: 'o/a', snapshots: { c1: { [deep]: f('blob', 'D1', 4000), 'q4/a/m-Q4_K_M-00002-of-00002.gguf': f('blob', 'D2', 4000), 'config.json': f('small', 'c', 30) } } }],
      (m) => [part(m, 'o/a', deep)],
    );
    const rmdirs = opsOf(plan, 'rmdir-empty');
    const [inner, outer] = [rmdirs[0]!.path, rmdirs[1]!.path];
    const k = plan.ops.indexOf(rmdirs[0]!);
    const sfs = scriptedFs(t.fs, []);
    // after the last rename: q4 is swapped for a symlink to a moved copy (someone else's change)
    const r = await run(t, plan, {
      safeFs: await SafeFs.create(t.roots, sfs),
      hooks: { afterOp: async (_p, i) => { if (i === k - 1) { await rename(outer, `${outer}-moved`); await symlink(`${basename(outer)}-moved`, outer); } } },
    });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toMatch(/^Rollback incomplete: rmdir-empty failed: STALE/);
    expect(r.error!.message).toContain(`${inner} was changed by something else after the review, so it was left as it is`);
    expect(sfs.calls.filter((call) => call.method === 'mkdir' && String(call.args[0]).startsWith(t.hub))).toEqual([]);
    expect((await lstat(outer)).isSymbolicLink()).toBe(true); // left as it is
  });

  it('a hold-rename refused by revalidation (hub entry replaced by someone) is left alone; the rest is reversed (ROLLED_BACK)', async () => {
    const c = await mixed();
    const target = opsOf(c.plan, 'hold-rename')[1]!;
    const k = c.plan.ops.indexOf(target);
    const r = await run(c.t, c.plan, { hooks: { afterOp: async (_p, i) => {
      if (i === k - 1) { await unlink(target.path); await writeFile(target.path, 'changed by someone'); } // link replaced by a file
    } } });
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(r.error!.message).toContain('hold-rename failed: STALE');
    expect(await readFile(target.path, 'utf8')).toBe('changed by someone');
    expect(existsSync(target.dest)).toBe(false);
    await expectHoldEmpty(c.t, c.holdDir);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Coverage: every reversal outcome of undoOne, renameBack, capturedText and removeCreatedDirs
// ---------------------------------------------------------------------------------------------------------------

const errOf = (code: string, message: string): Error => Object.assign(new Error(message), { code });
/** A read view over `base` whose `method` calls on exactly `path` are answered by `fn` (others pass through). */
function readOverride(base: Tree['fs'], method: 'lstat' | 'readFile', path: string, fn: (orig: (...a: unknown[]) => Promise<unknown>, ...a: unknown[]) => Promise<unknown>): Tree['fs'] {
  const orig = (base[method] as (...a: unknown[]) => Promise<unknown>).bind(base);
  return Object.assign(Object.create(base) as Tree['fs'], { [method]: (...a: unknown[]) => (a[0] === path ? fn(orig, ...a) : orig(...a)) });
}
/** An FsLike over `base` whose `method` runs `fn` instead for paths where `when` holds. */
function mutOverride(base: Tree['fs'], method: 'unlink' | 'rename' | 'mkdir', when: (p: string) => boolean,
  fn: (orig: (...a: unknown[]) => Promise<unknown>, ...a: unknown[]) => Promise<unknown>): Tree['fs'] {
  const orig = (base[method] as (...a: unknown[]) => Promise<unknown>).bind(base);
  return { ...base, [method]: (...a: unknown[]) => (when(String(a[0])) ? fn(orig, ...a) : orig(...a)) } as Tree['fs'];
}
const throwAfter = (k: number, before?: () => Promise<void>): Partial<ExecDeps> =>
  ({ hooks: { afterOp: async (_p, i) => { if (i === k) { await before?.(); throw new Error(`injected failure after op ${k}`); } } } });
const plain = (): Promise<Ctx> => setup(mixedRepos(), (m) => [part(m, 'o/a', S1)]);

describe('rollback: renameBack outcomes', () => {
  it('a held item already put back by someone counts as reversed (ROLLED_BACK)', async () => {
    const { t, plan, holdDir } = await plain();
    const op = opsOf(plan, 'hold-rename')[0]!;
    const r = await run(t, plan, throwAfter(plan.ops.indexOf(op), () => rename(op.dest, op.path)));
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect((await lstat(op.path)).ino).toBe(op.expect.ino);
    await expectHoldEmpty(t, holdDir);
  });

  it('a held item gone (with or without something else at home) or replaced → IO naming it; nothing else is touched', async () => {
    for (const variant of ['gone', 'gone-other-home', 'replaced'] as const) {
      const { t, plan } = await plain();
      const op = opsOf(plan, 'hold-rename')[0]!;
      const r = await run(t, plan, throwAfter(plan.ops.indexOf(op), async () => {
        await unlink(op.dest);
        if (variant === 'gone-other-home') await symlink('elsewhere', op.path);
        if (variant === 'replaced') await symlink('elsewhere', op.dest);
      }));
      const why = variant === 'replaced' ? `${op.dest} is not the item that was moved there` : `${op.dest} is missing`;
      expect(r.error!.code, variant).toBe('IO');
      expect(r.error!.message, variant).toContain(`${op.dest} is still in Recently Deleted (it belongs at ${op.path}): ${why}`);
      if (variant === 'gone-other-home') expect(await readlink(op.path)).toBe('elsewhere');
      if (variant === 'replaced') {
        expect(await readlink(op.dest)).toBe('elsewhere');
        // the folders that still hold something are kept and named
        expect(r.notes!.find((n) => n.startsWith('kept in Recently Deleted (not empty): '))).toContain(`: ${dirname(op.dest)}, ${dirname(dirname(op.dest))}`);
      } else {
        expect((r.notes ?? []).some((n) => n.startsWith('kept in Recently Deleted'))).toBe(false);
      }
      const rb = (await journalLines(t)).filter((l) => l.t === 'rollback' && l.i === plan.ops.indexOf(op));
      expect(rb).toEqual([expect.objectContaining({ ok: false, error: expect.stringContaining(why) })]);
    }
  });

  it('several reversals failing are all named, separated by "; "', async () => {
    const { t, plan } = await plain();
    const [a, b] = opsOf(plan, 'hold-rename');
    const r = await run(t, plan, throwAfter(plan.ops.indexOf(b!), async () => { await unlink(a!.dest); await unlink(b!.dest); }));
    expect(r.error!.message).toContain(`${b!.dest} is missing; ${a!.dest} is still in Recently Deleted`);
  });
});

describe('rollback: a failing rename whose outcome cannot be checked', () => {
  it('the destination cannot be lstat\'d → renameBack is asked and reports it; the item is left where it is', async () => {
    const { t, plan } = await plain();
    const op = opsOf(plan, 'hold-rename')[1]!;
    let armed = false;
    const sfs = mutOverride(t.fs, 'rename', (p) => p === op.path, async () => { armed = true; throw errOf('EXDEV', 'cross-device'); });
    const fs = readOverride(t.fs, 'lstat', op.dest, async (orig, ...a) => { if (armed) throw errOf('EIO', 'unreadable'); return orig(...a); });
    const r = await run(t, plan, { safeFs: await SafeFs.create(t.roots, sfs), fs });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toMatch(/^Rollback incomplete: hold-rename failed: EXDEV/);
    expect(r.error!.message).toContain(`${op.dest} is still in Recently Deleted (it belongs at ${op.path}): Could not check ${op.dest}: EIO`);
    expect((await lstat(op.path)).ino).toBe(op.expect.ino); // never moved
  });
});

describe('rollback: written files and view entries', () => {
  /** A hold delete plan whose leading view op writes one view-state file, failing after it. */
  async function writeCase() {
    const { t, plan } = await plain();
    const p = join(t.lmstudioRoot, 'state.json');
    const w = forge(plan, { ops: [{ kind: 'write-file', path: p, before: null, after: '{}', role: 'view-state' }, ...plan.ops] });
    return { t, w, p };
  }

  it('the written file seen absent then present while it is checked → left alone, IO naming it', async () => {
    const { t, w, p } = await writeCase();
    let armed = false;
    let n = 0;
    const flaky = readOverride(t.fs, 'lstat', p, async (orig, ...a) => {
      if (armed && n++ === 0) throw errOf('ENOENT', 'not yet');
      return orig(...a);
    });
    const r = await run(t, w, { fs: flaky, ...throwAfter(0, async () => { armed = true; }) });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toContain(`${p} was not restored: ${p} changed while it was being checked`);
    expect(await readFile(p, 'utf8')).toBe('{}');
  });

  it('the written file replaced by a symlink → left alone, IO naming it', async () => {
    const { t, w, p } = await writeCase();
    const r = await run(t, w, throwAfter(0, async () => { await unlink(p); await symlink('x', p); }));
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toContain(`${p} was not restored: ${p} is no longer a regular file`);
    expect(await readlink(p)).toBe('x');
  });

  it('a removed view entry that is neither a symlink nor a regular file (a socket) cannot be re-created → IO naming it', async () => {
    const { t, plan } = await plain();
    const sock = join(t.lmstudioRoot, 's.sock');
    const server = createServer();
    // sun_path is limited to ~107 bytes and Stryker's temp dir lengthens the absolute path: listen through a short symlink
    const short = join(t.root, 'k');
    await symlink(t.lmstudioRoot, short);
    try { await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(join(short, 's.sock'), res); }); }
    finally { await unlink(short); }
    try {
      const facts = (await factsOf(t.fs, sock))!;
      expect(facts.isFile || facts.isSymlink || facts.isDirectory).toBe(false);
      const w = forge(plan, { ops: [{ kind: 'unlink', path: sock, expect: facts, role: 'view-blob' }, ...plan.ops] });
      const r = await run(t, w, throwAfter(0));
      expect(r.error!.code).toBe('IO');
      expect(r.error!.message).toContain(`the view entry ${sock} was not restored: no copy of ${sock} was kept`);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('a failing view unlink whose path cannot be checked afterwards is not re-created (never over something unknown)', async () => {
    const c = await mixed();
    const link = opsOf(c.plan, 'unlink')[0]!;
    let armed = false;
    const sfs = mutOverride(c.t.fs, 'unlink', (p) => p === link.path, async () => { armed = true; throw errOf('EACCES', 'denied'); });
    const fs = readOverride(c.t.fs, 'lstat', link.path, async (orig, ...a) => { if (armed) throw errOf('EIO', 'unreadable'); return orig(...a); });
    const r = await run(c.t, c.plan, { safeFs: await SafeFs.create(c.t.roots, sfs), fs });
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(r.error!.message).toContain('unlink failed: EACCES');
    expect((await lstat(link.path)).isSymbolicLink()).toBe(true); // it was never removed
  });

  it('a hold-mode empty plan is refused before anything runs (an emptied item could never be put back)', async () => {
    const { t, plan, holdDir } = await plain();
    const held = join(holdDir, 'x');
    await mkdir(holdDir);
    await writeFile(held, 'held');
    const w = forge(plan, { purpose: 'empty', selection: null, ops: [{ kind: 'unlink', path: held, expect: (await factsOf(t.fs, held))!, role: 'held-item' }] });
    const r = await run(t, w, throwAfter(0));
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'CONTAINMENT', message: 'Refused: an empty plan is always permanent' } });
    expect(await readFile(held, 'utf8')).toBe('held');
  });
});

describe('rollback: hub folders, store ops and created dirs', () => {
  it('a removed hub folder that cannot be recreated → IO naming it', async () => {
    const { t, plan } = await plain();
    const k = indexOf(plan, 'rmdir-empty');
    const dir = (plan.ops[k] as Kind<'rmdir-empty'>).path;
    let armed = false;
    const sfs = mutOverride(t.fs, 'mkdir', (p) => armed && p === dir, async () => { throw errOf('EACCES', 'denied'); });
    const r = await run(t, plan, { safeFs: await SafeFs.create(t.roots, sfs), ...throwAfter(k, async () => { armed = true; }) });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toContain(`the folder ${dir} could not be recreated: `);
  });

  it('a rewritten .refs changed by someone after the sweep is not restored → IO naming it', async () => {
    const { t, plan } = await setup(mixedRepos(true), (m) => [part(m, 'o/a', S1)]);
    const sweep = opsOf(plan, 'store-sweep')[0]!;
    expect(sweep.payload).toBe('keep');
    const r = await run(t, plan, throwAfter(plan.ops.indexOf(sweep), () => appendFile(sweep.refsPath, 'models--o--z/blobs/q\n')));
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toContain(`${sweep.refsPath} was not restored to its earlier content: ${sweep.refsPath} has changed since this operation wrote it`);
  });

  it('a .refs unlink that failed, whose state cannot be read back → IO naming it', async () => {
    const { t, plan } = await plain();
    const sweep = opsOf(plan, 'store-sweep')[0]!;
    let armed = false;
    const sfs = mutOverride(t.fs, 'unlink', (p) => p === sweep.refsPath, async () => { armed = true; throw errOf('EACCES', 'denied'); });
    const fs = readOverride(t.fs, 'readFile', sweep.refsPath, async (orig, ...a) => { if (armed) throw errOf('EIO', 'unreadable'); return orig(...a); });
    const r = await run(t, plan, { safeFs: await SafeFs.create(t.roots, sfs), fs });
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toContain(`${sweep.refsPath} was not restored to its earlier content: unreadable`);
    expect(existsSync(sweep.storePath)).toBe(true); // the held payload was still moved back
  });

  it('a held payload whose rename took effect but reported an error is moved back', async () => {
    const { t, plan, holdDir } = await plain();
    const sweep = opsOf(plan, 'store-sweep')[0]!;
    const dest = join(t.holdRoot, ...sweep.holdDest!.split('/'));
    const liar = mutOverride(t.fs, 'rename', (p) => p === sweep.storePath, async (orig, ...a) => { await orig(...a); throw errOf('EIO', 'reported after the fact'); });
    const before = await snapshotTree(t.hub);
    const r = await run(t, plan, { safeFs: await SafeFs.create(t.roots, liar) });
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(existsSync(dest)).toBe(false);
    expect((await lstat(sweep.storePath)).ino).toBe(sweep.expect.ino);
    expectHubRestored(before, await snapshotTree(t.hub));
    await expectHoldEmpty(t, holdDir);
  });

  it('store-refs-add in a hold plan: reversed to the exact bytes; refused before writing → nothing to reverse; changed since → IO', async () => {
    const make = async () => {
      const { t, plan, holdDir } = await plain();
      await mkdir(holdDir);
      const refs = opsOf(plan, 'store-sweep')[0]!.refsPath;
      const text = await readFile(refs, 'utf8');
      const raw = text.split('\n').filter((l) => l !== '');
      const add = forge(plan, { purpose: 'restore', selection: null,
        ops: [{ kind: 'store-refs-add', refsPath: refs, addRefs: ['models--o--z/blobs/k'], expectRefsRaw: raw }] });
      return { t, refs, text, add };
    };
    {
      const { t, refs, text, add } = await make();
      const r = await run(t, add, throwAfter(0));
      expect(r.error!.code).toBe('ROLLED_BACK');
      expect(await readFile(refs, 'utf8')).toBe(text);
    }
    {
      const { t, refs, text, add } = await make();
      await writeFile(refs.slice(0, -'.refs'.length) + '.lock', '');
      const r = await run(t, add);
      expect(r.error).toMatchObject({ code: 'ROLLED_BACK' });
      expect(r.error!.message).toContain('store-refs-add failed: the store payload is locked by another process');
      expect(await readFile(refs, 'utf8')).toBe(text);
    }
    {
      const { t, refs, add } = await make();
      const r = await run(t, add, throwAfter(0, () => appendFile(refs, 'models--o--y/blobs/q\n')));
      expect(r.error!.code).toBe('IO');
      expect(r.error!.message).toContain(`${refs} was not restored to its earlier content: ${refs} has changed since this operation wrote it`);
    }
  });

  it('created dirs: one already gone is skipped; an rmdir error is a note (EACCES) or silently kept (EEXIST)', async () => {
    {
      const { t, plan, holdDir } = await plain();
      const op = opsOf(plan, 'hold-rename')[0]!;
      const r = await run(t, plan, throwAfter(plan.ops.indexOf(op), async () => {
        await rename(op.dest, op.path);
        await rename(dirname(op.dest), join(t.root, 'moved-away'));
      }));
      expect(r.error!.code).toBe('ROLLED_BACK');
      expect((r.notes ?? []).some((n) => n.startsWith('could not remove'))).toBe(false);
      await expectHoldEmpty(t, holdDir);
    }
    for (const code of ['EACCES', 'EEXIST', 'ENOTEMPTY']) {
      const { t, plan, holdDir } = await plain();
      let armed = false;
      const real = await SafeFs.create(t.roots, t.fs);
      // the removal itself failing: SafeFs maps the fs error to IO (EEXIST: EXISTS) carrying the errno
      const failing = new Proxy(real, { get: (target, k, recv) => (k !== 'rmdirEmpty' ? Reflect.get(target, k, recv) as unknown
        : async (p: string, hook?: AttemptHook) => {
          if (armed && p === holdDir) throw new SafeFsError(code === 'EEXIST' ? 'EXISTS' : 'IO', p, 'injected', code);
          return target.rmdirEmpty(p, hook);
        }) });
      const r = await run(t, plan, { safeFs: failing, ...throwAfter(0, async () => { armed = true; }) });
      expect(r.error!.code, code).toBe('ROLLED_BACK');
      const note = `could not remove the empty folder ${holdDir}: ${code}`;
      if (code === 'EACCES') expect(r.notes).toContain(note);
      else expect(r.notes ?? []).not.toContain(note);
      expect(existsSync(holdDir)).toBe(true);
    }
  });
});

describe('rollback never removes a directory outside the hold root (mutation gate)', () => {
  it('a hub folder made for a restore-rename stays after the rollback', async () => {
    const { t, plan, holdDir } = await plain();
    const src = join(holdDir, 'f');
    await mkdir(dirname(src), { recursive: true });
    await writeFile(src, 'held');
    const newDir = join(t.folder('o/a'), 'snapshots', 'c-new');
    const ops: Op[] = [{ kind: 'restore-rename', path: src, dest: join(newDir, 'f'), expect: (await factsOf(t.fs, src))!, role: 'snapshot-link' }];
    const r = await run(t, forge(plan, { purpose: 'restore', selection: null, ops }), throwAfter(0));
    expect(r.error!.code).toBe('ROLLED_BACK');
    expect(await readFile(src, 'utf8')).toBe('held');
    expect((await lstat(newDir)).isDirectory()).toBe(true);
  });
});

describe('rollback helpers (assertion helpers kept for defence in depth)', () => {
  const F: FileFacts = { dev: 1, ino: 2, size: 3, mtimeMs: 4, nlink: 1, isSymlink: false, isDirectory: false, isFile: true };
  const op: Op = { kind: 'hold-rename', path: '/h/a', dest: '/d/a', expect: F, role: 'repo-blob' };

  it('sameItem: identity, type, link text, and for non-directories size and mtime; a directory may change size/mtime', () => {
    expect(sameItem(F, { ...F, nlink: 2 })).toBe(true);
    for (const change of [{ dev: 9 }, { ino: 9 }, { size: 9 }, { mtimeMs: 9 }, { linkTarget: 'x' }, { isFile: false },
      { isSymlink: true }, { isDirectory: true }] as Array<Partial<FileFacts>>) {
      expect(sameItem(F, { ...F, ...change }), JSON.stringify(change)).toBe(false);
    }
    const D: FileFacts = { ...F, isFile: false, isDirectory: true };
    expect(sameItem(D, { ...D, size: 99, mtimeMs: 99 })).toBe(true);
    expect(sameItem(D, { ...D, ino: 99 })).toBe(false);
    const L: FileFacts = { ...F, isFile: false, isSymlink: true, linkTarget: 'a' };
    expect(sameItem(L, { ...L, linkTarget: 'b' })).toBe(false);
  });

  it('toFailure: a plain Error names no op and no path', () => {
    expect(toFailure(new Error('boom'))).toEqual({ message: 'boom', path: '', index: null, stale: false });
    expect(toFailure('text')).toEqual({ message: 'text', path: '', index: null, stale: false });
  });

  it('rollbackIndices: applied and registered ops, plus the failing one when known, highest first, once each', () => {
    expect(rollbackIndices([0, 2], [2, 3], null)).toEqual([3, 2, 0]);
    expect(rollbackIndices([0], [], 4)).toEqual([4, 0]);
    expect(rollbackIndices([], [], null)).toEqual([]);
  });

  it('reverseGuarded: a throwing reversal becomes a problem for its op and the next reversal still runs', async () => {
    const ran: number[] = [];
    const outs = [];
    for (const i of [1, 0]) {
      outs.push(await reverseGuarded(i, op, async () => {
        ran.push(i);
        if (i === 1) throw new Error('disk on fire');
        return { acted: true, problems: [] };
      }));
    }
    expect(ran).toEqual([1, 0]);
    expect(outs).toEqual([{ acted: true, problems: ['op 1 (hold-rename /h/a) could not be reversed: disk on fire'] }, { acted: true, problems: [] }]);
  });

  it('rollbackError / failurePath: the path only when known', () => {
    const known = { message: 'm', path: '/p', index: 0, stale: false };
    const unknown = { ...known, path: '', index: null };
    expect(failurePath(known)).toBe('/p');
    expect(failurePath(unknown)).toBeUndefined();
    expect(rollbackError(known, [])).toMatchObject({ code: 'ROLLED_BACK', path: '/p', message: 'Move to Recently Deleted failed: m (/p). Everything already changed was put back.' });
    expect(rollbackError(unknown, [])).toMatchObject({ code: 'ROLLED_BACK', message: 'Move to Recently Deleted failed: m. Everything already changed was put back.' });
    expect(rollbackError(unknown, []).path).toBeUndefined();
    expect(rollbackError(known, ['a', 'b'])).toMatchObject({ code: 'IO', path: '/p', message: 'Rollback incomplete: m (/p). Not put back: a; b.' });
    expect(rollbackError(unknown, ['a'])).toMatchObject({ code: 'IO', message: 'Rollback incomplete: m. Not put back: a.' });
  });

  it('holdDirOf / unexpectedFailureMessage', () => {
    expect(holdDirOf({ mode: 'hold', holdRoot: '/r', deletionId: 'D' })).toBe(join('/r', 'D'));
    expect(holdDirOf({ mode: 'permanent', holdRoot: '/r', deletionId: 'D' })).toBeNull();
    expect(holdDirOf({ mode: 'hold', holdRoot: null, deletionId: 'D' })).toBeNull();
    expect(holdDirOf({ mode: 'hold', holdRoot: '/r', deletionId: null })).toBeNull();
    expect(unexpectedFailureMessage(new Error('x'), 0, '/r/D')).toBe('Unexpected failure: x.');
    expect(unexpectedFailureMessage(new Error('x'), 2, null)).toBe('Unexpected failure: x. 2 operation(s) had been applied. See the journal.');
    expect(unexpectedFailureMessage(new Error('x'), 1, '/r/D')).toBe('Unexpected failure: x. 1 operation(s) had been applied; items may remain in /r/D. See the journal.');
  });

  it('a held file replaced by a same-name file with another inode is not moved into the hub → IO naming it', async () => {
    const { t, plan } = await plain();
    const op0 = opsOf(plan, 'hold-rename').find((o) => o.role === 'repo-blob')!;
    const r = await run(t, plan, throwAfter(plan.ops.indexOf(op0), async () => {
      const bytes = await readFile(op0.dest);
      await unlink(op0.dest);
      await writeFile(op0.dest, bytes); // same name, same bytes, new inode
    }));
    expect(r.error!.code).toBe('IO');
    expect(r.error!.message).toContain(`${op0.dest} is still in Recently Deleted (it belongs at ${op0.path}): ${op0.dest} is not the item that was moved there`);
    expect(existsSync(op0.path)).toBe(false);
    expect(existsSync(op0.dest)).toBe(true);
  });
});
