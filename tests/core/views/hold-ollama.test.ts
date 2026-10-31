// Move to Recently Deleted works for an Ollama-synced model (the real impact provider; small regular
// config blobs are recorded in the hold manifest).
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadState } from '../../../src/core/compat/state';
import { Journal } from '../../../src/core/exec/journal';
import { AppLock } from '../../../src/core/exec/lock';
import { executeHold, manifestFromPlan } from '../../../src/core/hold/manifest';
import { holdRootFor } from '../../../src/core/hold/hold-root';
import { planDeletion } from '../../../src/core/plan/planner';
import { SafeFs } from '../../../src/core/safe-fs';
import { scanHub } from '../../../src/core/scan/scanner';
import { executeSync, planSync } from '../../../src/core/sync/sync';
import { createViewImpactProvider } from '../../../src/core/views/impact';
import { useCanaries } from '../../helpers/canary';
import { fakeFetch, ggufBytes, loadCase, sha256Hex, type CaseSpec } from './_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const R = 'acme/Tiny-GGUF';
const K = `${R}:Tiny-Q4_K_M.gguf`;
const G15 = { arch: 'llama', fileType: 15, tensors: [[4, 4]] };
const q4 = sha256Hex(ggufBytes(G15));
const NOW = new Date(2026, 9, 25, 14, 3, 7);
const spec: CaseSpec = {
  repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [{ path: 'Tiny-Q4_K_M.gguf', gguf: G15 }] }] }],
  views: ['ollama'],
};

describe('Recently Deleted for an Ollama-synced model', () => {
  it('a whole-repo hold plan is offered, records the config blob bytes and executes', async () => {
    const lc = await loadCase(spec);
    const plan = await planSync(lc.config, lc.model, { offline: false, now: NOW.getTime() });
    await executeSync(plan, {
      safeFs: lc.safeFs, fs: lc.fs, fetch: fakeFetch({ status: 404 }), allowMassRemoval: false, token: null,
      now: () => NOW, lock: new AppLock(path.join(lc.c.dir, 'sync-lock')),
    });
    const hub = lc.model.hubRoot;
    const ol = realpathSync(lc.c.ollama!);
    const holdRoot = holdRootFor(hub);
    mkdirSync(holdRoot, { recursive: true });
    const roots = { hubRoot: hub, viewRoots: [ol], holdRoot };
    const safeFs = await SafeFs.create(roots, lc.fs);
    const cfgRel = (await loadState(ol)).state.owned[K]!.paths.find((p) => p.startsWith('blobs/') && p !== `blobs/sha256-${q4}`)!;
    const cfgBytes = readFileSync(path.join(ol, cfgRel));

    const provider = createViewImpactProvider(lc.config, lc.fs);
    const pair = await planDeletion({
      model: lc.model, selection: { repos: [{ repoId: R, whole: true }] }, roots, views: provider, now: NOW.getTime(),
    });
    expect(pair.holdUnavailableReason).toBeNull();
    const hold = pair.hold!;
    expect(hold.ops.some((o) => o.kind === 'unlink' && o.role === 'view-blob' && o.path === path.join(ol, cfgRel))).toBe(true);

    const m = await manifestFromPlan(hold, { model: lc.model, viewRoots: { ollama: ol }, fs: lc.fs, now: NOW.getTime() });
    const rec = m.viewEntriesRemoved.find((e) => e.path === cfgRel)!;
    expect(rec).toEqual({ view: 'ollama', path: cfgRel, contentBase64: cfgBytes.toString('base64'), done: false });
    expect(m.viewEntriesRemoved.find((e) => e.path === `blobs/sha256-${q4}`)?.contentBase64).toBeUndefined();   // the model blob is a symlink

    mkdirSync(path.join(lc.c.dir, 'journal'));
    const res = await executeHold(hold, {
      safeFs, fs: lc.fs, journal: new Journal(path.join(lc.c.dir, 'journal'), () => NOW.getTime()),
      lock: new AppLock(path.join(lc.c.dir, 'exec-lock')), rescan: () => scanHub(hub), now: () => NOW.getTime(),
      diskFree: async () => 1e12,
    }, { model: lc.model, viewRoots: { ollama: ol }, fs: lc.fs });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(() => readFileSync(path.join(ol, cfgRel))).toThrow();
  });
});
