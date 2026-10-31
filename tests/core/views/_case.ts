import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { HfhubConfig } from '../../../src/core/compat/config';
import { loadConfig } from '../../../src/core/compat/config';
import type { FsLike } from '../../../src/core/fsx';
import { SafeFs } from '../../../src/core/safe-fs';
import { scanHub } from '../../../src/core/scan/scanner';
import type { GgufEntry } from '../../../src/core/views/view-types';
import type { CacheModel, Op } from '../../../src/core/types';
import { buildCase, type BuiltCase, type CaseSpec } from '../../golden/build-fixture.mjs';
import { guardedFs } from '../../helpers/guarded-fs';
import { tempDir } from '../_temp';

export { ggufBytes, sha256Hex } from '../../golden/build-fixture.mjs';
export type { BuiltCase, CaseSpec } from '../../golden/build-fixture.mjs';

export interface LoadedCase {
  c: BuiltCase;
  model: CacheModel;      // scanHub(realpath(c.hub))
  config: HfhubConfig;    // loadConfig(c.env, c.home)
  safeFs: SafeFs;         // roots: realpath hub + the view roots that exist
  fs: FsLike;            // guardedFs()
}

/** Needs useCanaries() in the calling test file (tempDir). */
export async function loadCase(spec: CaseSpec): Promise<LoadedCase> {
  const c = await buildCase(await tempDir(), spec);
  const fs = guardedFs();
  const hub = await realpath(c.hub);
  const model = await scanHub(hub);
  const config = await loadConfig(c.env, c.home);
  const viewRoots: string[] = [];
  for (const root of [c.lmstudio, c.ollama]) {
    if (root === null) continue;
    try {
      viewRoots.push(await realpath(root));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  const safeFs = await SafeFs.create({ hubRoot: hub, viewRoots, holdRoot: null }, fs);
  return { c, model, config, safeFs, fs };
}

/** A GgufEntry with plausible defaults; `relpath` drives `basename`, `key` and the flags unless overridden. */
export function entry(partial: Partial<GgufEntry> = {}): GgufEntry {
  const repoId = partial.repoId ?? 'acme/Tiny-GGUF';
  const relpath = partial.relpath ?? 'Tiny-Q4_K_M.gguf';
  const sha256 = partial.sha256 ?? 'a'.repeat(64);
  const folderName = partial.folderName ?? `models--${repoId.replaceAll('/', '--')}`;
  return {
    key: `${repoId}:${relpath}`,
    repoId,
    folderName,
    relpath,
    basename: relpath.slice(relpath.lastIndexOf('/') + 1),
    blobPath: join('/hub', folderName, 'blobs', sha256),
    sha256,
    size: 1,
    isMmproj: relpath.toLowerCase().includes('mmproj'),
    isShard: false,
    isCurrent: true,
    ...partial,
  };
}

/** Absolute repo-blob paths of every blob of `repoId` (what a delete of the whole repo would doom). */
export function doomRepo(model: CacheModel, repoId: string): string[] {
  const repo = model.repos.find((r) => r.id === repoId);
  if (!repo) throw new Error(`doomRepo: no repo ${repoId}`);
  return Object.values(repo.blobs).map((b) => b.path);
}

/** Runs view ops through SafeFs, in order: unlink, rmdir-empty and write-file. Anything else is a test bug. */
export async function applyViewOps(ops: Op[], safeFs: SafeFs): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'unlink') await safeFs.unlink(op.path, op.expect);
    else if (op.kind === 'rmdir-empty') await safeFs.rmdirEmpty(op.path);
    else if (op.kind === 'write-file') await safeFs.writeFileAtomic(op.path, op.after);
    else throw new Error(`applyViewOps: unsupported op ${op.kind}`);
  }
}

// ---------- fetch doubles (structurally the FetchLike of registry.ts) ----------
export interface FetchInit { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }
export type FetchResult = { status: number; arrayBuffer(): Promise<ArrayBuffer> };
export type FetchFn = (url: string, init: FetchInit) => Promise<FetchResult>;
export type RecordingFetch = FetchFn & { calls: Array<{ url: string; init: FetchInit }> };

const toBuffer = (body: string | Uint8Array): ArrayBuffer => {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/** Records its calls; answers `{status, body}`, or rejects when given an Error (a network failure). */
export function fakeFetch(reply: { status: number; body?: string | Uint8Array } | Error): RecordingFetch {
  const calls: RecordingFetch['calls'] = [];
  const f: FetchFn = async (url, init) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return { status: reply.status, arrayBuffer: async () => toBuffer(reply.body ?? '') };
  };
  return Object.assign(f, { calls });
}

/** Never answers; rejects with an AbortError when `init.signal` aborts (so a timeout test finishes). */
export function hangingFetch(): RecordingFetch {
  const calls: RecordingFetch['calls'] = [];
  const f: FetchFn = (url, init) =>
    new Promise<FetchResult>((_resolve, reject) => {
      calls.push({ url, init });
      const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    });
  return Object.assign(f, { calls });
}
