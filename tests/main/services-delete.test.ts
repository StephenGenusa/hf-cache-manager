// The AppServices write side (plan, execute, Recently Deleted, auto-empty). Every deletion path runs
// for real against a temp app fixture with canaries planted (useCanaries verifies them after each test).
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DAY_MS } from '../../src/core/hold/held';
import { holdRootFor } from '../../src/core/hold/hold-root';
import { SafeFs } from '../../src/core/safe-fs';
import type { Selection } from '../../src/core/types';
import { createCorePort, type CorePort, type CorePortOptions } from '../../src/main/core-port';
import { inProcessScanRunner, type ScanRunner } from '../../src/main/scan-client';
import {
  AppServices, AUTO_EMPTY_ALREADY_STARTED, AUTO_EMPTY_GRACE_MS, AUTO_EMPTY_RETRY_MS, defaultSchedule, HELD_UNREADABLE_WARNING, type Scheduler,
  type ServicesDeps,
} from '../../src/main/services';
import { formatBytes } from '../../src/shared/format';
import type { ApiResult, ExecResultDTO, PlanDTO } from '../../src/shared/api';
import { DELETION_ID_PATTERN } from '../../src/shared/ipc-schemas';
import { buildAppFixture, SIZES, type AppFixture } from '../helpers/app-fixture';
import { buildFixture } from '../helpers/fixture';
import { useCanaries } from '../helpers/canary';
import { guardedFs } from '../helpers/guarded-fs';
import { treeDigest } from '../helpers/tree-digest';

useCanaries();
beforeEach(() => expect.hasAssertions());

const Q = 'unsloth/Qwen3.6-27B-GGUF';
const FLUX = 'black-forest-labs/FLUX.1-dev';
const PHRASE = Q;   // The confirm phrase is the full repo id
const T0 = 1_800_000_000_000;
const REVIEW_AGAIN = 'The cache changed since you reviewed — please review again.';
const created: AppFixture[] = [];
afterEach(async () => { for (const fx of created.splice(0)) await fx.dispose(); });

function unwrap<T>(r: ApiResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}
function errorOf<T>(r: ApiResult<T>): { code: string; message: string } {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.error;
}

const sel = (...keys: string[]): Selection => ({ repos: [{ repoId: Q, whole: false, groupKeys: keys, unlockComponents: false }] });
const whole = (...ids: string[]): Selection => ({ repos: ids.map((repoId) => ({ repoId, whole: true as const })) });

interface Clock { t: number }
interface App { fx: AppFixture; svc: AppServices; port: CorePort; clock: Clock; deps: ServicesDeps; holdRoot: string }

type FxLike = Pick<AppFixture, 'userDataDir' | 'env' | 'home'>;
function servicesFor(fx: FxLike, clock: Clock, over: Partial<ServicesDeps> = {}, portOpts: Partial<CorePortOptions> = {}):
  { svc: AppServices; port: CorePort; deps: ServicesDeps } {
  const port = createCorePort({
    userDataDir: fx.userDataDir, env: fx.env, home: fx.home, offline: true, now: () => clock.t,
    makeSafeFs: (roots) => SafeFs.create(roots, guardedFs()), ...portOpts,
  });
  const deps: ServicesDeps = {
    env: fx.env, home: fx.home, userDataDir: fx.userDataDir, port, platform: 'linux', now: () => clock.t,
    scanRunner: inProcessScanRunner, emitProgress: () => undefined,
    makeUserSafeFs: (dir) => SafeFs.create({ hubRoot: dir, viewRoots: [], holdRoot: null }, guardedFs()),
    ...over,
  };
  return { svc: new AppServices(deps), port: deps.port, deps };
}

async function app(over: Partial<ServicesDeps> = {}): Promise<App> {
  const fx = await buildAppFixture();
  created.push(fx);
  const clock = { t: T0 };
  const s = servicesFor(fx, clock, over);
  return { fx, clock, ...s, holdRoot: holdRootFor(await realpath(fx.hubRoot)) };
}

/** A gate a scan runner waits on, so a test can hold a scan open. */
function gatedRunner(): { runner: ScanRunner; block(): void; release(): void } {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  return {
    runner: async (hub, p, s) => {
      if (gate !== null) await gate;
      return inProcessScanRunner(hub, p, s);
    },
    block: () => { gate = new Promise((r) => { open = r; }); },
    release: () => { open(); gate = null; },
  };
}

async function holdOf(svc: AppServices, s: Selection): Promise<ExecResultDTO> {
  const pair = unwrap(await svc.planDelete(s));
  expect(pair.hold).not.toBeNull();
  return unwrap(await svc.executePlan(pair.hold!.planId, pair.hold!.fingerprint, 'hold', null));
}

/** The tree, less the AppLock's own folder beside the hub (taking the lock creates it; it is empty after release). */
async function cacheDigest(root: string): Promise<Record<string, string>> {
  const d = await treeDigest(root);
  if (d['hf/.hf-cache-manager'] === 'dir' && !Object.keys(d).some((k) => k.startsWith('hf/.hf-cache-manager/'))) delete d['hf/.hf-cache-manager'];
  return d;
}

/** Every listed deletion id, as if all of them had been announced (runAutoEmpty requires the announced set). */
async function allHeld(svc: AppServices): Promise<Set<string>> {
  const r = await svc.listHeld();
  return new Set(r.ok ? r.data.items.map((i) => i.deletionId) : []);
}

const heldIds = (holdRoot: string): string[] =>
  existsSync(holdRoot) ? readdirSync(holdRoot).filter((n) => DELETION_ID_PATTERN.test(n)) : [];

// ---------------------------------------------------------------- preview and selection checks

test('preview equals the planner figure and registers nothing', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const before = await treeDigest(fx.root);
  expect(unwrap(await svc.previewSelection(sel('quant:Q8_0', 'quant:BF16'))))
    .toEqual({ groupCount: 2, freedBytes: 8250, viewLinksAffected: 1, warnings: [] });
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('selection refusals map the planner errors: unknown repo or group NOT_FOUND, locked group INVALID_INPUT', async () => {
  const { fx, svc } = await app();
  const before = await treeDigest(fx.root);
  const calls: Array<(s: Selection) => Promise<ApiResult<unknown>>> = [(s) => svc.previewSelection(s), (s) => svc.planDelete(s)];
  for (const call of calls) {
    expect(errorOf(await call(sel('quant:NOPE')))).toEqual({ code: 'NOT_FOUND', message: `${Q} has no group quant:NOPE` });
    expect(errorOf(await call(whole('org/nope')))).toMatchObject({ code: 'NOT_FOUND' });
    const locked = errorOf(await call({ repos: [{ repoId: FLUX, whole: false, groupKeys: ['component:vae/'], unlockComponents: false }] }));
    expect(locked.code).toBe('INVALID_INPUT');
    expect(locked.message).toMatch(/^black-forest-labs\/FLUX\.1-dev: .* is locked; unlock component deletion to select it$/);
    expect((await call({ repos: [{ repoId: FLUX, whole: false, groupKeys: ['component:vae/'], unlockComponents: true }] })).ok).toBe(true);
  }
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('planDelete and preview while a scan runs are BUSY', async () => {
  const g = gatedRunner();
  const { svc } = await app({ scanRunner: g.runner });
  await svc.scan();
  g.block();
  const scanning = svc.scan();
  expect(errorOf(await svc.planDelete(sel('quant:Q8_0'))).code).toBe('BUSY');
  expect(errorOf(await svc.previewSelection(sel('quant:Q8_0'))).code).toBe('BUSY');
  g.release();
  await scanning;
  expect((await svc.planDelete(sel('quant:Q8_0'))).ok).toBe(true);
});

test('an unreadable config.toml refuses planDelete with CONFIG; nothing registered or changed', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  await writeFile(fx.configFile, '[views.lmstudio\nroot = ');
  const before = await treeDigest(fx.root);
  expect(errorOf(await svc.planDelete(sel('quant:Q8_0'))).code).toBe('CONFIG');
  expect(errorOf(await svc.previewSelection(sel('quant:Q8_0'))).code).toBe('CONFIG');
  expect(await treeDigest(fx.root)).toEqual(before);
  // Recently Deleted stays available (it touches no view)
  expect(unwrap(await svc.listHeld())).toMatchObject({ available: true, items: [] });
});

// ---------------------------------------------------------------- the confirm gate and single use

test('wrong confirm text is refused, nothing changes, and the plan stays usable', async () => {
  const { fx, svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:BF16')));
  expect(pair.permanent.confirmPhrase).toBe(PHRASE);
  const before = await treeDigest(fx.root);
  for (const t of ['unsloth/Qwen3.6-27B-GG', 'Unsloth/Qwen3.6-27B-GGUF', ' unsloth/Qwen3.6-27B-GGUF', `${PHRASE} `, 'Qwen3.6-27B-GGUF', null]) {
    expect(errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', t)))
      .toEqual({ code: 'CONFIRM', message: 'The confirmation text did not match.' });
  }
  expect(await treeDigest(fx.root)).toEqual(before);
  const r = unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE));
  expect(r).toMatchObject({ ok: true, mode: 'permanent', purpose: 'delete', freedBytesPlanned: 5380, heldBytes: 0, error: null,
    followUp: null, totalOps: expect.any(Number), notes: [] });
  expect(r.appliedOps).toBe(r.totalOps);
  expect(existsSync(fx.repo(Q).file('BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf'))).toBe(false);
  expect(existsSync(fx.repo(Q).file('Qwen3.6-27B-Q8_0.gguf'))).toBe(true);
});

test('mode mismatch, or a confirm text for a plan without a phrase, is INVALID_INPUT and consumes nothing', async () => {
  const { fx, svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  const hold = pair.hold!;
  const before = await treeDigest(fx.root);
  expect(errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'hold', null)).code).toBe('INVALID_INPUT');
  expect(errorOf(await svc.executePlan(hold.planId, hold.fingerprint, 'permanent', PHRASE)).code).toBe('INVALID_INPUT');
  expect(errorOf(await svc.executePlan(hold.planId, hold.fingerprint, 'hold', '')).code).toBe('INVALID_INPUT');
  expect(await treeDigest(fx.root)).toEqual(before);
  expect(unwrap(await svc.executePlan(hold.planId, hold.fingerprint, 'hold', null)).ok).toBe(true);
});

test('an unknown plan id or a wrong fingerprint is refused before anything runs', async () => {
  const { fx, svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  const before = await treeDigest(fx.root);
  expect(errorOf(await svc.executePlan('6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', pair.permanent.fingerprint, 'permanent', PHRASE)).code)
    .toBe('UNKNOWN_PLAN');
  expect(errorOf(await svc.executePlan(pair.permanent.planId, 'a'.repeat(64), 'permanent', PHRASE)))
    .toEqual({ code: 'FINGERPRINT', message: REVIEW_AGAIN });
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('hold moves exactly the reviewed files, reports 0 freed now, and consumes the sibling', async () => {
  const { fx, svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0', 'quant:BF16')));
  expect(pair.hold).not.toBeNull();
  expect(pair.holdUnavailableReason).toBeNull();
  expect(pair.hold!.freedBytes).toBe(8250);
  const r = unwrap(await svc.executePlan(pair.hold!.planId, pair.hold!.fingerprint, 'hold', null));
  expect(r).toMatchObject({ ok: true, mode: 'hold', purpose: 'delete', heldBytes: 8250, followUp: null });
  expect(lstatSync(fx.repo(Q).file('Qwen3.6-27B-UD-Q4_K_XL.gguf')).isSymbolicLink()).toBe(true);
  expect(existsSync(fx.repo(Q).file('Qwen3.6-27B-Q8_0.gguf'))).toBe(false);
  expect(existsSync(join(fx.lmstudioRoot, Q, 'Qwen3.6-27B-Q8_0.gguf'))).toBe(false);
  expect(lstatSync(join(fx.lmstudioRoot, Q, 'mmproj-F16.gguf')).isSymbolicLink()).toBe(true);   // keep-shared
  const again = errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE));
  expect(again.code).toBe('USED');
  const held = unwrap(await svc.listHeld());
  expect(held).toMatchObject({ available: true, unavailableReason: null, totalBytes: 8250, autoEmptyDays: 14,
    items: [{ status: 'held', error: null, repoIds: [Q], bytes: 8250, heldAtMs: T0, otherEntries: 0 }] });
  expect(held.items[0]!.groupLabels).toHaveLength(2);
  expect(heldIds(join(await realpath(fx.hubRoot), '..', '.hf-cache-manager', 'recently-deleted'))).toEqual([held.items[0]!.deletionId]);
});

test('stale plan: a blob changed after review aborts with the exact message and touches nothing', async () => {
  const { fx, svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  await appendFile(fx.repo(Q).blobOf('Qwen3.6-27B-Q8_0.gguf'), 'x');   // test-side mutation in tmp
  const before = await cacheDigest(fx.root);
  const r = await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE);
  expect(r).toMatchObject({ ok: true, data: { ok: false, error: { code: 'STALE', message: REVIEW_AGAIN }, appliedOps: 0 } });
  expect(await cacheDigest(fx.root)).toEqual(before);
  // the plan was taken: it cannot be retried, only reviewed again
  expect(errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).code).toBe('UNKNOWN_PLAN');
  const again = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  expect(unwrap(await svc.executePlan(again.permanent.planId, again.permanent.fingerprint, 'permanent', PHRASE)).ok).toBe(true);
});

test('second execute of the same plan is refused; the sibling is USED', async () => {
  const { fx, svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  expect(unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).ok).toBe(true);
  const before = await treeDigest(fx.root);
  expect(errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).code).toBe('UNKNOWN_PLAN');
  expect(errorOf(await svc.executePlan(pair.hold!.planId, pair.hold!.fingerprint, 'hold', null)).code).toBe('USED');
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('a double-click runs the plan exactly once', async () => {
  const { svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  const go = (): Promise<ApiResult<ExecResultDTO>> => svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE);
  const results = await Promise.all([go(), go(), go()]);
  expect(results.filter((r) => r.ok && r.data.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok).map((r) => errorOf(r).code).sort()).toEqual(['BUSY', 'BUSY']);
});

test('a lock left with this process\'s pid is reported as a stale own lock with the lock path', async () => {
  const { fx, svc } = await app();
  const lockDir = join(dirname(await realpath(fx.hubRoot)), '.hf-cache-manager');
  await mkdir(lockDir);
  const lockPath = join(lockDir, 'app.lock');
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, at: T0 - 1 })}\n`);
  const before = await treeDigest(fx.hubRoot);
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  const r = unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE));
  expect(r.ok).toBe(false);
  expect(r.error).toEqual({ code: 'LOCKED', message: `Another operation is in progress (process ${process.pid}).`, detailPath: lockPath, staleOwnLock: true });
  expect(await treeDigest(fx.hubRoot)).toEqual(before);
});

test('a lock held by another live process is LOCKED without the stale-own flag', async () => {
  const { fx, svc } = await app();
  const lockDir = join(dirname(await realpath(fx.hubRoot)), '.hf-cache-manager');
  await mkdir(lockDir);
  const lockPath = join(lockDir, 'app.lock');
  await writeFile(lockPath, `${JSON.stringify({ pid: 1, at: T0 - 1 })}\n`); // pid 1 is always alive
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  const r = unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE));
  expect(r.error).toEqual({ code: 'LOCKED', message: 'Another operation is in progress (process 1).', detailPath: lockPath });
});

test('a plan past its 10 minutes is EXPIRED with the review-again copy; nothing runs', async () => {
  const { fx, svc, clock } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  clock.t = pair.permanent.expiresAt;
  const before = await treeDigest(fx.root);
  expect(errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)))
    .toEqual({ code: 'EXPIRED', message: 'This plan expired — please review again.' });
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('execute while a scan runs is BUSY and the plan stays usable', async () => {
  const g = gatedRunner();
  const { svc } = await app({ scanRunner: g.runner });
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  g.block();
  const scanning = svc.scan();
  expect(errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).code).toBe('BUSY');
  g.release();
  await scanning;
  // the scan saw nothing change, so the reviewed plan still runs
  expect(unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).ok).toBe(true);
});

test('execute rescans afterwards: the library and a new review see the change', async () => {
  const { svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE));
  expect(errorOf(await svc.planDelete(sel('quant:Q8_0')))).toMatchObject({ code: 'NOT_FOUND' });
});

test('a missing app data folder refuses execute before anything runs; the plan stays usable', async () => {
  const { fx, svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  const moved = `${fx.userDataDir}-away`;
  await rename(fx.userDataDir, moved);
  const before = await treeDigest(fx.hubRoot);
  expect(errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).code).toBe('INTERNAL');
  expect(await treeDigest(fx.hubRoot)).toEqual(before);
  await rename(moved, fx.userDataDir);
  expect(unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).ok).toBe(true);
});

// ---------------------------------------------------------------- held payloads

test('Delete Permanently warns when it removes a store payload a held deletion needs; the hold review warns too', async () => {
  const { svc } = await app();
  await holdOf(svc, whole('org/shared-a'));   // payload kept in the hub: shared-b still references it
  const id = unwrap(await svc.listHeld()).items[0]!.deletionId;
  const pair = unwrap(await svc.planDelete(whole('org/shared-b')));
  const needs = (p: PlanDTO): string[] => p.warnings.filter((w) => w.includes(`org/shared-a (${id}) in Recently Deleted needs shared store/`));
  expect(needs(pair.permanent)).toHaveLength(1);
  expect(needs(pair.permanent)[0]).toMatch(/to be restored; Delete Permanently removes it for good\.$/);
  expect(pair.hold).not.toBeNull();
  expect(needs(pair.hold!)).toHaveLength(1);
  expect(needs(pair.hold!)[0]).toMatch(/to be restored; it moves into this deletion, so restore this one first\.$/);
  // nothing held needs FLUX's files
  const other = unwrap(await svc.planDelete(whole(FLUX)));
  expect(other.permanent.warnings.some((w) => w.includes('Recently Deleted needs'))).toBe(false);
});

// ---------------------------------------------------------------- restore and empty

test('restore returns files byte-identical and offers sync', async () => {
  const { fx, svc } = await app();
  await svc.scan();
  const before = await treeDigest(fx.hubRoot);
  await holdOf(svc, sel('quant:Q8_0'));
  expect(await treeDigest(fx.hubRoot)).not.toEqual(before);
  const id = unwrap(await svc.listHeld()).items[0]!.deletionId;
  const plan = unwrap(await svc.planRestore(id));
  expect(plan).toMatchObject({ purpose: 'restore', mode: 'hold', confirmPhrase: null });
  const r = unwrap(await svc.executePlan(plan.planId, plan.fingerprint, plan.mode, plan.confirmPhrase));
  expect(r).toMatchObject({ ok: true, purpose: 'restore', followUp: 'offer-sync' });
  expect(await treeDigest(fx.hubRoot)).toEqual(before);
  expect(unwrap(await svc.listHeld()).items).toEqual([]);
  expect(errorOf(await svc.executePlan(plan.planId, plan.fingerprint, plan.mode, null)).code).toBe('UNKNOWN_PLAN');
});

test('planRestore/planEmpty reject deletionIds not in the hold listing', async () => {
  const { fx, svc } = await app();
  const before = await treeDigest(fx.root);
  const unknown = '2026-10-25T14-03-07-123Z-1a2b3c4d';
  expect(errorOf(await svc.planRestore(unknown)).code).toBe('NOT_FOUND');
  expect(errorOf(await svc.planEmpty({ deletionId: unknown })).code).toBe('NOT_FOUND');
  expect(unwrap(await svc.planEmpty({ all: true }))).toEqual({ plans: [], skipped: [], freedBytes: 0, apparentBytes: 0, sharedBytes: 0 });
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('hold unavailable: listHeld says why; restore and empty are NOT_FOUND with that reason', async () => {
  const fx = await buildAppFixture();
  created.push(fx);
  const base = servicesFor(fx, { t: T0 });
  const port: CorePort = {
    ...base.port,
    roots: async (hub, config) => {
      const r = await base.port.roots(hub, config);
      return { ...r, roots: { ...r.roots, holdRoot: null }, holdUnavailableReason: 'Recently Deleted is on a different drive' };
    },
  };
  const { svc } = servicesFor(fx, { t: T0 }, { port });
  expect(unwrap(await svc.listHeld())).toMatchObject({ available: false, unavailableReason: 'Recently Deleted is on a different drive', items: [] });
  expect(errorOf(await svc.planEmpty({ all: true }))).toEqual({ code: 'NOT_FOUND', message: 'Recently Deleted is on a different drive' });
  expect(errorOf(await svc.planRestore('2026-10-25T14-03-07-123Z-1a2b3c4d'))).toEqual({ code: 'NOT_FOUND', message: 'Recently Deleted is on a different drive' });
  expect(await svc.runAutoEmpty(await allHeld(svc))).toBeNull();
});

test('empty all permanently deletes every held deletion, one plan each, in order', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  await holdOf(svc, sel('quant:BF16'));
  expect(heldIds(holdRoot)).toHaveLength(2);
  const batch = unwrap(await svc.planEmpty({ all: true }));
  expect(batch.plans).toHaveLength(2);
  expect(batch.skipped).toEqual([]);
  expect(batch.plans.every((p) => p.purpose === 'empty' && p.mode === 'permanent' && p.confirmPhrase === null)).toBe(true);
  expect(batch.freedBytes).toBe(batch.plans.reduce((n, p) => n + p.freedBytes, 0));
  expect(batch.sharedBytes).toBe(batch.plans.reduce((n, p) => n + p.sharedBytes, 0));
  expect(batch.freedBytes).toBeGreaterThan(8250);   // the held payloads plus each manifest
  for (const p of batch.plans) {
    const r = unwrap(await svc.executePlan(p.planId, p.fingerprint, p.mode, p.confirmPhrase));
    expect(r).toMatchObject({ ok: true, purpose: 'empty', followUp: null });
  }
  expect(unwrap(await svc.listHeld())).toMatchObject({ totalBytes: 0, items: [] });
  expect(heldIds(holdRoot)).toEqual([]);
  expect(existsSync(fx.repo(Q).file('Qwen3.6-27B-UD-Q4_K_XL.gguf'))).toBe(true);
});

test('a later empty plan that went STALE touched nothing and is planned and reviewed again, never run unreviewed', async () => {
  const { fx, svc, holdRoot } = await app();
  // Q6_K and org/dupe's model.safetensors are hardlinks of one inode: emptying one changes the other's nlink
  await holdOf(svc, sel('quant:Q6_K'));
  await holdOf(svc, whole('org/dupe'));
  const batch = unwrap(await svc.planEmpty({ all: true }));
  expect(batch.plans).toHaveLength(2);
  const [first, second] = batch.plans as [PlanDTO, PlanDTO];
  expect(unwrap(await svc.executePlan(first.planId, first.fingerprint, 'permanent', null)).ok).toBe(true);
  const before = await treeDigest(fx.root);
  const r = unwrap(await svc.executePlan(second.planId, second.fingerprint, 'permanent', null));
  expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE', message: REVIEW_AGAIN } });
  expect(await treeDigest(fx.root)).toEqual(before);
  expect(heldIds(holdRoot)).toHaveLength(1);
  const again = unwrap(await svc.planEmpty({ deletionId: heldIds(holdRoot)[0]! }));
  expect(again.plans).toHaveLength(1);
  expect(again.plans[0]!.freedBytes).toBeGreaterThanOrEqual(SIZES.qQ6);   // now the last link: it frees the payload
  const p = again.plans[0]!;
  expect(unwrap(await svc.executePlan(p.planId, p.fingerprint, 'permanent', null)).ok).toBe(true);
  expect(heldIds(holdRoot)).toEqual([]);
});

// ---------------------------------------------------------------- auto-empty

test('auto-empty runs only for items older than the setting', async () => {
  const { fx, svc, clock, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const id = unwrap(await svc.listHeld()).items[0]!.deletionId;
  const manifestBytes = (await lstat(join(holdRoot, id, 'manifest.json'))).size;
  clock.t = T0 + 13 * DAY_MS;
  expect(await svc.runAutoEmpty(await allHeld(svc))).toEqual({ count: 0, freedBytes: 0 });
  expect(heldIds(holdRoot)).toEqual([id]);
  clock.t = T0 + 15 * DAY_MS;
  expect(await svc.runAutoEmpty(await allHeld(svc))).toEqual({ count: 1, freedBytes: SIZES.qQ8 + manifestBytes });
  expect(unwrap(await svc.listHeld()).items).toEqual([]);
  expect(heldIds(holdRoot)).toEqual([]);
  expect(unwrap(await svc.scan()).lastAutoEmpty).toEqual({ at: T0 + 15 * DAY_MS, count: 1, freedBytes: SIZES.qQ8 + manifestBytes, days: 14 });
  expect(existsSync(fx.repo(Q).file('Qwen3.6-27B-UD-Q4_K_XL.gguf'))).toBe(true);
});

test('auto-empty set to Never does nothing, even for an item 30 days old', async () => {
  const { svc, clock, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  unwrap(await svc.setAutoEmptyDays(null));
  expect(unwrap(await svc.listHeld()).autoEmptyDays).toBeNull();
  clock.t = T0 + 30 * DAY_MS;
  expect(await svc.runAutoEmpty(await allHeld(svc))).toBeNull();
  expect(heldIds(holdRoot)).toHaveLength(1);
  unwrap(await svc.setAutoEmptyDays(7));
  expect(unwrap(await svc.listHeld()).autoEmptyDays).toBe(7);
  expect(await svc.runAutoEmpty(await allHeld(svc))).toMatchObject({ count: 1 });
});

test('an unreadable settings.json keeps auto-empty off (fail safe)', async () => {
  const { fx, svc, clock, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  await writeFile(join(fx.userDataDir, 'settings.json'), '{ not json');
  clock.t = T0 + 30 * DAY_MS;
  expect(await svc.runAutoEmpty(await allHeld(svc))).toBeNull();
  expect(heldIds(holdRoot)).toHaveLength(1);
  expect(await readFile(join(fx.userDataDir, 'settings.json'), 'utf8')).toBe('{ not json');
});

/** A fake timer: records what the services schedule; a test fires it by hand. */
function fakeTimers(): { schedule: Scheduler; timers: Array<{ run: () => Promise<void>; ms: number; cancelled: boolean }> } {
  const timers: Array<{ run: () => Promise<void>; ms: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (run, ms) => {
      const t = { run, ms, cancelled: false };
      timers.push(t);
      return { cancel: () => { t.cancelled = true; } };
    },
  };
}
const pendingMessage = (n: number, days: number, bytes: number, emptyAt: number | null = null): string =>
  `${n} item(s) in Recently Deleted are older than ${days} days and will be emptied ${emptyAt === null ? 'in 10 minutes' : `at ${new Date(emptyAt).toLocaleTimeString()}`} (${formatBytes(bytes)} freed). `
  + 'Open Recently Deleted to restore any you want to keep. Dismiss to keep them for this session.';

test('the first good scan of a start only schedules auto-empty, with a notice; it runs 10 minutes later and rescans', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q6_K'));   // a hardlink of org/dupe's blob: emptying it changes that blob's nlink
  const id = heldIds(holdRoot)[0]!;
  const manifestBytes = (await lstat(join(holdRoot, id, 'manifest.json'))).size;
  // a new app start 15 days later
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
  const lib = unwrap(await next.scan());
  expect(lib).toMatchObject({ heldCount: 1, lastAutoEmpty: null });
  expect(heldIds(holdRoot)).toEqual([id]);   // nothing emptied yet
  expect(ft.timers).toEqual([]);   // The countdown starts only when the notice is delivered
  expect(AUTO_EMPTY_GRACE_MS).toBe(10 * 60_000);
  const notices = unwrap(await next.startupNotices());
  expect(ft.timers.map((t) => t.ms)).toEqual([AUTO_EMPTY_GRACE_MS]);
  unwrap(await next.startupNotices());   // a second delivery does not start a second countdown
  expect(ft.timers).toHaveLength(1);
  expect(notices).toContainEqual({
    kind: 'auto-empty-pending', id: 'auto-empty-pending', emptyAt: clock.t + AUTO_EMPTY_GRACE_MS,
    message: pendingMessage(1, 14, manifestBytes, clock.t + AUTO_EMPTY_GRACE_MS),
  });
  // before: the dupe blob has another link (the held one), so deleting org/dupe does not free it
  const freedBefore = unwrap(await next.previewSelection(whole('org/dupe'))).freedBytes;
  expect(freedBefore).toBeLessThan(SIZES.qQ6);
  await ft.timers[0]!.run();
  expect(heldIds(holdRoot)).toEqual([]);
  expect(unwrap(await next.startupNotices()).some((n) => n.kind === 'auto-empty-pending')).toBe(false);
  // The model was rescanned, so the same preview now frees the payload too
  expect(unwrap(await next.previewSelection(whole('org/dupe'))).freedBytes).toBe(freedBefore + SIZES.qQ6);
  expect(unwrap(await next.scan())).toMatchObject({ heldCount: 0, lastAutoEmpty: { at: clock.t, count: 1, freedBytes: manifestBytes } });
  // later scans of the same start never schedule again
  await holdOf(next, sel('quant:BF16'));
  clock.t += 30 * DAY_MS;
  unwrap(await next.scan());
  expect(ft.timers).toHaveLength(1);
  expect(heldIds(holdRoot)).toHaveLength(1);
});

test('an injected grace period (the guarded E2E override) sets both the countdown and the deadline', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule, autoEmptyGraceMs: 4000 }).svc;
  unwrap(await next.scan());
  const notices = unwrap(await next.startupNotices());
  expect(ft.timers.map((t) => t.ms)).toEqual([4000]);
  expect(notices.find((n) => n.kind === 'auto-empty-pending')).toMatchObject({ emptyAt: clock.t + 4000 });
  expect(heldIds(holdRoot)).toHaveLength(1);
});

test('dismissing the pending notice cancels auto-empty for the session', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
  unwrap(await next.scan());
  await next.startupNotices();
  expect(unwrap(await next.ackStartupNotice('auto-empty-pending'))).toBeNull();
  expect(ft.timers[0]!.cancelled).toBe(true);
  await ft.timers[0]!.run();   // even a timer that fires anyway does nothing
  expect(await next.runAutoEmpty(await allHeld(next))).toBeNull();
  expect(heldIds(holdRoot)).toHaveLength(1);
  expect(unwrap(await next.startupNotices()).some((n) => n.kind === 'auto-empty-pending')).toBe(false);
});

test('the due set is computed again when the timer fires: a restored deletion is not emptied', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
  unwrap(await next.scan());
  await next.startupNotices();
  const before = await treeDigest(fx.hubRoot);
  const plan = unwrap(await next.planRestore(heldIds(holdRoot)[0]!));
  expect(unwrap(await next.executePlan(plan.planId, plan.fingerprint, plan.mode, null)).ok).toBe(true);
  await ft.timers[0]!.run();
  expect(existsSync(fx.repo(Q).file('Qwen3.6-27B-Q8_0.gguf'))).toBe(true);
  expect(await treeDigest(fx.hubRoot)).not.toEqual(before);   // restored, not emptied
  expect(unwrap(await next.scan()).lastAutoEmpty).toBeNull();
});

test('a timer that fires while an operation runs waits and retries; the guards still apply', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const g = gatedRunner();
  const next = servicesFor(fx, clock, { schedule: ft.schedule, scanRunner: g.runner }).svc;
  unwrap(await next.scan());
  await next.startupNotices();
  g.block();
  const scanning = next.scan();
  await ft.timers[0]!.run();
  expect(heldIds(holdRoot)).toHaveLength(1);
  expect(ft.timers.map((t) => t.ms)).toEqual([AUTO_EMPTY_GRACE_MS, AUTO_EMPTY_RETRY_MS]);
  g.release();
  await scanning;
  // No app data folder, no run (and no retry)
  const moved = `${fx.userDataDir}-away`;
  await rename(fx.userDataDir, moved);
  await ft.timers[1]!.run();
  expect(heldIds(holdRoot)).toHaveLength(1);
  expect(await next.runAutoEmpty(await allHeld(next))).toBeNull();
  await rename(moved, fx.userDataDir);
  expect(await next.runAutoEmpty(await allHeld(next))).toMatchObject({ count: 1 });
  expect(heldIds(holdRoot)).toEqual([]);
});

test('a clock that looks wrong turns auto-empty off for the session, with a notice', async () => {
  for (const [offset, why] of [[-2 * DAY_MS, 'a deletion is dated in the future'], [400 * DAY_MS, 'the newest deletion is more than a year old']] as const) {
    const { fx, svc, holdRoot } = await app();
    await holdOf(svc, sel('quant:Q8_0'));
    const clock = { t: T0 + offset };
    const ft = fakeTimers();
    const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
    unwrap(await next.scan());
    expect(ft.timers).toEqual([]);
    expect(unwrap(await next.startupNotices())).toContainEqual({ kind: 'auto-empty-skipped', id: 'auto-empty-skipped',
      message: `Automatic emptying of Recently Deleted is off for this session: ${why}, so the system clock may be wrong. Check the date and time.` });
    expect(await next.runAutoEmpty(await allHeld(next))).toBeNull();
    expect(heldIds(holdRoot)).toHaveLength(1);
    expect(unwrap(await next.ackStartupNotice('auto-empty-skipped'))).toBeNull();
    expect(unwrap(await next.startupNotices()).some((n) => n.kind === 'auto-empty-skipped')).toBe(false);
  }
});

test('a failed or hub-missing first scan does not use up the start: the first good scan schedules, once', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  let mode: 'fail' | 'ok' = 'fail';
  const runner: ScanRunner = (hub, p, s) => (mode === 'fail' ? Promise.reject(new Error('EACCES: boom')) : inProcessScanRunner(hub, p, s));
  const next = servicesFor(fx, clock, { schedule: ft.schedule, scanRunner: runner }).svc;
  expect(unwrap(await next.scan()).scanError).not.toBeNull();
  expect(ft.timers).toEqual([]);
  mode = 'ok';
  unwrap(await next.scan());
  unwrap(await next.scan());
  await next.startupNotices();
  expect(ft.timers).toHaveLength(1);
  await ft.timers[0]!.run();
  expect(heldIds(holdRoot)).toEqual([]);
});

test('if the pending notice is never delivered, auto-empty never runs, however long the app stays open', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
  unwrap(await next.scan());
  clock.t += 60 * 60_000;   // an hour later
  unwrap(await next.scan());
  expect(ft.timers).toEqual([]);
  expect(await next.runAutoEmpty(new Set())).toMatchObject({ count: 0 });
  expect(heldIds(holdRoot)).toHaveLength(1);
  // delivered: now the 10-minute countdown exists and empties
  await next.startupNotices();
  expect(ft.timers.map((t) => t.ms)).toEqual([AUTO_EMPTY_GRACE_MS]);
  await ft.timers[0]!.run();
  expect(heldIds(holdRoot)).toEqual([]);
});

test('defaultSchedule runs after the delay and can be cancelled (fake timers)', () => {
  vi.useFakeTimers();
  try {
    let runs = 0;
    defaultSchedule(async () => { runs++; }, AUTO_EMPTY_GRACE_MS);
    const cancelled = defaultSchedule(async () => { runs += 10; }, AUTO_EMPTY_GRACE_MS);
    cancelled.cancel();
    vi.advanceTimersByTime(AUTO_EMPTY_GRACE_MS - 1);
    expect(runs).toBe(0);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test('formatBytes uses decimal units', () => {
  expect([0, 999, 1000, 8250, 1_500_000, 2e9, 3.2e12].map(formatBytes)).toEqual(['0 B', '999 B', '1.0 kB', '8.3 kB', '1.5 MB', '2.0 GB', '3.2 TB']);
});

test('auto-empty does not run after a failed scan, nor while a scan or an operation runs', async () => {
  const fx = await buildAppFixture();
  created.push(fx);
  const clock = { t: T0 };
  const g = gatedRunner();
  const svc = servicesFor(fx, clock, { scanRunner: g.runner }).svc;
  await holdOf(svc, sel('quant:Q8_0'));   // the first scan ran at T0: nothing was due
  const holdRoot = holdRootFor(await realpath(fx.hubRoot));
  clock.t = T0 + 30 * DAY_MS;
  // while a scan runs
  g.block();
  const scanning = svc.scan();
  expect(await svc.runAutoEmpty(await allHeld(svc))).toBeNull();
  expect(heldIds(holdRoot)).toHaveLength(1);
  g.release();
  await scanning;   // not the first scan of this start: it empties nothing
  expect(heldIds(holdRoot)).toHaveLength(1);
  // while an execute runs (its rescan is held open)
  const pair = unwrap(await svc.planDelete(sel('quant:BF16')));
  g.block();
  const executing = svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE);
  expect(await svc.runAutoEmpty(await allHeld(svc))).toBeNull();
  expect(heldIds(holdRoot)).toHaveLength(1);
  g.release();
  expect(unwrap(await executing).ok).toBe(true);
  // a failed scan keeps no model: nothing is emptied
  const runner: ScanRunner = () => Promise.reject(new Error('EACCES: scan boom'));
  const failing = servicesFor(fx, clock, { scanRunner: runner }).svc;
  expect(unwrap(await failing.scan()).scanError).not.toBeNull();
  expect(await failing.runAutoEmpty(await allHeld(failing))).toBeNull();
  expect(heldIds(holdRoot)).toHaveLength(1);
  // idle, with a good scan: it runs
  expect(await svc.runAutoEmpty(await allHeld(svc))).toMatchObject({ count: 1 });
  expect(heldIds(holdRoot)).toEqual([]);
});

test('auto-empty stops at the first failure and leaves the later deletions for the next run', async () => {
  const { svc, clock, holdRoot } = await app();
  // oldest first: Q6_K, then org/dupe (a hardlink of the same inode: it goes STALE once Q6_K is emptied), then Q8_0
  await holdOf(svc, sel('quant:Q6_K'));
  clock.t = T0 + 1000;
  await holdOf(svc, whole('org/dupe'));
  clock.t = T0 + 2000;
  await holdOf(svc, sel('quant:Q8_0'));
  expect(heldIds(holdRoot)).toHaveLength(3);
  clock.t = T0 + 15 * DAY_MS;
  expect(await svc.runAutoEmpty(await allHeld(svc))).toMatchObject({ count: 1 });
  const left = unwrap(await svc.listHeld()).items;
  expect(left.map((i) => i.repoIds)).toEqual([[Q], ['org/dupe']]);   // newest first: Q8_0 never ran
  // the next run plans again from the disk and finishes
  expect(await svc.runAutoEmpty(await allHeld(svc))).toMatchObject({ count: 2 });
  expect(heldIds(holdRoot)).toEqual([]);
});

test('a missing hub: no auto-empty, Recently Deleted unavailable, planning HUB_MISSING', async () => {
  const fx = await buildAppFixture();
  created.push(fx);
  const { svc } = servicesFor(fx, { t: T0 }, { env: { ...fx.env } }, { env: { ...fx.env, HF_HUB_CACHE: join(fx.root, 'nope') } });
  expect(unwrap(await svc.scan()).hubPresent).toBe(false);
  expect(await svc.runAutoEmpty(await allHeld(svc))).toBeNull();
  expect(unwrap(await svc.listHeld())).toMatchObject({ available: false, items: [] });
  expect(errorOf(await svc.planDelete(sel('quant:Q8_0'))).code).toBe('HUB_MISSING');
  expect(errorOf(await svc.planEmpty({ all: true })).code).toBe('HUB_MISSING');
});


// ---------------------------------------------------------------- edge cases

test('when Recently Deleted cannot be read, the permanent plan says so', async () => {
  const fx = await buildAppFixture();
  created.push(fx);
  const base = servicesFor(fx, { t: T0 });
  const broken: CorePort = { ...base.port, listHeld: () => Promise.reject(new Error('EIO: held boom')) };
  const a = servicesFor(fx, { t: T0 }, { port: broken }).svc;
  const pair = unwrap(await a.planDelete(whole('org/shared-b')));
  expect(pair.permanent.warnings).toContain(HELD_UNREADABLE_WARNING('EIO: held boom'));
  // hold unavailable: held deletions on disk cannot be listed either
  const noHold: CorePort = {
    ...base.port,
    roots: async (hub, config) => {
      const r = await base.port.roots(hub, config);
      return { ...r, roots: { ...r.roots, holdRoot: null }, holdUnavailableReason: 'Recently Deleted is on a different drive' };
    },
  };
  const b = servicesFor(fx, { t: T0 }, { port: noHold }).svc;
  const p2 = unwrap(await b.planDelete(whole('org/shared-b')));
  expect(p2.hold).toBeNull();
  expect(p2.permanent.warnings).toContain(HELD_UNREADABLE_WARNING('Recently Deleted is on a different drive'));
});

test('config.toml broken between review and execute: CONFIG, nothing runs, the plan stays usable', async () => {
  const { fx, svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  const good = await readFile(fx.configFile, 'utf8');
  await writeFile(fx.configFile, '[views.lmstudio\nroot = ');
  const before = await treeDigest(fx.hubRoot);
  expect(errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).code).toBe('CONFIG');
  expect(await treeDigest(fx.hubRoot)).toEqual(before);
  await writeFile(fx.configFile, good);
  expect(unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).ok).toBe(true);
});

test('hub gone between review and execute: HUB_MISSING, nothing runs, the plan stays usable', async () => {
  const { fx, svc } = await app();
  const pair = unwrap(await svc.planDelete(sel('quant:Q8_0')));
  const away = `${fx.hubRoot}-unmounted`;
  await rename(fx.hubRoot, away);
  const before = await treeDigest(away);
  expect(errorOf(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).code).toBe('HUB_MISSING');
  expect(await treeDigest(away)).toEqual(before);
  await rename(away, fx.hubRoot);
  expect(unwrap(await svc.executePlan(pair.permanent.planId, pair.permanent.fingerprint, 'permanent', PHRASE)).ok).toBe(true);
});

test('an id shared by a model and a dataset cannot be planned', async () => {
  const base = await buildFixture({ repos: [
    { id: 'o/x', snapshots: [{ commit: 'a'.repeat(40), files: [{ path: 'config.json', blob: { key: 'm', bytes: 5 } }] }] },
    { id: 'o/x', type: 'dataset', snapshots: [{ commit: 'b'.repeat(40), files: [{ path: 'data.json', blob: { key: 'd', bytes: 7 } }] }] },
  ] });
  try {
    const userDataDir = join(base.root, 'userdata');
    await mkdir(userDataDir);
    const { svc } = servicesFor({ userDataDir, env: base.env, home: base.home }, { t: T0 });
    const before = await treeDigest(base.root);
    const results: Array<ApiResult<unknown>> = [await svc.planDelete(whole('o/x')), await svc.previewSelection(whole('o/x'))];
    for (const r of results) {
      expect(errorOf(r)).toEqual({ code: 'INVALID_INPUT', message: 'Two repos share this id (model and dataset); deletion is disabled for them in this version.' });
    }
    expect(await treeDigest(base.root)).toEqual(before);
  } finally {
    await base.dispose();
  }
});

// ---------------------------------------------------------------- auto-empty edge cases

/** A new app start 15 days after T0 whose port can run a hook (a dismissal) at one point of the auto-empty run. */
function hookedStart(fx: AppFixture, clock: Clock, hook: { at: 'listHeld' | 'planEmpty' | 'afterFirstExecute' | null; run: () => Promise<void> }):
  { svc: AppServices; ft: ReturnType<typeof fakeTimers>; executed: string[]; plannedAfterArm: { n: number }; arm(): void } {
  const ft = fakeTimers();
  const executed: string[] = [];
  const plannedAfterArm = { n: 0 };
  let started = false;
  const base = servicesFor(fx, clock).port;
  let armed = false;
  const fire = async (at: string): Promise<void> => {
    if (armed && hook.at === at) { armed = false; await hook.run(); }
  };
  const port: CorePort = {
    ...base,
    listHeld: async (r) => { const out = await base.listHeld(r); await fire('listHeld'); return out; },
    planEmpty: async (r, t, now) => {
      if (started) plannedAfterArm.n++;
      const out = await base.planEmpty(r, t, now);
      await fire('planEmpty');
      return out;
    },
    executePlan: async (plan, model, r) => {
      const res = await base.executePlan(plan, model, r);
      if (plan.purpose === 'empty') { executed.push(plan.deletionId!); await fire('afterFirstExecute'); }
      return res;
    },
  };
  const svc = servicesFor(fx, clock, { port, schedule: ft.schedule }).svc;
  return { svc, ft, executed, plannedAfterArm, arm: () => { armed = true; started = true; } };
}

test('a dismissal at any point of a started run stops every later plan, and says the run had started', async () => {
  for (const at of ['listHeld', 'planEmpty', 'afterFirstExecute'] as const) {
    const { fx, svc } = await app();
    await holdOf(svc, sel('quant:Q8_0'));
    await holdOf(svc, sel('quant:BF16'));
    const holdRoot = holdRootFor(await realpath(fx.hubRoot));
    const clock = { t: T0 + 15 * DAY_MS };
    const acks: Array<ApiResult<null>> = [];
    const h = hookedStart(fx, clock, { at, run: async () => { acks.push(await h.svc.ackStartupNotice('auto-empty-pending')); } });
    unwrap(await h.svc.scan());
    expect(unwrap(await h.svc.startupNotices()).some((n) => n.kind === 'auto-empty-pending')).toBe(true);
    h.arm();
    await h.ft.timers[0]!.run();
    expect(acks.map((a) => (a.ok ? 'ok' : a.error.message)), at).toEqual([AUTO_EMPTY_ALREADY_STARTED]);
    expect(h.executed, at).toHaveLength(at === 'afterFirstExecute' ? 1 : 0);
    expect(h.plannedAfterArm.n, at).toBe(at === 'listHeld' ? 0 : 1);   // dismissed once the due set is known: not even planned
    expect(heldIds(holdRoot), at).toHaveLength(at === 'afterFirstExecute' ? 1 : 2);
    // the session stays off
    expect(await h.svc.runAutoEmpty(await allHeld(h.svc))).toBeNull();
    expect(heldIds(holdRoot), at).toHaveLength(at === 'afterFirstExecute' ? 1 : 2);
  }
});

test('once the run starts the pending notice is retired; a later dismissal is refused with the started copy', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
  unwrap(await next.scan());
  await next.startupNotices();
  await ft.timers[0]!.run();
  expect(heldIds(holdRoot)).toEqual([]);
  expect(unwrap(await next.startupNotices()).some((n) => n.kind === 'auto-empty-pending')).toBe(false);
  expect(errorOf(await next.ackStartupNotice('auto-empty-pending')).message).toBe(AUTO_EMPTY_ALREADY_STARTED);
});

test('only the deletions the notice announced are emptied; one that became due during the grace waits', async () => {
  const { fx, svc, clock: c0, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));        // held at T0
  c0.t = T0 + 2 * DAY_MS;
  await holdOf(svc, sel('quant:BF16'));        // held at T0 + 2 days
  const clock = { t: T0 + 16 * DAY_MS - 60_000 };   // Q8_0 due, BF16 one minute short of 14 days
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
  unwrap(await next.scan());
  const notice = unwrap(await next.startupNotices()).find((n) => n.kind === 'auto-empty-pending');
  expect(notice?.message.startsWith('1 item(s) in Recently Deleted')).toBe(true);
  clock.t += AUTO_EMPTY_GRACE_MS;                // now both are due
  await ft.timers[0]!.run();
  const left = unwrap(await next.listHeld()).items;
  expect(left.map((i) => i.heldAtMs)).toEqual([T0 + 2 * DAY_MS]);
  expect(heldIds(holdRoot)).toHaveLength(1);
});

test('the clock bounds are exact: 1 day ahead and 365 days old are trusted, 1 ms more is not', async () => {
  const { fx, svc } = await app();
  await holdOf(svc, sel('quant:Q8_0'));         // createdAt T0
  const skippedAt = async (t: number): Promise<boolean> => {
    const ft = fakeTimers();
    const s = servicesFor(fx, { t }, { schedule: ft.schedule }).svc;
    unwrap(await s.scan());
    return unwrap(await s.startupNotices()).some((n) => n.kind === 'auto-empty-skipped');
  };
  expect(await skippedAt(T0 - DAY_MS)).toBe(false);
  expect(await skippedAt(T0 - DAY_MS - 1)).toBe(true);
  expect(await skippedAt(T0 + 365 * DAY_MS)).toBe(false);
  expect(await skippedAt(T0 + 365 * DAY_MS + 1)).toBe(true);
});

test('repeated startupNotices() calls keep exactly one timer and an unchanged deadline', async () => {
  const { fx, svc } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
  unwrap(await next.scan());
  const first = unwrap(await next.startupNotices()).find((n) => n.kind === 'auto-empty-pending');
  expect(first).toMatchObject({ emptyAt: clock.t + AUTO_EMPTY_GRACE_MS });
  clock.t += 4 * 60_000;
  for (let i = 0; i < 3; i++) {
    const again = unwrap(await next.startupNotices()).find((n) => n.kind === 'auto-empty-pending');
    expect(again).toEqual(first);   // same deadline and text, however often it is read
  }
  expect(ft.timers).toHaveLength(1);
  expect(ft.timers[0]!.ms).toBe(AUTO_EMPTY_GRACE_MS);
  expect(ft.timers[0]!.cancelled).toBe(false);
});

test('startupNotices() after a dismissal starts no timer and does not return the notice', async () => {
  const { fx, svc } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
  unwrap(await next.scan());
  unwrap(await next.ackStartupNotice('auto-empty-pending'));   // dismissed before it was ever delivered
  for (let i = 0; i < 2; i++) expect(unwrap(await next.startupNotices()).some((n) => n.kind === 'auto-empty-pending')).toBe(false);
  expect(ft.timers).toEqual([]);
});

// ---------------------------------------------------------------- a review withdraws its deletion

/** Two deletions held 15 days before a new start, both announced; the notice delivered (the countdown armed). */
async function twoAnnounced(): Promise<{ fx: AppFixture; holdRoot: string; next: AppServices; ft: ReturnType<typeof fakeTimers>;
  clock: Clock; q8: string; bf16: string; notice: { message: string; emptyAt: number | null } }> {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  const q8 = heldIds(holdRoot)[0]!;
  await holdOf(svc, sel('quant:BF16'));
  const bf16 = heldIds(holdRoot).find((x) => x !== q8)!;
  const clock = { t: T0 + 15 * DAY_MS };
  const ft = fakeTimers();
  const next = servicesFor(fx, clock, { schedule: ft.schedule }).svc;
  unwrap(await next.scan());
  const notice = unwrap(await next.startupNotices()).find((n) => n.kind === 'auto-empty-pending') as { message: string; emptyAt: number | null };
  expect(notice.message.startsWith('2 item(s) in Recently Deleted')).toBe(true);
  expect(ft.timers).toHaveLength(1);
  return { fx, holdRoot, next, ft, clock, q8, bf16, notice };
}

test('opening a restore review withdraws that deletion from the auto-empty run; the other is still emptied', async () => {
  const { fx, holdRoot, next, ft, q8, bf16, notice } = await twoAnnounced();
  const plan = unwrap(await next.planRestore(q8));   // the review is open; the user has not clicked Restore yet
  const after = unwrap(await next.startupNotices()).find((n) => n.kind === 'auto-empty-pending');
  expect(after?.message.startsWith('1 item(s) in Recently Deleted')).toBe(true);
  expect(after?.emptyAt).toBe(notice.emptyAt);   // the deadline is unchanged
  expect(ft.timers).toHaveLength(1);
  expect(ft.timers[0]!.cancelled).toBe(false);
  await ft.timers[0]!.run();
  expect(heldIds(holdRoot)).toEqual([q8]);   // only the other one was emptied
  expect(heldIds(holdRoot)).not.toContain(bf16);
  // the review the user had open still restores
  expect(unwrap(await next.executePlan(plan.planId, plan.fingerprint, plan.mode, null)).ok).toBe(true);
  expect(existsSync(fx.repo(Q).file('Qwen3.6-27B-Q8_0.gguf'))).toBe(true);
});

test('a single-deletion empty review also withdraws it; withdrawing every announced one cancels the timer and retires the notice', async () => {
  const { holdRoot, next, ft, q8, bf16 } = await twoAnnounced();
  unwrap(await next.planEmpty({ deletionId: bf16 }));
  expect(unwrap(await next.startupNotices()).find((n) => n.kind === 'auto-empty-pending')?.message.startsWith('1 item(s)')).toBe(true);
  expect(ft.timers[0]!.cancelled).toBe(false);
  unwrap(await next.planRestore(q8));
  expect(ft.timers[0]!.cancelled).toBe(true);
  expect(unwrap(await next.startupNotices()).some((n) => n.kind === 'auto-empty-pending')).toBe(false);
  await ft.timers[0]!.run();   // a timer that fires anyway empties nothing
  expect(heldIds(holdRoot).sort()).toEqual([q8, bf16].sort());
});

test('"empty all" is not a single-deletion review and withdraws nothing', async () => {
  const { next, ft } = await twoAnnounced();
  unwrap(await next.planEmpty({ all: true }));
  expect(unwrap(await next.startupNotices()).find((n) => n.kind === 'auto-empty-pending')?.message.startsWith('2 item(s)')).toBe(true);
  expect(ft.timers[0]!.cancelled).toBe(false);
});

test('Recently Deleted marks the announced deletions with the run deadline; a review clears the mark', async () => {
  const { next, q8, bf16, notice } = await twoAnnounced();
  const list = unwrap(await next.listHeld());
  expect(list.autoEmptyAt).toBe(notice.emptyAt);
  expect(list.items.map((i) => [i.deletionId, i.pendingAutoEmpty]).sort()).toEqual([[bf16, true], [q8, true]].sort());
  unwrap(await next.planRestore(q8));
  expect(unwrap(await next.listHeld()).items.map((i) => [i.deletionId, i.pendingAutoEmpty]).sort()).toEqual([[bf16, true], [q8, false]].sort());
  unwrap(await next.ackStartupNotice('auto-empty-pending'));   // dismissed: nothing is marked any more
  const after = unwrap(await next.listHeld());
  expect(after.autoEmptyAt).toBeNull();
  expect(after.items.every((i) => !i.pendingAutoEmpty)).toBe(true);
});

test('before the notice is delivered, or with nothing due, no row is marked', async () => {
  const { fx, svc, holdRoot } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  expect(unwrap(await svc.listHeld())).toMatchObject({ autoEmptyAt: null, items: [{ pendingAutoEmpty: false }] });   // not due
  const ft = fakeTimers();
  const next = servicesFor(fx, { t: T0 + 15 * DAY_MS }, { schedule: ft.schedule }).svc;
  unwrap(await next.scan());
  // announced but not yet armed: marked, with no deadline yet
  expect(unwrap(await next.listHeld())).toMatchObject({ autoEmptyAt: null, items: [{ pendingAutoEmpty: true }] });
  await next.startupNotices();
  await ft.timers[0]!.run();
  expect(heldIds(holdRoot)).toEqual([]);
  expect(unwrap(await next.listHeld())).toMatchObject({ autoEmptyAt: null, items: [] });
});

test('a review requested during a started run (answered BUSY) still withdraws its deletion; the run skips it', async () => {
  const { fx, svc } = await app();
  await holdOf(svc, sel('quant:Q8_0'));
  await holdOf(svc, sel('quant:BF16'));
  const holdRoot = holdRootFor(await realpath(fx.hubRoot));
  const clock = { t: T0 + 15 * DAY_MS };
  const replies: Array<ApiResult<unknown>> = [];
  let second = '';
  const h = hookedStart(fx, clock, { at: 'afterFirstExecute', run: async () => {
    second = heldIds(holdRoot).find((x) => x !== h.executed[0])!;
    replies.push(await h.svc.planRestore(second));
  } });
  unwrap(await h.svc.scan());
  unwrap(await h.svc.startupNotices());
  h.arm();
  await h.ft.timers[0]!.run();
  expect(replies.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual(['BUSY']);
  expect(h.executed).toHaveLength(1);
  expect(heldIds(holdRoot)).toEqual([second]);   // not emptied: still held
  const plan = unwrap(await h.svc.planRestore(second));   // and the user can restore it now
  expect(unwrap(await h.svc.executePlan(plan.planId, plan.fingerprint, plan.mode, null)).ok).toBe(true);
  expect(heldIds(holdRoot)).toEqual([]);
});
