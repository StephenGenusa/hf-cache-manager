// The app's own settings file and the symlink probe. Both mutate only through a SafeFs rooted at the
// userData folder (FsLike is never named here; reads go through a ReadFs). The app never writes config.toml.
import { join } from 'node:path';
import type { AdviceSettings } from '../core/advice/types';
import { factsOf, readFs, type ReadFs } from '../core/fsx';
import { AUTO_EMPTY_DEFAULT_DAYS } from '../core/hold/held';
import { SafeFs, SafeFsError } from '../core/safe-fs';
import type { DiskInfoDTO } from '../shared/api';
import { ADVICE_SETTINGS } from '../shared/ipc-schemas';
import { DOWNLOADS_BLOCK, EMPTY_DOWNLOADS, RECENT_LOOKUPS, type DownloadsBlock, type RecentLookup } from './download/queue';

/** Defaults for the advice block: nothing assumed about the hardware (it is detected), llama.cpp-style context and KV. */
export const DEFAULT_ADVICE: AdviceSettings = {
  gpuBytes: null, gpuKind: null, ramBytes: null, drivesDisplay: null, context: 32768, kvType: 'f16', tools: null,
};

/**
 * Acknowledged startup notices live in the journal, not here. `autoEmptyDays` null is "Never".
 * `downloads`: the download queue; absent until the engine first saves one. Every writer spreads the
 * current settings so it is kept. `recentLookups`: the last 20 Hub look-ups, newest first, parsed the same way.
 */
export interface AppSettings { autoEmptyDays: number | null; advice: AdviceSettings; downloads?: DownloadsBlock; recentLookups?: RecentLookup[] }
export const DEFAULT_SETTINGS: AppSettings = { autoEmptyDays: AUTO_EMPTY_DEFAULT_DAYS, advice: DEFAULT_ADVICE };

export const SETTINGS_FILE = 'settings.json';
const PROBE_DIR = '.symlink-probe';
const WINDOWS_SYMLINK_COPY = 'Symlinks need Developer Mode or administrator rights (Settings → For developers).';

/** A SafeFs rooted at userData: nothing else in this file can write anywhere else. */
export type UserSafeFsFactory = (userDataDir: string) => Promise<SafeFs>;
const defaultSafeFs: UserSafeFsFactory = (dir) => SafeFs.create({ hubRoot: dir, viewRoots: [], holdRoot: null });

export interface StoreOptions { fs?: ReadFs; makeSafeFs?: UserSafeFsFactory }

const NEVER: AppSettings = { autoEmptyDays: null, advice: DEFAULT_ADVICE };

/**
 * Why the saved download queue cannot be known from `c` (settings.json unreadable or not JSON, or a
 * downloads block that fails the schema), or null when the queue it gives is the real one.
 */
export function queueUnreadable(c: CheckedSettings): string | null {
  return c.downloadsError ?? (c.settings === NEVER ? c.error : null);
}

/** Advice only: a missing block is the defaults; a bad one is the defaults plus a reason. Never touches auto-empty. */
function parseAdvice(raw: unknown): { advice: AdviceSettings; adviceError: string | null } {
  const block = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'advice' in raw
    ? (raw as { advice: unknown }).advice : undefined;
  if (block === undefined) return { advice: DEFAULT_ADVICE, adviceError: null };
  const r = ADVICE_SETTINGS.safeParse(block);
  if (r.success) return { advice: r.data, adviceError: null };
  return { advice: DEFAULT_ADVICE, adviceError: `advice settings ignored: ${r.error.issues.map((i) => `${i.path.join('.') || 'advice'}: ${i.message}`).join('; ')}` };
}

/**
 * Parsed like advice: a missing block is absent; a bad one is the empty queue plus a reason. Never touches
 * auto-empty. A file that is valid JSON but not an object cannot say what the queue was, so it is
 * an error (the delete guard then fails closed), not an empty queue.
 */
function parseDownloads(raw: unknown): { downloads?: DownloadsBlock; downloadsError: string | null } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { downloadsError: 'downloads ignored: settings.json is not a JSON object' };
  const block = 'downloads' in raw ? (raw as { downloads: unknown }).downloads : undefined;
  if (block === undefined) return { downloadsError: null };
  const r = DOWNLOADS_BLOCK.safeParse(block);
  if (r.success) return { downloads: r.data, downloadsError: null };
  return { downloads: EMPTY_DOWNLOADS, downloadsError: `downloads ignored: ${r.error.issues.map((i) => `${i.path.join('.') || 'downloads'}: ${i.message}`).join('; ')}` };
}

/** Like downloads: a missing block is absent; a bad one is an empty list. Never touches auto-empty. */
function parseRecent(raw: unknown): { recentLookups?: RecentLookup[] } {
  const block = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'recentLookups' in raw
    ? (raw as { recentLookups: unknown }).recentLookups : undefined;
  if (block === undefined) return {};
  const r = RECENT_LOOKUPS.safeParse(block);
  return { recentLookups: r.success ? r.data : [] };
}

export interface CheckedSettings { settings: AppSettings; error: string | null; adviceError: string | null; downloadsError: string | null }

/** null error: auto-empty is valid. Otherwise why the file cannot be trusted. Advice and queue problems go to their own error only. */
function parse(text: string): CheckedSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { settings: NEVER, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`, adviceError: null, downloadsError: null };
  }
  const { advice, adviceError } = parseAdvice(raw);
  const { downloads, downloadsError } = parseDownloads(raw);
  const rest = { advice, ...(downloads ? { downloads } : {}), ...parseRecent(raw) };
  const days = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'autoEmptyDays' in raw
    ? (raw as { autoEmptyDays: unknown }).autoEmptyDays : undefined;
  if (days === null) return { settings: { autoEmptyDays: null, ...rest }, error: null, adviceError, downloadsError };
  if (typeof days === 'number' && Number.isInteger(days) && days > 0) return { settings: { autoEmptyDays: days, ...rest }, error: null, adviceError, downloadsError };
  return { settings: { autoEmptyDays: null, ...rest }, error: 'autoEmptyDays must be a whole number of days or null', adviceError, downloadsError };
}

export class AppSettingsStore {
  private readonly fs: ReadFs;
  private readonly makeSafeFs: UserSafeFsFactory;
  private safeFs: Promise<SafeFs> | null = null;

  constructor(private readonly userDataDir: string, opts: StoreOptions = {}) {
    this.fs = opts.fs ?? readFs;
    this.makeSafeFs = opts.makeSafeFs ?? defaultSafeFs;
  }

  /**
   * A missing file (ENOENT) gives the defaults. Any other read error, or a corrupt or invalid file, is an error state:
   * auto-empty is off (never a silent default-on permanent deletion) and `error` says why. Never writes.
   */
  async loadChecked(): Promise<CheckedSettings> {
    let text: string;
    try {
      text = await this.fs.readFile(join(this.userDataDir, SETTINGS_FILE), 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return { settings: { ...DEFAULT_SETTINGS }, error: null, adviceError: null, downloadsError: null };
      return { settings: NEVER, error: code ?? (e instanceof Error ? e.message : String(e)), adviceError: null, downloadsError: null };
    }
    return parse(text);
  }

  /** The tail of the update chain; overlapping updates run one after another on it. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * One serialized read-modify-write: `fn` sees the file as the previous update left it and returns what to save, or
   * null to write nothing. Every writer of settings.json goes through here, so two writers can never lose each other's
   * change (an advice save can never put back an auto-empty setting the user just changed).
   */
  update(fn: (current: CheckedSettings) => AppSettings | null): Promise<AppSettings | null> {
    const run = this.queue.then(async () => {
      const next = fn(await this.loadChecked());
      if (next !== null) await this.save(next);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<AppSettings> {
    return (await this.loadChecked()).settings;
  }

  async save(s: AppSettings): Promise<void> {
    this.safeFs ??= this.makeSafeFs(this.userDataDir);
    const safe = await this.safeFs;
    const out = {
      autoEmptyDays: s.autoEmptyDays, advice: s.advice, ...(s.downloads ? { downloads: s.downloads } : {}),
      ...(s.recentLookups ? { recentLookups: s.recentLookups } : {}),
    };
    await safe.writeFileAtomic(join(this.userDataDir, SETTINGS_FILE), JSON.stringify(out, null, 2));
  }
}

export interface ProbeOptions { fs?: ReadFs; makeSafeFs?: UserSafeFsFactory; platform?: NodeJS.Platform }

/** Creates a symlink under `<userData>/.symlink-probe`, removes it again and reports whether that worked. */
export async function probeSymlinks(userDataDir: string, opts: ProbeOptions = {}): Promise<{ ok: boolean; detail: string }> {
  const fs = opts.fs ?? readFs;
  const dir = join(userDataDir, PROBE_DIR);
  const link = join(dir, 'link');
  let safe: SafeFs | null = null;
  try {
    safe = await (opts.makeSafeFs ?? defaultSafeFs)(userDataDir);
    await safe.mkdirp(dir);
    await removeLeftover(safe, fs, link);
    await safe.symlink('probe-target', link);
    const facts = await factsOf(fs, link);
    if (facts === null) throw new SafeFsError('STALE', link, 'the probe link vanished');
    await safe.unlink(link, facts);
    await safe.rmdirEmpty(dir);
    return { ok: true, detail: 'Symlinks available' };
  } catch (e) {
    if (safe !== null) await cleanup(safe, fs, dir, link);
    if ((opts.platform ?? process.platform) === 'win32') return { ok: false, detail: WINDOWS_SYMLINK_COPY };
    const code = e instanceof SafeFsError ? e.errno ?? e.code : (e as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN';
    return { ok: false, detail: `Symlink creation failed: ${code}` };
  }
}

/** A link left by a crashed probe is removed first so the probe can run again. */
async function removeLeftover(safe: SafeFs, fs: ReadFs, link: string): Promise<void> {
  const old = await factsOf(fs, link);
  if (old !== null) await safe.unlink(link, old);
}

/** Best effort: the probe's own link and folder, whichever exist. */
async function cleanup(safe: SafeFs, fs: ReadFs, dir: string, link: string): Promise<void> {
  try {
    await removeLeftover(safe, fs, link);
    await safe.rmdirEmpty(dir);
  } catch {
    // nothing else to do: the folder holds at most the probe link
  }
}

export function diskInfoFrom(s: { bsize: number; blocks: number; bfree: number; bavail: number }, pathDisplay: string): DiskInfoDTO {
  return { pathDisplay, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize, usedBytes: (s.blocks - s.bfree) * s.bsize };
}
