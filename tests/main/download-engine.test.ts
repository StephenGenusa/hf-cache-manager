import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fileStates, unchangedLinks } from '../../src/core/download/cache-state';
import { toRemoteListing } from '../../src/core/download/remote-repo';
import { ExecError } from '../../src/core/exec/errors';
import { AppLock } from '../../src/core/exec/lock';
import type { FileHandleLike, FsLike } from '../../src/core/fsx';
import { SafeFs } from '../../src/core/safe-fs';
import { scanHub } from '../../src/core/scan/scanner';
import { AppSettingsStore } from '../../src/main/app-settings';
import { DownloadEngine, FREE_MARGIN, MSG, type DownloadEngineDeps } from '../../src/main/download/engine';
import type { DownloadProgressDTO, QueueItem } from '../../src/main/download/queue';
import { createHubClient, type HubClient } from '../../src/main/hub/client';
import { useCanaries } from '../helpers/canary';
import { failingFs, recordingFs, scriptedFs } from '../helpers/failing-fs';
import { gitBlobId, sha256Hex, startFakeHub, type FakeHub, type FakeHubOptions, type FakeHubRepo } from '../helpers/fake-hub';
import { buildFixture, type Fixture, type FixtureSpec } from '../helpers/fixture';
import { treeDigest } from '../helpers/tree-digest';

useCanaries();

const C = 'a1'.repeat(20);
const OLD = 'b2'.repeat(20);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const bytes = (n: number, seed = 7): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed + (i >> 8)) & 0xff);
const W = bytes(300_000);
const J = enc('{"model_type":"llama"}');
const EW = sha256Hex(W);
const EJ = gitBlobId(J);
const REPO: FakeHubRepo = { repoId: 'org/name', commit: C, lfs: ['w/model.gguf'], files: { 'w/model.gguf': W, 'config.json': J } };
const OTHER = { repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'x.gguf', blob: 'x' }] }] }] } satisfies FixtureSpec;

const hubs: FakeHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
});

/** fetch that refuses anything but the loopback fakes: no test can reach the network. */
function loopbackFetch(h: FakeHub): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (![h.endpoint, h.cdnOrigin].some((o) => url.startsWith(`${o}/`))) throw new Error(`test tried to reach ${url}`);
    return globalThis.fetch(input, init);
  }) as typeof fetch;
}

interface World {
  fx: Fixture; hub: FakeHub; client: HubClient; folder: string; userData: string; lockDir: string;
  events: DownloadProgressDTO[]; settings: AppSettingsStore;
  engine(extra?: Partial<DownloadEngineDeps> & { fsLike?: FsLike }): DownloadEngine;
  item(paths?: string[], revision?: string, links?: QueueItem['links']): Promise<QueueItem>;
}

async function world(o: { spec?: FixtureSpec; repos?: FakeHubRepo[]; hub?: FakeHubOptions; spacedHub?: boolean } = {}): Promise<World> {
  const fx = await buildFixture(o.spec ?? OTHER);
  const hubRoot = o.spacedHub ? join(fx.root, 'My Drive', 'hf hub') : fx.hubRoot;
  if (o.spacedHub) await mkdir(hubRoot, { recursive: true });
  const roots = { ...fx.roots, hubRoot };
  const hub = await startFakeHub(o.repos ?? [REPO], o.hub);
  hubs.push(hub);
  const client = createHubClient({ endpoint: { origin: hub.endpoint, base: hub.endpoint, loopbackHttp: true }, token: null, fetch: loopbackFetch(hub) });
  const userData = join(fx.root, 'userdata');
  await mkdir(userData, { recursive: true });
  const settings = new AppSettingsStore(userData, { fs: fx.fs, makeSafeFs: (d) => SafeFs.create({ hubRoot: d, viewRoots: [], holdRoot: null }, fx.fs) });
  const lockDir = join(dirname(fx.hubRoot), '.hf-cache-manager');
  const events: DownloadProgressDTO[] = [];
  const w: World = {
    fx, hub, client, folder: join(hubRoot, 'models--org--name'), userData, lockDir, events, settings,
    engine: (extra = {}) => {
      const fsLike = extra.fsLike ?? fx.fs;
      return new DownloadEngine({
        client, hubRoot, safeFs: async () => new SafeFs(roots, fsLike), lock: new AppLock(lockDir), settings,
        statfs: async () => ({ bavail: 1e13, bsize: 1 }), now: () => Date.now(), emit: (e) => events.push(e), symlinksSupported: true,
        fs: fsLike, sleep: (ms, signal) => new Promise((res, rej) => {
          if (signal.aborted) return rej(signal.reason);   // as the real sleep: an earlier abort is never missed
          const t = setTimeout(res, Math.min(ms, 20));
          signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
        }),
        ...extra,
      });
    },
    item: async (paths, revision = 'main', links = []) => {
      const rev = await client.revision('org/name', 'model', revision);
      const l = toRemoteListing({ repoId: 'org/name', type: 'model', commit: rev.commit, files: rev.siblings });
      const files = l.files.filter((f) => !paths || paths.includes(f.path))
        .map((f) => ({ path: f.path, etag: f.etag, size: f.size, lfs: f.lfs, state: 'queued' as const, bytes: 0, error: null }));
      // refAtStart as downloadStart records it: what refs/<revision> names now (a commit revision has no ref)
      const text = /^[0-9a-f]{40}$/.test(revision) ? null : await readFile(join(w.folder, 'refs', ...revision.split('/')), 'utf8').catch(() => null);
      const refAtStart = text !== null && /^[0-9a-f]{40}$/.test(text.trim()) ? text.trim() : null;
      return { id: randomUUID(), repoId: 'org/name', type: 'model', revision, commit: rev.commit, refAtStart, files, links };
    },
  };
  return w;
}

const blobs = (w: World): string => join(w.folder, 'blobs');
const snap = (w: World, p: string, commit = C): string => join(w.folder, 'snapshots', commit, ...p.split('/'));
const exists = async (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);
const fileOf = (e: DownloadEngine, path: string) => e.list()[0]!.files.find((f) => f.path === path)!;
/** The repo tree minus what lies outside the repo folder: a digest of the rest of the hub. */
async function outsideDigest(w: World): Promise<Record<string, string>> {
  const all = await treeDigest(w.fx.hubRoot);
  return Object.fromEntries(Object.entries(all).filter(([k]) => k !== 'models--org--name' && !k.startsWith('models--org--name/')));
}
const savedQueue = async (w: World): Promise<unknown> => JSON.parse(await readFile(join(w.userData, 'settings.json'), 'utf8')).downloads;

describe('a whole download', () => {
  test('full download → the scanner sees the repo, files linked as huggingface_hub does, refs/main = commit', async () => {
    const w = await world();
    const before = await outsideDigest(w);
    const e = w.engine();
    await e.start(await w.item());
    await e.whenIdle();
    expect(e.list()[0]!.files.map((f) => [f.path, f.state, f.bytes, f.error])).toEqual([
      ['w/model.gguf', 'done', W.length, null], ['config.json', 'done', J.length, null]]);
    expect(await readlink(snap(w, 'w/model.gguf'))).toBe(`../../../blobs/${EW}`);
    expect(await readlink(snap(w, 'config.json'))).toBe(`../../blobs/${EJ}`);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
    expect(Buffer.from(await readFile(join(blobs(w), EW))).equals(Buffer.from(W))).toBe(true);
    expect((await readdir(blobs(w))).sort()).toEqual([EJ, EW].sort());   // no .incomplete left
    const repo = (await scanHub(w.fx.hubRoot)).repos.find((r) => r.id === 'org/name')!;
    expect(repo.mainCommit).toBe(C);
    // (the scanner names 64-hex blobs only; a 40-hex small-file blob is seen through its link)
    expect(repo.files.map((f) => [f.relpath, f.linkPath.endsWith(f.relpath), f.isCurrent]).sort()).toEqual([['config.json', true, true], ['w/model.gguf', true, true]]);
    expect(repo.files.find((f) => f.relpath === 'w/model.gguf')!.blobEtag).toBe(EW);
    expect(repo.incomplete).toEqual([]);
    expect(await outsideDigest(w)).toEqual(before);   // nothing outside the repo folder changed
    expect(w.events.filter((x) => x.state === 'done').map((x) => x.path).sort()).toEqual(['config.json', 'w/model.gguf']);
    expect(w.hub.requests.some((r) => r.url.startsWith(w.hub.cdnOrigin) && 'authorization' in r.headers)).toBe(false);
  });

  test('a commit-hash revision writes no ref', async () => {
    const w = await world();
    const e = w.engine();
    await e.start(await w.item(undefined, C));
    await e.whenIdle();
    expect(e.list()[0]!.files.every((f) => f.state === 'done')).toBe(true);
    expect(await readdir(join(w.folder, 'refs'))).toEqual([]);
    expect(await readlink(snap(w, 'config.json'))).toBe(`../../blobs/${EJ}`);
  });

  test('files whose blob is already cached are linked into the new snapshot before the ref moves', async () => {
    const spec: FixtureSpec = { repos: [{ id: 'org/name', snapshots: [{ commit: OLD, files: [{ path: 'config.json', blob: { key: 'cfg', content: Buffer.from(J), etag: 'git-sha1' } }] }] }] };
    const w = await world({ spec });
    const rev = await w.client.revision('org/name', 'model', 'main');
    const listing = toRemoteListing({ repoId: 'org/name', type: 'model', commit: rev.commit, files: rev.siblings });
    const links = unchangedLinks(listing, await scanHub(w.fx.hubRoot));
    expect(links).toEqual([{ path: 'config.json', etag: EJ }]);
    const spy = scriptedFs(w.fx.fs, []);
    const e = w.engine({ fsLike: spy });
    await e.start(await w.item(['w/model.gguf'], 'main', links));
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf').state).toBe('done');
    expect(await readlink(snap(w, 'config.json'))).toBe(`../../blobs/${EJ}`);
    expect(await readlink(snap(w, 'config.json', OLD))).toBe(`../../blobs/${EJ}`);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
    const linkAt = spy.calls.findIndex((c) => c.method === 'symlink' && String(c.args[1]).endsWith(join(C, 'config.json')));
    const refAt = spy.calls.findIndex((c) => c.method === 'rename' && String(c.args[1]) === join(w.folder, 'refs', 'main'));
    expect(linkAt).toBeGreaterThan(-1);
    expect(refAt).toBeGreaterThan(linkAt);
    const repo = (await scanHub(w.fx.hubRoot)).repos.find((r) => r.id === 'org/name')!;
    expect(repo.files.filter((f) => f.isCurrent).map((f) => f.relpath).sort()).toEqual(['config.json', 'w/model.gguf']);
  });

  test('an older item finishing after a newer one never moves the ref back; the files stay linked', async () => {
    const NEWER = 'c3'.repeat(20);
    const w = await world();
    const e = w.engine();
    const older = await w.item();   // refs/main absent when it started
    expect(older.refAtStart).toBeNull();
    await mkdir(join(w.folder, 'refs'), { recursive: true });
    await writeFile(join(w.folder, 'refs', 'main'), NEWER);   // a newer download moved main on meanwhile
    await e.start(older);
    await e.whenIdle();
    const files = e.list()[0]!.files;
    expect(files.map((f) => f.state)).toEqual(['done', 'done']);
    expect(files.map((f) => f.error).filter((x) => x !== null)).toEqual([MSG.refMoved('main')]);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(NEWER);
    expect(await readlink(snap(w, 'w/model.gguf'))).toBe(`../../../blobs/${EW}`);
    expect(await readlink(snap(w, 'config.json'))).toBe(`../../blobs/${EJ}`);
    expect((await readdir(join(w.folder, 'refs'))).filter((n) => n.endsWith('.hfcm-tmp'))).toEqual([]);
  });

  test('a legacy item (no refAtStart) never moves the ref; its files stay linked, with a note', async () => {
    const w = await world();
    await mkdir(join(w.folder, 'refs'), { recursive: true });
    await writeFile(join(w.folder, 'refs', 'main'), OLD);
    const e = w.engine();
    const legacy = await w.item(['config.json']);
    delete legacy.refAtStart;
    await e.start(legacy);
    await e.whenIdle();
    expect(fileOf(e, 'config.json')).toMatchObject({ state: 'done', error: MSG.refUnknown('main') });
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(OLD);
    expect(await readlink(snap(w, 'config.json'))).toBe(`../../blobs/${EJ}`);
  });

  test('the ref moves from the commit it named at the start, and a ref already at the commit is left alone', async () => {
    const w = await world();
    await mkdir(join(w.folder, 'refs'), { recursive: true });
    await writeFile(join(w.folder, 'refs', 'main'), OLD);
    const e = w.engine();
    const item = await w.item(['config.json']);
    expect(item.refAtStart).toBe(OLD);
    await e.start(item);
    await e.whenIdle();
    expect(fileOf(e, 'config.json')).toMatchObject({ state: 'done', error: null });
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
    const ino = (await lstat(join(w.folder, 'refs', 'main'))).ino;
    const again = { ...(await w.item(['w/model.gguf'])), refAtStart: OLD };   // started before the first moved main to C
    await e.start(again);
    await e.whenIdle();
    expect(e.list()[1]!.files[0]).toMatchObject({ state: 'done', error: null });
    expect((await lstat(join(w.folder, 'refs', 'main'))).ino).toBe(ino);   // already C: not rewritten
  });

  test('an update of a repo whose cached blob is a store link links it into the new snapshot and moves the ref', async () => {
    const spec: FixtureSpec = { repos: [{ id: 'org/name', snapshots: [{ commit: OLD, files: [
      { path: 'w/model.gguf', blob: { key: 'w', content: Buffer.from(W), etag: 'sha256', storage: 'store' } }] }] }] };
    const w = await world({ spec });
    expect((await lstat(join(blobs(w), EW))).isSymbolicLink()).toBe(true);
    const rev = await w.client.revision('org/name', 'model', 'main');
    const model = await scanHub(w.fx.hubRoot);
    const links = unchangedLinks(toRemoteListing({ repoId: 'org/name', type: 'model', commit: rev.commit, files: rev.siblings }), model);
    expect(links).toEqual([{ path: 'w/model.gguf', etag: EW }]);
    const before = await outsideDigest(w);
    const e = w.engine();
    const item = await w.item(['config.json'], 'main', links);
    expect(item.refAtStart).toBe(OLD);
    await e.start(item);
    await e.whenIdle();
    expect(fileOf(e, 'config.json')).toMatchObject({ state: 'done', error: null });
    expect(await readlink(snap(w, 'w/model.gguf'))).toBe(`../../../blobs/${EW}`);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
    expect((await lstat(join(blobs(w), EW))).isSymbolicLink()).toBe(true);   // the store link itself is untouched
    expect(await outsideDigest(w)).toEqual(before);   // the shared store payload is not touched
    expect(w.hub.requests.some((r) => r.url.includes('model.gguf'))).toBe(false);   // never downloaded again
  });

  test('a selected file whose blob is already a verified store link is linked only; a damaged payload is refused', async () => {
    const spec: FixtureSpec = { repos: [{ id: 'org/name', snapshots: [{ commit: OLD, files: [
      { path: 'w/model.gguf', blob: { key: 'w', content: Buffer.from(W), etag: 'sha256', storage: 'store' } }] }] }] };
    const w = await world({ spec });
    const e = w.engine();
    await e.start(await w.item(['w/model.gguf']));
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'done', error: null });
    expect(await readlink(snap(w, 'w/model.gguf'))).toBe(`../../../blobs/${EW}`);
    // a payload with other bytes of the same size: never linked
    const w2 = await world({ spec });
    const payload = join(w2.fx.hubRoot, 'blobs', w2.fx.xetHash('w').slice(0, 2), w2.fx.xetHash('w'));
    const damaged = Buffer.from(W).fill(1);
    await writeFile(payload, damaged);
    const e2 = w2.engine();
    await e2.start(await w2.item(['w/model.gguf']));
    await e2.whenIdle();
    expect(fileOf(e2, 'w/model.gguf')).toMatchObject({ state: 'failed', error: MSG.different });
    expect(await exists(snap(w2, 'w/model.gguf'))).toBe(false);
    expect(Buffer.from(await readFile(payload)).equals(damaged)).toBe(true);
  });

  test('a store link at blobs/<etag> whose payload is missing fails with a message that says so; nothing is replaced', async () => {
    const spec: FixtureSpec = { repos: [{ id: 'org/name', snapshots: [{ commit: OLD, files: [
      { path: 'w/model.gguf', blob: { key: 'w', content: Buffer.from(W), etag: 'sha256', storage: 'store', danglingStore: true } }] }] }] };
    const w = await world({ spec });
    const link = await readlink(join(blobs(w), EW));
    const e = w.engine();
    await e.start(await w.item(['w/model.gguf']));
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'failed', error: MSG.danglingStore });
    expect(await readlink(join(blobs(w), EW))).toBe(link);
    expect(await exists(snap(w, 'w/model.gguf'))).toBe(false);
  });

  test('a no-symlink cache: a changed file is downloaded, an unchanged plain copy is copied (verified) into the new snapshot', async () => {
    const TW = 'text weights '.repeat(500);
    const TOK = '{"tok":1}';
    const repo: FakeHubRepo = { repoId: 'org/name', commit: C, lfs: ['w/model.gguf'], files: { 'w/model.gguf': enc(TW), 'config.json': J, 'tok.json': enc(TOK) } };
    const spec: FixtureSpec = { repos: [{ id: 'org/name', orphans: [{ key: 'tw', content: TW, etag: 'sha256' }], snapshots: [{ commit: OLD, files: [
      { path: 'config.json', plain: '{"model_type":"old"}' },   // changed on the Hub since
      { path: 'w/model.gguf', plain: TW },                       // unchanged, its blob kept (this app's copy layout)
      { path: 'tok.json', plain: TOK },                          // unchanged, no blob (huggingface_hub without symlinks)
    ] }] }] };
    const w = await world({ spec, repos: [repo] });
    const rev = await w.client.revision('org/name', 'model', 'main');
    const listing = toRemoteListing({ repoId: 'org/name', type: 'model', commit: rev.commit, files: rev.siblings });
    const model = await scanHub(w.fx.hubRoot);
    const states = fileStates(listing, model);
    expect(Object.fromEntries(states)).toEqual({ 'w/model.gguf': { kind: 'cached' }, 'config.json': { kind: 'update' }, 'tok.json': { kind: 'update' } });
    const links = unchangedLinks(listing, model);
    expect(links).toEqual([{ path: 'w/model.gguf', etag: sha256Hex(enc(TW)) }]);
    const e = w.engine({ symlinksSupported: false });
    await e.start(await w.item(['config.json', 'tok.json'], 'main', links));
    await e.whenIdle();
    expect(e.list()[0]!.files.map((f) => [f.path, f.state, f.error])).toEqual([['config.json', 'done', null], ['tok.json', 'done', null]]);
    for (const [p, body] of [['config.json', J], ['tok.json', enc(TOK)], ['w/model.gguf', enc(TW)]] as const) {
      const st = await lstat(snap(w, p));
      expect(st.isFile() && !st.isSymbolicLink()).toBe(true);
      expect(Buffer.from(await readFile(snap(w, p))).equals(Buffer.from(body))).toBe(true);
    }
    expect(await readFile(snap(w, 'config.json', OLD), 'utf8')).toBe('{"model_type":"old"}');   // the old revision untouched
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
    expect(w.hub.requests.some((r) => r.url.includes('model.gguf'))).toBe(false);
  });

  test('without symlinks the snapshot gets verified copies', async () => {
    const w = await world();
    const e = w.engine({ symlinksSupported: false });
    await e.start(await w.item());
    await e.whenIdle();
    expect(e.list()[0]!.files.every((f) => f.state === 'done')).toBe(true);
    const st = await lstat(snap(w, 'w/model.gguf'));
    expect(st.isFile()).toBe(true);
    expect(Buffer.from(await readFile(snap(w, 'w/model.gguf'))).equals(Buffer.from(W))).toBe(true);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
  });

  test('a snapshot copy that does not match the blob → failed, the copy left in place and named, ref not moved', async () => {
    const w = await world();
    const flipping: FsLike = {
      ...w.fx.fs,
      open: async (p, flags) => {
        const h = await w.fx.fs.open(p, flags);
        if (flags !== 'wx' || !p.includes(`${C}`)) return h;
        return { ...h, write: async (c: Uint8Array) => h.write(Uint8Array.from(c, (b, i) => (i === 0 ? b ^ 0xff : b))) } satisfies FileHandleLike;
      },
    };
    const e = w.engine({ symlinksSupported: false, fsLike: flipping });
    await e.start(await w.item(['config.json']));
    await e.whenIdle();
    const f = fileOf(e, 'config.json');
    expect(f.state).toBe('failed');
    expect(f.error).toContain('the snapshot copy does not match the blob');
    expect(f.error).toContain(`left at ${snap(w, 'config.json')}`);
    expect((await stat(snap(w, 'config.json'))).size).toBe(J.length);   // the bad copy is left in place, never removed
    expect(Buffer.from(await readFile(join(blobs(w), EJ))).equals(Buffer.from(J))).toBe(true);
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);
  });

  test('at most 4 files stream at once (the fake Hub counts open bodies)', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 7; i++) files[`f${i}.bin`] = bytes(3000, i);
    const w = await world({ repos: [{ repoId: 'org/name', commit: C, lfs: Object.keys(files), files }], hub: { slowBytesPerSec: 6000 } });
    let open = 0;
    let most = 0;
    const counting: HubClient = { ...w.client, open: async (...a) => {
      const r = await w.client.open(...a);
      open += 1; most = Math.max(most, open);
      async function* body() { try { yield* r.body; } finally { open -= 1; } }
      return { ...r, body: body() };
    } };
    const e = w.engine({ client: counting });
    await e.start(await w.item());
    await e.whenIdle();
    expect(e.list()[0]!.files.every((f) => f.state === 'done')).toBe(true);
    expect(most).toBe(4);
    expect(w.hub.streams.max).toBe(4);
  });
});

describe('kill, pause, resume, cancel', () => {
  class Killable extends AppSettingsStore {
    dead = false;
    override update(fn: Parameters<AppSettingsStore['update']>[0]) {
      return this.dead ? Promise.resolve(null) : super.update(fn);
    }
  }
  /** A client whose body stops after `n` bytes and then hangs until its signal aborts (a process killed mid-file). */
  function stallAfter(c: HubClient, n: number, state: { stalled: boolean }): HubClient {
    return {
      ...c,
      open: async (repoId, type, commit, path, from, signal) => {
        const r = await c.open(repoId, type, commit, path, from, signal);
        async function* body(): AsyncGenerator<Uint8Array> {
          let got = 0;
          for await (const chunk of r.body) {
            const part = chunk.subarray(0, n - got);
            if (part.length > 0) yield part;
            got += part.length;
            if (got >= n) {
              state.stalled = true;
              await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            }
          }
        }
        return { ...r, body: body() };
      },
    };
  }

  test('kill after N bytes → .incomplete kept, resumed, verified', async () => {
    const w = await world();
    const N = 123_457;
    const dying = new Killable(w.userData, { fs: w.fx.fs, makeSafeFs: (d) => SafeFs.create({ hubRoot: d, viewRoots: [], holdRoot: null }, w.fx.fs) });
    const state = { stalled: false };
    const first = w.engine({ client: stallAfter(w.client, N, state), settings: dying });
    const item = await w.item(['w/model.gguf']);
    await first.start(item);
    await vi.waitFor(() => expect(state.stalled).toBe(true), { timeout: 5000 });
    await vi.waitFor(async () => expect(JSON.stringify(await savedQueue(w))).toContain('"downloading"'));
    dying.dead = true;   // the process is gone: nothing more is saved
    const inc = join(blobs(w), `${EW}.incomplete`);
    expect((await stat(inc)).size).toBe(N);
    expect(await exists(join(blobs(w), EW))).toBe(false);

    const second = w.engine();
    await second.restore();
    expect(second.list()[0]!.files[0]).toMatchObject({ state: 'paused', bytes: N, error: null });
    await second.resume(item.id);
    await second.whenIdle();
    expect(second.list()[0]!.files[0]).toMatchObject({ state: 'done', bytes: W.length });
    expect(w.hub.requests.some((r) => r.headers.range === `bytes=${N}-`)).toBe(true);
    expect(Buffer.from(await readFile(join(blobs(w), EW))).equals(Buffer.from(W))).toBe(true);
    expect(await exists(inc)).toBe(false);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
    first.pause(item.id);
    await first.whenIdle();
    expect(Buffer.from(await readFile(join(blobs(w), EW))).equals(Buffer.from(W))).toBe(true);
  });

  test('pause keeps the partial file, resume finishes it; cancel drops the item and keeps its partial file', async () => {
    const w = await world({ hub: { slowBytesPerSec: 200_000 } });
    const e = w.engine();
    const item = await w.item(['w/model.gguf']);
    await e.start(item);
    const inc = join(blobs(w), `${EW}.incomplete`);
    await vi.waitFor(async () => expect((await stat(inc)).size).toBeGreaterThan(0), { timeout: 5000 });
    e.pause(item.id);
    await e.whenIdle();
    const kept = (await stat(inc)).size;
    expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'paused', bytes: kept });
    expect(kept).toBeLessThan(W.length);
    expect(JSON.stringify(await savedQueue(w))).toContain('"paused"');
    await e.resume(item.id);
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf').state).toBe('done');

    const again = await w.item(['config.json']);
    const slow = w.engine({ client: stallAfter(w.client, 5, { stalled: false }) });
    await slow.start(again);
    const incJ = join(blobs(w), `${EJ}.incomplete`);
    await vi.waitFor(async () => expect((await stat(incJ)).size).toBe(5), { timeout: 5000 });
    slow.cancel(again.id);
    await slow.whenIdle();
    expect(slow.list()).toEqual([]);
    expect((await stat(incJ)).size).toBe(5);
    expect(await savedQueue(w)).toEqual({ version: 1, items: [] });
  });
});

describe('refusals leave everything as found', () => {
  test('200 on a range request → refused, partial unchanged', async () => {
    const w = await world({ hub: { ignoreRange: ['w/model.gguf'] } });
    await mkdir(blobs(w), { recursive: true });
    const inc = join(blobs(w), `${EW}.incomplete`);
    await writeFile(inc, W.subarray(0, 1000));
    const before = await stat(inc);
    const e = w.engine();
    await e.start(await w.item(['w/model.gguf']));
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'failed', error: MSG.cannotResume });
    expect(MSG.cannotResume).toBe('the server cannot resume this file');
    const after = await stat(inc);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
    expect(Buffer.from(await readFile(inc)).equals(Buffer.from(W.subarray(0, 1000)))).toBe(true);
    expect(await exists(join(blobs(w), EW))).toBe(false);
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);
  });

  test('a partial file written by another program is resumed after hashing; one larger than the Hub size is refused', async () => {
    const w = await world();
    await mkdir(blobs(w), { recursive: true });
    await writeFile(join(blobs(w), `${EW}.incomplete`), W.subarray(0, 4321));
    await writeFile(join(blobs(w), `${EJ}.incomplete`), Buffer.concat([Buffer.from(J), Buffer.from('xx')]));
    const e = w.engine();
    await e.start(await w.item());
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf').state).toBe('done');
    expect(w.hub.requests.some((r) => r.headers.range === 'bytes=4321-')).toBe(true);
    expect(fileOf(e, 'config.json')).toMatchObject({ state: 'failed', error: MSG.partialTooBig });
    expect(await readFile(join(blobs(w), `${EJ}.incomplete`), 'utf8')).toBe(`${new TextDecoder().decode(J)}xx`);
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);   // not every file is done
  });

  test('a corrupt file → failed "does not match the Hub", partial kept, nothing committed', async () => {
    const w = await world({ hub: { corrupt: ['w/model.gguf'] } });
    const e = w.engine();
    await e.start(await w.item());
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'failed', error: MSG.partialMismatch });
    expect(MSG.partialMismatch).toMatch(/does not match the Hub/);
    expect((await stat(join(blobs(w), `${EW}.incomplete`))).size).toBe(W.length);
    expect(await exists(join(blobs(w), EW))).toBe(false);
    expect(await exists(snap(w, 'w/model.gguf'))).toBe(false);
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);
    expect(fileOf(e, 'config.json').state).toBe('done');
  });

  test('snapshot entry appeared → "a different file is already there", entry unchanged, ref not moved', async () => {
    const w = await world();
    await mkdir(join(w.folder, 'snapshots', C), { recursive: true });
    await writeFile(snap(w, 'config.json'), 'the user put this here');
    const e = w.engine();
    await e.start(await w.item());
    await e.whenIdle();
    expect(fileOf(e, 'config.json')).toMatchObject({ state: 'failed', error: MSG.different });
    expect(await readFile(snap(w, 'config.json'), 'utf8')).toBe('the user put this here');
    expect(fileOf(e, 'w/model.gguf').state).toBe('done');
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);
  });

  test('a different blob already at blobs/<etag> → "a different file is already there", both files untouched, never linked', async () => {
    const w = await world();
    await mkdir(blobs(w), { recursive: true });
    await writeFile(join(blobs(w), EJ), 'not the config');
    const e = w.engine();
    await e.start(await w.item(['config.json']));
    await e.whenIdle();
    expect(fileOf(e, 'config.json')).toMatchObject({ state: 'failed', error: MSG.different });
    expect(await readFile(join(blobs(w), EJ), 'utf8')).toBe('not the config');
    expect(await exists(snap(w, 'config.json'))).toBe(false);
  });

  test('a blob that appears during the download (commitBlob already-present): verified; a different one fails, the same one is used', async () => {
    for (const content of [enc('{"model_type":"other"}'), J]) {
      const w = await world();
      const planting: HubClient = {
        ...w.client,
        open: async (...a) => {
          const r = await w.client.open(...a);
          await writeFile(join(blobs(w), EJ), content);   // another downloader finished first
          return r;
        },
      };
      const e = w.engine({ client: planting });
      await e.start(await w.item(['config.json']));
      await e.whenIdle();
      const inc = join(blobs(w), `${EJ}.incomplete`);
      expect(Buffer.from(await readFile(inc)).equals(Buffer.from(J))).toBe(true);   // the verified partial is left, never deleted
      expect(Buffer.from(await readFile(join(blobs(w), EJ))).equals(Buffer.from(content))).toBe(true);
      if (content === J) {
        expect(fileOf(e, 'config.json').state).toBe('done');
        expect(fileOf(e, 'config.json').error).toContain(inc);
        expect(await readlink(snap(w, 'config.json'))).toBe(`../../blobs/${EJ}`);
      } else {
        expect(fileOf(e, 'config.json')).toMatchObject({ state: 'failed', error: MSG.different });
        expect(await exists(snap(w, 'config.json'))).toBe(false);
      }
    }
  });

  test('a failed ref update names the temp file it left', async () => {
    const w = await world();
    const e = w.engine({ fsLike: failingFs(w.fx.fs, 'rename', 'EIO', (p) => p.includes('.hfcm-tmp')) });
    await e.start(await w.item(['config.json']));
    await e.whenIdle();
    const f = fileOf(e, 'config.json');
    expect(f.state).toBe('failed');
    const tmp = /left at (.+?\.hfcm-tmp)\b/.exec(f.error ?? '')?.[1];
    expect(tmp).toBeDefined();
    expect(await readFile(tmp!, 'utf8')).toBe(C);
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);
    // Retry: the blob is verified and linked again ('same'); the ref attempt uses a new temp name and the old one stays.
    await e.resume(e.list()[0]!.id);
    await e.whenIdle();
    const tmp2 = /left at (.+?\.hfcm-tmp)\b/.exec(fileOf(e, 'config.json').error ?? '')?.[1];
    expect(tmp2).toBeDefined();
    expect(tmp2).not.toBe(tmp);
    expect(await readFile(tmp!, 'utf8')).toBe(C);
  });
});

describe('disk space', () => {
  test('free below the margin → paused "disk nearly full", nothing created, nothing requested', async () => {
    const w = await world();
    const seen: string[] = [];
    const e = w.engine({ statfs: async (p) => { seen.push(p); return { bavail: FREE_MARGIN + W.length - 1, bsize: 1 }; } });
    await e.start(await w.item(['w/model.gguf']));
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'paused-disk', error: MSG.diskFull });
    expect(seen).toEqual([w.fx.hubRoot]);   // the nearest existing folder on the way to blobs/
    expect(await exists(w.folder)).toBe(false);
    expect(w.hub.requests.filter((r) => r.url.startsWith(w.hub.cdnOrigin))).toEqual([]);
    // Exactly enough room: it downloads. Without symlinks the snapshot copy needs room as well.
    const fits = w.engine({ statfs: async () => ({ bavail: FREE_MARGIN + W.length, bsize: 1 }) });
    await fits.start(await w.item(['w/model.gguf']));
    await fits.whenIdle();
    expect(fileOf(fits, 'w/model.gguf').state).toBe('done');
    const w2 = await world();
    const copying = w2.engine({ symlinksSupported: false, statfs: async () => ({ bavail: FREE_MARGIN + 2 * W.length - 1, bsize: 1 }) });
    await copying.start(await w2.item(['w/model.gguf']));
    await copying.whenIdle();
    expect(fileOf(copying, 'w/model.gguf').state).toBe('paused-disk');
  });

  test('ENOSPC during a write → paused "disk nearly full", partial kept, nothing committed', async () => {
    const w = await world();
    let written = 0;
    const full: FsLike = {
      ...w.fx.fs,
      open: async (p, flags) => {
        const h = await w.fx.fs.open(p, flags);
        if (flags === 'r') return h;
        return { ...h, write: async (c: Uint8Array) => {
          if (written > 50_000) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          await h.write(c);
          written += c.length;
        } } satisfies FileHandleLike;
      },
    };
    const e = w.engine({ fsLike: full });
    await e.start(await w.item(['w/model.gguf']));
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'paused-disk', error: MSG.diskFull });
    expect((await stat(join(blobs(w), `${EW}.incomplete`))).size).toBe(written);
    expect(await exists(join(blobs(w), EW))).toBe(false);
    expect(await exists(snap(w, 'w/model.gguf'))).toBe(false);
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);
  });
});

describe('other programs', () => {
  test('other-downloader lock + fresh .incomplete → waiting-other, proceeds after the lock goes', async () => {
    const w = await world();
    await mkdir(blobs(w), { recursive: true });
    await writeFile(join(blobs(w), `${EW}.incomplete`), W.subarray(0, 777));
    const lock = join(w.fx.hubRoot, '.locks', 'models--org--name', `${EW}.lock`);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, '');
    const e = w.engine();
    await e.start(await w.item(['w/model.gguf']));
    await vi.waitFor(() => expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'waiting-other', error: MSG.otherProgram }));
    expect(w.hub.requests.filter((r) => r.url.startsWith(w.hub.cdnOrigin))).toEqual([]);
    await unlink(lock);   // the test plays the other program finishing
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf').state).toBe('done');
    expect(w.hub.requests.some((r) => r.headers.range === 'bytes=777-')).toBe(true);
    expect(await readdir(join(w.fx.hubRoot, '.locks', 'models--org--name'))).toEqual([]);   // the app creates no lock files
  });

  test('a stale partial next to a lock (older than 10 minutes) is not another downloader', async () => {
    const w = await world();
    await mkdir(blobs(w), { recursive: true });
    await writeFile(join(blobs(w), `${EW}.incomplete`), W.subarray(0, 10));
    const lock = join(w.fx.hubRoot, '.locks', 'models--org--name', `${EW}.lock`);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, '');
    const e = w.engine({ now: () => Date.now() + 11 * 60_000 });
    await e.start(await w.item(['w/model.gguf']));
    await e.whenIdle();
    expect(fileOf(e, 'w/model.gguf').state).toBe('done');
    expect(w.events.some((x) => x.state === 'waiting-other')).toBe(false);
  });

  test('the AppLock held by a deletion or sync → waiting-other, committed once it is released', async () => {
    const w = await world();
    const deletion = new AppLock(w.lockDir);
    await deletion.acquire(Date.now());
    const e = w.engine();
    await e.start(await w.item(['config.json']));
    await vi.waitFor(() => expect(fileOf(e, 'config.json')).toMatchObject({ state: 'waiting-other', error: MSG.appBusy }));
    expect(await exists(join(blobs(w), EJ))).toBe(false);
    await deletion.release();
    await e.whenIdle();
    expect(fileOf(e, 'config.json').state).toBe('done');
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
    expect(await new AppLock(w.lockDir).isHeld(Date.now())).toBe(false);
  });
});

describe('progress and persistence', () => {
  test('progress is throttled per file by time; every state change is sent', async () => {
    const w = await world();
    const frozen = w.engine({ now: () => 1_000_000 });
    await frozen.start(await w.item(['w/model.gguf']));
    await frozen.whenIdle();
    const states = w.events.map((x) => x.state);
    expect(states.filter((s) => s === 'downloading')).toHaveLength(1);   // the state change only: no time has passed
    expect(states).toEqual(['queued', 'downloading', 'verifying', 'done']);
    expect(w.events.at(-1)).toMatchObject({ bytes: W.length, size: W.length, error: null });

    const w2 = await world();
    let t = 0;
    const moving = w2.engine({ now: () => (t += 300) });
    await moving.start(await w2.item(['w/model.gguf']));
    await moving.whenIdle();
    const dl = w2.events.filter((x) => x.state === 'downloading');
    expect(dl.length).toBeGreaterThan(2);
    expect(dl.slice(1).every((x) => x.bytesPerSec > 0)).toBe(true);
  });

  test('the queue persists (version 1) and restore() brings unfinished files back paused', async () => {
    const w = await world();
    const e = w.engine({ statfs: async () => ({ bavail: 0, bsize: 1 }) });
    const item = await w.item();
    await e.start(item);
    await e.whenIdle();
    const saved = await savedQueue(w) as { version: number; items: QueueItem[] };
    expect(saved.version).toBe(1);
    expect(saved.items.map((i) => i.id)).toEqual([item.id]);
    expect(saved.items[0]!.files.map((f) => f.state)).toEqual(['paused-disk', 'paused-disk']);
    const next = w.engine();
    await next.restore();
    expect(next.list()[0]!.files.map((f) => f.state)).toEqual(['paused', 'paused']);
    await next.resume(item.id);
    await next.whenIdle();
    expect(next.list()[0]!.files.map((f) => f.state)).toEqual(['done', 'done']);
    expect((await savedQueue(w) as { items: QueueItem[] }).items[0]!.files.map((f) => f.state)).toEqual(['done', 'done']);
  });

  test('a bad downloads block is an empty queue and leaves autoEmptyDays untouched; an untrusted file is never rewritten', async () => {
    const w = await world();
    const file = join(w.userData, 'settings.json');
    await writeFile(file, JSON.stringify({ autoEmptyDays: 7, downloads: { version: 1, items: 'nope' } }));
    const e = w.engine();
    await e.restore();
    expect(e.list()).toEqual([]);
    const item = await w.item(['config.json']);
    await e.start(item);
    await e.whenIdle();
    const out = JSON.parse(await readFile(file, 'utf8'));
    expect(out.autoEmptyDays).toBe(7);
    expect(out.downloads.items.map((i: QueueItem) => i.id)).toEqual([item.id]);

    const w2 = await world();
    const bad = JSON.stringify({ autoEmptyDays: 0, downloads: { version: 1, items: [] } });
    await writeFile(join(w2.userData, 'settings.json'), bad);
    const e2 = w2.engine();
    await e2.start(await w2.item(['config.json']));
    await e2.whenIdle();
    expect(fileOf(e2, 'config.json').state).toBe('done');
    expect(await readFile(join(w2.userData, 'settings.json'), 'utf8')).toBe(bad);

    // A bad advice block is not silently replaced by the defaults either (as remember() does)
    const w3 = await world();
    const badAdvice = JSON.stringify({ autoEmptyDays: 7, advice: { context: 'lots' } });
    await writeFile(join(w3.userData, 'settings.json'), badAdvice);
    const e3 = w3.engine();
    await e3.start(await w3.item(['config.json']));
    await e3.whenIdle();
    expect(fileOf(e3, 'config.json').state).toBe('done');
    expect(await readFile(join(w3.userData, 'settings.json'), 'utf8')).toBe(badAdvice);
    expect(e3.saveError).toContain('advice');
  });

  test('start validates the item: unsafe paths, revisions and duplicates are refused before anything happens', async () => {
    const w = await world();
    const e = w.engine();
    const good = await w.item(['config.json']);
    const f = good.files[0]!;
    for (const bad of [{ ...good, files: [{ ...f, path: '../x' }] }, { ...good, revision: '../main' }, { ...good, repoId: 'a/b/c' },
      { ...good, files: [{ ...f, etag: 'z'.repeat(40) }] }, { ...good, commit: 'main' }, { ...good, files: [f, f] }]) {
      await expect(e.start(bad as QueueItem)).rejects.toThrow();
    }
    await e.start(good);
    await expect(e.start(good)).rejects.toThrow(/already in the queue/);
    await e.whenIdle();
    expect(e.list()).toHaveLength(1);
  });
});

/** A fs whose 'wx'/'a' handles matching `when` throw ENOSPC after `after` bytes while `on()` is true. */
function noSpaceFs(base: FsLike, when: (p: string) => boolean, after: number, on: () => boolean = () => true): FsLike {
  return {
    ...base,
    open: async (p, flags) => {
      const h = await base.open(p, flags);
      if (flags === 'r' || !when(p) || !on()) return h;
      let n = 0;
      return { ...h, write: async (c: Uint8Array) => {
        if (n + c.length > after) {
          await h.write(c.subarray(0, Math.max(0, after - n)));
          n = after;
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        await h.write(c);
        n += c.length;
      } } satisfies FileHandleLike;
    },
  };
}
const SEVEN: Record<string, Uint8Array> = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}.bin`, bytes(3000, i)]));

describe('edge cases', () => {
  test('a failing other-downloader check gives its stream slot back: repeated EACCES on .locks never exhausts the 4 slots', async () => {
    const w = await world({ repos: [{ repoId: 'org/name', commit: C, lfs: Object.keys(SEVEN), files: SEVEN }] });
    let denied = true;
    const fsLike: FsLike = { ...w.fx.fs, lstat: async (p) => {
      if (denied && p.includes(`${'/'}.locks${'/'}`)) throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
      return w.fx.fs.lstat(p);
    } };
    const e = w.engine({ fsLike });
    const item = await w.item();
    await e.start(item);
    await e.whenIdle();
    for (let i = 0; i < 3; i++) {
      expect(e.list()[0]!.files.map((f) => f.state)).toEqual(Array(7).fill('failed'));
      await e.resume(item.id);
      await e.whenIdle();
    }
    denied = false;
    await e.resume(item.id);
    await e.whenIdle();
    expect(e.list()[0]!.files.map((f) => f.state)).toEqual(Array(7).fill('done'));
  });

  test('free space is reserved across running files: two files that each fit alone do not both start', async () => {
    const A = bytes(300_000, 1);
    const B = bytes(300_000, 2);
    const w = await world({ repos: [{ repoId: 'org/name', commit: C, lfs: ['a.bin', 'b.bin'], files: { 'a.bin': A, 'b.bin': B } }] });
    const slowOpen: HubClient = { ...w.client, open: async (...a) => {
      await new Promise((r) => setTimeout(r, 100));
      return w.client.open(...a);
    } };
    const e = w.engine({ client: slowOpen, statfs: async () => ({ bavail: FREE_MARGIN + A.length + 1000, bsize: 1 }) });
    const item = await w.item();
    await e.start(item);
    await e.whenIdle();
    expect(e.list()[0]!.files.map((f) => f.state).sort()).toEqual(['done', 'paused-disk']);
    expect(e.list()[0]!.files.find((f) => f.state === 'paused-disk')!.bytes).toBe(0);
    await e.resume(item.id);   // the first file's reservation ended with its run
    await e.whenIdle();
    expect(e.list()[0]!.files.map((f) => f.state)).toEqual(['done', 'done']);
  });

  test('an unchanged file whose cached blob does not match the Hub is not linked and the ref does not move', async () => {
    const spec: FixtureSpec = { repos: [{ id: 'org/name', snapshots: [{ commit: OLD, files: [{ path: 'config.json', blob: { key: 'cfg', content: Buffer.from(J), etag: 'git-sha1' } }] }] }] };
    const w = await world({ spec });
    const rev = await w.client.revision('org/name', 'model', 'main');
    const links = unchangedLinks(toRemoteListing({ repoId: 'org/name', type: 'model', commit: rev.commit, files: rev.siblings }), await scanHub(w.fx.hubRoot));
    expect(links).toEqual([{ path: 'config.json', etag: EJ }]);
    const damaged = Buffer.from(J).fill(0x41);   // same size, other bytes: hours after the scan
    await writeFile(join(blobs(w), EJ), damaged);
    const refBefore = await readFile(join(w.folder, 'refs', 'main'), 'utf8').catch(() => null);
    const e = w.engine();
    await e.start(await w.item(['w/model.gguf'], 'main', links));
    await e.whenIdle();
    const f = fileOf(e, 'w/model.gguf');
    expect(f.state).toBe('failed');
    expect(f.error).toContain(MSG.cachedMismatch);
    expect(f.error).toContain('config.json');
    expect(await exists(snap(w, 'config.json'))).toBe(false);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8').catch(() => null)).toBe(refBefore);
    expect(Buffer.from(await readFile(join(blobs(w), EJ))).equals(damaged)).toBe(true);
    expect(w.events.some((x) => x.path === 'w/model.gguf' && x.state === 'verifying')).toBe(true);
  });

  test('ENOSPC part-way through a snapshot copy → paused, the copy named (spaces in the paths); resume appends and verifies', async () => {
    const SP = 'w/my model.gguf';
    const w = await world({ spacedHub: true, repos: [{ repoId: 'org/name', commit: C, lfs: [SP], files: { [SP]: W } }] });
    expect(w.folder).toContain(' ');
    let full = true;
    const fsLike = noSpaceFs(w.fx.fs, (p) => p.includes(join('snapshots', C)), 1000, () => full);
    const spy = scriptedFs(fsLike, []);
    const e = w.engine({ symlinksSupported: false, fsLike: spy });
    const item = await w.item([SP]);
    await e.start(item);
    await e.whenIdle();
    const entry = snap(w, SP);
    expect(fileOf(e, SP)).toMatchObject({ state: 'paused-disk', error: `${MSG.diskFull}; the partial copy is left at ${entry}` });
    const short = await stat(entry);
    expect(short.size).toBe(1000);
    expect(Buffer.from(await readFile(join(blobs(w), EW))).equals(Buffer.from(W))).toBe(true);   // the verified blob is committed
    full = false;
    await e.resume(item.id);
    await e.whenIdle();
    expect(fileOf(e, SP).state).toBe('done');
    const after = await stat(entry);
    expect(after.ino).toBe(short.ino);   // appended to the same file, not copied again
    expect(Buffer.from(await readFile(entry)).equals(Buffer.from(W))).toBe(true);
    // created, prefix-checked, appended and checked (that check is the content check before the ref moves)
    expect(spy.calls.filter((c) => c.method === 'open' && c.args[0] === entry).map((c) => c.args[1])).toEqual(['wx', 'r', 'a', 'r']);
    expect(spy.calls.some((c) => c.method === 'rename' && String(c.args[1]).startsWith(join(w.folder, 'snapshots')))).toBe(false);
    expect(await readdir(dirname(entry))).toEqual(['my model.gguf']);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
  });

  test('a shorter snapshot entry that is not the start of the blob → "a different file is already there", untouched', async () => {
    const w = await world();
    await mkdir(join(w.folder, 'snapshots', C), { recursive: true });
    await writeFile(snap(w, 'config.json'), '{"x"');
    const e = w.engine({ symlinksSupported: false });
    await e.start(await w.item(['config.json']));
    await e.whenIdle();
    expect(fileOf(e, 'config.json')).toMatchObject({ state: 'failed', error: MSG.different });
    expect(await readFile(snap(w, 'config.json'), 'utf8')).toBe('{"x"');
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);
  });

  test('a failed ref update names its temp file from the error field, with spaces in the hub path', async () => {
    const w = await world({ spacedHub: true });
    const e = w.engine({ fsLike: failingFs(w.fx.fs, 'rename', 'EIO', (p) => p.includes('.hfcm-tmp')) });
    await e.start(await w.item(['config.json']));
    await e.whenIdle();
    const err = fileOf(e, 'config.json').error ?? '';
    const tmps = (await readdir(join(w.folder, 'refs'))).filter((n) => n.endsWith('.hfcm-tmp'));
    expect(tmps).toHaveLength(1);
    expect(err).toContain(`left at ${join(w.folder, 'refs', tmps[0]!)}`);
  });

  test('two items for the same blob at once: one writer, one download, both done', async () => {
    const w = await world({ hub: { slowBytesPerSec: 600_000 } });
    const spy = scriptedFs(w.fx.fs, []);
    const e = w.engine({ fsLike: spy });
    const a = await w.item(['w/model.gguf']);
    const b = await w.item(['w/model.gguf']);
    await Promise.all([e.start(a), e.start(b)]);
    await e.whenIdle();
    expect(e.list().map((i) => i.files[0]!.state)).toEqual(['done', 'done']);
    expect(w.hub.requests.filter((r) => r.url.startsWith(w.hub.cdnOrigin) && r.url.endsWith('model.gguf'))).toHaveLength(1);
    const writers = spy.calls.filter((c) => c.method === 'open' && c.args[1] !== 'r' && String(c.args[0]).endsWith(`${EW}.incomplete`));
    expect(writers).toHaveLength(1);
    expect(await readlink(snap(w, 'w/model.gguf'))).toBe(`../../../blobs/${EW}`);
  });

  test('one item listing the same blob twice: downloaded once, both paths linked', async () => {
    const same = bytes(5000, 9);
    const w = await world({ repos: [{ repoId: 'org/name', commit: C, lfs: ['a.bin', 'd/b.bin'], files: { 'a.bin': same, 'd/b.bin': same } }], hub: { slowBytesPerSec: 20_000 } });
    const e = w.engine();
    await e.start(await w.item());
    await e.whenIdle();
    expect(e.list()[0]!.files.map((f) => f.state)).toEqual(['done', 'done']);
    expect(w.hub.requests.filter((r) => r.url.startsWith(w.hub.cdnOrigin))).toHaveLength(1);
    expect(await readlink(snap(w, 'a.bin'))).toBe(`../../blobs/${sha256Hex(same)}`);
    expect(await readlink(snap(w, 'd/b.bin'))).toBe(`../../../blobs/${sha256Hex(same)}`);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
  });

  test('pause or cancel during the commit step: the commit runs to its end; a failure in it is still recorded', async () => {
    for (const action of ['pause', 'cancel', 'pause-failing'] as const) {
      const w = await world();
      let engine: DownloadEngine | null = null;
      let id = '';
      const base = action === 'pause-failing' ? failingFs(w.fx.fs, 'rename', 'EIO', (p) => p.includes('.hfcm-tmp')) : w.fx.fs;
      const fsLike: FsLike = { ...base, rename: async (a, b) => {
        if (a.endsWith('.incomplete')) {
          if (action === 'cancel') engine!.cancel(id);
          else engine!.pause(id);
        }
        return base.rename(a, b);
      } };
      engine = w.engine({ fsLike });
      const item = await w.item(['config.json']);
      id = item.id;
      await engine.start(item);
      await engine.whenIdle();
      expect(await readlink(snap(w, 'config.json'))).toBe(`../../blobs/${EJ}`);
      if (action === 'cancel') {
        expect(engine.list()).toEqual([]);
        expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
      } else if (action === 'pause') {
        expect(fileOf(engine, 'config.json')).toMatchObject({ state: 'done', error: null });
        expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
      } else {
        expect(fileOf(engine, 'config.json').state).toBe('failed');
        expect(fileOf(engine, 'config.json').error).toMatch(/left at .+?\.hfcm-tmp\b/);
      }
    }
  });

  test('pause while waiting for the AppLock: the commit never starts; resume commits it', async () => {
    const w = await world();
    const deletion = new AppLock(w.lockDir);
    await deletion.acquire(Date.now());
    const e = w.engine();
    const item = await w.item(['config.json']);
    await e.start(item);
    await vi.waitFor(() => expect(fileOf(e, 'config.json').state).toBe('waiting-other'));
    e.pause(item.id);
    await e.whenIdle();
    expect(fileOf(e, 'config.json').state).toBe('paused');
    expect(await exists(join(blobs(w), EJ))).toBe(false);
    expect(Buffer.from(await readFile(join(blobs(w), `${EJ}.incomplete`))).equals(Buffer.from(J))).toBe(true);
    await deletion.release();
    await e.resume(item.id);
    await e.whenIdle();
    expect(fileOf(e, 'config.json').state).toBe('done');
  }, 20_000); // two lock waits plus real file I/O; slow under parallel load (Stryker runs 8 workers)

  test('a pause that lands while a lock attempt is under way stays paused (never overwritten by waiting-other); resume commits', async () => {
    const w = await world();
    const real = new AppLock(w.lockDir);
    let pauseNow: (() => void) | null = null;
    // the first attempt is paused while it runs, then finds the lock taken
    const lock = {
      acquire: async (now: number) => {
        if (pauseNow === null) return real.acquire(now);
        const p = pauseNow;
        pauseNow = null;
        p();
        throw new ExecError('LOCKED', 'Another operation is in progress.', w.lockDir);
      },
      release: () => real.release(),
    } as unknown as AppLock;
    const e = w.engine({ lock });
    const item = await w.item(['config.json']);
    pauseNow = () => e.pause(item.id);
    await e.start(item);
    await e.whenIdle();
    expect(fileOf(e, 'config.json').state).toBe('paused');
    await e.resume(item.id);
    await e.whenIdle();
    expect(fileOf(e, 'config.json').state).toBe('done');
  });

  test('minors: start refuses done files; an untrusted settings file sets saveError; restore of a bad block writes nothing', async () => {
    const w = await world();
    const e = w.engine();
    const item = await w.item(['config.json']);
    await expect(e.start({ ...item, files: [{ ...item.files[0]!, state: 'done' }] })).rejects.toThrow(/done/);
    const file = join(w.userData, 'settings.json');
    const badBlock = JSON.stringify({ autoEmptyDays: 7, downloads: 'x' });
    await writeFile(file, badBlock);
    await e.restore();
    await e.whenIdle();
    expect(await readFile(file, 'utf8')).toBe(badBlock);
    const untrusted = JSON.stringify({ autoEmptyDays: 0 });
    await writeFile(file, untrusted);
    await e.start(item);
    await e.whenIdle();
    expect(e.saveError).toMatch(/not saved/);
    expect(await readFile(file, 'utf8')).toBe(untrusted);
  });
});

describe('never deletes, truncates or overwrites', () => {
  test('no unlink or rmdir is reached on any path, success or failure (fs spy)', async () => {
    const calls: string[] = [];
    const run = async (o: Parameters<typeof world>[0], tweak: (w: World) => Promise<void> = async () => undefined,
      extra: (w: World, fs: FsLike) => Partial<DownloadEngineDeps> & { fsLike?: FsLike } = () => ({})) => {
      const w = await world(o);
      await tweak(w);
      const fsLike = recordingFs(w.fx.fs, calls);
      const e = w.engine({ fsLike, ...extra(w, fsLike) });
      await e.start(await w.item());
      await e.whenIdle();
      await e.resume(e.list()[0]!.id);   // Retry every failure once
      await e.whenIdle();
      return { w, e };
    };
    await run({});
    await run({}, async () => undefined, () => ({ symlinksSupported: false }));
    await run({ hub: { corrupt: ['w/model.gguf', 'config.json'] } });
    await run({ hub: { ignoreRange: ['w/model.gguf'] } }, async (w) => {
      await mkdir(blobs(w), { recursive: true });
      await writeFile(join(blobs(w), `${EW}.incomplete`), W.subarray(0, 10));
    });
    await run({}, async (w) => {
      await mkdir(join(w.folder, 'snapshots', C), { recursive: true });
      await writeFile(snap(w, 'config.json'), 'mine');
      await writeFile(join(w.folder, 'blobs-not'), '');
    });
    await run({}, async () => undefined, (w, fs) => ({ fsLike: failingFs(fs, 'rename', 'EIO', (p) => p.includes('.hfcm-tmp')) }));
    await run({}, async () => undefined, () => ({ statfs: async () => ({ bavail: 0, bsize: 1 }) }));
    for (const method of ['open', 'rename', 'symlink', 'mkdir', 'writeFile'] as const) {
      await run({}, async () => undefined, (w, fs) => ({ fsLike: failingFs(fs, method, 'EIO') }));
    }
    // ENOSPC in the stream and in a snapshot copy, a damaged cached blob, and pause /
    // cancel arriving during the commit step.
    await run({}, async () => undefined, (w, fs) => ({ fsLike: noSpaceFs(fs, (p) => p.endsWith('.incomplete'), 5000) }));
    await run({}, async () => undefined, (w, fs) => ({ symlinksSupported: false, fsLike: noSpaceFs(fs, (p) => p.includes(join('snapshots', C)), 10) }));
    await run({ spec: { repos: [{ id: 'org/name', snapshots: [{ commit: OLD, files: [{ path: 'config.json', blob: { key: 'cfg', content: Buffer.from(J), etag: 'git-sha1' } }] }] }] } },
      async (w) => { await writeFile(join(blobs(w), EJ), Buffer.from(J).fill(0x42)); });
    for (const act of ['pause', 'cancel'] as const) {
      const w = await world({ hub: { slowBytesPerSec: 200_000 } });
      let eng: DownloadEngine | null = null;
      const rec = recordingFs(w.fx.fs, calls);
      const fsLike: FsLike = { ...rec, rename: async (a, b) => {
        if (a.endsWith('.incomplete')) eng![act](eng!.list()[0]!.id);
        return rec.rename(a, b);
      } };
      eng = w.engine({ fsLike });
      const item = await w.item();
      await eng.start(item);
      await vi.waitFor(async () => expect(await exists(join(blobs(w), `${EW}.incomplete`))).toBe(true));
      if (act === 'pause') {
        eng.pause(item.id);
        await eng.whenIdle();
        await eng.resume(item.id);
      }
      await eng.whenIdle();
    }
    const { w, e } = await run({ hub: { slowBytesPerSec: 100_000 } }, async () => undefined, () => ({}));
    expect(e.list()[0]!.files.every((f) => f.state === 'done')).toBe(true);
    void w;
    const allowed = new Set(['lstat', 'stat', 'readlink', 'readdir', 'readFile', 'realpath', 'statfs', 'mkdir', 'open', 'writeFile', 'rename', 'symlink']);
    expect(calls.length).toBeGreaterThan(100);
    expect([...new Set(calls)].filter((m) => !allowed.has(m))).toEqual([]);
    expect(calls).not.toContain('unlink');   // the allow-list above already excludes every removing method of FsLike
  }, 30_000);

  test('the engine reaches the filesystem only through DownloadFs / SafeFs and read-only fsx helpers', async () => {
    const src = await readFile(join(__dirname, '../../src/main/download/engine.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../../core/download/download-fs', '../../core/download/hash', '../../core/download/remote-repo',
      '../../core/exec/errors', '../../core/exec/lock', '../../core/fsx', '../../core/safe-fs', '../../core/types',
      '../../shared/hub-input', '../app-settings', '../hub/client', './queue', 'node:path'].sort());
    expect(src).not.toMatch(/require\(|import\(/);
    // From fsx only the read-only names: factsOf, factsMatch, isNotFound, readFs, ReadFs.
    expect(/import \{ ([^}]+) \} from '..\/..\/core\/fsx'/.exec(src)?.[1]).toBe('factsMatch, factsOf, isNotFound, readFs, type ReadFs');
  });
});

describe('committed files must still be there before the ref moves', () => {
  test('a blob removed between one file\'s commit and the last → the item fails, the ref is not moved; Retry repairs it', async () => {
    const w = await world({ hub: { slowBytesPerSec: 300_000 } });
    const e = w.engine();
    const item = await w.item();
    await e.start(item);
    while (!w.events.some((x) => x.path === 'config.json' && x.state === 'done')) await new Promise((r) => setTimeout(r, 5));
    expect(fileOf(e, 'w/model.gguf').state).not.toBe('done');
    await unlink(join(blobs(w), EJ));   // a deletion behind the engine's back
    await e.whenIdle();
    expect(fileOf(e, 'config.json')).toMatchObject({ state: 'failed', error: MSG.removed });
    expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'failed', error: MSG.removed });
    expect(MSG.removed).toBe('files of this download were removed; download it again');
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);
    // Retry: the removed file is fetched again, everything verified, then the ref moves
    await e.resume(item.id);
    await e.whenIdle();
    expect(e.list()[0]!.files.map((f) => f.state)).toEqual(['done', 'done']);
    expect(await readFile(join(w.folder, 'refs', 'main'), 'utf8')).toBe(C);
  });

  test('the copies are re-hashed before the AppLock is taken; under the lock only their facts are checked', async () => {
    const w = await world({ hub: { slowBytesPerSec: 300_000 } });
    const events: string[] = [];
    const entry = snap(w, 'config.json');
    const fsLike: FsLike = { ...w.fx.fs, open: async (p, flags) => {
      if (p === entry) events.push(`open:${flags}`);
      return w.fx.fs.open(p, flags);
    } };
    const real = new AppLock(w.lockDir);
    const lock = {
      acquire: async (now: number) => { await real.acquire(now); events.push('acquire'); },
      release: async () => { events.push('release'); await real.release(); },
    } as unknown as AppLock;
    const e = w.engine({ symlinksSupported: false, fsLike, lock });
    await e.start(await w.item());
    await e.whenIdle();
    expect(e.list()[0]!.files.map((f) => f.state)).toEqual(['done', 'done']);
    const last = events.lastIndexOf('acquire');
    // config.json finished first; the last commit (the weights) re-reads its copy before taking the lock, never under it
    expect(events.slice(0, last).filter((x) => x === 'open:r').length).toBeGreaterThanOrEqual(2);
    expect(events.slice(last)).not.toContain('open:r');
    expect(events.at(last - 1)).toBe('open:r');
  });

  test('without symlinks a committed copy is checked by content: same size, other bytes → the ref is not moved', async () => {
    const w = await world({ hub: { slowBytesPerSec: 300_000 } });
    const e = w.engine({ symlinksSupported: false });
    await e.start(await w.item());
    while (!w.events.some((x) => x.path === 'config.json' && x.state === 'done')) await new Promise((r) => setTimeout(r, 5));
    expect(fileOf(e, 'w/model.gguf').state).not.toBe('done');
    const other = Buffer.from(J).fill(0x42);
    await writeFile(snap(w, 'config.json'), other);   // same size, other bytes, behind the engine's back
    await e.whenIdle();
    expect(MSG.copyMismatch).toBe('a copied file does not match the Hub');
    expect(fileOf(e, 'config.json')).toMatchObject({ state: 'failed', error: MSG.copyMismatch });
    expect(fileOf(e, 'w/model.gguf')).toMatchObject({ state: 'failed', error: MSG.copyMismatch });
    expect(await exists(join(w.folder, 'refs', 'main'))).toBe(false);
    expect(Buffer.from(await readFile(snap(w, 'config.json'))).equals(other)).toBe(true);   // left as it is
  });
});
