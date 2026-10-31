import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  DELETION_ID_RE, HOLD_MANIFEST_VERSION, createHoldHooks, executeHold, finalizeHold, MANIFEST_NAME, MAX_MANIFEST_BYTES, heldPathOfHoldDest, manifestFromPlan, manifestPath,
  parseManifest, serializeManifest, type HoldManifest,
} from '../../../src/core/hold/manifest';
import { MAX_HELD_VIEW_FILE_BYTES, MAX_HELD_VIEW_TOTAL_BYTES } from '../../../src/core/hold/view-limits';
import { factsOf, type ReadFs } from '../../../src/core/fsx';
import { fingerprintPlan } from '../../../src/core/plan/fingerprint';
import { planDeletion } from '../../../src/core/plan/planner';
import type { DeletionPlan, ExecHooks, FileFacts, Op } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { treeDigest } from '../../helpers/tree-digest';
import { buildHoldScenario, HEX, q8Iq2MmprojSelection } from './scenario';

useCanaries();
beforeEach(() => expect.hasAssertions());

const H = '/x/hold';
const ID = '2026-10-25T14-03-07-000Z-0a1b2c3d';
const HUB = '/x/hub';
const HASH = '1'.repeat(64);
const facts = (over: Partial<FileFacts> = {}): FileFacts =>
  ({ dev: 1, ino: 2, size: 3, mtimeMs: 4, nlink: 1, isSymlink: true, isDirectory: false, isFile: false, linkTarget: '../../blobs/e', ...over });

function sampleManifest(holdRoot: string, id: string): HoldManifest {
  const d = join(holdRoot, id);
  const store = `${HUB}/blobs/11/${HASH}`;
  return {
    version: 1, deletionId: id, planId: 'p1', createdAt: 1700000000000, hubRoot: HUB,
    repos: [{ repoId: 'o/n', whole: false, groups: [{ key: 'q4', label: 'Q4' }] }],
    items: [{
      originalPath: `${HUB}/models--o--n/snapshots/c/a.gguf`, heldPath: join(d, 'models--o--n/snapshots/c/a.gguf'),
      role: 'snapshot-link', facts: facts(), linkTarget: '../../blobs/e', done: true,
    }],
    storeItems: [{
      originalPath: store, heldPath: null, refsRemoved: [`models--o--n/blobs/${HASH}`], refsPath: store + '.refs',
      facts: facts({ isSymlink: false, isFile: true, linkTarget: undefined }), size: 3, done: true,
    }],
    viewEntriesRemoved: [{ view: 'lmstudio', path: 'o/n/a.gguf', linkTarget: '/x/hub/blobs/e', done: true }],
    bytesHeld: 3, bytesFreedWhenEmptied: 3, status: 'held',
  };
}

type J = Record<string, unknown>;
const base = (): J => JSON.parse(serializeManifest(sampleManifest(H, ID))) as J;
const patch = (o: J): string => JSON.stringify({ ...base(), ...o });
const nested = (key: string, o: J): string => {
  const b = base();
  b[key] = [{ ...(b[key] as J[])[0], ...o }];
  return JSON.stringify(b);
};
const patchItem = (o: J): string => nested('items', o);
const patchStore = (o: J): string => nested('storeItems', o);
const patchView = (o: J): string => nested('viewEntriesRemoved', o);
const patchRepo = (o: J): string => nested('repos', o);
const dup = (key: 'items' | 'storeItems', o: J): string => {
  const b = base();
  const e = (b[key] as J[])[0]!;
  b[key] = [e, { ...e, ...o }];
  return JSON.stringify(b);
};
const D = join(H, ID);
const folderItem = (): J => ({ originalPath: `${HUB}/models--o--n`, heldPath: join(D, 'models--o--n'), role: 'repo-folder',
  facts: facts({ isSymlink: false, isDirectory: true }), tree: [], done: false });
function overlap(childFirst = false, kind: 'link' | 'blob' = 'link'): string {
  const b = base();
  const child = kind === 'blob'
    ? { ...folderItem(), tree: undefined, originalPath: `${HUB}/models--o--n/blobs/e`, heldPath: join(D, 'models--o--n/blobs/e'), role: 'repo-blob' }
    : (b.items as J[])[0]!;
  if (childFirst) b.items = [folderItem(), child];
  else b.items = [folderItem(), child];
  return JSON.stringify(b);
}
const folder = `${HUB}/models--o--n`;
const itemAt = (originalPath: string, role: string, heldRel: string): string =>
  patchItem({ originalPath, role, heldPath: join(D, heldRel) });
const storeAt = (hash: string, held: string | null): string =>
  patchStore({ originalPath: `${HUB}/blobs/${hash.slice(0, 2)}/${hash}`, refsPath: `${HUB}/blobs/${hash.slice(0, 2)}/${hash}.refs`, heldPath: held });

const parse = (text: string) => parseManifest(text, { holdRoot: H, deletionId: ID });

describe('constants and helpers', () => {
  test('constants', () => {
    expect(HOLD_MANIFEST_VERSION).toBe(1);
    expect(MANIFEST_NAME).toBe('manifest.json');
    expect(MAX_MANIFEST_BYTES).toBe(16 * 1024 * 1024);
    expect(manifestPath(H, ID)).toBe(join(H, ID, 'manifest.json'));
  });
  test('heldPathOfHoldDest joins the holdRoot-relative POSIX destination', () => {
    expect(heldPathOfHoldDest(H, `${ID}/store/11/${HASH}`)).toBe(join(H, ID, 'store', '11', HASH));
  });
  test('DELETION_ID_RE rejects path-like names', () => {
    for (const bad of ['.', '..', 'a/b-0a1b2c3d', '-0a1b2c3d', '2026-10-25T14-03-07-000Z-0A1B2C3D', '2026-10-25T14-03-07-000Z-0a1b2c3',
      'x-0a1b2c3d', '2026-10-25T14:03:07.000Z-0a1b2c3d', '2026-10-25T14-03-07-000Z-0a1b2c3d\n'])
      expect(DELETION_ID_RE.test(bad)).toBe(false);
    expect(DELETION_ID_RE.test(ID)).toBe(true);
  });
});

describe('serialize and parse', () => {
  test('round-trips, ending in a newline', () => {
    const m = sampleManifest(H, ID);
    expect(parse(serializeManifest(m))).toEqual({ ok: true, manifest: m });
    expect(serializeManifest(m).endsWith('}\n')).toBe(true);
  });
  test('accepts every role in its layout, a kept-in-hub and a held store item, and optional view fields', () => {
    const b = base();
    const hashB = 'ab'.repeat(32);
    b.items = [
      { ...(b.items as J[])[0] },
      { originalPath: `${HUB}/models--p--q`, heldPath: join(D, 'models--p--q'), role: 'repo-folder', facts: facts({ isSymlink: false, isDirectory: true }),
        tree: [{ rel: 'blobs', facts: facts({ isSymlink: false, isDirectory: true }) }, { rel: 'blobs/e', facts: facts() }], done: false },
      { originalPath: `${folder}/blobs/${HASH}`, heldPath: join(D, 'models--o--n/blobs', HASH), role: 'repo-blob', facts: facts(), done: false },
    ];
    b.storeItems = [
      { ...(b.storeItems as J[])[0] },
      { originalPath: `${HUB}/blobs/ab/${hashB}`, heldPath: join(D, 'store', 'ab', hashB), refsRemoved: [], refsPath: `${HUB}/blobs/ab/${hashB}.refs`,
        facts: facts(), size: 0, done: false },
    ];
    b.viewEntriesRemoved = [{ view: 'ollama', path: 'm/tag', manifestText: '{}', done: false }];
    const r = parse(JSON.stringify(b));
    expect(r.ok).toBe(true);
    expect(r).toEqual({ ok: true, manifest: b });
  });
  test('rejects a deletionId that is not a deletion id even when the file agrees', () => {
    const r = parseManifest(patch({ deletionId: 'x-0a1b2c3d' }), { holdRoot: H, deletionId: 'x-0a1b2c3d' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/deletionId/) as string });
  });
  test('rejects a non-absolute holdRoot', () => {
    expect(parseManifest(serializeManifest(sampleManifest(H, ID)), { holdRoot: 'hold', deletionId: ID }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/holdRoot/) as string });
  });
});

const treeItem = (tree: unknown, over: J = {}): string => {
  const b = base();
  b.items = [{ ...folderItem(), ...(tree === undefined ? { tree: undefined } : { tree }), ...over }];
  return JSON.stringify(b);
};
const te = (rel: unknown, f: unknown = facts()): J => ({ rel, facts: f });
const treeRows: Array<[string, string, RegExp]> = [
  ['a repo-folder without a tree', treeItem(undefined), /items\[0\]\.tree: .*required/],
  ['a tree on a snapshot-link', patchItem({ tree: [] }), /items\[0\]\.tree: .*only/],
  ['a tree that is not an array', treeItem('x'), /items\[0\]\.tree: must be an array/],
  ['a tree entry that is not an object', treeItem([5]), /tree\[0\]: must be an object/],
  ['a tree entry with an unknown field', treeItem([{ ...te('a'), extra: 1 }]), /tree\[0\]: unknown field/],
  ['a tree rel that is not a string', treeItem([te(5)]), /tree\[0\]\.rel: must be a string/],
  ['an absolute tree rel', treeItem([te('/a')]), /tree\[0\]\.rel: must be a relative POSIX path/],
  ['a backslash tree rel', treeItem([te('a\\b')]), /tree\[0\]\.rel/],
  ['a NUL tree rel', treeItem([te('a\0b')]), /tree\[0\]\.rel/],
  ['an empty tree rel', treeItem([te('')]), /tree\[0\]\.rel/],
  ['a dot-dot tree rel', treeItem([te('a/../b')]), /tree\[0\]\.rel: must not contain/],
  ['a dot tree rel', treeItem([te('./a')]), /tree\[0\]\.rel: must not contain/],
  ['a trailing-slash tree rel', treeItem([te('a/')]), /tree\[0\]\.rel: must not contain/],
  ['a duplicate tree rel', treeItem([te('a'), te('a')]), /tree\[1\]\.rel: duplicate/],
  ['bad tree facts', treeItem([te('a', { size: 1 })]), /tree\[0\]\.facts: is not valid file facts/],
];
test.each(treeRows)('parseManifest rejects %s', (_n, text, re) => {
  const r = parse(text);
  expect(r.ok).toBe(false);
  expect((r as { error: string }).error).toMatch(re);
});
test('parseManifest round-trips a repo-folder tree in order', () => {
  const tree = [te('blobs'), te('blobs/e'), te('snapshots')];
  const r = parse(treeItem(tree));
  expect(r).toMatchObject({ ok: true });
  expect((r as { manifest: HoldManifest }).manifest.items[0]!.tree).toEqual(tree);
});

const BAD_PATH = ['relative', 'x/../y', '/x//y', '/x/y/', ''];
const HASH2 = '2'.repeat(64);
const rows: Array<[string, string, RegExp]> = [
  ['not json', '{', /JSON/],
  ['wrong version', patch({ version: 2 }), /version/],
  ['id mismatch', patch({ deletionId: '2026-10-25T14-03-07-000Z-ffffffff' }), /deletionId/],
  ['relative hubRoot', patch({ hubRoot: 'hub' }), /hubRoot/],
  ['non-string hubRoot', patch({ hubRoot: 5 }), /hubRoot/],
  ['heldPath outside its folder', patchItem({ heldPath: join(H, 'other-0a1b2c3d', 'a') }), /heldPath/],
  ['heldPath not at the layout place', patchItem({ heldPath: join(D, 'elsewhere') }), /heldPath/],
  ['heldPath is the folder itself', patchItem({ heldPath: D }), /heldPath/],
  ['originalPath outside hub', patchItem({ originalPath: '/etc/passwd' }), /originalPath/],
  ['originalPath is the hub', patchItem({ originalPath: HUB }), /originalPath/],
  ['refsPath not payload+.refs', patchStore({ refsPath: '/x/hub/blobs/aa/zz.refs' }), /refsPath/],
  ['absolute ref line', patchStore({ refsRemoved: ['/models--o--n/blobs/' + '1'.repeat(64)] }), /refsRemoved/],
  ['dotdot ref line', patchStore({ refsRemoved: ['../models--o--n/blobs/x'] }), /refsRemoved/],
  ['dotdot blob name ref line', patchStore({ refsRemoved: ['models--o--n/blobs/..'] }), /refsRemoved/],
  ['dot blob name ref line', patchStore({ refsRemoved: ['models--o--n/blobs/.'] }), /refsRemoved/],
  ['newline in ref line', patchStore({ refsRemoved: ['models--o--n/blobs/a\nmodels--o--n/blobs/b'] }), /refsRemoved/],
  ['trailing newline in ref line', patchStore({ refsRemoved: [`models--o--n/blobs/${HASH}\n`] }), /refsRemoved/],
  ['CR in ref line', patchStore({ refsRemoved: ['models--o--n/blobs/a\rb'] }), /refsRemoved/],
  ['NUL in ref line', patchStore({ refsRemoved: ['models--o--n/blobs/a\0b'] }), /refsRemoved/],
  ['non-string ref line', patchStore({ refsRemoved: [1] }), /refsRemoved/],
  ['refsRemoved not an array', patchStore({ refsRemoved: 'x' }), /refsRemoved/],
  ['unknown role', patchItem({ role: 'everything' }), /role/],
  ['store role on an item', patchItem({ role: 'store-payload' }), /role/],
  ['view-link role on an item', patchItem({ role: 'view-link' }), /role/],
  ['non-string role', patchItem({ role: 7 }), /role/],
  ['unknown status', patch({ status: 'done' }), /status/],
  ['negative bytes', patch({ bytesHeld: -1 }), /bytesHeld/],
  ['fractional bytes', patch({ bytesFreedWhenEmptied: 1.5 }), /bytesFreedWhenEmptied/],
  ['string bytes', patch({ bytesHeld: '3' }), /bytesHeld/],
  ['negative createdAt', patch({ createdAt: -1 }), /createdAt/],
  ['fractional createdAt', patch({ createdAt: 1.5 }), /createdAt/],
  ['non-string planId', patch({ planId: 1 }), /planId/],
  ['extra field', patch({ surprise: 1 }), /unknown field/],
  ['extra field in item', patchItem({ surprise: 1 }), /unknown field/],
  ['extra field in store item', patchStore({ surprise: 1 }), /unknown field/],
  ['extra field in view entry', patchView({ surprise: 1 }), /unknown field/],
  ['extra field in repo', patchRepo({ surprise: 1 }), /unknown field/],
  ['manifest not an object', '[]', /manifest/],
  ['null manifest', 'null', /manifest/],
  ['item not an object', patch({ items: [null] }), /items/],
  ['items not an array', patch({ items: {} }), /items/],
  // Roles must match the executor's shape
  ['repo-folder with a deep path', itemAt(`${folder}/blobs`, 'repo-folder', 'models--o--n/blobs'), /originalPath/],
  ['repo-folder not a repo folder name', itemAt(`${HUB}/notarepo`, 'repo-folder', 'notarepo'), /originalPath/],
  ['repo-folder named like a repo but bare', itemAt(`${HUB}/models--`, 'repo-folder', 'models--'), /originalPath/],
  ['repo-blob not in blobs/', itemAt(`${folder}/refs/main`, 'repo-blob', 'models--o--n/refs/main'), /originalPath/],
  ['repo-blob too deep', itemAt(`${folder}/blobs/a/b`, 'repo-blob', 'models--o--n/blobs/a/b'), /originalPath/],
  ['snapshot-link outside snapshots', itemAt(`${folder}/refs/main/x`, 'snapshot-link', 'models--o--n/refs/main/x'), /originalPath/],
  ['snapshot-link too shallow', itemAt(`${folder}/snapshots/c`, 'snapshot-link', 'models--o--n/snapshots/c'), /originalPath/],
  ['snapshot-link a refs file as repo-folder role', itemAt(`${folder}/refs/main`, 'repo-folder', 'models--o--n/refs/main'), /originalPath/],
  // Store item shape
  ['store payload not under blobs/', patchStore({ originalPath: `${HUB}/other/11/${HASH}`, refsPath: `${HUB}/other/11/${HASH}.refs` }), /originalPath/],
  ['store payload wrong shard', patchStore({ originalPath: `${HUB}/blobs/22/${HASH}`, refsPath: `${HUB}/blobs/22/${HASH}.refs` }), /originalPath/],
  ['store payload non-hex hash', storeAt('zz'.repeat(32), null), /originalPath/],
  ['store payload short hash', patchStore({ originalPath: `${HUB}/blobs/11/111`, refsPath: `${HUB}/blobs/11/111.refs` }), /originalPath/],
  ['store payload outside hub', patchStore({ originalPath: `/etc/blobs/11/${HASH}`, refsPath: `/etc/blobs/11/${HASH}.refs` }), /originalPath/],
  ['store heldPath wrong place', patchStore({ heldPath: join(D, 'store', '11', 'x') }), /heldPath/],
  ['store heldPath outside D', patchStore({ heldPath: join(H, 'other', 'store', '11', HASH) }), /heldPath/],
  ['store heldPath not a string', patchStore({ heldPath: 5 }), /heldPath/],
  // Duplicates
  ['duplicate item originalPath', dup('items', {}), /duplicate/],
  ['duplicate item heldPath', dup('items', { originalPath: `${HUB}/models--o--n/snapshots/c/b` }), /heldPath/],
  ['duplicate store originalPath', dup('storeItems', {}), /duplicate/],
  ['duplicate store heldPath', (() => {
    const b = base();
    const s = (b.storeItems as J[])[0]!;
    const held = join(D, 'store', '11', HASH);
    b.storeItems = [{ ...s, heldPath: held }, { ...s, heldPath: held, originalPath: `${HUB}/blobs/11/${HASH}`, refsPath: `${HUB}/blobs/11/${HASH}.refs` }];
    return JSON.stringify(b);
  })(), /duplicate/],
  ['item and store item sharing a path', (() => {
    const b = base();
    const s = (b.storeItems as J[])[0]!;
    b.storeItems = [{ ...s, originalPath: `${HUB}/blobs/22/${HASH2}`, refsPath: `${HUB}/blobs/22/${HASH2}.refs`, heldPath: join(D, 'store', '22', HASH2) },
      { ...s, originalPath: `${HUB}/blobs/22/${HASH2}`, refsPath: `${HUB}/blobs/22/${HASH2}.refs`, heldPath: null }];
    return JSON.stringify(b);
  })(), /duplicate/],
  // overlapping entries
  ['repo-folder plus a child snapshot-link', overlap(), /items\[1\]\.originalPath/],
  ['child listed before its folder', overlap(true), /items\[1\]\.originalPath/],
  ['repo-folder plus a child repo-blob', overlap(false, 'blob'), /items\[1\]\.originalPath/],
  // Facts and numbers
  ['facts missing', patchItem({ facts: undefined }), /facts/],
  ['facts null', patchItem({ facts: null }), /facts/],
  ['facts with a string number', patchItem({ facts: { ...facts(), size: '3' } }), /facts/],
  ['facts with a null number (JSON NaN)', patchItem({ facts: { ...facts(), ino: null } }), /facts/],
  ['facts with a non-boolean flag', patchItem({ facts: { ...facts(), isFile: 1 } }), /facts/],
  ['facts with a non-string linkTarget', patchItem({ facts: { ...facts(), linkTarget: 5 } }), /facts/],
  ['store facts invalid', patchStore({ facts: [] }), /facts/],
  ['item done not boolean', patchItem({ done: 'yes' }), /done/],
  ['store done not boolean', patchStore({ done: 1 }), /done/],
  ['view done not boolean', patchView({ done: null }), /done/],
  ['store size negative', patchStore({ size: -1 }), /size/],
  ['store size fractional', patchStore({ size: 0.5 }), /size/],
  ['item linkTarget not a string', patchItem({ linkTarget: 1 }), /linkTarget/],
  ['repos groups entry bad', patchRepo({ groups: [{ key: 'a', label: 1 }] }), /label/],
  ['repos groups key bad', patchRepo({ groups: [{ key: 1, label: 'a' }] }), /key/],
  ['repos groups extra field', patchRepo({ groups: [{ key: 'a', label: 'b', z: 1 }] }), /unknown field/],
  ['repos groups not an array', patchRepo({ groups: 'a' }), /groups/],
  ['repos whole not boolean', patchRepo({ whole: 'x' }), /whole/],
  ['repos repoId not a string', patchRepo({ repoId: 1 }), /repoId/],
  // view entries
  ['unknown view', patchView({ view: 'plex' }), /view/],
  ['non-string view', patchView({ view: 1 }), /view/],
  ['absolute view path', patchView({ path: '/etc/passwd' }), /path/],
  ['dotdot view path', patchView({ path: 'a/../../b' }), /path/],
  ['empty segment view path', patchView({ path: 'a//b' }), /path/],
  ['dot segment view path', patchView({ path: './a' }), /path/],
  ['backslash view path', patchView({ path: 'a\\b' }), /path/],
  ['NUL view path', patchView({ path: 'a\0b' }), /path/],
  ['empty view path', patchView({ path: '' }), /path/],
  ['view linkTarget not a string', patchView({ linkTarget: 1 }), /linkTarget/],
  ['view manifestText not a string', patchView({ manifestText: 1 }), /manifestText/],
  ['view contentBase64 not a string', patchView({ contentBase64: 1 }), /contentBase64: must be a string/],
  ['view contentBase64 not base64', patchView({ contentBase64: 'not base64!' }), /contentBase64: must be valid base64/],
  ['view contentBase64 not canonical', patchView({ contentBase64: 'QQ' }), /contentBase64: must be valid base64/],
  ['view contentBase64 over 1 MiB', patchView({ contentBase64: Buffer.alloc(1048577, 1).toString('base64') }), /contentBase64: .*1 MiB/],
];
test.each(rows)('parseManifest rejects %s', (_n, text, re) => {
  const r = parse(text);
  expect(r.ok).toBe(false);
  expect((r as { error: string }).error).toMatch(re);
});

const PATH_FIELDS: Array<[string, (p: string) => string, RegExp]> = [
  ['item originalPath', (p) => patchItem({ originalPath: p }), /^items\[0\]\.originalPath: must be a normalised absolute path/],
  ['item heldPath', (p) => patchItem({ heldPath: p }), /^items\[0\]\.heldPath: must be a normalised absolute path/],
  ['store refsPath', (p) => patchStore({ refsPath: p }), /^storeItems\[0\]\.refsPath: must be a normalised absolute path/],
  ['store heldPath', (p) => patchStore({ heldPath: p }), /^storeItems\[0\]\.heldPath: must be a normalised absolute path/],
  ['store originalPath', (p) => patchStore({ originalPath: p }), /^storeItems\[0\]\.originalPath: must be a normalised absolute path/],
];
describe.each(PATH_FIELDS)('non-normalised path in %s', (_n, mk, re) => {
  test.each(BAD_PATH.map((p) => [p]))('rejects %j', (p) => {
    const r = parse(mk(p));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(re);
  });
});

test('parseManifest rejects a NUL byte in a path', () => {
  expect(parse(patchItem({ originalPath: `${HUB}/models--o--n/snapshots/c/a\0` }))).toMatchObject({ ok: false });
});

const forge = (plan: DeletionPlan, edit: (p: DeletionPlan) => void): DeletionPlan => {
  const p = structuredClone(plan);
  edit(p);
  return p;
};

describe('manifestFromPlan', () => {
  test('records items, store items, view entries and bytes from a hold plan', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const man = await manifestFromPlan(plan, { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 1_000 });
    const dir = join(s.roots.holdRoot!, plan.deletionId!);
    expect(man).toMatchObject({ version: 1, deletionId: plan.deletionId, planId: plan.id, createdAt: 1_000,
      hubRoot: s.hub, status: 'moving', bytesFreedWhenEmptied: 2000, bytesHeld: plan.apparentBytes });
    expect(man.repos).toEqual([{ repoId: 'org/gguf', whole: false, groups: expect.arrayContaining([
      expect.objectContaining({ key: expect.stringMatching(/^mmproj:/) as string })]) as unknown[] }]);
    expect(man.repos[0]!.groups).toHaveLength(3);
    expect(man.items.map((i) => i.role).sort()).toEqual(['repo-blob', 'repo-blob', 'repo-blob', 'snapshot-link', 'snapshot-link', 'snapshot-link']);
    for (const i of man.items) {
      expect(i.done).toBe(false);
      expect(i.heldPath.startsWith(dir + sep)).toBe(true);
      expect(i.tree).toBeUndefined();
    }
    const link = man.items.find((i) => i.originalPath.endsWith('m-Q8_0.gguf'))!;
    expect(link).toMatchObject({ role: 'snapshot-link', linkTarget: `../../blobs/${HEX.B}`, facts: { isSymlink: true } });
    const s1 = man.storeItems.find((x) => x.originalPath.endsWith(HEX.S1))!;
    expect(s1).toMatchObject({ heldPath: join(dir, 'store', 'aa', HEX.S1), size: 2000,
      refsRemoved: [`models--org--gguf/blobs/${HEX.B}`], refsPath: s1.originalPath + '.refs' });
    const s2 = man.storeItems.find((x) => x.originalPath.endsWith(HEX.S2))!;
    expect(s2).toMatchObject({ heldPath: null, refsRemoved: [`models--org--gguf/blobs/${HEX.D}`] });
    expect(man.viewEntriesRemoved).toEqual([
      { view: 'lmstudio', path: 'org/gguf/m-Q8_0.gguf', linkTarget: join(s.hub, 'models--org--gguf', 'blobs', HEX.B), done: false },
      { view: 'ollama', path: 'manifests/hf.co/org/gguf/Q8_0', manifestText: `{"layers":[{"digest":"sha256:${HEX.B}"}]}`, done: false },
    ]);
    expect(parseManifest(serializeManifest(man), { holdRoot: s.roots.holdRoot!, deletionId: man.deletionId }).ok).toBe(true);
  });

  test('records the lstat tree of a whole repo folder and the result parses', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan({ repos: [{ repoId: 'org/other', whole: true }] });
    const man = await manifestFromPlan(plan, { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 5 });
    expect(man.repos).toEqual([expect.objectContaining({ repoId: 'org/other', whole: true })]);
    expect(man.repos[0]!.groups.length).toBeGreaterThan(0);
    const folder = join(s.hub, 'models--org--other');
    const item = man.items.find((i) => i.role === 'repo-folder')!;
    expect(item.originalPath).toBe(folder);
    const rels = item.tree!.map((t) => t.rel);
    expect(rels).toEqual([...rels].sort());
    expect(rels).toEqual(expect.arrayContaining(['refs', 'refs/main', 'blobs', `blobs/${HEX.C}`, `blobs/${HEX.D}`, 'snapshots',
      `snapshots/${HEX.c2}`, `snapshots/${HEX.c2}/x-IQ2_XS.gguf`, `snapshots/${HEX.c2}/mmproj-F16.gguf`]));
    for (const t of item.tree!) expect(t.facts).toEqual(await factsOf(s.fs, join(folder, ...t.rel.split('/'))));
    const c = item.tree!.find((t) => t.rel === `blobs/${HEX.C}`)!;
    expect(c.facts).toMatchObject({ isFile: true, nlink: 2, size: 500 });
    const d = item.tree!.find((t) => t.rel === `blobs/${HEX.D}`)!;
    expect(d.facts).toMatchObject({ isSymlink: true, linkTarget: `../../blobs/bb/${HEX.S2}` });
    expect(parseManifest(serializeManifest(man), { holdRoot: s.roots.holdRoot!, deletionId: man.deletionId }).ok).toBe(true);
  });

  test('fs defaults to the read-only node fs', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan({ repos: [{ repoId: 'org/other', whole: true }] });
    const withFs = await manifestFromPlan(plan, { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 2 });
    expect(await manifestFromPlan(plan, { model: m, viewRoots: s.viewRoots, now: 2 })).toEqual(withFs);
  });

  test('refuses a folder entry that vanishes during the walk and a rename of an unexpected role', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan({ repos: [{ repoId: 'org/other', whole: true }] });
    const gone = join(s.hub, 'models--org--other', 'refs', 'main');
    const racing = Object.assign(Object.create(s.fs) as typeof s.fs, {
      lstat: async (p: string) => {
        if (p === gone) throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
        return s.fs.lstat(p);
      },
    });
    await expect(manifestFromPlan(plan, { model: m, viewRoots: s.viewRoots, fs: racing, now: 1 })).rejects.toThrow(/vanished/);
    const odd = forge(plan, (p) => { (p.ops.find((o) => o.kind === 'hold-rename') as { role: string }).role = 'held-item'; });
    await expect(manifestFromPlan(odd, { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 1 })).rejects.toThrow('hold plan renames a held-item');
  });

  test('rejects a permanent plan, a restore plan and a plan without a deletion id', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const sel = q8Iq2MmprojSelection(s, m);
    const pair = await planDeletion({ model: m, selection: sel, roots: s.roots, views: s.views, now: s.now });
    const ctx = { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 1 };
    await expect(manifestFromPlan(pair.permanent, ctx)).rejects.toThrow(/hold plan/);
    await expect(manifestFromPlan(forge(pair.hold!, (p) => { p.purpose = 'restore'; }), ctx)).rejects.toThrow(/hold plan/);
    await expect(manifestFromPlan(forge(pair.hold!, (p) => { p.deletionId = null; }), ctx)).rejects.toThrow(/hold plan/);
    await expect(manifestFromPlan(forge(pair.hold!, (p) => { p.holdRoot = null; }), ctx)).rejects.toThrow(/hold plan/);
  });

  test('rejects a store-sweep that would delete the payload', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = forge(await s.holdPlan(q8Iq2MmprojSelection(s, m)), (p) => {
      const sweep = p.ops.find((o): o is Extract<Op, { kind: 'store-sweep' }> => o.kind === 'store-sweep' && o.payload === 'hold')!;
      sweep.payload = 'delete';
    });
    await expect(manifestFromPlan(plan, { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 1 })).rejects.toThrow('hold plan contains a store-sweep with payload delete');
  });

  test('rejects a selection naming an unknown repo or group', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const ctx = { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 1 };
    await expect(manifestFromPlan(forge(plan, (p) => { p.selection!.repos[0]!.repoId = 'no/such'; }), ctx)).rejects.toThrow(/unknown repo no\/such/);
    await expect(manifestFromPlan(forge(plan, (p) => {
      (p.selection!.repos[0] as { groupKeys: string[] }).groupKeys = ['quant:Nope'];
    }), ctx)).rejects.toThrow(/unknown group quant:Nope/);
    await expect(manifestFromPlan(forge(plan, (p) => { p.selection = null; }), ctx)).rejects.toThrow(/selection/);
  });

  test('view ops: a regular file that is not a manifest is refused, overlapping view roots are refused, other ops are ignored', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const ctx = { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 1 };
    const manifestFile = join(s.ollama, 'manifests', 'hf.co', 'org', 'gguf', 'Q8_0');
    const regular = await factsOf(s.fs, manifestFile);
    const withBlob = (role: 'view-blob' | 'view-link'): DeletionPlan => forge(plan, (p) => {
      p.ops.push({ kind: 'unlink', path: manifestFile, expect: regular!, role });
    });
    await expect(manifestFromPlan(withBlob('view-link'), ctx)).rejects.toThrow(
      `Cannot move to Recently Deleted: ${manifestFile} is a regular file in the ollama folder, not a link \u2014 use Delete Permanently.`);
    // a regular view-blob over 1 MiB is refused the same way (its bytes are never read)
    await expect(manifestFromPlan(forge(plan, (p) => {
      p.ops.push({ kind: 'unlink', path: manifestFile, expect: { ...regular!, size: 1048577 }, role: 'view-blob' });
    }), ctx)).rejects.toThrow(/Cannot move to Recently Deleted: .* is a regular file in the ollama folder/);
    // up to 1 MiB it is recorded
    const kept = await manifestFromPlan(withBlob('view-blob'), ctx);
    const last = kept.viewEntriesRemoved[kept.viewEntriesRemoved.length - 1]!;
    expect(last).toEqual({ view: 'ollama', path: 'manifests/hf.co/org/gguf/Q8_0', contentBase64: readFileSync(manifestFile).toString('base64'), done: false });
    const ignored = await manifestFromPlan(forge(plan, (p) => { p.ops.push({ kind: 'rmdir-empty', path: join(s.ollama, 'x') }); }), ctx);
    expect(ignored.viewEntriesRemoved).toHaveLength(2);
    await expect(manifestFromPlan(plan, { ...ctx, viewRoots: { lmstudio: s.root, ollama: s.ollama } })).rejects.toThrow(/more than one view folder/);
    const outside = forge(plan, (p) => {
      p.ops.push({ kind: 'unlink', path: join(s.hub, 'models--org--gguf', 'refs', 'main'), expect: regular!, role: 'view-link' });
    });
    await expect(manifestFromPlan(outside, ctx)).rejects.toThrow(/not inside a view root/);
    const view = s.lmstudio;
    await expect(manifestFromPlan(forge(plan, (p) => {
      p.ops.push({ kind: 'unlink', path: view, expect: regular!, role: 'view-link' });
    }), ctx)).rejects.toThrow(/not inside a view root/);
  });
});

describe('regular view blobs in the manifest', () => {
  const entryWith = (o: J): HoldManifest => {
    const r = parse(patchView(o));
    if (!r.ok) throw new Error(r.error);
    return r.manifest;
  };
  test('parseView accepts a valid contentBase64 (also empty and exactly 1 MiB) and the manifest round-trips', () => {
    for (const c of ['', Buffer.from('{"a":1}').toString('base64'), Buffer.alloc(1048576, 7).toString('base64')]) {
      const m = entryWith({ contentBase64: c });
      expect(m.viewEntriesRemoved[0]!.contentBase64).toBe(c);
      const again = parseManifest(serializeManifest(m), { holdRoot: H, deletionId: ID });
      expect(again).toEqual({ ok: true, manifest: m });
    }
  });
  test('manifestFromPlan refuses an oversized view-manifest, a non-file and too much view data in total', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const ctx = { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 1 };
    const file = join(s.ollama, 'manifests', 'hf.co', 'org', 'gguf', 'Q8_0');
    const regular = (await factsOf(s.fs, file))!;
    const withOp = (expect_: FileFacts, role: 'view-blob' | 'view-manifest'): DeletionPlan =>
      forge(plan, (p) => { p.ops.push({ kind: 'unlink', path: file, expect: expect_, role }); });
    expect(MAX_HELD_VIEW_FILE_BYTES).toBe(1048576);
    expect(MAX_HELD_VIEW_TOTAL_BYTES).toBe(4194304);
    await expect(manifestFromPlan(withOp({ ...regular, size: 1048577 }, 'view-manifest'), ctx))
      .rejects.toThrow(`Cannot move to Recently Deleted: ${file} is a regular file in the ollama folder larger than 1 MiB \u2014 use Delete Permanently.`);
    const notFile = { ...regular, isFile: false, isDirectory: true };
    for (const role of ['view-blob', 'view-manifest'] as const) {
      await expect(manifestFromPlan(withOp(notFile, role), ctx)).rejects.toThrow(`Cannot move to Recently Deleted: ${file} is not a regular file or link in the ollama folder \u2014 use Delete Permanently.`);
    }
    // many files, each within the limit, but over 4 MiB together (declared sizes; every limit is checked before any read)
    // (a view-manifest counts at 6 bytes per byte: 174762 bytes is 1048572, so 5 of them pass 4 MiB)
    const many = forge(plan, (p) => {
      for (let i = 0; i < 5; i++) p.ops.push({ kind: 'unlink', path: file, expect: { ...regular, size: 174762 }, role: 'view-manifest' });
    });
    await expect(manifestFromPlan(many, ctx)).rejects.toThrow('Cannot move to Recently Deleted: more than 4 MiB of view data \u2014 use Delete Permanently.');
  });
  test('manifestFromPlan throws when the file changed size after planning', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const file = join(s.ollama, 'manifests', 'hf.co', 'org', 'gguf', 'Q8_0');
    const regular = (await factsOf(s.fs, file))!;
    const stale = forge(plan, (p) => {
      p.ops.push({ kind: 'unlink', path: file, expect: { ...regular, size: regular.size + 1 }, role: 'view-blob' });
    });
    await expect(manifestFromPlan(stale, { model: m, viewRoots: s.viewRoots, fs: s.fs, now: 1 })).rejects.toThrow(/changed since preview/);
  });

  test('a regular view file is opened only while its lstat facts equal the plan\'s; anything else is "changed since preview"', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const file = join(s.ollama, 'manifests', 'hf.co', 'org', 'gguf', 'Q8_0');
    const planned = (await factsOf(s.fs, file))!;
    const reads: string[] = [];
    const spy: ReadFs = { ...s.fs, readFile: ((p: string, enc?: 'utf8') => {
      reads.push(p);
      return enc === undefined ? s.fs.readFile(p) : s.fs.readFile(p, enc);
    }) as ReadFs['readFile'] };
    const ctx = { model: m, viewRoots: s.viewRoots, fs: spy, now: 1 };
    const withOp = (role: 'view-blob' | 'view-manifest'): DeletionPlan =>
      forge(plan, (p) => { p.ops.push({ kind: 'unlink', path: file, expect: planned, role }); });
    const changedMsg = `${file} changed since preview \u2014 try again.`;
    // rewritten with the same size (only the inode/mtime differ): refused for both roles, never read
    const text = readFileSync(file, 'utf8');
    renameSync(file, `${file}.aside`);
    writeFileSync(file, text.replace(/./, (c) => (c === '{' ? '[' : '{')));
    for (const role of ['view-blob', 'view-manifest'] as const) {
      await expect(manifestFromPlan(withOp(role), ctx)).rejects.toThrow(changedMsg);
    }
    // replaced by a folder (a FIFO would be the same: not the planned regular file), or gone: never opened
    renameSync(file, `${file}.rewritten`);
    mkdirSync(file);
    await expect(manifestFromPlan(withOp('view-manifest'), ctx)).rejects.toThrow(changedMsg);
    renameSync(file, `${file}.dir`);
    await expect(manifestFromPlan(withOp('view-blob'), ctx)).rejects.toThrow(changedMsg);
    expect(reads.filter((p) => p === file)).toEqual([]);
    // back as planned: read once per op and recorded
    renameSync(`${file}.aside`, file);
    const ok = await manifestFromPlan(withOp('view-manifest'), ctx);
    expect(ok.viewEntriesRemoved[ok.viewEntriesRemoved.length - 1]!.manifestText).toBe(text);
    expect(reads.filter((p) => p === file)).toEqual([file, file]);   // the plan's own op on it, and this one
  });

  test('a file that grows between the facts check and the read is refused too', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const file = join(s.ollama, 'manifests', 'hf.co', 'org', 'gguf', 'Q8_0');
    const planned = (await factsOf(s.fs, file))!;
    const racy: ReadFs = { ...s.fs, readFile: (async (p: string) => {
      const b = await s.fs.readFile(p);
      return p === file ? Buffer.concat([b, Buffer.from('x')]) : b;
    }) as ReadFs['readFile'] };
    const op = forge(plan, (p) => { p.ops.push({ kind: 'unlink', path: file, expect: planned, role: 'view-manifest' }); });
    await expect(manifestFromPlan(op, { model: m, viewRoots: s.viewRoots, fs: racy, now: 1 })).rejects.toThrow(/changed since preview/);
  });
});

describe('hold hooks and finalizeHold', () => {
  const readManifest = (holdRoot: string, id: string): HoldManifest => {
    const r = parseManifest(readFileSync(manifestPath(holdRoot, id), 'utf8'), { holdRoot, deletionId: id });
    if (!r.ok) throw new Error(r.error);
    return r.manifest;
  };
  const hooksFor = (s: Awaited<ReturnType<typeof buildHoldScenario>>, m: Awaited<ReturnType<typeof s.model>>) =>
    createHoldHooks({ safeFs: s.safeFs, fs: s.fs, model: m, viewRoots: s.viewRoots, now: () => 5_000 });
  const secondRenameDest = (plan: DeletionPlan): string =>
    (plan.ops.filter((o): o is Extract<Op, { kind: 'hold-rename' }> => o.kind === 'hold-rename')[1]!).dest;
  const failSecondRename = (hooks: ExecHooks, plan: DeletionPlan): ExecHooks => ({
    ...hooks,
    async beforeFirstOp(p) {
      await hooks.beforeFirstOp!(p);
      const dest = secondRenameDest(plan);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, 'x');
    },
  });

  test('hold hooks write the manifest before the first op and mark each entry done after its op', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = hooksFor(s, m);
    const hr = s.roots.holdRoot!;
    const id = plan.deletionId!;
    const seen: HoldManifest[] = [];
    const first = plan.ops.find((o): o is Extract<Op, { kind: 'hold-rename' }> => o.kind === 'hold-rename')!;
    const spy: ExecHooks = {
      async beforeFirstOp(p) {
        await hooks.beforeFirstOp!(p);
        const man = readManifest(hr, id);
        expect(man.status).toBe('moving');
        expect(man.items.every((i) => !i.done)).toBe(true);
        expect(lstatSync(first.path)).toBeTruthy();
      },
      async afterOp(p, i) { await hooks.afterOp!(p, i); seen.push(readManifest(hr, id)); },
    };
    const r = await s.exec(plan, spy);
    expect(r.ok).toBe(true);
    const firstHold = plan.ops.indexOf(first);
    expect(seen[firstHold]!.items.find((i) => i.originalPath === first.path)!.done).toBe(true);
    expect(seen[0]!.status).toBe('moving');
    const final = readManifest(hr, id);
    expect(final.status).toBe('held');
    expect(final.items.every((i) => i.done)).toBe(true);
    expect(final.storeItems.every((i) => i.done)).toBe(true);
    expect(final.viewEntriesRemoved.every((v) => v.done)).toBe(true);
    expect(final.viewEntriesRemoved).toHaveLength(2);
    expect(final.createdAt).toBe(5_000);
  });

  test('hold hooks ignore plans that are not hold deletes', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const pair = await planDeletion({ model: m, selection: q8Iq2MmprojSelection(s, m), roots: s.roots, views: s.views, now: s.now });
    const hooks = hooksFor(s, m);
    const before = readdirSync(s.roots.holdRoot!);
    await hooks.beforeFirstOp!(pair.permanent);
    await hooks.afterOp!(pair.permanent, 0);
    expect(readdirSync(s.roots.holdRoot!)).toEqual(before);
  });

  test('beforeFirstOp refuses an absent or non-directory deletion folder and creates nothing', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = hooksFor(s, m);
    const hr = s.roots.holdRoot!;
    await expect(hooks.beforeFirstOp!(plan)).rejects.toThrow(/deletion folder/);
    expect(readdirSync(hr)).toEqual([]);
    symlinkSync(s.hub, join(hr, plan.deletionId!));
    await expect(hooks.beforeFirstOp!(plan)).rejects.toThrow(/deletion folder/);
  });

  test('the executor reports IO "Could not prepare" when the folder is gone before the hook, creating nothing', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = hooksFor(s, m);
    const before = await treeDigest(s.hub);
    const r = await s.exec(plan, { ...hooks, async beforeFirstOp(p) {
      await s.fs.rename(join(s.roots.holdRoot!, p.deletionId!), join(s.root, 'moved-away'));
      await hooks.beforeFirstOp!(p);
    } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'IO' });
    expect(r.error!.message).toMatch(/Could not prepare/);
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
    expect(await treeDigest(s.hub)).toEqual(before);
  });

  test('a manifest changed behind the hook is STALE, not overwritten', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = hooksFor(s, m);
    const mp = manifestPath(s.roots.holdRoot!, plan.deletionId!);
    mkdirSync(join(s.roots.holdRoot!, plan.deletionId!));
    await hooks.beforeFirstOp!(plan);
    const idx = plan.ops.findIndex((o) => o.kind === 'hold-rename');
    writeFileSync(mp, 'tampered, and longer than before');
    await expect(hooks.afterOp!(plan, idx)).rejects.toThrow(/changed since/);
    expect(readFileSync(mp, 'utf8')).toBe('tampered, and longer than before');
  });

  test('afterOp for an op with no manifest entry rewrites nothing', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = hooksFor(s, m);
    mkdirSync(join(s.roots.holdRoot!, plan.deletionId!));
    await hooks.beforeFirstOp!(plan);
    const mp = manifestPath(s.roots.holdRoot!, plan.deletionId!);
    const bytes = readFileSync(mp);
    const extra = { ...plan, ops: [{ kind: 'rmdir-empty' as const, path: join(s.hub, 'models--org--gguf', 'snapshots') }, ...plan.ops] };
    await hooks.afterOp!(extra, 0);
    expect(readFileSync(mp).equals(bytes)).toBe(true);
  });

  test('read-only fs parameters default to the node read-only fs', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = createHoldHooks({ safeFs: s.safeFs, model: m, viewRoots: s.viewRoots, now: () => 7 });
    const r = await s.exec(plan, hooks);
    expect(r.ok).toBe(true);
    expect((await finalizeHold(plan, { ...r, ok: false }, { safeFs: s.safeFs }))!.status).toBe('partial');
    const s2 = await buildHoldScenario(); const m2 = await s2.model();
    const p2 = await s2.holdPlan(q8Iq2MmprojSelection(s2, m2));
    expect((await executeHold(p2, s2.execDeps(), { model: m2, viewRoots: s2.viewRoots })).ok).toBe(true);
  });

  test('finalizeHold surfaces a refs file it cannot read', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const r = await s.exec(plan, hooksFor(s, m));
    const denied = Object.assign(Object.create(s.fs) as typeof s.fs, {
      readFile: async (p: string, enc?: 'utf8') => {
        if (p.endsWith('.refs')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return enc ? s.fs.readFile(p, enc) : s.fs.readFile(p);
      },
    });
    await expect(finalizeHold(plan, { ...r, ok: false }, { safeFs: s.safeFs, fs: denied })).rejects.toThrow('EACCES');
  });

  test('afterOp without a prior beforeFirstOp throws', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    await expect(hooksFor(s, m).afterOp!(plan, 0)).rejects.toThrow(/no manifest/);
  });

  test('finalizeHold after a rolled-back hold marks nothing done and status partial', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const before = await treeDigest(s.hub);
    const r = await s.exec(plan, failSecondRename(hooksFor(s, m), plan));
    expect(r.ok).toBe(false);
    const man = await finalizeHold(plan, r, { safeFs: s.safeFs, fs: s.fs });
    expect(man!.status).toBe('partial');
    expect(man!.items.every((i) => !i.done)).toBe(true);
    expect(man!.storeItems.every((i) => !i.done)).toBe(true);
    expect(man!.viewEntriesRemoved.every((v) => !v.done)).toBe(true);
    expect(readManifest(s.roots.holdRoot!, plan.deletionId!)).toEqual(man);
    expect(await treeDigest(s.hub)).toEqual(before);
  });

  test('finalizeHold reconciles what is really held after a failure part-way', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = hooksFor(s, m);
    const res = await s.exec(plan, hooks);
    expect(res.ok).toBe(true);
    // A finished run, then put some of it back as a rollback would and finalize it as failed.
    const done = readManifest(s.roots.holdRoot!, plan.deletionId!);
    expect(done.status).toBe('held');
    const item = done.items[0]!;
    await s.fs.rename(item.heldPath, item.originalPath);
    const kept = done.storeItems.find((x) => x.heldPath === null)!;
    writeFileSync(kept.refsPath, kept.refsRemoved.join('\n') + '\n');
    const view = done.viewEntriesRemoved.find((v) => v.linkTarget !== undefined)!;
    await s.fs.symlink(view.linkTarget!, join(s.lmstudio, ...view.path.split('/')));
    const fin = await finalizeHold(plan, { ...res, ok: false }, { safeFs: s.safeFs, fs: s.fs });
    expect(fin!.status).toBe('partial');
    expect(fin!.items.find((i) => i.originalPath === item.originalPath)!.done).toBe(false);
    expect(fin!.items.filter((i) => i.done)).toHaveLength(done.items.length - 1);
    expect(fin!.storeItems.find((x) => x.heldPath === null)!.done).toBe(false);
    expect(fin!.storeItems.find((x) => x.heldPath !== null)!.done).toBe(true);
    expect(fin!.viewEntriesRemoved.find((v) => v.linkTarget !== undefined)!.done).toBe(false);
    expect(fin!.viewEntriesRemoved.find((v) => v.manifestText !== undefined)!.done).toBe(true);
    // a missing .refs counts as done for a kept store item
    await s.fs.unlink(kept.refsPath);
    const again = await finalizeHold(plan, { ...res, ok: false }, { safeFs: s.safeFs, fs: s.fs });
    expect(again!.storeItems.find((x) => x.heldPath === null)!.done).toBe(true);
  });

  test('finalizeHold after success leaves status held and the file unchanged', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const r = await s.exec(plan, hooksFor(s, m));
    expect(r.ok).toBe(true);
    const mp = manifestPath(s.roots.holdRoot!, plan.deletionId!);
    const bytes = readFileSync(mp);
    const man = await finalizeHold(plan, r, { safeFs: s.safeFs, fs: s.fs });
    expect(man!.status).toBe('held');
    expect(readFileSync(mp).equals(bytes)).toBe(true);
  });

  test('finalizeHold marks a manifest left moving as held when the run succeeded', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = hooksFor(s, m);
    const r = await s.exec(plan, { beforeFirstOp: hooks.beforeFirstOp! });
    expect(readManifest(s.roots.holdRoot!, plan.deletionId!).status).toBe('moving');
    const man = await finalizeHold(plan, r, { safeFs: s.safeFs, fs: s.fs });
    expect(man!.status).toBe('held');
    expect(readManifest(s.roots.holdRoot!, plan.deletionId!).status).toBe('held');
  });

  test('finalizeHold returns null for a permanent plan and when no manifest was written; throws on a corrupt one', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const pair = await planDeletion({ model: m, selection: q8Iq2MmprojSelection(s, m), roots: s.roots, views: s.views, now: s.now });
    const fake = { ok: false, planId: 'p', appliedOps: 0, freedBytesPlanned: 0, heldBytes: 0, diskFreeBefore: 0, diskFreeAfter: 0 };
    const deps = { safeFs: s.safeFs, fs: s.fs };
    expect(await finalizeHold(pair.permanent, fake, deps)).toBeNull();
    const plan = pair.hold!;
    expect(await finalizeHold(plan, fake, deps)).toBeNull();
    mkdirSync(join(s.roots.holdRoot!, plan.deletionId!));
    writeFileSync(manifestPath(s.roots.holdRoot!, plan.deletionId!), '{nope');
    await expect(finalizeHold(plan, fake, deps)).rejects.toThrow(/not valid JSON/);
  });

  test('finalizeHold refuses a manifest whose view entries do not match the plan', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const r = await s.exec(plan, hooksFor(s, m));
    const forged = structuredClone(plan);
    forged.ops = forged.ops.filter((o) => !(o.kind === 'unlink' && o.role === 'view-link'));
    await expect(finalizeHold(forged, { ...r, ok: false }, { safeFs: s.safeFs, fs: s.fs })).rejects.toThrow(/view entries/);
  });

  test('executeHold on success leaves a held manifest; on failure finalizes it as partial', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const sel = q8Iq2MmprojSelection(s, m);
    const ctx = { model: m, viewRoots: s.viewRoots, fs: s.fs };
    const ok = await s.holdPlan(sel);
    const r1 = await executeHold(ok, s.execDeps(), ctx);
    expect(r1.ok).toBe(true);
    expect(readManifest(s.roots.holdRoot!, ok.deletionId!).status).toBe('held');
    expect((r1.notes ?? []).some((n) => /Could not update the Recently Deleted/.test(n))).toBe(false);

    const s2 = await buildHoldScenario(); const m2 = await s2.model();
    const plan = await s2.holdPlan(q8Iq2MmprojSelection(s2, m2));
    const base = s2.execDeps();
    const failing = Object.assign(Object.create(base.journal) as typeof base.journal, {
      before: async (...a: Parameters<typeof base.journal.before>) => {
        if (a[1] === 3) throw new Error('journal full');
        return base.journal.before(...a);
      },
    });
    const r2 = await executeHold(plan, { ...base, journal: failing }, { model: m2, viewRoots: s2.viewRoots, fs: s2.fs });
    expect(r2.ok).toBe(false);
    const man = readManifest(s2.roots.holdRoot!, plan.deletionId!);
    expect(man.status).toBe('partial');
    expect(man.items.every((i) => !i.done)).toBe(true);
  });

  test('executeHold leaves a manifest it did not write alone (re-run, dry run, pre-start refusal)', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const ctx = { model: m, viewRoots: s.viewRoots, fs: s.fs };
    expect((await executeHold(plan, s.execDeps(), ctx)).ok).toBe(true);
    const mp = manifestPath(s.roots.holdRoot!, plan.deletionId!);
    const bytes = readFileSync(mp);
    const again = await executeHold(plan, s.execDeps(), ctx);
    expect(again.ok).toBe(false);
    expect(again.error!.code).toBe('STALE');
    expect(readFileSync(mp).equals(bytes)).toBe(true);
    const dry = await executeHold(plan, s.execDeps(undefined, true), ctx);
    expect(readFileSync(mp).equals(bytes)).toBe(true);
    expect(dry.ok).toBe(false);
    const s2 = await buildHoldScenario(); const m2 = await s2.model();
    const p2 = await s2.holdPlan(q8Iq2MmprojSelection(s2, m2));
    const mp2 = manifestPath(s2.roots.holdRoot!, p2.deletionId!);
    mkdirSync(join(s2.roots.holdRoot!, p2.deletionId!));
    writeFileSync(mp2, 'foreign');
    const r = await executeHold({ ...p2, fingerprint: 'bad' }, s2.execDeps(), { model: m2, viewRoots: s2.viewRoots, fs: s2.fs });
    expect(r.error!.code).toBe('FINGERPRINT');
    expect(readFileSync(mp2, 'utf8')).toBe('foreign');
    expect(r.notes ?? []).toEqual([]);
  });

  test('finalizeHold refuses view entries that are out of order with the plan', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const r = await s.exec(plan, hooksFor(s, m));
    const mp = manifestPath(s.roots.holdRoot!, plan.deletionId!);
    const man = readManifest(s.roots.holdRoot!, plan.deletionId!);
    man.viewEntriesRemoved.reverse();
    writeFileSync(mp, serializeManifest(man));
    await expect(finalizeHold(plan, { ...r, ok: false }, { safeFs: s.safeFs, fs: s.fs })).rejects.toThrow(/view entr/);
  });

  test('executeHold appends a finalize failure to notes and never throws', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const base = s.execDeps();
    const failing = Object.assign(Object.create(base.journal) as typeof base.journal, {
      before: async (...a: Parameters<typeof base.journal.before>) => {
        if (a[1] === 3) throw new Error('journal full');
        return base.journal.before(...a);
      },
    });
    const unreadable = Object.assign(Object.create(s.fs) as typeof s.fs, {
      readFile: async (p: string, enc?: 'utf8') => {
        if (p.endsWith(MANIFEST_NAME)) throw new Error('disk on fire');
        return enc ? s.fs.readFile(p, enc) : s.fs.readFile(p);
      },
    });
    const r = await executeHold(plan, { ...base, journal: failing }, { model: m, viewRoots: s.viewRoots, fs: unreadable });
    expect(r.ok).toBe(false);
    expect(r.notes!.some((n) => /Recently Deleted.*disk on fire/.test(n))).toBe(true);
  });

  test('executeHold appends a finalize failure to a result without notes', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const base = s.execDeps();
    const failing = Object.assign(Object.create(base.journal) as typeof base.journal, {
      before: async (...a: Parameters<typeof base.journal.before>) => {
        if (a[1] === 0) throw new Error('journal full');
        return base.journal.before(...a);
      },
    });
    const unreadable = Object.assign(Object.create(s.fs) as typeof s.fs, {
      readFile: async (p: string, enc?: 'utf8') => {
        if (p.endsWith(MANIFEST_NAME)) throw new Error('disk on fire');
        return enc ? s.fs.readFile(p, enc) : s.fs.readFile(p);
      },
    });
    const r = await executeHold(plan, { ...base, journal: failing }, { model: m, viewRoots: s.viewRoots, fs: unreadable });
    expect(r.ok).toBe(false);
    expect(r.notes).toHaveLength(1);
    expect(r.notes!.some((n) => /Recently Deleted.*disk on fire/.test(n))).toBe(true);
  });

  test('executeHold passes a permanent plan through and does not finalize a failed one', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const pair = await planDeletion({ model: m, selection: q8Iq2MmprojSelection(s, m), roots: s.roots, views: s.views, now: s.now });
    const ctx = { model: m, viewRoots: s.viewRoots, fs: s.fs };
    const ok = await executeHold(pair.permanent, s.execDeps(), ctx);
    expect(ok.ok).toBe(true);
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
    const again = await executeHold(pair.permanent, s.execDeps(), ctx);   // files are gone now: stale, not ok
    expect(again.ok).toBe(false);
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
  });

  test('a hold plan with a regular view blob over 1 MiB leaves everything unchanged and names the path', async () => {
    const s = await buildHoldScenario(); const m = await s.model();
    const plan = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const blob = join(s.lmstudio, 'org', 'gguf', 'regular.bin');
    writeFileSync(blob, Buffer.alloc(1048577, 1));
    const body = structuredClone(plan) as Partial<DeletionPlan>;
    delete body.id; delete body.fingerprint;
    body.ops = [{ kind: 'unlink', path: blob, expect: (await factsOf(s.fs, blob))!, role: 'view-blob' }, ...plan.ops];
    const forged = { ...plan, ops: body.ops, fingerprint: fingerprintPlan(body as Omit<DeletionPlan, 'id' | 'fingerprint'>) };
    const snap = async () => [await treeDigest(s.hub), await treeDigest(s.lmstudio), await treeDigest(s.ollama), await treeDigest(s.roots.holdRoot!)];
    const before = await snap();
    const r = await executeHold(forged, s.execDeps(), { model: m, viewRoots: s.viewRoots, fs: s.fs });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.error)).toContain(blob);
    expect(await snap()).toEqual(before);
  });
});
