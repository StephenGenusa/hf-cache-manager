import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readGgufHeader } from '../../src/core/views/gguf-header';
import { createHubClient, HubClientError, hubFetch, networkBlockedCount, type HubClient } from '../../src/main/hub/client';
import type { HubEndpoint } from '../../src/main/hub/policy';
import { gitBlobId, sha256Hex, startFakeHub, type FakeHub, type FakeHubOptions, type FakeHubRepo } from '../helpers/fake-hub';

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const MIB = 1024 * 1024;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const bytes = (n: number, seed = 7): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function u64(n: bigint): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; }
function gstr(s: string): Uint8Array[] { const b = enc(s); return [u64(BigInt(b.length)), b]; }
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** GGUF v3, no tensors, one string KV. */
const smallGguf = (): Uint8Array =>
  concat([enc('GGUF'), u32(3), u64(0n), u64(1n), ...gstr('general.architecture'), u32(8), ...gstr('llama')]);
/** A GGUF whose first key claims a 40 MiB name: reading it needs bytes beyond the 32 MiB cap. */
const hugeKeyGguf = (): Uint8Array => concat([enc('GGUF'), u32(3), u64(0n), u64(1n), u64(BigInt(40 * MIB)), enc('x'.repeat(64))]);

const REPOS: FakeHubRepo[] = [
  { repoId: 'org/model', commit: C1, lfs: ['big.bin', 'm.gguf', 'huge.gguf'],
    files: { 'config.json': enc('{"a":1}'), 'big.bin': bytes(5000), 'dir/a b#.txt': enc('spaced'), 'm.gguf': smallGguf(),
      'huge.gguf': hugeKeyGguf(), 'wide.bin': bytes(Math.floor(2.5 * MIB)) } },
  { repoId: 'org/gated', commit: C2, gated: true, files: { 'w.bin': bytes(100) } },
  { repoId: 'org/data', type: 'dataset', commit: C2, files: { 'train.csv': enc('a,b\n1,2\n') } },
];

let hub: FakeHub | null = null;
const servers: http.Server[] = [];
let seen: string[] = [];

/** fetch that refuses anything but the loopback fakes, and records every URL it is asked for. */
function guardedFetch(allowed: () => string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (!allowed().some((o) => url.startsWith(o + '/'))) throw new Error(`test tried to reach ${url}`);
    return globalThis.fetch(input, init);
  }) as typeof fetch;
}

async function start(opts?: FakeHubOptions): Promise<FakeHub> {
  hub = await startFakeHub(REPOS, opts);
  return hub;
}
const loopEp = (origin: string, base = origin): HubEndpoint => ({ origin, base, loopbackHttp: true });

function client(h: FakeHub, token: string | null = null, extra: { sleep?: (ms: number) => Promise<void>; connectTimeoutMs?: number; idleTimeoutMs?: number } = {}): HubClient {
  return createHubClient({ endpoint: loopEp(h.endpoint), token, fetch: guardedFetch(() => [h.endpoint, h.cdnOrigin]), ...extra });
}

async function readAll(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return concat(parts);
}

async function hubError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HubClientError);
    return (e as HubClientError).error;
  }
  throw new Error('expected a HubClientError');
}

afterEach(async () => {
  const h = hub;
  hub = null;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(null)));
  }
  if (h) {
    // No request ever left the loopback fakes.
    for (const r of h.requests) expect(r.url.startsWith(h.endpoint + '/') || r.url.startsWith(h.cdnOrigin + '/')).toBe(true);
    for (const u of seen) expect(u.startsWith(h.endpoint + '/') || u.startsWith(h.cdnOrigin + '/')).toBe(true);
    await h.close();
  }
  seen = [];
});

const noSleep = (): ((ms: number) => Promise<void>) & { calls: number[] } => {
  const calls: number[] = [];
  return Object.assign(async (ms: number) => void calls.push(ms), { calls });
};

describe('revision()', () => {
  test('maps the commit and siblings (etag: lfs.sha256 for LFS, else blobId)', async () => {
    const h = await start();
    const rev = await client(h).revision('org/model', 'model', 'main');
    expect(rev).toMatchObject({ repoId: 'org/model', type: 'model', commit: C1, gated: false, private: false,
      lastModified: '2026-10-01T00:00:00.000Z' });
    const by = new Map(rev.siblings.map((s) => [s.path, s]));
    expect(by.get('config.json')).toEqual({ path: 'config.json', size: 7, etag: gitBlobId(enc('{"a":1}')), lfs: false });
    expect(by.get('big.bin')).toEqual({ path: 'big.bin', size: 5000, etag: sha256Hex(bytes(5000)), lfs: true });
    expect(rev.siblings).toHaveLength(6);
    expect(h.requests[0]!.url).toBe(`${h.endpoint}/api/models/org/model/revision/main?blobs=true`);
  });

  test('datasets use /api/datasets/', async () => {
    const h = await start();
    const rev = await client(h).revision('org/data', 'dataset', C2);
    expect(rev).toMatchObject({ type: 'dataset', commit: C2 });
    expect(h.requests[0]!.url).toBe(`${h.endpoint}/api/datasets/org/data/revision/${C2}?blobs=true`);
  });

  test('a gated repo still lists, marked gated', async () => {
    const h = await start();
    expect(await client(h).revision('org/gated', 'model', 'main')).toMatchObject({ gated: true, commit: C2 });
  });

  test('404 → NOT_FOUND, not retried', async () => {
    const h = await start();
    const sleep = noSleep();
    expect((await hubError(client(h, null, { sleep }).revision('org/nope', 'model', 'main'))).code).toBe('NOT_FOUND');
    expect((await hubError(client(h, null, { sleep }).revision('org/model', 'model', 'v9'))).code).toBe('NOT_FOUND');
    expect(sleep.calls).toEqual([]);
    expect(h.requests).toHaveLength(2);
  });

  test('5xx on the API is retried', async () => {
    const h = await start({ failFirst: { 'revision:org/model': 2 } });
    const sleep = noSleep();
    expect((await client(h, null, { sleep }).revision('org/model', 'model', 'main')).commit).toBe(C1);
    expect(sleep.calls).toHaveLength(2);
  });

  test('builds URLs from ep.base, revision encoded per segment', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      return Response.json({ sha: C1, siblings: [] });
    }) as unknown as typeof fetch;
    const ep: HubEndpoint = { origin: 'https://hub.example.com', base: 'https://hub.example.com/mirror', loopbackHttp: false };
    await createHubClient({ endpoint: ep, token: null, fetch: f }).revision('org/m', 'space', 'refs/pr/1');
    await createHubClient({ endpoint: ep, token: null, fetch: f }).revision('org/m', 'model', 'feat/x.y');
    expect(urls).toEqual([
      'https://hub.example.com/mirror/api/spaces/org/m/revision/refs/pr/1?blobs=true',
      'https://hub.example.com/mirror/api/models/org/m/revision/feat/x.y?blobs=true',
    ]);
  });

  test('rejects an invalid repo id or revision before any request', async () => {
    const f = vi.fn();
    const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f as unknown as typeof fetch });
    await expect(c.revision('org/../x', 'model', 'main')).rejects.toThrow();
    await expect(c.revision('org', 'model', 'main')).rejects.toThrow();
    await expect(c.revision('org/m', 'model', '../x')).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  describe('validates the untrusted response with zod → BAD_RESPONSE', () => {
    const sib = { rfilename: 'a.txt', size: 1, blobId: 'c'.repeat(40) };
    test.each([
      ['missing sha', { siblings: [sib] }],
      ['sha not a commit', { sha: 'main', siblings: [] }],
      ['missing siblings', { sha: C1 }],
      ['size as a string', { sha: C1, siblings: [{ ...sib, size: '1' }] }],
      ['negative size', { sha: C1, siblings: [{ ...sib, size: -1 }] }],
      ['rfilename a number', { sha: C1, siblings: [{ ...sib, rfilename: 5 }] }],
      ['empty rfilename', { sha: C1, siblings: [{ ...sib, rfilename: '' }] }],
      ['path over 4096', { sha: C1, siblings: [{ ...sib, rfilename: 'x'.repeat(4097) }] }],
      ['bad blobId', { sha: C1, siblings: [{ ...sib, blobId: '../../x' }] }],
      ['bad lfs.sha256', { sha: C1, siblings: [{ ...sib, lfs: { sha256: 'nope', size: 1 } }] }],
      ['private not boolean', { sha: C1, private: 'yes', siblings: [] }],
      ['duplicate paths', { sha: C1, siblings: [sib, sib] }],
      ['over 100,000 siblings', { sha: C1, siblings: Array.from({ length: 100_001 }, (_, i) => ({ rfilename: `f${i}` })) }],
      ['not an object', [1, 2]],
    ])('%s', async (_name, body) => {
      const f = (async () => Response.json(body)) as unknown as typeof fetch;
      const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f });
      expect((await hubError(c.revision('org/m', 'model', 'main'))).code).toBe('BAD_RESPONSE');
    });

    test('a commit revision answered with another sha', async () => {
      const f = (async () => Response.json({ sha: C2, siblings: [] })) as unknown as typeof fetch;
      const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f });
      expect((await hubError(c.revision('org/m', 'model', C1))).code).toBe('BAD_RESPONSE');
      expect((await c.revision('org/m', 'model', C2.toUpperCase())).commit).toBe(C2);
    });

    test('not JSON', async () => {
      const f = (async () => new Response('<html>')) as unknown as typeof fetch;
      const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f });
      expect((await hubError(c.revision('org/m', 'model', 'main'))).code).toBe('BAD_RESPONSE');
    });

    test('accepts exactly 100,000 siblings and a 4096-char path; unknown keys ignored, missing size/etag → null', async () => {
      const siblings = Array.from({ length: 100_000 }, (_, i) => ({ rfilename: i === 0 ? 'p'.repeat(4096) : `f${i}`, extra: 1 }));
      const f = (async () => Response.json({ sha: C1.toUpperCase(), gated: 'auto', private: true, x: {}, siblings })) as unknown as typeof fetch;
      const rev = await createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f }).revision('org/m', 'model', 'main');
      expect(rev.siblings).toHaveLength(100_000);
      expect(rev).toMatchObject({ commit: C1, gated: true, private: true, lastModified: null });
      expect(rev.siblings[1]).toEqual({ path: 'f1', size: null, etag: null, lfs: false });
    });
  });
});

describe('open()', () => {
  test('follows the redirect to the CDN; Authorization to the Hub only', async () => {
    const h = await start();
    const r = await client(h, 'hf_secret').open('org/model', 'model', C1, 'big.bin', 0, new AbortController().signal);
    expect(r.status).toBe(200);
    expect(r.size).toBe(5000);
    expect(await readAll(r.body)).toEqual(bytes(5000));
    const [toHub, toCdn] = h.requests;
    expect(toHub!.url).toBe(`${h.endpoint}/org/model/resolve/${C1}/big.bin`);
    expect(toHub!.headers.authorization).toBe('Bearer hf_secret');
    expect(toCdn!.url.startsWith(h.cdnOrigin + '/')).toBe(true);
    expect(toCdn!.headers.authorization).toBeUndefined();
    expect(toCdn!.headers.range).toBeUndefined();
  });

  test('fromByte > 0 sends Range and returns 206 with the rest', async () => {
    const h = await start();
    const r = await client(h).open('org/model', 'model', C1, 'big.bin', 1234, new AbortController().signal);
    expect(r.status).toBe(206);
    expect(r.size).toBe(5000);
    expect(await readAll(r.body)).toEqual(bytes(5000).subarray(1234));
    expect(h.requests.every((q) => q.headers.range === 'bytes=1234-')).toBe(true);
  });

  test('a server that ignores Range on a resume → RANGE_IGNORED; from byte 0 a 200 is fine', async () => {
    const h = await start({ ignoreRange: ['big.bin'] });
    const e = await hubError(client(h).open('org/model', 'model', C1, 'big.bin', 10, new AbortController().signal));
    expect(e).toEqual({ code: 'RANGE_IGNORED', message: 'The server cannot resume this file' });
    const r = await client(h).open('org/model', 'model', C1, 'big.bin', 0, new AbortController().signal);
    expect(r.status).toBe(200);
    expect(r.size).toBe(5000);
    expect(await readAll(r.body)).toEqual(bytes(5000));
  });

  test('a caller abort ends the backoff wait at once', async () => {
    const ctl = new AbortController();
    const f = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f, sleep: () => new Promise(() => undefined) });
    const p = c.open('org/m', 'model', C1, 'a', 0, ctl.signal);
    setTimeout(() => ctl.abort(new Error('paused')), 20);
    await expect(p).rejects.toThrow('paused');
  });

  test('429 says rate-limited and is not retried', async () => {
    const sleep = noSleep();
    const f = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f, sleep });
    expect((await hubError(c.open('org/m', 'model', C1, 'a', 0, new AbortController().signal))).message).toMatch(/rate-limit/);
    expect(sleep.calls).toEqual([]);
  });

  test('file paths encoded per segment; datasets resolve under /datasets/', async () => {
    const h = await start();
    const r = await client(h).open('org/model', 'model', C1, 'dir/a b#.txt', 0, new AbortController().signal);
    expect(new TextDecoder().decode(await readAll(r.body))).toBe('spaced');
    expect(h.requests[0]!.url).toBe(`${h.endpoint}/org/model/resolve/${C1}/dir/a%20b%23.txt`);
    const d = await client(h).open('org/data', 'dataset', C2, 'train.csv', 0, new AbortController().signal);
    expect(new TextDecoder().decode(await readAll(d.body))).toBe('a,b\n1,2\n');
    expect(h.requests[2]!.url).toBe(`${h.endpoint}/datasets/org/data/resolve/${C2}/train.csv`);
  });

  test('refuses unsafe paths and a non-commit revision before any request', async () => {
    const f = vi.fn();
    const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f as unknown as typeof fetch });
    const sig = new AbortController().signal;
    expect((await hubError(c.open('org/m', 'model', C1, '../x', 0, sig))).code).toBe('BAD_RESPONSE');
    expect((await hubError(c.open('org/m', 'model', C1, 'a//b', 0, sig))).code).toBe('BAD_RESPONSE');
    expect((await hubError(c.open('org/m', 'model', C1, 'a/./b', 0, sig))).code).toBe('BAD_RESPONSE');
    await expect(c.open('org/m', 'model', 'main', 'a', 0, sig)).rejects.toThrow();
    await expect(c.open('org/m', 'model', C1, 'a', -1, sig)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  test('gated repo with no token → GATED; with a token it streams', async () => {
    const h = await start();
    const sleep = noSleep();
    expect((await hubError(client(h, null, { sleep }).open('org/gated', 'model', C2, 'w.bin', 0, new AbortController().signal))).code).toBe('GATED');
    expect(sleep.calls).toEqual([]);
    const r = await client(h, 'hf_tok').open('org/gated', 'model', C2, 'w.bin', 0, new AbortController().signal);
    expect(await readAll(r.body)).toEqual(bytes(100));
  });

  test('404 → NOT_FOUND, not retried', async () => {
    const h = await start();
    const sleep = noSleep();
    expect((await hubError(client(h, null, { sleep }).open('org/model', 'model', C1, 'nope.bin', 0, new AbortController().signal))).code).toBe('NOT_FOUND');
    expect(sleep.calls).toEqual([]);
    expect(h.requests).toHaveLength(1);
  });

  test('5xx retried with backoff, then succeeds', async () => {
    const h = await start({ failFirst: { 'big.bin': 3 } });
    const sleep = noSleep();
    const r = await client(h, null, { sleep }).open('org/model', 'model', C1, 'big.bin', 0, new AbortController().signal);
    expect(await readAll(r.body)).toEqual(bytes(5000));
    expect(sleep.calls).toHaveLength(3);
    expect(sleep.calls[0]!).toBeGreaterThan(0);
    expect(sleep.calls[1]!).toBeGreaterThan(sleep.calls[0]!);
    expect(sleep.calls[2]!).toBeGreaterThan(sleep.calls[1]!);
  });

  test('5xx on every try → SERVER after 3 retries', async () => {
    const h = await start({ failFirst: { 'big.bin': 10 } });
    const sleep = noSleep();
    expect((await hubError(client(h, null, { sleep }).open('org/model', 'model', C1, 'big.bin', 0, new AbortController().signal))).code).toBe('SERVER');
    expect(sleep.calls).toHaveLength(3);
    expect(h.requests).toHaveLength(4);
  });

  test('network errors are retried, then NETWORK', async () => {
    const sleep = noSleep();
    let n = 0;
    const f = (async () => { n++; throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f, sleep });
    expect((await hubError(c.open('org/m', 'model', C1, 'a', 0, new AbortController().signal))).code).toBe('NETWORK');
    expect(n).toBe(4);
    expect(sleep.calls).toHaveLength(3);
  });

  test('401/403 not retried', async () => {
    for (const status of [401, 403]) {
      const sleep = noSleep();
      let n = 0;
      const f = (async () => { n++; return new Response('', { status }); }) as unknown as typeof fetch;
      const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: 't', fetch: f, sleep });
      expect((await hubError(c.open('org/m', 'model', C1, 'a', 0, new AbortController().signal))).code).toBe('UNAUTHORIZED');
      expect(n).toBe(1);
      expect(sleep.calls).toEqual([]);
    }
  });

  test('a 206 whose Content-Range does not start at fromByte is an error', async () => {
    for (const cr of ['bytes 0-9/10', 'bytes 6-9/10', null, 'garbage']) {
      const f = (async () => new Response('x', { status: 206, headers: cr ? { 'Content-Range': cr } : {} })) as unknown as typeof fetch;
      const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: f, sleep: noSleep() });
      expect((await hubError(c.open('org/m', 'model', C1, 'a', 5, new AbortController().signal))).code).toBe('BAD_RESPONSE');
    }
  });

  test('redirects: at most 5 hops, no downgrade to a non-loopback host', async () => {
    let n = 0;
    const loop = (async (u: string) => { n++; return new Response(null, { status: 302, headers: { Location: u } }); }) as unknown as typeof fetch;
    const c = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: null, fetch: loop, sleep: noSleep() });
    expect((await hubError(c.open('org/m', 'model', C1, 'a', 0, new AbortController().signal))).code).toBe('BAD_RESPONSE');
    expect(n).toBe(6);
    const away = (async () => new Response(null, { status: 302, headers: { Location: 'http://evil.example.com/x' } })) as unknown as typeof fetch;
    const c2 = createHubClient({ endpoint: loopEp('http://127.0.0.1:9'), token: 't', fetch: away, sleep: noSleep() });
    expect((await hubError(c2.open('org/m', 'model', C1, 'a', 0, new AbortController().signal))).message).toMatch(/refused/i);
  });

  test('the caller can abort mid-stream; nothing is retried', async () => {
    const h = await start({ slowBytesPerSec: 2000 });
    const ctl = new AbortController();
    const sleep = noSleep();
    const r = await client(h, null, { sleep }).open('org/model', 'model', C1, 'big.bin', 0, ctl.signal);
    const it = r.body[Symbol.asyncIterator]();
    await it.next();
    ctl.abort();
    await expect(it.next()).rejects.toThrow();
    expect(sleep.calls).toEqual([]);
  });
});

describe('timeouts', () => {
  async function server(handler: http.RequestListener): Promise<string> {
    const s = http.createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  const only = (origin: string): typeof fetch => guardedFetch(() => [origin]);

  test('connect timeout: a server that never answers → NETWORK after the retries', async () => {
    let hits = 0;
    const origin = await server(() => { hits++; });
    const sleep = noSleep();
    const c = createHubClient({ endpoint: loopEp(origin), token: null, fetch: only(origin), sleep, connectTimeoutMs: 50, idleTimeoutMs: 50 });
    const e = await hubError(c.revision('org/m', 'model', 'main'));
    expect(e.code).toBe('NETWORK');
    expect(e.message).toMatch(/timed? ?out/i);
    expect(hits).toBe(4);
    expect(sleep.calls).toHaveLength(3);
    for (const u of seen) expect(u.startsWith(origin + '/')).toBe(true);
  });

  test('idle timeout: headers then silence → the body fails with NETWORK', async () => {
    const origin = await server((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('abc');
    });
    const c = createHubClient({ endpoint: loopEp(origin), token: null, fetch: only(origin), sleep: noSleep(), connectTimeoutMs: 1000, idleTimeoutMs: 80 });
    const r = await c.open('org/m', 'model', C1, 'a', 0, new AbortController().signal);
    const e = await hubError(readAll(r.body));
    expect(e.code).toBe('NETWORK');
    expect(e.message).toMatch(/no data/i);
  });

  test('a slow consumer is not an idle server', async () => {
    const h = await start();
    const c = createHubClient({ endpoint: loopEp(h.endpoint), token: null, fetch: guardedFetch(() => [h.endpoint, h.cdnOrigin]), idleTimeoutMs: 30 });
    const r = await c.open('org/model', 'model', C1, 'config.json', 0, new AbortController().signal);
    await new Promise((res) => setTimeout(res, 100));
    expect(await readAll(r.body)).toEqual(enc('{"a":1}'));
  });
});

describe('readAt()', () => {
  test('reads a small GGUF header through range requests', async () => {
    const h = await start();
    const header = await readGgufHeader(client(h).readAt('org/model', 'model', C1, 'm.gguf'));
    expect(header.kv.get('general.architecture')).toBe('llama');
    const cdn = h.requests.filter((q) => q.url.startsWith(h.cdnOrigin));
    expect(cdn[0]!.headers.range).toBe(`bytes=0-${MIB - 1}`);
  });

  test('1 MiB chunks: a 2.5 MiB read is three range requests', async () => {
    const h = await start();
    const got = await client(h).readAt('org/model', 'model', C1, 'wide.bin')(0, Math.floor(2.5 * MIB));
    expect(sha256Hex(got)).toBe(sha256Hex(bytes(Math.floor(2.5 * MIB))));   // toEqual on 2.5 MiB is slow
    const ranges = h.requests.filter((q) => q.url.startsWith(h.cdnOrigin)).map((q) => q.headers.range);
    expect(ranges).toEqual([`bytes=0-${MIB - 1}`, `bytes=${MIB}-${2 * MIB - 1}`, `bytes=${2 * MIB}-${Math.floor(2.5 * MIB) - 1}`]);
  });

  test('short read at the end of the file; past the end is empty', async () => {
    const h = await start();
    const ra = client(h).readAt('org/model', 'model', C1, 'config.json');
    expect(await ra(3, 100)).toEqual(enc('{"a":1}').subarray(3));
    expect(await ra(7, 10)).toEqual(new Uint8Array(0));
  });

  test('a server that ignores Range: a prefix read works, any later offset is RANGE_IGNORED', async () => {
    const h = await start({ ignoreRange: ['big.bin'] });
    const ra = client(h).readAt('org/model', 'model', C1, 'big.bin');
    expect(await ra(0, 50)).toEqual(bytes(5000).subarray(0, 50));
    const e = await hubError(ra(100, 50));
    expect(e).toEqual({ code: 'RANGE_IGNORED', message: 'The server ignored the byte range' });
  });

  test('each readAt handle receives at most 32 MiB (+ one chunk) in all, even from a server that ignores Range', async () => {
    const file = new Uint8Array(40 * MIB);
    hub = await startFakeHub([{ repoId: 'org/big', commit: C1, files: { 'x.gguf': file } }], { ignoreRange: ['x.gguf'] });
    const h = hub;
    let received = 0;
    const inner = guardedFetch(() => [h.endpoint, h.cdnOrigin]);
    const counting = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await inner(input, init);
      if (!res.body) return res;
      const count = new TransformStream<Uint8Array, Uint8Array>({ transform(c, ctl) { received += c.length; ctl.enqueue(c); } });
      return new Response(res.body.pipeThrough(count), { status: res.status, headers: res.headers });
    }) as typeof fetch;
    const ra = createHubClient({ endpoint: loopEp(h.endpoint), token: null, fetch: counting }).readAt('org/big', 'model', C1, 'x.gguf');
    let reads = 0;
    let err: { code: string; message: string } | null = null;
    for (; reads < 100 && !err; reads++) {
      try {
        await ra(0, MIB);   // pos 0 is the one 200 the client accepts; repeat it to drain the budget
      } catch (e) {
        expect(e).toBeInstanceOf(HubClientError);
        err = (e as HubClientError).error;
      }
    }
    expect(err).toEqual({ code: 'BAD_RESPONSE', message: 'GGUF header reads passed their 32 MiB transfer budget' });
    expect(reads).toBeLessThanOrEqual(34);
    expect(received).toBeLessThanOrEqual(32 * MIB + MIB);
  });

  test('refuses beyond 32 MiB', async () => {
    const h = await start();
    const ra = client(h).readAt('org/model', 'model', C1, 'huge.gguf');
    expect(await hubError(ra(32 * MIB, 1))).toEqual({ code: 'BAD_RESPONSE', message: 'GGUF header reads stop at 32 MiB' });
    expect(h.requests).toHaveLength(0);
    await expect(readGgufHeader(ra)).rejects.toThrow();
    const cdn = h.requests.filter((q) => q.url.startsWith(h.cdnOrigin)).map((q) => q.headers.range!);
    for (const r of cdn) expect(Number(/-(\d+)$/.exec(r)![1])).toBeLessThan(32 * MIB);
  });

  test('a gated file without a token → GATED', async () => {
    const h = await start();
    expect((await hubError(client(h).readAt('org/gated', 'model', C2, 'w.bin')(0, 10))).code).toBe('GATED');
  });
});

describe('under E2E hubFetch never leaves the loopback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const stubFetch = () => {
    const f = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', f);
    return f;
  };

  test('a non-loopback URL is NETWORK_BLOCKED and counted, and never fetched; loopback URLs go through', async () => {
    vi.stubEnv('HFCM_E2E', '1');
    const f = stubFetch();
    const before = networkBlockedCount();
    for (const url of ['https://huggingface.co/api/models/o/m', 'http://example.com/x', 'http://127.0.0.1.evil.com/x', 'https://cdn-lfs.hf.co/x']) {
      await expect(hubFetch(url)).rejects.toMatchObject({ name: 'HubClientError', code: 'NETWORK_BLOCKED' });
    }
    await expect(hubFetch(new URL('https://huggingface.co/x'))).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
    await expect(hubFetch(new Request('https://huggingface.co/x'))).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
    await expect(hubFetch('not a url')).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
    expect(networkBlockedCount()).toBe(before + 7);
    expect(f).not.toHaveBeenCalled();
    for (const url of ['http://127.0.0.1:9/api', 'http://localhost:9/x', 'http://[::1]:9/x']) await hubFetch(url);
    expect(f).toHaveBeenCalledTimes(3);
    expect(networkBlockedCount()).toBe(before + 7);
  });

  test('outside E2E hubFetch is the plain global fetch', async () => {
    vi.stubEnv('HFCM_E2E', '');
    vi.stubEnv('HFCM_E2E_ROOT', '');
    const f = stubFetch();
    const before = networkBlockedCount();
    await hubFetch('https://huggingface.co/api/models/o/m');
    expect(f).toHaveBeenCalledTimes(1);
    expect(networkBlockedCount()).toBe(before);
  });

  test('the client does not retry a blocked request: it fails at once with NETWORK_BLOCKED', async () => {
    vi.stubEnv('HFCM_E2E', '1');
    stubFetch();
    const sleep = vi.fn(async () => undefined);
    const c = createHubClient({ endpoint: { origin: 'https://huggingface.co', base: 'https://huggingface.co', loopbackHttp: false }, token: null, fetch: hubFetch, sleep });
    await expect(c.revision('o/m', 'model', 'main')).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
    expect(sleep).not.toHaveBeenCalled();
  });
});
