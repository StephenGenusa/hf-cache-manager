// "Check for updates": every cached repo is compared with the Hub's main revision, against the loopback fake Hub
// (never the network). Nothing in the cache is written; the findings are kept in settings.json.
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { SafeFs } from '../../src/core/safe-fs';
import { createCorePort } from '../../src/main/core-port';
import { OFFLINE_TEXT } from '../../src/main/download-service';
import { inProcessScanRunner } from '../../src/main/scan-client';
import { AppServices, type ServicesDeps } from '../../src/main/services';
import { HUB_UNREACHABLE_TEXT, PINNED_TEXT } from '../../src/main/update-service';
import type { ApiResult, UpdateCheckProgressDTO } from '../../src/shared/api';
import { buildAppFixture, type AppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';
import { sha256Hex, startFakeHub, type FakeHub, type FakeHubOptions, type FakeHubRepo } from '../helpers/fake-hub';
import { guardedFs } from '../helpers/guarded-fs';
import { treeDigest } from '../helpers/tree-digest';

useCanaries();
beforeEach(() => expect.hasAssertions());

const HUB_COMMIT = 'e7'.repeat(20);
const NEW_CONFIG = new TextEncoder().encode('{"new":true}');
const Q = 'unsloth/Qwen3.6-27B-GGUF';
const FLUX = 'black-forest-labs/FLUX.1-dev';

const created: AppFixture[] = [];
const hubs: FakeHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
  for (const fx of created.splice(0)) await fx.dispose();
});

function unwrap<T>(r: ApiResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

interface World {
  fx: AppFixture; hub: FakeHub; svc: AppServices; events: UpdateCheckProgressDTO[]; sleeps: number[]; env: NodeJS.ProcessEnv;
  again(): AppServices;
}

/**
 * The app fixture's cache (seven repos, all at refs/main) and a Hub that has two of them: bartowski/tiny-GGUF with
 * the same file (current) and org/dupe with a changed config.json (an update). org/shared-b loses its refs/main (pinned).
 */
async function world(o: { env?: NodeJS.ProcessEnv; hub?: FakeHubOptions; over?: Partial<ServicesDeps>; fetch?: (real: typeof fetch) => typeof fetch } = {}): Promise<World> {
  const fx = await buildAppFixture();
  created.push(fx);
  await unlink(join(fx.hubRoot, 'models--org--shared-b', 'refs', 'main'));
  const repos: FakeHubRepo[] = [
    { repoId: 'bartowski/tiny-GGUF', commit: HUB_COMMIT, lfs: ['tiny-Q4_K_M.gguf'], files: { 'tiny-Q4_K_M.gguf': fx.content('tiny'), 'README.md': NEW_CONFIG } },
    { repoId: 'org/dupe', commit: HUB_COMMIT, lfs: ['config.json'], files: { 'config.json': NEW_CONFIG, 'extra-Q4_K_M.gguf': new Uint8Array(9) } },
  ];
  const hub = await startFakeHub(repos, o.hub);
  hubs.push(hub);
  const env: NodeJS.ProcessEnv = { ...fx.env, HF_ENDPOINT: hub.endpoint, HF_TOKEN: 'hf_test_token', ...o.env };
  const events: UpdateCheckProgressDTO[] = [];
  const sleeps: number[] = [];
  const loopback = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${hub.endpoint}/`)) throw new Error(`test tried to reach ${url}`);
    return globalThis.fetch(input, init);
  }) as typeof fetch;
  const build = (): AppServices => new AppServices({
    env, home: fx.home, userDataDir: fx.userDataDir, platform: 'linux', now: () => Date.now(),
    port: createCorePort({ userDataDir: fx.userDataDir, env, home: fx.home, offline: true, makeSafeFs: (roots) => SafeFs.create(roots, guardedFs()) }),
    scanRunner: inProcessScanRunner, emitProgress: () => undefined,
    makeUserSafeFs: (dir) => SafeFs.create({ hubRoot: dir, viewRoots: [], holdRoot: null }, guardedFs()),
    emitUpdateCheck: (p) => events.push(p),
    download: { fetch: o.fetch ? o.fetch(loopback) : loopback, clientSleep: async () => undefined },
    updates: { sleep: async (ms) => { sleeps.push(ms); } },
    ...o.over,
  });
  return { fx, hub, svc: build(), events, sleeps, env, again: build };
}

const byRepo = (w: { results: Array<{ repoId: string }> }) => Object.fromEntries(w.results.map((r) => [r.repoId, r]));

test('a run compares every cached repo with the Hub: updates, failures and pinned repos are reported; nothing in the cache is written', async () => {
  const w = await world();
  unwrap(await w.svc.scan());
  const before = await treeDigest(w.fx.hubRoot);
  expect(unwrap(await w.svc.updateCheck())).toMatchObject({ checkedAt: null, disabledReason: null, error: null, results: [], progress: { running: false } });
  unwrap(await w.svc.updateCheckStart());
  await w.svc.updateCheckIdle();
  const s = unwrap(await w.svc.updateCheck());
  expect(s.progress).toEqual({ running: false, done: 7, total: 7, current: null, waitingUntil: null });
  expect(s.error).toBeNull();
  expect(typeof s.checkedAt).toBe('number');
  const r = byRepo(s);
  // the changed file the cache holds counts; the Hub's new quant (never downloaded) and the README do not
  expect(r['org/dupe']).toMatchObject({ type: 'model', status: 'update', updateFiles: 1, message: null });
  expect(r['bartowski/tiny-GGUF']).toBeUndefined();   // current: no entry
  expect(r['org/shared-b']).toMatchObject({ status: 'skipped', updateFiles: 0, message: PINNED_TEXT });
  for (const id of [Q, FLUX, 'org/shared-a', 'org/partial']) expect(r[id]).toMatchObject({ status: 'failed', message: 'Not found on the Hub' });
  expect(s.results.map((x) => x.repoId)).toEqual([...s.results.map((x) => x.repoId)].sort());
  // one revision request per repo that has a main revision, each with the user's token; no file is fetched
  expect(w.hub.requests.every((q) => /\/api\/models\/[^/]+\/[^/]+\/revision\/main\?blobs=true$/.test(q.url))).toBe(true);
  expect(w.hub.requests).toHaveLength(6);
  expect(w.hub.requests.some((q) => q.url.includes('shared-b'))).toBe(false);
  expect(w.hub.requests.every((q) => q.headers['authorization'] === 'Bearer hf_test_token')).toBe(true);
  expect(await treeDigest(w.fx.hubRoot)).toEqual(before);
  // progress: counts up to the total and ends not running
  expect(w.events.at(-1)).toEqual(s.progress);
  expect(w.events.every((e) => e.total === 7)).toBe(true);
  expect(w.events.map((e) => e.done)).toEqual([...w.events.map((e) => e.done)].sort((a, b) => a - b));
  expect(w.events.some((e) => e.running && e.current !== null)).toBe(true);
});

test('the findings survive a restart, and an update clears itself once its file is in the cache', async () => {
  const w = await world();
  unwrap(await w.svc.updateCheckStart());
  await w.svc.updateCheckIdle();
  const first = unwrap(await w.svc.updateCheck());
  const restarted = w.again();
  const s = unwrap(await restarted.updateCheck());
  expect(s.results).toEqual(first.results);
  expect(s.checkedAt).toBe(first.checkedAt);
  expect(s.progress.running).toBe(false);
  // what a refresh in the Download tab leaves: the Hub's blob and its link in the new snapshot
  const folder = join(w.fx.hubRoot, 'models--org--dupe');
  const etag = sha256Hex(NEW_CONFIG);
  await writeFile(join(folder, 'blobs', etag), NEW_CONFIG);
  await mkdir(join(folder, 'snapshots', HUB_COMMIT), { recursive: true });
  await symlink(join('..', '..', 'blobs', etag), join(folder, 'snapshots', HUB_COMMIT, 'config.json'));
  unwrap(await restarted.scan());
  expect(byRepo(unwrap(await restarted.updateCheck()))['org/dupe']).toBeUndefined();
  expect(byRepo(unwrap(await restarted.updateCheck()))['org/shared-b']).toMatchObject({ status: 'skipped' });
});

test('a rate-limited request waits as long as the Hub asks, shows the wait, then goes on', async () => {
  const w = await world({ hub: { rateLimitFirst: { 'revision:org/dupe': 2 }, rateLimitAfterSec: 3 } });
  unwrap(await w.svc.updateCheckStart());
  await w.svc.updateCheckIdle();
  const s = unwrap(await w.svc.updateCheck());
  expect(byRepo(s)['org/dupe']).toMatchObject({ status: 'update', updateFiles: 1 });
  expect(s.progress).toMatchObject({ running: false, done: 7, total: 7 });
  expect(w.sleeps.filter((ms) => ms > 0 && ms <= 3000).length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...w.sleeps)).toBeLessThanOrEqual(3000);
  expect(w.events.some((e) => e.running && e.waitingUntil !== null)).toBe(true);
});

test('a repo the Hub keeps rate-limiting is reported as not checked, and the run still ends', async () => {
  const w = await world({ hub: { rateLimitFirst: { 'revision:org/dupe': 1000 } } });
  unwrap(await w.svc.updateCheckStart());
  await w.svc.updateCheckIdle();
  const s = unwrap(await w.svc.updateCheck());
  expect(byRepo(s)['org/dupe']).toMatchObject({ status: 'failed', message: expect.stringMatching(/rate-limit/) });
  expect(s.progress).toMatchObject({ running: false, done: 7, total: 7 });
});

test('Cancel stops a running check; what the last finished run found is kept; a second start while one runs is BUSY', async () => {
  let hold = false;
  const w = await world({
    fetch: (real) => ((input, init) => (hold
      ? new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(init.signal!.reason as Error), { once: true }); })
      : real(input, init))) as typeof fetch,
  });
  unwrap(await w.svc.updateCheckStart());
  await w.svc.updateCheckIdle();
  const first = unwrap(await w.svc.updateCheck());
  hold = true;
  unwrap(await w.svc.updateCheckStart());
  expect(await w.svc.updateCheckStart()).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  expect(unwrap(await w.svc.updateCheck()).progress).toMatchObject({ running: true, total: 7 });
  unwrap(await w.svc.updateCheckCancel());
  await w.svc.updateCheckIdle();
  const s = unwrap(await w.svc.updateCheck());
  expect(s.progress.running).toBe(false);
  expect(s.results).toEqual(first.results);
  expect(s.error).toBeNull();
  expect(w.events.at(-1)).toMatchObject({ running: false });
  unwrap(await w.svc.updateCheckCancel());   // nothing running: still fine
});

test('with download mode off the check does not start and says why', async () => {
  const w = await world({ env: { HF_HUB_OFFLINE: '1' } });
  expect(await w.svc.updateCheckStart()).toEqual({ ok: false, error: { code: 'OFFLINE', message: OFFLINE_TEXT } });
  expect(unwrap(await w.svc.updateCheck())).toMatchObject({ disabledReason: OFFLINE_TEXT, results: [], progress: { running: false } });
  expect(w.hub.requests).toEqual([]);
});

test('when the Hub cannot be reached the run stops after three repos in a row, keeps earlier findings and says so', async () => {
  let down = false;
  let calls = 0;
  const w = await world({
    over: { updates: { concurrency: 1, sleep: async () => undefined } },
    fetch: (real) => ((input, init) => { if (!down) return real(input, init); calls += 1; return Promise.reject(new Error('getaddrinfo ENOTFOUND')); }) as typeof fetch,
  });
  unwrap(await w.svc.updateCheckStart());
  await w.svc.updateCheckIdle();
  const first = unwrap(await w.svc.updateCheck());
  down = true;
  unwrap(await w.svc.updateCheckStart());
  await w.svc.updateCheckIdle();
  const s = unwrap(await w.svc.updateCheck());
  expect(s.error).toBe(HUB_UNREACHABLE_TEXT);
  expect(calls).toBe(12);   // three repos, each tried four times by the client
  expect(s.progress.running).toBe(false);
  expect(s.results).toEqual(first.results);   // a repo that could not be asked keeps what was known about it
  expect(JSON.parse(await readFile(join(w.fx.userDataDir, 'settings.json'), 'utf8'))).toHaveProperty('updateCheck.entries');
});

test('one repo can be checked on its own: the changed files are named, the finding is replaced, and it clears once refreshed', async () => {
  const w = await world();
  unwrap(await w.svc.updateCheckStart());
  await w.svc.updateCheckIdle();
  const before = w.hub.requests.length;
  const one = unwrap(await w.svc.updateCheckRepo('org/dupe', 'model'));
  expect(one).toMatchObject({ repoId: 'org/dupe', type: 'model', status: 'update', commit: HUB_COMMIT, message: null,
    files: [{ path: 'config.json', size: NEW_CONFIG.length }] });
  expect(w.hub.requests.slice(before).map((q) => q.url)).toEqual([`${w.hub.endpoint}/api/models/org/dupe/revision/main?blobs=true`]);
  expect(unwrap(await w.svc.updateCheckRepo('bartowski/tiny-GGUF', 'model'))).toMatchObject({ status: 'current', files: [], message: null });
  expect(unwrap(await w.svc.updateCheckRepo('org/shared-b', 'model'))).toMatchObject({ status: 'skipped', message: PINNED_TEXT });
  expect(await w.svc.updateCheckRepo('nope/nothing', 'model')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  // refreshed in the Download tab: the next look at the repo finds it current and drops the saved finding
  const folder = join(w.fx.hubRoot, 'models--org--dupe');
  const etag = sha256Hex(NEW_CONFIG);
  await writeFile(join(folder, 'blobs', etag), NEW_CONFIG);
  await mkdir(join(folder, 'snapshots', HUB_COMMIT), { recursive: true });
  await symlink(join('..', '..', 'blobs', etag), join(folder, 'snapshots', HUB_COMMIT, 'config.json'));
  unwrap(await w.svc.scan());
  expect(unwrap(await w.svc.updateCheckRepo('org/dupe', 'model'))).toMatchObject({ status: 'current', files: [] });
  const saved = JSON.parse(await readFile(join(w.fx.userDataDir, 'settings.json'), 'utf8')) as { updateCheck: { entries: Array<{ repoId: string }> } };
  expect(saved.updateCheck.entries.some((e) => e.repoId === 'org/dupe')).toBe(false);
});

test('a single-repo check that cannot reach the Hub keeps what was known and says why; offline it asks nothing', async () => {
  let down = false;
  const w = await world({ fetch: (real) => ((input, init) => (down ? Promise.reject(new Error('getaddrinfo ENOTFOUND')) : real(input, init))) as typeof fetch });
  unwrap(await w.svc.updateCheckStart());
  await w.svc.updateCheckIdle();
  down = true;
  const one = unwrap(await w.svc.updateCheckRepo('org/dupe', 'model'));
  expect(one).toMatchObject({ status: 'update', commit: HUB_COMMIT, files: [{ path: 'config.json' }], message: expect.stringMatching(/Network error/) });
  expect(byRepo(unwrap(await w.svc.updateCheck()))['org/dupe']).toMatchObject({ status: 'update', updateFiles: 1 });

  const off = await world({ env: { HF_HUB_OFFLINE: '1' } });
  expect(unwrap(await off.svc.updateCheckRepo('org/dupe', 'model'))).toMatchObject({ status: 'failed', files: [], message: OFFLINE_TEXT });
  expect(off.hub.requests).toEqual([]);
});
