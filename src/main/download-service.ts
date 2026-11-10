// Download mode services (items 5, 7, 10, 11).
// look up → preview → start, the deletion pattern: a look-up keeps the Hub listing in main under a uuid (10 minutes),
// the renderer sends back only that id and group keys. A look-up returns at once with format/tool advice; the GGUF
// shapes (Hub range reads, 4 at a time) come from downloadAdvice(lookupId). A preview is fingerprinted (the commit, the
// chosen files with their etags, and the on-disk facts of exactly what they would touch) and single use; downloadStart
// re-reads the Hub revision (one API call) and those facts, and refuses a moved commit or changed facts with "look up
// again". The engine (built at service start, restoring the saved queue) runs in the background, outside the
// services' operation mutex (its AppLock serializes commits with deletions and sync).
// Network access only through the hub client, which gets `hubFetch`.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AdviceSettings, MachineProfile } from '../core/advice/types';
import { classifyRepo } from '../core/classify/classify';
import type { HfhubConfig } from '../core/compat/config';
import { fileStates, requiresBytes, unchangedLinks, type FileState } from '../core/download/cache-state';
import { remoteRepo, repoFolderName, toRemoteListing, type RemoteListing } from '../core/download/remote-repo';
import { shapeFromHeaders, type ModelShape } from '../core/advice/shape';
import { factsOf, isNotFound, type ReadFs } from '../core/fsx';
import { hashCanonical } from '../core/plan/fingerprint';
import type { CacheModel, Group, Repo, RepoType, RepoView } from '../core/types';
import { readGgufHeader, type GgufHeader } from '../core/views/gguf-header';
import { readToken } from '../core/views/registry';
import type {
  ApiError, ApiErrorCode, ApiResult, DownloadDoneDTO, DownloadFileDTO, DownloadGroupDTO, DownloadItemDTO, DownloadPreviewDTO,
  DownloadProgressDTO, DownloadsDTO, HubLookupDTO, RecentLookupDTO, RepoAdviceDTO,
} from '../shared/api';
import { formatBytes } from '../shared/format';
import { isCommitHash, parseHubInput } from '../shared/hub-input';
import { HEADER_KINDS, headerFiles, repoAdvice, type ShapeCache } from './advice-service';
import { queueUnreadable, type AppSettingsStore } from './app-settings';
import { GGUF_ARRAY_ITEMS, type CorePort } from './core-port';
import { DownloadEngine, FREE_MARGIN } from './download/engine';
import { MAX_RECENT_LOOKUPS, type QueueItem, type RecentLookup } from './download/queue';
import { badgeFor } from './dto';
import { isE2E } from './env-guard';
import { createHubClient, HubClientError, hubFetch, type HubClient } from './hub/client';
import { endpointFromEnv, type HubEndpoint } from './hub/policy';

/** Look-ups and previews live this long (like deletion plans). */
export const DOWNLOAD_TTL_MS = 10 * 60_000;
/** GGUF header reads from the Hub running at once for one downloadAdvice call. */
export const HEADER_READS_AT_ONCE = 4;
/** File states in which the engine may be writing the file's .incomplete right now. */
const WRITING = new Set(['queued', 'waiting-other', 'downloading', 'verifying']);

export const OFFLINE_TEXT = 'Offline mode is on (HF_HUB_OFFLINE)';
export const E2E_ENDPOINT_TEXT =
  'Download mode is off: under the E2E suite HF_ENDPOINT must be a loopback address (http://127.0.0.1, http://localhost or http://[::1])';
/** The reactive fit check makes many previews; only the newest this many stay usable. */
export const MAX_PREVIEWS = 50;
export const GATED_TEXT = 'Gated: accept the terms on huggingface.co and make sure your token is set';
export const LOOKUP_GONE_TEXT = 'This look-up expired — look up again.';
export const PREVIEW_GONE_TEXT = 'This download preview expired — look up again.';
export const PREVIEW_USED_TEXT = 'This download preview was already used — look up again.';
export const MOVED_TEXT = 'The repo changed on the Hub since the look-up; look up again.';
export const CHANGED_TEXT = 'The cache changed since the preview; look up again.';
export const ALL_CACHED_TEXT = 'Everything selected is already in the cache.';
export const ALL_QUEUED_TEXT = 'Everything selected is already in the cache or in the download queue.';
export const DL_BUSY_TEXT = 'A deletion or sync is running — start the download when it finishes.';
export const RESUME_BUSY_TEXT = 'A deletion or sync is running — resume the download when it finishes.';
export const UNVERIFIABLE_TEXT = 'These files cannot be verified (the Hub lists no size or hash for them), so they cannot be downloaded.';
export const REFUSED_TEXT = 'These Hub entries were refused (an unsafe path or a malformed size or hash), so they cannot be downloaded.';
export const INCOMPLETE_SET_TEXT = (present: number, expected: number): string =>
  `Only ${present} of ${expected} shards are listed on the Hub; an incomplete set cannot be downloaded.`;
export const NO_ROOM_TEXT = (need: number, free: number, where: string): string =>
  `Needs ${formatBytes(need)}, but ${formatBytes(free)} is free on ${where} and ${formatBytes(FREE_MARGIN)} must stay free.`;
const UNVERIFIABLE_KEY = 'unverifiable:files';
const REFUSED_KEY = 'refused:files';

/** What the download services need from AppServices (the scan state, the advice context, the mutex, the rescan). */
export interface DownloadHost {
  env: NodeJS.ProcessEnv;
  home: string;
  now: () => number;
  fs: ReadFs;
  port: CorePort;
  settings: AppSettingsStore;
  /** The last scan's model, scanning first when none has run; else why the cache cannot be used. */
  model(): Promise<ApiResult<CacheModel>>;
  /** An execute or sync is running (BUSY for downloadStart). */
  opRunning(): boolean;
  /** The library rescan after a finished download. */
  rescan(): Promise<void>;
  symlinksSupported(): Promise<boolean>;
  adviceContext(): Promise<{ machine: MachineProfile; settings: AdviceSettings; config: HfhubConfig | null }>;
  emitProgress(e: DownloadProgressDTO): void;
  emitDone(e: DownloadDoneDTO): void;
}

/** Test seams (the production composition sets none of them). */
export interface DownloadOptions {
  /** Default `hubFetch` (the only production route to the network). */
  fetch?: typeof fetch;
  statfs?: (p: string) => Promise<{ bavail: number; bsize: number }>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  clientSleep?: (ms: number) => Promise<void>;
}

interface Lookup {
  listing: RemoteListing; revision: string; gated: boolean; expiresAt: number;
  blocked: ApiError | null; groups: Map<string, DownloadGroupDTO>;
  repo: Repo; view: RepoView;
  /** Shapes read for this look-up, by sorted etag list (only facts of the content; failed reads are dropped). */
  shapes: ShapeCache;
  /** Gated and no token at look-up time: no header is requested. */
  noToken: boolean;
}
interface Preview {
  hubRoot: string; listing: RemoteListing; revision: string; paths: string[]; fingerprint: string; fits: boolean; reason: string | null;
  expiresAt: number; used: boolean;
}

const fail = (code: ApiErrorCode, message: string): { ok: false; error: ApiError } => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });

/** Why download mode is off, from the environment alone, or the endpoint to use. */
export function downloadMode(env: NodeJS.ProcessEnv): { ok: true; endpoint: HubEndpoint } | { ok: false; reason: string } {
  // the default endpoint always parses, so this reads HF_HUB_OFFLINE exactly as policy.ts does, whatever HF_ENDPOINT is
  const flag = endpointFromEnv({ HF_HUB_OFFLINE: env.HF_HUB_OFFLINE });
  if ('offline' in flag && flag.offline) return { ok: false, reason: OFFLINE_TEXT };
  const r = endpointFromEnv(env);
  if ('error' in r) return { ok: false, reason: `Download mode is off: ${r.error}` };
  if (isE2E(env) && !r.endpoint.loopbackHttp) return { ok: false, reason: E2E_ENDPOINT_TEXT };
  return { ok: true, endpoint: r.endpoint };
}

/** A Hub client error as the API reports it. Anything else is rethrown (INTERNAL). */
function hubFailure(e: unknown): { ok: false; error: ApiError } {
  if (e instanceof HubClientError) {
    switch (e.code) {
      case 'NOT_FOUND': return fail('NOT_FOUND', e.message);
      case 'GATED':
      case 'UNAUTHORIZED': return fail('GATED', GATED_TEXT);
      case 'OFFLINE': return fail('OFFLINE', e.message);
      default: return fail('NETWORK', e.message);
    }
  }
  throw e;   // anything else (a bug, an unexpected error) is INTERNAL, never "bad input"
}

const stateDto = (s: FileState | undefined, size: number): Pick<DownloadFileDTO, 'state' | 'have'> =>
  s === undefined || s.kind === 'absent' ? { state: 'absent', have: 0 }
    : s.kind === 'cached' ? { state: 'cached', have: size }
      : s.kind === 'partial' ? { state: 'partial', have: s.have } : { state: 'update', have: 0 };

/**
 * The listing's paths an unfinished download of the same repo and commit already fetches (and will link). Another
 * commit's download links only its own snapshot, so its files are not counted.
 */
function queuedEtags(items: readonly QueueItem[], listing: RemoteListing): Set<string> {
  const etags = new Set<string>();
  for (const i of items) {
    if (i.repoId !== listing.repoId || i.type !== listing.type || i.commit !== listing.commit) continue;
    for (const f of i.files) if (f.state !== 'done') etags.add(f.etag);
  }
  return new Set(listing.files.filter((f) => etags.has(f.etag)).map((f) => f.path));
}

/** The look-up's groups: the classifier's, in order, then the files that can never be downloaded (not selectable). */
export function downloadGroups(listing: RemoteListing, view: RepoView, states: Map<string, FileState>): DownloadGroupDTO[] {
  const byPath = new Map(listing.files.map((f) => [f.path, f]));
  const out = view.groups.map((g: Group): DownloadGroupDTO => {
    const files = g.files.flatMap((sf) => {
      const f = byPath.get(sf.relpath);
      return f === undefined ? [] : [{ path: f.path, size: f.size, ...stateDto(states.get(f.path), f.size) }];
    });
    const complete = g.shards === undefined || g.shards.present >= g.shards.expected;
    return {
      key: g.key, kind: g.kind, label: g.label, files, requiresBytes: requiresBytes(listing, states, files.map((f) => f.path)),
      complete, selectable: complete && files.length > 0,
      reason: complete ? null : INCOMPLETE_SET_TEXT(g.shards!.present, g.shards!.expected),
    };
  });
  const never = (key: string, label: string, paths: string[], reason: string): DownloadGroupDTO => ({
    key, kind: 'other', label, files: paths.map((path) => ({ path, size: 0, state: 'absent', have: 0 })),
    requiresBytes: 0, complete: true, selectable: false, reason,
  });
  if (listing.unverifiable.length > 0) out.push(never(UNVERIFIABLE_KEY, 'Cannot be verified', listing.unverifiable, UNVERIFIABLE_TEXT));
  if (listing.refused.length > 0) out.push(never(REFUSED_KEY, 'Refused', listing.refused, REFUSED_TEXT));
  return out;
}

/**
 * Narrowed: the chosen files at the commit, and the on-disk facts (null when absent) of exactly what
 * they would touch: each file's blob, its blobs/<etag>.incomplete, its snapshots/<commit>/<path> entry, and
 * refs/<revision> for a branch revision. A .incomplete that this app's engine is writing now (`writing`) is left out,
 * so a second download of the same repo can start while the first runs.
 */
export async function previewFingerprint(fs: ReadFs, hubRoot: string, listing: RemoteListing, revision: string,
  paths: readonly string[], writing: ReadonlySet<string>): Promise<string> {
  const etags = new Map(listing.files.map((f) => [f.path, f.etag]));
  const folder = join(hubRoot, repoFolderName(listing.repoId, listing.type));
  const files = [];
  for (const p of [...paths].sort()) {
    const etag = etags.get(p) ?? null;
    const inc = etag === null ? null : join(folder, 'blobs', `${etag}.incomplete`);
    files.push({
      path: p, etag,
      blob: etag === null ? null : await factsOf(fs, join(folder, 'blobs', etag)),
      incomplete: inc === null || writing.has(inc) ? 'engine' : await factsOf(fs, inc),
      entry: await factsOf(fs, join(folder, 'snapshots', listing.commit, ...p.split('/'))),
    });
  }
  const ref = isCommitHash(revision) ? null : await factsOf(fs, join(folder, 'refs', ...revision.split('/')));
  const refText = ref?.isFile === true ? await fs.readFile(join(folder, 'refs', ...revision.split('/')), 'utf8').catch(() => null) : null;
  return hashCanonical({ commit: listing.commit, files, ref, refText });
}

/**
 * The commit refs/<revision> names now (whitespace stripped, as the scanner reads it), or null when it is
 * absent, not a regular file, not a commit, or the revision is itself a commit. The engine moves the ref only from it.
 */
export async function refCommit(fs: ReadFs, hubRoot: string, listing: RemoteListing, revision: string): Promise<string | null> {
  if (isCommitHash(revision)) return null;
  const ref = join(hubRoot, repoFolderName(listing.repoId, listing.type), 'refs', ...revision.split('/'));
  const facts = await factsOf(fs, ref);
  if (facts === null || !facts.isFile || facts.isSymlink) return null;
  const text = (await fs.readFile(ref, 'utf8')).trim();
  return /^[0-9a-f]{40}$/.test(text) ? text : null;
}

/** The groups whose GGUF header makes their shape and is not in `cache` yet (same rule as library advice). */
function headerJobs(repo: Repo, view: RepoView, cache: ShapeCache): Array<{ g: Group; key: string; paths: string[] }> {
  return view.groups.flatMap((g) => {
    if (!HEADER_KINDS.has(g.kind) || g.locked) return [];
    const files = headerFiles(repo, g);
    return files === null || cache.has(files.key) ? [] : [{ g, key: files.key, paths: files.paths }];
  });
}

/** Runs `fn` over `items`, at most `n` at once. */
async function inParallel<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** How a refusal names a repo: its id, plus the type for a dataset or space (a model and a dataset may share an id). */
export const repoLabel = (repoId: string, type: RepoType): string => (type === 'model' ? repoId : `${repoId} (${type})`);

export function lookupInput(r: RecentLookup): string {
  const prefix = r.type === 'dataset' ? 'datasets/' : r.type === 'space' ? 'spaces/' : '';
  return `${prefix}${r.repoId}${r.revision === 'main' ? '' : `@${r.revision}`}`;
}

/** Marks a header read that must not be cached: the shape is unknown for this look-up only. */
class NotRead extends Error {}

export class DownloadService {
  private readonly lookups = new Map<string, Lookup>();
  private readonly previews = new Map<string, Preview>();
  /** The client built with the token read by the latest look-up or start. */
  private current: { client: HubClient; token: string | null } | null = null;
  /** What the engine holds: every call goes to the current client, so a token set later reaches downloads too. */
  private readonly viaCurrent: HubClient = {
    revision: (...a) => this.currentClient().revision(...a),
    open: (...a) => this.currentClient().open(...a),
    readAt: (...a) => this.currentClient().readAt(...a),
  };
  private engine: { hubRoot: string; ready: Promise<DownloadEngine> } | null = null;
  private engineNow: DownloadEngine | null = null;
  /** engineNow once its restore() has loaded the saved queue (until then the delete guard reads settings too). */
  private restored: DownloadEngine | null = null;
  /** Downloads seen unfinished this session: only these get the rescan + downloadDone when their last file is done. */
  private readonly live = new Set<string>();

  constructor(private readonly h: DownloadHost, private readonly o: DownloadOptions = {}) {}

  private prune(now: number): void {
    for (const [id, x] of this.lookups) if (x.expiresAt <= now) this.lookups.delete(id);
    for (const [id, x] of this.previews) if (x.expiresAt <= now) this.previews.delete(id);
  }

  /**
   * The look-up, its expiry pushed DOWNLOAD_TTL_MS past now: a look-up expires only after that long unused, never while
   * the user is still choosing files. Its listing growing old is safe: downloadStart checks the Hub commit again.
   */
  private useLookup(lookupId: string): Lookup | undefined {
    const now = this.h.now();
    this.prune(now);
    const l = this.lookups.get(lookupId);
    if (l !== undefined) l.expiresAt = now + DOWNLOAD_TTL_MS;
    return l;
  }

  private currentClient(): HubClient {
    if (this.current === null) throw new HubClientError({ code: 'OFFLINE', message: 'Download mode is not ready yet' });
    return this.current.client;
  }

  /**
   * The client for the current endpoint. `fresh` (each look-up and start) reads the token again (HF_TOKEN, else the
   * token file: cheap) and rebuilds the client with it; otherwise the last one is kept.
   */
  private async hubClient(fresh: boolean): Promise<ApiResult<{ client: HubClient; token: string | null }>> {
    const mode = downloadMode(this.h.env);
    if (!mode.ok) return fail('OFFLINE', mode.reason);
    if (fresh || this.current === null) {
      const token = await readToken(this.h.env, this.h.home, this.h.fs);
      this.current = {
        token,
        client: createHubClient({
          endpoint: mode.endpoint, token, fetch: this.o.fetch ?? hubFetch, ...(this.o.clientSleep ? { sleep: this.o.clientSleep } : {}),
        }),
      };
    }
    return ok(this.current);
  }

  /**
   * Called once at service start (bootstrap): builds the engine and restores the saved queue, so paused downloads
   * exist before any download call. Never throws; with download mode off or no cache, nothing is built.
   */
  async start(): Promise<void> {
    try {
      await this.engineFor();
    } catch {
      // downloads() reports why later
    }
  }

  /** The engine of the present hub, built once and restored from settings (its unfinished files come back paused). */
  private async engineFor(): Promise<ApiResult<DownloadEngine>> {
    const c = await this.hubClient(false);
    if (!c.ok) return c;
    const hub = await this.h.port.resolveHub();
    if (!hub.present) return fail('HUB_MISSING', hub.problem.message);
    if (this.engine === null || this.engine.hubRoot !== hub.hubRoot) {
      const target = this.h.port.downloadTarget(hub.hubRoot);
      const ready = (async () => {
        const engine = new DownloadEngine({
          client: this.viaCurrent, hubRoot: hub.hubRoot, safeFs: target.safeFs, lock: target.lock, settings: this.h.settings,
          statfs: this.o.statfs ?? ((p) => this.h.fs.statfs(p)), now: this.h.now, emit: (e) => this.onProgress(e),
          symlinksSupported: await this.h.symlinksSupported(), fs: this.h.fs, ...(this.o.sleep ? { sleep: this.o.sleep } : {}),
        });
        this.engineNow = engine;
        await engine.restore();
        if (this.engineNow === engine) this.restored = engine;
        return engine;
      })();
      this.engine = { hubRoot: hub.hubRoot, ready };
      ready.catch(() => { if (this.engine?.ready === ready) this.engine = null; });
    }
    return ok(await this.engine.ready);
  }

  /** Every event goes to the renderer; an item whose last file is done gets one rescan, then `downloadDone`. */
  private onProgress(e: DownloadProgressDTO): void {
    try {
      this.h.emitProgress(e);
    } catch {
      // a failing listener never stops a download
    }
    if (e.state !== 'done') {
      this.live.add(e.id);
      return;
    }
    if (!this.live.has(e.id)) return;
    const item = this.engineNow?.list().find((i) => i.id === e.id);
    if (item === undefined || !item.files.every((f) => f.state === 'done')) return;
    this.live.delete(e.id);
    void this.finished(item);
  }

  private async finished(item: QueueItem): Promise<void> {
    try {
      await this.h.rescan();
    } catch {
      // the toast still comes; the library shows the last scan
    }
    try {
      this.h.emitDone({ id: item.id, repoId: item.repoId, type: item.type });
    } catch {
      // no window
    }
  }

  /**
   * Returns without reading any GGUF header: `advice` has every shape unknown and `shapesPending` says
   * whether downloadAdvice(lookupId) has shapes to read.
   */
  async hubLookup(input: string): Promise<ApiResult<HubLookupDTO>> {
    const parsed = parseHubInput(input);
    if ('error' in parsed) return fail('INVALID_INPUT', parsed.error);
    const c = await this.hubClient(true);
    if (!c.ok) return c;
    const { client, token } = c.data;
    const { repoId, type, revision } = parsed;
    try {
      repoFolderName(repoId, type);
    } catch {
      return fail('INVALID_INPUT', `${repoId} cannot be stored in the cache (unsupported characters).`);
    }
    let rev;
    try {
      rev = await client.revision(repoId, type, revision);
    } catch (e) {
      return hubFailure(e);
    }
    const listing = toRemoteListing({ repoId, type, commit: rev.commit, files: rev.siblings });
    const repo = remoteRepo(listing);
    const view = classifyRepo(repo, () => null);
    const m = await this.h.model();
    const states = m.ok ? fileStates(listing, m.data) : new Map<string, FileState>();
    // Gated without a token → not downloadable (a resolve refused later, in downloadAdvice, blocks it too)
    const noToken = rev.gated && token === null;
    const blocked: ApiError | null = noToken ? { code: 'GATED', message: GATED_TEXT } : m.ok ? null : m.error;
    const ctx = await this.h.adviceContext();
    const advice = await repoAdvice({
      repo, view, machine: ctx.machine, settings: ctx.settings, config: ctx.config, cache: new Map(), readText: () => null,
      readHeaders: () => Promise.reject(new NotRead('shapes come from downloadAdvice')),
    });
    const groups = downloadGroups(listing, view, states);
    const now = this.h.now();
    this.prune(now);
    const lookupId = randomUUID();
    this.lookups.set(lookupId, {
      listing, revision, gated: rev.gated, expiresAt: now + DOWNLOAD_TTL_MS, blocked, noToken,
      groups: new Map(groups.map((g) => [g.key, g])), repo, view, shapes: new Map(),
    });
    await this.remember({ repoId, type, revision, at: now });
    return ok({
      lookupId, repoId, type, revision, commit: rev.commit, badge: badgeFor(view), gated: rev.gated, private: rev.private,
      lastModified: rev.lastModified, downloadable: blocked === null, notDownloadableReason: blocked?.message ?? null, groups, advice,
      shapesPending: !noToken && headerJobs(repo, view, new Map()).length > 0,
    });
  }

  /**
   * The look-up's advice with GGUF shapes: headers read from the Hub with range requests, at most
   * HEADER_READS_AT_ONCE groups at a time, first shard first, cached by etag list for this look-up (a second call
   * reads nothing again). A transfer failure leaves that shape unknown and uncached; a 401/403 marks the look-up gated.
   */
  async downloadAdvice(lookupId: string): Promise<ApiResult<RepoAdviceDTO>> {
    const l = this.useLookup(lookupId);
    if (l === undefined) return fail('UNKNOWN_PLAN', LOOKUP_GONE_TEXT);
    const { listing, repo, view, shapes } = l;
    const byEtag = new Map(listing.files.map((f) => [f.etag, f]));
    const readHeaders = async (paths: readonly string[]): Promise<GgufHeader[] | null> => {
      if (l.noToken) throw new NotRead('not read: the repo is gated and no token is set');
      const c = await this.hubClient(false);
      if (!c.ok) throw new NotRead(c.error.message);
      const out: GgufHeader[] = [];
      for (const p of paths) {
        const f = byEtag.get(p.slice(p.lastIndexOf('/') + 1));
        if (f === undefined) return null;
        try {
          out.push(await readGgufHeader(c.data.client.readAt(listing.repoId, listing.type, listing.commit, f.path), GGUF_ARRAY_ITEMS));
        } catch (e) {
          if (e instanceof HubClientError) {
            if (e.code === 'GATED' || e.code === 'UNAUTHORIZED') l.blocked = { code: 'GATED', message: GATED_TEXT };
            throw e;   // a transfer problem, not a fact of the bytes: never cached
          }
          return null;   // not a usable GGUF header (a fact of the content)
        }
      }
      return out;
    };
    // fill this look-up's cache first, several groups at once; repoAdvice then finds every shape there
    await inParallel(headerJobs(repo, view, shapes), HEADER_READS_AT_ONCE, async ({ g, key, paths }) => {
      if (shapes.has(key)) return;   // two groups with the same files
      const shape: Promise<ModelShape | null> = readHeaders(paths).then((h) => (h === null ? null : shapeFromHeaders(h, g.shards ?? null)));
      shapes.set(key, shape);
      try {
        await shape;
      } catch {
        if (shapes.get(key) === shape) shapes.delete(key);
      }
    });
    const ctx = await this.h.adviceContext();
    return ok(await repoAdvice({
      repo, view, machine: ctx.machine, settings: ctx.settings, config: ctx.config, cache: shapes, readText: () => null,
      readHeaders: () => Promise.reject(new NotRead('read above')),
    }));
  }

  /** The look-up's groups with their cache states read again from the current scan (after a download); no Hub request. */
  async lookupGroups(lookupId: string): Promise<ApiResult<DownloadGroupDTO[]>> {
    const l = this.useLookup(lookupId);
    if (l === undefined) return fail('UNKNOWN_PLAN', LOOKUP_GONE_TEXT);
    const m = await this.h.model();
    if (!m.ok) return m;
    const groups = downloadGroups(l.listing, l.view, fileStates(l.listing, m.data));
    l.groups = new Map(groups.map((g) => [g.key, g]));
    return ok(groups);
  }

  /** Newest first, one entry per repo and revision, at most 20. A settings file that cannot be trusted is not rewritten. */
  private async remember(r: RecentLookup): Promise<void> {
    try {
      await this.h.settings.update((cur) => {
        // A file with a block the user has not seen reported yet is left as it is (no silent repair from a read)
        if (cur.error !== null || cur.adviceError !== null || cur.downloadsError !== null) return null;
        const rest = (cur.settings.recentLookups ?? []).filter((x) => !(x.repoId === r.repoId && x.type === r.type && x.revision === r.revision));
        return { ...cur.settings, recentLookups: [r, ...rest].slice(0, MAX_RECENT_LOOKUPS) };
      });
    } catch {
      // a look-up never fails because the list could not be saved
    }
  }

  async recentLookups(): Promise<ApiResult<RecentLookupDTO[]>> {
    const list = (await this.h.settings.loadChecked()).settings.recentLookups ?? [];
    return ok(list.map((r) => ({ input: lookupInput(r), repoId: r.repoId, type: r.type, revision: r.revision, at: r.at })));
  }

  async downloadPreview(lookupId: string, groupKeys: readonly string[]): Promise<ApiResult<DownloadPreviewDTO>> {
    const l = this.useLookup(lookupId);
    if (l === undefined) return fail('UNKNOWN_PLAN', LOOKUP_GONE_TEXT);
    const now = this.h.now();
    if (l.blocked !== null) return { ok: false, error: { ...l.blocked } };
    const paths = new Set<string>();
    for (const key of groupKeys) {
      const g = l.groups.get(key);
      if (g === undefined) return fail('NOT_FOUND', `This look-up has no group ${key}.`);
      if (!g.selectable) return fail('INVALID_INPUT', `${g.label}: ${g.reason ?? 'cannot be downloaded'}`);
      for (const f of g.files) paths.add(f.path);
    }
    const m = await this.h.model();
    if (!m.ok) return m;
    const { listing } = l;
    const chosen = [...paths];
    const states = fileStates(listing, m.data);
    const queued = queuedEtags(this.engineNow?.list() ?? [], listing);
    const notCached = chosen.filter((p) => states.get(p)?.kind !== 'cached');
    const fetch = notCached.filter((p) => !queued.has(p));
    const need = requiresBytes(listing, states, fetch);
    const sizes = new Map(listing.files.map((f) => [f.path, f.size]));
    // without symlinks every snapshot entry is a second copy of its blob
    const copies = (await this.h.symlinksSupported()) ? 0 : fetch.reduce((n, p) => n + (sizes.get(p) ?? 0), 0);
    const room = await this.freeBytes(m.data.hubRoot, repoFolderName(listing.repoId, listing.type));
    const fits = fetch.length > 0 && need + copies <= room.free - FREE_MARGIN;
    const reason = fetch.length === 0 ? (notCached.length > 0 ? ALL_QUEUED_TEXT : ALL_CACHED_TEXT) : fits ? null : NO_ROOM_TEXT(need + copies, room.free, room.where);
    const previewId = randomUUID();
    const fingerprint = await previewFingerprint(this.h.fs, m.data.hubRoot, listing, l.revision, chosen, this.writing());
    this.prune(now);
    // keep at most MAX_PREVIEWS: the oldest go first (Map keeps insertion order)
    while (this.previews.size >= MAX_PREVIEWS) {
      const oldest = this.previews.keys().next();
      if (oldest.done === true) break;
      this.previews.delete(oldest.value);
    }
    this.previews.set(previewId, {
      hubRoot: m.data.hubRoot, listing, revision: l.revision, paths: chosen, fingerprint, fits, reason, expiresAt: now + DOWNLOAD_TTL_MS, used: false,
    });
    return ok({ previewId, fingerprint, requiresBytes: need, freeBytes: room.free, fits, reason, files: fetch.length });
  }

  /** Statfs of the nearest existing folder on the way to the repo's blobs/. */
  private async freeBytes(hubRoot: string, folderName: string): Promise<{ free: number; where: string }> {
    let p = join(hubRoot, folderName, 'blobs');
    for (;;) {
      try {
        if ((await this.h.fs.lstat(p)).isDirectory()) break;
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      const up = dirname(p);
      if (up === p) break;
      p = up;
    }
    const s = await (this.o.statfs ?? ((x: string) => this.h.fs.statfs(x)))(p);
    return { free: s.bavail * s.bsize, where: p };
  }

  /**
   * Refusals, in order: an unknown, used or expired preview, a fingerprint that is not the preview's (STALE), an
   * execute or sync running (BUSY), a preview that did not fit, then the Hub commit moved or what the files touch changed
   * (STALE, "look up again"). Single use: a refusal after the checks above uses it up, except BUSY and network errors.
   */
  async downloadStart(previewId: string, fingerprint: string): Promise<ApiResult<{ id: string }>> {
    const now = this.h.now();
    const p = this.previews.get(previewId);
    if (p === undefined) return fail('UNKNOWN_PLAN', PREVIEW_GONE_TEXT);
    if (p.used) return fail('USED', PREVIEW_USED_TEXT);
    if (now >= p.expiresAt) {
      this.prune(now);
      return fail('EXPIRED', PREVIEW_GONE_TEXT);
    }
    if (fingerprint !== p.fingerprint) return fail('STALE', CHANGED_TEXT);
    if (this.h.opRunning()) return fail('BUSY', DL_BUSY_TEXT);
    if (!p.fits) return fail('INVALID_INPUT', p.reason ?? ALL_CACHED_TEXT);
    p.used = true;   // set before the first await: a double click starts one download
    try {
      return await this.startPreview(p);
    } catch (err) {
      p.used = false;   // An unexpected error (INTERNAL) leaves the preview usable
      throw err;
    }
  }

  /** downloadStart past its synchronous checks, with `p` marked used. */
  private async startPreview(p: Preview): Promise<ApiResult<{ id: string }>> {
    const retryable = (r: { ok: false; error: ApiError }): { ok: false; error: ApiError } => {
      p.used = false;
      return r;
    };
    const e = await this.engineFor();
    if (!e.ok) return retryable(e);
    // The hub the preview was fingerprinted on must be the one the engine writes to
    if (this.engine?.hubRoot !== p.hubRoot) return fail('STALE', CHANGED_TEXT);
    const c = await this.hubClient(true);
    if (!c.ok) return retryable(c);
    const { listing } = p;
    try {
      const rev = await c.data.client.revision(listing.repoId, listing.type, p.revision);
      if (rev.commit !== listing.commit) return fail('STALE', MOVED_TEXT);
    } catch (err) {
      return retryable(hubFailure(err));
    }
    if (await previewFingerprint(this.h.fs, p.hubRoot, listing, p.revision, p.paths, this.writing()) !== p.fingerprint) {
      return fail('STALE', CHANGED_TEXT);
    }
    const refAtStart = await refCommit(this.h.fs, p.hubRoot, listing, p.revision);
    const m = await this.h.model();
    if (!m.ok) return retryable(m);
    // from here to the engine's start nothing awaits: no execute or sync can begin in between
    if (this.h.opRunning()) return retryable(fail('BUSY', DL_BUSY_TEXT));
    const states = fileStates(listing, m.data);
    const byPath = new Map(listing.files.map((f) => [f.path, f]));
    // what an unfinished download already fetches is linked by that one, never queued twice
    const queued = queuedEtags(e.data.list(), listing);
    const files = p.paths.filter((x) => states.get(x)?.kind !== 'cached' && !queued.has(x)).map((x) => {
      const f = byPath.get(x)!;
      return { path: f.path, etag: f.etag, size: f.size, lfs: f.lfs, state: 'queued' as const, bytes: 0, error: null };
    });
    const fetched = new Set(files.map((f) => f.path));
    const item: QueueItem = {
      id: randomUUID(), repoId: listing.repoId, type: listing.type, revision: p.revision, commit: listing.commit,
      refAtStart, files,
      links: unchangedLinks(listing, m.data).filter((x) => !fetched.has(x.path)),
    };
    this.live.add(item.id);
    await e.data.start(item);
    return ok({ id: item.id });
  }

  /**
   * The repo folders (absolute) with a queue item that is not finished: some file not
   * done (queued, running, paused, waiting or failed: the user cancels a failed one to unblock it), each with a label
   * naming the repo (and its type, unless a model). Deletions and restores touching them are refused by the services.
   * The engine's items are under the engine's hub. Until the engine has restored the saved queue (startup, download mode
   * off, offline, no cache), the queue saved in settings counts too, under `hubRoot` (the plan's hub).
   */
  async activeFolders(hubRoot: string): Promise<{ active: Map<string, string>; unreadable: string | null }> {
    const out = new Map<string, string>();
    const add = (root: string, items: readonly QueueItem[]): void => {
      for (const i of items) {
        if (i.files.every((f) => f.state === 'done')) continue;
        let name: string;
        try {
          name = repoFolderName(i.repoId, i.type);
        } catch {
          continue;   // no folder can hold it
        }
        out.set(join(root, name), repoLabel(i.repoId, i.type));
      }
    };
    const engine = this.engineNow;
    const engineHub = this.engine?.hubRoot;
    if (engine !== null && engineHub !== undefined) add(engineHub, engine.list());
    let unreadable: string | null = null;
    if (engine === null || this.restored !== engine) {
      const cur = await this.h.settings.loadChecked();
      unreadable = queueUnreadable(cur);   // The caller then fails closed
      add(hubRoot, cur.settings.downloads?.items ?? []);
    }
    return { active: out, unreadable };
  }

  /** The .incomplete paths this app's engine may be writing now (files queued, waiting, streaming or verifying). */
  private writing(): Set<string> {
    const out = new Set<string>();
    const hubRoot = this.engine?.hubRoot;
    if (hubRoot === undefined) return out;
    for (const i of this.engineNow?.list() ?? []) {
      const folder = join(hubRoot, repoFolderName(i.repoId, i.type));
      for (const f of i.files) if (WRITING.has(f.state)) out.add(join(folder, 'blobs', `${f.etag}.incomplete`));
    }
    return out;
  }

  private async control(id: string, fn: (e: DownloadEngine) => Promise<void> | void): Promise<ApiResult<null>> {
    const e = await this.engineFor();
    if (!e.ok) return e;
    if (!e.data.list().some((i) => i.id === id)) return fail('NOT_FOUND', 'That download is no longer in the queue.');
    await fn(e.data);
    return ok(null);
  }

  downloadPause(id: string): Promise<ApiResult<null>> {
    return this.control(id, (e) => e.pause(id));
  }

  /** BUSY while an execute, sync or auto-empty run holds the mutex (checked again after every await). */
  async downloadResume(id: string): Promise<ApiResult<null>> {
    if (this.h.opRunning()) return fail('BUSY', RESUME_BUSY_TEXT);
    let busy = false;
    const r = await this.control(id, async (e) => {
      if (this.h.opRunning()) {
        busy = true;
        return;
      }
      this.live.add(id);
      await e.resume(id);   // the files are queued synchronously, before its first await
    });
    return busy ? fail('BUSY', RESUME_BUSY_TEXT) : r;
  }

  /**
   * Drops the item from the queue (partial files stay). With no engine (download mode off, offline, no cache) the item
   * is removed from the queue saved in settings, so a paused or failed item never blocks a deletion for good.
   */
  async downloadCancel(id: string): Promise<ApiResult<null>> {
    const e = await this.engineFor();
    if (!e.ok) return this.cancelSaved(id);
    if (!e.data.list().some((i) => i.id === id)) return fail('NOT_FOUND', 'That download is no longer in the queue.');
    this.live.delete(id);
    e.data.cancel(id);
    return ok(null);
  }

  private async cancelSaved(id: string): Promise<ApiResult<null>> {
    let found = false;
    let untrusted: string | null = null;
    await this.h.settings.update((cur) => {
      const items = cur.settings.downloads?.items ?? [];
      found = items.some((i) => i.id === id);
      if (!found) return null;
      // A file with a block that cannot be trusted is left as it is
      untrusted = cur.error ?? cur.adviceError;
      if (untrusted !== null) return null;
      return { ...cur.settings, downloads: { version: 1, items: items.filter((i) => i.id !== id) } };
    });
    if (!found) return fail('NOT_FOUND', 'That download is no longer in the queue.');
    if (untrusted !== null) return fail('INTERNAL', `settings.json cannot be trusted (${untrusted}); the download was not removed`);
    return ok(null);
  }

  /** The queue; with download mode off (or no cache), the queue as saved, with the reason. */
  async downloads(): Promise<ApiResult<DownloadsDTO>> {
    const e = await this.engineFor();
    if (!e.ok) {
      const saved = (await this.h.settings.loadChecked()).settings.downloads?.items ?? [];
      return ok({ items: saved.map(itemDto), disabledReason: e.error.message, notes: [] });
    }
    const notes = [e.data.saveError, e.data.lockError].filter((n): n is string => n !== null);
    return ok({ items: e.data.list().map(itemDto), disabledReason: null, notes });
  }
}

function itemDto(i: QueueItem): DownloadItemDTO {
  return {
    id: i.id, repoId: i.repoId, type: i.type, revision: i.revision, commit: i.commit,
    files: i.files.map((f) => ({ path: f.path, size: f.size, state: f.state, bytes: f.bytes, error: f.error })),
  };
}
