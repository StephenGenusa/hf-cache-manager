// planEmpty. Every empty plan here is planned from a real hold
// of the shared hold scenario and executed by the real executor; outcomes are asserted on disk (treeDigest, existsSync).
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import { executePlan } from '../../../src/core/exec/executor';
import { factsOf, type ReadFs } from '../../../src/core/fsx';
import { EMPTY_SKIPPED, HeldError, listHeld, planEmpty, type HeldDeletion } from '../../../src/core/hold/held';
import { createHoldHooks, executeHold, finalizeHold, MANIFEST_NAME, type HoldManifest } from '../../../src/core/hold/manifest';
import { isStrictlyInside } from '../../../src/core/paths';
import { fingerprintPlan } from '../../../src/core/plan/fingerprint';
import type { DeletionPlan, ExecHooks, Op, Selection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { failingFs } from '../../helpers/failing-fs';
import { treeDigest } from '../../helpers/tree-digest';
import { buildHoldScenario, HEX, q8Iq2MmprojSelection, type HoldScenario } from './scenario';

const canaries = useCanaries();

type OkDeletion = Extract<HeldDeletion, { ok: true }>;
type Unlink = Extract<Op, { kind: 'unlink' }>;

/** Holds `sel` (default: + IQ2 + mmproj of org/gguf) with executeHold at manifest time `at`; returns its deletion id. */
async function holdAt(s: HoldScenario, at: number, sel?: Selection): Promise<string> {
  const m = await s.model();
  const plan = await s.holdPlan(sel ?? q8Iq2MmprojSelection(s, m));
  const hooks = createHoldHooks({ safeFs: s.safeFs, fs: s.fs, model: m, viewRoots: s.viewRoots, now: () => at });
  const r = await s.exec(plan, hooks);
  expect(r.ok).toBe(true);
  return plan.deletionId!;
}
async function okList(s: HoldScenario): Promise<OkDeletion[]> {
  const all = await listHeld(s.roots);
  return all.map((d) => { if (!d.ok) throw new Error(d.error); return d; });
}
const groupSel = async (s: HoldScenario, repoId: string, label: string): Promise<Selection> =>
  ({ repos: [{ repoId, whole: false, unlockComponents: false, groupKeys: [s.keyFor(await s.model(), repoId, 'quant', label)] }] });
const unlinks = (p: DeletionPlan): Unlink[] => p.ops.filter((o): o is Unlink => o.kind === 'unlink');
const opPath = (o: Op): string => ('path' in o ? o.path : o.refsPath);
const pathsOf = (p: DeletionPlan): string[] => p.ops.map(opPath);
const depth = (p: string): number => p.split(sep).length;
/** Every non-directory and directory entry under `dir` (lstat walk, links never followed). */
function walkSync(dir: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [dir];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (lstatSync(p).isDirectory()) { const sub = walkSync(p); files.push(...sub.files); dirs.push(...sub.dirs); }
    else files.push(p);
  }
  return { files, dirs };
}
const writeM = (dir: string, m: unknown): Promise<void> => writeFile(join(dir, MANIFEST_NAME), JSON.stringify(m, null, 2) + '\n');
const readM = (dir: string): HoldManifest => JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8')) as HoldManifest;

describe('planEmpty: one deletion', () => {
  test('emptying a partial-group hold frees the held store payload but not the shared hardlink; the hub is untouched', async () => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const [d] = await okList(s);
    const at9 = await planEmpty([d!], s.roots, 9_000);
    expect(at9.plans[0]).toMatchObject({ createdAt: 9_000, expiresAt: 609_000 });
    const { plans, skipped } = await planEmpty([d!], s.roots, s.now);
    expect(skipped).toEqual([]);
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    const dir = d!.dir;
    const man = join(dir, 'manifest.json');
    expect(plan).toMatchObject({ mode: 'permanent', purpose: 'empty', deletionId: d!.deletionId, confirmPhrase: null,
      selection: null, createdAt: s.now, expiresAt: s.now + 600_000, hubRoot: s.roots.hubRoot, holdRoot: s.roots.holdRoot,
      kept: [], viewImpact: [], warnings: [] });
    expect(plan.contentDigest).toBeUndefined();
    expect(plan.fingerprint).toBe(fingerprintPlan(plan));
    expect(plan.freed.bytes).toBe(2000 + lstatSync(man).size);
    expect(plan.freed.lines).toContainEqual({ path: join(dir, 'store', 'aa', HEX.S1), bytes: 2000, reason: 'store-unreferenced' });
    expect(plan.freed.lines).toContainEqual({ path: join(dir, 'models--org--gguf', 'blobs', HEX.C), bytes: 0, reason: 'hardlink-others-remain' });
    expect(plan.freed.lines).toContainEqual({ path: man, bytes: lstatSync(man).size, reason: 'plain-file' });
    expect(plan.freed.lines).toContainEqual({ path: join(dir, 'models--org--gguf', 'blobs', HEX.B), bytes: 0, reason: 'link-only' });
    // one freed line and one unlink per non-directory entry; one rmdir-empty per directory
    const tree = walkSync(dir);
    expect(plan.freed.lines.map((l) => l.path).sort()).toEqual([...tree.files].sort());
    expect(unlinks(plan).map((o) => o.path).sort()).toEqual([...tree.files].sort());
    expect(plan.ops.filter((o) => o.kind === 'rmdir-empty').map((o) => (o as { path: string }).path).sort()).toEqual([...tree.dirs].sort());
    expect(plan.apparentBytes).toBe(2000 + 500 + lstatSync(man).size);
    // order: unlinks deepest first with the manifest last, then rmdir-empty deepest first with the deletion dir last
    const us = unlinks(plan);
    expect(us.at(-1)!.path).toBe(man);
    const ds = us.slice(0, -1).map((o) => depth(o.path));
    expect(ds).toEqual([...ds].sort((a, b) => b - a));
    // other unlinks, then rmdir-empty of every sub-directory deepest first, then the manifest unlink, then rmdir D:
    // a failure while removing directories leaves the manifest in place
    expect(plan.ops.at(-1)).toEqual({ kind: 'rmdir-empty', path: dir });
    expect(plan.ops.at(-2)).toEqual(us.at(-1));
    const firstRmdir = plan.ops.findIndex((o) => o.kind === 'rmdir-empty');
    expect(firstRmdir).toBe(us.length - 1);
    const rd = plan.ops.slice(firstRmdir, -2).map((o) => depth((o as { path: string }).path));
    expect(rd.length).toBeGreaterThan(0);
    expect(plan.ops.slice(firstRmdir, -2).every((o) => o.kind === 'rmdir-empty')).toBe(true);
    expect(rd).toEqual([...rd].sort((a, b) => b - a));
    for (const o of plan.ops) expect(isStrictlyInside(opPath(o), dir) || (o.kind === 'rmdir-empty' && o.path === dir)).toBe(true);
    for (const o of us) {
      expect(o).toMatchObject({ role: 'held-item' });
      expect(o.expect).toEqual(await factsOf(s.fs, o.path));                       // facts for every unlink (no digest)
    }
    // the kept payload (heldPath null, still in the hub) gets no op
    const kept = d!.manifest.storeItems.find((x) => x.heldPath === null)!;
    expect(pathsOf(plan).some((p) => p.startsWith(s.hub + sep))).toBe(false);
    expect(existsSync(kept.originalPath)).toBe(true);
    const hubBefore = await treeDigest(s.hub);
    const r = await s.exec(plan);
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, appliedOps: plan.ops.length, heldBytes: 0, freedBytesPlanned: plan.freed.bytes });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(s.roots.holdRoot!)).toBe(true);
    expect(await treeDigest(s.hub)).toEqual(hubBefore);
  });

  test('a whole-repo hold of both repos holds both links of <C>: the first line frees it once (hardlink-all-planned)', async () => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000, { repos: [{ repoId: 'org/gguf', whole: true }, { repoId: 'org/other', whole: true }] });
    const { plans } = await planEmpty('all', s.roots, s.now);
    const cLines = plans[0]!.freed.lines.filter((l) => l.path.endsWith(HEX.C));
    expect(cLines.map((l) => [l.bytes, l.reason])).toEqual([[500, 'hardlink-all-planned'], [0, 'hardlink-all-planned']]);
    expect(cLines[0]!.path < cLines[1]!.path).toBe(true);
    expect(plans[0]!.freed.lines.find((l) => l.path.endsWith(HEX.A))).toMatchObject({ bytes: 1000, reason: 'only-link' });
    expect(plans[0]!.freed.lines.find((l) => l.path.endsWith(HEX.S2))).toMatchObject({ bytes: 300, reason: 'store-unreferenced' });
    const r = await s.exec(plans[0]!);
    expect(r.ok).toBe(true);
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
  });

  test('two deletions holding both links of <C>: each plan reports 0; the second goes STALE after the first runs; re-planned it is the only link', async () => {
    const s = await buildHoldScenario();
    const first = await holdAt(s, 1_000, await groupSel(s, 'org/gguf', 'IQ2_XS'));
    const second = await holdAt(s, 2_000, await groupSel(s, 'org/other', 'IQ2_XS'));
    const { plans, skipped } = await planEmpty('all', s.roots, s.now);
    expect(skipped).toEqual([]);
    expect(plans.map((p) => p.deletionId)).toEqual([first, second]);                // oldest first
    for (const p of plans) {
      expect(p.freed.lines.filter((l) => l.path.endsWith(HEX.C))).toEqual([
        { path: expect.stringContaining(p.deletionId!) as unknown as string, bytes: 0, reason: 'hardlink-others-remain' }]);
    }
    expect(await s.exec(plans[0]!)).toMatchObject({ ok: true });
    const holdBefore = await treeDigest(s.roots.holdRoot!);
    const r2 = await s.exec(plans[1]!);
    expect(r2).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE' } });
    expect(await treeDigest(s.roots.holdRoot!)).toEqual(holdBefore);
    const again = await planEmpty('all', s.roots, s.now);
    expect(again.plans).toHaveLength(1);
    expect(again.plans[0]!.freed.lines.find((l) => l.path.endsWith(HEX.C))).toMatchObject({ bytes: 500, reason: 'only-link' });
    expect(await s.exec(again.plans[0]!)).toMatchObject({ ok: true });
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
  });

  test('explicit deletions are planned oldest first whatever the order passed; a repeated deletion is planned once', async () => {
    const s = await buildHoldScenario();
    const a = await holdAt(s, 2_000, await groupSel(s, 'org/gguf', 'Q4_K_M'));
    const b = await holdAt(s, 1_000);
    const list = await okList(s);
    const { plans } = await planEmpty([...list, ...list], s.roots, s.now);
    expect(plans.map((p) => p.deletionId)).toEqual([b, a]);
    expect((await planEmpty([], s.roots, s.now))).toEqual({ plans: [], skipped: [] });
  });

  test('deletions held at the same time are ordered by id', async () => {
    const s = await buildHoldScenario();
    const ids = [await holdAt(s, 1_000, await groupSel(s, 'org/gguf', 'Q4_K_M')), await holdAt(s, 1_000)].sort();
    const list = await okList(s);
    expect((await planEmpty(list, s.roots, s.now)).plans.map((p) => p.deletionId)).toEqual(ids);
    expect((await planEmpty([...list].reverse(), s.roots, s.now)).plans.map((p) => p.deletionId)).toEqual(ids);
  });

  test('empty dry run returns exactly plan.ops and changes nothing', async () => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const { plans } = await planEmpty('all', s.roots, s.now);
    const before = await treeDigest(s.root);
    const r = await s.exec(plans[0]!, undefined, true);
    expect(r.ok).toBe(true);
    expect(r.dryRunOps).toEqual(plans[0]!.ops);
    expect(await treeDigest(s.root)).toEqual(before);
  });
});

describe('planEmpty: skipped deletions', () => {
  test("planEmpty('all') skips corrupt and interrupted deletions and never lists their paths", async () => {
    const s = await buildHoldScenario();
    const goodId = await holdAt(s, 1_000, await groupSel(s, 'org/gguf', 'Q4_K_M'));
    const badId = await holdAt(s, 2_000, await groupSel(s, 'org/gguf', 'IQ2_XS'));
    const movingId = await holdAt(s, 3_000, await groupSel(s, 'org/other', 'IQ2_XS'));
    const hr = s.roots.holdRoot!;
    const bad = readM(join(hr, badId));
    bad.items[0]!.originalPath = '/etc/passwd';
    await writeM(join(hr, badId), bad);
    const moving = readM(join(hr, movingId));
    moving.status = 'moving';
    await writeM(join(hr, movingId), moving);
    const goodDir = join(hr, goodId);
    const { plans, skipped } = await planEmpty('all', s.roots, s.now);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.warnings).toEqual([]);                                        // Skipped texts are not warnings
    expect(skipped).toHaveLength(2);
    expect(skipped).toContain(EMPTY_SKIPPED.interrupted(movingId));
    expect(skipped.find((x) => x.startsWith(`Skipped ${badId}`))).toMatch(new RegExp(`^Skipped ${badId}: its manifest is unreadable \\(.*originalPath.*\\)\\. It was left untouched\\.$`));
    expect(pathsOf(plans[0]!).every((p) => p.startsWith(goodDir + sep) || p === goodDir)).toBe(true);
    // passed explicitly, the same deletions are skipped the same way (interrupted judged from the re-read manifest)
    const all = await listHeld(s.roots);
    const asOk = all.find((d) => d.deletionId === movingId) as OkDeletion;
    const again = await planEmpty([...all.filter((d) => d.deletionId !== movingId), { ...asOk, interrupted: false }], s.roots, s.now);
    expect(again.plans.map((p) => p.deletionId)).toEqual([goodId]);
    expect(again.skipped).toEqual([EMPTY_SKIPPED.corrupt(badId, (all.find((d) => d.deletionId === badId) as { error: string }).error),
      EMPTY_SKIPPED.interrupted(movingId)]);
    const before = await treeDigest(hr);
    expect((await s.exec(plans[0]!)).ok).toBe(true);
    const after = await treeDigest(hr);
    for (const [k, v] of Object.entries(before)) {
      if (!k.startsWith(goodId)) expect(after[k], k).toBe(v);                     // the skipped deletions are untouched
    }
  });

  test('EMPTY_SKIPPED texts', () => {
    expect(EMPTY_SKIPPED.corrupt('X', 'bad')).toBe('Skipped X: its manifest is unreadable (bad). It was left untouched.');
    expect(EMPTY_SKIPPED.interrupted('X')).toBe('Skipped X: a move into Recently Deleted did not finish. Restore it or review it first.');
    expect(EMPTY_SKIPPED.gone('X')).toBe('Skipped X: it is no longer in Recently Deleted.');
    expect(EMPTY_SKIPPED.changed('X')).toBe('Skipped X: it changed after it was listed. Review Recently Deleted again.');
  });
});

describe('planEmpty: junk in the deletion folder', () => {
  test('planEmpty never follows a symlinked directory inside a deletion and lists stray files', async () => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const [d] = await okList(s);
    const outside = join(s.root, 'outside-dir');
    const canary = await canaries.plant(join(outside, 'canary.txt'), 'keep me\n');
    const junk = join(d!.dir, 'junk');
    await symlink(outside, junk);
    const tmp = join(d!.dir, 'manifest.json.123.tmp');
    await writeFile(tmp, 'half-written');
    const { plans } = await planEmpty('all', s.roots, s.now);
    const plan = plans[0]!;
    expect(plan.ops).toContainEqual(expect.objectContaining({ kind: 'unlink', path: junk, role: 'held-item', expect: expect.objectContaining({ isSymlink: true }) }));
    expect(plan.ops).toContainEqual(expect.objectContaining({ kind: 'unlink', path: tmp, role: 'held-item' }));
    expect(plan.freed.lines).toContainEqual({ path: junk, bytes: 0, reason: 'link-only' });
    expect(plan.freed.lines).toContainEqual({ path: tmp, bytes: 12, reason: 'plain-file' });
    expect(pathsOf(plan).some((p) => p === outside || p.startsWith(outside + sep))).toBe(false);
    expect((await s.exec(plan)).ok).toBe(true);
    expect(existsSync(d!.dir)).toBe(false);
    expect(readFileSync(canary, 'utf8')).toBe('keep me\n');
  });

  test('the stray a failed hold left at a destination is listed as an unlink op and removed', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = createHoldHooks({ safeFs: s.safeFs, fs: s.fs, model: m, viewRoots: s.viewRoots, now: () => 1_000 });
    const dest = plan.ops.filter((o): o is Extract<Op, { kind: 'hold-rename' }> => o.kind === 'hold-rename')[1]!.dest;
    const failSecondRename: ExecHooks = {
      ...hooks,
      async beforeFirstOp(p) {
        await hooks.beforeFirstOp!(p);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, 'x');
      },
    };
    const r = await s.exec(plan, failSecondRename);
    expect(r.ok).toBe(false);
    await finalizeHold(plan, r, { safeFs: s.safeFs, fs: s.fs });
    const { plans } = await planEmpty('all', s.roots, s.now);
    expect(plans[0]!.ops).toContainEqual(expect.objectContaining({ kind: 'unlink', path: dest, role: 'held-item' }));
    expect((await s.exec(plans[0]!)).ok).toBe(true);
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
  });

  test.each([['outside the hold root', 'CONTAINMENT'], ['inside the hold root', 'STALE']])(
    'R29: D/a swapped for a symlink (to a moved copy %s) after planning → %s, nothing touched', async (where, code) => {
      const s = await buildHoldScenario();
      await holdAt(s, 1_000);
      const [d] = await okList(s);
      const { plans } = await planEmpty('all', s.roots, s.now);
      const a = join(d!.dir, 'models--org--gguf');
      const deep = unlinks(plans[0]!).find((o) => o.path.startsWith(join(a, 'snapshots') + sep) && depth(o.path) - depth(a) >= 3);
      expect(deep).toBeDefined();
      const moved = where.startsWith('outside') ? join(s.root, 'moved-a') : join(s.roots.holdRoot!, 'moved-a');
      await rename(a, moved);
      await symlink(moved, a);
      const before = await treeDigest(s.root);
      const r = await s.exec(plans[0]!);
      expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code } });
      expect(await treeDigest(s.root)).toEqual(before);
    });

  test('at apply time: D/a swapped for a symlink after revalidation → the unlink below it fails, nothing outside D touched', async () => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const [d] = await okList(s);
    const { plans } = await planEmpty('all', s.roots, s.now);
    const a = join(d!.dir, 'models--org--gguf');
    const moved = join(s.roots.holdRoot!, 'moved-a');
    let movedBefore: Record<string, string> = {};
    const swap: ExecHooks = {
      async beforeFirstOp() {
        await rename(a, moved);
        await symlink(moved, a);
        movedBefore = await treeDigest(moved);
      },
    };
    const first = plans[0]!.ops[0] as Unlink;
    expect(first.path.startsWith(a + sep)).toBe(true);                             // the deepest entry is under D/a
    const r = await s.exec(plans[0]!, swap);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', path: first.path } });
    expect(r.error!.message).toContain('unlink failed: STALE');
    expect(await treeDigest(moved)).toEqual(movedBefore);
  });
});

describe('planEmpty: refusals', () => {
  test('planEmpty throws NO_HOLD_ROOT when roots.holdRoot is null', async () => {
    const s = await buildHoldScenario();
    const err = await planEmpty('all', { ...s.roots, holdRoot: null }, s.now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeldError);
    expect(err).toMatchObject({ code: 'NO_HOLD_ROOT' });
  });

  test.each([
    ['deletion dir is a symlink', 'gone'], ['deletion dir gone', 'gone'], ['bad deletion id', 'corrupt'],
    ['manifest replaced by a directory', 'corrupt'], ['manifest text changed', 'changed'], ['manifest of another hub', 'corrupt'],
  ])('fix 3: a deletion that changed after listing (%s) is skipped (%s), the others are still planned; nothing touched', async (name, kind) => {
    const s = await buildHoldScenario();
    const other = await holdAt(s, 500, await groupSel(s, 'org/gguf', 'Q4_K_M'));
    await holdAt(s, 1_000);
    const list = await okList(s);
    let d = list.find((x) => x.deletionId !== other)!;
    const id = d.deletionId;
    let roots = s.roots;
    if (name === 'deletion dir is a symlink') {
      await rename(d.dir, join(s.root, 'elsewhere'));
      await symlink(join(s.root, 'elsewhere'), d.dir);
    }
    if (name === 'deletion dir gone') await rename(d.dir, join(s.root, 'elsewhere'));
    if (name === 'bad deletion id') d = { ...d, deletionId: '../' + id };
    if (name === 'manifest replaced by a directory') {
      await rename(join(d.dir, MANIFEST_NAME), join(s.root, 'old-manifest'));
      await mkdir(join(d.dir, MANIFEST_NAME));
    }
    if (name === 'manifest text changed') d = { ...d, manifestText: d.manifestText + ' ' };
    if (name === 'manifest of another hub') roots = { ...roots, hubRoot: join(s.root, 'other-hub') };
    const before = await treeDigest(s.root);
    const r = await planEmpty([list.find((x) => x.deletionId === other)!, d], roots, s.now);
    const anotherHub = name === 'manifest of another hub';
    expect(r.skipped).toHaveLength(anotherHub ? 2 : 1);
    const mine = r.skipped.at(-1)!;
    expect(mine.startsWith(`Skipped ${d.deletionId}: `)).toBe(true);
    if (kind === 'gone') expect(mine).toBe(EMPTY_SKIPPED.gone(id));
    if (kind === 'changed') expect(mine).toBe(EMPTY_SKIPPED.changed(id));
    if (kind === 'corrupt') expect(mine).toMatch(/: its manifest is unreadable \(.+\)\. It was left untouched\.$/);
    if (anotherHub) expect(mine).toContain('different hub');
    // another hub: the other deletion's manifest belongs to the scanned hub, not `roots`, so it is skipped too
    expect(r.plans.map((p) => p.deletionId)).toEqual(anotherHub ? [] : [other]);
    expect(await treeDigest(s.root)).toEqual(before);
  });

  test('the caller-supplied manifest and dir are never used: only deletionId and manifestText count', async () => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const [d] = await okList(s);
    const forged: HoldManifest = structuredClone(d!.manifest);
    forged.items = forged.items.map((i) => ({ ...i, heldPath: '/etc/passwd' }));
    forged.createdAt = 0;
    const a = await planEmpty([d!], s.roots, s.now);
    const b = await planEmpty([{ ...d!, manifest: forged, dir: '/tmp', heldCount: 0, otherEntries: 0 }], s.roots, s.now);
    expect(b.plans.map((p) => p.ops)).toEqual(a.plans.map((p) => p.ops));
    expect(b.plans.map((p) => p.freed)).toEqual(a.plans.map((p) => p.freed));
  });

  /** planEmpty of the one held deletion with `fs`: the deletion it skipped as changed, or the error it threw. */
  async function changedWith(make: (s: HoldScenario, d: OkDeletion) => ReadFs): Promise<{ s: HoldScenario; d: OkDeletion; r: unknown }> {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const [d] = await okList(s);
    const r = await planEmpty([d!], s.roots, s.now, make(s, d!)).catch((e: unknown) => e);
    return { s, d: d!, r };
  }

  test.each([
    ['an entry vanishing mid-walk', 'lstat', 'ENOENT'], ['a directory vanishing mid-walk', 'readdir', 'ENOENT'],
    ['a directory realpath vanishing', 'realpath', 'ENOENT'],
  ] as const)('%s: the deletion is skipped as changed (STALE_MANIFEST)', async (_name, method, code) => {
    const { d, r } = await changedWith((s, x) => failingFs(s.fs, method, code, (q) => q === join(x.dir, 'models--org--gguf')));
    expect(r).toEqual({ plans: [], skipped: [EMPTY_SKIPPED.changed(d.deletionId)] });
  });

  test('any other read error mid-walk propagates unchanged', async () => {
    const { r } = await changedWith((s, x) => failingFs(s.fs, 'readdir', 'EIO', (q) => q === x.dir));
    expect(r).not.toBeInstanceOf(HeldError);
    expect(r).toMatchObject({ code: 'EIO' });
  });

  test('a directory reached through a symlinked ancestor (realpath differs) is skipped as changed', async () => {
    const { d, r } = await changedWith((s, x) => {
      const target = join(x.dir, 'models--org--gguf', 'snapshots');
      return { ...s.fs, realpath: async (p: string) => (p === target ? p + '-elsewhere' : s.fs.realpath(p)) } as ReadFs;
    });
    expect(r).toEqual({ plans: [], skipped: [EMPTY_SKIPPED.changed(d.deletionId)] });
  });

  test('a manifest that vanished or changed between the re-read and the walk is skipped as changed', async () => {
    const hidden = await changedWith((s, x) => ({ ...s.fs, readdir: async (p: string) =>
      (await s.fs.readdir(p)).filter((n) => join(p, n) !== join(x.dir, MANIFEST_NAME)) }) as ReadFs);
    expect(hidden.r).toEqual({ plans: [], skipped: [EMPTY_SKIPPED.changed(hidden.d.deletionId)] });
    const grown = await changedWith((s, x) => {
      let n = 0;
      const mp = join(x.dir, MANIFEST_NAME);
      return { ...s.fs, lstat: async (p: string) => {
        const st = await s.fs.lstat(p);
        // the first lstat of the manifest is rereadHeld's; the walk's sees it one byte larger
        return p === mp && n++ > 0 ? Object.assign(Object.create(Object.getPrototypeOf(st) as object) as object, st, { size: st.size + 1 }) as typeof st : st;
      } } as ReadFs;
    });
    expect(grown.r).toEqual({ plans: [], skipped: [EMPTY_SKIPPED.changed(grown.d.deletionId)] });
  });
});

describe('anything the plan does not remove keeps the deletion folder (STALE before, IO during)', () => {
  test.each([['the deletion folder', []], ['a nested directory', ['models--org--gguf', 'snapshots']]] as const)(
    'a file added to %s after planning → STALE naming it, nothing touched', async (_where, rel) => {
      const s = await buildHoldScenario();
      await holdAt(s, 1_000);
      const [d] = await okList(s);
      const { plans } = await planEmpty('all', s.roots, s.now);
      const added = join(d!.dir, ...rel, 'added-later');
      await writeFile(added, 'new');
      const before = await treeDigest(s.root);
      const r = await s.exec(plans[0]!);
      expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE', path: added } });
      expect(await treeDigest(s.root)).toEqual(before);
    });

  test('a file added during the run → IO at its directory; the manifest is still there and the deletion still lists', async () => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const [d] = await okList(s);
    const { plans } = await planEmpty('all', s.roots, s.now);
    const nested = join(d!.dir, 'models--org--gguf', 'snapshots');
    const r = await s.exec(plans[0]!, { beforeFirstOp: async () => { await writeFile(join(nested, 'raced-in'), 'x'); } });
    expect(r).toMatchObject({ ok: false, error: { code: 'IO', path: nested } });
    expect(r.error!.message).toContain('rmdir-empty failed: ENOTEMPTY');
    expect(readFileSync(join(d!.dir, MANIFEST_NAME), 'utf8')).toBe(d!.manifestText);
    expect(readFileSync(join(nested, 'raced-in'), 'utf8')).toBe('x');
    expect((await listHeld(s.roots)).at(0)).toMatchObject({ ok: true, deletionId: d!.deletionId });
  });

  test.each([['ENOENT', 'STALE'], ['EIO', 'IO']] as const)('reading a directory at revalidation failing with %s → %s, nothing touched', async (errno, code) => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const [d] = await okList(s);
    const { plans } = await planEmpty('all', s.roots, s.now);
    const before = await treeDigest(s.root);
    const r = await executePlan(plans[0]!, { ...s.execDeps(), fs: failingFs(s.fs, 'readdir', errno, (q) => q === d!.dir) });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code, path: d!.dir } });
    expect(await treeDigest(s.root)).toEqual(before);
  });
});

describe('special files', () => {
  // A Unix socket is the special file a test can make without a shell (child_process is banned in tests too); a fifo
  // or device node takes the same path: lstat says neither file, directory nor symlink
  test.skipIf(process.platform === 'win32')('a socket in the deletion folder is listed as an unlink with 0 bytes (special-file) and removed', async () => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const [d] = await okList(s);
    const sock = join(d!.dir, 's');
    const server = createServer();
    // sun_path is limited to ~107 bytes and Stryker's temp dir lengthens the absolute path: listen through a short symlink
    const short = join(s.root, 'k');
    await symlink(d!.dir, short);
    try { await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(join(short, 's'), res); }); }
    finally { await unlink(short); }
    try {
      const { plans } = await planEmpty('all', s.roots, s.now);
      expect(plans[0]!.ops).toContainEqual(expect.objectContaining({ kind: 'unlink', path: sock, role: 'held-item',
        expect: expect.objectContaining({ isFile: false, isDirectory: false, isSymlink: false }) }));
      expect(plans[0]!.freed.lines).toContainEqual({ path: sock, bytes: 0, reason: 'special-file' });
      expect((await s.exec(plans[0]!)).ok).toBe(true);
      expect(existsSync(d!.dir)).toBe(false);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

describe('planEmpty: executeHold-built deletions', () => {
  test('a deletion made by executeHold empties completely', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const hold = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    expect((await executeHold(hold, s.execDeps(), { model: m, viewRoots: s.viewRoots, fs: s.fs })).ok).toBe(true);
    const { plans } = await planEmpty('all', s.roots, s.now);
    expect((await s.exec(plans[0]!)).ok).toBe(true);
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
  });
});
