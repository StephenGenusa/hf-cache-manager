import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pyDumpsCompact } from '../../../src/core/compat/pyjson';
import {
  MT, manifestUrl, readToken, registryBlob, registryCachePaths, registryCollisions, registryConfig, registryManifest,
  type RegistryCtx,
} from '../../../src/core/views/registry';
import { SkipEntry } from '../../../src/core/views/view-types';
import { viewFs } from '../../../src/core/views/walk';
import { useCanaries } from '../../helpers/canary';
import { tempDir } from '../_temp';
import { entry, fakeFetch, hangingFetch, loadCase, sha256Hex, type CaseSpec, type LoadedCase } from './_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const R = 'acme/Tiny-GGUF';
const spec: CaseSpec = { repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [{ path: 'a.gguf', text: 'q' }] }] }], views: ['ollama'] };
const MAN = path.join('.hfhub-registry', R, 'Tiny-Q4_K_M.gguf.json');
let lc: LoadedCase;
let root: string;
let ctx: RegistryCtx;
beforeEach(async () => {
  lc = await loadCase(spec);
  root = realpathSync(lc.c.ollama!);
  ctx = { root, fs: lc.fs, safeFs: lc.safeFs, fetch: fakeFetch({ status: 500 }), offline: false, token: null };
});
const cacheDir = (): string => path.join(root, '.hfhub-registry');
const seed = (rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

describe('paths and url', () => {
  it('manifestUrl percent-encodes the relpath with safe=""', () => {
    expect(manifestUrl('acme/Tiny-GGUF', 'sub dir/Tiny-Q4_K_M.gguf')).toBe('https://huggingface.co/v2/acme/Tiny-GGUF/manifests/sub%20dir%2FTiny-Q4_K_M.gguf');
    expect(manifestUrl(R, "a(b)'*!~.gguf")).toBe(`https://huggingface.co/v2/${R}/manifests/a%28b%29%27%2A%21~.gguf`);
  });
  it('cache layout uses the basename (REF 5.5, 8.9)', () => {
    expect(registryCachePaths(R, 'sub/Tiny-Q4_K_M.gguf')).toEqual({
      manifest: '.hfhub-registry/acme/Tiny-GGUF/Tiny-Q4_K_M.gguf.json', config: '.hfhub-registry/acme/Tiny-GGUF/Tiny-Q4_K_M.gguf.config.json' });
  });
});

describe('readToken', () => {
  it('HF_TOKEN, else the stripped token file, else null', async () => {
    const tmp = await tempDir();
    expect(await readToken({ HF_TOKEN: 'hf_x' }, tmp)).toBe('hf_x');
    mkdirSync(path.join(tmp, 'hfh'));
    writeFileSync(path.join(tmp, 'hfh', 'token'), ' hf_y\n');
    expect(await readToken({ HF_HOME: path.join(tmp, 'hfh') }, tmp)).toBe('hf_y');
    expect(await readToken({ HF_TOKEN: '', HF_HOME: path.join(tmp, 'hfh') }, tmp)).toBe('hf_y');
    expect(await readToken({ HF_HOME: path.join(tmp, 'none') }, tmp)).toBeNull();
  });
  it('strips Python str.strip() whitespace only (not U+FEFF)', async () => {
    const tmp = await tempDir();
    mkdirSync(path.join(tmp, 'hfh'));
    writeFileSync(path.join(tmp, 'hfh', 'token'), '\u00a0\u3000\x1f hf_z \u2028\x85\n');
    expect(await readToken({ HF_HOME: path.join(tmp, 'hfh') }, tmp)).toBe('hf_z');
    writeFileSync(path.join(tmp, 'hfh', 'token'), '\ufeffhf_z\ufeff');
    expect(await readToken({ HF_HOME: path.join(tmp, 'hfh') }, tmp)).toBe('\ufeffhf_z\ufeff');
  });
  it('a directory or a file under a file is not a token; an unreadable path rethrows', async () => {
    const tmp = await tempDir();
    mkdirSync(path.join(tmp, 'hfh', 'token'), { recursive: true });
    expect(await readToken({ HF_HOME: path.join(tmp, 'hfh') }, tmp)).toBeNull();
    writeFileSync(path.join(tmp, 'f'), 'x');
    expect(await readToken({ HF_HOME: path.join(tmp, 'f') }, tmp)).toBeNull();
    symlinkSync('loop', path.join(tmp, 'loop'));
    await expect(readToken({ HF_HOME: path.join(tmp, 'loop') }, tmp)).rejects.toThrow();
  });
});

describe('registryManifest', () => {
  it('fetch: Accept + Bearer header; 200 cached with default separators', async () => {
    const f = fakeFetch({ status: 200, body: '{"schemaVersion":2,"layers":[]}' });
    const m = await registryManifest({ ...ctx, fetch: f, token: 'hf_x' }, R, 'sub/Tiny-Q4_K_M.gguf');
    expect(f.calls[0]!.init.headers).toEqual({ Accept: MT.manifest, Authorization: 'Bearer hf_x' });
    expect(f.calls[0]!.url).toBe(`https://huggingface.co/v2/${R}/manifests/sub%2FTiny-Q4_K_M.gguf`);
    expect(pyDumpsCompact(m!)).toBe('{"schemaVersion":2,"layers":[]}');
    expect(readFileSync(path.join(root, MAN), 'utf8')).toBe('{"schemaVersion": 2, "layers": []}');
  });
  it('no token means no Authorization header', async () => {
    const f = fakeFetch({ status: 200, body: '{}' });
    await registryManifest({ ...ctx, fetch: f }, R, 'Tiny-Q4_K_M.gguf');
    expect(f.calls[0]!.init.headers).toEqual({ Accept: MT.manifest });
  });
  it.each([404, 401, 400])('%i -> null and cached {"missing": true}', async (status) => {
    expect(await registryManifest({ ...ctx, fetch: fakeFetch({ status }) }, R, 'Tiny-Q4_K_M.gguf')).toBeNull();
    expect(readFileSync(path.join(root, MAN), 'utf8')).toBe('{"missing": true}');
  });
  it('cache hit is used without network; {"missing":true} -> null', async () => {
    const f = fakeFetch({ status: 500 });
    seed(MAN, '{"schemaVersion": 2}');
    expect(pyDumpsCompact((await registryManifest({ ...ctx, fetch: f }, R, 'x/Tiny-Q4_K_M.gguf'))!)).toBe('{"schemaVersion":2}');
    seed(MAN, '{"missing": true}');
    expect(await registryManifest({ ...ctx, fetch: f, offline: true }, R, 'Tiny-Q4_K_M.gguf')).toBeNull();
    for (const falsy of ['false', 'null', '0', '0.0', '-0.0', '""', '[]', '{}']) {
      seed(MAN, `{"missing": ${falsy}}`);
      expect(await registryManifest({ ...ctx, fetch: f }, R, 'Tiny-Q4_K_M.gguf'), falsy).not.toBeNull();
    }
    for (const truthy of ['true', '1', '0.5', '"x"', '[0]', '{"a": 1}', 'NaN']) {
      seed(MAN, `{"missing": ${truthy}}`);
      expect(await registryManifest({ ...ctx, fetch: f }, R, 'Tiny-Q4_K_M.gguf'), truthy).toBeNull();
    }
    seed(MAN, '{}');
    expect(await registryManifest({ ...ctx, fetch: f }, R, 'Tiny-Q4_K_M.gguf')).not.toBeNull();
    expect(f.calls).toHaveLength(0);
  });
  it('test_offline_without_cached_response_skips', async () => {
    await expect(registryManifest({ ...ctx, offline: true }, R, 'a.gguf')).rejects.toThrow(SkipEntry);
    expect(existsSync(cacheDir())).toBe(false);
  });
  it('test_registry_outage_skips_and_writes_nothing (500, network error, timeout)', async () => {
    for (const f of [fakeFetch({ status: 500 }), fakeFetch(new TypeError('fetch failed')), fakeFetch(new SkipEntry('x')), hangingFetch()]) {
      await expect(registryManifest({ ...ctx, fetch: f, timeoutMs: 20 }, R, 'a.gguf')).rejects.toThrow(SkipEntry);
    }
    await expect(registryManifest({ ...ctx, fetch: { call: () => Promise.reject('str') }.call, timeoutMs: 20 }, R, 'a.gguf')).rejects.toThrow(/str/);
    expect(existsSync(cacheDir())).toBe(false);
  });
  it('an unparseable or non-object response is a SkipEntry and nothing is cached', async () => {
    await expect(registryManifest({ ...ctx, fetch: fakeFetch({ status: 200, body: 'nope' }) }, R, 'a.gguf')).rejects.toThrow(SkipEntry);
    await expect(registryManifest({ ...ctx, fetch: fakeFetch({ status: 200, body: '[1]' }) }, R, 'a.gguf')).rejects.toThrow(/not an object/);
    expect(existsSync(cacheDir())).toBe(false);
  });
  it('unparseable cached manifest -> SkipEntry, cache untouched', async () => {
    const f = fakeFetch({ status: 200, body: '{}' });
    seed(MAN, '{oops');
    await expect(registryManifest({ ...ctx, fetch: f }, R, 'Tiny-Q4_K_M.gguf')).rejects.toThrow(SkipEntry);
    expect(readFileSync(path.join(root, MAN), 'utf8')).toBe('{oops');
    seed(MAN, '[1]');
    await expect(registryManifest({ ...ctx, fetch: f }, R, 'Tiny-Q4_K_M.gguf')).rejects.toThrow(/not an object/);
    expect(f.calls).toHaveLength(0);
  });
  it('a cache write refusal (symlinked cache folder) becomes a SkipEntry', async () => {
    mkdirSync(path.join(root, 'elsewhere'));
    symlinkSync(path.join(root, 'elsewhere'), cacheDir());
    await expect(registryManifest({ ...ctx, fetch: fakeFetch({ status: 404 }) }, R, 'a.gguf')).rejects.toThrow(/skipped/);
    expect(existsSync(path.join(root, 'elsewhere', R))).toBe(false);
  });
  it('a directory at the cache file path is not a cache hit and the write is refused', async () => {
    mkdirSync(path.join(root, MAN), { recursive: true });
    await expect(registryManifest({ ...ctx, fetch: fakeFetch({ status: 404 }) }, R, 'Tiny-Q4_K_M.gguf')).rejects.toThrow(SkipEntry);
  });
  it('a non-ENOENT read error propagates', async () => {
    symlinkSync('loop', path.join(root, '.hfhub-registry'));
    await expect(registryManifest({ ...ctx, fetch: fakeFetch({ status: 404 }), fs: lc.fs }, R, 'a.gguf')).rejects.toThrow();
  });
});

describe('registryConfig and registryBlob', () => {
  const D1 = `sha256:${'a'.repeat(64)}`;
  const CFG = path.join('.hfhub-registry', R, 'Tiny-Q4_K_M.gguf.config.json');
  it('registryConfig caches raw bytes; empty body -> "{}"; cache hit needs no network', async () => {
    const f = fakeFetch({ status: 200, body: '{ "a" :1}' });
    const raw = await registryConfig({ ...ctx, fetch: f }, R, 'Tiny-Q4_K_M.gguf', D1);
    expect(Buffer.from(raw).toString()).toBe('{ "a" :1}');
    expect(f.calls[0]!.url).toBe(`https://huggingface.co/v2/${R}/blobs/${D1}`);
    expect(f.calls[0]!.init.headers).toEqual({});
    expect(readFileSync(path.join(root, CFG), 'utf8')).toBe('{ "a" :1}');
    expect(Buffer.from(await registryConfig({ ...ctx, fetch: fakeFetch({ status: 500 }) }, R, 'Tiny-Q4_K_M.gguf', D1)).toString()).toBe('{ "a" :1}');
    seed(CFG.replace('Tiny-Q4', 'E-Q4'), 'zz');
    const empty = await registryConfig({ ...ctx, fetch: fakeFetch({ status: 200, body: '' }) }, R, 'N.gguf', D1);
    expect(Buffer.from(empty).toString()).toBe('{}');
    expect(readFileSync(path.join(root, '.hfhub-registry', R, 'N.gguf.config.json'), 'utf8')).toBe('{}');
  });
  it('registryConfig: offline uncached, not found and outage skip without writing', async () => {
    await expect(registryConfig({ ...ctx, offline: true }, R, 'a.gguf', D1)).rejects.toThrow(SkipEntry);
    await expect(registryConfig({ ...ctx, fetch: fakeFetch({ status: 404 }) }, R, 'a.gguf', D1)).rejects.toThrow(/not found/);
    await expect(registryConfig({ ...ctx, fetch: fakeFetch({ status: 503 }) }, R, 'a.gguf', D1)).rejects.toThrow(SkipEntry);
    expect(existsSync(cacheDir())).toBe(false);
  });
  it('registryConfig refuses a malformed digest before any request', async () => {
    const f = fakeFetch({ status: 200, body: '{}' });
    for (const bad of ['sha256:abc', `sha256:${'A'.repeat(64)}`, `../${'a'.repeat(64)}`, `sha256:${'a'.repeat(64)}/../x`]) {
      await expect(registryConfig({ ...ctx, fetch: f }, R, 'a.gguf', bad)).rejects.toThrow(/digest/);
    }
    expect(f.calls).toHaveLength(0);
  });
  it('registryConfig and registryBlob use the 60 s blob timeout, the manifest 30 s', async () => {
    const real = AbortSignal.timeout;
    const timeouts: number[] = [];
    AbortSignal.timeout = (ms: number): AbortSignal => { timeouts.push(ms); return real.call(AbortSignal, ms); };
    try {
      const f = fakeFetch({ status: 200, body: '{}' });
      await registryManifest({ ...ctx, fetch: f }, R, 'm.gguf');
      await registryConfig({ ...ctx, fetch: f }, R, 'm.gguf', D1);
      await registryBlob({ ...ctx, fetch: fakeFetch({ status: 404 }) }, R, D1).catch(() => undefined);
    } finally {
      AbortSignal.timeout = real;
    }
    expect(timeouts).toEqual([30_000, 60_000, 60_000]);
  });
  it('viewFs.writeFileAtomic guard refuses a path whose resolved parent is the hub', async () => {
    symlinkSync(lc.model.hubRoot, path.join(root, 'lnk'));
    await expect(viewFs(lc.safeFs, root, lc.fs).writeFileAtomic(path.join(root, 'lnk', 'x.json'), 'x')).rejects.toThrow(SkipEntry);
    expect(existsSync(path.join(lc.model.hubRoot, 'x.json'))).toBe(false);
  });
  it('registryBlob verifies sha256 and refuses a mismatch', async () => {
    const body = 'tmpl';
    const good = `sha256:${sha256Hex(body)}`;
    const f = fakeFetch({ status: 200, body });
    expect(Buffer.from(await registryBlob({ ...ctx, fetch: f, token: 't' }, R, good)).toString()).toBe('tmpl');
    expect(f.calls[0]!.init.headers).toEqual({ Authorization: 'Bearer t' });
    await expect(registryBlob({ ...ctx, fetch: fakeFetch({ status: 200, body: 'evil' }) }, R, good)).rejects.toThrow(SkipEntry);
    expect(existsSync(cacheDir())).toBe(false);
  });
  it('registryBlob: offline, not found and timeout skip', async () => {
    await expect(registryBlob({ ...ctx, offline: true }, R, 'sha256:a')).rejects.toThrow(SkipEntry);
    await expect(registryBlob({ ...ctx, fetch: fakeFetch({ status: 404 }) }, R, 'sha256:a')).rejects.toThrow(/not found/);
    await expect(registryBlob({ ...ctx, fetch: hangingFetch(), timeoutMs: 20 }, R, 'sha256:a')).rejects.toThrow(SkipEntry);
  });
});

describe('registryCollisions', () => {
  it('same basename (case-insensitive) in different subfolders of one repo -> all skipped (spec 11)', () => {
    const es = [entry({ relpath: 'a/M-Q4_K_M.gguf' }), entry({ relpath: 'b/m-q4_k_m.gguf' }), entry({ relpath: 'M-Q8_0.gguf' }),
      entry({ relpath: 'mmproj-F16.gguf', isMmproj: true }), entry({ repoId: 'other/R', relpath: 'M-Q4_K_M.gguf' }),
      entry({ relpath: 'c/M-Q4_K_M.gguf', isShard: true })];
    const out = registryCollisions(es);
    expect([...out.keys()]).toEqual([`${R}:a/M-Q4_K_M.gguf`, `${R}:b/m-q4_k_m.gguf`]);
    expect(out.get(`${R}:a/M-Q4_K_M.gguf`)).toContain('b/m-q4_k_m.gguf');
  });
});
