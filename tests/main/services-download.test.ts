// Look up → preview → start over the services, against the loopback fake Hub (never the network).
import { lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MachineProfile } from '../../src/core/advice/types';
import { classifyRepo } from '../../src/core/classify/classify';
import { remoteRepo, toRemoteListing } from '../../src/core/download/remote-repo';
import { SafeFs } from '../../src/core/safe-fs';
import { createCorePort } from '../../src/main/core-port';
import {
  ALL_CACHED_TEXT, ALL_QUEUED_TEXT, CHANGED_TEXT, downloadGroups, previewFingerprint, E2E_ENDPOINT_TEXT, GATED_TEXT, MAX_PREVIEWS, MOVED_TEXT, OFFLINE_TEXT, PREVIEW_USED_TEXT,
  UNVERIFIABLE_TEXT,
} from '../../src/main/download-service';
import { FREE_MARGIN } from '../../src/main/download/engine';
import { inProcessScanRunner } from '../../src/main/scan-client';
import { AppServices, DOWNLOAD_ACTIVE_TEXT, type ServicesDeps } from '../../src/main/services';
import type { ApiResult, DownloadDoneDTO, DownloadProgressDTO, HubLookupDTO } from '../../src/shared/api';
import { buildAppFixture, tinyGgufHeader, type AppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';
import { gitBlobId, sha256Hex, startFakeHub, type FakeHub, type FakeHubOptions, type FakeHubRepo } from '../helpers/fake-hub';
import { failingFs } from '../helpers/failing-fs';
import { guardedFs } from '../helpers/guarded-fs';
import { treeDigest } from '../helpers/tree-digest';

useCanaries();
beforeEach(() => expect.hasAssertions());

const C = 'c0'.repeat(20);
const C2 = 'd1'.repeat(20);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const Q4 = tinyGgufHeader(4000, 15);
const Q8A = tinyGgufHeader(3000, 7, [4096]);
const Q8B = tinyGgufHeader(2000, 7, [4096], false);
const README = enc('# a model\n');
const MODEL: FakeHubRepo = {
  repoId: 'org/Model-GGUF', commit: C, lfs: ['Model-Q4_K_M.gguf', 'Q8_0/Model-Q8_0-00001-of-00002.gguf', 'Q8_0/Model-Q8_0-00002-of-00002.gguf'],
  files: {
    'Model-Q4_K_M.gguf': Q4, 'Q8_0/Model-Q8_0-00001-of-00002.gguf': Q8A, 'Q8_0/Model-Q8_0-00002-of-00002.gguf': Q8B, 'README.md': README,
  },
};
/** Two of three shards listed: an incomplete set. */
const BROKEN: FakeHubRepo = {
  repoId: 'org/Broken-GGUF', commit: C, lfs: ['B-Q8_0-00001-of-00003.gguf', 'B-Q8_0-00002-of-00003.gguf'],
  files: { 'B-Q8_0-00001-of-00003.gguf': tinyGgufHeader(1000, 7), 'B-Q8_0-00002-of-00003.gguf': new Uint8Array(500), 'B-Q4_0.gguf': new Uint8Array(300) },
};
const GATED: FakeHubRepo = { repoId: 'org/Gated-GGUF', commit: C, gated: true, lfs: ['G-Q4_K_M.gguf'], files: { 'G-Q4_K_M.gguf': Q4 } };

const MACHINE: MachineProfile = { platform: 'linux', ramBytes: 64e9, gpuName: 'Test GPU', gpuBytes: 24e9, gpuKind: 'nvidia', computeCap: 8.9, drivesDisplay: false };
const GPU = { over: { detectMachine: async () => MACHINE } };
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
const errOf = <T>(r: ApiResult<T>): { code: string; message: string } => {
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
};

function loopbackFetch(h: FakeHub, seen: string[] = []): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (![h.endpoint, h.cdnOrigin].some((o) => url.startsWith(`${o}/`))) throw new Error(`test tried to reach ${url}`);
    return globalThis.fetch(input, init);
  }) as typeof fetch;
}

interface World {
  fx: AppFixture; hub: FakeHub; svc: AppServices; events: DownloadProgressDTO[]; done: DownloadDoneDTO[];
  free: { bytes: number }; whenDone: (n?: number) => Promise<DownloadDoneDTO[]>; fetched: string[]; env: NodeJS.ProcessEnv;
}

async function world(o: { env?: NodeJS.ProcessEnv; repos?: FakeHubRepo[]; over?: Partial<ServicesDeps>; hub?: FakeHubOptions;
  before?: (fx: AppFixture) => Promise<void> } = {}): Promise<World> {
  const fx = await buildAppFixture();
  created.push(fx);
  const tiny = fx.content('tiny');
  const TINY: FakeHubRepo = { repoId: 'bartowski/tiny-GGUF', commit: C2, lfs: ['tiny-Q4_K_M.gguf'], files: { 'tiny-Q4_K_M.gguf': tiny, 'README.md': README } };
  await o.before?.(fx);
  const hub = await startFakeHub(o.repos ?? [MODEL, BROKEN, GATED, TINY], o.hub);
  hubs.push(hub);
  const env: NodeJS.ProcessEnv = { ...fx.env, HF_ENDPOINT: hub.endpoint };
  delete env.HF_TOKEN;
  Object.assign(env, o.env);
  const events: DownloadProgressDTO[] = [];
  const done: DownloadDoneDTO[] = [];
  const waiters: Array<() => void> = [];
  const free = { bytes: 1e13 };
  const fetched: string[] = [];
  const port = createCorePort({
    userDataDir: fx.userDataDir, env, home: fx.home, offline: true, makeSafeFs: (roots) => SafeFs.create(roots, guardedFs()),
  });
  const svc = new AppServices({
    env, home: fx.home, userDataDir: fx.userDataDir, port, platform: 'linux', now: () => Date.now(),
    scanRunner: inProcessScanRunner, emitProgress: () => undefined,
    makeUserSafeFs: (dir) => SafeFs.create({ hubRoot: dir, viewRoots: [], holdRoot: null }, guardedFs()),
    emitDownloadProgress: (e) => events.push(e),
    emitDownloadDone: (d) => { done.push(d); waiters.splice(0).forEach((w) => w()); },
    download: {
      fetch: loopbackFetch(hub, fetched), statfs: async () => ({ bavail: free.bytes, bsize: 1 }), clientSleep: async () => undefined,
      sleep: (ms, signal) => new Promise((res, rej) => {
        if (signal.aborted) return rej(signal.reason);   // as the real sleep: an earlier abort is never missed
        const t = setTimeout(res, Math.min(ms, 20));
        signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
      }),
    },
    ...o.over,
  });
  /** Resolves once `n` downloads have sent downloadDone. */
  const whenDone = async (n = 1): Promise<DownloadDoneDTO[]> => {
    while (done.length < n) await new Promise<void>((r) => waiters.push(r));
    return done.slice(0, n);
  };
  return { fx, hub, svc, events, done, free, whenDone, fetched, env };
}

const groupOf = (l: HubLookupDTO, label: string) => {
  const g = l.groups.find((x) => x.label === label);
  if (!g) throw new Error(`no group ${label} in ${l.groups.map((x) => x.label).join(', ')}`);
  return g;
};
const folder = (w: World, id: string): string => join(w.fx.hubRoot, `models--${id.replace('/', '--')}`);

describe('hubLookup', () => {
  test('groups, cache states, Requires and advice for a fake repo; no header is read by the look-up; nothing written', async () => {
    const w = await world(GPU);
    unwrap(await w.svc.redetectMachine());
    const before = await treeDigest(w.fx.hubRoot);
    const l = unwrap(await w.svc.hubLookup('https://huggingface.co/org/Model-GGUF'));
    expect(l).toMatchObject({ repoId: 'org/Model-GGUF', type: 'model', revision: 'main', commit: C, gated: false, private: false,
      lastModified: '2026-10-01T00:00:00.000Z', downloadable: true, notDownloadableReason: null });
    expect(l.lookupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(l.badge).toMatch(/GGUF/);
    const q4 = groupOf(l, 'Q4_K_M');
    expect(q4).toMatchObject({ kind: 'quant', complete: true, selectable: true, reason: null, requiresBytes: Q4.length,
      files: [{ path: 'Model-Q4_K_M.gguf', size: Q4.length, state: 'absent', have: 0 }] });
    const q8 = groupOf(l, 'Q8_0');
    expect(q8).toMatchObject({ complete: true, selectable: true, requiresBytes: Q8A.length + Q8B.length });
    // advice: one entry per classified group, same keys and order; no header was read, the shapes are pending
    const classified = l.groups.filter((g) => g.selectable || !g.complete);
    expect(l.advice.groups.map((g) => g.key)).toEqual(classified.map((g) => g.key));
    expect(l.shapesPending).toBe(true);
    expect(l.advice.groups.find((g) => g.key === q4.key)!.reason).toMatch(/shape unknown/i);
    expect(w.hub.requests.filter((r) => r.headers['range'] !== undefined)).toEqual([]);
    expect(w.hub.requests.some((r) => r.url.includes('/resolve/'))).toBe(false);
    expect(await treeDigest(w.fx.hubRoot)).toEqual(before);
  });

  test('downloadAdvice reads the shapes from the Hub (first shard first), once per file across two calls', async () => {
    const w = await world(GPU);
    unwrap(await w.svc.redetectMachine());
    const before = await treeDigest(w.fx.hubRoot);
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const adv = unwrap(await w.svc.downloadAdvice(l.lookupId));
    expect(adv.groups.map((g) => g.key)).toEqual(l.advice.groups.map((g) => g.key));
    expect(adv.groups.find((g) => g.key === groupOf(l, 'Q4_K_M').key)!.reason).not.toMatch(/shape unknown/i);
    const ranged = (): string[] => w.hub.requests.filter((r) => r.headers['range'] !== undefined && r.url.startsWith(w.hub.endpoint)).map((r) => r.url);
    const first = ranged();
    const a = first.findIndex((u) => u.includes('00001-of-00002'));
    const b = first.findIndex((u) => u.includes('00002-of-00002'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    for (const f of ['Model-Q4_K_M.gguf', '00001-of-00002', '00002-of-00002']) expect(first.some((u) => u.includes(f)), f).toBe(true);
    expect(first.some((u) => u.includes('README'))).toBe(false);
    expect(unwrap(await w.svc.downloadAdvice(l.lookupId))).toEqual(adv);
    expect(ranged()).toEqual(first);   // the second call reads nothing again
    expect(errOf(await w.svc.downloadAdvice('00000000-0000-4000-8000-00000000000b')).code).toBe('UNKNOWN_PLAN');
    expect(await treeDigest(w.fx.hubRoot)).toEqual(before);
  });

  test('cached and absent states against the scanned cache', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('bartowski/tiny-GGUF'));
    const files = l.groups.flatMap((g) => g.files);
    expect(files.find((f) => f.path === 'tiny-Q4_K_M.gguf')).toMatchObject({ state: 'cached', have: w.fx.content('tiny').length });
    expect(files.find((f) => f.path === 'README.md')).toMatchObject({ state: 'absent', have: 0 });
    expect(groupOf(l, 'Q4_K_M').requiresBytes).toBe(0);
  });

  test('gated with no token → not downloadable with the gated reason, and no file is requested', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('org/Gated-GGUF'));
    expect(l).toMatchObject({ gated: true, downloadable: false, notDownloadableReason: GATED_TEXT });
    expect(GATED_TEXT).toBe('Gated: accept the terms on huggingface.co and make sure your token is set');
    expect(l.shapesPending).toBe(false);
    expect(unwrap(await w.svc.downloadAdvice(l.lookupId)).groups).toHaveLength(1);
    expect(w.hub.requests.some((r) => r.url.includes('/resolve/'))).toBe(false);
    expect(errOf(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]))).toEqual({ code: 'GATED', message: GATED_TEXT });
  });

  test('a gated repo is refused by downloadPreview even when downloadAdvice never ran', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('org/Gated-GGUF'));
    expect(errOf(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]))).toEqual({ code: 'GATED', message: GATED_TEXT });
  });

  test('at most MAX_PREVIEWS previews stay usable; the oldest are dropped', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const key = groupOf(l, 'Q4_K_M').key;
    const first = unwrap(await w.svc.downloadPreview(l.lookupId, [key]));
    for (let i = 0; i < MAX_PREVIEWS; i++) unwrap(await w.svc.downloadPreview(l.lookupId, [key]));
    expect(errOf(await w.svc.downloadStart(first.previewId, first.fingerprint)).code).toBe('UNKNOWN_PLAN');
  });

  test('the token is read again on every look-up: set after the first, the second is downloadable', async () => {
    const w = await world();
    expect(unwrap(await w.svc.hubLookup('org/Gated-GGUF')).downloadable).toBe(false);
    w.env.HF_TOKEN = 'hf_later';
    const l = unwrap(await w.svc.hubLookup('org/Gated-GGUF'));
    expect(l).toMatchObject({ downloadable: true, notDownloadableReason: null });
    unwrap(await w.svc.downloadAdvice(l.lookupId));
    expect(w.hub.requests.filter((r) => r.url.includes('/resolve/')).every((r) => r.headers['authorization'] === 'Bearer hf_later')).toBe(true);
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    await w.whenDone();
  });

  test('gated with a token → downloadable (the token reaches only the Hub origin)', async () => {
    const w = await world({ env: { HF_TOKEN: 'hf_test_token' } });
    const l = unwrap(await w.svc.hubLookup('org/Gated-GGUF'));
    expect(l).toMatchObject({ gated: true, downloadable: true, notDownloadableReason: null });
    expect(w.hub.requests.filter((r) => r.url.startsWith(w.hub.cdnOrigin)).every((r) => r.headers['authorization'] === undefined)).toBe(true);
    // the token is in no DTO, event or saved file
    const adv = unwrap(await w.svc.downloadAdvice(l.lookupId));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    await w.whenDone();
    const saved = await readFile(join(w.fx.userDataDir, 'settings.json'), 'utf8');
    const all = JSON.stringify([l, adv, p, w.events, w.done, unwrap(await w.svc.downloads()), unwrap(await w.svc.recentLookups())]) + saved;
    expect(all).not.toContain('hf_test_token');
  });

  test('a look-up leaves a settings file with an unreported bad advice or downloads block untouched', async () => {
    const w = await world();
    const text = JSON.stringify({ autoEmptyDays: 7, advice: { gpuBytes: 'lots' }, downloads: { version: 9 } });
    await writeFile(join(w.fx.userDataDir, 'settings.json'), text);
    unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    expect(await readFile(join(w.fx.userDataDir, 'settings.json'), 'utf8')).toBe(text);
  });

  test('an incomplete shard set is not selectable, with the reason; preview refuses it', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('org/Broken-GGUF'));
    const g = l.groups.find((x) => x.kind === 'quant' && !x.complete)!;
    expect(g).toMatchObject({ selectable: false, reason: 'Only 2 of 3 shards are listed on the Hub; an incomplete set cannot be downloaded.' });
    expect(errOf(await w.svc.downloadPreview(l.lookupId, [g.key])).code).toBe('INVALID_INPUT');
    // the complete quant next to it is fine
    expect(unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_0').key])).fits).toBe(true);
  });

  test('HF_HUB_OFFLINE=1 → OFFLINE, and nothing is fetched', async () => {
    const w = await world({ env: { HF_HUB_OFFLINE: '1' } });
    expect(errOf(await w.svc.hubLookup('org/Model-GGUF'))).toEqual({ code: 'OFFLINE', message: OFFLINE_TEXT });
    expect(w.fetched).toEqual([]);
    expect(unwrap(await w.svc.downloads())).toMatchObject({ items: [], disabledReason: OFFLINE_TEXT });
  });

  test('under E2E a non-loopback HF_ENDPOINT disables download mode; nothing is fetched', async () => {
    const w = await world({ env: { HFCM_E2E: '1', HF_ENDPOINT: 'https://huggingface.co' } });
    expect(errOf(await w.svc.hubLookup('org/Model-GGUF'))).toEqual({ code: 'OFFLINE', message: E2E_ENDPOINT_TEXT });
    expect(w.fetched).toEqual([]);
  });

  test('bad input and unknown repos are refused; a path is never a repo', async () => {
    const w = await world();
    expect(errOf(await w.svc.hubLookup('../../etc/passwd')).code).toBe('INVALID_INPUT');
    // a leading slash is just an id to the parser (`etc/passwd`): asked of the Hub, never read from disk
    expect(errOf(await w.svc.hubLookup('/etc/passwd')).code).toBe('NOT_FOUND');
    expect(w.fetched.filter((u) => !u.startsWith(w.hub.endpoint))).toEqual([]);
    expect(errOf(await w.svc.hubLookup('https://evil.example/org/Model-GGUF')).code).toBe('INVALID_INPUT');
    expect(errOf(await w.svc.hubLookup('org/missing'))).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('recent look-ups: newest first, one per repo and revision, at most 20, kept in settings', async () => {
    const w = await world();
    const old = Array.from({ length: 20 }, (_, i) => ({ repoId: `o/r${i}`, type: 'model', revision: 'main', at: i }));
    await writeFile(join(w.fx.userDataDir, 'settings.json'), JSON.stringify({ autoEmptyDays: 7, recentLookups: old }));
    unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    unwrap(await w.svc.hubLookup(`org/Model-GGUF@${C}`));
    unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const list = unwrap(await w.svc.recentLookups());
    expect(list).toHaveLength(20);
    expect(list.slice(0, 3).map((r) => r.input)).toEqual(['org/Model-GGUF', `org/Model-GGUF@${C}`, 'o/r0']);
    const saved = JSON.parse(await readFile(join(w.fx.userDataDir, 'settings.json'), 'utf8'));
    expect(saved.autoEmptyDays).toBe(7);
    expect(saved.recentLookups).toHaveLength(20);
    // a bad block is an empty list for that key only
    await writeFile(join(w.fx.userDataDir, 'settings.json'), JSON.stringify({ autoEmptyDays: 7, recentLookups: [{ repoId: '../x' }] }));
    expect(unwrap(await w.svc.recentLookups())).toEqual([]);
    expect(unwrap(await w.svc.settings()).autoEmptyDays).toBe(7);
  });
});

describe('downloadGroups (pure)', () => {
  test('files without a Hub size or hash form a group that cannot be selected; refused entries likewise', () => {
    const l = toRemoteListing({ repoId: 'o/m', type: 'model', commit: C, files: [
      { path: 'a.gguf', size: 10, etag: 'a'.repeat(64), lfs: true },
      { path: 'nohash.bin', size: 10, etag: null, lfs: false },
      { path: '../evil', size: 1, etag: 'b'.repeat(64), lfs: true },
    ] });
    const view = classifyRepo(remoteRepo(l), () => null);
    const groups = downloadGroups(l, view, new Map());
    expect(groups.find((g) => g.key === 'unverifiable:files')).toMatchObject({
      selectable: false, reason: UNVERIFIABLE_TEXT, files: [{ path: 'nohash.bin', size: 0, state: 'absent', have: 0 }] });
    expect(groups.find((g) => g.key === 'refused:files')).toMatchObject({ selectable: false, files: [{ path: '../evil' }] });
    expect(groups.filter((g) => g.selectable).flatMap((g) => g.files.map((f) => f.path))).toEqual(['a.gguf']);
  });
});

describe('statfs seam (the guarded E2E disk)', () => {
  test('diskInfo reads the injected statfs instead of the real disk', async () => {
    const statfs = async () => ({ bsize: 1, blocks: 2e12, bfree: 5e11, bavail: 5e11 });
    const w = await world({ over: { statfs } });
    expect(unwrap(await w.svc.diskInfo())).toMatchObject({ totalBytes: 2e12, freeBytes: 5e11, usedBytes: 1.5e12 });
  });
});

describe('downloadPreview', () => {
  test('requires vs free space − 5 GB: fits only with room for the margin', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const key = groupOf(l, 'Q4_K_M').key;
    w.free.bytes = FREE_MARGIN + Q4.length - 1;
    const tight = unwrap(await w.svc.downloadPreview(l.lookupId, [key]));
    expect(tight).toMatchObject({ requiresBytes: Q4.length, freeBytes: FREE_MARGIN + Q4.length - 1, fits: false, files: 1 });
    expect(tight.reason).toMatch(/must stay free/);
    expect(errOf(await w.svc.downloadStart(tight.previewId, tight.fingerprint)).code).toBe('INVALID_INPUT');
    w.free.bytes = FREE_MARGIN + Q4.length;
    const room = unwrap(await w.svc.downloadPreview(l.lookupId, [key]));
    expect(room).toMatchObject({ fits: true, reason: null });
    expect(room.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('everything cached → nothing to fetch, not startable; unknown look-ups and groups are refused', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('bartowski/tiny-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    expect(p).toMatchObject({ files: 0, requiresBytes: 0, fits: false, reason: ALL_CACHED_TEXT });
    expect(errOf(await w.svc.downloadPreview(l.lookupId, ['quant:nope'])).code).toBe('NOT_FOUND');
    expect(errOf(await w.svc.downloadPreview('00000000-0000-4000-8000-000000000009', ['quant:Q4_K_M'])).code).toBe('UNKNOWN_PLAN');
  });
});

describe('downloadStart', () => {
  test('a moved Hub commit → STALE "look up again"; nothing is written', async () => {
    const repo = { ...MODEL };
    const w = await world({ repos: [repo] });
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    repo.commit = C2;
    expect(errOf(await w.svc.downloadStart(p.previewId, p.fingerprint))).toEqual({ code: 'STALE', message: MOVED_TEXT });
    expect(await lstat(folder(w, 'org/Model-GGUF')).then(() => true, () => false)).toBe(false);
  });

  test('what the selection touches changed since the preview → STALE; a wrong fingerprint → STALE; a used preview → USED', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('bartowski/tiny-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'model card and assets').key]));
    expect(p.fits).toBe(true);
    expect(errOf(await w.svc.downloadStart(p.previewId, 'f'.repeat(64)))).toEqual({ code: 'STALE', message: CHANGED_TEXT });
    // an unrelated partial file in the repo does not matter ...
    await writeFile(join(folder(w, 'bartowski/tiny-GGUF'), 'blobs', `${'e'.repeat(64)}.incomplete`), 'x');
    const p2 = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'model card and assets').key]));
    expect(p2.fingerprint).toBe(p.fingerprint);
    // ... the selected file's snapshot entry does
    await mkdir(join(folder(w, 'bartowski/tiny-GGUF'), 'snapshots', C2), { recursive: true });
    await writeFile(join(folder(w, 'bartowski/tiny-GGUF'), 'snapshots', C2, 'README.md'), 'mine');
    expect(errOf(await w.svc.downloadStart(p.previewId, p.fingerprint))).toEqual({ code: 'STALE', message: CHANGED_TEXT });
    expect(errOf(await w.svc.downloadStart(p.previewId, p.fingerprint))).toEqual({ code: 'USED', message: PREVIEW_USED_TEXT });
  });

  test('BUSY while a deletion or sync holds the mutex; the preview stays usable', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    const mutex = w.svc as unknown as { op: string | null };
    mutex.op = 'execute';
    expect(errOf(await w.svc.downloadStart(p.previewId, p.fingerprint)).code).toBe('BUSY');
    mutex.op = null;
    unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    await w.whenDone();
  });

  test('an unexpected error inside downloadStart does not use up the preview', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    const host = (w.svc as unknown as { dl: { h: { model: () => Promise<unknown> } } }).dl.h;
    const model = host.model;
    host.model = () => Promise.reject(new Error('a bug'));
    expect(errOf(await w.svc.downloadStart(p.previewId, p.fingerprint))).toEqual({ code: 'INTERNAL', message: expect.stringContaining('a bug') });
    host.model = model;
    unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    await w.whenDone();
  });

  test('look up → preview → start → done: the repo is written as hf download does, rescanned, then downloadDone', async () => {
    const w = await world();
    const outside = async () => Object.fromEntries(Object.entries(await treeDigest(w.fx.hubRoot)).filter(([k]) => !k.startsWith('models--org--Model-GGUF')));
    const before = await outside();
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q8_0').key, groupOf(l, 'model card and assets').key]));
    expect(p).toMatchObject({ files: 3, fits: true, requiresBytes: Q8A.length + Q8B.length + README.length });
    const { id } = unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    const [done] = await w.whenDone();
    expect(done).toEqual({ id, repoId: 'org/Model-GGUF', type: 'model' });
    const f = folder(w, 'org/Model-GGUF');
    expect(await readFile(join(f, 'refs', 'main'), 'utf8')).toBe(C);
    expect(await readlink(join(f, 'snapshots', C, 'Q8_0', 'Model-Q8_0-00001-of-00002.gguf'))).toBe(`../../../blobs/${sha256Hex(Q8A)}`);
    expect(await readlink(join(f, 'snapshots', C, 'README.md'))).toBe(`../../blobs/${gitBlobId(README)}`);
    expect(await lstat(join(f, 'snapshots', C, 'Model-Q4_K_M.gguf')).then(() => true, () => false)).toBe(false);
    expect(await outside()).toEqual(before);
    // the rescan ran before the event: the library already lists the repo
    const lib = unwrap(await w.svc.scan());
    expect(lib.repos.some((r) => r.repoId === 'org/Model-GGUF')).toBe(true);
    expect(w.events.some((e) => e.id === id && e.state === 'done' && e.path === 'README.md')).toBe(true);
    const q = unwrap(await w.svc.downloads());
    expect(q.disabledReason).toBeNull();
    expect(q.items).toEqual([expect.objectContaining({ id, repoId: 'org/Model-GGUF', commit: C })]);
    expect(q.items[0]!.files.every((x) => x.state === 'done')).toBe(true);
    // a second look-up now sees the files as cached
    const again = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    expect(groupOf(again, 'Q8_0').files.every((x) => x.state === 'cached')).toBe(true);
    expect(w.done).toHaveLength(1);
  });

  test('a second quant of the same repo can be previewed and started while the first downloads', async () => {
    const w = await world({ hub: { slowBytesPerSec: 2000 } });
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const p1 = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    const first = unwrap(await w.svc.downloadStart(p1.previewId, p1.fingerprint));
    while (!w.events.some((e) => e.id === first.id && e.state === 'downloading')) await new Promise((r) => setTimeout(r, 10));
    const p2 = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q8_0').key]));
    const second = unwrap(await w.svc.downloadStart(p2.previewId, p2.fingerprint));
    expect(w.done).toEqual([]);   // the first was still running
    const done = await w.whenDone(2);
    expect(done.map((d) => d.id).sort()).toEqual([first.id, second.id].sort());
    const f = folder(w, 'org/Model-GGUF');
    for (const p of ['Model-Q4_K_M.gguf', 'Q8_0/Model-Q8_0-00002-of-00002.gguf']) {
      expect(await lstat(join(f, 'snapshots', C, ...p.split('/'))).then((s) => s.isSymbolicLink())).toBe(true);
    }
  });

  test('a file already in the queue is never queued again: preview leaves it out, an older preview is STALE', async () => {
    const w = await world({ hub: { slowBytesPerSec: 2000 } });
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const q4 = groupOf(l, 'Q4_K_M').key;
    const card = groupOf(l, 'model card and assets').key;
    const stale = unwrap(await w.svc.downloadPreview(l.lookupId, [q4]));   // made before the first download started
    const p1 = unwrap(await w.svc.downloadPreview(l.lookupId, [q4]));
    unwrap(await w.svc.downloadStart(p1.previewId, p1.fingerprint));
    const again = unwrap(await w.svc.downloadPreview(l.lookupId, [q4]));
    expect(again).toMatchObject({ files: 0, requiresBytes: 0, fits: false, reason: ALL_QUEUED_TEXT });
    const mixed = unwrap(await w.svc.downloadPreview(l.lookupId, [q4, card]));
    expect(mixed).toMatchObject({ files: 1, requiresBytes: README.length, fits: true });
    // a preview made before the first download started is refused: what it would touch is being written now
    expect(errOf(await w.svc.downloadStart(stale.previewId, stale.fingerprint))).toEqual({ code: 'STALE', message: CHANGED_TEXT });
    const second = unwrap(await w.svc.downloadStart(mixed.previewId, mixed.fingerprint));
    const items = unwrap(await w.svc.downloads()).items;
    expect(items.find((i) => i.id === second.id)?.files.map((f) => f.path)).toEqual(['README.md']);
    expect(items.filter((i) => i.files.some((f) => f.path === 'Model-Q4_K_M.gguf'))).toHaveLength(1);
    await w.whenDone(2);
  });

  test('a file queued for another commit still counts as to fetch: that download links only its own snapshot', async () => {
    const repo = { ...MODEL };
    const w = await world({ repos: [repo], hub: { slowBytesPerSec: 2000 } });
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    const first = unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    repo.commit = C2;
    const moved = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    expect(unwrap(await w.svc.downloadPreview(moved.lookupId, [groupOf(moved, 'Q4_K_M').key]))).toMatchObject({ files: 1, fits: true });
    unwrap(await w.svc.downloadCancel(first.id));
  });

  test('lookupGroups recomputes the cache states from the rescanned cache (no Hub request); unknown look-ups are refused', async () => {
    const w = await world();
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    expect(groupOf(l, 'Q4_K_M').files[0]).toMatchObject({ state: 'absent' });
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    await w.whenDone();
    const before = w.hub.requests.length;
    const groups = unwrap(await w.svc.lookupGroups(l.lookupId));
    const q4 = groups.find((g) => g.label === 'Q4_K_M')!;
    expect(q4.files[0]).toMatchObject({ state: 'cached', have: Q4.length });
    expect(q4.requiresBytes).toBe(0);
    expect(groups.find((g) => g.label === 'Q8_0')!.files.every((f) => f.state === 'absent')).toBe(true);
    expect(w.hub.requests.length).toBe(before);
    expect(errOf(await w.svc.lookupGroups('00000000-0000-4000-8000-000000000009')).code).toBe('UNKNOWN_PLAN');
  });

  test('the fingerprint leaves out a .incomplete this engine is writing, and covers it otherwise', async () => {
    const w = await world();
    const listing = toRemoteListing({ repoId: 'org/Model-GGUF', type: 'model', commit: C, files: [
      { path: 'Model-Q4_K_M.gguf', size: Q4.length, etag: sha256Hex(Q4), lfs: true }] });
    const inc = join(folder(w, 'org/Model-GGUF'), 'blobs', `${sha256Hex(Q4)}.incomplete`);
    const fp = (writing: Set<string>) => previewFingerprint(w.fx.fs as never, w.fx.hubRoot, listing, 'main', ['Model-Q4_K_M.gguf'], writing);
    const none = await fp(new Set());
    await mkdir(join(folder(w, 'org/Model-GGUF'), 'blobs'), { recursive: true });
    await writeFile(inc, 'abc');
    const own = await fp(new Set([inc]));
    expect(await fp(new Set())).not.toBe(none);
    await writeFile(inc, 'abcdef');
    expect(await fp(new Set([inc]))).toBe(own);
  });

  test('startDownloads restores the saved queue before any download call; downloads() lists it paused; Resume finishes it', async () => {
    const id = '00000000-0000-4000-8000-0000000000c3';
    const w = await world({
      before: async (fx) => {
        const item = {
          id, repoId: 'org/Model-GGUF', type: 'model', revision: 'main', commit: C, refAtStart: null, links: [],
          files: [{ path: 'Model-Q4_K_M.gguf', etag: sha256Hex(Q4), size: Q4.length, lfs: true, state: 'downloading', bytes: 0, error: null }],
        };
        await writeFile(join(fx.userDataDir, 'settings.json'), JSON.stringify({ autoEmptyDays: 7, downloads: { version: 1, items: [item] } }));
      },
    });
    await w.svc.startDownloads();
    expect(w.events).toEqual([expect.objectContaining({ id, path: 'Model-Q4_K_M.gguf', state: 'paused' })]);
    const q = unwrap(await w.svc.downloads());
    expect(q.items).toEqual([expect.objectContaining({ id, files: [expect.objectContaining({ state: 'paused', bytes: 0 })] })]);
    unwrap(await w.svc.downloadResume(id));
    const [d] = await w.whenDone();
    expect(d).toEqual({ id, repoId: 'org/Model-GGUF', type: 'model' });
  });

  test('a repo with a paused download cannot be deleted (planDelete, and executePlan of an older review)', async () => {
    const w = await world({ hub: { slowBytesPerSec: 1 } });
    const tiny = { repos: [{ repoId: 'bartowski/tiny-GGUF', whole: true as const }] };
    const older = unwrap(await w.svc.planDelete(tiny));   // reviewed before the download
    const l = unwrap(await w.svc.hubLookup('bartowski/tiny-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'model card and assets').key]));
    const { id } = unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    unwrap(await w.svc.downloadPause(id));
    const text = 'bartowski/tiny-GGUF has downloads in progress, paused or failed; finish or cancel them first.';
    expect(errOf(await w.svc.planDelete(tiny))).toEqual({ code: 'ACTIVE_DOWNLOAD', message: text });
    const perm = older.permanent;
    expect(errOf(await w.svc.executePlan(perm.planId, perm.fingerprint, 'permanent', perm.confirmPhrase)))
      .toEqual({ code: 'ACTIVE_DOWNLOAD', message: text });
    expect(await lstat(folder(w, 'bartowski/tiny-GGUF')).then(() => true)).toBe(true);
    // other repos are not affected; a cancelled download no longer blocks
    unwrap(await w.svc.planDelete({ repos: [{ repoId: 'org/dupe', whole: true }] }));
    unwrap(await w.svc.downloadCancel(id));
    unwrap(await w.svc.planDelete(tiny));
  });

  test('downloadStart records the commit refs/<revision> names at the start (refAtStart) in the saved queue', async () => {
    const w = await world({ hub: { slowBytesPerSec: 1 } });
    const ref = join(folder(w, 'bartowski/tiny-GGUF'), 'refs', 'main');
    const before = (await readFile(ref, 'utf8')).trim();
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    const l = unwrap(await w.svc.hubLookup('bartowski/tiny-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'model card and assets').key]));
    const { id } = unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    unwrap(await w.svc.downloadPause(id));
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(w.fx.userDataDir, 'settings.json'), 'utf8')).downloads?.items;
      expect(saved).toEqual([expect.objectContaining({ id, revision: 'main', refAtStart: before })]);
    });
    unwrap(await w.svc.downloadCancel(id));
  });

  test('pause / resume / cancel by id; unknown ids are NOT_FOUND', async () => {
    const w = await world();
    const bogus = '00000000-0000-4000-8000-00000000000a';
    for (const r of [await w.svc.downloadPause(bogus), await w.svc.downloadResume(bogus), await w.svc.downloadCancel(bogus)]) {
      expect(errOf(r).code).toBe('NOT_FOUND');
    }
    const l = unwrap(await w.svc.hubLookup('org/Model-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'Q4_K_M').key]));
    const { id } = unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    unwrap(await w.svc.downloadPause(id));
    unwrap(await w.svc.downloadResume(id));
    await w.whenDone();
    unwrap(await w.svc.downloadCancel(id));
    expect(unwrap(await w.svc.downloads()).items).toEqual([]);
  });
});

describe('deletions vs. downloads', () => {
  const tiny = { repos: [{ repoId: 'bartowski/tiny-GGUF', whole: true as const }] };
  const TEXT = DOWNLOAD_ACTIVE_TEXT('bartowski/tiny-GGUF');
  const savedItem = (id: string, over: Record<string, unknown> = {}) => ({
    id, repoId: 'bartowski/tiny-GGUF', type: 'model', revision: 'main', commit: C2, refAtStart: null, links: [],
    files: [{ path: 'README.md', etag: gitBlobId(README), size: README.length, lfs: false, state: 'paused', bytes: 0, error: null }], ...over,
  });
  const withSaved = (items: unknown[]) => async (fx: AppFixture): Promise<void> => {
    await writeFile(join(fx.userDataDir, 'settings.json'), JSON.stringify({ autoEmptyDays: 7, downloads: { version: 1, items } }));
  };

  test('Resume/Retry is BUSY while an execute, sync or auto-empty run holds the mutex; nothing restarts', async () => {
    const w = await world({ hub: { slowBytesPerSec: 1 } });
    const l = unwrap(await w.svc.hubLookup('bartowski/tiny-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'model card and assets').key]));
    const { id } = unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    unwrap(await w.svc.downloadPause(id));
    const mutex = w.svc as unknown as { op: string | null };
    for (const op of ['execute', 'sync', 'auto-empty']) {
      mutex.op = op;
      expect(errOf(await w.svc.downloadResume(id)).code).toBe('BUSY');
    }
    mutex.op = null;
    expect(unwrap(await w.svc.downloads()).items[0]!.files.every((f) => f.state === 'paused')).toBe(true);
    unwrap(await w.svc.downloadResume(id));
    unwrap(await w.svc.downloadCancel(id));
  });

  test('a download whose files have only failed still blocks deletion of its repo, until it is cancelled', async () => {
    const w = await world({ hub: { failFirst: { 'README.md': 1000 } } });
    const l = unwrap(await w.svc.hubLookup('bartowski/tiny-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'model card and assets').key]));
    const { id } = unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    await vi.waitFor(() => expect(w.events.some((e) => e.id === id && e.state === 'failed')).toBe(true));
    expect(unwrap(await w.svc.downloads()).items[0]!.files.map((f) => f.state)).toEqual(['failed']);
    expect(TEXT).toBe('bartowski/tiny-GGUF has downloads in progress, paused or failed; finish or cancel them first.');
    expect(errOf(await w.svc.planDelete(tiny))).toEqual({ code: 'ACTIVE_DOWNLOAD', message: TEXT });
    unwrap(await w.svc.downloadCancel(id));
    unwrap(await w.svc.planDelete(tiny));
  });

  test('before the engine has restored the saved queue, the guard reads it from settings', async () => {
    const w = await world({ before: withSaved([savedItem('00000000-0000-4000-8000-0000000000d1')]) });
    // no startDownloads(), no download call: no engine yet
    expect(errOf(await w.svc.planDelete(tiny))).toEqual({ code: 'ACTIVE_DOWNLOAD', message: TEXT });
    unwrap(await w.svc.planDelete({ repos: [{ repoId: 'org/dupe', whole: true }] }));
  });

  test('download mode off (HF_HUB_OFFLINE): a saved item still blocks deletion; Cancel works offline and unblocks it', async () => {
    const id = '00000000-0000-4000-8000-0000000000d2';
    const w = await world({ env: { HF_HUB_OFFLINE: '1' }, before: withSaved([savedItem(id), savedItem('00000000-0000-4000-8000-0000000000d3', { repoId: 'org/Other' })]) });
    await w.svc.startDownloads();
    expect(unwrap(await w.svc.downloads())).toMatchObject({ disabledReason: OFFLINE_TEXT, items: [{ id }, { repoId: 'org/Other' }] });
    expect(errOf(await w.svc.planDelete(tiny))).toEqual({ code: 'ACTIVE_DOWNLOAD', message: TEXT });
    expect(errOf(await w.svc.downloadPause(id)).code).toBe('OFFLINE');
    expect(errOf(await w.svc.downloadCancel('00000000-0000-4000-8000-00000000000f')).code).toBe('NOT_FOUND');
    unwrap(await w.svc.downloadCancel(id));
    expect(unwrap(await w.svc.downloads()).items.map((i) => i.repoId)).toEqual(['org/Other']);
    const saved = JSON.parse(await readFile(join(w.fx.userDataDir, 'settings.json'), 'utf8'));
    expect(saved).toMatchObject({ autoEmptyDays: 7, downloads: { version: 1, items: [{ repoId: 'org/Other' }] } });
    unwrap(await w.svc.planDelete(tiny));
    expect(w.fetched).toEqual([]);
  });

  test('r2: a saved queue that cannot be read fails closed: a repo with any partial file cannot be deleted', async () => {
    const partial = { repos: [{ repoId: 'org/partial', whole: true as const }] };
    for (const text of ['{ not json', JSON.stringify({ autoEmptyDays: 7, downloads: { version: 1, items: 'nope' } })]) {
      const w = await world({ env: { HF_HUB_OFFLINE: '1' }, before: async (fx) => { await writeFile(join(fx.userDataDir, 'settings.json'), text); } });
      const err = errOf(await w.svc.planDelete(partial));
      expect(err.code).toBe('ACTIVE_DOWNLOAD');
      expect(err.message).toMatch(/^org\/partial has partial downloads and the saved download queue cannot be read \((invalid JSON|downloads ignored).*\); fix settings\.json first\.$/);
      unwrap(await w.svc.planDelete(tiny));   // no partial file: not blocked
    }
    // a readable queue: the old partial file alone does not block (the planner's own .incomplete rule decides)
    const ok = await world({ env: { HF_HUB_OFFLINE: '1' } });
    unwrap(await ok.svc.planDelete(partial));
  });

  test('with the saved queue unreadable, a blobs/ that cannot be read counts as holding partial files', async () => {
    const denied = (p: string): boolean => p.endsWith(join('models--bartowski--tiny-GGUF', 'blobs'));
    const w = await world({ env: { HF_HUB_OFFLINE: '1' }, over: { fs: failingFs(guardedFs(), 'readdir', 'EACCES', denied) },
      before: async (fx) => { await writeFile(join(fx.userDataDir, 'settings.json'), '{ not json'); } });
    const err = errOf(await w.svc.planDelete(tiny));
    expect(err.code).toBe('ACTIVE_DOWNLOAD');
    expect(err.message).toMatch(/^bartowski\/tiny-GGUF has partial downloads and the saved download queue cannot be read \(invalid JSON.*\); fix settings\.json first\.$/);
    // another repo whose blobs/ is readable and holds no partial file: not blocked
    unwrap(await w.svc.planDelete({ repos: [{ repoId: 'org/dupe', whole: true }] }));
  });

  test('a multi-repo selection is refused when any repo in it has a download; the hold half of an older review too', async () => {
    const w = await world({ hub: { slowBytesPerSec: 1 } });
    const both = { repos: [{ repoId: 'org/dupe', whole: true as const }, { repoId: 'bartowski/tiny-GGUF', whole: true as const }] };
    const older = unwrap(await w.svc.planDelete(tiny));
    expect(older.hold).not.toBeNull();
    const l = unwrap(await w.svc.hubLookup('bartowski/tiny-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'model card and assets').key]));
    const { id } = unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    unwrap(await w.svc.downloadPause(id));
    expect(errOf(await w.svc.planDelete(both))).toEqual({ code: 'ACTIVE_DOWNLOAD', message: TEXT });
    expect(errOf(await w.svc.executePlan(older.hold!.planId, older.hold!.fingerprint, 'hold', null))).toEqual({ code: 'ACTIVE_DOWNLOAD', message: TEXT });
    expect(await lstat(folder(w, 'bartowski/tiny-GGUF')).then(() => true)).toBe(true);
    unwrap(await w.svc.downloadCancel(id));
  });

  test('planRestore is refused for a held repo that has a download (the restore would land in its folder)', async () => {
    const w = await world({ hub: { slowBytesPerSec: 1 } });
    const pair = unwrap(await w.svc.planDelete(tiny));
    unwrap(await w.svc.executePlan(pair.hold!.planId, pair.hold!.fingerprint, 'hold', null));
    const held = unwrap(await w.svc.listHeld()).items[0]!.deletionId;
    const l = unwrap(await w.svc.hubLookup('bartowski/tiny-GGUF'));
    const p = unwrap(await w.svc.downloadPreview(l.lookupId, [groupOf(l, 'model card and assets').key]));
    const { id } = unwrap(await w.svc.downloadStart(p.previewId, p.fingerprint));
    unwrap(await w.svc.downloadPause(id));
    expect(errOf(await w.svc.planRestore(held))).toEqual({ code: 'ACTIVE_DOWNLOAD', message: TEXT });
    unwrap(await w.svc.downloadCancel(id));
    unwrap(await w.svc.planRestore(held));
  });

  test('the refusal names the repo type for a dataset or space (a model and a dataset may share an id)', async () => {
    const w = await world({
      before: async (fx) => {
        const snapDir = join(fx.hubRoot, 'datasets--o--ds', 'snapshots', C2);
        await mkdir(snapDir, { recursive: true });
        await writeFile(join(snapDir, 'data.csv'), 'a,b\n');
        await withSaved([savedItem('00000000-0000-4000-8000-0000000000d4', { type: 'dataset', repoId: 'o/ds' })])(fx);
      },
    });
    expect(errOf(await w.svc.planDelete({ repos: [{ repoId: 'o/ds', whole: true }] })))
      .toEqual({ code: 'ACTIVE_DOWNLOAD', message: 'o/ds (dataset) has downloads in progress, paused or failed; finish or cancel them first.' });
    unwrap(await w.svc.planDelete(tiny));   // the models are not affected
  });
});
