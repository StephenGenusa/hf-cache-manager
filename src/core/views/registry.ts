// Ollama registry constants, manifest-path helpers, and the registry client with its cache.
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isPyMap, pyDumpsDefault, pyLoads, pyTruthy, type PyJson } from '../compat/pyjson';
import { isNotFound, readFs, type ReadFs } from '../fsx';
import { resolveTokenPath } from '../paths';
import { SafeFsError, type SafeFs } from '../safe-fs';
import { SkipEntry, type GgufEntry } from './view-types';
import { viewFs } from './walk';

/** Media types (hfhub/ollama_registry.py:13-19). */
export const MT = {
  manifest: 'application/vnd.docker.distribution.manifest.v2+json',
  config: 'application/vnd.docker.container.image.v1+json',
  model: 'application/vnd.ollama.image.model',
  projector: 'application/vnd.ollama.image.projector',
  template: 'application/vnd.ollama.image.template',
  params: 'application/vnd.ollama.image.params',
  license: 'application/vnd.ollama.image.license',
} as const;

/** `manifests/hf.co/<org>/<name>/<tag>` (hfhub/views/ollama.py:27-28). */
export const manifestRel = (repoId: string, tag: string): string => `manifests/hf.co/${repoId}/${tag}`;

/** `blobs/sha256-<hex>` (hfhub/views/ollama.py:23-24). */
export const blobRel = (sha: string): string => `blobs/sha256-${sha}`;

// ---------------------------------------------------------------------------------------------------------------------
// Registry client, cache and token (hfhub/ollama_registry.py, hfhub/views/ollama.py:170-235, hfhub/sync.py:36-44).
// This is the only place sync goes online. HTTP 404/401/400 mean "not found"; any other status or a network failure
// is a SkipEntry. Cache writes happen at once (as in the CLI) through viewFs, so a refusal becomes a SkipEntry too.
// ---------------------------------------------------------------------------------------------------------------------
export const REGISTRY_TIMEOUT_MS = 30_000;
const BLOB_TIMEOUT_MS = 60_000;
const BASE = 'https://huggingface.co/v2';
const CACHE_DIR = '.hfhub-registry';

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) =>
  Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface RegistryCtx {
  root: string; fs: ReadFs; safeFs: SafeFs; fetch: FetchLike; offline: boolean; token: string | null;
  /** Overrides both the 30 s manifest/config and the 60 s blob timeout (tests). */
  timeoutMs?: number;
}

/** Python `str.strip()`: the `str.isspace` characters at either end (U+FEFF is not one of them). */
const PY_SPACE = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');

/** `HF_TOKEN`, else the stripped token file when it is a regular file, else null (hfhub/sync.py:36-44). */
export async function readToken(env: NodeJS.ProcessEnv, home: string, fs: ReadFs = readFs): Promise<string | null> {
  const fromEnv = env['HF_TOKEN'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const file = resolveTokenPath(env, home);
  try {
    if (!(await fs.stat(file)).isFile()) return null;
    return (await fs.readFile(file, 'utf8')).replace(PY_STRIP, '');
  } catch (e) {
    if (isNotFound(e) || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

/** `urllib.parse.quote(relpath, safe="")`: unreserved characters stay, everything else is percent-encoded. */
export function manifestUrl(repoId: string, relpath: string): string {
  const tag = encodeURIComponent(relpath).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${BASE}/${repoId}/manifests/${tag}`;
}

/** View-relative cache files, keyed by the BASENAME of the relpath. */
export function registryCachePaths(repoId: string, relpath: string): { manifest: string; config: string } {
  const base = `${CACHE_DIR}/${repoId}/${relpath.slice(relpath.lastIndexOf('/') + 1)}`;
  return { manifest: `${base}.json`, config: `${base}.config.json` };
}

const NOT_FOUND = new Set([404, 401, 400]);

/** Body bytes, or null for "not found". Anything else, or a rejected promise, is a SkipEntry. */
async function request(ctx: RegistryCtx, url: string, timeout: number, accept: string | null): Promise<Uint8Array | null> {
  const headers: Record<string, string> = {};
  if (accept !== null) headers['Accept'] = accept;
  if (ctx.token !== null && ctx.token !== '') headers['Authorization'] = `Bearer ${ctx.token}`;
  try {
    const res = await ctx.fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(ctx.timeoutMs ?? timeout) });
    if (res.status >= 200 && res.status < 300) return new Uint8Array(await res.arrayBuffer());
    if (NOT_FOUND.has(res.status)) return null;
    throw new SkipEntry(`registry unreachable: HTTP ${res.status}`);
  } catch (e) {
    if (e instanceof SkipEntry) throw e;
    throw new SkipEntry(`registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A regular cache file's bytes, or null when absent / not a regular file (Path.is_file). */
async function readCache(ctx: RegistryCtx, rel: string): Promise<Uint8Array | null> {
  const abs = join(ctx.root, rel);
  try {
    if (!(await ctx.fs.stat(abs)).isFile()) return null;
    return await ctx.fs.readFile(abs);
  } catch (e) {
    if (isNotFound(e) || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

async function writeCache(ctx: RegistryCtx, rel: string, data: string | Uint8Array): Promise<void> {
  const abs = join(ctx.root, rel);
  const vfs = viewFs(ctx.safeFs, ctx.root, ctx.fs);
  try {
    await vfs.mkdirp(dirname(abs));
    await vfs.writeFileAtomic(abs, data);
  } catch (e) {
    if (e instanceof SafeFsError) throw new SkipEntry(`${rel}: ${e.message}; skipped`);
    throw e;
  }
}

/** The registry manifest of `relpath`, or null when the registry (or its cache) says it does not exist. */
export async function registryManifest(ctx: RegistryCtx, repoId: string, relpath: string): Promise<Map<string, PyJson> | null> {
  const rel = registryCachePaths(repoId, relpath).manifest;
  const decode = (bytes: Uint8Array, what: string): PyJson => {
    try {
      return pyLoads(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new SkipEntry(`${rel}: ${what} is not valid JSON; skipped`);
    }
  };
  const cached = await readCache(ctx, rel);
  if (cached !== null) {
    const data = decode(cached, 'cached registry response');
    if (!isPyMap(data)) throw new SkipEntry(`${rel}: cached registry response is not an object; skipped`);
    const missing = data.get('missing');
    return missing !== undefined && pyTruthy(missing) ? null : data;
  }
  if (ctx.offline) throw new SkipEntry('offline and no cached registry response');
  const body = await request(ctx, manifestUrl(repoId, relpath), REGISTRY_TIMEOUT_MS, MT.manifest);
  let manifest: Map<string, PyJson> | null = null;
  if (body !== null) {
    const parsed = decode(body, 'registry response');
    if (!isPyMap(parsed)) throw new SkipEntry(`${repoId}: registry response is not an object; skipped`);
    manifest = parsed;
  }
  await writeCache(ctx, rel, pyDumpsDefault(manifest ?? new Map<string, PyJson>([['missing', true]])));
  return manifest;
}

/** The config blob's raw bytes (an empty body is `{}`), cached beside the manifest cache. */
export async function registryConfig(ctx: RegistryCtx, repoId: string, relpath: string, digest: string): Promise<Uint8Array> {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new SkipEntry(`${repoId}: registry config digest ${digest} is not sha256:<64 hex>; skipped`);
  const rel = registryCachePaths(repoId, relpath).config;
  const cached = await readCache(ctx, rel);
  if (cached !== null) return cached;
  if (ctx.offline) throw new SkipEntry('offline and registry layers not cached');
  const body = await request(ctx, `${BASE}/${repoId}/blobs/${digest}`, BLOB_TIMEOUT_MS, null);
  if (body === null) throw new SkipEntry(`registry unreachable: config blob ${digest} not found`);
  const raw = body.length === 0 ? new TextEncoder().encode('{}') : body;
  await writeCache(ctx, rel, raw);
  return raw;
}

/** A layer blob, verified against its digest. Not cached here: the driver writes it into the view's blobs. */
export async function registryBlob(ctx: RegistryCtx, repoId: string, digest: string): Promise<Uint8Array> {
  if (ctx.offline) throw new SkipEntry('offline and registry layers not cached');
  const body = await request(ctx, `${BASE}/${repoId}/blobs/${digest}`, BLOB_TIMEOUT_MS, null);
  if (body === null) throw new SkipEntry(`registry unreachable: blob ${digest} not found`);
  if (digest !== `sha256:${createHash('sha256').update(body).digest('hex')}`) {
    throw new SkipEntry(`registry blob ${digest} failed its sha256 check; skipped`);
  }
  return body;
}

/** Entries whose cache files would collide: same repo, same basename case-insensitively, non-shard, non-mmproj. key -> warning. */
export function registryCollisions(entries: GgufEntry[]): Map<string, string> {
  const groups = new Map<string, GgufEntry[]>();
  for (const e of entries) {
    if (e.isShard || e.isMmproj) continue;
    const k = `${e.repoId}\u0000${e.basename.toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const out = new Map<string, string>();
  for (const e of entries) {
    const g = groups.get(`${e.repoId}\u0000${e.basename.toLowerCase()}`);
    if (e.isShard || e.isMmproj || g === undefined || g.length < 2) continue;
    out.set(e.key, `${e.key}: registry cache name ${e.basename} collides with ${g.filter((x) => x !== e).map((x) => x.relpath).join(', ')}; skipped`);
  }
  return out;
}
