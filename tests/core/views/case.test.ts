import { lstatSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { entry, applyViewOps, doomRepo, fakeFetch, ggufBytes, hangingFetch, loadCase, sha256Hex, type CaseSpec } from './_case';
import { useCanaries } from '../../helpers/canary';

useCanaries();
beforeEach(() => expect.hasAssertions());

const base: CaseSpec = { repos: [{ id: 'acme/T', main: 'c1', snapshots: [
  { commit: 'c1', mtime: 1700000100, files: [{ path: 'a/b/x.gguf', text: 'xx' }, { path: 'y.gguf', text: 'xx' }, { path: 'p.txt', text: 'p', plain: true }] }] }],
  views: ['lmstudio'], aliases: { 'my model': 'acme/T:y.gguf' } };

describe('buildCase', () => {
  it('builds relative links, shared blobs, refs/main, mtimes and config roots', async () => {
    const { c, model, config } = await loadCase(base);
    const folder = path.join(c.hub, 'models--acme--T');
    const etag = sha256Hex('xx');
    expect(readlinkSync(path.join(folder, 'snapshots/c1/a/b/x.gguf'))).toBe(`../../../../blobs/${etag}`);
    expect(readlinkSync(path.join(folder, 'snapshots/c1/y.gguf'))).toBe(`../../blobs/${etag}`);
    expect(Object.keys(model.repos[0]!.blobs)).toEqual([etag]);
    expect(readFileSync(path.join(folder, 'refs/main'), 'utf8')).toBe('c1');
    expect(lstatSync(path.join(folder, 'snapshots/c1')).mtimeMs).toBe(1700000100_000);
    expect(lstatSync(path.join(folder, 'snapshots/c1/p.txt')).isSymbolicLink()).toBe(false);
    expect(config.views.lmstudio.root).toBe(c.lmstudio);
    expect(config.views.ollama.root).toBe(c.ollama);
    expect(config.views.ollama.aliases).toEqual({ 'my model': 'acme/T:y.gguf' });
    expect(existsSync(c.lmstudio!)).toBe(true);
    expect(existsSync(c.ollama!)).toBe(false);
  });

  it('store:true writes marker, payload, .refs and a relative store link', async () => {
    const { c, model } = await loadCase({ ...base, repos: [{ id: 'acme/T', main: 'c1', snapshots: [
      { commit: 'c1', mtime: 1, files: [{ path: 'x.gguf', text: 'st', store: true }] }] }] });
    const etag = sha256Hex('st');
    const h = sha256Hex(`xet:${etag}`);
    expect(readFileSync(path.join(c.hub, 'blobs/.huggingface-shared-blobs'), 'utf8')).toBe('1\n');
    expect(readlinkSync(path.join(c.hub, 'models--acme--T/blobs', etag))).toBe(`../../blobs/${h.slice(0, 2)}/${h}`);
    expect(readFileSync(path.join(c.hub, 'blobs', h.slice(0, 2), `${h}.refs`), 'utf8')).toBe(`models--acme--T/blobs/${etag}\n`);
    expect(model.storeMarked).toBe(true);
  });

  it('viewFiles: files and links, with @HUB@ replaced; noConfig writes no config', async () => {
    const { c } = await loadCase({ ...base, noConfig: true, views: ['lmstudio', 'ollama'],
      viewFiles: { lmstudio: { 'a/f.txt': 'hi', 'a/l': { link: '@HUB@/x' } }, ollama: { 'o.json': '{}' } } });
    expect(readFileSync(path.join(c.lmstudio!, 'a/f.txt'), 'utf8')).toBe('hi');
    expect(readlinkSync(path.join(c.lmstudio!, 'a/l'))).toBe(`${c.hub}/x`);
    expect(readFileSync(path.join(c.ollama!, 'o.json'), 'utf8')).toBe('{}');
    expect(existsSync(c.configPath)).toBe(false);
  });
});

describe('ggufBytes', () => {
  it('is a GGUF v3 header with the given arch and file type', () => {
    const b = ggufBytes({ arch: 'llama', fileType: 15, tensors: [[2, 3]], pad: 5 });
    expect(Buffer.from(b.subarray(0, 4)).toString()).toBe('GGUF');
    expect(Buffer.from(b).readUInt32LE(4)).toBe(3);
    expect(Buffer.from(b).readBigUInt64LE(8)).toBe(1n);
    expect(Buffer.from(b).includes('llama')).toBe(true);
    expect(ggufBytes({ arch: 'llama', fileType: 15, tensors: [[2, 3]], pad: 5 })).toEqual(b);
    expect(ggufBytes({ arch: 'llama', fileType: 15, tensors: [[2, 3]], tokens: 3 }).length).toBeGreaterThan(b.length - 5);
  });
});

describe('helpers', () => {
  it('entry fills defaults and derives key, basename and mmproj', () => {
    expect(entry({ relpath: 'd/mmproj-F16.gguf' })).toMatchObject({ key: 'acme/Tiny-GGUF:d/mmproj-F16.gguf', basename: 'mmproj-F16.gguf', isMmproj: true });
    expect(entry({ repoId: 'o/r' }).folderName).toBe('models--o--r');
  });

  it('doomRepo lists blob paths and throws for an unknown repo', async () => {
    const { model } = await loadCase(base);
    expect(doomRepo(model, 'acme/T')).toEqual([path.join(model.hubRoot, 'models--acme--T/blobs', sha256Hex('xx'))]);
    expect(() => doomRepo(model, 'no/pe')).toThrow(/no repo/);
  });

  it('applyViewOps runs unlink, rmdir-empty and write-file through SafeFs', async () => {
    const { c, safeFs, fs } = await loadCase({ ...base, viewFiles: { lmstudio: { 'd/l': { link: '@HUB@/x' }, 's.json': 'old' } } });
    const l = path.join(c.lmstudio!, 'd/l');
    const { factsOf } = await import('../../../src/core/fsx');
    await applyViewOps([
      { kind: 'unlink', path: l, expect: (await factsOf(fs, l))!, role: 'view-link' },
      { kind: 'rmdir-empty', path: path.join(c.lmstudio!, 'd') },
      { kind: 'write-file', path: path.join(c.lmstudio!, 's.json'), before: 'old', after: 'new', role: 'view-state' },
    ], safeFs);
    expect(existsSync(path.join(c.lmstudio!, 'd'))).toBe(false);
    expect(readFileSync(path.join(c.lmstudio!, 's.json'), 'utf8')).toBe('new');
    await expect(applyViewOps([{ kind: 'store-refs-add', refsPath: '/x', addRefs: [], expectRefsRaw: null }], safeFs)).rejects.toThrow(/unsupported/);
  });

  it('fakeFetch records calls and answers or rejects', async () => {
    const f = fakeFetch({ status: 200, body: 'hey' });
    const init = { method: 'GET' as const, headers: { A: 'b' }, signal: new AbortController().signal };
    const r = await f('u', init);
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('hey');
    expect(f.calls).toEqual([{ url: 'u', init }]);
    expect(Buffer.from(await (await fakeFetch({ status: 404 })('u', init)).arrayBuffer()).length).toBe(0);
    await expect(fakeFetch(new TypeError('fetch failed'))('u', init)).rejects.toThrow('fetch failed');
  });

  it('hangingFetch rejects when its signal aborts, including an already aborted one', async () => {
    const f = hangingFetch();
    const ac = new AbortController();
    const p = f('u', { method: 'GET', headers: {}, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(f('u', { method: 'GET', headers: {}, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toHaveLength(2);
  });
});
