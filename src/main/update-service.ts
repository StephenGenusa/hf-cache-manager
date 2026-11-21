// "Check for updates": asks the Hub, once per cached repo, what its main revision holds now, and keeps which repos
// have a newer version of a file the cache already holds. Read-only towards the cache: the only thing written is the
// `updateCheck` block of settings.json. Started by hand only; nothing here runs on its own.
import { outdatedFiles } from '../core/download/cache-state';
import { toRemoteListing } from '../core/download/remote-repo';
import type { CacheModel, Repo } from '../core/types';
import type { ApiError, ApiErrorCode, ApiResult, UpdateCheckDTO, UpdateCheckProgressDTO, UpdateRepoDTO, UpdateResultDTO } from '../shared/api';
import type { AppSettingsStore } from './app-settings';
import { HubClientError, type HubClient } from './hub/client';
import { EMPTY_UPDATE_CHECK, MAX_UPDATE_ENTRIES, MAX_UPDATE_FILES, type UpdateCheckBlock, type UpdateCheckEntry } from './update-block';

export const PINNED_TEXT = 'Not checked: the cache has no main revision for this repo (it is pinned to a commit)';
export const BAD_ID_TEXT = 'Not checked: this repo id cannot be looked up on the Hub';
export const HUB_UNREACHABLE_TEXT = 'The check stopped: the Hub could not be reached. Repos that were not checked keep what was known about them.';
export const CHECK_RUNNING_TEXT = 'A check for updates is already running.';

/** Repos asked at once (as GGUF header reads). */
export const UPDATE_CONCURRENCY = 4;
/** The run stops when this many repos in a row fail on the network: the Hub is not reachable. */
export const NETWORK_STOP = 3;
/** Waits when the Hub rate-limits without saying how long; a repo still refused after the last one is reported. */
export const RATE_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];
export const MAX_RATE_WAIT_MS = 5 * 60_000;

const fail = (code: ApiErrorCode, message: string): { ok: false; error: ApiError } => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const keyOf = (r: { repoId: string; type: string }): string => `${r.type}:${r.repoId}`;
const IDLE: UpdateCheckProgressDTO = { running: false, done: 0, total: 0, current: null, waitingUntil: null };

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export interface UpdateHooks {
  now(): number;
  settings: AppSettingsStore;
  /** The last good scan (scanning first when none has run). */
  model(): Promise<ApiResult<CacheModel>>;
  /** A Hub client with the token as it is now; OFFLINE when download mode is off. */
  client(): Promise<ApiResult<HubClient>>;
  /** Why the Hub cannot be asked (download mode off), or null. */
  disabledReason(): string | null;
  emit(p: UpdateCheckProgressDTO): void;
}
export interface UpdateOptions {
  /** Test seams: the wait between rate-limited tries (resolves early when `signal` aborts) and the repos asked at once. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  concurrency?: number;
}

/** What one repo's check gave: an entry to keep, `null` for a repo that is current, or a network failure. */
type Outcome = { kind: 'entry'; entry: UpdateCheckEntry | null } | { kind: 'network'; message: string };

export class UpdateService {
  private progress: UpdateCheckProgressDTO = IDLE;
  private run: { ctl: AbortController; done: Promise<void> } | null = null;
  /** Why the last run of this session stopped early, or null. */
  private error: string | null = null;
  /** The block as last read or written: what a run found is known even when settings.json cannot be saved. */
  private block: UpdateCheckBlock | null = null;

  constructor(private readonly h: UpdateHooks, private readonly o: UpdateOptions = {}) {}

  private async loaded(): Promise<UpdateCheckBlock> {
    this.block ??= (await this.h.settings.loadChecked()).settings.updateCheck ?? EMPTY_UPDATE_CHECK;
    return this.block;
  }

  /** The findings that still hold against the scan: an update whose files are now cached, or a repo that left the cache, is gone. */
  async status(): Promise<ApiResult<UpdateCheckDTO>> {
    const block = await this.loaded();
    const m = await this.h.model();
    const results: UpdateResultDTO[] = [];
    if (m.ok) {
      for (const e of block.entries) {
        const repo = m.data.repos.find((r) => r.id === e.repoId && r.type === e.type);
        if (repo === undefined) continue;
        let updateFiles = 0;
        if (e.status === 'update') {
          updateFiles = outdatedOf(e, m.data).length;
          if (updateFiles === 0) continue;
        } else if (e.status === 'skipped' && repo.mainCommit !== null) continue;
        results.push({ repoId: e.repoId, type: e.type, status: e.status, updateFiles, message: e.message, checkedAt: e.checkedAt });
      }
    }
    results.sort((a, b) => (a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
    return ok({ progress: this.progress, checkedAt: block.checkedAt, disabledReason: this.h.disabledReason(), error: this.error, results });
  }

  /** Starts a run and returns; progress arrives as events and the findings are read with `status`. */
  async start(): Promise<ApiResult<null>> {
    if (this.run !== null) return fail('BUSY', CHECK_RUNNING_TEXT);
    const off = this.h.disabledReason();
    if (off !== null) return fail('OFFLINE', off);
    // claimed before the first await, so two starts cannot both run
    const ctl = new AbortController();
    let finish: () => void = () => undefined;
    this.run = { ctl, done: new Promise<void>((r) => { finish = r; }) };
    const release = (): void => { this.run = null; finish(); };
    let m: ApiResult<CacheModel>;
    let c: ApiResult<HubClient>;
    try {
      await this.loaded();
      m = await this.h.model();
      c = m.ok ? await this.h.client() : m;
    } catch (e) {
      release();
      throw e;
    }
    if (!m.ok || !c.ok) {
      release();
      return m.ok ? (c as { ok: false; error: ApiError }) : m;
    }
    this.error = null;
    void this.runAll(m.data, c.data, ctl.signal).catch((e: unknown) => {
      this.error = `The check failed: ${e instanceof Error ? e.message : String(e)}`;
    }).finally(() => {
      this.progress = { ...this.progress, running: false, current: null, waitingUntil: null };
      release();
      this.h.emit(this.progress);
    });
    return ok(null);
  }

  async cancel(): Promise<ApiResult<null>> {
    this.run?.ctl.abort(new Error('check cancelled'));
    return ok(null);
  }

  /** Resolves when no run is going (tests, and a clean shutdown). */
  async idle(): Promise<void> {
    while (this.run !== null) await this.run.done;
  }

  private entry(repo: Repo, status: UpdateCheckEntry['status'], message: string | null, over: Partial<UpdateCheckEntry> = {}): UpdateCheckEntry {
    return { repoId: repo.id, type: repo.type, status, commit: null, files: [], message, checkedAt: this.h.now(), ...over };
  }

  /**
   * One repo against the Hub's main revision: the entry to keep, or null when every file the cache holds is current.
   * A pinned repo is not asked. A Hub failure is thrown (HubClientError) for the caller to judge.
   */
  private async ask(repo: Repo, model: CacheModel, client: HubClient, signal?: AbortSignal): Promise<UpdateCheckEntry | null> {
    if (repo.mainCommit === null) return this.entry(repo, 'skipped', PINNED_TEXT);
    let rev;
    try {
      rev = await client.revision(repo.id, repo.type, 'main', signal);
    } catch (e) {
      if (e instanceof TypeError) return this.entry(repo, 'failed', BAD_ID_TEXT);   // an id the client will not put in a URL
      throw e;
    }
    const listing = toRemoteListing({ repoId: repo.id, type: repo.type, commit: rev.commit, files: rev.siblings });
    const files = outdatedFiles(listing, model);
    return files.length === 0 ? null : this.entry(repo, 'update', null, { commit: rev.commit, files: files.slice(0, MAX_UPDATE_FILES) });
  }

  /**
   * Checks one cached repo now (the repo the user opened) and replaces what was kept about it. When the Hub cannot be
   * asked (download mode off, a run going, a Hub error) nothing kept changes: the answer is what was known, with the
   * reason as its message.
   */
  async checkRepo(repoId: string, type: Repo['type']): Promise<ApiResult<UpdateRepoDTO>> {
    const m = await this.h.model();
    if (!m.ok) return m;
    const repo = m.data.repos.find((r) => r.id === repoId && r.type === type);
    if (repo === undefined) return fail('NOT_FOUND', `${repoId} is not in the cache.`);
    const dto = (e: UpdateCheckEntry | null, message: string | null = e?.message ?? null): UpdateRepoDTO => {
      const files = e?.status === 'update' ? outdatedOf(e, m.data).map((f) => ({ path: f.path, size: f.size })) : [];
      const status = e === null || (e.status === 'update' && files.length === 0) ? 'current' : e.status;
      return { repoId, type, status, commit: e?.commit ?? null, files, message, checkedAt: e?.checkedAt ?? null };
    };
    const known = (await this.loaded()).entries.find((e) => e.repoId === repoId && e.type === type) ?? null;
    const unasked = (reason: string): ApiResult<UpdateRepoDTO> =>
      ok(known === null ? { repoId, type, status: 'failed', commit: null, files: [], message: reason, checkedAt: null } : dto(known, reason));
    const off = repo.mainCommit === null ? null : this.h.disabledReason();
    if (off !== null) return unasked(off);
    if (this.run !== null) return unasked(CHECK_RUNNING_TEXT);
    let entry: UpdateCheckEntry | null;
    try {
      const c = await this.h.client();
      if (!c.ok) return unasked(c.error.message);
      entry = await this.ask(repo, m.data, c.data);
    } catch (e) {
      if (e instanceof HubClientError) return unasked(e.message);
      throw e;
    }
    await this.keep(m.data, new Map([[keyOf({ repoId, type }), entry]]), false);
    return ok(entry === null ? { repoId, type, status: 'current', commit: null, files: [], message: null, checkedAt: this.h.now() } : dto(entry));
  }

  private async runAll(model: CacheModel, client: HubClient, signal: AbortSignal): Promise<void> {
    const repos = [...model.repos].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sleep = this.o.sleep ?? defaultSleep;
    const set = (p: Partial<UpdateCheckProgressDTO>): void => {
      this.progress = { ...this.progress, ...p };
      this.h.emit(this.progress);
    };
    this.progress = { running: true, done: 0, total: repos.length, current: null, waitingUntil: null };
    this.h.emit(this.progress);

    /** Checked repos: the entry to keep, or null for a current one. A repo that is not here keeps its old entry. */
    const found = new Map<string, UpdateCheckEntry | null>();
    /** Network failures not yet followed by an answer: kept only if the Hub turns out to be reachable. */
    let unanswered: Array<{ repo: Repo; message: string }> = [];
    let stopped = false;
    /** A rate-limit wait in progress: every worker waits it out, whichever of them was refused. */
    let gate: Promise<void> | null = null;
    let next = 0;

    const one = async (repo: Repo): Promise<Outcome> => {
      for (let round = 0; ; round++) {
        while (gate !== null && !signal.aborted) await gate;
        if (signal.aborted) throw signal.reason;
        try {
          return { kind: 'entry', entry: await this.ask(repo, model, client, signal) };
        } catch (e) {
          if (signal.aborted) throw signal.reason;
          if (!(e instanceof HubClientError)) throw e;
          if (e.code === 'NETWORK' || e.code === 'NETWORK_BLOCKED') return { kind: 'network', message: e.message };
          if (e.code !== 'RATE_LIMITED' || round >= RATE_BACKOFF_MS.length) return { kind: 'entry', entry: this.entry(repo, 'failed', e.message) };
          const wait = Math.min(e.error.retryAfterMs ?? RATE_BACKOFF_MS[round]!, MAX_RATE_WAIT_MS);
          if (gate === null) {
            set({ waitingUntil: this.h.now() + wait });
            const g: Promise<void> = sleep(wait, signal).then(() => {
              if (gate === g) { gate = null; set({ waitingUntil: null }); }
            });
            gate = g;
          }
        }
      }
    };

    const worker = async (): Promise<void> => {
      while (!stopped && !signal.aborted && next < repos.length) {
        const repo = repos[next++]!;
        set({ current: repo.id });
        const out = await one(repo);
        if (out.kind === 'network') {
          unanswered.push({ repo, message: out.message });
          if (unanswered.length >= NETWORK_STOP) stopped = true;
        } else {
          for (const u of unanswered) {
            found.set(keyOf({ repoId: u.repo.id, type: u.repo.type }),
              { repoId: u.repo.id, type: u.repo.type, status: 'failed', commit: null, files: [], message: u.message, checkedAt: this.h.now() });
          }
          unanswered = [];
          found.set(keyOf({ repoId: repo.id, type: repo.type }), out.entry);
        }
        set({ done: this.progress.done + 1 });
      }
    };

    let cancelled = false;
    try {
      await Promise.all(Array.from({ length: Math.max(1, Math.min(this.o.concurrency ?? UPDATE_CONCURRENCY, repos.length)) }, worker));
    } catch (e) {
      if (!signal.aborted) throw e;
      cancelled = true;
    }
    if (signal.aborted) cancelled = true;
    if (stopped) this.error = HUB_UNREACHABLE_TEXT;
    // A cancelled run found nothing worth keeping over the last finished one; a stopped or finished one is merged in.
    if (!cancelled) await this.keep(model, found, true);
  }

  /** Merges a run into the block: a checked repo's entry is replaced (or dropped when it is current); repos no longer cached go. */
  private async keep(model: CacheModel, found: Map<string, UpdateCheckEntry | null>, wholeRun: boolean): Promise<void> {
    const cached = new Set(model.repos.map((r) => keyOf({ repoId: r.id, type: r.type })));
    const at = this.h.now();   // read once: what is kept in memory and what is saved must say the same time
    const merge = (old: UpdateCheckBlock): UpdateCheckBlock => ({
      version: 1, checkedAt: wholeRun ? at : old.checkedAt,
      entries: [
        ...old.entries.filter((e) => cached.has(keyOf(e)) && !found.has(keyOf(e))),
        ...[...found.values()].filter((e) => e !== null),
      ].slice(0, MAX_UPDATE_ENTRIES),
    });
    this.block = merge(await this.loaded());
    try {
      await this.h.settings.update((cur) => {
        // A file with a block the user has not seen reported yet is left as it is (no silent repair from a read)
        if (cur.error !== null || cur.adviceError !== null || cur.downloadsError !== null) return null;
        return { ...cur.settings, updateCheck: merge(cur.settings.updateCheck ?? EMPTY_UPDATE_CHECK) };
      });
    } catch {
      // the findings stay known for this session; a check never fails because they could not be saved
    }
  }
}

/** The files of an update entry the cache still does not hold at the Hub's version. */
function outdatedOf(e: UpdateCheckEntry, model: CacheModel): UpdateCheckEntry['files'] {
  if (e.commit === null) return [];
  try {
    return outdatedFiles(toRemoteListing({ repoId: e.repoId, type: e.type, commit: e.commit, files: e.files }), model);
  } catch {
    return [];   // an entry that cannot be read as a listing says nothing
  }
}
