// Pure logic, plain data: no file system and no substitutes.
import { describe, expect, it } from 'vitest';
import { toRemoteListing } from '../../../src/core/download/remote-repo';
import {
  MAX_PART_SIZE, PART_SIZE, manifestName, mergeManifests, objectDir, parseManifest, partCount, partPath, partSizes, repoKey, serializeManifest,
  toRawListing, type TransferManifest,
} from '../../../src/core/transfer/format';

const C = 'c'.repeat(40);
const E64 = 'a'.repeat(64);
const E40 = 'b'.repeat(40);
const base: TransferManifest = {
  version: 1, repoId: 'org/name', type: 'model', commit: C, ref: 'main', exportedAt: 1000,
  files: [
    { path: 'model.gguf', size: 10, etag: E64, lfs: true, partSize: 4 },
    { path: 'config.json', size: 3, etag: E40, lfs: false, partSize: 4 },
  ],
};
const named = (m: TransferManifest): { text: string; name: string } => {
  const text = serializeManifest(m);
  return { text, name: manifestName(text) };
};
const edited = (change: (o: Record<string, unknown>) => void): { text: string; name: string } => {
  const o = JSON.parse(serializeManifest(base)) as Record<string, unknown>;
  change(o);
  const text = JSON.stringify(o);
  return { text, name: manifestName(text) };
};

describe('parts', () => {
  it('the part size is 1 GiB, below the FAT32 file limit', () => {
    expect(PART_SIZE).toBe(1024 ** 3);
    expect(PART_SIZE).toBeLessThan(MAX_PART_SIZE);
    expect(MAX_PART_SIZE).toBe(4 * 1024 ** 3 - 1);
  });
  it.each([
    [0, 4, [0]], [1, 4, [1]], [4, 4, [4]], [5, 4, [4, 1]], [8, 4, [4, 4]], [10, 4, [4, 4, 2]],
  ])('a file of %i bytes in parts of %i is %j', (size, part, want) => {
    expect(partSizes(size, part)).toEqual(want);
    expect(partCount(size, part)).toBe(want.length);
    expect(partSizes(size, part).reduce((a, b) => a + b, 0)).toBe(size);
  });
  it('part names are the etag and a 3-digit index under objects/<first two hex>', () => {
    expect(objectDir(E64)).toBe('objects/aa');
    expect(partPath(E64, 0)).toBe(`objects/aa/${E64}.000`);
    expect(partPath(E40, 12)).toBe(`objects/bb/${E40}.012`);
    expect(partPath(E40, 1234)).toBe(`objects/bb/${E40}.1234`);
  });
  it.each([['../x'], ['A'.repeat(64)], [''], ['a'.repeat(63)], ['a/b']])('refuses %j as an etag', (etag) => {
    expect(() => partPath(etag, 0)).toThrow();
  });
  it.each([[-1], [1.5], [Number.NaN]])('refuses %j as a part index', (i) => {
    expect(() => partPath(E64, i)).toThrow();
  });
});

describe('manifest text', () => {
  it('is canonical: files sorted by path, the same text whatever order they were given in', () => {
    const reversed = { ...base, files: [...base.files].reverse() };
    expect(serializeManifest(reversed)).toBe(serializeManifest(base));
    expect(serializeManifest(base).endsWith('\n')).toBe(true);
    expect((JSON.parse(serializeManifest(base)) as TransferManifest).files.map((f) => f.path)).toEqual(['config.json', 'model.gguf']);
  });
  it('round-trips through its name', () => {
    const { text, name } = named(base);
    expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
    const r = parseManifest(text, name);
    expect(r).toEqual({ ok: true, manifest: { ...base, files: [...base.files].reverse() } });
  });
  it('accepts the -<n> names a writer falls back to', () => {
    const { text } = named(base);
    expect(parseManifest(text, manifestName(text, 3)).ok).toBe(true);
    expect(manifestName(text, 3)).toMatch(/^[0-9a-f]{64}-3\.json$/);
  });
  it('refuses a truncated or edited manifest, and a name that is not a hash', () => {
    const { text, name } = named(base);
    expect(parseManifest(text.slice(0, -5), name)).toEqual({ ok: false, error: expect.stringContaining('does not match its name') });
    expect(parseManifest(text.replace('org/name', 'org/nome'), name).ok).toBe(false);
    expect(parseManifest(text, 'manifest.json')).toEqual({ ok: false, error: 'not a manifest name' });
    expect(parseManifest(text, `${name.slice(0, 64)}-0.json`).ok).toBe(false);
  });
  it('refuses text that is not JSON even under its own hash', () => {
    const text = 'not json';
    expect(parseManifest(text, manifestName(text))).toEqual({ ok: false, error: 'the manifest is not valid JSON' });
  });
  it.each<[string, (o: Record<string, unknown>) => void]>([
    ['another version', (o) => { o.version = 2; }],
    ['an unknown field', (o) => { o.extra = 1; }],
    ['a repo id with a path in it', (o) => { o.repoId = '../../etc'; }],
    ['a repo id of three parts', (o) => { o.repoId = 'a/b/c'; }],
    ['an unknown type', (o) => { o.type = 'kernel'; }],
    ['a short commit', (o) => { o.commit = 'abc'; }],
    ['a ref that climbs out', (o) => { o.ref = '../main'; }],
    ['a ref that is a commit', (o) => { o.ref = C; }],
    ['a negative time', (o) => { o.exportedAt = -1; }],
    ['no files', (o) => { o.files = []; }],
    ['files that are not a list', (o) => { o.files = {}; }],
    ['a path that climbs out', (o) => { (o.files as Array<Record<string, unknown>>)[0]!.path = '../x'; }],
    ['an absolute path', (o) => { (o.files as Array<Record<string, unknown>>)[0]!.path = '/etc/passwd'; }],
    ['a backslash path', (o) => { (o.files as Array<Record<string, unknown>>)[0]!.path = 'a\\b'; }],
    ['an etag that is not hex', (o) => { (o.files as Array<Record<string, unknown>>)[0]!.etag = '../../x'; }],
    ['an lfs flag that contradicts the etag', (o) => { (o.files as Array<Record<string, unknown>>)[0]!.lfs = true; }],
    ['a fractional size', (o) => { (o.files as Array<Record<string, unknown>>)[0]!.size = 1.5; }],
    ['a zero part size', (o) => { (o.files as Array<Record<string, unknown>>)[0]!.partSize = 0; }],
    ['a part size over the FAT32 limit', (o) => { (o.files as Array<Record<string, unknown>>)[0]!.partSize = MAX_PART_SIZE + 1; }],
    ['an unknown file field', (o) => { (o.files as Array<Record<string, unknown>>)[0]!.mode = 7; }],
    ['a file that is not an object', (o) => { (o.files as unknown[])[0] = 'x'; }],
    ['the same path twice', (o) => { const f = o.files as Array<Record<string, unknown>>; f[1]!.path = f[0]!.path; }],
    ['one etag with two sizes', (o) => { const f = o.files as Array<Record<string, unknown>>; f.push({ ...f[0]!, path: 'other', size: 99 }); }],
  ])('refuses %s', (_what, change) => {
    const { text, name } = edited(change);
    expect(parseManifest(text, name).ok).toBe(false);
  });
  it('accepts a null ref and two paths sharing one object', () => {
    const { text, name } = edited((o) => {
      o.ref = null;
      const f = o.files as Array<Record<string, unknown>>;
      f.push({ ...f[0]!, path: 'copy/of/it' });
    });
    const r = parseManifest(text, name);
    expect(r.ok && r.manifest.ref).toBe(null);
    expect(r.ok && r.manifest.files).toHaveLength(3);
  });
});

describe('mergeManifests', () => {
  const quantB = { path: 'b.gguf', size: 7, etag: 'd'.repeat(64), lfs: true, partSize: 4 };
  it('unions the exports of one repo commit and keeps other commits and repos apart', () => {
    const second: TransferManifest = { ...base, exportedAt: 2000, ref: null, files: [quantB, base.files[1]!] };
    const other: TransferManifest = { ...base, repoId: 'org/other', exportedAt: 5 };
    const older: TransferManifest = { ...base, commit: 'e'.repeat(40), ref: null };
    const { repos, conflicts } = mergeManifests([second, other, base, older]);
    expect(conflicts).toEqual([]);
    expect(repos.map(repoKey)).toEqual([`model:org/name@${C}`, `model:org/name@${'e'.repeat(40)}`, `model:org/other@${C}`]);
    expect(repos[0]!.files.map((f) => f.path)).toEqual(['b.gguf', 'config.json', 'model.gguf']);
    expect(repos[0]!.exportedAt).toBe(2000);
    expect(repos[0]!.ref).toBe('main');   // a later export without a ref does not take the ref away
    expect(repos[1]!.ref).toBe(null);
  });
  it('gives the same result whatever order the manifests were read in', () => {
    const second: TransferManifest = { ...base, exportedAt: 2000, files: [quantB] };
    expect(mergeManifests([base, second])).toEqual(mergeManifests([second, base]));
  });
  it('leaves out, whole, a later export that names another file under a path already merged', () => {
    const clash: TransferManifest = { ...base, exportedAt: 3000, files: [{ ...base.files[0]!, etag: 'f'.repeat(64) }, quantB] };
    const { repos, conflicts } = mergeManifests([clash, base]);
    expect(conflicts).toEqual([`model:org/name@${C}`]);
    expect(repos[0]!.files.map((f) => f.path)).toEqual(['config.json', 'model.gguf']);
  });
  it('leaves out a later export that gives a merged object another size or part size', () => {
    const size: TransferManifest = { ...base, exportedAt: 3000, files: [{ ...base.files[0]!, path: 'x', size: 11 }] };
    const part: TransferManifest = { ...base, exportedAt: 3000, files: [{ ...base.files[0]!, path: 'x', partSize: 8 }] };
    expect(mergeManifests([base, size]).conflicts).toHaveLength(1);
    expect(mergeManifests([base, part]).conflicts).toHaveLength(1);
  });
  it('a model and a dataset of the same name are two repos', () => {
    const { repos } = mergeManifests([base, { ...base, type: 'dataset' }]);
    expect(repos.map((r) => r.type)).toEqual(['dataset', 'model']);
  });
});

describe('toRawListing', () => {
  it('passes the download safety gate with every file verified', () => {
    const { repos } = mergeManifests([base]);
    const listing = toRemoteListing(toRawListing(repos[0]!));
    expect(listing.commit).toBe(C);
    expect(listing.refused).toEqual([]);
    expect(listing.unverifiable).toEqual([]);
    expect(listing.files).toEqual([
      { path: 'config.json', size: 3, etag: E40, lfs: false },
      { path: 'model.gguf', size: 10, etag: E64, lfs: true },
    ]);
  });
});
