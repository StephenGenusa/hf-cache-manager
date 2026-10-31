// The AppServices sync side. Every sync runs for real against a temp app fixture with canaries
// planted (useCanaries verifies them after each test). Nothing here touches anything outside os.tmpdir().
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { emptyState } from '../../src/core/compat/state';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SafeFs } from '../../src/core/safe-fs';
import type { SyncItem, SyncPlan, SyncResult, ViewSyncPlan } from '../../src/core/sync/sync';
import { createCorePort, type CorePort, type CorePortOptions } from '../../src/main/core-port';
import { toSyncPlanDTO, toSyncResultDTO } from '../../src/main/dto';
import { inProcessScanRunner, type ScanRunner } from '../../src/main/scan-client';
import { AppServices, BUSY_TEXT, type ServicesDeps } from '../../src/main/services';
import type { ApiResult } from '../../src/shared/api';
import { buildAppFixture, type AppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';
import { guardedFs } from '../helpers/guarded-fs';
import { treeDigest } from '../helpers/tree-digest';

useCanaries();
beforeEach(() => expect.hasAssertions());

const Q = 'unsloth/Qwen3.6-27B-GGUF';
const Q6 = `${Q}/Qwen3.6-27B-Q6_K.gguf`;
const T0 = 1_800_000_000_000;
const created: AppFixture[] = [];
afterEach(async () => { for (const fx of created.splice(0)) await fx.dispose(); });

function unwrap<T>(r: ApiResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

interface Clock { t: number }
type FxLike = Pick<AppFixture, 'userDataDir' | 'env' | 'home'>;
interface Built { svc: AppServices; port: CorePort; scans: { n: number } }

function servicesFor(fx: FxLike, clock: Clock, over: Partial<ServicesDeps> = {}, portOpts: Partial<CorePortOptions> = {},
  wrap: (p: CorePort) => CorePort = (p) => p): Built {
  const scans = { n: 0 };
  const counting: ScanRunner = (hub, p, s) => { scans.n++; return inProcessScanRunner(hub, p, s); };
  const port = wrap(createCorePort({
    userDataDir: fx.userDataDir, env: fx.env, home: fx.home, offline: true, now: () => clock.t,
    makeSafeFs: (roots) => SafeFs.create(roots, guardedFs()), ...portOpts,
  }));
  const svc = new AppServices({
    env: fx.env, home: fx.home, userDataDir: fx.userDataDir, port, platform: 'linux', now: () => clock.t,
    scanRunner: counting, emitProgress: () => undefined,
    makeUserSafeFs: (dir) => SafeFs.create({ hubRoot: dir, viewRoots: [], holdRoot: null }, guardedFs()),
    ...over,
  });
  return { svc, port, scans };
}

async function app(opts: Parameters<typeof buildAppFixture>[0] = {}, over: Partial<ServicesDeps> = {}, portOpts: Partial<CorePortOptions> = {},
  wrap?: (p: CorePort) => CorePort): Promise<{ fx: AppFixture; clock: Clock } & Built> {
  const fx = await buildAppFixture(opts);
  created.push(fx);
  const clock = { t: T0 };
  const b = servicesFor(fx, clock, over, portOpts, wrap);
  return { fx, clock, ...b };
}

/** Adds an (empty) Ollama view folder to the fixture's config.toml. */
async function enableOllama(fx: AppFixture): Promise<string> {
  const root = join(fx.root, 'ollama-view');
  await mkdir(root, { recursive: true });
  await writeFile(fx.configFile, `[views.lmstudio]\nroot = "${fx.lmstudioRoot}"\n\n[views.ollama]\nroot = "${root}"\n`);
  return root;
}

// ---------------------------------------------------------------- preview

test('preview lists adds and foreign entries, and writes nothing', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const before = await treeDigest(fx.root);
  const p = unwrap(await svc.planSync());
  const lm = p.views.find((v) => v.view === 'lmstudio')!;
  expect(lm.adds.map((e) => e.paths[0])).toContain(Q6);
  // The exact absolute path under the (realpath'd) LM Studio root travels with it
  const lmRoot = await realpath(fx.lmstudioRoot);
  const q6 = lm.adds.find((e) => e.paths[0] === Q6)!;
  expect(q6.fullPaths[0]).toBe(join(lmRoot, ...Q6.split('/')));
  for (const e of [...lm.adds, ...lm.foreign]) expect(e.fullPaths).toEqual(e.paths.map((p) => join(lmRoot, ...p.split('/'))));
  expect(lm.foreign.map((e) => e.key)).toContain('bartowski/tiny-GGUF:tiny-Q4_K_M.gguf');
  expect(lm.skippedReason).toBeNull();
  expect(p.views.find((v) => v.view === 'ollama')!.skippedReason).not.toBeNull();   // disabled view
  expect(p.expiresAt - p.createdAt).toBe(10 * 60_000);
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('rootDisplay substitutes ~ for the home folder', async () => {
  const fx = await buildAppFixture();
  created.push(fx);
  const { svc } = servicesFor({ ...fx, home: dirname(fx.lmstudioRoot) }, { t: T0 });
  const lm = unwrap(await svc.planSync()).views.find((v) => v.view === 'lmstudio')!;
  expect(lm.rootDisplay).toBe(`~/${basename(fx.lmstudioRoot)}`);
});

// ---------------------------------------------------------------- execute

test('execute creates links with exact absolute repo-blob targets and never touches foreign files', async () => {
  const { fx, svc, scans } = await app();
  await svc.scan();
  const tiny = await readFile(join(fx.lmstudioRoot, 'bartowski/tiny-GGUF/tiny-Q4_K_M.gguf'));
  const p = unwrap(await svc.planSync());
  const scansBefore = scans.n;
  const r = unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false }));
  expect(r.ok).toBe(true);
  expect(r.views.find((v) => v.view === 'lmstudio')).toMatchObject({ status: 'applied', error: null, partialWrites: [] });
  expect(readlinkSync(join(fx.lmstudioRoot, Q6))).toBe(fx.repo(Q).blobOf('Qwen3.6-27B-Q6_K.gguf'));
  expect(await readFile(join(fx.lmstudioRoot, 'bartowski/tiny-GGUF/tiny-Q4_K_M.gguf'))).toEqual(tiny);
  expect(lstatSync(join(fx.lmstudioRoot, 'bartowski/tiny-GGUF/tiny-Q4_K_M.gguf')).isSymbolicLink()).toBe(false);
  expect(scans.n).toBe(scansBefore + 1);   // rescan after sync
  expect(await svc.executeSync(p.planId, { allowMassRemoval: false })).toMatchObject({ ok: false, error: { code: 'USED' } });
  expect(unwrap(await svc.scan()).hubPresent).toBe(true);
});

test('unknown plan and expired plan are refused and write nothing', async () => {
  const { fx, svc, clock } = await app();
  await svc.scan();
  expect(await svc.executeSync('0b0f1a52-1c9f-4a5e-9d63-7a0c8f2e4b11', { allowMassRemoval: false }))
    .toMatchObject({ ok: false, error: { code: 'UNKNOWN_PLAN' } });
  const p = unwrap(await svc.planSync());
  const before = await treeDigest(fx.root);
  clock.t += 10 * 60_000;
  expect(await svc.executeSync(p.planId, { allowMassRemoval: false })).toMatchObject({ ok: false, error: { code: 'EXPIRED' } });
  expect(await treeDigest(fx.root)).toEqual(before);
  expect(existsSync(join(fx.lmstudioRoot, Q6))).toBe(false);
});

test('mass removal refused without the flag, state byte-identical; allowed with it', async () => {
  const { fx, svc } = await app({ massRemovalState: true });
  await svc.scan();
  const p = unwrap(await svc.planSync());
  const lmPlan = p.views.find((v) => v.view === 'lmstudio')!;
  expect(lmPlan.wouldRemoveAll).toBe(true);
  expect(lmPlan.removals.flatMap((e) => e.paths)).toContain('gone/repo/x.gguf');
  const state = await readFile(join(fx.lmstudioRoot, '.hfhub-state.json'));
  const r = unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false }));
  const lm = r.views.find((v) => v.view === 'lmstudio')!;
  expect(r.ok).toBe(false);
  expect(lm.status).toBe('refused-mass-removal');
  expect(lm.error).toMatch(/refused/);
  expect(r.massRemovalViews).toEqual(['lmstudio']);
  expect(await readFile(join(fx.lmstudioRoot, '.hfhub-state.json'))).toEqual(state);
  expect(lstatSync(join(fx.lmstudioRoot, 'gone/repo/x.gguf')).isSymbolicLink()).toBe(true);
  const p2 = unwrap(await svc.planSync());
  expect(unwrap(await svc.executeSync(p2.planId, { allowMassRemoval: true })).ok).toBe(true);
  expect(existsSync(join(fx.lmstudioRoot, 'gone/repo/x.gguf'))).toBe(false);
});

test('a view that changed since the preview is reported stale, with its error, and is not touched', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const p = unwrap(await svc.planSync());
  const target = join(fx.lmstudioRoot, Q6);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'the user put this here\n');
  const r = unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false }));
  const lm = r.views.find((v) => v.view === 'lmstudio')!;
  expect(r.ok).toBe(false);
  expect(lm.status).toBe('stale');
  expect(lm.error).toMatch(/changed since the preview/);
  expect(await readFile(target, 'utf8')).toBe('the user put this here\n');
});

// ---------------------------------------------------------------- refusals

test('missing hub and a hub with no repos give HUB_MISSING with the guard text', async () => {
  const { fx } = await app();
  const gone = join(fx.root, 'gone');
  const missing = servicesFor({ ...fx, env: { ...fx.env, HF_HUB_CACHE: gone } }, { t: T0 });
  expect(await missing.svc.planSync()).toEqual({
    ok: false, error: { code: 'HUB_MISSING', message: `Cache not found or empty at ${gone}; sync is disabled so nothing is removed by mistake.` },
  });
  const empty = join(dirname(fx.hubRoot), 'empty-hub');
  await mkdir(empty, { recursive: true });
  const none = servicesFor({ ...fx, env: { ...fx.env, HF_HUB_CACHE: empty } }, { t: T0 });
  const r = await none.svc.planSync();
  expect(r).toMatchObject({ ok: false, error: { code: 'HUB_MISSING' } });
  expect(!r.ok && r.error.message).toBe(`Cache not found or empty at ${empty}; sync is disabled so nothing is removed by mistake.`);
});

test('an unreadable config.toml blocks planSync and executeSync and keeps the plan unused', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const p = unwrap(await svc.planSync());
  const good = await readFile(fx.configFile, 'utf8');
  await writeFile(fx.configFile, '[views.lmstudio\nroot = ');
  const before = await treeDigest(fx.root);
  expect(await svc.planSync()).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
  expect(await svc.executeSync(p.planId, { allowMassRemoval: false })).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
  expect(await treeDigest(fx.root)).toEqual(before);
  await writeFile(fx.configFile, good);
  expect(unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false })).ok).toBe(true);   // not consumed by the refusal
});

test('a failed first scan refuses planSync', async () => {
  const fx = await buildAppFixture();
  created.push(fx);
  const failing: ScanRunner = () => Promise.reject(new Error('EACCES: nope'));
  const { svc } = servicesFor(fx, { t: T0 }, { scanRunner: failing });
  expect(await svc.planSync()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

test('BUSY while a scan runs: planSync and executeSync refuse and the plan stays usable', async () => {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const gated: ScanRunner = async (h, p, s) => { if (gate !== null) await gate; return inProcessScanRunner(h, p, s); };
  const { fx, svc } = await app({}, { scanRunner: gated });
  await svc.scan();
  const p = unwrap(await svc.planSync());
  gate = new Promise((r) => { open = r; });
  const scanning = svc.scan();
  expect(await svc.planSync()).toEqual({ ok: false, error: { code: 'BUSY', message: BUSY_TEXT } });
  expect(await svc.executeSync(p.planId, { allowMassRemoval: false })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  open();
  gate = null;
  await scanning;
  expect(existsSync(join(fx.lmstudioRoot, Q6))).toBe(false);
  expect(unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false })).ok).toBe(true);
});

test('BUSY while a sync runs: deletes, plans and previews refuse; one execution only', async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((r) => { release = r; });
  let entered: () => void = () => undefined;
  const inside = new Promise<void>((r) => { entered = r; });
  const { svc, fx } = await app({}, {}, {}, (p) => ({
    ...p, executeSync: async (plan, o, r) => { entered(); await hold; return p.executeSync(plan, o, r); },
  }));
  await svc.scan();
  const p1 = unwrap(await svc.planSync());
  const running = svc.executeSync(p1.planId, { allowMassRemoval: false });
  await inside;
  expect(await svc.executeSync(p1.planId, { allowMassRemoval: false })).toMatchObject({ ok: false, error: { code: 'USED' } });
  expect(await svc.planSync()).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  expect(await svc.planDelete({ repos: [{ repoId: 'bartowski/tiny-GGUF', whole: true }] })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  expect(await svc.previewSelection({ repos: [{ repoId: 'bartowski/tiny-GGUF', whole: true }] })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  release();
  expect(unwrap(await running).ok).toBe(true);
  expect(existsSync(join(fx.lmstudioRoot, Q6))).toBe(true);
});

const linkExists = (p: string): boolean => {
  try { lstatSync(p); return true; } catch { return false; }
};

test('a new preview supersedes the older one', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const p1 = unwrap(await svc.planSync());
  const p2 = unwrap(await svc.planSync());
  expect(await svc.executeSync(p1.planId, { allowMassRemoval: false })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PLAN' } });
  expect(linkExists(join(fx.lmstudioRoot, Q6))).toBe(false);
  expect(unwrap(await svc.executeSync(p2.planId, { allowMassRemoval: false })).ok).toBe(true);
});

test('a delete between preview and execute voids the preview: no dangling link is created', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const p = unwrap(await svc.planSync());
  expect(p.views[0]!.adds.map((e) => e.paths[0])).toContain(Q6);
  const pair = unwrap(await svc.planDelete({ repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q6_K'], unlockComponents: false }] }));
  unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', pair.permanent.confirmPhrase));
  const r = await svc.executeSync(p.planId, { allowMassRemoval: false });
  expect(r).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PLAN' } });
  expect(!r.ok && r.error.message).toMatch(/Preview expired — the cache changed; preview Sync again/);
  expect(linkExists(join(fx.lmstudioRoot, Q6))).toBe(false);
});

test('a rescan that finds a changed model voids the preview; an unchanged rescan does not', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const p = unwrap(await svc.planSync());
  await svc.scan();
  const p2 = unwrap(await svc.planSync());
  await svc.scan();   // nothing changed on disk
  await unlink(join(fx.repo(Q).snapshotDir(), 'README.md'));
  await svc.scan();
  expect(await svc.executeSync(p2.planId, { allowMassRemoval: false })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PLAN' } });
  expect(p.planId).not.toBe(p2.planId);
});

test('an unchanged rescan keeps the preview usable', async () => {
  const { svc } = await app();
  await svc.scan();
  const p = unwrap(await svc.planSync());
  await svc.scan();
  expect(unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false })).ok).toBe(true);
});

// ---------------------------------------------------------------- offline, skipped and partial results

test('offline: an Ollama view makes no network call, and its skipped entries reach the result', async () => {
  const fetchSpy = vi.fn<NonNullable<CorePortOptions['fetch']>>(() => Promise.reject(new Error('network used')));
  const { fx, svc } = await app({}, {}, { offline: true, fetch: fetchSpy });
  const ollamaRoot = await enableOllama(fx);
  await svc.scan();
  const p = unwrap(await svc.planSync());
  expect(p.views.map((v) => v.view)).toEqual(['lmstudio', 'ollama']);
  const r = unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false }));
  expect(fetchSpy).not.toHaveBeenCalled();
  const ol = r.views.find((v) => v.view === 'ollama')!;
  expect(ol.skipped).toBeGreaterThan(0);
  expect(ol.warnings.join('\n')).toMatch(/skipped/i);   // every skipped entry is listed, not just counted
  expect(existsSync(join(ollamaRoot, 'manifests'))).toBe(false);
});

test('a plan-skipped view is reported in the result, not dropped', async () => {
  const { svc } = await app();
  await svc.scan();
  const p = unwrap(await svc.planSync());
  const r = unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false }));
  const ol = r.views.find((v) => v.view === 'ollama')!;
  expect(ol.status).toBe('skipped');
  expect(ol.error).not.toBeNull();
  expect(r.ok).toBe(true);   // only executed views decide ok
});

test('toSyncResultDTO shows partial writes, stale, aborted and refused views and every skipped entry', () => {
  const base = { applied: [], skippedEntries: [], removedPaths: [], createdPaths: [], warnings: [] };
  const result: SyncResult = {
    planId: 'p',
    views: [
      { ...base, view: 'lmstudio', status: 'aborted', message: '[lmstudio] aborted: boom',
        applied: [{ key: 'a:b', action: 'create' }, { key: 'c:d', action: 'update' }, { key: 'e:f', action: 'prune' }, { key: 'g:h', action: 'adopt' }, { key: 'i:j', action: 'tombstone' }],
        removedPaths: ['x', 'y'],
        skippedEntries: [{ key: 'k:1', reason: 'disk full', partialWrite: true }, { key: 'k:2', reason: 'no space for the manifest' }],
        warnings: ['w1'] },
      { ...base, view: 'ollama', status: 'stale', message: '[ollama] the view changed since the preview — preview again' },
    ],
  };
  const dto = toSyncResultDTO(result, []);
  expect(dto.ok).toBe(false);
  const lm = dto.views[0]!;
  expect(lm).toMatchObject({ view: 'lmstudio', status: 'aborted', created: 1, updated: 1, removed: 2, adopted: 1, tombstoned: 1, skipped: 2, error: '[lmstudio] aborted: boom' });
  expect(lm.partialWrites).toEqual(['k:1: disk full']);
  expect(lm.warnings).toEqual(['w1', 'k:2: skipped — no space for the manifest']);
  expect(dto.views[1]).toMatchObject({ view: 'ollama', status: 'stale', error: '[ollama] the view changed since the preview — preview again' });
  const partialOnly = toSyncResultDTO({ planId: 'p', views: [{ ...base, view: 'lmstudio', status: 'applied', skippedEntries: [{ key: 'k', reason: 'x', partialWrite: true }] }] }, []);
  expect(partialOnly.ok).toBe(false);   // a partial write is never reported as plain success
  expect(partialOnly.views[0]!.error).toBeNull();
});

test('an already-owned link is left exactly as it was by a sync', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const link = join(fx.lmstudioRoot, `${Q}/Qwen3.6-27B-Q8_0.gguf`);
  const before = readlinkSync(link);
  const p = unwrap(await svc.planSync());
  unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false }));
  expect(readlinkSync(link)).toBe(before);
});

test('toSyncResultDTO: ok is false when nothing ran, and refused views are all listed', () => {
  expect(toSyncResultDTO({ planId: 'p', views: [] }, [{ view: 'lmstudio', reason: 'r' }, { view: 'ollama', reason: 'r' }]))
    .toMatchObject({ ok: false, massRemovalViews: [] });
  const base = { applied: [], skippedEntries: [], removedPaths: [], createdPaths: [], warnings: [] };
  const refused = toSyncResultDTO({ planId: 'p', views: [
    { ...base, view: 'lmstudio', status: 'refused-mass-removal', message: 'm' }, { ...base, view: 'ollama', status: 'refused-mass-removal', message: 'm' },
  ] }, []);
  expect(refused).toMatchObject({ ok: false, massRemovalViews: ['lmstudio', 'ollama'] });
});

// A hand-built plan: every kind of line the user confirms deletions from.
const item = (key: string, action: SyncItem['action'], over: Partial<SyncItem> = {}): SyncItem =>
  ({ key, action, conditional: [], removes: [], keepsShared: [], ...over });
const desired = (key: string, paths: string[]): NonNullable<SyncItem['desired']> =>
  ({ key, repoId: 'o/r', sha256: 'a'.repeat(64), paths, links: [] });

test('toSyncPlanDTO lists removals, conditional and shared notes, tombstones, adopts, foreign and skipped lines', () => {
  const view: ViewSyncPlan = {
    view: 'ollama', root: '/home/u/ollama', statePath: '/home/u/ollama/.hfhub-state.json', stateRaw: null, state: emptyState(),
    items: [
      item('o/r:gone.gguf', 'prune', { removes: ['a/gone.gguf', 'blobs/sha256-1'], conditional: ['blobs/sha256-1'], keepsShared: [{ path: 'a/shared', owners: ['o/r:other', 'x:y'] }] }),
      item('o/r:upd.gguf', 'update', { desired: desired('o/r:upd.gguf', ['n/upd.gguf']), removes: ['old/upd.gguf'] }),
      item('o/r:hand.gguf', 'update', { desired: desired('o/r:hand.gguf', ['n/hand.gguf']), keepsShared: [{ path: 'n/hand.gguf', owners: ['o/r:taker'] }] }),
      item('o/r:tomb.gguf', 'tombstone', { reason: 'no longer in the hub', owned: { paths: ['t/tomb.gguf'], sha256: 'b'.repeat(64) } }),
      item('o/r:adopt.gguf', 'adopt', { desired: desired('o/r:adopt.gguf', ['ad/adopt.gguf']) }),
      item('o/r:new.gguf', 'create', { desired: desired('o/r:new.gguf', ['c/new.gguf']) }),
      item('o/r:mine.gguf', 'foreign', { desired: desired('o/r:mine.gguf', ['f/mine.gguf']), reason: 'not created by sync' }),
      item('o/r:skip.gguf', 'skip', { desired: desired('o/r:skip.gguf', ['s/skip.gguf']), reason: 'no tag' }),
      item('o/r:same.gguf', 'noop', { desired: desired('o/r:same.gguf', ['z/same.gguf']) }),
    ],
    foreign: [{ key: 'u:v', path: 'u/v.gguf', target: '/home/u/elsewhere/v.gguf' }, { key: 'u:w', path: 'u/w.gguf' }],
    warnings: ['view warning'], massRemoval: true, ownedCount: 7, expect: {}, collisions: {},
    counts: { skip: 1, update: 2, foreign: 1, create: 1, noop: 1, tombstone: 1, adopt: 1, prune: 1 },
  };
  const plan: SyncPlan = {
    id: 'plan-1', createdAt: 5, expiresAt: 605, hubRoot: '/home/u/hub', offline: false, hubMissing: false, views: [view],
    skipped: [{ view: 'lmstudio', reason: 'root does not exist: /nope' }], warnings: ['view warning'],
  };
  const dto = toSyncPlanDTO(plan, '/home/u');
  const ol = dto.views.find((v) => v.view === 'ollama')!;
  expect(ol.rootDisplay).toBe('~/ollama');
  expect(ol.wouldRemoveAll).toBe(true);
  expect(ol.ownedCount).toBe(7);
  expect(ol.warnings).toEqual(['view warning']);
  expect(ol.removals).toEqual([
    { key: 'o/r:gone.gguf', paths: ['a/gone.gguf', 'blobs/sha256-1'], fullPaths: ['/home/u/ollama/a/gone.gguf', '/home/u/ollama/blobs/sha256-1'],
      note: 'removed only if no manifest uses it: blobs/sha256-1; a/shared kept — also owned by o/r:other, x:y' },
    { key: 'o/r:upd.gguf', paths: ['old/upd.gguf'], fullPaths: ['/home/u/ollama/old/upd.gguf'], note: null },
    { key: 'o/r:hand.gguf', paths: [], fullPaths: [], note: 'n/hand.gguf kept — also owned by o/r:taker' },
  ]);
  expect(ol.updates.map((e) => e.key)).toEqual(['o/r:upd.gguf', 'o/r:hand.gguf']);
  expect(ol.tombstones).toEqual([{ key: 'o/r:tomb.gguf', paths: ['t/tomb.gguf'], fullPaths: ['/home/u/ollama/t/tomb.gguf'], note: 'no longer in the hub' }]);
  expect(ol.adopts).toEqual([{ key: 'o/r:adopt.gguf', paths: ['ad/adopt.gguf'], fullPaths: ['/home/u/ollama/ad/adopt.gguf'], note: null }]);
  expect(ol.adds.map((e) => e.paths)).toEqual([['c/new.gguf']]);
  // Every entry carries the full absolute paths (view root joined), as the deletion review does
  expect(ol.adds.map((e) => e.fullPaths)).toEqual([['/home/u/ollama/c/new.gguf']]);
  expect(ol.updates.map((e) => e.fullPaths)).toEqual([['/home/u/ollama/n/upd.gguf'], ['/home/u/ollama/n/hand.gguf']]);
  expect(ol.foreign).toEqual([
    { key: 'o/r:mine.gguf', paths: ['f/mine.gguf'], fullPaths: ['/home/u/ollama/f/mine.gguf'], note: 'not created by sync' },
    { key: 'u:v', paths: ['u/v.gguf'], fullPaths: ['/home/u/ollama/u/v.gguf'], note: 'points to ~/elsewhere/v.gguf' },
    { key: 'u:w', paths: ['u/w.gguf'], fullPaths: ['/home/u/ollama/u/w.gguf'], note: null },
  ]);
  expect(ol.skipped).toEqual([{ key: 'o/r:skip.gguf', paths: ['s/skip.gguf'], fullPaths: ['/home/u/ollama/s/skip.gguf'], note: 'no tag' }]);
  const lm = dto.views.find((v) => v.view === 'lmstudio')!;
  expect(lm).toMatchObject({ rootDisplay: null, skippedReason: 'root does not exist: /nope', adds: [], removals: [] });
});

// ---------------------------------------------------------------- symmetry and in-flight planning

test('a sync execute voids an outstanding deletion review: the links it created are not left dangling', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const pair = unwrap(await svc.planDelete({ repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q6_K'], unlockComponents: false }] }));
  const p = unwrap(await svc.planSync());
  expect(unwrap(await svc.executeSync(p.planId, { allowMassRemoval: false })).ok).toBe(true);
  expect(linkExists(join(fx.lmstudioRoot, Q6))).toBe(true);
  const after = await treeDigest(fx.root);
  for (const plan of [pair.permanent, ...(pair.hold === null ? [] : [pair.hold])]) {
    const r = await svc.executePlan(plan.planId, plan.fingerprint, plan.mode, plan.confirmPhrase);
    expect(r).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PLAN' } });
    expect(!r.ok && r.error.message).toBe('The cache or its links changed; review the deletion again');
  }
  expect(await treeDigest(fx.root)).toEqual(after);
});

/** A port whose next planSync / planDeletion call waits for `release()` (after the call has started). */
function delayed(): { wrap: (p: CorePort) => CorePort; arm(): void; started: Promise<void>; release(): void } {
  let armed = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let started: () => void = () => undefined;
  const startedP = new Promise<void>((r) => { started = r; });
  const hold = async (): Promise<void> => {
    if (!armed) return;
    armed = false;
    started();
    await gate;
  };
  return {
    arm: () => { armed = true; }, started: startedP, release: () => release(),
    wrap: (p) => ({
      ...p,
      planSync: async (m, c, n) => { const plan = await p.planSync(m, c, n); await hold(); return plan; },
      planDeletion: async (m, s, r, c, n) => { const pair = await p.planDeletion(m, s, r, c, n); await hold(); return pair; },
    }),
  };
}

test('a planSync that started before an execute and finishes after it is not registered', async () => {
  const d = delayed();
  const { svc } = await app({}, {}, {}, d.wrap);
  await svc.scan();
  const p1 = unwrap(await svc.planSync());
  d.arm();
  const slow = svc.planSync();
  await d.started;
  expect(unwrap(await svc.executeSync(p1.planId, { allowMassRemoval: false })).ok).toBe(true);
  d.release();
  const r = await slow;
  expect(r).toMatchObject({ ok: false, error: { code: 'STALE' } });
  expect(!r.ok && r.error.message).toBe('Preview expired — preview Sync again');
});

test('a planDelete that started before an execute and finishes after it is not registered', async () => {
  const d = delayed();
  const { svc } = await app({}, {}, {}, d.wrap);
  await svc.scan();
  const p1 = unwrap(await svc.planSync());
  d.arm();
  const slow = svc.planDelete({ repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q6_K'], unlockComponents: false }] });
  await d.started;
  expect(unwrap(await svc.executeSync(p1.planId, { allowMassRemoval: false })).ok).toBe(true);
  d.release();
  const r = await slow;
  expect(r).toMatchObject({ ok: false, error: { code: 'STALE' } });
  expect(!r.ok && r.error.message).toBe('The cache or its links changed; review the deletion again');
});

test('an execute that starts and finishes while planSync reads its context voids that preview', async () => {
  let armed = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let started: () => void = () => undefined;
  const startedP = new Promise<void>((r) => { started = r; });
  const wrap = (p: CorePort): CorePort => ({
    ...p,
    loadConfig: async () => {
      const c = await p.loadConfig();
      if (armed) { armed = false; started(); await gate; }
      return c;
    },
  });
  const { svc } = await app({}, {}, {}, wrap);
  await svc.scan();
  const p1 = unwrap(await svc.planSync());
  armed = true;
  const slow = svc.planSync();   // held inside planningContext (its config read)
  await startedP;
  expect(unwrap(await svc.executeSync(p1.planId, { allowMassRemoval: false })).ok).toBe(true);   // with its rescan
  release();
  const r = await slow;
  expect(r).toMatchObject({ ok: false, error: { code: 'STALE', message: 'Preview expired — preview Sync again' } });
});
