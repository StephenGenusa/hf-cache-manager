// Property tests for the deletion invariants ((a)–(d), and 9). Each run builds a random hub in
// a guarded temp root (buildTree), plans with the real planner, executes with the real executor through SafeFs over
// the fixture's guardedFs, and checks the disk against oracles computed from the before/after trees.
// Runs: NUM_RUNS per property from a fixed per-property seed, so the generator-coverage check is deterministic.
// FC_NUM_RUNS overrides the count; FC_SEED replays a reported seed (or `random` draws one); either way the coverage
// check is then skipped unless the default seed runs at least the default count.
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyRepo } from '../../../src/core/classify/classify';
import { executePlan, isViewOp, type ExecDeps, type ExecOutcome } from '../../../src/core/exec/executor';
import { Journal } from '../../../src/core/exec/journal';
import { AppLock } from '../../../src/core/exec/lock';
import { PlanError, targetOf } from '../../../src/core/plan/closure';
import { phaseOf, planDeletion } from '../../../src/core/plan/planner';
import { SafeFs } from '../../../src/core/safe-fs';
import type {
  CacheModel, DeletionPlan, Group, Op, PlanPair, Selection, ViewImpactLine, ViewImpactProvider,
} from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { bytesFreedIfRemoved, danglingLinks, diffTrees, snapshotTree, uniqueInodeBytes, type TreeEntry } from '../support/observe';
import { buildTree, scanTolerant, type Tree, type TreeSpec } from '../support/scenarios';
import { lmstudioViews } from '../support/stub-views';
import { arbPick, arbTreeSpec, asksLockedWithoutUnlock, selectionFrom, type Pick } from './arb';

useCanaries();

const DEFAULT_RUNS = 40;
const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? DEFAULT_RUNS);
const FC_SEED = process.env.FC_SEED;
/** fc.assert parameters; on failure the thrown error carries the seed, the shrink path and the counterexample. */
const params = <Ts extends unknown[]>(defaultSeed: number): fc.Parameters<Ts> => ({
  numRuns: NUM_RUNS,
  ...(FC_SEED === undefined ? { seed: defaultSeed } : FC_SEED === 'random' ? {} : { seed: Number(FC_SEED) }),
});

/**
 * Generator coverage: every dangerous shape must occur at least once in a property's runs, so a
 * generator regression that stops drawing one fails loudly instead of silently weakening the property.
 */
const SHAPES = [
  'shared 64-hex blob', 'shared 40-hex blob', '40-hex blob doomed', 'cross-repo store payload', 'keep sweep',
  'hardlink-all-planned', 'D1 refusal', 'locked group selected', 'locked group refused', 'empty snapshot',
  'view links', 'store lock', 'orphan blob', 'whole repo', 'partial repo',
] as const;
type Shape = (typeof SHAPES)[number];
class Coverage {
  private seen = new Map<Shape, number>();
  mark(shape: Shape, on = true): void {
    if (on) this.seen.set(shape, (this.seen.get(shape) ?? 0) + 1);
  }
  /** Shapes of one planned case (the freed lines, warnings and view impact are the same on both plans of a pair). */
  record(model: CacheModel, selection: Selection, plan: DeletionPlan): void {
    const linksPer = (repo: CacheModel['repos'][number]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const f of repo.files) {
        const tg = targetOf(repo, f);
        if (tg.kind === 'blob') m.set(tg.path, (m.get(tg.path) ?? 0) + 1);
      }
      return m;
    };
    const shared = model.repos.flatMap((r) => [...linksPer(r)].filter(([, n]) => n > 1).map(([p]) => basename(p)));
    this.mark('shared 64-hex blob', shared.some((e) => HEX64.test(e)));
    this.mark('shared 40-hex blob', shared.some((e) => HEX40.test(e)));
    this.mark('40-hex blob doomed', plan.freed.lines.some((l) => HEX40.test(basename(l.path)) && basename(dirname(l.path)) === 'blobs'));
    this.mark('cross-repo store payload', Object.values(model.store).some((st) => new Set((st.validRefs ?? []).map((r) => r.split('/')[0])).size > 1));
    this.mark('keep sweep', plan.ops.some((o) => o.kind === 'store-sweep' && o.payload === 'keep'));
    this.mark('hardlink-all-planned', plan.freed.lines.some((l) => l.reason === 'hardlink-all-planned'));
    this.mark('D1 refusal', plan.warnings.some((w) => w.includes(' kept: same content as ')));
    this.mark('locked group selected', selection.repos.some((s) => !s.whole && s.unlockComponents));
    this.mark('empty snapshot', model.repos.some((r) => r.snapshots.some((c) => !r.files.some((f) => f.commit === c))));
    this.mark('view links', plan.viewImpact.length > 0);
    this.mark('store lock', Object.values(model.store).some((st) => st.lockPresent));
    this.mark('orphan blob', model.repos.some((r) => r.orphanEtags.length > 0 || r.otherFiles.some((o) => HEX40.test(basename(o.path)))));
    this.mark('whole repo', selection.repos.some((s) => s.whole));
    this.mark('partial repo', selection.repos.some((s) => !s.whole));
  }
  assertAll(): void {
    if (FC_SEED !== undefined || NUM_RUNS < DEFAULT_RUNS) return; // only the default seed's runs are pinned
    const missing = SHAPES.filter((s) => !this.seen.has(s));
    expect(missing, `generator coverage: shapes never drawn ${JSON.stringify(Object.fromEntries(this.seen))}`).toEqual([]);
  }
}
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const TIMEOUT = 300_000;

const within = (p: string, root: string): boolean => p === root || p.startsWith(root + sep);
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
const without = (t: Map<string, TreeEntry>, pred: (p: string) => boolean): Map<string, TreeEntry> =>
  new Map([...t].filter(([p]) => !pred(p)));
/** Freed counts payload and file bytes; a store `.refs` manifest is metadata the freed figure never includes. */
const isRefs = (p: string): boolean => p.endsWith('.refs');

/** View provider that lists what lmstudioViews would remove, but only as blocked lines with no ops. */
function blockedViews(viewRoot: string, fs: Tree['fs']): ViewImpactProvider {
  const inner = lmstudioViews(viewRoot, fs);
  return {
    impactFor: async (model, doomed) => {
      const { lines } = await inner.impactFor(model, doomed);
      return { ops: [], lines: lines.map((l): ViewImpactLine => ({ ...l, action: 'blocked', note: 'test: view blocked' })) };
    },
  };
}

interface Case {
  t: Tree; model: CacheModel; selection: Selection; pair: PlanPair; plan: DeletionPlan;
  /** classifyRepo groups per repo id, taken before execution (classification reads model_index.json from disk) */
  groups: Map<string, Group[]>;
  before: Map<string, TreeEntry>; after: Map<string, TreeEntry>; result: ExecOutcome;
  danglingViewBefore: string[]; danglingHubBefore: string[];
}

/**
 * Scans `t`, derives the selection from `pick` and plans it. A selection asking for a locked group without
 * unlockComponents must be refused with PlanError LOCKED_GROUP and nothing on disk changed; that case returns null.
 */
async function planOrRefuse(
  t: Tree, pick: Pick, views: ViewImpactProvider, cov: Coverage,
): Promise<{ model: CacheModel; selection: Selection; pair: PlanPair } | null> {
  const model = await scanTolerant(t);
  const selection = selectionFrom(model, pick);
  if (asksLockedWithoutUnlock(model, selection)) {
    const before = await snapshotTree(t.root);
    const err = await planDeletion({ model, selection, roots: t.roots, views, now: t.now }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect((err as PlanError).code).toBe('LOCKED_GROUP');
    expect(diffTrees(before, await snapshotTree(t.root))).toEqual({ removed: [], added: [], changed: [] });
    cov.mark('locked group refused');
    return null;
  }
  const pair = await planDeletion({ model, selection, roots: t.roots, views, now: t.now });
  cov.record(model, selection, pair.permanent);
  return { model, selection, pair };
}

/**
 * Builds the tree, plans `pick`, executes the plan of `pick.mode` (dry run when asked) and snapshots the whole fixture
 * root before and after. `body` runs the assertions; the fixture is disposed after every run (its canaries are verified
 * then, so a run that touched one fails). A refused locked selection is checked in planOrRefuse and skips `body`.
 */
async function withCase(
  spec: TreeSpec, pick: Pick, cov: Coverage,
  opts: { views?: 'lmstudio' | 'blocked'; dryRun?: boolean },
  body: (c: Case) => Promise<void> | void,
): Promise<void> {
  const t = await buildTree(spec);
  try {
    const views = opts.views === 'blocked' ? blockedViews(t.lmstudioRoot, t.fs) : lmstudioViews(t.lmstudioRoot, t.fs);
    const planned = await planOrRefuse(t, pick, views, cov);
    if (planned === null) return;
    const { model, selection, pair } = planned;
    const groups = new Map(model.repos.map((r) => [r.id, classifyRepo(r).groups]));
    const plan = pick.mode === 'hold' ? pair.hold : pair.permanent;
    if (plan === null) throw new Error('the fixture always offers hold');
    const danglingViewBefore = await danglingLinks(t.lmstudioRoot);
    const danglingHubBefore = await danglingLinks(t.hub);
    const before = await snapshotTree(t.root);
    const deps: ExecDeps = {
      safeFs: await SafeFs.create(t.roots, t.fs), fs: t.fs,
      journal: new Journal(t.appData, () => t.now), lock: new AppLock(t.lockDir),
      rescan: () => scanTolerant(t), now: () => t.now, diskFree: async () => 1e12,
      ...(opts.dryRun ? { dryRun: true } : {}),
    };
    const result = await executePlan(plan, deps);
    const after = await snapshotTree(t.root);
    await body({ t, model, selection, pair, plan, groups, before, after, result, danglingViewBefore, danglingHubBefore });
  } finally {
    await t.dispose();
  }
}

/** Removed / added / changed over the fixture root, the executor's own journal (app data) excluded. */
function diffOf(c: Case): ReturnType<typeof diffTrees> {
  const app = (p: string): boolean => within(p, c.t.appData);
  return diffTrees(without(c.before, app), without(c.after, app));
}

const descendants = (t: Map<string, TreeEntry>, root: string): string[] => [...t.keys()].filter((p) => within(p, root));

/** Paths the executor must have moved into the hold area: `[source, dest]` for every rename, store hold included. */
function holdMoves(plan: DeletionPlan): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const op of plan.ops) {
    if (op.kind === 'hold-rename') out.push([op.path, op.dest]);
    if (op.kind === 'store-sweep' && op.payload === 'hold') out.push([op.storePath, join(plan.holdRoot!, ...op.holdDest!.split('/'))]);
  }
  return out;
}

describe('deletion properties', () => {
  it('(a) removed paths equal the plan paths; changed ⊆ refs/write-file paths; added only under <holdRoot>/<deletionId>', async () => {
    const cov = new Coverage();
    await fc.assert(fc.asyncProperty(arbTreeSpec, arbPick, async (spec, pick) => {
      await withCase(spec, pick, cov, {}, async (c) => {
        expect(c.result.error).toBeUndefined();
        expect(c.result).toMatchObject({ ok: true, appliedOps: c.plan.ops.length });
        const d = diffOf(c);

        const expectedRemoved = new Set<string>();
        const allowedChanged = new Set<string>();
        for (const op of c.plan.ops) {
          switch (op.kind) {
            case 'unlink': case 'rmdir-empty': expectedRemoved.add(op.path); break;
            case 'hold-rename': for (const p of descendants(c.before, op.path)) expectedRemoved.add(p); break;
            case 'store-sweep':
              if (op.payload !== 'keep') { expectedRemoved.add(op.storePath); expectedRemoved.add(op.refsPath); }
              else allowedChanged.add(op.refsPath);
              break;
            case 'write-file': allowedChanged.add(op.path); break;
            default: throw new Error(`unexpected op kind ${op.kind} in a delete plan`);
          }
        }
        expect(d.removed).toEqual(sorted(expectedRemoved));
        for (const p of d.changed) expect(allowedChanged.has(p), `changed ${p}`).toBe(true);

        // A keep-sweep leaves .refs = the lines it had minus those of the removed repo blobs, sorted, "<line>\n" each
        const removedSet = new Set(d.removed);
        for (const op of c.plan.ops) {
          if (op.kind !== 'store-sweep' || op.payload !== 'keep') continue;
          const raw = c.model.store[op.storePath]!.refsRaw!;
          const left = raw.filter((l) => !removedSet.has(join(c.t.hub, ...l.split('/')))).sort();
          expect(left.length).toBeGreaterThan(0);
          expect(await readFile(op.refsPath, 'utf8')).toBe(left.map((l) => `${l}\n`).join(''));
        }

        if (c.plan.mode === 'permanent') {
          expect(d.added).toEqual([]);
          return;
        }
        // Hold: exactly the moved entries (same inode, type, bytes, link text) plus the folders above them
        const holdDir = join(c.plan.holdRoot!, c.plan.deletionId!);
        const expectedAdded = new Set<string>([holdDir]);
        for (const [src, dest] of holdMoves(c.plan)) {
          for (let p = dirname(dest); within(p, holdDir); p = dirname(p)) expectedAdded.add(p);
          for (const p of descendants(c.before, src)) {
            const moved = dest + p.slice(src.length);
            expectedAdded.add(moved);
            const b = c.before.get(p)!;
            const a = c.after.get(moved);
            expect(a, `held ${moved}`).toBeDefined();
            expect({ type: a!.type, ino: a!.ino, sha256: a!.sha256, linkTarget: a!.linkTarget })
              .toEqual({ type: b.type, ino: b.ino, sha256: b.sha256, linkTarget: b.linkTarget });
          }
        }
        expect(d.added).toEqual(sorted(expectedAdded));
      });
    }), params(0x7a11));
    cov.assertAll();
  }, TIMEOUT);

  it('(b) nothing outside the closure: every removed snapshot entry is in a selected group or links a doomed etag; orphanEtags after ⊆ before; no new dangling link in the hub', async () => {
    const cov = new Coverage();
    await fc.assert(fc.asyncProperty(arbTreeSpec, arbPick, async (spec, pick) => {
      await withCase(spec, pick, cov, {}, async (c) => {
        expect(c.result.ok).toBe(true);
        const removed = new Set(diffOf(c).removed);
        const byId = new Map(c.model.repos.map((r) => [r.id, r]));
        const selectedFolders = c.selection.repos.map((s) => byId.get(s.repoId)!.folder);
        const storePaths = new Set(c.plan.ops.flatMap((o) => (o.kind === 'store-sweep' ? [o.storePath, o.refsPath] : [])));

        // Every removed path is in a selected repo folder, a store path the plan sweeps, or a view root
        for (const p of removed) {
          const ok = selectedFolders.some((f) => within(p, f)) || storePaths.has(p) || c.t.roots.viewRoots.some((v) => within(p, v));
          expect(ok, `removed ${p} lies outside the selection's closure`).toBe(true);
        }

        for (const sel of c.selection.repos) {
          const repo = byId.get(sel.repoId)!;
          if (sel.whole) continue; // the whole folder is the closure
          const chosen = new Set(sel.groupKeys);
          const inGroup = new Set(c.groups.get(repo.id)!.filter((g) => chosen.has(g.key)).flatMap((g) => g.files.map((x) => x.linkPath)));
          const removedTargets = new Set<string>();
          for (const file of repo.files) {
            if (!removed.has(file.linkPath)) continue;
            // the first-hop blob (64-hex RepoBlob or 40-hex git-sha1 blob) went with the link
            const tg = targetOf(repo, file);
            if (tg.kind === 'blob') removedTargets.add(tg.path);
            const doomedEtag = tg.kind === 'blob' && removed.has(tg.path);
            expect(inGroup.has(file.linkPath) || doomedEtag, `${file.linkPath} removed outside the closure`).toBe(true);
            // A current file outside the selected groups blocks its blob, so only non-current entries go with it
            if (!inGroup.has(file.linkPath)) expect(file.isCurrent, `current ${file.linkPath} removed outside the selection`).toBe(false);
          }
          // a partial selection never removes the folder, refs/, the main snapshot root or anything outside snapshots/ and blobs/
          for (const p of removed) {
            if (!within(p, repo.folder)) continue;
            // a removed blobs/* entry is the first-hop blob of a removed link: never an orphan, an .incomplete or a stray file
            if (dirname(p) === join(repo.folder, 'blobs')) expect(removedTargets.has(p), `partial removed unlinked ${p}`).toBe(true);
            expect(within(p, join(repo.folder, 'snapshots')) || dirname(p) === join(repo.folder, 'blobs'), `partial removed ${p}`).toBe(true);
            if (repo.mainCommit !== null) expect(p).not.toBe(join(repo.folder, 'snapshots', repo.mainCommit));
            // A removed directory lost at least one file of the closure (an already-empty dir is not in it)
            if (c.before.get(p)!.type === 'dir') {
              expect(descendants(c.before, p).some((q) => q !== p && removed.has(q) && c.before.get(q)!.type !== 'dir'), `empty dir ${p} removed`).toBe(true);
            }
          }
          for (const inc of repo.incomplete) expect(removed.has(inc.path), `partial removed ${inc.path}`).toBe(false);
          for (const e of repo.orphanEtags) expect(removed.has(repo.blobs[e]!.path), `partial removed orphan ${e}`).toBe(false);
        }

        // A locked store payload is never swept: no op names it, and it and its .refs are untouched
        const changed = new Set(diffOf(c).changed);
        for (const st of Object.values(c.model.store)) {
          if (!st.lockPresent) continue;
          expect(c.plan.ops.some((o) => o.kind === 'store-sweep' && o.storePath === st.path), `locked ${st.path} swept`).toBe(false);
          for (const p of [st.path, st.refsPath]) expect(removed.has(p) || changed.has(p), `locked store ${p} touched`).toBe(false);
        }

        const model2 = await scanTolerant(c.t);
        for (const r2 of model2.repos) {
          const r1 = byId.get(r2.id)!;
          for (const e of r2.orphanEtags) expect(r1.orphanEtags, `${r2.id}: new orphan ${e}`).toContain(e);
        }
        for (const s of c.selection.repos) {
          if (s.whole) expect(model2.repos.map((r) => r.id)).not.toContain(s.repoId);
        }
        const dangling = await danglingLinks(c.t.hub);
        for (const p of dangling) expect(c.danglingHubBefore, `new dangling hub link ${p}`).toContain(p);
      });
    }), params(0x7b22));
    cov.assertAll();
  }, TIMEOUT);

  it('(c) permanent: uniqueInodeBytes(before) − uniqueInodeBytes(after) === plan.freed.bytes; hold: unchanged, and bytesFreedIfRemoved(<holdRoot>/<deletionId>) === plan.freed.bytes', async () => {
    const cov = new Coverage();
    await fc.assert(fc.asyncProperty(arbTreeSpec, arbPick, async (spec, pick) => {
      await withCase(spec, pick, cov, {}, (c) => {
        expect(c.result.ok).toBe(true);
        const app = (p: string): boolean => within(p, c.t.appData) || isRefs(p);
        const before = without(c.before, app);
        const after = without(c.after, app);
        if (c.plan.mode === 'permanent') {
          expect(uniqueInodeBytes(before, c.t.hub) - uniqueInodeBytes(after, c.t.hub)).toBe(c.plan.freed.bytes);
          expect(uniqueInodeBytes(before) - uniqueInodeBytes(after)).toBe(c.plan.freed.bytes); // nothing elsewhere either
          expect(c.result).toMatchObject({ freedBytesPlanned: c.plan.freed.bytes, heldBytes: 0 });
        } else {
          const holdDir = join(c.plan.holdRoot!, c.plan.deletionId!);
          expect(uniqueInodeBytes(after)).toBe(uniqueInodeBytes(before));
          expect(bytesFreedIfRemoved(after, holdDir)).toBe(c.plan.freed.bytes);
          expect(uniqueInodeBytes(after, holdDir)).toBe(c.plan.apparentBytes);
          expect(c.result).toMatchObject({ freedBytesPlanned: 0, heldBytes: c.plan.apparentBytes });
        }
      });
    }), params(0x7c35));
    cov.assertAll();
  }, TIMEOUT);

  it('(d) with lmstudioViews: danglingLinks(view) after ⊆ dangling before ∪ blocked lines; with stubViews(blocked-only): dangling == listed', async () => {
    const cov = new Coverage();
    await fc.assert(fc.asyncProperty(arbTreeSpec, arbPick, fc.boolean(), async (spec, pick, blocked) => {
      await withCase(spec, pick, cov, { views: blocked ? 'blocked' : 'lmstudio' }, async (c) => {
        expect(c.result.ok).toBe(true);
        const listed = c.plan.viewImpact.filter((l) => l.action === 'blocked').map((l) => join(c.t.lmstudioRoot, ...l.path.split('/')));
        const dangling = await danglingLinks(c.t.lmstudioRoot);
        if (blocked) {
          expect(c.plan.ops.some((o) => isViewOp(o, c.t.roots.viewRoots))).toBe(false);
          expect(dangling).toEqual(sorted(new Set([...c.danglingViewBefore, ...listed])));
        } else {
          expect(listed).toEqual([]);
          for (const p of dangling) expect(c.danglingViewBefore, `view link ${p} dangles`).toContain(p);
          // every removed view link was one the plan listed for removal
          const removedLinks = diffOf(c).removed.filter((p) => within(p, c.t.lmstudioRoot));
          const planned = c.plan.viewImpact.filter((l) => l.action === 'remove').map((l) => join(c.t.lmstudioRoot, ...l.path.split('/')));
          expect(removedLinks).toEqual(sorted(planned));
        }
      });
    }), params(0x7d44));
    cov.assertAll();
  }, TIMEOUT);

  it('inv9 property: dryRunOps equals plan.ops and the tree is unchanged', async () => {
    const cov = new Coverage();
    await fc.assert(fc.asyncProperty(arbTreeSpec, arbPick, async (spec, pick) => {
      await withCase(spec, pick, cov, { dryRun: true }, (c) => {
        expect(c.result.ok).toBe(true);
        expect(c.result.dryRunOps).toEqual(c.plan.ops);
        expect(diffTrees(c.before, c.after)).toEqual({ removed: [], added: [], changed: [] }); // app data and hold root included
      });
    }), params(0x7e56));
    cov.assertAll();
  }, TIMEOUT);

  it('inv5 property: phaseOf(ops) is non-decreasing for every generated plan', async () => {
    const cov = new Coverage();
    await fc.assert(fc.asyncProperty(arbTreeSpec, arbPick, async (spec, pick) => {
      const t = await buildTree(spec);
      try {
        const planned = await planOrRefuse(t, pick, lmstudioViews(t.lmstudioRoot, t.fs), cov);
        if (planned === null) return;
        const { pair } = planned;
        for (const plan of [pair.permanent, pair.hold!]) {
          expect(plan.purpose).toBe('delete'); // The phase order applies to delete plans
          // leading view ops from the ViewImpactProvider count as phase 0 (binding note); they must be a prefix
          const isView = plan.ops.map((o: Op) => isViewOp(o, t.roots.viewRoots));
          const firstHub = isView.indexOf(false);
          if (firstHub !== -1) expect(isView.slice(firstHub)).not.toContain(true);
          const phases = plan.ops.map((o, i) => (isView[i] ? 0 : phaseOf(o)));
          for (let i = 1; i < phases.length; i++) {
            expect(phases[i]!, `op ${i} ${plan.ops[i]!.kind} ${basename('path' in plan.ops[i]! ? (plan.ops[i] as { path: string }).path : '')}`)
              .toBeGreaterThanOrEqual(phases[i - 1]!);
          }
        }
      } finally {
        await t.dispose();
      }
    }), params(0x7f66));
    cov.assertAll();
  }, TIMEOUT);
});
