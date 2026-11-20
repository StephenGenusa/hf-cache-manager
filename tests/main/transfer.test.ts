// Transfer drives through the real services: a real cache built by hand is exported to a "drive" (a temp folder named
// by HFCM_TRANSFER_ROOTS, the documented override of the volume search) and loaded into a second real cache by the
// real download engine. Real file system throughout, no network (HF_HUB_OFFLINE=1) and no substitute, except where a
// test says so in its own comment (free space, which a test cannot use up on a real disk).
import { mkdir, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCorePort } from '../../src/main/core-port';
import { inProcessScanRunner } from '../../src/main/scan-client';
import { AppServices, type ServicesDeps } from '../../src/main/services';
import { EXPORT_ACTIVE_TEXT, EXPORT_NOTHING_TEXT, NO_TRANSFER_TEXT, VOLUME_GONE_TEXT, type TransferService } from '../../src/main/transfer-service';
import { DRIVE_GONE_TEXT } from '../../src/main/transfer/drive-source';
import { listVolumes, mountedChildren, mountParents, overrideRoots, volumeId, windowsRoots } from '../../src/main/transfer/volumes';
import type { ApiResult, ExportDTO, HubLookupDTO } from '../../src/shared/api';
import type { Selection } from '../../src/core/types';
import { tinyGgufHeader } from '../helpers/app-fixture';
import { buildRepo, bytes, COMMIT, gitSha1, sha256, tmp, useTempDirs } from '../core/transfer/_drive';

useTempDirs();
const PART = 1000;
const Q4 = tinyGgufHeader(4000, 15);
const Q8 = tinyGgufHeader(3300, 7);
const README = '# a model\n';
const REPO = 'org/Model-GGUF';
const FILES = [
  { path: 'Model-Q4_K_M.gguf', content: Q4, lfs: true },
  { path: 'Model-Q8_0.gguf', content: Q8, lfs: true },
  { path: 'README.md', content: README, lfs: false },
];
const WHOLE: Selection = { repos: [{ repoId: REPO, whole: true }] };

function unwrap<T>(r: ApiResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}
const errOf = <T>(r: ApiResult<T>): { code: string; message: string } => {
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
};

interface Machine { svc: AppServices; hub: string; userData: string; events: ExportDTO[] }

/** A machine: its own cache, settings folder and home, seeing the given volumes. */
async function machine(volumes: string[], over: Partial<ServicesDeps> = {}): Promise<Machine> {
  const root = await tmp();
  const hub = join(root, 'hub');
  const userData = join(root, 'userData');
  const home = join(root, 'home');
  for (const d of [hub, userData, home]) await mkdir(d);
  const env: NodeJS.ProcessEnv = {
    HF_HUB_CACHE: hub, HF_HUB_OFFLINE: '1', HFCM_OFFLINE: '1', HFCM_NO_GPU_DETECT: '1', HFCM_TRANSFER_ROOTS: volumes.join(delimiter),
  };
  const events: ExportDTO[] = [];
  const svc = new AppServices({
    env, home, userDataDir: userData, port: createCorePort({ userDataDir: userData, env, home, offline: true }),
    scanRunner: inProcessScanRunner, now: Date.now, emitProgress: () => undefined, platform: process.platform,
    emitExportProgress: (e) => events.push(e), transfer: { partSize: PART }, ...over,
  });
  return { svc, hub, userData, events };
}

async function exportAll(m: Machine, selection: Selection = WHOLE): Promise<ExportDTO> {
  unwrap(await m.svc.scan());
  const vol = unwrap(await m.svc.transferVolumes())[0]!;
  const preview = unwrap(await m.svc.exportPreview(selection, vol.id));
  expect(preview.fits).toBe(true);
  const { id } = unwrap(await m.svc.exportStart(preview.previewId));
  await m.svc.exportsIdle();
  return unwrap(await m.svc.exports()).find((e) => e.id === id)!;
}

/** Opens the one repo on the drive and loads the named groups (all when none are named); resolves when every file is done. */
async function load(m: Machine, groupKeys?: string[]): Promise<{ lookup: HubLookupDTO; id: string }> {
  unwrap(await m.svc.scan());
  const vol = unwrap(await m.svc.transferVolumes())[0]!;
  const drive = unwrap(await m.svc.transferDrive(vol.id));
  const lookup = unwrap(await m.svc.transferOpen(vol.id, drive.repos[0]!.key));
  const keys = groupKeys ?? lookup.groups.filter((g) => g.selectable).map((g) => g.key);
  const preview = unwrap(await m.svc.downloadPreview(lookup.lookupId, keys));
  expect(preview.reason).toBe(null);
  const { id } = unwrap(await m.svc.downloadStart(preview.previewId, preview.fingerprint));
  for (let i = 0; i < 400; i += 1) {
    const item = unwrap(await m.svc.downloads()).items.find((x) => x.id === id);
    if (item !== undefined && item.files.every((f) => f.state === 'done' || f.state === 'failed')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { lookup, id };
}

describe('volume search (pure logic, plain data)', () => {
  it('Windows: every drive letter but the system drive', () => {
    const roots = windowsRoots({ SystemDrive: 'C:' });
    expect(roots).toHaveLength(25);
    expect(roots).not.toContain('C:\\');
    expect(roots).toContain('E:\\');
    expect(windowsRoots({ SystemDrive: 'd:' })).not.toContain('D:\\');
    expect(windowsRoots({})).not.toContain('C:\\');
  });
  it('macOS and Linux: the folders drives are mounted under', () => {
    expect(mountParents('darwin', 'sam')).toEqual(['/Volumes']);
    expect(mountParents('linux', 'sam')).toEqual(['/media/sam', '/run/media/sam', '/media', '/mnt']);
    expect(mountParents('linux', '')).toEqual(['/media', '/mnt']);
    expect(mountParents('win32', 'sam')).toEqual([]);
  });
  it('a child is a volume only when it is a folder on another device than its parent', () => {
    expect(mountedChildren(7, [
      { name: 'USB', dev: 40, isDirectory: true },
      { name: 'Macintosh HD', dev: 7, isDirectory: true },     // the link to the system disk
      { name: 'sam', dev: 7, isDirectory: true },               // /media/sam itself, not a mount
      { name: 'note.txt', dev: 41, isDirectory: false },
      { name: 'Backup', dev: 42, isDirectory: true },
    ])).toEqual(['Backup', 'USB']);
  });
  it('HFCM_TRANSFER_ROOTS replaces the search; unset or empty leaves it on', () => {
    expect(overrideRoots({})).toBe(null);
    expect(overrideRoots({ HFCM_TRANSFER_ROOTS: '' })).toBe(null);
    expect(overrideRoots({ HFCM_TRANSFER_ROOTS: ['/a', ' /b ', ''].join(delimiter) })).toEqual(['/a', '/b']);
  });
  it('a volume id is 16 hex, the same for the same root, and never the path', () => {
    expect(volumeId('/media/sam/USB')).toMatch(/^[0-9a-f]{16}$/);
    expect(volumeId('/media/sam/USB')).toBe(volumeId('/media/sam/USB'));
    expect(volumeId('/media/sam/USB')).not.toBe(volumeId('/media/sam/USB2'));
  });
});

describe('listVolumes (real file system)', () => {
  it('lists the override folders that exist, with their free space, and skips the ones that do not', async () => {
    const a = await tmp();
    const b = await tmp();
    const list = await listVolumes({
      platform: process.platform, user: '', env: { HFCM_TRANSFER_ROOTS: [a, join(a, 'missing'), b, a].join(delimiter) },
    });
    expect(list.map((v) => v.root)).toEqual([a, b]);
    expect(list[0]).toMatchObject({ id: volumeId(a), name: a, hasTransfer: false });
    expect(list[0]!.totalBytes).toBeGreaterThan(0);
    expect(list[0]!.freeBytes).toBeGreaterThan(0);
    expect(list[0]!.freeBytes).toBeLessThanOrEqual(list[0]!.totalBytes);
  });
  it('the real search on this machine returns only folders that exist, never the system drive', async () => {
    const list = await listVolumes({ platform: process.platform, user: '', env: { SystemDrive: process.env.SystemDrive } });
    for (const v of list) expect((await stat(v.root)).isDirectory()).toBe(true);
    if (process.platform === 'win32') expect(list.map((v) => v.name)).not.toContain((process.env.SystemDrive ?? 'C:').toUpperCase());
  });
});

describe('export, then load on another machine', () => {
  it('the whole repo arrives byte for byte, laid out as huggingface_hub lays it out, and nothing saved names the drive', async () => {
    const vol = await tmp();
    const a = await machine([vol]);
    await buildRepo(a.hub, REPO, FILES);
    const vols = unwrap(await a.svc.transferVolumes());
    expect(vols).toEqual([expect.objectContaining({ id: volumeId(vol), hasTransfer: false })]);
    expect(errOf(await a.svc.transferDrive(vols[0]!.id)).message).toBe(NO_TRANSFER_TEXT);

    const done = await exportAll(a);
    expect(done).toMatchObject({ status: 'done', message: null, filesDone: 3, filesTotal: 3, bytes: 4000 + 3300 + README.length, repoIds: [REPO] });
    expect(a.events[0]!.status).toBe('running');
    expect(a.events.at(-1)!.status).toBe('done');
    expect((await readdir(vol)).sort()).toEqual(['hf-cache-manager-transfer']);

    const b = await machine([vol]);
    unwrap(await b.svc.scan());
    const seen = unwrap(await b.svc.transferVolumes());
    expect(seen[0]!.hasTransfer).toBe(true);
    const drive = unwrap(await b.svc.transferDrive(seen[0]!.id));
    expect(drive.notes).toEqual([]);
    expect(drive.repos).toEqual([{
      key: `model:${REPO}@${COMMIT}`, repoId: REPO, type: 'model', commitShort: COMMIT.slice(0, 8), ref: 'main',
      exportedAtMs: expect.any(Number), bytes: 4000 + 3300 + README.length, files: 3, incompleteFiles: 0,
    }]);

    const { lookup, id } = await load(b);
    expect(lookup).toMatchObject({ repoId: REPO, revision: 'main', commit: COMMIT, downloadable: true, gated: false });
    expect(lookup.groups.flatMap((g) => g.files.map((f) => f.state))).toEqual(['absent', 'absent', 'absent']);
    const item = unwrap(await b.svc.downloads()).items.find((x) => x.id === id)!;
    expect(item.fromDrive).toBe(true);
    expect(item.files.map((f) => [f.path, f.state, f.error])).toEqual(expect.arrayContaining([
      ['Model-Q4_K_M.gguf', 'done', null], ['Model-Q8_0.gguf', 'done', null], ['README.md', 'done', null],
    ]));

    const folder = join(b.hub, 'models--org--Model-GGUF');
    expect((await readdir(join(folder, 'blobs'))).sort()).toEqual([sha256(Q4), sha256(Q8), gitSha1(README)].sort());
    expect(Buffer.from(await readFile(join(folder, 'blobs', sha256(Q4)))).equals(Buffer.from(Q4))).toBe(true);
    expect(Buffer.from(await readFile(join(folder, 'snapshots', COMMIT, 'Model-Q8_0.gguf'))).equals(Buffer.from(Q8))).toBe(true);
    expect(await readFile(join(folder, 'snapshots', COMMIT, 'README.md'), 'utf8')).toBe(README);
    expect(await readFile(join(folder, 'refs', 'main'), 'utf8')).toBe(COMMIT);
    // The snapshot entry leads to the blob in this cache, never to the drive
    const entry = join(folder, 'snapshots', COMMIT, 'Model-Q4_K_M.gguf');
    const linked = await readlink(entry).catch(() => null);
    if (linked !== null) expect(linked.split(/[\\/]/)).toEqual(['..', '..', 'blobs', sha256(Q4)]);
    // Nothing the app saved names the drive
    for (const name of await readdir(b.userData)) {
      const p = join(b.userData, name);
      if ((await stat(p)).isFile()) expect(await readFile(p, 'utf8')).not.toContain(vol);
    }
    // and the library now lists the repo
    expect(unwrap(await b.svc.scan()).repos.map((r) => r.repoId)).toEqual([REPO]);
  });

  it('reads GGUF shapes from the drive for the advice, with no network', async () => {
    const vol = await tmp();
    const a = await machine([vol]);
    await buildRepo(a.hub, REPO, FILES);
    await exportAll(a);
    // Substitute: the machine profile (a fixed 24 GB GPU instead of running nvidia-smi), so the advice has a GPU to judge for.
    const b = await machine([vol], {
      detectMachine: async () => ({ platform: 'linux', ramBytes: 64e9, gpuName: 'Test GPU', gpuBytes: 24e9, gpuKind: 'nvidia', computeCap: 8.9, drivesDisplay: false }),
    });
    unwrap(await b.svc.redetectMachine());
    unwrap(await b.svc.scan());
    const v = unwrap(await b.svc.transferVolumes())[0]!;
    const lookup = unwrap(await b.svc.transferOpen(v.id, `model:${REPO}@${COMMIT}`));
    expect(lookup.shapesPending).toBe(true);
    const reasonOf = (groups: typeof lookup.advice.groups): string => groups.find((g) => g.key === 'quant:Q4_K_M')!.reason;
    const advice = unwrap(await b.svc.downloadAdvice(lookup.lookupId));
    // The shape comes only from the GGUF header, which here can only have been read from the drive
    expect(reasonOf(advice.groups)).not.toMatch(/shape unknown/i);
    expect(reasonOf(advice.groups)).not.toBe(reasonOf(lookup.advice.groups));
  });

  it('one quant only: exported alone, loaded alone; a later export of the rest adds to the same repo on the drive', async () => {
    const vol = await tmp();
    const a = await machine([vol]);
    await buildRepo(a.hub, REPO, FILES);
    const q4: Selection = { repos: [{ repoId: REPO, whole: false, groupKeys: ['quant:Q4_K_M'], unlockComponents: false }] };
    expect(await exportAll(a, q4)).toMatchObject({ status: 'done', filesTotal: 1, bytes: 4000 });
    const v = unwrap(await a.svc.transferVolumes())[0]!;
    expect(unwrap(await a.svc.transferDrive(v.id)).repos[0]).toMatchObject({ files: 1, bytes: 4000 });

    const again = unwrap(await a.svc.exportPreview(q4, v.id));
    expect(again).toMatchObject({ requiresBytes: 0, files: 0, fits: true, reason: EXPORT_NOTHING_TEXT });
    const rest = unwrap(await a.svc.exportPreview(WHOLE, v.id));
    expect(rest).toMatchObject({ requiresBytes: 3300 + README.length, files: 2, repos: 1, skipped: [] });
    expect((await exportAll(a)).status).toBe('done');
    expect(unwrap(await a.svc.transferDrive(v.id)).repos[0]).toMatchObject({ files: 3 });

    const b = await machine([vol]);
    await load(b, ['quant:Q8_0']);
    const folder = join(b.hub, 'models--org--Model-GGUF');
    expect(await readdir(join(folder, 'blobs'))).toEqual([sha256(Q8)]);
    expect(await readdir(join(folder, 'snapshots', COMMIT))).toEqual(['Model-Q8_0.gguf']);
  });

  it('a ref this cache already has on another revision is left as it is; the files still arrive', async () => {
    const vol = await tmp();
    const a = await machine([vol]);
    await buildRepo(a.hub, REPO, FILES);
    await exportAll(a);
    const b = await machine([vol]);
    const other = 'e'.repeat(40);
    await buildRepo(b.hub, REPO, [{ path: 'Model-Q2_K.gguf', content: bytes(500, 3), lfs: true }], { links: true, commit: other });
    const { id } = await load(b);
    const folder = join(b.hub, 'models--org--Model-GGUF');
    expect(await readFile(join(folder, 'refs', 'main'), 'utf8')).toBe(other);
    expect((await readdir(join(folder, 'snapshots'))).sort()).toEqual([COMMIT, other].sort());
    const item = unwrap(await b.svc.downloads()).items.find((x) => x.id === id)!;
    expect(item.files.every((f) => f.state === 'done')).toBe(true);
    expect(item.files.map((f) => f.error).filter((e) => e !== null)).toEqual(['refs/main already names another revision in this cache; it was not changed']);
  });

  it('a file whose bytes were changed on the drive never enters the cache', async () => {
    const vol = await tmp();
    const a = await machine([vol]);
    await buildRepo(a.hub, REPO, FILES);
    await exportAll(a);
    // Same size, other bytes, in the middle part of the Q4 quant
    const part = join(vol, 'hf-cache-manager-transfer', 'objects', sha256(Q4).slice(0, 2), `${sha256(Q4)}.001`);
    await writeFile(part, bytes(PART, 77));
    const b = await machine([vol]);
    const { id } = await load(b, ['quant:Q4_K_M']);
    const item = unwrap(await b.svc.downloads()).items.find((x) => x.id === id)!;
    expect(item.files[0]).toMatchObject({ path: 'Model-Q4_K_M.gguf', state: 'failed' });
    const folder = join(b.hub, 'models--org--Model-GGUF');
    expect(await readdir(join(folder, 'blobs'))).toEqual([`${sha256(Q4)}.incomplete`]);
    expect(await readdir(join(folder, 'snapshots', COMMIT)).catch(() => [])).toEqual([]);
  });

  it('a drive unplugged between the listing and the start is refused; an unknown volume id is refused', async () => {
    const vol = await tmp();
    const a = await machine([vol]);
    await buildRepo(a.hub, REPO, FILES);
    await exportAll(a);
    const gone = await tmp();
    const b = await machine([gone]);
    unwrap(await b.svc.scan());
    expect(errOf(await b.svc.transferDrive('0'.repeat(16))).message).toBe(VOLUME_GONE_TEXT);
    expect(errOf(await b.svc.exportPreview(WHOLE, '0'.repeat(16))).message).toBe(VOLUME_GONE_TEXT);

    const c = await machine([vol]);
    unwrap(await c.svc.scan());
    const v = unwrap(await c.svc.transferVolumes())[0]!;
    const lookup = unwrap(await c.svc.transferOpen(v.id, `model:${REPO}@${COMMIT}`));
    const preview = unwrap(await c.svc.downloadPreview(lookup.lookupId, ['quant:Q4_K_M']));
    // "Unplug": the drive's record of the repo goes away (the test removes the manifest; the app never deletes one)
    const dir = join(vol, 'hf-cache-manager-transfer', 'manifests');
    const { unlink } = await import('node:fs/promises');
    for (const n of await readdir(dir)) await unlink(join(dir, n));
    expect(errOf(await c.svc.downloadStart(preview.previewId, preview.fingerprint))).toEqual({ code: 'STALE', message: DRIVE_GONE_TEXT });
    expect(await readdir(c.hub)).toEqual([]);
  });
});

describe('export refusals', () => {
  it('too little room: says how much is needed and how much is free, and writes nothing', async () => {
    // Substitute: the free-space reading (statfs) of the drive. A test cannot fill a real disk; everything else is real.
    const vol = await tmp();
    const a = await machine([vol], { download: { statfs: () => Promise.resolve({ bavail: 1000, bsize: 1 }) } });
    await buildRepo(a.hub, REPO, FILES);
    unwrap(await a.svc.scan());
    const v = unwrap(await a.svc.transferVolumes())[0]!;
    const preview = unwrap(await a.svc.exportPreview(WHOLE, v.id));
    expect(preview.fits).toBe(false);
    expect(preview.requiresBytes).toBe(4000 + 3300 + README.length);
    expect(preview.freeBytes).toBe(1000);
    expect(preview.reason).toMatch(/need 7\.3\d? kB .* but only 1\.00? kB is free\. They will not fit\./);
    expect(errOf(await a.svc.exportStart(preview.previewId)).code).toBe('INVALID_INPUT');
    expect(await readdir(vol)).toEqual([]);
  });

  it('a preview is single use, and an unknown one is refused', async () => {
    const vol = await tmp();
    const a = await machine([vol]);
    await buildRepo(a.hub, REPO, FILES);
    unwrap(await a.svc.scan());
    const v = unwrap(await a.svc.transferVolumes())[0]!;
    const preview = unwrap(await a.svc.exportPreview(WHOLE, v.id));
    unwrap(await a.svc.exportStart(preview.previewId));
    expect(errOf(await a.svc.exportStart(preview.previewId)).code).toBe('USED');
    expect(errOf(await a.svc.exportStart('11111111-1111-4111-8111-111111111111')).code).toBe('UNKNOWN_PLAN');
    await a.svc.exportsIdle();
  });

  it('while an export runs, its repo folder is reported as busy and a second export is refused', async () => {
    const vol = await tmp();
    const a = await machine([vol]);
    await buildRepo(a.hub, REPO, FILES);
    unwrap(await a.svc.scan());
    const v = unwrap(await a.svc.transferVolumes())[0]!;
    const one = unwrap(await a.svc.exportPreview(WHOLE, v.id));
    const two = unwrap(await a.svc.exportPreview(WHOLE, v.id));
    const transfer = (a.svc as unknown as { transfer: TransferService }).transfer;
    const starting = a.svc.exportStart(one.previewId);
    unwrap(await starting);
    // Read at once: the export was launched in the same turn that resolved exportStart
    const busy = transfer.activeFolders();
    expect([...busy.values()]).toEqual([REPO]);
    expect([...busy.keys()][0]!.endsWith('models--org--Model-GGUF')).toBe(true);
    expect(EXPORT_ACTIVE_TEXT(REPO)).toContain('is being exported');
    expect(errOf(await a.svc.exportStart(two.previewId)).code).toBe('BUSY');
    await a.svc.exportsIdle();
    expect(transfer.activeFolders().size).toBe(0);
  });

  it('cancel stops a running export and leaves no record on the drive', async () => {
    const vol = await tmp();
    const a = await machine([vol]);
    await buildRepo(a.hub, REPO, FILES);
    unwrap(await a.svc.scan());
    const v = unwrap(await a.svc.transferVolumes())[0]!;
    const preview = unwrap(await a.svc.exportPreview(WHOLE, v.id));
    const { id } = unwrap(await a.svc.exportStart(preview.previewId));
    unwrap(await a.svc.exportCancel(id));
    await a.svc.exportsIdle();
    expect(unwrap(await a.svc.exports())[0]).toMatchObject({ id, status: 'cancelled', message: 'The export was cancelled.' });
    expect(await readdir(join(vol, 'hf-cache-manager-transfer', 'manifests')).catch(() => [])).toEqual([]);
    expect(errOf(await a.svc.exportCancel('11111111-1111-4111-8111-111111111111')).code).toBe('NOT_FOUND');
  });
});
