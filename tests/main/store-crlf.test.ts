// A cache laid out as huggingface_hub lays it out on Windows with the shared blob store: the store marker and the
// `.refs` files end their lines with CRLF, and a file that is not LFS links to a blob named by its 40-hex git id.
// Real file system (a temp folder) and the real services; no substitutes.
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanHub } from '../../src/core/scan/scanner';
import { parseRefs, readStoreMarker, sweepDecision } from '../../src/core/scan/store';
import { createCorePort } from '../../src/main/core-port';
import { inProcessScanRunner } from '../../src/main/scan-client';
import { AppServices } from '../../src/main/services';
import type { ApiResult } from '../../src/shared/api';
import { bytes, COMMIT, gitSha1, sha256, tmp, useTempDirs } from '../core/transfer/_drive';

useTempDirs();
const REPO = 'org/Reasoning-Set';
const FOLDER = 'datasets--org--Reasoning-Set';
const TRAIN = bytes(50_000, 5);
const ATTRS = '*.jsonl filter=lfs diff=lfs merge=lfs -text\n';
const README = '# a dataset\n';
const LFS = sha256(TRAIN);
/** The store names a payload by another hash than the repo blob (here: of other bytes), as the real store does. */
const STORE = sha256('store name');

function unwrap<T>(r: ApiResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

/** <hub>/datasets--org--Reasoning-Set with train.jsonl in the shared store, plus two small files that are not LFS. */
async function buildHub(eol: '\n' | '\r\n', refs: string[] = [`${FOLDER}/blobs/${LFS}`]): Promise<string> {
  const root = await tmp();
  const hub = join(root, 'hub');
  const folder = join(hub, FOLDER);
  const snap = join(folder, 'snapshots', COMMIT);
  for (const d of [join(hub, 'blobs', STORE.slice(0, 2)), join(folder, 'blobs'), join(folder, 'refs'), snap]) await mkdir(d, { recursive: true });
  await writeFile(join(hub, 'blobs', '.huggingface-shared-blobs'), `1${eol}`);
  const payload = join(hub, 'blobs', STORE.slice(0, 2), STORE);
  await writeFile(payload, TRAIN);
  await writeFile(`${payload}.refs`, refs.map((l) => `${l}${eol}`).join(''));
  await symlink(join('..', '..', 'blobs', STORE.slice(0, 2), STORE), join(folder, 'blobs', LFS), 'file');
  await symlink(join('..', '..', 'blobs', LFS), join(snap, 'train.jsonl'), 'file');
  for (const [name, text] of [['.gitattributes', ATTRS], ['README.md', README]] as const) {
    await writeFile(join(folder, 'blobs', gitSha1(text)), text);
    await symlink(join('..', '..', 'blobs', gitSha1(text)), join(snap, name), 'file');
  }
  await writeFile(join(folder, 'refs', 'main'), COMMIT);
  return hub;
}

async function servicesFor(hub: string): Promise<AppServices> {
  const root = join(hub, '..');
  const userData = join(root, 'userData');
  const home = join(root, 'home');
  await mkdir(userData);
  await mkdir(home);
  const env: NodeJS.ProcessEnv = { HF_HUB_CACHE: hub, HF_HUB_OFFLINE: '1', HFCM_OFFLINE: '1' };
  return new AppServices({
    env, home, userDataDir: userData, port: createCorePort({ userDataDir: userData, env, home, offline: true }),
    scanRunner: inProcessScanRunner, now: Date.now, emitProgress: () => undefined, platform: process.platform,
  });
}

describe('the store marker', () => {
  it.each([['1\n', true], ['1\r\n', true], ['1', false], ['1\r', false], ['2\r\n', false], ['1\r\n\r\n', false], [' 1\r\n', false], ['', false]])(
    '%j counts: %s', async (text, want) => {
      const hub = await tmp();
      await mkdir(join(hub, 'blobs'));
      await writeFile(join(hub, 'blobs', '.huggingface-shared-blobs'), text);
      expect(await readStoreMarker(hub)).toBe(want);
    });
  it('a missing marker does not count', async () => {
    expect(await readStoreMarker(await tmp())).toBe(false);
  });
});

describe('parseRefs (pure)', () => {
  it('reads LF and CRLF lines alike and keeps anything else in the line', () => {
    expect(parseRefs('a/blobs/x\nb/blobs/y\n')).toEqual(['a/blobs/x', 'b/blobs/y']);
    expect(parseRefs('a/blobs/x\r\nb/blobs/y\r\n')).toEqual(['a/blobs/x', 'b/blobs/y']);
    expect(parseRefs('a/blobs/x\r\nb/blobs/y')).toEqual(['a/blobs/x', 'b/blobs/y']);
    expect(parseRefs('')).toEqual([]);
    expect(parseRefs('a\rb\n')).toEqual(['a\rb']);     // a lone CR is not a line ending
    expect(parseRefs(' a \r\n\r\n')).toEqual([' a ', '']);   // no trimming, an empty line stays
  });
});

describe.each([['CRLF (Windows)', '\r\n'], ['LF', '\n']] as const)('a shared-store cache written with %s line endings', (_name, eol) => {
  it('the scan trusts the store and finds the one repo that references the payload', async () => {
    const hub = await buildHub(eol);
    const model = await scanHub(hub);
    expect(model.storeMarked).toBe(true);
    const store = Object.values(model.store);
    expect(store).toHaveLength(1);
    expect(store[0]!.refsRaw).toEqual([`${FOLDER}/blobs/${LFS}`]);
    expect(store[0]!.validRefs).toEqual([`${FOLDER}/blobs/${LFS}`]);
    const blob = model.repos[0]!.blobs[LFS]!;
    expect(sweepDecision(store[0]!, [blob.path], model.storeMarked)).toEqual({ deletable: true, reason: 'store-unreferenced' });
    expect(sweepDecision(store[0]!, [], model.storeMarked)).toEqual({ deletable: false, reason: 'store-shared' });
  });

  it('the library shows every file at its size, and what a deletion frees is the size of the files', async () => {
    const svc = await servicesFor(await buildHub(eol));
    const total = TRAIN.length + ATTRS.length + README.length;
    const lib = unwrap(await svc.scan());
    expect(lib.repos.map((r) => [r.repoId, r.apparentBytes])).toEqual([[REPO, total]]);
    const detail = unwrap(await svc.repoDetail(REPO));
    const files = detail.groups.flatMap((g) => g.files.map((f) => [f.relpath, f.bytes]));
    expect(files).toEqual(expect.arrayContaining([['train.jsonl', TRAIN.length], ['.gitattributes', ATTRS.length], ['README.md', README.length]]));
    expect(detail.apparentBytes).toBe(total);
    for (const g of detail.groups) {
      const size = g.files.reduce((n, f) => n + f.bytes, 0);
      expect(g.apparentBytes, g.key).toBe(size);
      expect(g.reclaimableBytes, g.key).toBe(size);
    }
    expect(detail.groups.reduce((n, g) => n + g.apparentBytes, 0)).toBe(total);
    const preview = unwrap(await svc.previewSelection({ repos: [{ repoId: REPO, whole: true }] }));
    // the whole repo also removes refs/main, a 40-byte file
    expect(preview.freedBytes).toBe(total + COMMIT.length);
  });
});

describe('a payload another repo still references', () => {
  it('is not counted as freed, and its size is still shown', async () => {
    // The second reference must be a real link to the payload to count, so a second repo is built beside the first.
    const other = 'datasets--org--Other-Set';
    const hub = await buildHub('\r\n', [`${FOLDER}/blobs/${LFS}`, `${other}/blobs/${LFS}`]);
    await mkdir(join(hub, other, 'blobs'), { recursive: true });
    await mkdir(join(hub, other, 'snapshots', COMMIT), { recursive: true });
    await symlink(join('..', '..', 'blobs', STORE.slice(0, 2), STORE), join(hub, other, 'blobs', LFS), 'file');
    await symlink(join('..', '..', 'blobs', LFS), join(hub, other, 'snapshots', COMMIT, 'train.jsonl'), 'file');
    const svc = await servicesFor(hub);
    unwrap(await svc.scan());
    const detail = unwrap(await svc.repoDetail(REPO));
    const group = detail.groups.find((g) => g.files.some((f) => f.relpath === 'train.jsonl'))!;
    expect(group.files.find((f) => f.relpath === 'train.jsonl')!.bytes).toBe(TRAIN.length);
    const preview = unwrap(await svc.previewSelection({ repos: [{ repoId: REPO, whole: true }] }));
    // the two small files and refs/main (40 bytes); the payload stays for the other repo
    expect(preview.freedBytes).toBe(ATTRS.length + README.length + COMMIT.length);
  });
});
