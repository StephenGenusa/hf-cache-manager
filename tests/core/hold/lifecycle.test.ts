// The hold / restore / empty lifecycle through the plan registry and the real executor
// (test (c)). Outcomes are asserted on disk.
import { lstatSync, readdirSync } from 'node:fs';
import { readdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { executePlan } from '../../../src/core/exec/executor';
import { listHeld, planEmpty, planRestore, type HeldDeletion } from '../../../src/core/hold/held';
import { executeHold } from '../../../src/core/hold/manifest';
import { PlanRegistry } from '../../../src/core/plan/registry';
import { useCanaries } from '../../helpers/canary';
import { treeDigest } from '../../helpers/tree-digest';
import { buildHoldScenario, HEX, q8Iq2MmprojSelection, type HoldScenario } from './scenario';

useCanaries();

type OkDeletion = Extract<HeldDeletion, { ok: true }>;

/**
 * Bytes of every regular payload file under `dir`, counting each inode once (a disk-usage proxy that needs no statfs).
 * Bookkeeping files (`*.refs`, the manifest) are skipped: a hold moves payloads and only rewrites those.
 */
function usedBytes(dir: string, seen = new Set<string>()): number {
  let sum = 0;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isDirectory()) sum += usedBytes(p, seen);
    else if (st.isFile() && !n.endsWith('.refs') && n !== 'manifest.json' && !seen.has(`${st.dev}:${st.ino}`)) { seen.add(`${st.dev}:${st.ino}`); sum += st.size; }
  }
  return sum;
}
/** Hub plus hold root, each inode once across both. */
const totalUsed = (s: HoldScenario): number => {
  const seen = new Set<string>();
  return usedBytes(s.hub, seen) + usedBytes(s.roots.holdRoot!, seen);
};

async function holdIt(s: HoldScenario, sel?: Parameters<HoldScenario['holdPlan']>[0]) {
  const m = await s.model();
  const plan = await s.holdPlan(sel ?? q8Iq2MmprojSelection(s, m));
  const r = await executeHold(plan, s.execDeps(), { model: m, viewRoots: s.viewRoots, fs: s.fs });
  return { plan, r };
}
async function onlyHeld(s: HoldScenario): Promise<OkDeletion> {
  const d = (await listHeld(s.roots)).at(0)!;
  if (!d.ok) throw new Error(d.error);
  return d;
}

describe('Recently Deleted lifecycle', () => {
  test('hold reports 0 freed now and X held; empty then frees X (test (c))', async () => {
    const s = await buildHoldScenario();
    const before = totalUsed(s);
    const { plan, r } = await holdIt(s);
    expect(r).toMatchObject({ ok: true, heldBytes: plan.apparentBytes, freedBytesPlanned: 0 });
    expect(plan.apparentBytes).toBeGreaterThan(0);
    const afterHold = totalUsed(s);
    expect(afterHold).toBe(before);                                       // a hold frees nothing: payloads only moved
    const d = await onlyHeld(s);
    const manifestSize = lstatSync(join(d.dir, 'manifest.json')).size;
    const { plans, skipped } = await planEmpty([d], s.roots, s.now);
    expect(skipped).toEqual([]);
    expect(plans).toHaveLength(1);
    const e = await s.exec(plans[0]!);
    expect(e).toMatchObject({ ok: true, heldBytes: 0 });
    expect(afterHold - totalUsed(s) + manifestSize).toBe(plans[0]!.freed.bytes);   // payload delta plus the manifest
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
  });

  test('restore and empty plans go through the registry: single use, 10-minute expiry, fingerprint', async () => {
    const s = await buildHoldScenario();
    await holdIt(s);
    const d = await onlyHeld(s);
    const restore = await planRestore(d, await s.model(), s.roots, s.now);
    const empty = (await planEmpty([d], s.roots, s.now)).plans[0]!;
    for (const p of [restore, empty]) {
      expect(p.expiresAt - p.createdAt).toBe(600_000);
      const reg = new PlanRegistry();
      reg.put(p);
      expect(() => reg.take(p.id, 'x'.repeat(64), p.createdAt)).toThrow(expect.objectContaining({ code: 'FINGERPRINT' }));
      expect(() => reg.take(p.id, p.fingerprint, p.createdAt + 600_000)).toThrow(expect.objectContaining({ code: 'EXPIRED' }));
      expect(() => reg.take(p.id, p.fingerprint, p.createdAt + 599_999)).not.toThrow();
      expect(() => reg.take(p.id, p.fingerprint, p.createdAt)).toThrow(expect.objectContaining({ code: 'USED' }));
    }
  });

  test('a restore plan is refused as stale when a held file changes after review', async () => {
    const s = await buildHoldScenario();
    await holdIt(s);
    const d = await onlyHeld(s);
    const plan = await planRestore(d, await s.model(), s.roots, s.now);
    const link = d.manifest.items.find((i) => i.originalPath.endsWith('m-Q8_0.gguf'))!.heldPath;
    await unlink(link);
    await symlink('../../blobs/elsewhere', link);                       // a changed target
    const hub = await treeDigest(s.hub);
    const hold = await treeDigest(s.roots.holdRoot!);
    const r = await executePlan(plan, s.execDeps());
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE' } });
    expect(await treeDigest(s.hub)).toEqual(hub);
    expect(await treeDigest(s.roots.holdRoot!)).toEqual(hold);
  });

  test('an empty plan is refused as stale when a hardlink partner disappears after review', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const sel = { repos: [{ repoId: 'org/gguf', whole: false, unlockComponents: false,
      groupKeys: [s.keyFor(m, 'org/gguf', 'quant', 'IQ2_XS')] }] };
    await holdIt(s, sel);
    const d = await onlyHeld(s);
    const { plans } = await planEmpty([d], s.roots, s.now);
    await unlink(join(s.hub, 'models--org--other', 'blobs', HEX.C));   // nlink of <C> changes
    const hub = await treeDigest(s.hub);
    const hold = await treeDigest(s.roots.holdRoot!);
    const r = await s.exec(plans[0]!);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE' } });
    expect(await treeDigest(s.hub)).toEqual(hub);
    expect(await treeDigest(s.roots.holdRoot!)).toEqual(hold);
  });

  test('partial restore, then empty of the remainder, leaves the hold root empty', async () => {
    const s = await buildHoldScenario();
    await holdIt(s);
    const d = await onlyHeld(s);
    const blocker = join(s.hub, 'models--org--gguf', 'snapshots', HEX.c1, 'm-Q8_0.gguf');
    await symlink(`../../blobs/${HEX.B}`, blocker);                     // re-downloaded: conflicts with the held item
    const plan = await planRestore(d, await s.model(), s.roots, s.now);
    expect(await s.exec(plan)).toMatchObject({ ok: true });
    expect(await listHeld(s.roots)).toMatchObject([{ ok: true, heldCount: 1 }]);
    const rest = await onlyHeld(s);
    const { plans } = await planEmpty([rest], s.roots, s.now);
    expect(plans).toHaveLength(1);
    expect(await s.exec(plans[0]!)).toMatchObject({ ok: true });
    expect(await readdir(s.roots.holdRoot!)).toEqual([]);
  });
});
