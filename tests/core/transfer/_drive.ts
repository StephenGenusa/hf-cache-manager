// Shared by the transfer tests: real temp folders (no fixture helper, so these tests also run on Windows), a small real
// cache built by hand the way huggingface_hub lays it out, and the "volumes" the drive tests run against.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { makeTempRoot, removeTempRoot, removeTree } from '../../helpers/tmp';

const made: string[] = [];
const madeOutside: string[] = [];

/** Call once per test file: removes every folder the helpers below made, after each test. */
export function useTempDirs(): void {
  afterEach(async () => {
    for (const d of made.splice(0)) await removeTempRoot(d);
    for (const d of madeOutside.splice(0)) await removeTree(d);
  });
}

export async function tmp(): Promise<string> {
  const d = await makeTempRoot('hfcm-t-');
  made.push(d);
  return d;
}

/**
 * The places a "drive" test runs: always a temp folder on the system disk, plus a real FAT32 and a real exFAT volume
 * when HFCM_TEST_FAT32_DIR / HFCM_TEST_EXFAT_DIR name a folder on one (a throwaway volume: each test makes its own
 * subfolder there and removes it afterwards).
 */
export const VOLUMES: Array<{ name: string; base: string | null }> = [
  { name: 'temp folder', base: null },
  ...(process.env.HFCM_TEST_FAT32_DIR ? [{ name: 'FAT32 volume', base: process.env.HFCM_TEST_FAT32_DIR }] : []),
  ...(process.env.HFCM_TEST_EXFAT_DIR ? [{ name: 'exFAT volume', base: process.env.HFCM_TEST_EXFAT_DIR }] : []),
];

/** A fresh folder standing for a volume root. */
export async function volume(base: string | null): Promise<string> {
  if (base === null) return tmp();
  const d = await mkdtemp(join(base, 'hfcm-vol-'));
  madeOutside.push(d);
  return d;
}

export const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');
export const gitSha1 = (b: string | Uint8Array): string =>
  createHash('sha1').update(`blob ${typeof b === 'string' ? Buffer.byteLength(b) : b.length}\0`).update(b).digest('hex');

/** Deterministic bytes, different for every seed. */
export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed * 2654435761 % 4294967296;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1664525 + 1013904223) % 4294967296;
    out[i] = x >>> 24;
  }
  return out;
}

export const COMMIT = 'c'.repeat(40);

export interface CacheFile { path: string; content: string | Uint8Array; lfs: boolean }

/**
 * <hub>/models--<org>--<name> with blobs/, snapshots/<commit>/ and refs/main. `links` true: snapshot entries are
 * relative symlinks to the blobs (the normal cache). false: plain copies beside the blobs (a cache without symlinks).
 */
export async function buildRepo(hub: string, repoId: string, files: CacheFile[], opts: { links: boolean; commit?: string; ref?: string | null } = { links: true }): Promise<string> {
  const commit = opts.commit ?? COMMIT;
  const folder = join(hub, `models--${repoId.replace('/', '--')}`);
  await mkdir(join(folder, 'blobs'), { recursive: true });
  await mkdir(join(folder, 'snapshots', commit), { recursive: true });
  for (const f of files) {
    const etag = f.lfs ? sha256(f.content) : gitSha1(f.content);
    await writeFile(join(folder, 'blobs', etag), f.content, { flag: 'w' });
    const entry = join(folder, 'snapshots', commit, ...f.path.split('/'));
    await mkdir(dirname(entry), { recursive: true });
    if (opts.links) {
      const up = Array<string>(f.path.split('/').length + 1).fill('..');
      await symlink(join(...up, 'blobs', etag), entry, 'file');
    } else await writeFile(entry, f.content);
  }
  if (opts.ref !== null) {
    await mkdir(join(folder, 'refs'), { recursive: true });
    await writeFile(join(folder, 'refs', opts.ref ?? 'main'), commit);
  }
  return folder;
}
