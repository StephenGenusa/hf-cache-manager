// The shared hold scenario: a hub with a Xet store, two repos sharing blobs, and LM Studio / Ollama view entries. Exact sizes
// and distinct payload bytes per file (spec in). Everything lives under the fixture's tmp root.
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { classifyRepo } from '../../../src/core/classify/classify';
import { executePlan, type ExecDeps, type ExecOutcome } from '../../../src/core/exec/executor';
import { Journal } from '../../../src/core/exec/journal';
import { AppLock } from '../../../src/core/exec/lock';
import type { FsLike } from '../../../src/core/fsx';
import { planDeletion } from '../../../src/core/plan/planner';
import { SafeFs } from '../../../src/core/safe-fs';
import { scanHub } from '../../../src/core/scan/scanner';
import type {
  CacheModel, DeletionPlan, ExecHooks, GroupKind, Selection, SafeRoots, ViewImpactProvider, ViewName,
} from '../../../src/core/types';
import { buildFixture } from '../../helpers/fixture';
import { triggeredViews } from '../support/stub-views';

export const HEX = {
  A: '1'.repeat(64), B: '2'.repeat(64), C: '3'.repeat(64), D: '4'.repeat(64), E: '5'.repeat(64),
  S1: 'aa' + '6'.repeat(62), S2: 'bb' + '7'.repeat(62), c1: 'c'.repeat(40), c2: 'd'.repeat(40),
};

export interface HoldScenario {
  root: string; hub: string; lmstudio: string; ollama: string; roots: SafeRoots;
  appData: string; now: number;
  viewRoots: Partial<Record<ViewName, string>>; views: ViewImpactProvider;
  model(): Promise<CacheModel>;
  keyFor(model: CacheModel, repoId: string, kind: GroupKind, labelPart: string): string;
  holdPlan(sel: Selection): Promise<DeletionPlan>;
  exec(plan: DeletionPlan, hooks?: ExecHooks, dryRun?: boolean): Promise<ExecOutcome>;
  execDeps(hooks?: ExecHooks, dryRun?: boolean): ExecDeps;
  safeFs: SafeFs; fs: FsLike;
}

/** `size` bytes of text unique to `tag`. */
const bytesOf = (tag: string, size: number): string => `${tag}|`.repeat(Math.ceil(size / (tag.length + 1))).slice(0, size);

export async function buildHoldScenario(): Promise<HoldScenario> {
  const fx = await buildFixture({ holdRoot: true, views: { lmstudio: { dirs: ['org/gguf'] }, ollama: { dirs: ['manifests/hf.co/org/gguf'] } } });
  const { fs, hubRoot: hub } = fx;
  const lmstudio = fx.viewRoots.lmstudio!;
  const ollama = fx.viewRoots.ollama!;
  const put = async (p: string, data: string): Promise<void> => {
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  };
  const ln = async (target: string, p: string): Promise<void> => {
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.symlink(target, p);
  };
  const { A, B, C, D, E, S1, S2, c1, c2 } = HEX;
  const gguf = join(hub, 'models--org--gguf');
  const other = join(hub, 'models--org--other');

  await put(join(hub, 'blobs', '.huggingface-shared-blobs'), '1\n');
  await put(join(hub, 'blobs', 'aa', S1), bytesOf('store-one', 2000));
  await put(join(hub, 'blobs', 'aa', S1 + '.refs'), `models--org--gguf/blobs/${B}\n`);
  await put(join(hub, 'blobs', 'bb', S2), bytesOf('store-two', 300));
  await put(join(hub, 'blobs', 'bb', S2 + '.refs'), `models--org--gguf/blobs/${D}\nmodels--org--other/blobs/${D}\n`);

  await put(join(gguf, 'refs', 'main'), c1);
  await put(join(gguf, 'blobs', A), bytesOf('blob-a', 1000));
  await ln(`../../blobs/aa/${S1}`, join(gguf, 'blobs', B));
  await put(join(gguf, 'blobs', C), bytesOf('blob-c', 500));
  await ln(`../../blobs/bb/${S2}`, join(gguf, 'blobs', D));
  await put(join(gguf, 'blobs', E), bytesOf('blob-e', 50));
  const snap1 = join(gguf, 'snapshots', c1);
  await ln(`../../blobs/${A}`, join(snap1, 'm-Q4_K_M.gguf'));
  await ln(`../../blobs/${B}`, join(snap1, 'm-Q8_0.gguf'));
  await ln(`../../../blobs/${C}`, join(snap1, 'sub', 'm-IQ2_XS.gguf'));
  await ln(`../../blobs/${D}`, join(snap1, 'mmproj-F16.gguf'));
  await ln(`../../blobs/${E}`, join(snap1, 'README.md'));

  await put(join(other, 'refs', 'main'), c2);
  await fs.mkdir(join(other, 'blobs'), { recursive: true });
  await fs.link(join(gguf, 'blobs', C), join(other, 'blobs', C));
  await ln(`../../blobs/bb/${S2}`, join(other, 'blobs', D));
  const snap2 = join(other, 'snapshots', c2);
  await ln(`../../blobs/${C}`, join(snap2, 'x-IQ2_XS.gguf'));
  await ln(`../../blobs/${D}`, join(snap2, 'mmproj-F16.gguf'));

  await ln(join(gguf, 'blobs', B), join(lmstudio, 'org', 'gguf', 'm-Q8_0.gguf'));
  await put(join(ollama, 'manifests', 'hf.co', 'org', 'gguf', 'Q8_0'), `{"layers":[{"digest":"sha256:${B}"}]}`);

  const now = Date.now();
  const appData = join(fx.root, 'app-data');
  await fs.mkdir(appData, { recursive: true });
  const lockDir = join(dirname(hub), '.hf-cache-manager');
  const safeFs = await SafeFs.create(fx.roots, fs);
  const views = triggeredViews(join(gguf, 'blobs', B), [
    { view: 'lmstudio', viewRoot: lmstudio, rel: 'org/gguf/m-Q8_0.gguf', role: 'view-link' },
    { view: 'ollama', viewRoot: ollama, rel: 'manifests/hf.co/org/gguf/Q8_0', role: 'view-manifest' },
  ], fs);
  const model = (): Promise<CacheModel> => scanHub(hub, fs);
  const execDeps = (hooks?: ExecHooks, dryRun?: boolean): ExecDeps => ({
    safeFs, fs, journal: new Journal(appData, () => now), lock: new AppLock(lockDir), rescan: model,
    now: () => now, diskFree: async () => 1e12, ...(hooks ? { hooks } : {}), ...(dryRun ? { dryRun } : {}),
  });
  return {
    root: fx.root, hub, lmstudio, ollama, roots: fx.roots, appData, now,
    viewRoots: { lmstudio, ollama }, views, model,
    keyFor: (m, repoId, kind, labelPart) => {
      const repo = m.repos.find((r) => r.id === repoId);
      if (!repo) throw new Error(`unknown repo ${repoId}`);
      const g = classifyRepo(repo).groups.find((x) => x.kind === kind && x.label.includes(labelPart));
      if (!g) throw new Error(`${repoId}: no ${kind} group labelled ~${labelPart}`);
      return g.key;
    },
    holdPlan: async (sel) => {
      const pair = await planDeletion({ model: await model(), selection: sel, roots: fx.roots, views, now });
      if (!pair.hold) throw new Error(`no hold plan: ${pair.holdUnavailableReason ?? '?'}`);
      return pair.hold;
    },
    execDeps,
    exec: (plan, hooks, dryRun) => executePlan(plan, execDeps(hooks, dryRun)),
    safeFs, fs,
  };
}

export function q8Iq2MmprojSelection(s: HoldScenario, m: CacheModel): Selection {
  return { repos: [{
    repoId: 'org/gguf', whole: false, unlockComponents: false,
    groupKeys: [s.keyFor(m, 'org/gguf', 'quant', 'Q8_0'), s.keyFor(m, 'org/gguf', 'quant', 'IQ2_XS'), s.keyFor(m, 'org/gguf', 'mmproj', '')],
  }] };
}

/**
 * The restore order, checked on the plan alone (a payload in the hub always has a valid reference or no .refs):
 * - no store-refs-add precedes the repo-blob / repo-folder rename that brings back a line it adds;
 * - a store-refs-add that creates `.refs` (expectRefsRaw null) comes after its payload's rename, if the plan has one;
 * - a store-refs-add into an existing, stale `.refs` comes before its payload's rename, and so does
 *   every rename bringing back a line that `.refs` already lists.
 */
export function assertR1(p: DeletionPlan): void {
  const restoredAt = (line: string): number => {
    const blob = join(p.hubRoot, ...line.split('/'));
    return p.ops.findIndex((o) => o.kind === 'restore-rename' && (o.dest === blob || blob.startsWith(o.dest + '/')));
  };
  p.ops.forEach((op, i) => {
    if (op.kind !== 'store-refs-add') return;
    // restoredAt -1 (the blob is not restored by this plan, e.g. it never left the hub) is fine: nothing to order
    for (const line of op.addRefs) expect(restoredAt(line), `${line} comes back after its refs line is written`).toBeLessThan(i);
    const payload = op.refsPath.slice(0, -'.refs'.length);
    const k = p.ops.findIndex((o) => o.kind === 'restore-rename' && o.dest === payload);
    if (op.expectRefsRaw === null) {
      expect(k, 'a payload whose .refs this plan creates moves before it').toBeLessThan(i);
    } else if (k !== -1) {
      expect(k, 'a payload with a stale .refs moves after its refs are added').toBeGreaterThan(i);
      for (const line of op.expectRefsRaw) expect(restoredAt(line), `${line} comes back before its payload`).toBeLessThan(k);
    }
  });
}
