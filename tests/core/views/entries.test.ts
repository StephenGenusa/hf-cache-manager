import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { scanHub } from '../../../src/core/scan/scanner';
import { ggufEntries, mmprojFor } from '../../../src/core/views/entries';
import type { CaseFile, CaseSpec } from '../../golden/build-fixture.mjs';
import { useCanaries } from '../../helpers/canary';
import { entry, loadCase, sha256Hex } from './_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const repo = (files: CaseFile[], extra: CaseFile[] = [], main = 'c2'): CaseSpec => ({
  repos: [{ id: 'acme/Tiny-GGUF', main, snapshots: [
    { commit: 'c2', mtime: 1700000200, files }, { commit: 'c1', mtime: 1700000100, files: extra }] }],
  views: [],
});

describe('ggufEntries', () => {
  it('lists symlinked .gguf from the current snapshot first; older-only files are not current', async () => {
    const { model } = await loadCase(repo(
      [{ path: 'Tiny-Q4_K_M.gguf', text: 'q4-new' }, { path: 'README.md', text: 'r' }],
      [{ path: 'Tiny-Q4_K_M.gguf', text: 'q4-old' }, { path: 'Tiny-Q2_K.gguf', text: 'q2' }]));
    const es = ggufEntries(model);
    expect(es.map((e) => [e.key, e.isCurrent, e.sha256])).toEqual([
      ['acme/Tiny-GGUF:Tiny-Q2_K.gguf', false, sha256Hex('q2')],
      ['acme/Tiny-GGUF:Tiny-Q4_K_M.gguf', true, sha256Hex('q4-new')],
    ]);
    expect(es[1]!.blobPath).toBe(path.join(model.hubRoot, 'models--acme--Tiny-GGUF', 'blobs', sha256Hex('q4-new')));
    expect(es[1]!.folderName).toBe('models--acme--Tiny-GGUF');
    expect(es[1]!.size).toBe(6);
  });

  it('isCurrent is false for every entry when refs/main names no snapshot (V16)', async () => {
    const { model } = await loadCase(repo([{ path: 'a-Q8_0.gguf', text: 'x' }], [], 'nope'));
    expect(model.repos[0]!.mainCommit).toBe('nope');
    expect(ggufEntries(model).map((e) => e.isCurrent)).toEqual([false]);
  });

  it('isCurrent is false for every entry when refs/main is absent (V16)', async () => {
    const { model, c } = await loadCase(repo([{ path: 'a-Q8_0.gguf', text: 'x' }]));
    unlinkSync(path.join(c.hub, 'models--acme--Tiny-GGUF', 'refs', 'main'));
    const rescanned = await scanHub(model.hubRoot);
    expect(rescanned.repos[0]!.mainCommit).toBeNull();
    expect(ggufEntries(rescanned).map((e) => [e.relpath, e.isCurrent])).toEqual([['a-Q8_0.gguf', false]]);
  });

  it('ignores plain files in snapshots and non-model repos', async () => {
    const { model } = await loadCase(repo([{ path: 'a-Q8_0.gguf', text: 'x', plain: true }]));
    expect(ggufEntries(model)).toEqual([]);
    const ds = await loadCase({ repos: [{ id: 'acme/Data', type: 'dataset', main: 'c1', snapshots: [
      { commit: 'c1', mtime: 1700000100, files: [{ path: 'd.gguf', text: 'd' }] }] }], views: [] });
    expect(ds.model.repos.map((r) => r.type)).toEqual(['dataset']);
    expect(ggufEntries(ds.model)).toEqual([]);
  });

  it('matches the .gguf suffix case-sensitively off win32', async () => {
    const { model } = await loadCase(repo([{ path: 'A-Q8_0.GGUF', text: 'x' }, { path: 'b-Q8_0.gguf', text: 'y' }]));
    expect(ggufEntries(model).map((e) => e.relpath)).toEqual(process.platform === 'win32' ? ['A-Q8_0.GGUF', 'b-Q8_0.gguf'] : ['b-Q8_0.gguf']);
  });

  it('dedupes by relpath across snapshots, first (main) wins', async () => {
    const { model } = await loadCase(repo([{ path: 'a-Q8_0.gguf', text: 'new' }], [{ path: 'a-Q8_0.gguf', text: 'old' }]));
    const es = ggufEntries(model);
    expect(es).toHaveLength(1);
    expect(es[0]!.sha256).toBe(sha256Hex('new'));
  });

  it('a dangling main link does not hide the older snapshot file: seen is marked after the blob check (cache.py:61-82)', async () => {
    const { model, c } = await loadCase(repo(
      [{ path: 'a-Q8_0.gguf', text: 'new', store: true }], [{ path: 'a-Q8_0.gguf', text: 'old' }]));
    const h = sha256Hex(`xet:${sha256Hex('new')}`);
    unlinkSync(path.join(c.hub, 'blobs', h.slice(0, 2), h));
    const es = ggufEntries(await scanHub(model.hubRoot));
    expect(es.map((e) => [e.relpath, e.sha256, e.isCurrent])).toEqual([['a-Q8_0.gguf', sha256Hex('old'), false]]);
  });

  it('reports the sha256 (etag), not the store name, and size follows the store link', async () => {
    const { model } = await loadCase(repo([{ path: 'a-Q8_0.gguf', text: 'stored', store: true }]));
    const [e] = ggufEntries(model);
    expect(e!.sha256).toBe(sha256Hex('stored'));
    expect(e!.size).toBe(6);
    expect(path.basename(e!.blobPath)).toBe(sha256Hex('stored'));
  });

  it('drops an entry whose store payload is missing', async () => {
    const { model, c } = await loadCase(repo([{ path: 'a-Q8_0.gguf', text: 'stored', store: true }]));
    expect(ggufEntries(model)).toHaveLength(1);
    const h = sha256Hex(`xet:${sha256Hex('stored')}`);
    unlinkSync(path.join(c.hub, 'blobs', h.slice(0, 2), h));
    expect(ggufEntries(await scanHub(model.hubRoot))).toEqual([]);
  });

  it('flags mmproj and shards', async () => {
    const { model } = await loadCase(repo([{ path: 'mmproj-F16.gguf', text: 'p' }, { path: 'big-Q4_K_M-00001-of-00002.gguf', text: 's1' }]));
    expect(ggufEntries(model).map((e) => [e.basename, e.isMmproj, e.isShard])).toEqual([
      ['big-Q4_K_M-00001-of-00002.gguf', false, true], ['mmproj-F16.gguf', true, false]]);
  });

  it('sorts by key in code point order', async () => {
    const { model } = await loadCase(repo([{ path: 'b.gguf', text: '1' }, { path: 'B.gguf', text: '2' }, { path: 'a/z.gguf', text: '3' }]));
    expect(ggufEntries(model).map((e) => e.relpath)).toEqual(['B.gguf', 'a/z.gguf', 'b.gguf']);
  });
});

describe('mmprojFor', () => {
  it('test_mmproj_for_prefers_f16', async () => {
    const { model } = await loadCase(repo([
      { path: 'mmproj-BF16.gguf', text: 'b' }, { path: 'x/mmproj-model-f16.gguf', text: 'f' },
      { path: 'mmproj-fp16.gguf', text: 'fp' }, { path: 'mmproj-F32.gguf', text: '32' }]));
    expect(mmprojFor(ggufEntries(model), 'acme/Tiny-GGUF')!.relpath).toBe('x/mmproj-model-f16.gguf');
  });

  it('falls back BF16 > F32 > first sorted, and null when none', () => {
    const e = (relpath: string, repoId = 'acme/Tiny-GGUF') => entry({ relpath, repoId });
    expect(mmprojFor([e('mmproj-F32.gguf'), e('mmproj-BF16.gguf')], 'acme/Tiny-GGUF')!.relpath).toBe('mmproj-BF16.gguf');
    expect(mmprojFor([e('mmproj-F32.gguf'), e('mmproj-Q8_0.gguf')], 'acme/Tiny-GGUF')!.relpath).toBe('mmproj-F32.gguf');
    expect(mmprojFor([e('mmproj-b.gguf'), e('mmproj-Q8_0.gguf'), e('mmproj-a.gguf')], 'acme/Tiny-GGUF')!.relpath).toBe('mmproj-Q8_0.gguf');
    expect(mmprojFor([e('Tiny-Q4.gguf')], 'acme/Tiny-GGUF')).toBeNull();
    expect(mmprojFor([e('mmproj-F16.gguf', 'other/R')], 'acme/Tiny-GGUF')).toBeNull();
    expect(mmprojFor([], 'acme/Tiny-GGUF')).toBeNull();
  });
});
