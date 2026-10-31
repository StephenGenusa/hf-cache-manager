import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readStoreMarker, parseRefs, isStorePath, validRefsFor, lockPresent, readStoreFile, sweepDecision } from '../../../src/core/scan/store';
import { useCanaries } from '../../helpers/canary';
import { folderName, hex, hubBuilder } from '../../helpers/hub-builder';
import { tmpBase } from '../../helpers/tmp';
import { treeDigest } from '../../helpers/tree-digest';
import type { FileFacts, StoreFile } from '../../../src/core/types';
import { mkdir, symlink, writeFile } from 'node:fs/promises';

useCanaries();

const roots: string[] = [];
const build = async () => {
  const hb = await hubBuilder();
  roots.push(hb.root);
  return hb;
};
afterAll(() => {
  // each test's afterEach cleanup must have removed the temp root this file created
  expect(roots.filter((r) => existsSync(r))).toEqual([]);
});

describe('readStoreMarker', () => {
  it('is true only for a regular file containing exactly "1\\n"', async () => {
    const hb = await build();
    expect(await readStoreMarker(hb.hub)).toBe(false);
    await hb.marker('1');
    expect(await readStoreMarker(hb.hub)).toBe(false);
    await hb.marker('1\n\n');
    expect(await readStoreMarker(hb.hub)).toBe(false);
    await hb.marker('1\r\n');
    expect(await readStoreMarker(hb.hub)).toBe(false);
    await hb.marker('1\n');
    expect(await readStoreMarker(hb.hub)).toBe(true);
  });
  it('is false when the marker is a symlink to a valid marker', async () => {
    const hb = await build();
    const elsewhere = join(hb.root, 'elsewhere');
    await writeFile(elsewhere, '1\n');
    await hb.symlink(elsewhere, join(hb.hub, 'blobs', '.huggingface-shared-blobs'));
    expect(await readStoreMarker(hb.hub)).toBe(false);
  });
});

describe('parseRefs', () => {
  it('splits on \\n and drops only the final empty element', () => {
    expect(parseRefs('models--a--b/blobs/x\nmodels--c--d/blobs/y\n')).toEqual(['models--a--b/blobs/x', 'models--c--d/blobs/y']);
    expect(parseRefs('a\n\nb')).toEqual(['a', '', 'b']);
    expect(parseRefs('a\r\n')).toEqual(['a\r']);
    expect(parseRefs('')).toEqual([]);
  });
});

describe('isStorePath (shape)', () => {
  const hub = join(tmpBase(), 'hfcm-t-shape-only', 'hub'); // pure string test, nothing is created
  const h = hex('payload');
  it('accepts <hub>/blobs/<xx>/<64hex> with xx = hash[:2]', () => {
    expect(isStorePath(hub, join(hub, 'blobs', h.slice(0, 2), h))).toBe(true);
  });
  it.each([
    ['wrong prefix dir', () => join(hub, 'blobs', 'zz', h)],
    ['upper-case hash', () => join(hub, 'blobs', h.slice(0, 2).toUpperCase(), h.toUpperCase())],
    ['three levels', () => join(hub, 'blobs', h.slice(0, 2), 'x', h)],
    ['63 chars', () => join(hub, 'blobs', h.slice(0, 2), h.slice(1))],
    ['.refs file', () => join(hub, 'blobs', h.slice(0, 2), h + '.refs')],
    ['outside store', () => join(hub, 'models--a--b', 'blobs', h)],
  ])('rejects %s', (_n, p) => expect(isStorePath(hub, p())).toBe(false));
});

describe('hub builder', () => {
  it('builds hfhub-shaped links and a stable tree digest', async () => {
    const hb = await build();
    expect(folderName('unsloth/X')).toBe('models--unsloth--X');
    const r = hb.repo('o/m');
    const etags = await r.files('c1', { 'a/b.gguf': 5, 'config.json': '{}' });
    await r.main('c1');
    const before = await treeDigest(hb.hub);
    expect(before['models--o--m/snapshots/c1/a/b.gguf']).toBe(`link:../../../blobs/${etags['a/b.gguf']}`);
    expect(before['models--o--m/refs/main']).toMatch(/^file:3:/);
    expect(await treeDigest(hb.hub)).toEqual(before);
    expect(Object.keys(before).some((k) => k.includes('.hfcm-canary'))).toBe(false);
  });
});

describe('validRefsFor / lockPresent / readStoreFile', () => {
  const H = hex('xet-1');
  const etagA = hex('etag-a');
  const etagB = hex('etag-b');
  const refA = 'models--a--one/blobs/' + etagA;
  const refB = 'models--b--two/blobs/' + etagB;

  const setup = async () => {
    const hb = await build();
    const S = join(hb.hub, 'blobs', H.slice(0, 2), H);
    await hb.store(H, 1234, null);
    await hb.repo('a/one').storeLink(etagA, H);
    await hb.repo('b/two').storeLink(etagB, H);
    return { hb, hub: hb.hub, S };
  };

  it('keeps lines whose candidate is a symlink to exactly this store path, in manifest order', async () => {
    const { hub, S } = await setup();
    expect(await validRefsFor(hub, S, [refB, refA])).toEqual([refB, refA]);
  });
  it('deduplicates repeated lines, first occurrence wins', async () => {
    const { hub, S } = await setup();
    expect(await validRefsFor(hub, S, [refA, refA])).toEqual([refA]);
  });
  it('a missing candidate is simply not a reference', async () => {
    const { hub, S } = await setup();
    expect(await validRefsFor(hub, S, [refA, 'models--gone--x/blobs/' + hex(9)])).toEqual([refA]);
  });
  it('a candidate that is a regular file is not a reference', async () => {
    const { hb, hub, S } = await setup();
    const e = hex('plain');
    await hb.repo('c/plain').blob(e, 'data');
    expect(await validRefsFor(hub, S, ['models--c--plain/blobs/' + e])).toEqual([]);
  });
  it('a symlink to a different store path is not a reference', async () => {
    const { hb, hub, S } = await setup();
    const e = hex('other');
    await hb.repo('c/other').storeLink(e, hex('xet-2'));
    expect(await validRefsFor(hub, S, ['models--c--other/blobs/' + e])).toEqual([]);
  });
  it.each([
    ['absolute', (r: string) => '/' + r],
    ['dot-dot', () => 'models--a--one/../models--a--one/blobs/' + etagA],
    ['two parts', () => 'models--a--one/' + etagA],
    ['four parts', () => 'models--a--one/blobs/sub/' + etagA],
    ['bad type prefix', () => 'loras--a--one/blobs/' + etagA],
    ['not blobs', () => 'models--a--one/snapshots/' + etagA],
    ['empty leaf', () => 'models--a--one/blobs/'],
    ['carriage return', (r: string) => r + '\r'],
    ['empty line', () => ''],
  ])('skips a %s line (3-part candidate rule)', async (_n, f) => {
    const { hub, S } = await setup();
    expect(await validRefsFor(hub, S, [f(refA)])).toEqual([]);
  });
  it('accepts datasets-- candidates', async () => {
    const { hb, hub, S } = await setup();
    const e = hex('ds');
    await hb.repo('o/d', 'dataset').storeLink(e, H);
    const refD = 'datasets--o--d/blobs/' + e;
    expect(await validRefsFor(hub, S, [refD])).toEqual([refD]);
  });
  it('accepts spaces-- and kernels-- candidates by prefix', async () => {
    const { hb, hub, S } = await setup();
    const e = hex('sp');
    await hb.repo('o/s', 'space').storeLink(e, H);
    const k = hex('kn');
    await hb.symlink(`../../blobs/${H.slice(0, 2)}/${H}`, join(hub, 'kernels--o--k', 'blobs', k));
    const refS = 'spaces--o--s/blobs/' + e;
    const refK = 'kernels--o--k/blobs/' + k;
    expect(await validRefsFor(hub, S, [refS, refK])).toEqual([refS, refK]);
  });
  it('compares abspath, not realpath: a link through an aliased directory is not a reference', async () => {
    const { hb, hub, S } = await setup();
    const alias = join(hb.root, 'alias');
    await symlink(join(hub, 'blobs'), alias); // directly under hb.root (builder's mkdir refuses the temp root itself)
    const e = hex('aliased');
    await hb.symlink(`${alias}/${H.slice(0, 2)}/${H}`, join(hub, 'models--a--one', 'blobs', e));
    expect(await validRefsFor(hub, S, ['models--a--one/blobs/' + e])).toEqual([]);
  });
  it('accepts an absolute link target and strips \\\\?\\', async () => {
    const { hb, hub, S } = await setup();
    const e = hex('abs');
    await hb.symlink('\\\\?\\' + S, join(hub, 'models--a--one', 'blobs', e));
    expect(await validRefsFor(hub, S, ['models--a--one/blobs/' + e])).toEqual(['models--a--one/blobs/' + e]);
  });
  it('normalises a non-canonical storePath and hubRoot before comparing', async () => {
    const { hub, S } = await setup();
    expect(await validRefsFor(hub, join(hub, '.', 'blobs', H.slice(0, 2), H), [refA])).toEqual([refA]);
    expect(await validRefsFor(hub + '/', S, [refA])).toEqual([refA]);
    const rel = relative(process.cwd(), hub);
    expect(await validRefsFor(rel, relative(process.cwd(), S), [refA])).toEqual([refA]);
    const sf = (await readStoreFile(join(hub, '.'), join(hub, '.', 'blobs', H.slice(0, 2), H))).store;
    expect(sf?.path).toBe(S);
  });
  it.each(['C:\\x\\blobs\\y', '\\\\srv\\x'])('skips the win32-absolute line %s', async (l) => {
    const { hub, S } = await setup();
    expect(await validRefsFor(hub, S, [l])).toEqual([]);
  });
  it('ENOTDIR on a candidate makes validRefs null', async () => {
    const { hub, S } = await setup();
    await mkdir(join(hub, 'models--e--bad'), { recursive: true });
    await writeFile(join(hub, 'models--e--bad', 'blobs'), 'file');
    expect(await validRefsFor(hub, S, [refA, 'models--e--bad/blobs/' + hex(3)])).toBeNull();
  });

  describe('lockPresent', () => {
    it('is true for <hash>.lock or <hash>.lock.soft of any type, false otherwise', async () => {
      const { S } = await setup();
      expect(await lockPresent(S)).toBe(false);
      await writeFile(S + '.lock.soft', '');
      expect(await lockPresent(S)).toBe(true);
    });
    it('is true for .lock', async () => {
      const { S } = await setup();
      await writeFile(S + '.lock', '');
      expect(await lockPresent(S)).toBe(true);
    });
    it('is true on a non-ENOENT error (ENOTDIR)', async () => {
      const { hub } = await setup();
      const x = join(hub, 'blobs', 'zz');
      await writeFile(x, 'f');
      expect(await lockPresent(join(x, hex('q')))).toBe(true);
    });
  });

  describe('readStoreFile', () => {
    it('reads facts, refsRaw, validRefs and lockPresent', async () => {
      const { hb, hub, S } = await setup();
      await hb.store(H, 1234, [refA, 'models--gone--x/blobs/' + hex(9)]);
      await hb.marker();
      const r = await readStoreFile(hub, S);
      expect(r.storeMarked).toBe(true);
      expect(r.store).toMatchObject({
        path: S, hash: H, refsPath: S + '.refs', lockPresent: false,
        refsRaw: [refA, 'models--gone--x/blobs/' + hex(9)], validRefs: [refA],
      });
      expect(r.store!.facts).toMatchObject({ size: 1234, isFile: true, isSymlink: false });
    });
    it('storeMarked is false without a marker', async () => {
      const { hub, S } = await setup();
      expect((await readStoreFile(hub, S)).storeMarked).toBe(false);
    });
    it('refsRaw and validRefs are null when .refs is missing', async () => {
      const { hub, S } = await setup();
      expect((await readStoreFile(hub, S)).store).toMatchObject({ refsRaw: null, validRefs: null });
    });
    it('refsRaw and validRefs are null when .refs is a directory or a symlink', async () => {
      const { hb, hub, S } = await setup();
      await mkdir(S + '.refs');
      expect((await readStoreFile(hub, S)).store).toMatchObject({ refsRaw: null, validRefs: null });
      const { hb: hb2, hub: hub2, S: S2 } = await setup();
      const real = join(hb2.root, 'real.refs');
      await writeFile(real, refA + '\n');
      await hb2.symlink(real, S2 + '.refs');
      expect((await readStoreFile(hub2, S2)).store).toMatchObject({ refsRaw: null, validRefs: null });
      void hb; void hub;
    });
    it('validRefs is [] (not null) for an existing empty .refs', async () => {
      const { hb, hub, S } = await setup();
      await hb.store(H, 10, []);
      expect((await readStoreFile(hub, S)).store).toMatchObject({ refsRaw: [], validRefs: [] });
    });
    it('store is null for a payload that is not store-shaped, a symlink, a directory or missing', async () => {
      const { hb, hub, S } = await setup();
      expect((await readStoreFile(hub, join(hub, 'blobs', 'zz', H))).store).toBeNull();
      const H2 = hex('lnk');
      await hb.symlink(S, join(hub, 'blobs', H2.slice(0, 2), H2));
      expect((await readStoreFile(hub, join(hub, 'blobs', H2.slice(0, 2), H2))).store).toBeNull();
      const H3 = hex('dir');
      await mkdir(join(hub, 'blobs', H3.slice(0, 2), H3), { recursive: true });
      expect((await readStoreFile(hub, join(hub, 'blobs', H3.slice(0, 2), H3))).store).toBeNull();
      const H4 = hex('none');
      expect((await readStoreFile(hub, join(hub, 'blobs', H4.slice(0, 2), H4))).store).toBeNull();
    });
  });
});

describe('sweepDecision', () => {
  const fileFacts = (o: Partial<FileFacts> = {}): FileFacts => ({
    dev: 1, ino: 1, size: 0, mtimeMs: 0, nlink: 1, isSymlink: false, isDirectory: false, isFile: true, ...o,
  });
  const hub = join(tmpBase(), 'hfcm-t-sweep-only', 'hub'); // pure strings, nothing is created
  const H = hex('payload');
  const S = join(hub, 'blobs', H.slice(0, 2), H);
  const etagA = hex('a'), etagB = hex('b');
  const refA = 'models--a--one/blobs/' + etagA, refB = 'models--b--two/blobs/' + etagB;
  const blobA = join(hub, 'models--a--one', 'blobs', etagA), blobB = join(hub, 'models--b--two', 'blobs', etagB);
  const base: StoreFile = {
    path: S, hash: H, facts: fileFacts({ size: 500 }), refsPath: S + '.refs',
    refsRaw: [refA, refB], validRefs: [refA, refB], lockPresent: false,
  };

  it('deletable only when every valid ref is being removed', () => {
    expect(sweepDecision(base, [blobA, blobB], true)).toEqual({ deletable: true, reason: 'store-unreferenced' });
    expect(sweepDecision(base, [blobA], true)).toEqual({ deletable: false, reason: 'store-shared' });
  });
  it('valid and empty refs => deletable (gc case)', () =>
    expect(sweepDecision({ ...base, refsRaw: ['models--gone--x/blobs/' + hex(1)], validRefs: [] }, [], true))
      .toEqual({ deletable: true, reason: 'store-unreferenced' }));
  it.each([
    ['store not marked', base, false],
    ['refsRaw null', { ...base, refsRaw: null, validRefs: null }, true],
    ['validRefs null', { ...base, validRefs: null }, true],
    ['lock present', { ...base, lockPresent: true }, true],
    ['payload not a file', { ...base, facts: { ...base.facts, isFile: false, isSymlink: true } }, true],
    ['path not store-shaped', { ...base, path: join(hub, 'blobs', 'zz', H) }, true],
  ])('uncertain when %s', (_n, s, marked) =>
    expect(sweepDecision(s as StoreFile, [blobA, blobB], marked)).toEqual({ deletable: false, reason: 'store-uncertain' }));
  it('a relative or foreign string in removing never matches', () =>
    expect(sweepDecision(base, [refA, refB], true)).toEqual({ deletable: false, reason: 'store-shared' }));
});
