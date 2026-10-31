// Property: for random repos with several ref-named and unreferenced snapshots and random
// shared blobs, a partial selection never dooms a link outside it, except an older-revision link in no group of a
// snapshot no ref names, and then only with its blob; every doomed blob has every link to it doomed.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyRepo } from '../../../src/core/classify/classify';
import { checkClosure, closeSelection, targetOf } from '../../../src/core/plan/closure';
import { planCore } from '../../../src/core/plan/planner';
import type { Selection, SnapshotFile } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { buildTree, f, type FileSpec, type RepoSpec } from '../support/scenarios';

useCanaries();

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 40);
const COMMITS = ['c0', 'c1', 'c2', 'c3', 'c4'] as const;
const POOL: FileSpec[] = [f('blob', 'B0', 100), f('blob', 'B1', 110), f('blob', 'B2', 120), f('small', 'S0', 30), f('small', 'S1', 31)];
const NAMES = ['m-Q4_K_M.gguf', 'm-Q8_0.gguf', 'x.gguf', 'config.json', 'sub/y.gguf'];

const arbCase = fc.record({
  snaps: fc.array(fc.dictionary(fc.constantFrom(...NAMES), fc.nat({ max: POOL.length - 1 }), { maxKeys: 4 }),
    { minLength: COMMITS.length, maxLength: COMMITS.length }),
  refs: fc.array(fc.tuple(fc.constantFrom('dev', 'v1', 'pr/1', 'pr/2'), fc.constantFrom(...COMMITS)), { maxLength: 4 }),
  pick: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
});

describe('property: no link outside the selection is doomed', () => {
  it('holds for random ref-named, older and shared snapshots', async () => {
    let refusals = 0;
    let cascades = 0;
    await fc.assert(fc.asyncProperty(arbCase, async ({ snaps, refs, pick }) => {
      const snapshots: RepoSpec['snapshots'] = {};
      COMMITS.forEach((c, i) => {
        snapshots[c] = Object.fromEntries(Object.entries(snaps[i]!).map(([n, p]) => [n, POOL[p]!]));
      });
      snapshots.c1!['m-Q2_K.gguf'] = f('blob', 'MAIN', 500);   // main is never empty
      const extra = Object.fromEntries(refs.map(([name, c]) => [`refs/${name}`, c]));
      const t = await buildTree({ repos: [{ id: 'o/a', main: 'c1', snapshots, extra }] });
      try {
        const m = await t.scan();
        const repo = m.repos[0]!;
        const groups = classifyRepo(repo).groups.filter((g) => !g.locked);
        const chosen = groups.filter((_, i) => pick[i % pick.length]);
        if (chosen.length === 0) return;
        const selection: Selection = { repos: [{ repoId: 'o/a', whole: false, groupKeys: chosen.map((g) => g.key), unlockComponents: false }] };
        const [c] = closeSelection(m, selection);
        expect(() => checkClosure(c!)).not.toThrow();
        const S = new Set(chosen.flatMap((g) => g.files.map((x) => x.linkPath)));
        const grouped = new Set(classifyRepo(repo).groups.flatMap((g) => g.files.map((x) => x.linkPath)));
        const named = new Set((repo.refs ?? []).map((r) => r.commit));
        const doomedLinks = new Set(c!.links.map((x) => x.linkPath));
        const doomedBlobs = new Set(c!.blobs.map((b) => b.path));
        const blobOf = (x: SnapshotFile): string | null => { const tg = targetOf(repo, x); return tg.kind === 'blob' ? tg.path : null; };
        const exempt = (x: SnapshotFile): boolean => !x.isCurrent && !grouped.has(x.linkPath) && !named.has(x.commit);
        for (const x of c!.links) {
          if (S.has(x.linkPath)) continue;
          cascades++;
          expect(exempt(x), `${x.linkPath} is doomed but not selected`).toBe(true);
          expect(doomedBlobs.has(blobOf(x)!)).toBe(true);
        }
        for (const x of repo.files) {
          const b = blobOf(x);
          if (b !== null && doomedBlobs.has(b)) {
            expect(doomedLinks.has(x.linkPath), `${x.linkPath} outlives its blob`).toBe(true);
            expect(S.has(x.linkPath) || exempt(x), `${x.linkPath} is not selected`).toBe(true);
          }
        }
        const refused = new Set(c!.refused.map((r) => r.file.linkPath));
        refusals += refused.size;
        for (const p of S) expect(doomedLinks.has(p) !== refused.has(p), p).toBe(true);
        const core = planCore(m, selection, { mode: 'permanent', hubRoot: t.hub, holdRoot: null, deletionId: null, now: t.now });
        for (const op of core.ops) if (op.kind === 'unlink' && op.role === 'snapshot-link') expect(doomedLinks.has(op.path)).toBe(true);
      } finally {
        await t.dispose();
      }
    }), { numRuns: NUM_RUNS, seed: 8_0_1 });
    if (NUM_RUNS >= 40) {
      expect(refusals).toBeGreaterThan(0);
      expect(cascades).toBeGreaterThan(0);
    }
  }, 120_000);
});
