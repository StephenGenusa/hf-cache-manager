import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { classifyRepo } from '../../../src/core/classify/classify';
import { fileStates, requiresBytes, unchangedLinks } from '../../../src/core/download/cache-state';
import { remoteRepo, repoFolderName, toRemoteListing, type RemoteListing } from '../../../src/core/download/remote-repo';
import { parseRepoFolder, scanHub } from '../../../src/core/scan/scanner';
import type { RepoType } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { hex, hubBuilder } from '../../helpers/hub-builder';

useCanaries();

const COMMIT = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const mk = (files: Array<[string, number | null, string | null]>, over: { repoId?: string; commit?: string } = {}): RemoteListing =>
  toRemoteListing({
    repoId: 'o/m', type: 'model', commit: COMMIT,
    files: files.map(([path, size, etag]) => ({ path, size, etag, lfs: true })), ...over,
  });
const nullRead = (): null => null;

describe('remoteRepo', () => {
  it('classifies like the same files on disk (quants, shards, mmproj, draft)', async () => {
    const entries: Record<string, number> = {
      'M-Q4_K_M.gguf': 400, 'M-Q8_0-00001-of-00002.gguf': 300, 'M-Q8_0-00002-of-00002.gguf': 310,
      'mmproj-F16.gguf': 50, 'MTP/M-Q4_K_M.gguf': 40, 'README.md': 3,
    };
    const hb = await hubBuilder();
    const rb = hb.repo('o/m');
    await rb.files(COMMIT, entries);
    await rb.main(COMMIT);
    const disk = (await scanHub(hb.hub)).repos[0]!;
    const remote = remoteRepo(mk(Object.entries(entries).map(([p, s]) => [p, s, hex(p)] as [string, number, string])));
    const strip = (v: ReturnType<typeof classifyRepo>) => ({
      kinds: v.kinds, apparentBytes: v.apparentBytes,
      groups: v.groups.map((g) => ({ key: g.key, files: g.files.map((f) => f.relpath).sort(), b: g.apparentBytes, s: g.shards, l: g.locked })),
    });
    expect(strip(classifyRepo(remote, nullRead))).toEqual(strip(classifyRepo(disk)));
  });

  it('builds an in-memory repo under the sentinel root', () => {
    const r = remoteRepo(mk([['a/b.gguf', 7, hex('x')]]));
    expect(r.folder).toBe('/hub-remote/models--o--m');
    expect(r.snapshots).toEqual([COMMIT]);
    expect(r.files[0]).toMatchObject({ isCurrent: true, blobEtag: hex('x'), facts: { ino: 0, dev: 0, size: 7, isFile: true, isSymlink: false } });
    expect(r.blobs[hex('x')]).toMatchObject({ size: 7, storePath: null, dangling: false });
  });

  it.each(['../x', '/abs', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a\0b', '', 'dir/'])('refuses unsafe path %j', (p) => {
    const l = mk([[p, 1, hex('e')], ['ok.txt', 1, hex('f')]]);
    expect(l.refused).toEqual([p]);
    expect(l.files.map((f) => f.path)).toEqual(['ok.txt']);
    const r = remoteRepo(l);
    expect(r.files.map((f) => f.relpath)).toEqual(['ok.txt']);
    expect(JSON.stringify(r)).not.toContain('..');
    expect(fileStates(l, { hubRoot: '', repos: [], storeMarked: false, store: {}, scannedAt: 0 }).has(p)).toBe(false);
  });

  it('refuses non-hex etags and unsafe commits or ids', () => {
    expect(mk([['a', 1, '../../x']]).refused).toEqual(['a']);
    expect(mk([['a', 1.5, hex('e')], ['b', Number.MAX_SAFE_INTEGER + 2, hex('e')], ['c', -1, hex('e')]]).refused).toEqual(['a', 'b', 'c']);
    expect(() => remoteRepo(mk([], { commit: '../x' }))).toThrow();
    expect(() => remoteRepo(mk([], { repoId: 'o/../m' }))).toThrow();
  });

  it('puts null size or etag in unverifiable, and duplicates in refused', () => {
    const l = mk([['n1', null, hex('e')], ['n2', 3, null], ['d', 1, hex('1')], ['d', 2, hex('2')], ['ok', 4, hex('3')]]);
    expect(l.unverifiable).toEqual(['n1', 'n2']);
    expect(l.refused).toEqual(['d']);
    expect(l.files.map((f) => [f.path, f.size])).toEqual([['d', 1], ['ok', 4]]);
    expect(remoteRepo(l).files.map((f) => f.relpath)).toEqual(['d', 'ok']);
  });
});

describe('repoFolderName', () => {
  it.each<RepoType>(['model', 'dataset', 'space'])('round-trips parseRepoFolder for %s', (t) => {
    expect(parseRepoFolder(repoFolderName('org/name', t))).toEqual({ id: 'org/name', type: t });
    expect(parseRepoFolder(repoFolderName('gpt2', t))).toEqual({ id: 'gpt2', type: t });
  });
  it.each(['o-/m', 'o/m-', 'o/a--b', 'a/b/c', '', 'o//m'])('rejects %j', (id) => {
    expect(() => repoFolderName(id, 'model')).toThrow();
  });
});

async function cache() {
  const hb = await hubBuilder();
  const rb = hb.repo('o/m');
  const cachedE = hex('cached'), oldE = hex('old'), newE = hex('new'), partE = hex('part'), bigE = hex('big');
  await rb.blob(cachedE, 10);
  await rb.link(OLD, 'cached.bin', cachedE);
  await rb.blob(oldE, 20);
  await rb.link(OLD, 'upd.bin', oldE);
  await rb.plain(OLD, 'plain.bin', 5);
  await rb.incomplete(partE, 5);
  await rb.incomplete(bigE, 99);
  await rb.main(OLD);
  const model = await scanHub(hb.hub);
  const listing = mk([
    ['cached.bin', 10, cachedE], ['upd.bin', 30, newE], ['plain.bin', 5, hex('plainE')],
    ['part.bin', 100, partE], ['big.bin', 50, bigE], ['absent.bin', 40, hex('abs')],
  ]);
  return { model, listing };
}

describe('fileStates / requiresBytes / unchangedLinks', () => {
  it('maps states per hfu probe_cache plus .incomplete', async () => {
    const { model, listing } = await cache();
    const s = fileStates(listing, model);
    expect(Object.fromEntries(s)).toEqual({
      // A plain copy in an older snapshot only is not this commit's file
      'cached.bin': { kind: 'cached' }, 'upd.bin': { kind: 'update' }, 'plain.bin': { kind: 'update' },
      'part.bin': { kind: 'partial', have: 5 }, 'big.bin': { kind: 'absent' }, 'absent.bin': { kind: 'absent' },
    });
    expect(requiresBytes(listing, s, ['cached.bin'])).toBe(0);
    expect(requiresBytes(listing, s, ['upd.bin', 'absent.bin'])).toBe(70);
    expect(requiresBytes(listing, s, ['part.bin'])).toBe(95);
    expect(requiresBytes(listing, s, ['plain.bin', 'big.bin', 'nope', 'big.bin'])).toBe(55);
  });

  it('is all absent when the repo is not cached', async () => {
    const { model, listing } = await cache();
    const s = fileStates({ ...listing, repoId: 'x/y' }, model);
    expect([...s.values()].every((v) => v.kind === 'absent')).toBe(true);
    expect(unchangedLinks({ ...listing, repoId: 'x/y' }, model)).toEqual([]);
  });

  it('lists unchanged files whose blob exists but is not linked in the new commit', async () => {
    const { model, listing } = await cache();
    expect(unchangedLinks(listing, model)).toEqual([{ path: 'cached.bin', etag: hex('cached') }]);
    // already linked in snapshots/<commit>: not listed again
    const hb = await hubBuilder();
    const rb = hb.repo('o/m');
    await rb.blob(hex('cached'), 10);
    await rb.link(COMMIT, 'cached.bin', hex('cached'));
    await rb.main(COMMIT);
    expect(unchangedLinks(listing, await scanHub(hb.hub))).toEqual([]);
  });

  it('sees 40-hex git blobs as present', async () => {
    const e = 'c'.repeat(40);
    const hb = await hubBuilder();
    const rb = hb.repo('o/m');
    await rb.blob(e, 4);
    await rb.link(OLD, 'small.txt', e);
    await rb.main(OLD);
    const model = await scanHub(hb.hub);
    const l = mk([['small.txt', 4, e]]);
    expect(fileStates(l, model).get('small.txt')).toEqual({ kind: 'cached' });
    expect(unchangedLinks(l, model)).toEqual([{ path: 'small.txt', etag: e }]);
  });

  it('reports an interrupted update as partial and requires only the rest', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/m');
    const oldE = hex('o'), newE = hex('n');
    await rb.blob(oldE, 20);
    await rb.link(OLD, 'u.bin', oldE);
    await rb.incomplete(newE, 12);
    await rb.main(OLD);
    const model = await scanHub(hb.hub);
    const l = mk([['u.bin', 30, newE]]);
    const s = fileStates(l, model);
    expect(s.get('u.bin')).toEqual({ kind: 'partial', have: 12 });
    expect(requiresBytes(l, s, ['u.bin'])).toBe(18);
  });

  it('falls back to update when the partial is not resumable (== size)', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/m');
    await rb.blob(hex('o'), 20);
    await rb.link(OLD, 'u.bin', hex('o'));
    await rb.incomplete(hex('n'), 30);
    await rb.incomplete(hex('p'), 10);
    const model = await scanHub(hb.hub);
    const l = mk([['u.bin', 30, hex('n')], ['p.bin', 11, hex('p')], ['q.bin', 10, hex('p')]]);
    const s = fileStates(l, model);
    expect(s.get('u.bin')).toEqual({ kind: 'update' });
    expect(s.get('p.bin')).toEqual({ kind: 'partial', have: 10 });
    expect(s.get('q.bin')).toEqual({ kind: 'absent' });
  });

  it('does not count a truncated or oversized blob as present', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/m');
    await rb.blob(hex('t'), 5);
    await rb.link(OLD, 't.bin', hex('t'));
    await rb.blob(hex('big'), 50);
    await rb.blob('d'.repeat(40), 3);
    await rb.blob(hex('ok'), 10);
    const model = await scanHub(hb.hub);
    const l = mk([['t.bin', 10, hex('t')], ['big.bin', 10, hex('big')], ['s.txt', 4, 'd'.repeat(40)], ['ok.bin', 10, hex('ok')]]);
    const s = fileStates(l, model);
    expect(s.get('t.bin')).toEqual({ kind: 'update' });
    expect(s.get('big.bin')).toEqual({ kind: 'absent' });
    expect(s.get('s.txt')).toEqual({ kind: 'absent' });
    expect(unchangedLinks(l, model)).toEqual([{ path: 'ok.bin', etag: hex('ok') }]);
  });

  it('a repo blob linked into the shared store is present when its payload is a regular file of the Hub size', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/m');
    const okE = hex('st-ok'), shortE = hex('st-short'), twoE = hex('st-two'), outE = hex('st-out');
    const okH = hex('payload-ok'), shortH = hex('payload-short'), twoH = hex('payload-two');
    await hb.marker();
    await hb.store(okH, 10, [`models--o--m/blobs/${okE}`]);
    await rb.storeLink(okE, okH);
    await rb.link(OLD, 'ok.bin', okE);
    await hb.store(shortH, 4, [`models--o--m/blobs/${shortE}`]);
    await rb.storeLink(shortE, shortH);
    // two hops (the store "payload" is itself a link): never followed past the first
    const real = await hb.store(hex('real'), 10, null);
    await hb.symlink(real, `${hb.hub}/blobs/${twoH.slice(0, 2)}/${twoH}`);
    await rb.storeLink(twoE, twoH);
    // a link to a regular file of the Hub size outside the store layout
    await writeFile(`${hb.hub}/elsewhere.bin`, 'x'.repeat(10));
    await hb.symlink('../../elsewhere.bin', `${rb.folder}/blobs/${outE}`);
    await rb.main(OLD);
    const model = await scanHub(hb.hub);
    const l = mk([['ok.bin', 10, okE], ['short.bin', 10, shortE], ['two.bin', 10, twoE], ['out.bin', 10, outE]]);
    const s = fileStates(l, model);
    expect(s.get('ok.bin')).toEqual({ kind: 'cached' });
    expect(s.get('short.bin')).toEqual({ kind: 'absent' });
    expect(s.get('two.bin')).toEqual({ kind: 'absent' });
    expect(s.get('out.bin')).toEqual({ kind: 'absent' });
    // a new commit: the store-linked file is linked into it, not downloaded again
    expect(unchangedLinks(l, model)).toEqual([{ path: 'ok.bin', etag: okE }]);
  });

  it('a plain copy counts as cached only in snapshots/<commit> at the Hub size; elsewhere it is an update', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/m');
    await rb.plain(OLD, 'old.bin', 5);
    await rb.plain(COMMIT, 'here.bin', 5);
    await rb.plain(COMMIT, 'short.bin', 3);
    await rb.plain(OLD, 'both.bin', 5);
    await rb.plain(COMMIT, 'both.bin', 5);
    await rb.main(OLD);
    const model = await scanHub(hb.hub);
    const l = mk([['old.bin', 5, hex('o2')], ['here.bin', 5, hex('h')], ['short.bin', 5, hex('s')], ['both.bin', 5, hex('b')]]);
    const s = fileStates(l, model);
    expect(Object.fromEntries(s)).toEqual({
      'old.bin': { kind: 'update' }, 'here.bin': { kind: 'cached' }, 'short.bin': { kind: 'update' }, 'both.bin': { kind: 'cached' },
    });
    expect(requiresBytes(l, s, ['old.bin', 'here.bin', 'short.bin'])).toBe(10);
    expect(unchangedLinks(l, model)).toEqual([]);   // no blob: nothing to link
  });

  it('does not count a dangling store link or a non-file 40-hex entry as present', async () => {
    const hb = await hubBuilder();
    const rb = hb.repo('o/m');
    await rb.storeLink(hex('dang'), hex('nostore'));
    await hb.symlink('elsewhere', `${rb.folder}/blobs/${'e'.repeat(40)}`);
    const model = await scanHub(hb.hub);
    const l = mk([['d.bin', 10, hex('dang')], ['e.txt', 4, 'e'.repeat(40)]]);
    expect([...fileStates(l, model).values()]).toEqual([{ kind: 'absent' }, { kind: 'absent' }]);
    expect(unchangedLinks(l, model)).toEqual([]);
  });
});
