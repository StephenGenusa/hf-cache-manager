// Export against the real file system: a real cache built by hand and scanned with the app's scanner, exported to a
// temp folder (and to a real FAT32 / exFAT volume when HFCM_TEST_FAT32_DIR / HFCM_TEST_EXFAT_DIR are set). No substitutes.
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanHub } from '../../../src/core/scan/scanner';
import { openObject, readDrive, transferRoot } from '../../../src/core/transfer/drive-reader';
import { EXPORT_MARGIN, exportNeeds, runExport, type ExportProgress } from '../../../src/core/transfer/export';
import { exportSet, nameFor, SKIP_MISSING, type ExportSet } from '../../../src/core/transfer/export-plan';
import { partPath } from '../../../src/core/transfer/format';
import type { Selection } from '../../../src/core/types';
import { buildRepo, bytes, COMMIT, gitSha1, sha256, tmp, useTempDirs, volume, VOLUMES, type CacheFile } from './_drive';

useTempDirs();
const PART = 1000;
const Q4 = bytes(2600, 11);
const Q8 = bytes(3100, 12);
const CONFIG = '{"model_type":"llama"}';
const FILES: CacheFile[] = [
  { path: 'model-Q4_K_M.gguf', content: Q4, lfs: true },
  { path: 'model-Q8_0.gguf', content: Q8, lfs: true },
  { path: 'config.json', content: CONFIG, lfs: false },
];
const WHOLE: Selection = { repos: [{ repoId: 'org/name', whole: true }] };

async function setFor(hub: string, selection: Selection = WHOLE): Promise<ExportSet> {
  const set = exportSet(await scanHub(hub), selection);
  if ('error' in set) throw new Error(set.error);
  return set;
}
async function run(set: ExportSet, vol: string, over: { signal?: AbortSignal; onProgress?: (p: ExportProgress) => void; now?: number } = {}) {
  return runExport(set, {
    volumeRoot: vol, now: () => over.now ?? 5000, signal: over.signal ?? new AbortController().signal,
    onProgress: over.onProgress ?? (() => undefined), partSize: PART,
  });
}
async function objectBytes(vol: string, etag: string, size: number): Promise<Buffer> {
  const out: Uint8Array[] = [];
  for await (const c of openObject(transferRoot(vol), { etag, size, partSize: PART }, 0)) out.push(c);
  return Buffer.concat(out);
}

describe('exportSet (the scanned cache as files to copy)', () => {
  it.each([[true, 'links'], [false, 'plain copies']])('a whole repo, snapshot entries as %s', async (links) => {
    const hub = await tmp();
    const folder = await buildRepo(hub, 'org/name', FILES, { links });
    const set = await setFor(hub);
    expect(set.skipped).toEqual([]);
    expect(set.repos).toHaveLength(1);
    const r = set.repos[0]!;
    expect(r).toMatchObject({ repoId: 'org/name', type: 'model', commit: COMMIT, ref: 'main' });
    expect(r.blobNames).toEqual([sha256(Q4), sha256(Q8), gitSha1(CONFIG)].sort());
    expect(r.files.map((f) => f.path)).toEqual(['config.json', 'model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
    if (links) {
      expect(r.files.map((f) => f.etag)).toEqual([gitSha1(CONFIG), sha256(Q4), sha256(Q8)]);
      expect(r.files[1]!.source).toBe(join(folder, 'blobs', sha256(Q4)));
    } else {
      expect(r.files.map((f) => f.etag)).toEqual([null, null, null]);
      expect(r.files[1]!.source).toBe(join(folder, 'snapshots', COMMIT, 'model-Q4_K_M.gguf'));
    }
    expect(r.files.map((f) => f.size)).toEqual([CONFIG.length, 2600, 3100]);
  });

  it('chosen groups only; an unknown group or repo is an error', async () => {
    const hub = await tmp();
    await buildRepo(hub, 'org/name', FILES);
    const set = await setFor(hub, { repos: [{ repoId: 'org/name', whole: false, groupKeys: ['quant:Q4_K_M'], unlockComponents: false }] });
    expect(set.repos[0]!.files.map((f) => f.path)).toEqual(['model-Q4_K_M.gguf']);
    const model = await scanHub(hub);
    expect(exportSet(model, { repos: [{ repoId: 'org/name', whole: false, groupKeys: ['quant:nope'], unlockComponents: false }] })).toEqual({ error: expect.stringContaining('quant:nope') });
    expect(exportSet(model, { repos: [{ repoId: 'org/gone', whole: true }] })).toEqual({ error: expect.stringContaining('org/gone') });
  });

  it('a file whose blob is gone is skipped with the reason; the rest is exported', async () => {
    const hub = await tmp();
    const folder = await buildRepo(hub, 'org/name', FILES);
    await unlink(join(folder, 'blobs', gitSha1(CONFIG)));
    const set = await setFor(hub);
    expect(set.skipped).toEqual([{ repoId: 'org/name', path: 'config.json', reason: SKIP_MISSING }]);
    expect(set.repos[0]!.files.map((f) => f.path)).toEqual(['model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
  });

  it('two snapshots become two sets; only the commit a ref names carries it', async () => {
    const hub = await tmp();
    const old = 'd'.repeat(40);
    await buildRepo(hub, 'org/name', [FILES[0]!], { links: true, commit: old, ref: null });
    await buildRepo(hub, 'org/name', FILES, { links: true });
    const set = await setFor(hub);
    expect(set.repos.map((r) => [r.commit, r.ref, r.files.length])).toEqual([[COMMIT, 'main', 3], [old, null, 1]]);
  });
});

describe('nameFor (pure)', () => {
  const h = { sha256: 'a'.repeat(64), gitSha1: 'b'.repeat(40) };
  it('takes the hash that names a blob of the repo, else the SHA-256', () => {
    expect(nameFor(h, [h.sha256, h.gitSha1])).toEqual({ etag: h.sha256, lfs: true });
    expect(nameFor(h, [h.gitSha1])).toEqual({ etag: h.gitSha1, lfs: false });
    expect(nameFor(h, [])).toEqual({ etag: h.sha256, lfs: true });
  });
});

describe.each(VOLUMES)('runExport to a $name', ({ base }) => {
  it.each([[true, 'links'], [false, 'plain copies']])('copies every file under its etag and adds one manifest (%s cache)', async (links) => {
    const hub = await tmp();
    await buildRepo(hub, 'org/name', FILES, { links });
    const vol = await volume(base);
    const events: ExportProgress[] = [];
    const res = await run(await setFor(hub), vol, { onProgress: (p) => events.push(p) });
    expect(res.ok).toBe(true);
    expect(res.stopped).toBe(null);
    expect(res.repos).toEqual([{ repoId: 'org/name', type: 'model', commit: COMMIT, manifest: expect.stringMatching(/^[0-9a-f]{64}\.json$/), failed: [] }]);
    const d = (await readDrive(vol))!;
    expect(d.notes).toEqual([]);
    expect(d.repos).toHaveLength(1);
    expect(d.repos[0]).toMatchObject({ repoId: 'org/name', commit: COMMIT, ref: 'main', exportedAt: 5000, incomplete: [] });
    expect(d.repos[0]!.files).toEqual([
      { path: 'config.json', size: CONFIG.length, etag: gitSha1(CONFIG), lfs: false, partSize: PART },
      { path: 'model-Q4_K_M.gguf', size: 2600, etag: sha256(Q4), lfs: true, partSize: PART },
      { path: 'model-Q8_0.gguf', size: 3100, etag: sha256(Q8), lfs: true, partSize: PART },
    ]);
    expect((await objectBytes(vol, sha256(Q4), 2600)).equals(Buffer.from(Q4))).toBe(true);
    expect((await objectBytes(vol, sha256(Q8), 3100)).equals(Buffer.from(Q8))).toBe(true);
    expect((await objectBytes(vol, gitSha1(CONFIG), CONFIG.length)).toString()).toBe(CONFIG);
    // 3 + 4 parts for the quants, 1 for the config
    const parts = (await Promise.all((await readdir(join(transferRoot(vol), 'objects'))).map((xx) => readdir(join(transferRoot(vol), 'objects', xx))))).flat();
    expect(parts).toHaveLength(8);
    expect(events.filter((e) => e.state === 'done').map((e) => e.path).sort()).toEqual(['config.json', 'model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
    expect(events.some((e) => e.state === 'hashing')).toBe(!links);
  });

  it('a second export of the same files writes nothing; another quant adds its object and one more manifest', async () => {
    const hub = await tmp();
    await buildRepo(hub, 'org/name', FILES);
    const vol = await volume(base);
    const q4: Selection = { repos: [{ repoId: 'org/name', whole: false, groupKeys: ['quant:Q4_K_M'], unlockComponents: false }] };
    expect((await run(await setFor(hub, q4), vol)).ok).toBe(true);
    const dir = join(transferRoot(vol), 'manifests');
    expect(await readdir(dir)).toHaveLength(1);
    expect(await exportNeeds(await setFor(hub, q4), vol, { partSize: PART })).toEqual({ bytes: 0, files: 0 });

    const again = await run(await setFor(hub, q4), vol, { now: 9000 });
    expect(again.ok).toBe(true);
    expect(again.repos[0]!.manifest).toBe(null);
    expect(await readdir(dir)).toHaveLength(1);

    expect(await exportNeeds(await setFor(hub), vol, { partSize: PART })).toEqual({ bytes: 3100 + CONFIG.length, files: 2 });
    const copied: string[] = [];
    const more = await run(await setFor(hub), vol, { now: 9000, onProgress: (p) => { if (p.state === 'copying') copied.push(p.path); } });
    expect(more.ok).toBe(true);
    expect([...new Set(copied)].sort()).toEqual(['config.json', 'model-Q8_0.gguf']);
    expect(await readdir(dir)).toHaveLength(2);
    expect((await readDrive(vol))!.repos[0]!.files.map((f) => f.path)).toEqual(['config.json', 'model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
  });

  it('a cancelled export adds no manifest; the next one continues the short part and finishes', async () => {
    const hub = await tmp();
    await buildRepo(hub, 'org/name', [FILES[1]!]);
    const vol = await volume(base);
    const set = await setFor(hub);
    // Stop on the first progress report of the copy; the parts written so far stay.
    const ctl = new AbortController();
    const stopped = await run(set, vol, { signal: ctl.signal, onProgress: (p) => { if (p.state === 'copying' && p.bytes > 0) ctl.abort(new Error('cancel')); } });
    expect(stopped.ok).toBe(false);
    expect(stopped.stopped).toEqual({ why: 'cancelled', message: 'The export was cancelled.' });
    expect(await readdir(join(transferRoot(vol), 'manifests'))).toEqual([]);
    expect((await readDrive(vol))!.repos).toEqual([]);
    // Make the leftover a part cut short in the middle, as a pulled drive would leave it.
    const first = join(transferRoot(vol), ...partPath(sha256(Q8), 0).split('/'));
    await writeFile(first, Q8.subarray(0, 400));
    expect(await exportNeeds(set, vol, { partSize: PART })).toEqual({ bytes: 3100 - 400, files: 1 });

    const res = await run(set, vol);
    expect(res.ok).toBe(true);
    expect((await objectBytes(vol, sha256(Q8), 3100)).equals(Buffer.from(Q8))).toBe(true);
    expect((await readDrive(vol))!.repos[0]!.files).toHaveLength(1);
  });

  it('a part on the drive larger than it can be fails that file, is left as it is, and no manifest is added', async () => {
    const hub = await tmp();
    await buildRepo(hub, 'org/name', [FILES[0]!]);
    const vol = await volume(base);
    const set = await setFor(hub);
    const stray = join(transferRoot(vol), ...partPath(sha256(Q4), 2).split('/'));
    await mkdir(dirname(stray), { recursive: true });
    await writeFile(stray, bytes(900, 99));   // the last part should be 600 bytes
    const res = await run(set, vol);
    expect(res.ok).toBe(false);
    expect(res.stopped).toBe(null);
    expect(res.repos[0]!.manifest).toBe(null);
    expect(res.repos[0]!.failed).toEqual([{ path: 'model-Q4_K_M.gguf', error: expect.stringContaining('remove it from the drive') }]);
    expect(Buffer.from(await readFile(stray)).equals(Buffer.from(bytes(900, 99)))).toBe(true);
    expect(await readdir(join(transferRoot(vol), 'manifests'))).toEqual([]);
  });

  it('a source that changes size before the copy fails that file with "changed"', async () => {
    const hub = await tmp();
    const folder = await buildRepo(hub, 'org/name', [FILES[0]!]);
    const vol = await volume(base);
    const set = await setFor(hub);
    await appendFile(join(folder, 'blobs', sha256(Q4)), 'more');
    const res = await run(set, vol);
    expect(res.ok).toBe(false);
    expect(res.repos[0]!.failed[0]!.error).toContain('changed in the cache');
  });
});

describe('exportNeeds', () => {
  it('on a volume with no transfer folder: every object once, at full size', async () => {
    const hub = await tmp();
    await buildRepo(hub, 'org/name', [...FILES, { path: 'copy/model-Q4_K_M.gguf', content: Q4, lfs: true }]);
    const vol = await tmp();
    expect(await exportNeeds(await setFor(hub), vol, { partSize: PART })).toEqual({ bytes: 2600 + 3100 + CONFIG.length, files: 3 });
    expect(await readdir(vol)).toEqual([]);   // asking writes nothing
  });
  it('the margin left free is 64 MiB', () => {
    expect(EXPORT_MARGIN).toBe(64 * 1024 * 1024);
  });
});

// Opt-in, real size: a file over 4 GiB (more than FAT32 can hold in one file) exported with the real 1 GiB part size to
// the FAT32 volume named by HFCM_TEST_FAT32_DIR, and read back whole. It writes about 4.5 GiB to the temp folder and
// again to that volume, so it runs only with HFCM_TEST_BIG=1.
describe.skipIf(!process.env.HFCM_TEST_FAT32_DIR || process.env.HFCM_TEST_BIG !== '1')('a file over 4 GiB on a real FAT32 volume', () => {
  it('is split into 1 GiB parts and reads back with the same SHA-256', async () => {
    const { createHash } = await import('node:crypto');
    const { open, symlink } = await import('node:fs/promises');
    const hub = await tmp();
    const folder = join(hub, 'models--org--big');
    await mkdir(join(folder, 'blobs'), { recursive: true });
    await mkdir(join(folder, 'snapshots', COMMIT), { recursive: true });
    const SIZE = 4.5 * 1024 ** 3;
    const block = bytes(64 * 1024 * 1024, 21);
    const hash = createHash('sha256');
    const fh = await open(join(folder, 'blobs', 'pending'), 'w');
    for (let done = 0; done < SIZE; done += block.length) {
      const chunk = block.subarray(0, Math.min(block.length, SIZE - done));
      hash.update(chunk);
      await fh.write(chunk);
    }
    await fh.close();
    const etag = hash.digest('hex');
    const { rename } = await import('node:fs/promises');
    await rename(join(folder, 'blobs', 'pending'), join(folder, 'blobs', etag));
    await symlink(join('..', '..', 'blobs', etag), join(folder, 'snapshots', COMMIT, 'big.gguf'), 'file');

    const vol = await volume(process.env.HFCM_TEST_FAT32_DIR!);
    const set = exportSet(await scanHub(hub), { repos: [{ repoId: 'org/big', whole: true }] });
    if ('error' in set) throw new Error(set.error);
    const res = await runExport(set, { volumeRoot: vol, now: () => 1, signal: new AbortController().signal, onProgress: () => undefined });
    expect(res.ok).toBe(true);
    const parts = (await readdir(join(transferRoot(vol), 'objects', etag.slice(0, 2)))).sort();
    expect(parts).toEqual([0, 1, 2, 3, 4].map((i) => `${etag}.00${i}`));
    const back = createHash('sha256');
    for await (const c of openObject(transferRoot(vol), { etag, size: SIZE, partSize: 1024 ** 3 }, 0)) back.update(c);
    expect(back.digest('hex')).toBe(etag);
  }, 3_600_000);
});
