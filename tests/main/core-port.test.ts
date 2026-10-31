import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import type { HfhubConfig } from '../../src/core/compat/config';
import { Journal } from '../../src/core/exec/journal';
import { HeldError } from '../../src/core/hold/held';
import { holdRootFor } from '../../src/core/hold/hold-root';
import { TOO_MANY_FILES } from '../../src/core/hold/manifest';
import { HOLD_UNAVAILABLE } from '../../src/core/plan/planner';
import { SafeFs } from '../../src/core/safe-fs';
import type { CacheModel, Op, PlanPair, Selection } from '../../src/core/types';
import { VIEW_ROOTS_OVERLAP } from '../../src/core/views/view-path';
import {
  createCorePort, holdMatchesPermanent, HOLD_PARITY_REASON, offlineFetch, type CorePort, type CorePortOptions, type PortRoots,
} from '../../src/main/core-port';
import { inProcessScanRunner } from '../../src/main/scan-client';
import { buildAppFixture, type AppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';
import { failingFs } from '../helpers/failing-fs';
import { guardedFs } from '../helpers/guarded-fs';
import { fakeFetch, ggufBytes, loadCase } from '../core/views/_case';
import { planDeletion as corePlanDeletion } from '../../src/core/plan/planner';
import { treeDigest } from '../helpers/tree-digest';

useCanaries();
beforeEach(() => expect.hasAssertions());

const Q = 'unsloth/Qwen3.6-27B-GGUF';
const FLUX = 'black-forest-labs/FLUX.1-dev';
const q8: Selection = { repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q8_0'], unlockComponents: false }] };

function portFor(fx: AppFixture, extra: Partial<CorePortOptions> = {}): CorePort {
  return createCorePort({
    userDataDir: fx.userDataDir, env: fx.env, home: fx.home, offline: true,
    makeSafeFs: (roots) => SafeFs.create(roots, guardedFs()), ...extra,
  });
}
const scan = async (hub: string): Promise<CacheModel> =>
  (await inProcessScanRunner(hub, () => undefined, new AbortController().signal)).model;

async function setup(extra: Partial<CorePortOptions> = {}, fxIn?: AppFixture) {
  const fx = fxIn ?? await buildAppFixture();
  const port = portFor(fx, extra);
  const hub = await port.resolveHub();
  const loaded = await port.loadConfig();
  if (!loaded.ok) throw new Error(loaded.error);
  const config: HfhubConfig = loaded.config;
  const model = await scan(hub.hubRoot);
  const r: PortRoots = await port.roots(hub.hubRoot, config);
  return { fx, port, hub, config, model, r };
}

test('resolveHub realpaths the hub once; a hub it cannot use is never present and says why', async () => {
  const fx = await buildAppFixture();
  const link = join(fx.root, 'hub-link');
  await symlink(fx.hubRoot, link);
  const port = (hub: string, extra: Partial<CorePortOptions> = {}) => portFor({ ...fx, env: { ...fx.env, HF_HUB_CACHE: hub } }, extra);
  expect(await port(link).resolveHub()).toEqual({ hubRoot: fx.hubRoot, present: true });
  const missing = join(fx.root, 'nope');
  expect(await port(missing).resolveHub()).toEqual({ hubRoot: missing, present: false,
    problem: { kind: 'missing', message: `Cache not found at ${missing}` } });
  expect(await port(join(fx.configFile, 'hub')).resolveHub()).toMatchObject({ present: false, problem: { kind: 'missing' } }); // ENOTDIR
  expect(await port(fx.configFile).resolveHub()).toEqual({ hubRoot: fx.configFile, present: false,
    problem: { kind: 'not-a-folder', message: `Cache not found at ${fx.configFile} (not a folder).` } });
  const denied = await port(fx.hubRoot, { fs: failingFs(guardedFs(), 'stat', 'EACCES', (p) => p === fx.hubRoot) }).resolveHub();
  expect(denied).toMatchObject({ hubRoot: fx.hubRoot, present: false, problem: { kind: 'no-access' } });
  expect(denied.present ? '' : denied.problem.message).toBe(`The cache at ${fx.hubRoot} cannot be read (EACCES).`);
  const loop = join(fx.root, 'loop');
  await symlink(loop, loop);
  const other = await port(loop).resolveHub();
  expect(other).toMatchObject({ hubRoot: loop, present: false, problem: { kind: 'other' } });
  expect(other.present ? '' : other.problem.message).toMatch(new RegExp(`^The cache at ${loop} could not be opened: .*ELOOP`));
  // realpath failing after a good stat is reported the same way, never as present
  const rp = await port(fx.hubRoot, { fs: failingFs(guardedFs(), 'realpath', 'EPERM', (p) => p === fx.hubRoot) }).resolveHub();
  expect(rp).toMatchObject({ present: false, problem: { kind: 'no-access' } });
});

test('loadConfig: the parsed config, or the error and path when config.toml cannot be read', async () => {
  const fx = await buildAppFixture();
  const ok = await portFor(fx).loadConfig();
  expect(ok).toMatchObject({ ok: true, config: { path: fx.configFile, exists: true, views: { lmstudio: { root: fx.lmstudioRoot } } } });
  await writeFile(fx.configFile, '[views.lmstudio\nroot = 3\n');
  const bad = await portFor(fx).loadConfig();
  expect(bad).toMatchObject({ ok: false, path: fx.configFile });
  expect(bad.ok ? '' : bad.error).not.toBe('');
  await writeFile(fx.configFile, '[views.lmstudio]\nroot = 3\n');
  expect(await portFor(fx).loadConfig()).toEqual({ ok: false, path: fx.configFile, error: 'views.lmstudio.root must be a string' });
  // an unreadable file (here: a directory) also fails closed instead of throwing
  const dir = join(fx.root, 'cfgdir');
  await mkdir(dir);
  const asDir = await portFor({ ...fx, env: { ...fx.env, HFHUB_CONFIG: dir } }).loadConfig();
  expect(asDir).toMatchObject({ ok: false, path: dir });
});

test('roots: realpath view roots, the canonical hold root, model and roots agree (carries 7, 8, 21, 25)', async () => {
  const { r, model, hub, fx } = await setup();
  expect(model.hubRoot).toBe(hub.hubRoot);
  expect(r.roots.hubRoot).toBe(hub.hubRoot);
  expect(r.roots.holdRoot).toBe(holdRootFor(hub.hubRoot));
  expect(r.roots.viewRoots).toEqual([fx.lmstudioRoot]);
  expect(r.viewRoots).toEqual({ lmstudio: fx.lmstudioRoot });
  expect(r.holdUnavailableReason).toBeNull();
  expect(r.safeFs.roots).toEqual(r.roots);
});

test('roots: no config means no view roots; a missing view root is left out', async () => {
  const fx = await buildAppFixture();
  const port = portFor(fx);
  const hub = await port.resolveHub();
  expect((await port.roots(hub.hubRoot, null)).roots.viewRoots).toEqual([]);
  const cfg: HfhubConfig = { path: fx.configFile, exists: true, views: {
    lmstudio: { root: join(fx.root, 'no-such'), aliases: {} }, ollama: { root: null, aliases: {} } } };
  const r = await port.roots(hub.hubRoot, cfg);
  expect(r.roots.viewRoots).toEqual([]);
  expect(r.viewRoots).toEqual({});
});

test('roots and planDeletion: a symlinked hold folder disables hold with holdAvailability\'s reason', async () => {
  const fx = await buildAppFixture();
  const mgr = join(dirname(fx.hubRoot), '.hf-cache-manager');
  const elsewhere = join(fx.root, 'mgr-elsewhere');
  await mkdir(elsewhere);
  await symlink(elsewhere, mgr); // the fixture does not create .hf-cache-manager
  const { port, model, r, config } = await setup({}, fx);
  expect(r.roots.holdRoot).toBeNull();
  expect(r.holdUnavailableReason).not.toBeNull();
  expect(r.holdUnavailableReason).not.toBe(HOLD_UNAVAILABLE);
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  expect(pair.hold).toBeNull();
  expect(pair.holdUnavailableReason).toBe(r.holdUnavailableReason);
});

test('planDeletion: both plans, nothing written, the view impact planned against the configured views', async () => {
  const { port, model, r, config, fx } = await setup();
  const before = await treeDigest(fx.root);
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  expect(pair.hold).not.toBeNull();
  expect(pair.holdUnavailableReason).toBeNull();
  expect(pair.permanent.viewImpact.some((l) => l.action === 'remove' && l.path === `${Q}/Qwen3.6-27B-Q8_0.gguf`)).toBe(true);
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('planDeletion refuses hold before confirm when its manifest would be too large (carries 27, 29)', async () => {
  const { port, model, r, config } = await setup({ maxManifestBytes: 64 * 1024 + 10 });
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  expect(pair.hold).toBeNull();
  expect(pair.holdUnavailableReason).toBe(TOO_MANY_FILES);
  expect(pair.permanent.mode).toBe('permanent');
});

test('holdManifestProblem: null for a buildable hold, the builder\'s message when it refuses (U2)', async () => {
  const { port, model, r, config } = await setup();
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  expect(await port.holdManifestProblem(pair.hold!, model, r, Date.now())).toBeNull();
  expect(await port.holdManifestProblem(pair.permanent, model, r, Date.now())).toBe('not a hold plan');
});

test('holdMatchesPermanent holds for every real pair', async () => {
  const { port, model, r, config } = await setup();
  const sels: Selection[] = [
    q8,
    { repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q8_0', 'quant:BF16', 'quant:Q6_K'], unlockComponents: false }] },
    { repos: [{ repoId: Q, whole: true }] },
    { repos: [{ repoId: FLUX, whole: true }] },
    { repos: [{ repoId: FLUX, whole: false, groupKeys: ['component:vae/'], unlockComponents: true }] },
    { repos: [{ repoId: 'org/shared-a', whole: true }] },
    { repos: [{ repoId: 'org/shared-a', whole: true }, { repoId: 'org/shared-b', whole: true }] },
  ];
  for (const s of sels) {
    const pair = await port.planDeletion(model, s, r, config, Date.now());
    expect(pair.hold, JSON.stringify(s)).not.toBeNull();
    expect(holdMatchesPermanent(pair, model), JSON.stringify(s)).toBe(true);
  }
});

test('holdMatchesPermanent refuses pairs whose hold would move other files', async () => {
  const { port, model, r, config } = await setup();
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  const hold = pair.hold!;
  const drop = (ops: Op[], i: number): Op[] => ops.filter((_, k) => k !== i);
  const renameAt = hold.ops.findIndex((o) => o.kind === 'hold-rename');
  expect(holdMatchesPermanent({ ...pair, hold: { ...hold, ops: drop(hold.ops, renameAt) } }, model)).toBe(false);
  const renameOp = hold.ops[renameAt] as Extract<Op, { kind: 'hold-rename' }>;
  const extra: Op = { kind: 'unlink', path: join(model.hubRoot, 'x'), expect: renameOp.expect, role: 'repo-blob' };
  expect(holdMatchesPermanent({ ...pair, hold: { ...hold, ops: [...hold.ops, extra] } }, model)).toBe(false);
  // a folder rename is accepted only for a repo selected whole
  const whole = await port.planDeletion(model, { repos: [{ repoId: Q, whole: true }] }, r, config, Date.now());
  const partialSel: PlanPair = { ...whole, hold: { ...whole.hold!, selection: q8 } };
  expect(holdMatchesPermanent(partialSel, model)).toBe(false);
  expect(holdMatchesPermanent({ ...pair, hold: null }, model)).toBe(false);
  // a whole-repo hold must still cover every permanent path outside its folder
  const perm = { ...whole.permanent, ops: [...whole.permanent.ops, extra] };
  expect(holdMatchesPermanent({ ...whole, permanent: perm }, model)).toBe(false);
  expect(HOLD_PARITY_REASON).toBe('Recently Deleted would not move exactly the reviewed files, so only Delete Permanently is offered.');
});

test('a folder rename needs the permanent plan to remove every path the model lists for that repo', async () => {
  const { port, model, r, config } = await setup();
  const whole = await port.planDeletion(model, { repos: [{ repoId: Q, whole: true }] }, r, config, Date.now());
  expect(holdMatchesPermanent(whole, model)).toBe(true);
  const repo = model.repos.find((x) => x.id === Q)!;
  const folder = repo.folder;
  const inFolder = (o: Op): boolean => 'path' in o && (o.path === folder || o.path.startsWith(folder + '/'));
  const without = (drop: (o: Op) => boolean): PlanPair => ({ ...whole, permanent: { ...whole.permanent, ops: whole.permanent.ops.filter((o) => !drop(o)) } });
  // every file still removed, only the folder rmdir missing: covered
  expect(holdMatchesPermanent(without((o) => o.kind === 'rmdir-empty' && o.path === folder), model)).toBe(true);
  // an rmdir-empty of the folder alone is not enough
  expect(holdMatchesPermanent(without((o) => inFolder(o) && !(o.kind === 'rmdir-empty' && o.path === folder)), model)).toBe(false);
  // nothing in the folder at all
  expect(holdMatchesPermanent(without(inFolder), model)).toBe(false);
  // one repo blob, one snapshot link, one other file (refs/main) missing
  const blob = Object.values(repo.blobs)[0]!.path;
  expect(holdMatchesPermanent(without((o) => o.kind === 'unlink' && o.path === blob), model)).toBe(false);
  const link = repo.files[0]!.linkPath;
  expect(holdMatchesPermanent(without((o) => o.kind === 'unlink' && o.path === link), model)).toBe(false);
  const refsMain = repo.otherFiles.find((o) => o.path.endsWith('/refs/main'))!.path;
  expect(holdMatchesPermanent(without((o) => o.kind === 'unlink' && o.path === refsMain), model)).toBe(false);
  // an .incomplete file of the repo missing
  const partial = await port.planDeletion(model, { repos: [{ repoId: 'org/partial', whole: true }] }, r, config, Date.now());
  expect(holdMatchesPermanent(partial, model)).toBe(true);
  const inc = model.repos.find((x) => x.id === 'org/partial')!.incomplete[0]!.path;
  expect(holdMatchesPermanent({ ...partial, permanent: { ...partial.permanent,
    ops: partial.permanent.ops.filter((o) => !(o.kind === 'unlink' && o.path === inc)) } }, model)).toBe(false);
});

test('port.planDeletion drops a hold that fails parity, with HOLD_PARITY_REASON', async () => {
  const tamper: CorePortOptions['testPlanner'] = async (args) => {
    const pair = await corePlanDeletion(args);
    const i = pair.hold!.ops.findIndex((o) => o.kind === 'hold-rename');
    return { ...pair, hold: { ...pair.hold!, ops: pair.hold!.ops.filter((_, k) => k !== i) } };
  };
  const { port, model, r, config } = await setup({ testPlanner: tamper });
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  expect(pair.hold).toBeNull();
  expect(pair.holdUnavailableReason).toBe(HOLD_PARITY_REASON);
  expect(pair.permanent.mode).toBe('permanent');
});

test('executePlan runs a hold delete through executeHold: the manifest is written and marked held', async () => {
  const { port, model, r, config, fx } = await setup();
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  const res = await port.executePlan(pair.hold!, model, r);
  expect(res).toMatchObject({ ok: true, planId: pair.hold!.id });
  const m = JSON.parse(await readFile(join(r.roots.holdRoot!, pair.hold!.deletionId!, 'manifest.json'), 'utf8')) as { status: string };
  expect(m.status).toBe('held');
  const held = await port.listHeld(r);
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({ ok: true, deletionId: pair.hold!.deletionId });
  expect(await port.journalIncomplete()).toEqual([]);
  expect(port.journalPath).toBe(join(fx.userDataDir, 'journal.jsonl'));
  expect((await stat(port.journalPath)).size).toBeGreaterThan(0);
  // the lock is released, so the next operation runs
  const perm = await port.planDeletion(await scan(model.hubRoot), { repos: [{ repoId: 'bartowski/tiny-GGUF', whole: true }] }, r, config, Date.now());
  expect((await port.executePlan(perm.permanent, model, r)).ok).toBe(true);
});

test('executePlan permanent: freed, disk measured, rescan on the real hub', async () => {
  const { port, model, r, config, fx } = await setup();
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  const res = await port.executePlan(pair.permanent, model, r);
  expect(res).toMatchObject({ ok: true, freedBytesPlanned: 2870, heldBytes: 0 });
  expect(res.diskFreeBefore).toBeGreaterThan(0);
  expect(res.diskFreeAfter).toBeGreaterThan(0);
  const after = await scan(model.hubRoot);
  expect(after.repos.find((x) => x.id === Q)!.files.some((f) => f.relpath === 'Qwen3.6-27B-Q8_0.gguf')).toBe(false);
  await expect(stat(join(fx.lmstudioRoot, Q, 'Qwen3.6-27B-Q8_0.gguf'))).rejects.toThrow();
  // a used-up plan run again is refused by the executor's revalidation, never re-applied
  expect((await port.executePlan(pair.permanent, after, r)).ok).toBe(false);
});

test('Recently Deleted: restore and empty by id, NOT_FOUND for an unknown id, auto-empty selection', async () => {
  const { port, model, r, config } = await setup();
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  await port.executePlan(pair.hold!, model, r);
  const id = pair.hold!.deletionId!;
  const after = await scan(model.hubRoot);
  const unknown = '2026-10-25T14-03-07-123Z-1a2b3c4d';
  await expect(port.planRestore(after, r, unknown, Date.now())).rejects.toMatchObject({ name: 'HeldError', code: 'NOT_FOUND' });
  await expect(port.planEmpty(r, [id, unknown], Date.now())).rejects.toBeInstanceOf(HeldError);
  const restore = await port.planRestore(after, r, id, Date.now());
  expect(restore).toMatchObject({ purpose: 'restore', mode: 'hold', deletionId: id });
  const one = await port.planEmpty(r, [id], Date.now());
  expect(one.plans.map((p) => p.deletionId)).toEqual([id]);
  const all = await port.planEmpty(r, 'all', Date.now());
  expect(all.plans.map((p) => p.deletionId)).toEqual([id]);
  const list = await port.listHeld(r);
  expect(port.autoEmptyDue(list, Date.now(), null)).toEqual([]);
  expect(port.autoEmptyDue(list, Date.now(), 14)).toEqual([]);
  expect(port.autoEmptyDue(list, Date.now() + 15 * 86_400_000, 14).map((d) => d.deletionId)).toEqual([id]);
});

test('journal: incomplete plans are reported and acknowledged through the journal', async () => {
  const { port, model, r, config, fx } = await setup();
  const pair = await port.planDeletion(model, q8, r, config, Date.now());
  await new Journal(fx.userDataDir).begin(pair.permanent);
  expect((await port.journalIncomplete()).map((p) => p.planId)).toEqual([pair.permanent.id]);
  await port.acknowledge(pair.permanent.id);
  expect(await port.journalIncomplete()).toEqual([]);
  // a new port on the same userData sees the acknowledgement
  expect(await portFor(fx).journalIncomplete()).toEqual([]);
});

test('sync: offline planning, execution under the shared lock, an offline fetch that always rejects', async () => {
  const { port, model, config, r } = await setup();
  const plan = await port.planSync(model, config, Date.now());
  expect(plan.offline).toBe(true);
  expect(plan.views.map((v) => v.view)).toEqual(['lmstudio']);
  const res = await port.executeSync(plan, { allowMassRemoval: false }, r);
  expect(res.planId).toBe(plan.id);
  expect(res.views.map((v) => v.view)).toEqual(['lmstudio']);
  // the lock is released: a deletion runs right after
  const pair = await port.planDeletion(await scan(model.hubRoot), q8, r, config, Date.now());
  expect((await port.executePlan(pair.permanent, model, r)).ok).toBe(true);
  await expect(offlineFetch('https://huggingface.co/x', { method: 'GET', headers: {}, signal: new AbortController().signal }))
    .rejects.toThrow('offline (HFCM_OFFLINE=1)');
});

test('sync online hands executeSync the given fetch', async () => {
  const G15 = { arch: 'llama', fileType: 15, tensors: [[4, 4]] };
  const R = 'acme/Tiny-GGUF';
  const lc = await loadCase({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [{ path: 'Tiny-Q4_K_M.gguf', gguf: G15 }] }] }],
    views: ['ollama'] });
  expect(ggufBytes(G15).length).toBeGreaterThan(0);
  const fetch = fakeFetch({ status: 404 });
  const port = createCorePort({ userDataDir: lc.c.dir, env: lc.c.env, home: lc.c.home, offline: false, fetch,
    // a case hub sits directly in its temp dir, whose parent the guard refuses to inspect: no hold root needed here
    makeSafeFs: (roots) => SafeFs.create({ ...roots, holdRoot: null }, guardedFs()) });
  const hub = await port.resolveHub();
  const loaded = await port.loadConfig();
  if (!loaded.ok) throw new Error(loaded.error);
  const r = await port.roots(hub.hubRoot, loaded.config);
  const plan = await port.planSync(lc.model, loaded.config, Date.now());
  expect(plan.offline).toBe(false);
  expect(fetch.calls).toEqual([]); // planning never fetches
  const res = await port.executeSync(plan, { allowMassRemoval: false }, r);
  expect(res.views.map((v) => v.status)).toEqual(['applied']);
  expect(fetch.calls.length).toBeGreaterThan(0);
  expect(fetch.calls.every((c) => c.url.includes(`/${R}/manifests/`) && c.init.method === 'GET')).toBe(true);
});

test('overlapping view roots: the deletion plan has no view ops and says why', async () => {
  const { port, model, r, config, fx } = await setup();
  const cfg: HfhubConfig = { ...config, views: { lmstudio: config.views.lmstudio, ollama: { root: fx.lmstudioRoot, aliases: {} } } };
  const r2 = await port.roots(r.roots.hubRoot, cfg);
  const pair = await port.planDeletion(model, q8, r2, cfg, Date.now());
  expect(pair.permanent.ops.some((o) => 'path' in o && o.path.startsWith(fx.lmstudioRoot))).toBe(false);
  expect(pair.permanent.warnings.some((w) => w.includes(VIEW_ROOTS_OVERLAP))).toBe(true);
  expect(pair.permanent.viewImpact.every((l) => l.action === 'blocked')).toBe(true);
});
