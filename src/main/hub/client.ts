// Hub client: the revision API, streaming resolve with manual redirects, range reads for GGUF headers.
// Network code lives only in src/main/hub/. The token goes out only through authHeader, per hop.
import { z } from 'zod';
import type { ReadAt } from '../../core/views/gguf-header';
import { encodeRevision, isCommitHash, safeRef, type HubRepoType } from '../../shared/hub-input';
import { isE2E } from '../env-guard';
import { authHeader, checkRedirect, isLoopbackHost, type HubEndpoint } from './policy';

export interface HubSibling { path: string; size: number | null; etag: string | null; lfs: boolean }
export interface HubRevision {
  repoId: string; type: HubRepoType; commit: string; gated: boolean; private: boolean;
  lastModified: string | null; siblings: HubSibling[];
}
/** RANGE_IGNORED: the server answered a request from past byte 0 with the whole file (status 200); it cannot resume. */
export type HubError = {
  code: 'NOT_FOUND' | 'GATED' | 'UNAUTHORIZED' | 'NETWORK' | 'SERVER' | 'OFFLINE' | 'BAD_RESPONSE' | 'RANGE_IGNORED' | 'NETWORK_BLOCKED';
  message: string;
};

export class HubClientError extends Error {
  constructor(readonly error: HubError) {
    super(error.message);
    this.name = 'HubClientError';
  }
  get code(): HubError['code'] { return this.error.code; }
}

export interface HubClient {
  revision(repoId: string, type: HubRepoType, revision: string): Promise<HubRevision>;
  /**
   * `size` is the whole file's size (Content-Range total on 206, Content-Length on 200), null when not given.
   * A 200 to a range request (fromByte > 0) is refused as RANGE_IGNORED ("The server cannot resume this file").
   * To drop a body without reading it, abort `signal`: a body never iterated is not cancelled otherwise.
   */
  open(repoId: string, type: HubRepoType, commit: string, path: string, fromByte: number, signal: AbortSignal):
    Promise<{ status: 200 | 206; body: AsyncIterable<Uint8Array>; size: number | null }>;
  readAt(repoId: string, type: HubRepoType, commit: string, path: string): ReadAt;
}

export interface HubClientDeps {
  endpoint: HubEndpoint;
  token: string | null;
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Tests only: shorten the spec's 15 s connect / 60 s idle timeouts. */
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

let blocked = 0;
/** Requests hubFetch refused under E2E. Read by the E2E harness only (bootstrap exposes it there). */
export const networkBlockedCount = (): number => blocked;

const urlOf = (input: Parameters<typeof fetch>[0]): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
function isLoopbackUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The production fetch, for callers outside src/main/hub/ that must not name the global themselves.
 * Under E2E (HFCM_E2E / HFCM_E2E_ROOT) any URL that is not loopback is refused with
 * NETWORK_BLOCKED and counted, before anything is sent: an E2E run can never reach the real Hub or any other host.
 */
export const hubFetch: typeof fetch = (input, init) => {
  if (isE2E(process.env) && !isLoopbackUrl(urlOf(input))) {
    blocked += 1;
    return Promise.reject(new HubClientError({ code: 'NETWORK_BLOCKED', message: `E2E: refusing a request that is not to a loopback address (${urlOf(input)})` }));
  }
  return globalThis.fetch(input, init);
};

export const CONNECT_TIMEOUT_MS = 15_000;
export const IDLE_TIMEOUT_MS = 60_000;
export const RETRIES = 3;
const BACKOFF_MS = [1_000, 2_000, 4_000];
export const HEADER_CHUNK = 1024 * 1024;
export const HEADER_CAP = 32 * 1024 * 1024;
export const MAX_SIBLINGS = 100_000;
export const MAX_PATH = 4096;
/** 100,000 siblings with LFS entries are ~30 MB of JSON; anything past this is not a listing. */
const MAX_API_BYTES = 64 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const API_KIND: Record<HubRepoType, string> = { model: 'models', dataset: 'datasets', space: 'spaces' };
const RESOLVE_PREFIX: Record<HubRepoType, string> = { model: '', dataset: 'datasets/', space: 'spaces/' };
const NOT_FOUND_CODES = new Set(['RepositoryNotFound', 'RevisionNotFound', 'EntryNotFound']);
const OVER_BUDGET = 'GGUF header reads passed their 32 MiB transfer budget';
const GATED_MSG = 'Gated: accept the terms on huggingface.co and make sure your token is set';

const size = z.int().min(0);
const SiblingSchema = z.object({
  rfilename: z.string().min(1).max(MAX_PATH),
  size: size.nullish(),
  blobId: z.string().regex(/^[0-9a-f]{40}$/).nullish(),
  lfs: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: size.nullish() }).nullish(),
});
const RevisionSchema = z.object({
  sha: z.string().refine(isCommitHash),
  gated: z.union([z.boolean(), z.string()]).nullish(),
  private: z.boolean().nullish(),
  lastModified: z.string().nullish(),
  siblings: z.array(SiblingSchema).max(MAX_SIBLINGS),
});

class Timeout extends Error {}

const bad = (message: string): HubClientError => new HubClientError({ code: 'BAD_RESPONSE', message });
const segmentsOk = (p: string): boolean => p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

function repoPath(repoId: string): string {
  if (repoId.split('/').length !== 2 || !segmentsOk(repoId)) throw new TypeError(`Invalid repo id: '${repoId}'`);
  return encodePath(repoId);
}

function statusError(res: Response): HubClientError {
  const code = res.headers.get('x-error-code') ?? '';
  if (code === 'GatedRepo') return new HubClientError({ code: 'GATED', message: GATED_MSG });
  if (res.status === 404 || NOT_FOUND_CODES.has(code)) return new HubClientError({ code: 'NOT_FOUND', message: 'Not found on the Hub' });
  if (res.status === 401 || res.status === 403) {
    return new HubClientError({ code: 'UNAUTHORIZED', message: `The Hub refused access (HTTP ${res.status}); check your token` });
  }
  if (res.status >= 500) return new HubClientError({ code: 'SERVER', message: `The Hub had an error (HTTP ${res.status})` });
  if (res.status === 429) return bad('The Hub is rate-limiting requests (HTTP 429); try again later');
  return bad(`Unexpected HTTP ${res.status} from the Hub`);
}

const discard = async (res: Response): Promise<void> => { await res.body?.cancel().catch(() => undefined); };

function contentLength(res: Response): number | null {
  const v = res.headers.get('content-length');
  return v !== null && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
}

/** `bytes <start>-<end>/<total|*>` → start and total (null for `*`). */
function contentRange(res: Response): { start: number; total: number | null } | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '');
  if (!m) return null;
  return { start: Number(m[1]), total: m[3] === '*' ? null : Number(m[3]) };
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const IGNORED_RANGE = 'The server ignored the byte range';
const CANNOT_RESUME = 'The server cannot resume this file';
const rangeIgnored = (message: string): HubClientError => new HubClientError({ code: 'RANGE_IGNORED', message });

/** Resolves when `signal` aborts (the backoff wait ends at once on pause or cancel). */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));

export function createHubClient(d: HubClientDeps): HubClient {
  const ep = d.endpoint;
  const sleep = d.sleep ?? defaultSleep;
  const connectMs = d.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const idleMs = d.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  /** One attempt: the request and its redirects, each hop with its own Authorization decision and connect timer. */
  async function send(start: string, headers: Record<string, string>, ctl: AbortController, signal: AbortSignal): Promise<Response> {
    let url = start;
    for (let hop = 0; ; hop++) {
      const timer = setTimeout(() => ctl.abort(new Timeout(`The Hub did not answer within ${connectMs / 1000} s (timed out)`)), connectMs);
      let res: Response;
      try {
        res = await d.fetch(url, { method: 'GET', headers: { ...headers, ...authHeader(url, ep, d.token) }, redirect: 'manual', signal });
      } finally {
        clearTimeout(timer);
      }
      if (!REDIRECTS.has(res.status)) return res;
      await discard(res);
      const location = res.headers.get('location');
      if (location === null) throw bad(`Redirect (HTTP ${res.status}) without a location`);
      const next = checkRedirect(url, location, ep, hop + 1);
      if (!next.ok) throw bad(next.reason);
      url = next.url;
    }
  }

  /** Network errors and 5xx are retried RETRIES times with backoff; anything else is returned or thrown at once. */
  async function request(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ res: Response; ctl: AbortController }> {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw signal.reason;
      const ctl = new AbortController();
      let failure: HubClientError;
      try {
        const res = await send(url, headers, ctl, AbortSignal.any([signal, ctl.signal]));
        if (res.status < 500) return { res, ctl };
        await discard(res);
        failure = statusError(res);
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        if (e instanceof HubClientError) throw e;
        const why = ctl.signal.reason instanceof Timeout ? ctl.signal.reason.message : `Network error: ${e instanceof Error ? e.message : String(e)}`;
        failure = new HubClientError({ code: 'NETWORK', message: why });
      }
      if (attempt >= RETRIES) throw failure;
      await Promise.race([sleep(BACKOFF_MS[attempt]!), aborted(signal)]);
    }
  }

  /** The body, failing with NETWORK when no chunk arrives for idleMs. The timer runs only while waiting on the server. */
  async function* stream(res: Response, ctl: AbortController, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    if (!res.body) return;
    const reader = res.body.getReader();
    let done = false;
    try {
      for (;;) {
        const timer = setTimeout(() => ctl.abort(new Timeout(`No data from the Hub for ${idleMs / 1000} s`)), idleMs);
        let r: Awaited<ReturnType<typeof reader.read>>;
        try {
          r = await reader.read();
        } catch (e) {
          if (signal.aborted) throw signal.reason;
          const why = ctl.signal.reason instanceof Timeout ? ctl.signal.reason.message : `Connection lost: ${e instanceof Error ? e.message : String(e)}`;
          throw new HubClientError({ code: 'NETWORK', message: why });
        } finally {
          clearTimeout(timer);
        }
        if (r.done) { done = true; return; }
        yield r.value;
      }
    } finally {
      if (!done) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  function resolveUrl(repoId: string, type: HubRepoType, commit: string, path: string): string {
    if (!isCommitHash(commit)) throw new TypeError(`Not a commit hash: '${commit}'`);
    if (path.length === 0 || path.length > MAX_PATH || !segmentsOk(path)) throw bad(`Unsafe file path: '${path}'`);
    return `${ep.base}/${RESOLVE_PREFIX[type]}${repoPath(repoId)}/resolve/${commit}/${encodePath(path)}`;
  }

  async function readJson(res: Response, ctl: AbortController, signal: AbortSignal): Promise<unknown> {
    const parts: Uint8Array[] = [];
    let n = 0;
    for await (const chunk of stream(res, ctl, signal)) {
      n += chunk.length;
      if (n > MAX_API_BYTES) throw bad('The Hub listing is too large');
      parts.push(chunk);
    }
    try {
      return JSON.parse(new TextDecoder().decode(concat(parts)));
    } catch {
      throw bad('The Hub listing is not JSON');
    }
  }

  async function revision(repoId: string, type: HubRepoType, rev: string): Promise<HubRevision> {
    if (!safeRef(rev) && !isCommitHash(rev)) throw new TypeError(`Invalid revision: '${rev}'`);
    const url = `${ep.base}/api/${API_KIND[type]}/${repoPath(repoId)}/revision/${encodeRevision(rev)}?blobs=true`;
    const signal = new AbortController().signal;
    const { res, ctl } = await request(url, { Accept: 'application/json' }, signal);
    if (res.status !== 200) {
      await discard(res);
      throw statusError(res);
    }
    const parsed = RevisionSchema.safeParse(await readJson(res, ctl, signal));
    if (!parsed.success) throw bad('The Hub listing is not in the expected format');
    const v = parsed.data;
    if (isCommitHash(rev) && v.sha.toLowerCase() !== rev.toLowerCase()) throw bad(`The Hub answered commit ${rev} with ${v.sha}`);
    const paths = new Set<string>();
    const siblings = v.siblings.map((s): HubSibling => {
      if (paths.has(s.rfilename)) throw bad(`The Hub listing names '${s.rfilename}' twice`);
      paths.add(s.rfilename);
      const lfs = s.lfs != null;
      return { path: s.rfilename, size: s.size ?? s.lfs?.size ?? null, etag: lfs ? s.lfs!.sha256 : s.blobId ?? null, lfs };
    });
    return {
      repoId, type, commit: v.sha.toLowerCase(),
      gated: v.gated != null && v.gated !== false, private: v.private === true,
      lastModified: v.lastModified ?? null, siblings,
    };
  }

  async function open(repoId: string, type: HubRepoType, commit: string, path: string, fromByte: number, signal: AbortSignal) {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0) throw new RangeError(`Invalid fromByte: ${fromByte}`);
    const url = resolveUrl(repoId, type, commit, path);
    const headers: Record<string, string> = { 'Accept-Encoding': 'identity', ...(fromByte > 0 ? { Range: `bytes=${fromByte}-` } : {}) };
    const { res, ctl } = await request(url, headers, signal);
    if (res.status === 200 && fromByte > 0) {
      await discard(res);
      throw rangeIgnored(CANNOT_RESUME);
    }
    if (res.status === 200) return { status: 200 as const, body: stream(res, ctl, signal), size: contentLength(res) };
    if (res.status === 206) {
      const cr = contentRange(res);
      if (!cr || cr.start !== fromByte) {
        await discard(res);
        throw bad(`The server answered a range request from byte ${fromByte} with '${res.headers.get('content-range') ?? 'no Content-Range'}'`);
      }
      return { status: 206 as const, body: stream(res, ctl, signal), size: cr.total };
    }
    await discard(res);
    throw statusError(res);
  }

  /**
   * Bytes [pos, pos + n) of the file (fewer at its end), one request of at most HEADER_CHUNK. Every byte received
   * counts against the handle's `budget` (HEADER_CAP in all), whatever the server sends.
   */
  async function rangeRead(url: string, pos: number, n: number, budget: { used: number }): Promise<Uint8Array> {
    if (budget.used >= HEADER_CAP) throw bad(OVER_BUDGET);
    const signal = new AbortController().signal;
    const { res, ctl } = await request(url, { 'Accept-Encoding': 'identity', Range: `bytes=${pos}-${pos + n - 1}` }, signal);
    if (res.status === 206) {
      const cr = contentRange(res);
      if (!cr || cr.start !== pos) {
        await discard(res);
        throw bad('The server answered a range request with the wrong range');
      }
    } else if (res.status === 200 && pos > 0) {
      await discard(res);
      throw rangeIgnored(IGNORED_RANGE);   // re-reading the prefix for every chunk would break the 32 MiB bound
    } else if (res.status === 200) {
      // pos 0: the wanted bytes are a prefix of the whole file; read n of them and stop
    } else if (res.status === 416) {
      await discard(res);
      return new Uint8Array(0);
    } else {
      await discard(res);
      throw statusError(res);
    }
    const parts: Uint8Array[] = [];
    let have = 0;
    const body = stream(res, ctl, signal);
    for await (const c of body) {
      budget.used += c.length;
      if (budget.used > HEADER_CAP) throw bad(OVER_BUDGET);   // leaving the loop cancels the rest of the body
      parts.push(c.subarray(0, n - have));
      have += Math.min(c.length, n - have);
      if (have >= n) break;
    }
    return concat(parts);
  }

  function readAt(repoId: string, type: HubRepoType, commit: string, path: string): ReadAt {
    const url = resolveUrl(repoId, type, commit, path);
    const budget = { used: 0 };
    return async (offset, length) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
        throw new RangeError(`Invalid read: ${offset}+${length}`);
      }
      if (offset >= HEADER_CAP) throw bad('GGUF header reads stop at 32 MiB');
      const end = Math.min(offset + length, HEADER_CAP);
      const parts: Uint8Array[] = [];
      for (let pos = offset; pos < end;) {
        const n = Math.min(HEADER_CHUNK, end - pos);
        const got = await rangeRead(url, pos, n, budget);
        parts.push(got);
        pos += got.length;
        if (got.length < n) break;
      }
      return parts.length === 0 ? new Uint8Array(0) : concat(parts);
    };
  }

  return { revision, open, readAt };
}
