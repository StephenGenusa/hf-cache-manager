import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlanError } from '../../../src/core/plan/closure';
import { fingerprintPlan, hashCanonical } from '../../../src/core/plan/fingerprint';
import {
  ACTIVE_WINDOW_MS, HOLD_UNAVAILABLE, assertNoActiveDownload, planCore, planDeletion,
} from '../../../src/core/plan/planner';
import { PlanRegistry } from '../../../src/core/plan/registry';
import type { CacheModel, FileFacts, Op, RepoSelection, SafeRoots, Selection, ViewImpactLine } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { snapshotTree } from '../support/observe';
import { buildTree, f, groupKeyFor, type RepoSpec, type Tree } from '../support/scenarios';
import { stubViews } from '../support/stub-views';

useCanaries();

const E = 'e'.repeat(64);
const lfacts: FileFacts = { dev: 1, ino: 9, size: 10, mtimeMs: 1, nlink: 1, isSymlink: true, isDirectory: false, isFile: false, linkTarget: '/x' };
const gguf = (id: string, incomplete?: RepoSpec['incomplete']): RepoSpec => ({
  id,
  snapshots: { c1: { 'm-Q4_K_M.gguf': f('blob', `Q4${id}`, 4000), 'm-Q8_0.gguf': f('blob', `Q8${id}`, 8000) } },
  ...(incomplete ? { incomplete } : {}),
});
const part = (m: CacheModel, id: string, rel = 'm-Q4_K_M.gguf'): RepoSelection =>
  ({ repoId: id, whole: false, groupKeys: [groupKeyFor(m, id, rel)], unlockComponents: false });
const whole = (repoId: string): RepoSelection => ({ repoId, whole: true });

async function setup(repos: RepoSpec[] = [gguf('o/a')]): Promise<{ t: Tree; m: CacheModel; viewUnlink: Op }> {
  const t = await buildTree({ repos });
  const m = await t.scan();
  const viewUnlink: Op = { kind: 'unlink', path: join(t.lmstudioRoot, 'o', 'a', 'm-Q4_K_M.gguf'), expect: lfacts, role: 'view-link' };
  return { t, m, viewUnlink };
}
const reason = async (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (e: unknown) => e);

describe('assertNoActiveDownload / inv8', () => {
  it('inv8: active .incomplete in a selected repo (age 5 min) → PlanError ACTIVE_DOWNLOAD naming the repo; 11 min → plans', async () => {
    const { t, m } = await setup([gguf('o/a', [{ etag: E, ageMs: 5 * 60_000 }])]);
    const selection: Selection = { repos: [part(m, 'o/a')] };
    const err = await reason(planDeletion({ model: m, selection, roots: t.roots, views: stubViews(), now: t.now }));
    expect(err).toBeInstanceOf(PlanError);
    expect(err).toMatchObject({ code: 'ACTIVE_DOWNLOAD', message: expect.stringContaining('o/a') });
    const pair = await planDeletion({ model: m, selection, roots: t.roots, views: stubViews(), now: t.now + 6 * 60_000 });
    expect(pair.permanent.ops.length).toBeGreaterThan(0);
  });
  it('covers whole-repo selections and partial ones, in both modes (the check is before either plan is built)', async () => {
    const { t, m } = await setup([gguf('o/a', [{ etag: E, ageMs: 60_000 }]), gguf('o/b')]);
    for (const r of [whole('o/a'), part(m, 'o/a')]) {
      const selection: Selection = { repos: [whole('o/b'), r] };
      expect(() => assertNoActiveDownload(m, selection, t.now)).toThrow(expect.objectContaining({ code: 'ACTIVE_DOWNLOAD' }));
      const views = stubViews();
      await expect(planDeletion({ model: m, selection, roots: t.roots, views, now: t.now })).rejects.toMatchObject({ code: 'ACTIVE_DOWNLOAD' });
      await expect(planDeletion({ model: m, selection, roots: { ...t.roots, holdRoot: null }, views, now: t.now }))
        .rejects.toMatchObject({ code: 'ACTIVE_DOWNLOAD' });
      expect(views.calls).toEqual([]);
    }
  });
  it('an active download in an unselected repo does not refuse; the window edge is exclusive', async () => {
    const { t, m } = await setup([gguf('o/a', [{ etag: E, ageMs: 60_000 }]), gguf('o/b')]);
    expect(() => assertNoActiveDownload(m, { repos: [whole('o/b')] }, t.now)).not.toThrow();
    const mtime = m.repos.find((r) => r.id === 'o/a')!.incomplete[0]!.mtimeMs;
    const sel: Selection = { repos: [whole('o/a')] };
    expect(() => assertNoActiveDownload(m, sel, mtime + ACTIVE_WINDOW_MS - 1)).toThrow(PlanError);
    expect(() => assertNoActiveDownload(m, sel, mtime + ACTIVE_WINDOW_MS)).not.toThrow();
    expect(() => assertNoActiveDownload(m, sel, mtime - 5_000)).toThrow(PlanError); // mtime in the future: active
  });
  it('fails closed on a .incomplete outside repo.incomplete (e.g. a symlink in otherFiles) and on an unknown repo', async () => {
    const { t, m } = await setup();
    const repo = m.repos[0]!;
    const odd: CacheModel = {
      ...m,
      repos: [{ ...repo, otherFiles: [...repo.otherFiles, { path: join(repo.folder, 'blobs', `${E}.incomplete`), facts: { ...lfacts, mtimeMs: t.now - 1000 } }] }],
    };
    expect(() => assertNoActiveDownload(odd, { repos: [whole('o/a')] }, t.now)).toThrow(expect.objectContaining({ code: 'ACTIVE_DOWNLOAD' }));
    expect(() => assertNoActiveDownload(m, { repos: [whole('o/zz')] }, t.now)).toThrow(expect.objectContaining({ code: 'UNKNOWN_REPO' }));
  });
});

describe('planDeletion', () => {
  it('contentDigest: both plans carry hashCanonical of the permanent-mode hub ops, inside the fingerprint', async () => {
    const { t, m } = await setup([gguf('o/a'), gguf('o/b')]);
    const selection: Selection = { repos: [whole('o/a')] };
    const pair = await planDeletion({ model: m, selection, roots: t.roots, views: stubViews(), now: t.now });
    const perm = planCore(m, selection, { mode: 'permanent', hubRoot: m.hubRoot, holdRoot: null, deletionId: null, now: t.now });
    expect(pair.permanent.contentDigest).toBe(hashCanonical(perm.ops));
    expect(pair.hold!.contentDigest).toBe(pair.permanent.contentDigest);
    expect(pair.hold!.ops).toHaveLength(1); // the whole-repo hold op alone could not show what is inside
    expect(fingerprintPlan({ ...pair.hold!, contentDigest: 'x' })).not.toBe(pair.hold!.fingerprint);
  });
  it('view ops come first in both plans and impactFor gets the doomed repo blob paths', async () => {
    const { t, m, viewUnlink } = await setup();
    const selection: Selection = { repos: [part(m, 'o/a')] };
    const views = stubViews({ ops: [viewUnlink], lines: [{ view: 'lmstudio', path: 'o/a/m-Q4_K_M.gguf', action: 'remove' }] });
    const pair = await planDeletion({ model: m, selection, roots: t.roots, views, now: t.now });
    expect(views.calls).toEqual([[t.blob('o/a', 'm-Q4_K_M.gguf')]]);
    expect(pair.permanent.ops[0]).toEqual(viewUnlink);
    expect(pair.hold!.ops[0]).toEqual(viewUnlink);
    expect(pair.permanent.viewImpact).toHaveLength(1);
    expect(pair.hold!.viewImpact).toEqual(pair.permanent.viewImpact);
    // the rest of each plan is exactly its planCore op list
    const core = planCore(m, selection, { mode: 'permanent', hubRoot: m.hubRoot, holdRoot: null, deletionId: null, now: t.now });
    expect(pair.permanent.ops.slice(1)).toEqual(core.ops);
    const hcore = planCore(m, selection, { mode: 'hold', hubRoot: m.hubRoot, holdRoot: t.roots.holdRoot, deletionId: pair.hold!.deletionId, now: t.now });
    expect(pair.hold!.ops.slice(1)).toEqual(hcore.ops);
  });
  it('a blocked view line adds a warning to both plans and does not refuse', async () => {
    const { t, m } = await setup();
    const views = stubViews({ lines: [{ view: 'lmstudio', path: '', action: 'blocked', note: 'hub folder is missing' }] });
    const pair = await planDeletion({ model: m, selection: { repos: [part(m, 'o/a')] }, roots: t.roots, views, now: t.now });
    expect(pair.permanent.warnings).toContain('LM Studio view not updated: hub folder is missing');
    expect(pair.hold!.warnings).toEqual(pair.permanent.warnings);
    expect(pair.permanent.viewImpact).toEqual([{ view: 'lmstudio', path: '', action: 'blocked', note: 'hub folder is missing' }]);
  });
  it('provider op at a relative or non-normalized path → throws naming the reason', async () => {
    const { t, m } = await setup();
    const selection: Selection = { repos: [part(m, 'o/a')] };
    for (const path of ['o/a/m.gguf', `${t.lmstudioRoot}/o/./a.gguf`]) {
      const op: Op = { kind: 'unlink', path, expect: lfacts, role: 'view-link' };
      const err = await reason(planDeletion({ model: m, selection, roots: t.roots, views: stubViews({ ops: [op] }), now: t.now }));
      expect((err as Error).message).toBe(`planDeletion: view op unlink ${path}: path is not a normalized absolute path`);
    }
  });

  it('provider op with a non-view role, kind or root → throws', async () => {
    const { t, m, viewUnlink } = await setup();
    const selection: Selection = { repos: [part(m, 'o/a')] };
    const hubLink = t.link('o/a', 'c1', 'm-Q8_0.gguf');
    const bad: Op[] = [
      { kind: 'unlink', path: hubLink, expect: lfacts, role: 'snapshot-link' },
      { kind: 'unlink', path: hubLink, expect: lfacts, role: 'view-link' },               // view role, hub path
      { ...viewUnlink, role: 'repo-blob' } as Op,
      { kind: 'hold-rename', path: (viewUnlink as { path: string }).path, dest: join(t.holdRoot, 'x'), expect: lfacts, role: 'view-link' },
      { kind: 'write-file', path: join(t.lmstudioRoot, '.hfhub-state.json'), before: null, after: '{}', role: 'hold-manifest' },
      { kind: 'write-file', path: join(t.hub, 'state.json'), before: null, after: '{}', role: 'view-state' },
      { kind: 'rmdir-empty', path: t.lmstudioRoot },                                         // the view root itself
      { kind: 'rmdir-empty', path: t.folder('o/a') },
      { kind: 'store-sweep', storePath: '/s', refsPath: '/s.refs', removeRefs: [], expectRefsRaw: [], payload: 'keep', expect: lfacts },
      { kind: 'unlink', path: join(t.lmstudioRoot, '..', 'escape'), expect: lfacts, role: 'view-link' },
    ];
    for (const op of bad) {
      const err = await reason(planDeletion({ model: m, selection, roots: t.roots, views: stubViews({ ops: [op] }), now: t.now }));
      expect(err, JSON.stringify(op)).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PlanError);
      expect((err as Error).message).toMatch(/view op/);
    }
    const ok: Op[] = [
      viewUnlink,
      { kind: 'rmdir-empty', path: join(t.lmstudioRoot, 'o', 'a') },
      { kind: 'write-file', path: join(t.lmstudioRoot, '.hfhub-state.json'), before: null, after: '{}', role: 'view-state' },
    ];
    const pair = await planDeletion({ model: m, selection, roots: t.roots, views: stubViews({ ops: ok }), now: t.now });
    expect(pair.permanent.ops.slice(0, 3)).toEqual(ok);
  });
  it('ids and timing', async () => {
    const { t, m } = await setup();
    const selection: Selection = { repos: [part(m, 'o/a')] };
    const pair = await planDeletion({ model: m, selection, roots: t.roots, views: stubViews(), now: t.now });
    expect(pair.permanent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(pair.hold!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(pair.hold!.id).not.toBe(pair.permanent.id);
    expect(pair.hold!.deletionId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/);
    expect(pair.hold!.deletionId!.slice(0, 24)).toBe(new Date(t.now).toISOString().replace(/[:.]/g, '-'));
    expect(pair.permanent.deletionId).toBeNull();
    for (const p of [pair.permanent, pair.hold!]) {
      expect(p.expiresAt).toBe(t.now + 600_000);
      expect(p.createdAt).toBe(t.now);
      expect(p.fingerprint).toBe(fingerprintPlan(p));
      expect(p.purpose).toBe('delete');
      expect(p.selection).toEqual(selection);
      expect(p.hubRoot).toBe(m.hubRoot);
    }
    expect([pair.permanent.mode, pair.hold!.mode]).toEqual(['permanent', 'hold']);
    expect([pair.permanent.holdRoot, pair.hold!.holdRoot]).toEqual([null, t.roots.holdRoot]);
    expect(pair.holdUnavailableReason).toBeNull();
    const again = await planDeletion({ model: m, selection, roots: t.roots, views: stubViews(), now: t.now });
    expect(again.hold!.deletionId).not.toBe(pair.hold!.deletionId);
    expect(again.permanent.id).not.toBe(pair.permanent.id);
  });
  it('the plan selection is a copy: mutating the caller selection afterwards does not change the plan', async () => {
    const { t, m } = await setup();
    const selection: Selection = { repos: [part(m, 'o/a')] };
    const pair = await planDeletion({ model: m, selection, roots: t.roots, views: stubViews(), now: t.now });
    selection.repos.push(whole('o/b'));
    expect(pair.permanent.selection!.repos).toHaveLength(1);
    expect(pair.permanent.fingerprint).toBe(fingerprintPlan(pair.permanent));
  });
  it('confirmPhrase: single repo → repo id; two repos → "delete 2 repos"; hold → null', async () => {
    const { t, m } = await setup([gguf('o/a'), gguf('o/b')]);
    const one = await planDeletion({ model: m, selection: { repos: [whole('o/a')] }, roots: t.roots, views: stubViews(), now: t.now });
    expect(one.permanent.confirmPhrase).toBe('o/a');
    expect(one.hold!.confirmPhrase).toBeNull();
    const two = await planDeletion({ model: m, selection: { repos: [whole('o/a'), part(m, 'o/b')] }, roots: t.roots, views: stubViews(), now: t.now });
    expect(two.permanent.confirmPhrase).toBe('delete 2 repos');
    expect(two.hold!.confirmPhrase).toBeNull();
  });
  it('hold plan is null with a reason when holdRoot is null', async () => {
    const { t, m } = await setup();
    const roots: SafeRoots = { ...t.roots, holdRoot: null };
    const views = stubViews();
    const pair = await planDeletion({ model: m, selection: { repos: [part(m, 'o/a')] }, roots, views, now: t.now });
    expect(pair.hold).toBeNull();
    expect(pair.holdUnavailableReason).toBe(HOLD_UNAVAILABLE);
    expect(pair.permanent.mode).toBe('permanent');
    expect(pair.permanent.ops.length).toBeGreaterThan(0);
    expect(views.calls).toHaveLength(1);
  });
  it('a holdRoot that is not this hub\'s Recently Deleted folder → no hold plan, permanent still offered', async () => {
    const { t, m } = await setup();
    const roots: SafeRoots = { ...t.roots, holdRoot: join(t.root, 'elsewhere', 'recently-deleted') };
    const pair = await planDeletion({ model: m, selection: { repos: [part(m, 'o/a')] }, roots, views: stubViews(), now: t.now });
    expect(pair.hold).toBeNull();
    expect(pair.holdUnavailableReason).toBe(HOLD_UNAVAILABLE);
    expect(pair.permanent.ops.length).toBeGreaterThan(0);
  });
  it('roots.hubRoot must be the scanned hub', async () => {
    const { t, m } = await setup();
    const roots: SafeRoots = { ...t.roots, hubRoot: join(t.root, 'other-hub') };
    await expect(planDeletion({ model: m, selection: { repos: [whole('o/a')] }, roots, views: stubViews(), now: t.now }))
      .rejects.toThrow(/hubRoot/);
  });
  it('warnings and kept are identical in both plans (and freed, apparentBytes)', async () => {
    const { t, m } = await setup([gguf('o/a'), gguf('o/b')]);
    const selection: Selection = { repos: [part(m, 'o/a'), whole('o/b')] };
    const views = stubViews({ lines: [{ view: 'ollama', path: 'x', action: 'blocked' }] });
    const pair = await planDeletion({ model: m, selection, roots: t.roots, views, now: t.now });
    const h = pair.hold!; const p = pair.permanent;
    expect(p.kept.length).toBeGreaterThan(0);
    expect(p.warnings.length).toBeGreaterThan(0);
    expect(h.kept).toEqual(p.kept);
    expect(h.warnings).toEqual(p.warnings);
    expect(h.freed).toEqual(p.freed);
    expect(h.apparentBytes).toBe(p.apparentBytes);
    expect(h.viewImpact).toEqual(p.viewImpact);
  });
  it('planning is read-only: the hub, hold root and views are byte-identical afterwards', async () => {
    const { t, m } = await setup();
    const before = await snapshotTree(t.root);
    await planDeletion({ model: m, selection: { repos: [whole('o/a')] }, roots: t.roots, views: stubViews(), now: t.now });
    expect(await snapshotTree(t.root)).toEqual(before);
  });
  it('PlanError from closure (unknown repo) propagates; nothing is registered', async () => {
    const { t, m } = await setup();
    const registry = new PlanRegistry();
    await expect(planDeletion({ model: m, selection: { repos: [whole('o/zz')] }, roots: t.roots, views: stubViews(), now: t.now, registry }))
      .rejects.toMatchObject({ code: 'UNKNOWN_REPO' });
  });
  it('with a registry, both plans are registered as a pair: taking one uses up the other', async () => {
    const { t, m } = await setup();
    const registry = new PlanRegistry();
    const pair = await planDeletion({ model: m, selection: { repos: [whole('o/a')] }, roots: t.roots, views: stubViews(), now: t.now, registry });
    expect(registry.take(pair.hold!.id, pair.hold!.fingerprint, t.now)).toBe(pair.hold);
    expect(() => registry.take(pair.permanent.id, pair.permanent.fingerprint, t.now, 'o/a'))
      .toThrow(expect.objectContaining({ code: 'USED' }));
    // without a registry nothing is registered anywhere (preview)
    const preview = await planDeletion({ model: m, selection: { repos: [whole('o/a')] }, roots: t.roots, views: stubViews(), now: t.now });
    expect(() => registry.take(preview.permanent.id, preview.permanent.fingerprint, t.now, 'o/a'))
      .toThrow(expect.objectContaining({ code: 'UNKNOWN_PLAN' }));
  });
});

describe('fail-closed hardening', () => {
  it('assertNoActiveDownload: a NaN or missing mtime counts as active', async () => {
    const { t, m } = await setup();
    const repo = m.repos[0]!;
    const sel: Selection = { repos: [whole('o/a')] };
    const nanInc: CacheModel = { ...m, repos: [{ ...repo, incomplete: [{ path: join(repo.folder, 'blobs', `${E}.incomplete`), size: 1, mtimeMs: Number.NaN }] }] };
    expect(() => assertNoActiveDownload(nanInc, sel, t.now)).toThrow(expect.objectContaining({ code: 'ACTIVE_DOWNLOAD' }));
    const noMtime = { ...lfacts } as Partial<FileFacts>;
    delete noMtime.mtimeMs;
    const undefOther: CacheModel = {
      ...m, repos: [{ ...repo, otherFiles: [...repo.otherFiles, { path: join(repo.folder, 'x.incomplete'), facts: noMtime as FileFacts }] }],
    };
    expect(() => assertNoActiveDownload(undefOther, sel, t.now)).toThrow(expect.objectContaining({ code: 'ACTIVE_DOWNLOAD' }));
    const oldInc: CacheModel = { ...m, repos: [{ ...repo, incomplete: [{ path: join(repo.folder, 'blobs', `${E}.incomplete`), size: 1, mtimeMs: t.now - 3_600_000 }] }] };
    expect(() => assertNoActiveDownload(oldInc, sel, t.now)).not.toThrow();
    expect(() => assertNoActiveDownload(oldInc, sel, Number.NaN)).toThrow(expect.objectContaining({ code: 'ACTIVE_DOWNLOAD' })); // unknown now
  });
  it('malformed selections give INVALID_SELECTION before the active-download check (non-array repos, non-string repoId)', async () => {
    const { t, m } = await setup([gguf('o/a', [{ etag: E, ageMs: 60_000 }])]);
    const bad = [
      { repos: 'o/a' }, { repos: { 0: whole('o/a') } }, null, { repos: [{ repoId: 7, whole: true }] }, { repos: [{ repoId: null, whole: true }] },
      { repos: [] },
    ] as unknown as Selection[];
    for (const selection of bad) {
      expect(() => assertNoActiveDownload(m, selection, t.now), JSON.stringify(selection)).toThrow(expect.objectContaining({ code: 'INVALID_SELECTION' }));
      const views = stubViews();
      await expect(planDeletion({ model: m, selection, roots: t.roots, views, now: t.now }), JSON.stringify(selection))
        .rejects.toMatchObject({ name: 'PlanError', code: 'INVALID_SELECTION' });
      expect(views.calls).toEqual([]);
    }
  });
  it('view ops inside <dirname(hub)>/.hf-cache-manager are refused even when holdRoot is null or foreign', async () => {
    const { t, m } = await setup();
    const mgr = join(dirname(m.hubRoot), '.hf-cache-manager');
    const selection: Selection = { repos: [part(m, 'o/a')] };
    const ops: Op[] = [
      { kind: 'unlink', path: join(mgr, 'app.lock'), expect: lfacts, role: 'view-link' },
      { kind: 'unlink', path: join(mgr, 'recently-deleted', 'x'), expect: lfacts, role: 'view-blob' },
      { kind: 'rmdir-empty', path: mgr },
      { kind: 'write-file', path: join(mgr, 'state.json'), before: null, after: '{}', role: 'view-state' },
    ];
    for (const holdRoot of [null, join(t.root, 'elsewhere', 'recently-deleted')]) {
      const roots: SafeRoots = { ...t.roots, viewRoots: [t.root], holdRoot }; // a view root that is an ancestor of dirname(hub)
      for (const op of ops) {
        await expect(planDeletion({ model: m, selection, roots, views: stubViews({ ops: [op] }), now: t.now }), JSON.stringify(op))
          .rejects.toThrow(/view op .*inside .*\.hf-cache-manager/);
      }
      // a sibling path under the same view root is still fine
      const okOp: Op = { kind: 'unlink', path: join(t.root, 'views-elsewhere', 'l'), expect: lfacts, role: 'view-link' };
      await expect(planDeletion({ model: m, selection, roots, views: stubViews({ ops: [okOp] }), now: t.now })).resolves.toBeDefined();
    }
  });
  it('a view op after rmdir-empty of its dir (or the dir itself again) is refused', async () => {
    const { t, m, viewUnlink } = await setup();
    const selection: Selection = { repos: [part(m, 'o/a')] };
    const dirA = join(t.lmstudioRoot, 'o', 'a');
    const cases: Op[][] = [
      [{ kind: 'rmdir-empty', path: dirA }, viewUnlink],
      [{ kind: 'rmdir-empty', path: join(t.lmstudioRoot, 'o') }, { kind: 'rmdir-empty', path: dirA }],
      [{ kind: 'rmdir-empty', path: dirA }, { kind: 'rmdir-empty', path: dirA }],
      [{ kind: 'rmdir-empty', path: dirA }, { kind: 'write-file', path: join(dirA, 's.json'), before: null, after: '{}', role: 'view-state' }],
    ];
    for (const ops of cases) {
      await expect(planDeletion({ model: m, selection, roots: t.roots, views: stubViews({ ops }), now: t.now }), JSON.stringify(ops))
        .rejects.toThrow(/view op .*(after rmdir-empty|deepest first)/);
    }
  });
  it('view rmdir-empty ops must be deepest first within a view root; separate view roots are ordered independently', async () => {
    const { t, m, viewUnlink } = await setup();
    const selection: Selection = { repos: [part(m, 'o/a')] };
    const lm = t.lmstudioRoot;
    const shallowThenDeep: Op[] = [{ kind: 'rmdir-empty', path: join(lm, 'p') }, { kind: 'rmdir-empty', path: join(lm, 'q', 'r') }];
    await expect(planDeletion({ model: m, selection, roots: t.roots, views: stubViews({ ops: shallowThenDeep }), now: t.now }))
      .rejects.toThrow(/deepest first/);
    const other = join(t.root, 'ollama-view');
    const roots: SafeRoots = { ...t.roots, viewRoots: [...t.roots.viewRoots, other] };
    const good: Op[] = [
      viewUnlink,
      { kind: 'rmdir-empty', path: join(lm, 'o', 'a') }, { kind: 'rmdir-empty', path: join(lm, 'o') },
      { kind: 'rmdir-empty', path: join(other, 'manifests', 'hf.co', 'o', 'a') }, { kind: 'rmdir-empty', path: join(other, 'manifests') },
    ];
    const pair = await planDeletion({ model: m, selection, roots, views: stubViews({ ops: good }), now: t.now });
    expect(pair.permanent.ops.slice(0, good.length)).toEqual(good);
  });
});

describe('planDeletion: exact warnings and view-op rules (mutation gate)', () => {
  it('blocked lines: exact text with and without a path or note, for both views; other actions add no warning', async () => {
    const { t, m } = await setup();
    const lines: ViewImpactLine[] = [
      { view: 'lmstudio', path: 'o/a/m.gguf', action: 'blocked', note: 'busy' },
      { view: 'ollama', path: '', action: 'blocked' },
      { view: 'lmstudio', path: 'o/a/x.gguf', action: 'remove' },
      { view: 'ollama', path: 'm', action: 'keep-shared' },
    ];
    const pair = await planDeletion({ model: m, selection: { repos: [part(m, 'o/a')] }, roots: t.roots, views: stubViews({ lines }), now: t.now });
    expect(pair.permanent.warnings).toEqual(['LM Studio view not updated (o/a/m.gguf): busy', 'Ollama view not updated: blocked']);
  });

  it('view-op rules: exact refusals, and what is allowed (view-manifest unlinks, equal-depth rmdirs, deeper unlinks after shallower)', async () => {
    const { t, m, viewUnlink } = await setup();
    const selection: Selection = { repos: [part(m, 'o/a')] };
    const lm = t.lmstudioRoot;
    const plan = (ops: Op[]) => planDeletion({ model: m, selection, roots: t.roots, views: stubViews({ ops }), now: t.now });
    const sweepOp: Op = { kind: 'store-sweep', storePath: '/s', refsPath: '/s.refs', removeRefs: [], expectRefsRaw: [], payload: 'keep', expect: lfacts };
    expect((await reason(plan([sweepOp])) as Error).message)
      .toBe('planDeletion: view op store-sweep : only view unlinks, rmdir-empty and view-state writes may come from a view provider');
    const asState: Op = { ...viewUnlink, role: 'view-state' } as unknown as Op;
    expect((await reason(plan([asState])) as Error).message).toMatch(/only view unlinks, rmdir-empty and view-state writes/);
    const out = join(t.root, 'not-a-view', 'x');
    expect((await reason(plan([{ ...viewUnlink, path: out } as Op])) as Error).message)
      .toBe(`planDeletion: view op unlink ${out}: path is not strictly inside a view root`);
    const ok: Op[] = [
      { kind: 'unlink', path: join(lm, 'o', 'x.json'), expect: lfacts, role: 'view-manifest' },
      { kind: 'unlink', path: join(lm, 'o', 'a', 'b', 'deep.gguf'), expect: lfacts, role: 'view-link' },
      { kind: 'rmdir-empty', path: join(lm, 'o', 'a', 'b') },
      { kind: 'rmdir-empty', path: join(lm, 'o', 'c', 'd') },
    ];
    expect((await plan(ok)).permanent.ops.slice(0, ok.length)).toEqual(ok);
  });

  it('exact texts: unknown repo in the active-download check, and the hold-unavailable reason', async () => {
    const { t, m } = await setup();
    expect(() => assertNoActiveDownload(m, { repos: [whole('o/zz')] }, t.now)).toThrow('o/zz is not in the cache');
    expect(HOLD_UNAVAILABLE).toBe('Recently Deleted is not available for this cache');
  });
});
