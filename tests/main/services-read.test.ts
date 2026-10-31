import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { failingFs } from '../helpers/failing-fs';
import { Journal } from '../../src/core/exec/journal';
import { holdRootFor } from '../../src/core/hold/hold-root';
import { SafeFs } from '../../src/core/safe-fs';
import { hubDiskBytes } from '../../src/core/scan/hub-bytes';
import type { DeletionPlan, Selection } from '../../src/core/types';
import { createCorePort, type CorePort } from '../../src/main/core-port';
import { toRepoDetail } from '../../src/main/dto';
import { inProcessScanRunner, type ScanRunner } from '../../src/main/scan-client';
import { AppServices, type ServicesDeps } from '../../src/main/services';
import type { ApiResult, ScanProgressDTO } from '../../src/shared/api';
import { buildAppFixture, type AppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';
import { buildFixture } from '../helpers/fixture';
import { guardedFs } from '../helpers/guarded-fs';
import { treeDigest } from '../helpers/tree-digest';

useCanaries();
beforeEach(() => expect.hasAssertions());

const Q = 'unsloth/Qwen3.6-27B-GGUF';
const NOW = 1_800_000_000_000;
const created: AppFixture[] = [];
afterEach(async () => { for (const fx of created.splice(0)) await fx.dispose(); });

function unwrap<T>(r: ApiResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

interface Harness { svc: AppServices; port: CorePort; progress: ScanProgressDTO[]; calls: { n: number }; deps: ServicesDeps }

function harness(fx: { root: string; home: string; env: NodeJS.ProcessEnv; userDataDir: string }, over: Partial<ServicesDeps> = {}, runner?: ScanRunner): Harness {
  const calls = { n: 0 };
  const progress: ScanProgressDTO[] = [];
  const port = createCorePort({
    userDataDir: fx.userDataDir, env: fx.env, home: fx.home, offline: true, now: () => NOW,
    makeSafeFs: (roots) => SafeFs.create(roots, guardedFs()),
  });
  const base = runner ?? inProcessScanRunner;
  const deps: ServicesDeps = {
    env: fx.env, home: fx.home, userDataDir: fx.userDataDir, port, platform: 'linux', now: () => NOW,
    scanRunner: (hub, onProgress, signal) => { calls.n++; return base(hub, onProgress, signal); },
    emitProgress: (p) => progress.push(p),
    makeUserSafeFs: (dir) => SafeFs.create({ hubRoot: dir, viewRoots: [], holdRoot: null }, guardedFs()),
    ...over,
  };
  return { svc: new AppServices(deps), port, progress, calls, deps };
}
async function app(over: Partial<ServicesDeps> = {}, runner?: ScanRunner): Promise<{ fx: AppFixture } & Harness> {
  const fx = await buildAppFixture();
  created.push(fx);
  return { fx, ...harness(fx, over, runner) };
}

test('scan returns the library and emits progress ending in done; the cache is not touched', async () => {
  const { fx, svc, progress } = await app();
  const before = await treeDigest(fx.root);
  const lib = unwrap(await svc.scan());
  expect(lib.hubPresent).toBe(true);
  expect(lib.hubRoot).toBe(await realpath(fx.hubRoot));
  expect(lib.repos).toHaveLength(7);
  expect(lib.scanError).toBeNull();
  expect(lib.scannedAt).toBe(NOW);
  expect(lib.heldBytes).toBe(0);
  expect(lib.heldCount).toBe(0);
  expect(lib.lastAutoEmpty).toBeNull();
  const scanned = await inProcessScanRunner(lib.hubRoot, () => undefined, new AbortController().signal);
  expect(lib.hubBytes).toBe(hubDiskBytes(scanned.model));
  expect(lib.hubBytes).toBeGreaterThan(0);
  expect(lib.repos.find((r) => r.repoId === Q)).toMatchObject({ type: 'model', ambiguous: false, usage: { lmstudio: 3, ollama: 0 } });
  const phases = progress.map((p) => p.phase);
  expect(phases[0]).toBe('scan');
  expect(phases).toContain('classify');
  expect(phases.indexOf('usage')).toBeLessThan(phases.lastIndexOf('usage') + 1);
  expect(progress.filter((p) => p.phase === 'usage')).toEqual([{ phase: 'usage', done: 0, total: 1 }, { phase: 'usage', done: 1, total: 1 }]);
  expect(progress.at(-1)).toEqual({ phase: 'done', done: 1, total: 1 });
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('concurrent scan calls share one run (the same promise); a later call scans again', async () => {
  const { svc, calls } = await app();
  const a = svc.scan();
  const b = svc.scan();
  expect(b).toBe(a);
  expect(await a).toEqual(await b);
  expect(calls.n).toBe(1);
  unwrap(await svc.scan());
  expect(calls.n).toBe(2);
});

test('missing hub: hubPresent false with the port message, no runner call, detail NOT_FOUND, disk HUB_MISSING', async () => {
  const fx = await buildAppFixture();
  created.push(fx);
  const missing = join(fx.root, 'unmounted');
  const h = harness({ ...fx, env: { ...fx.env, HF_HUB_CACHE: missing } });
  const lib = unwrap(await h.svc.scan());
  expect(lib).toMatchObject({ hubPresent: false, hubRoot: missing, repos: [], hubBytes: 0, scanError: `Cache not found at ${missing}` });
  expect(h.calls.n).toBe(0);
  expect(h.progress.at(-1)).toEqual({ phase: 'done', done: 1, total: 1 });
  expect(await h.svc.repoDetail(Q)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await h.svc.diskInfo()).toMatchObject({ ok: false, error: { code: 'HUB_MISSING', message: `Cache not found at ${missing}` } });
  // a regular file as the hub reads "(not a folder)"
  const h2 = harness({ ...fx, env: { ...fx.env, HF_HUB_CACHE: fx.configFile } });
  expect(unwrap(await h2.svc.scan()).scanError).toBe(`Cache not found at ${fx.configFile} (not a folder).`);
  const s = unwrap(await h2.svc.settings());
  expect(s).toMatchObject({ hubPresent: false, holdRoot: null });
});

test('repoDetail: unknown is NOT_FOUND, a known repo matches the dto, and it scans first when nothing was scanned', async () => {
  const { fx, svc, port } = await app();
  expect(await svc.repoDetail('nope/nothing')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });   // scanned on demand
  const detail = unwrap(await svc.repoDetail(Q));
  const hub = (await port.resolveHub()).hubRoot;
  const loaded = await port.loadConfig();
  if (!loaded.ok) throw new Error('config');
  const out = await inProcessScanRunner(hub, () => undefined, new AbortController().signal);
  const repo = out.model.repos.find((r) => r.id === Q)!;
  const view = out.views.find((v) => v.repoId === Q)!;
  expect(detail).toEqual(toRepoDetail(out.model, repo, view, await port.usage(out.model, loaded.config), NOW));
  expect(detail.groups.length).toBeGreaterThan(2);
  expect(fx.hubRoot).toBeTruthy();
});

test('an id shared by a model and a dataset is ambiguous: flagged in the library, refused by detail', async () => {
  const base = await buildFixture({ repos: [
    { id: 'o/x', snapshots: [{ commit: 'a'.repeat(40), files: [{ path: 'config.json', blob: { key: 'm', bytes: 5 } }] }] },
    { id: 'o/x', type: 'dataset', snapshots: [{ commit: 'b'.repeat(40), files: [{ path: 'data.json', blob: { key: 'd', bytes: 7 } }] }] },
    { id: 'o/y', snapshots: [{ commit: 'c'.repeat(40), files: [{ path: 'config.json', blob: { key: 'y', bytes: 5 } }] }] },
  ] });
  try {
    const userDataDir = join(base.root, 'userdata');
    await mkdir(userDataDir);
    const h = harness({ root: base.root, home: base.home, env: base.env, userDataDir });
    const lib = unwrap(await h.svc.scan());
    expect(lib.repos.map((r) => [r.type, r.repoId, r.ambiguous]).sort()).toEqual([
      ['dataset', 'o/x', true], ['model', 'o/x', true], ['model', 'o/y', false]]);
    const r = await h.svc.repoDetail('o/x');
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT',
      message: 'Two repos share this id (model and dataset); deletion is disabled for them in this version.' } });
    expect(unwrap(await h.svc.repoDetail('o/y')).repoId).toBe('o/y');
    expect((await h.svc.planningContext()).ok).toBe(true);
    expect(await h.svc.planningContext(['o/x'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((await h.svc.planningContext(['o/y'])).ok).toBe(true);
  } finally {
    await base.dispose();
  }
});

test('a failed scan keeps no model: scanError, progress error, planning refused, and a rescan recovers', async () => {
  let fail = true;
  const runner: ScanRunner = (hub, p, sig) => (fail ? Promise.reject(new Error('EACCES: permission denied')) : inProcessScanRunner(hub, p, sig));
  const { svc, progress } = await app({}, runner);
  const lib = unwrap(await svc.scan());
  expect(lib).toMatchObject({ hubPresent: true, repos: [], hubBytes: 0 });
  expect(lib.scanError).toBe('The cache could not be read: EACCES: permission denied. Fix the permissions and rescan.');
  expect(progress.at(-1)).toEqual({ phase: 'error', done: 0, total: 1, message: 'EACCES: permission denied' });
  expect(await svc.repoDetail(Q)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: lib.scanError } });
  expect(await svc.planningContext()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: lib.scanError } });
  fail = false;
  expect(unwrap(await svc.scan()).repos).toHaveLength(7);
  expect((await svc.planningContext()).ok).toBe(true);
  fail = true;
  unwrap(await svc.scan());
  expect((await svc.planningContext()).ok).toBe(false);   // the earlier model is dropped, never planned against
  fail = true;
  const thrown = await app({}, () => { throw new Error('sync boom'); });
  expect(unwrap(await thrown.svc.scan()).scanError).toContain('sync boom');
  const nonError = await app({}, () => Promise.reject('plain string'));
  expect(unwrap(await nonError.svc.scan()).scanError).toContain('plain string');
});

test('cancelScan aborts the running scan; the previous library survives', async () => {
  let hold = false;
  const cancelled = (): Error => Object.assign(new Error('Scan cancelled'), { name: 'AbortError' });
  const runner: ScanRunner = (hub, p, sig) => hold
    ? new Promise((_, reject) => { if (sig.aborted) reject(cancelled()); else sig.addEventListener('abort', () => reject(cancelled())); })
    : inProcessScanRunner(hub, p, sig);
  const { svc } = await app({}, runner);
  expect(unwrap(await svc.cancelScan())).toBeNull();   // nothing running
  unwrap(await svc.scan());
  hold = true;
  const running = svc.scan();
  expect(unwrap(await svc.cancelScan())).toBeNull();
  expect(await running).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'Scan cancelled' } });
  expect(unwrap(await svc.repoDetail(Q)).repoId).toBe(Q);
  hold = false;
  expect(unwrap(await svc.scan()).repos).toHaveLength(7);   // a new scan is not poisoned by the aborted signal
});

test('an unreadable config.toml blocks view-touching planning with CONFIG copy but not the library', async () => {
  const { fx, svc } = await app();
  await writeFile(fx.configFile, 'this is = = not toml');
  const lib = unwrap(await svc.scan());
  expect(lib.repos).toHaveLength(7);
  expect(lib.repos.find((r) => r.repoId === Q)!.usage).toEqual({ lmstudio: 0, ollama: 0 });
  const ctx = await svc.planningContext();
  expect(ctx).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
  expect(!ctx.ok && ctx.error.message).toMatch(/^config\.toml could not be read \([\s\S]+\); fix it before deleting or syncing\.$/);
  const s = unwrap(await svc.settings());
  expect(s.configError).toMatch(/./);
  expect(s.configExists).toBe(true);
  expect(s.configPath).toBe(fx.configFile);
  expect(s.views.every((v) => v.root === null && v.problem === null)).toBe(true);
  expect(unwrap(await svc.repoDetail(Q)).repoId).toBe(Q);
});

test('planningContext hands back the scanned state for a good config; no scan yet scans first', async () => {
  const { svc, fx } = await app();
  const c = await svc.planningContext([Q]);
  expect(c.ok).toBe(true);
  if (!c.ok) return;
  expect(c.data.config.views.lmstudio.root).toBe(fx.lmstudioRoot);
  expect(c.data.model.repos).toHaveLength(7);
  expect(c.data.roots.roots.hubRoot).toBe(c.data.model.hubRoot);
  expect(await svc.planningContext(['not/there'])).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  const missing = harness({ ...fx, env: { ...fx.env, HF_HUB_CACHE: join(fx.root, 'gone') } });
  expect(await missing.svc.planningContext()).toMatchObject({ ok: false, error: { code: 'HUB_MISSING', message: `Cache not found at ${join(fx.root, 'gone')}` } });
});

test('held totals come from listHeld when the hold root is available', async () => {
  const { fx, svc, port } = await app();
  const hub = await port.resolveHub();
  const loaded = await port.loadConfig();
  if (!loaded.ok) throw new Error('config');
  const out = await inProcessScanRunner(hub.hubRoot, () => undefined, new AbortController().signal);
  const r = await port.roots(hub.hubRoot, loaded.config);
  const sel: Selection = { repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q8_0'], unlockComponents: false }] };
  const pair = await port.planDeletion(out.model, sel, r, loaded.config, NOW);
  expect(pair.hold).not.toBeNull();
  await port.executePlan(pair.hold as DeletionPlan, out.model, r);
  const lib = unwrap(await svc.scan());
  expect(lib.heldCount).toBe(1);
  expect(lib.heldBytes).toBeGreaterThan(0);
  expect(fx.hubRoot).toBeTruthy();
});

test('a listHeld failure does not fail the scan', async () => {
  const { fx } = await app();
  const base = harness(fx);
  const port: CorePort = { ...base.port, listHeld: () => Promise.reject(new Error('held boom')) };
  const h = harness(fx, { port });
  expect(unwrap(await h.svc.scan())).toMatchObject({ heldBytes: 0, heldCount: 0, scanError: null });
});

test('settings are read-only facts', async () => {
  const { fx, svc } = await app();
  const configBefore = await readFile(fx.configFile, 'utf8');
  const s = unwrap(await svc.settings());
  expect(s).toMatchObject({
    hubRoot: await realpath(fx.hubRoot), hubPresent: true, configPath: fx.configFile, configExists: true, configError: null,
    holdRoot: join(dirname(await realpath(fx.hubRoot)), '.hf-cache-manager', 'recently-deleted'),
    holdUnavailableReason: null, autoEmptyDays: 14, platform: 'linux', journalPath: join(fx.userDataDir, 'journal.jsonl'),
    symlinks: { ok: true, detail: 'Symlinks available' },
  });
  expect(s.holdRoot).toBe(holdRootFor(await realpath(fx.hubRoot)));
  expect(s.views.find((v) => v.view === 'lmstudio')).toMatchObject({ root: fx.lmstudioRoot, rootExists: true, problem: null,
    statePath: join(fx.lmstudioRoot, '.hfhub-state.json') });
  expect(s.views.find((v) => v.view === 'ollama')).toMatchObject({ root: null, rootExists: false, statePath: null });
  expect(await readFile(fx.configFile, 'utf8')).toBe(configBefore);
});

test('settings: auto-empty from settings.json (Never is null), a missing view root, an overlap and a relative root', async () => {
  const { fx, svc } = await app();
  await writeFile(join(fx.userDataDir, 'settings.json'), '{"autoEmptyDays":null}');
  expect(unwrap(await svc.settings()).autoEmptyDays).toBeNull();
  const gone = join(fx.root, 'no-lm');
  await writeFile(fx.configFile, `[views.lmstudio]\nroot = "${gone}"\n[views.ollama]\nroot = "${join(fx.lmstudioRoot, 'inner')}"\n`);
  await mkdir(join(fx.lmstudioRoot, 'inner'));
  const s = unwrap(await svc.settings());
  expect(s.views.find((v) => v.view === 'lmstudio')).toMatchObject({ root: gone, rootExists: false });
  // both roots must exist to overlap; make lmstudio exist
  await mkdir(gone);
  const s2 = unwrap(await svc.settings());
  expect(s2.views.find((v) => v.view === 'ollama')!.problem).toBeNull();
  await writeFile(fx.configFile, `[views.lmstudio]\nroot = "${fx.lmstudioRoot}"\n[views.ollama]\nroot = "${join(fx.lmstudioRoot, 'inner')}"\n`);
  const s3 = unwrap(await svc.settings());
  expect(s3.views.every((v) => v.problem !== null && /overlap/i.test(v.problem))).toBe(true);
  await writeFile(fx.configFile, '[views.ollama]\nroot = "relative/path"\n');
  expect(unwrap(await svc.settings()).views.find((v) => v.view === 'ollama')!.problem).toMatch(/not an absolute path/);
});

test('diskInfo reports the hub filesystem', async () => {
  const { fx, svc } = await app();
  const d = unwrap(await svc.diskInfo());
  expect(d.pathDisplay).toBe(await realpath(fx.hubRoot));
  expect(d.totalBytes).toBeGreaterThan(0);
  expect(d.usedBytes + d.freeBytes).toBeLessThanOrEqual(d.totalBytes);
});

test('startup notices list incomplete journal plans until acknowledged, across restarts', async () => {
  const { fx, svc, port, deps } = await app();
  const hub = await port.resolveHub();
  const loaded = await port.loadConfig();
  if (!loaded.ok) throw new Error('config');
  const r = await port.roots(hub.hubRoot, loaded.config);
  const out = await inProcessScanRunner(hub.hubRoot, () => undefined, new AbortController().signal);
  const sel: Selection = { repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q8_0'], unlockComponents: false }] };
  const plan = (await port.planDeletion(out.model, sel, r, loaded.config, NOW)).permanent;
  const journal = new Journal(fx.userDataDir, () => NOW);
  await journal.begin(plan);
  await journal.before(plan.id, 0, plan.ops[0]!);
  await journal.before(plan.id, 1, plan.ops[1]!);
  const all = unwrap(await svc.startupNotices());
  const n = all.flatMap((x) => (x.kind === 'journal' ? [x] : []));
  expect(all).toHaveLength(1);
  expect(n[0]).toMatchObject({ kind: 'journal', planId: plan.id, startedAtMs: NOW, purpose: 'delete', mode: 'permanent', opsStarted: 2 });
  expect(n[0]!.message).toBe(`An operation did not finish: a permanent deletion (plan ${plan.id.slice(0, 8)}) started 2 step(s) `
    + `(started ${new Date(NOW).toLocaleString()}). The cache has been rescanned; review what remains before continuing.`);
  expect(n[0]!.lastOpPath).toMatch(/^.+$/);
  expect(await svc.ackStartupNotice('not-a-plan')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(unwrap(await svc.ackStartupNotice(n[0]!.planId))).toBeNull();
  expect(unwrap(await svc.startupNotices())).toEqual([]);
  expect(unwrap(await new AppServices(deps).startupNotices())).toEqual([]);    // a restart: the journal holds the ack
  expect(await svc.ackStartupNotice(n[0]!.planId)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

test('startup notice copy per purpose and mode; no ops started has no last path', async () => {
  const { fx, svc, port } = await app();
  const base = { startedAt: NOW, opsStarted: 0, lastOp: null } as const;
  const list = [
    { planId: 'aaaaaaaa-0000-4000-8000-000000000001', mode: 'hold', purpose: 'delete', ...base },
    { planId: 'aaaaaaaa-0000-4000-8000-000000000002', mode: 'permanent', purpose: 'restore', ...base },
    { planId: 'aaaaaaaa-0000-4000-8000-000000000003', mode: 'permanent', purpose: 'empty', ...base },
    { planId: 'aaaaaaaa-0000-4000-8000-000000000004', mode: 'hold', purpose: 'delete', startedAt: NOW, opsStarted: 1,
      lastOp: { kind: 'store-sweep', storePath: join(fx.home, 'store'), refsPath: join(fx.home, 'refs') } },
  ] as const;
  const stub: CorePort = { ...port, journalIncomplete: () => Promise.resolve(list.map((x) => ({ ...x })) as never) };
  const out = unwrap(await new AppServices({ ...harness(fx).deps, port: stub }).startupNotices());
  const js = out.flatMap((x) => (x.kind === 'journal' ? [x] : []));
  expect(js).toHaveLength(4);
  expect(js.map((x) => x.message.split(' (plan')[0])).toEqual([
    'An operation did not finish: a move to Recently Deleted',
    'An operation did not finish: a restore',
    'An operation did not finish: emptying Recently Deleted',
    'An operation did not finish: a move to Recently Deleted']);
  expect(js.map((x) => x.lastOpPath)).toEqual([null, null, null, '~/store']);
  expect(svc).toBeTruthy();
});

test('every method returns an ApiResult and never throws', async () => {
  const { fx, port } = await app();
  const boom = (): never => { throw new Error('port exploded'); };
  const bad: CorePort = { ...port, resolveHub: boom, loadConfig: boom, journalIncomplete: () => Promise.reject(new Error('journal exploded')),
    acknowledge: boom };
  const svc = new AppServices({ ...harness(fx).deps, port: bad });
  for (const r of [await svc.scan(), await svc.repoDetail(Q), await svc.settings(), await svc.diskInfo(), await svc.startupNotices(),
    await svc.ackStartupNotice('x'), await svc.planningContext()]) {
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  }
  // and a rename of the cache during the run is reported, not thrown
  await rename(fx.hubRoot, `${fx.hubRoot}-moved`);
  try {
    expect(unwrap(await harness(fx).svc.scan()).hubPresent).toBe(false);
  } finally {
    await rename(`${fx.hubRoot}-moved`, fx.hubRoot);
  }
});

test('cancelScan then scan starts a fresh scan, not the cancelled one', async () => {
  let n = 0;
  const cancelled = (): Error => Object.assign(new Error('Scan cancelled'), { name: 'AbortError' });
  const runner: ScanRunner = (hub, p, sig) => {
    n++;
    if (!sig.aborted) return inProcessScanRunner(hub, p, sig);   // the fresh run; the cancelled one arrives already aborted
    return Promise.reject(cancelled());
  };
  const { svc } = await app({}, runner);
  const first = svc.scan();
  await svc.cancelScan();
  const second = svc.scan();
  expect(second).not.toBe(first);
  expect(unwrap(await second).repos).toHaveLength(7);
  expect(await first).toMatchObject({ ok: false, error: { message: 'Scan cancelled' } });
  expect(n).toBe(1);   // The cancelled run stops at its first await, before it reaches the runner
});

test('a listHeld failure is a notice, not a silent 0/0; a good rescan clears it', async () => {
  const { fx } = await app();
  const base = harness(fx);
  let broken = true;
  const port: CorePort = { ...base.port, listHeld: (r) => (broken ? Promise.reject(new Error('held boom')) : base.port.listHeld(r)) };
  const h = harness(fx, { port });
  unwrap(await h.svc.scan());
  const n = unwrap(await h.svc.startupNotices());
  expect(n).toHaveLength(1);
  expect(n[0]).toEqual({ kind: 'held-unreadable', id: 'held-unreadable', message: expect.any(String) });
  expect(n[0]!.message).toBe('Recently Deleted could not be read (held boom); its totals are not shown. Rescan after fixing it.');
  expect(unwrap(await h.svc.ackStartupNotice('held-unreadable'))).toBeNull();
  expect(unwrap(await h.svc.startupNotices())).toEqual([]);
  broken = false;
  unwrap(await h.svc.scan());
  expect(unwrap(await h.svc.startupNotices())).toEqual([]);
});

test('an unreadable settings.json: auto-empty off, a startup notice, file untouched until Settings is saved', async () => {
  const { fx, svc } = await app();
  const file = join(fx.userDataDir, 'settings.json');
  await writeFile(file, '{garbage');
  expect(unwrap(await svc.settings()).autoEmptyDays).toBeNull();
  const n = unwrap(await svc.startupNotices());
  expect(n).toHaveLength(1);
  expect(n[0]).toEqual({ kind: 'settings-unreadable', id: 'settings-unreadable', message: expect.any(String) });
  expect(n[0]!.message).toMatch(/^Settings file could not be read \(.+\); automatic emptying is off until you save Settings$/);
  expect(await readFile(file, 'utf8')).toBe('{garbage');
  expect(unwrap(await svc.ackStartupNotice('settings-unreadable'))).toBeNull();
  expect(unwrap(await svc.startupNotices())).toEqual([]);
  expect(await readFile(file, 'utf8')).toBe('{garbage');
  // a read error (EACCES) is the same state
  await writeFile(file, '{"autoEmptyDays":9}');
  const h = harness(fx, { fs: failingFs(guardedFs(), 'readFile', 'EACCES', (p) => p === file) });
  expect(unwrap(await h.svc.settings()).autoEmptyDays).toBeNull();
  expect(unwrap(await h.svc.startupNotices())[0]!.message).toMatch(/EACCES/);
  expect(await readFile(file, 'utf8')).toBe('{"autoEmptyDays":9}');
  expect(await readdir(fx.userDataDir)).not.toContain('settings.json.tmp');
});

test('setAutoEmptyDays keeps an existing valid advice block byte-for-byte', async () => {
  const { fx, svc } = await app();
  const file = join(fx.userDataDir, 'settings.json');
  const advice = { gpuBytes: 24e9, gpuKind: 'nvidia', ramBytes: 64e9, drivesDisplay: false, context: 65536, kvType: 'q8_0', tools: ['llama.cpp', 'ollama'] };
  const block = JSON.stringify(advice, null, 2).replace(/\n/g, '\n  ');
  await writeFile(file, JSON.stringify({ autoEmptyDays: 14, advice }, null, 2));
  expect(unwrap(await svc.setAutoEmptyDays(30))).toBeNull();
  const text = await readFile(file, 'utf8');
  expect(text).toContain(`"advice": ${block}`);
  expect(JSON.parse(text)).toEqual({ autoEmptyDays: 30, advice });
});

test('setAutoEmptyDays and setAdviceSettings keep the saved download queue', async () => {
  const { fx, svc } = await app();
  const file = join(fx.userDataDir, 'settings.json');
  const advice = { gpuBytes: 24e9, gpuKind: 'nvidia', ramBytes: 64e9, drivesDisplay: false, context: 65536, kvType: 'q8_0', tools: ['llama.cpp', 'ollama'] } as const;
  const downloads = { version: 1, items: [{ id: 'q1', repoId: 'org/name', type: 'model', revision: 'main', commit: 'c'.repeat(40), refAtStart: null, links: [],
    files: [{ path: 'x.gguf', etag: 'e'.repeat(64), size: 10, lfs: true, state: 'paused', bytes: 3, error: null }] }] };
  await writeFile(file, JSON.stringify({ autoEmptyDays: 14, advice, downloads }));
  unwrap(await svc.setAutoEmptyDays(30));
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ autoEmptyDays: 30, advice, downloads });
  unwrap(await svc.setAdviceSettings({ ...advice, tools: null }));
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ autoEmptyDays: 30, advice: { ...advice, tools: null }, downloads });
});

test('a failed symlink probe is not cached; a success is', async () => {
  const { fx } = await app();
  let failing = true;
  const h = harness(fx, {
    makeUserSafeFs: (dir) => SafeFs.create({ hubRoot: dir, viewRoots: [], holdRoot: null }, failing ? failingFs(guardedFs(), 'symlink', 'EPERM') : guardedFs()),
  });
  expect(unwrap(await h.svc.settings()).symlinks.ok).toBe(false);
  failing = false;
  expect(unwrap(await h.svc.settings()).symlinks).toEqual({ ok: true, detail: 'Symlinks available' });
  failing = true;
  expect(unwrap(await h.svc.settings()).symlinks.ok).toBe(true);   // the success is cached
});

test('planningContext reloads config.toml: an edit after the scan is seen, and a broken edit refuses', async () => {
  const { fx, svc } = await app();
  unwrap(await svc.scan());
  const other = join(fx.root, 'lm-two');
  await mkdir(other);
  await writeFile(fx.configFile, `[views.lmstudio]\nroot = "${other}"\n`);
  const c = await svc.planningContext();
  expect(c.ok && c.data.config.views.lmstudio.root).toBe(other);
  expect(c.ok && c.data.roots.viewRoots.lmstudio).toBe(await realpath(other));
  expect(c.ok && c.data.dto.viewRoots.lmstudio).toBe(await realpath(other));
  await writeFile(fx.configFile, 'bad = = toml');
  expect(await svc.planningContext()).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
  await writeFile(fx.configFile, `[views.lmstudio]\nroot = "${fx.lmstudioRoot}"\n`);
  expect((await svc.planningContext()).ok).toBe(true);
});

test('production code never passes testPlanner or maxManifestBytes to the port', async () => {
  const names = (await readdir(join(process.cwd(), 'src', 'main'))).filter((f) => f.endsWith('.ts') && f !== 'core-port.ts');
  expect(names).toContain('services.ts');
  for (const f of names) {
    const text = await readFile(join(process.cwd(), 'src', 'main', f), 'utf8');
    expect(text, f).not.toMatch(/testPlanner|maxManifestBytes/);
  }
});

test('a scan cancelled after its runner returned never writes the scan state', async () => {
  const fx = await buildAppFixture();
  created.push(fx);
  const real = createCorePort({
    userDataDir: fx.userDataDir, env: fx.env, home: fx.home, offline: true, now: () => NOW,
    makeSafeFs: (roots) => SafeFs.create(roots, guardedFs()),
  });
  // each hold point stalls the cancelled scan right after one await of runScan (roots, usage, held listing)
  for (const at of ['roots', 'usage', 'listHeld'] as const) {
    let armed = false;
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const startedP = new Promise<void>((r) => { started = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const stall = async <T>(v: T): Promise<T> => {
      if (armed) { armed = false; started(); await gate; }
      return v;
    };
    const port: CorePort = {
      ...real,
      roots: async (...a) => { const v = await real.roots(...a); return at === 'roots' ? stall(v) : v; },
      usage: async (...a) => { const v = await real.usage(...a); return at === 'usage' ? stall(v) : v; },
      listHeld: async (...a) => { const v = await real.listHeld(...a); return at === 'listHeld' ? stall(v) : v; },
    };
    const { svc, progress } = harness(fx, { port });
    expect(unwrap(await svc.scan()).repos.map((r) => r.repoId)).toContain('org/dupe');
    armed = true;
    const stale = svc.scan();   // its runner sees org/dupe
    await startedP;
    unwrap(await svc.cancelScan());
    const away = join(fx.root, 'dupe-away');
    await rename(join(fx.hubRoot, 'models--org--dupe'), away);
    try {
      expect(unwrap(await svc.scan()).repos.map((r) => r.repoId), at).not.toContain('org/dupe');
      const doneBefore = progress.filter((p) => p.phase === 'done').length;
      release();
      expect(await stale, at).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'Scan cancelled' } });
      // the cancelled run left the newer scan's state alone and reported no completion
      expect(await svc.repoDetail('org/dupe'), at).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(progress.filter((p) => p.phase === 'done').length, at).toBe(doneBefore);
    } finally {
      await rename(away, join(fx.hubRoot, 'models--org--dupe'));
    }
  }
});
