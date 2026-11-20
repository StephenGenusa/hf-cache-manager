// The drives offered for Export and searched by Load from USB. No OS drive API and no child process is used: a volume
// is found by looking at where each system mounts them, and each is probed with a time limit so an empty card reader
// or a dead network drive never hangs the list.
//   Windows: the root of every drive letter except the system drive.
//   macOS:   every folder in /Volumes on another device than /Volumes itself (which leaves out the link to the system disk).
//   Linux:   the same rule for /media/<user>, /run/media/<user>, /media and /mnt.
// Nothing tells a USB stick from another disk here; the list shows each volume's name and free space and the user picks.
// HFCM_TRANSFER_ROOTS (a path-delimiter separated list of folders) replaces the search: for a drive mounted somewhere
// unusual, and for the E2E suite.
import { createHash } from 'node:crypto';
import { delimiter, join, win32 } from 'node:path';
import { readFs, type ReadFs } from '../../core/fsx';
import { hasTransfer } from '../../core/transfer/drive-reader';

export const PROBE_TIMEOUT_MS = 2_000;

export interface Volume { id: string; root: string; name: string; totalBytes: number; freeBytes: number; hasTransfer: boolean }
export interface VolumeDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The login name, for /media/<user>. */
  user: string;
  fs?: ReadFs;
  timeoutMs?: number;
}

/** A stable id for a root, so the renderer never holds or sends a path. */
export const volumeId = (root: string): string => createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 16);

/** The drive-letter roots to probe on Windows: A: to Z: without the system drive. Pure. */
export function windowsRoots(env: NodeJS.ProcessEnv): string[] {
  const system = (env.SystemDrive ?? env.SYSTEMDRIVE ?? 'C:').slice(0, 2).toUpperCase();
  return Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:`).filter((d) => d !== system).map((d) => `${d}\\`);
}

/** The folders whose children are mount points. Pure. */
export function mountParents(platform: NodeJS.Platform, user: string): string[] {
  if (platform === 'darwin') return ['/Volumes'];
  if (platform === 'win32') return [];
  return [...(user === '' ? [] : [`/media/${user}`, `/run/media/${user}`]), '/media', '/mnt'];
}

/** The children that are volumes of their own: directories on another device than their parent. Pure. */
export function mountedChildren(parentDev: number, children: ReadonlyArray<{ name: string; dev: number; isDirectory: boolean }>): string[] {
  return children.filter((c) => c.isDirectory && c.dev !== parentDev).map((c) => c.name).sort();
}

/** The override list from HFCM_TRANSFER_ROOTS, or null when it is not set. Pure. */
export function overrideRoots(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env.HFCM_TRANSFER_ROOTS;
  if (raw === undefined || raw === '') return null;
  return raw.split(delimiter).map((p) => p.trim()).filter((p) => p !== '');
}

async function within<T>(ms: number, p: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([p.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function candidates(d: VolumeDeps, fs: ReadFs, ms: number): Promise<Array<{ root: string; name: string }>> {
  const fixed = overrideRoots(d.env);
  if (fixed !== null) return fixed.map((root) => ({ root, name: root }));
  if (d.platform === 'win32') return windowsRoots(d.env).map((root) => ({ root, name: root.slice(0, 2) }));
  const out: Array<{ root: string; name: string }> = [];
  for (const parent of mountParents(d.platform, d.user)) {
    const found = await within(ms, (async () => {
      const dev = (await fs.stat(parent)).dev;
      const children = [];
      for (const name of await fs.readdir(parent)) {
        const st = await within(ms, fs.stat(join(parent, name)));
        if (st !== null) children.push({ name, dev: st.dev, isDirectory: st.isDirectory() });
      }
      return mountedChildren(dev, children);
    })());
    for (const name of found ?? []) out.push({ root: join(parent, name), name });
  }
  return out;
}

/** Every volume that answers within the time limit, in the order found, each root once. */
export async function listVolumes(d: VolumeDeps): Promise<Volume[]> {
  const fs = d.fs ?? readFs;
  const ms = d.timeoutMs ?? PROBE_TIMEOUT_MS;
  const seen = new Set<string>();
  const probes = (await candidates(d, fs, ms)).filter((c) => {
    const key = d.platform === 'win32' ? win32.normalize(c.root).toLowerCase() : c.root;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(async (c): Promise<Volume | null> => within(ms, (async () => {
    if (!(await fs.stat(c.root)).isDirectory()) return null;
    const s = await fs.statfs(c.root);
    return {
      id: volumeId(c.root), root: c.root, name: c.name, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize,
      hasTransfer: await hasTransfer(c.root, fs),
    };
  })()));
  return (await Promise.all(probes)).filter((v): v is Volume => v !== null);
}
