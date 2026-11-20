// Transfer drives: Export to drive and Load from USB.
// Volumes are probed fresh on every call and kept only as an id → root map for the calls that follow, so the renderer
// never holds a path and nothing about a drive is saved. A load opens a repo of the drive as a look-up of the download
// service (same groups, advice, preview and start; the bytes then come from the drive and are hashed against their
// etags before they enter the cache). An export is previewed (what it would write, and whether that fits) and then
// run in the background, one at a time, through the core's create-only DriveWriter; it only reads the cache, and a repo
// being exported cannot be deleted meanwhile (`activeFolders`).
import { randomUUID } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { repoFolderName } from '../core/download/remote-repo';
import type { ReadFs } from '../core/fsx';
import { isStrictlyInside } from '../core/paths';
import { readDrive } from '../core/transfer/drive-reader';
import { EXPORT_MARGIN, exportNeeds, runExport, type ExportProgress, type ExportResult } from '../core/transfer/export';
import { exportSet, type ExportSet } from '../core/transfer/export-plan';
import type { CacheModel, Selection } from '../core/types';
import type {
  ApiError, ApiErrorCode, ApiResult, ExportDTO, ExportPreviewDTO, HubLookupDTO, TransferDriveDTO, TransferRepoDTO, TransferVolumeDTO,
} from '../shared/api';
import { formatBytes } from '../shared/format';
import type { DownloadService } from './download-service';
import { repoLabel } from './download-service';
import { isE2E } from './env-guard';
import { driveSource } from './transfer/drive-source';
import { listVolumes, overrideRoots, type Volume } from './transfer/volumes';

/** Export previews live this long (like deletion plans). */
export const EXPORT_TTL_MS = 10 * 60_000;
/** At most 4 progress events per second per export; a change of status is always sent. */
export const EXPORT_PROGRESS_MS = 250;
/** Finished exports kept in the list. */
export const MAX_EXPORTS_LISTED = 20;

export const VOLUME_GONE_TEXT = 'That drive is no longer connected. Choose a drive again.';
export const NO_TRANSFER_TEXT = 'That drive has no models exported by HF Cache Manager.';
export const DRIVE_REPO_GONE_TEXT = 'That model is no longer on the drive.';
export const EXPORT_BUSY_TEXT = 'An export is already running — wait for it to finish or cancel it.';
export const EXPORT_PREVIEW_GONE_TEXT = 'This export preview expired — choose the drive again.';
export const EXPORT_NOTHING_TEXT = 'Everything selected is already on the drive.';
export const EXPORT_EMPTY_TEXT = 'Nothing in the selection can be exported.';
export const EXPORT_NO_ROOM_TEXT = (need: number, free: number, name: string): string =>
  `The selected models need ${formatBytes(need)} on ${name}, but only ${formatBytes(free)} is free. They will not fit.`;
export const EXPORT_ACTIVE_TEXT = (repo: string): string => `${repo} is being exported to a drive; wait for the export to finish or cancel it.`;

export interface TransferHost {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The login name, for /media/<user>. */
  user: string;
  now: () => number;
  fs: ReadFs;
  dl: DownloadService;
  /** The last scan's model, scanning first when none has run; else why the cache cannot be used. */
  model(): Promise<ApiResult<CacheModel>>;
  emitExport(e: ExportDTO): void;
  /** Free space of a volume (default the real statfs). */
  statfs?: (p: string) => Promise<{ bavail: number; bsize: number }>;
  /** Tests: the part size for new objects (default 1 GiB) and the volume probe's time limit. */
  partSize?: number;
  probeTimeoutMs?: number;
}

interface Preview { set: ExportSet; volume: Volume; hubRoot: string; fits: boolean; reason: string | null; expiresAt: number; used: boolean }
interface Running {
  dto: ExportDTO; ctl: AbortController; folders: Map<string, string>; done: Promise<void>;
  /** Bytes on the drive per file path key, summed into dto.bytes. */
  perFile: Map<string, { bytes: number; done: boolean }>;
  lastSent: number;
}

const fail = (code: ApiErrorCode, message: string): { ok: false; error: ApiError } => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class TransferService {
  private volumes = new Map<string, Volume>();
  private readonly previews = new Map<string, Preview>();
  private readonly exportsById = new Map<string, Running>();

  constructor(private readonly h: TransferHost) {}

  /**
   * Under the E2E suite only the folders HFCM_TRANSFER_ROOTS names inside the run's temp root are volumes: a test run
   * never probes, reads or writes a real drive.
   */
  private async probe(): Promise<Volume[]> {
    let env = this.h.env;
    if (isE2E(env)) {
      const root = env['HFCM_E2E_ROOT'] ?? '';
      const inside = (overrideRoots(env) ?? []).filter((p) => root !== '' && isStrictlyInside(p, root));
      if (inside.length === 0) return [];
      env = { ...env, HFCM_TRANSFER_ROOTS: inside.join(delimiter) };
    }
    const list = await listVolumes({
      platform: this.h.platform, env, user: this.h.user, fs: this.h.fs,
      ...(this.h.probeTimeoutMs === undefined ? {} : { timeoutMs: this.h.probeTimeoutMs }),
    });
    this.volumes = new Map(list.map((v) => [v.id, v]));
    return list;
  }

  private dto(v: Volume): TransferVolumeDTO {
    return { id: v.id, name: v.name, totalBytes: v.totalBytes, freeBytes: v.freeBytes, hasTransfer: v.hasTransfer };
  }

  async transferVolumes(): Promise<ApiResult<TransferVolumeDTO[]>> {
    return ok((await this.probe()).map((v) => this.dto(v)));
  }

  /** The volume a listing gave this id to, probed again now (it may have been unplugged since). */
  private async volume(volumeId: string): Promise<Volume | null> {
    if (!this.volumes.has(volumeId)) return null;
    return (await this.probe()).find((v) => v.id === volumeId) ?? null;
  }

  async transferDrive(volumeId: string): Promise<ApiResult<TransferDriveDTO>> {
    const v = await this.volume(volumeId);
    if (v === null) return fail('NOT_FOUND', VOLUME_GONE_TEXT);
    const drive = await readDrive(v.root, this.h.fs);
    if (drive === null) return fail('NOT_FOUND', NO_TRANSFER_TEXT);
    const repos: TransferRepoDTO[] = drive.repos.map((r) => ({
      key: r.key, repoId: r.repoId, type: r.type, commitShort: r.commit.slice(0, 8), ref: r.ref, exportedAtMs: r.exportedAt,
      bytes: r.bytes, files: r.files.length, incompleteFiles: r.incomplete.length,
    }));
    return ok({ volume: this.dto(v), repos, notes: drive.notes });
  }

  async transferOpen(volumeId: string, repoKey: string): Promise<ApiResult<HubLookupDTO>> {
    const v = await this.volume(volumeId);
    if (v === null) return fail('NOT_FOUND', VOLUME_GONE_TEXT);
    const drive = await readDrive(v.root, this.h.fs);
    if (drive === null) return fail('NOT_FOUND', NO_TRANSFER_TEXT);
    const repo = drive.repos.find((r) => r.key === repoKey);
    if (repo === undefined || repo.files.length === 0) return fail('NOT_FOUND', DRIVE_REPO_GONE_TEXT);
    return this.h.dl.driveLookup(driveSource(v.root, repo, this.h.fs), repo);
  }

  // ---------------------------------------------------------------------------------------------------------- export

  private prune(now: number): void {
    for (const [id, p] of this.previews) if (p.expiresAt <= now) this.previews.delete(id);
  }

  private running(): Running | undefined {
    return [...this.exportsById.values()].find((r) => r.dto.status === 'running');
  }

  private async free(root: string): Promise<number> {
    const s = await (this.h.statfs ?? ((p: string) => this.h.fs.statfs(p)))(root);
    return s.bavail * s.bsize;
  }

  /** The selection against the present scan and the present drive: what would be written and whether it fits. */
  private async measure(selection: Selection, v: Volume): Promise<ApiResult<{ set: ExportSet; hubRoot: string; need: number; files: number; free: number }>> {
    const m = await this.h.model();
    if (!m.ok) return m;
    const set = exportSet(m.data, selection);
    if ('error' in set) return fail('NOT_FOUND', set.error);
    const need = await exportNeeds(set, v.root, { fs: this.h.fs, ...(this.h.partSize === undefined ? {} : { partSize: this.h.partSize }) });
    return ok({ set, hubRoot: m.data.hubRoot, need: need.bytes, files: need.files, free: await this.free(v.root) });
  }

  async exportPreview(selection: Selection, volumeId: string): Promise<ApiResult<ExportPreviewDTO>> {
    const v = await this.volume(volumeId);
    if (v === null) return fail('NOT_FOUND', VOLUME_GONE_TEXT);
    const r = await this.measure(selection, v);
    if (!r.ok) return r;
    const { set, need, files, free } = r.data;
    const total = set.repos.reduce((n, x) => n + x.files.length, 0);
    const fits = total > 0 && need + EXPORT_MARGIN <= free;
    // Everything on the drive already is still a valid export: it may only need its record added.
    const reason = total === 0 ? EXPORT_EMPTY_TEXT : fits ? (need === 0 ? EXPORT_NOTHING_TEXT : null) : EXPORT_NO_ROOM_TEXT(need, free, v.name);
    const now = this.h.now();
    this.prune(now);
    const previewId = randomUUID();
    this.previews.set(previewId, { set, volume: v, hubRoot: r.data.hubRoot, fits, reason: fits ? null : reason, expiresAt: now + EXPORT_TTL_MS, used: false });
    return ok({
      previewId, volumeName: v.name, repos: set.repos.length, files, requiresBytes: need, freeBytes: free, fits, reason,
      skipped: set.skipped.map((s) => `${s.repoId}: ${s.path} (${s.reason})`),
    });
  }

  /**
   * Starts a previewed export and returns at once; progress comes as events. Refusals: an unknown, expired or used
   * preview, another export running (BUSY), a preview that did not fit, a drive that has gone or no longer has the room.
   */
  async exportStart(previewId: string): Promise<ApiResult<{ id: string }>> {
    const now = this.h.now();
    const p = this.previews.get(previewId);
    if (p === undefined) return fail('UNKNOWN_PLAN', EXPORT_PREVIEW_GONE_TEXT);
    if (p.used) return fail('USED', EXPORT_PREVIEW_GONE_TEXT);
    if (now >= p.expiresAt) {
      this.prune(now);
      return fail('EXPIRED', EXPORT_PREVIEW_GONE_TEXT);
    }
    if (this.running() !== undefined) return fail('BUSY', EXPORT_BUSY_TEXT);
    if (!p.fits) return fail('INVALID_INPUT', p.reason ?? EXPORT_EMPTY_TEXT);
    p.used = true;   // before the first await: a double click starts one export
    let v: Volume | null;
    try {
      v = (await this.probe()).find((x) => x.id === p.volume.id) ?? null;
      if (v !== null) {
        const need = await exportNeeds(p.set, v.root, { fs: this.h.fs, ...(this.h.partSize === undefined ? {} : { partSize: this.h.partSize }) });
        const free = await this.free(v.root);
        if (need.bytes + EXPORT_MARGIN > free) return fail('INVALID_INPUT', EXPORT_NO_ROOM_TEXT(need.bytes, free, v.name));
      }
    } catch (e) {
      p.used = false;
      throw e;
    }
    if (v === null) return fail('NOT_FOUND', VOLUME_GONE_TEXT);
    if (this.running() !== undefined) return fail('BUSY', EXPORT_BUSY_TEXT);   // checked again: the awaits above let another start in
    return ok({ id: this.launch(p.set, v, p.hubRoot) });
  }

  private launch(set: ExportSet, v: Volume, hubRoot: string): string {
    const id = randomUUID();
    const files = set.repos.flatMap((r) => r.files.map((f) => ({ key: `${r.repoId}\0${r.commit}\0${f.path}`, size: f.size })));
    const folders = new Map<string, string>();
    for (const r of set.repos) {
      try {
        folders.set(join(hubRoot, repoFolderName(r.repoId, r.type)), repoLabel(r.repoId, r.type));
      } catch {
        // no folder can hold it
      }
    }
    const run: Running = {
      dto: {
        id, volumeName: v.name, repoIds: [...new Set(set.repos.map((r) => r.repoId))], status: 'running', message: null,
        bytes: 0, totalBytes: files.reduce((n, f) => n + f.size, 0), filesDone: 0, filesTotal: files.length, current: null,
      },
      ctl: new AbortController(), folders, done: Promise.resolve(), lastSent: 0,
      perFile: new Map(files.map((f) => [f.key, { bytes: 0, done: false }])),
    };
    this.exportsById.set(id, run);
    this.trim();
    this.send(run, true);
    run.done = runExport(set, {
      volumeRoot: v.root, now: this.h.now, signal: run.ctl.signal, fs: this.h.fs, onProgress: (e) => this.onProgress(run, e),
      ...(this.h.partSize === undefined ? {} : { partSize: this.h.partSize }),
    }).then((res) => this.finish(run, set, res), (e: unknown) => {
      run.dto.status = 'failed';
      run.dto.message = errText(e);
      run.dto.current = null;
      this.send(run, true);
    });
    return id;
  }

  private onProgress(run: Running, e: ExportProgress): void {
    const st = run.perFile.get(`${e.repoId}\0${e.commit}\0${e.path}`);
    if (st === undefined) return;
    // Hashing reads the cache only: nothing is on the drive for the file yet.
    if (e.state === 'copying' || e.state === 'done') st.bytes = e.bytes;
    st.done = e.state === 'done';
    let bytes = 0;
    let done = 0;
    for (const f of run.perFile.values()) {
      bytes += f.bytes;
      if (f.done) done += 1;
    }
    run.dto.bytes = bytes;
    run.dto.filesDone = done;
    if (e.state === 'hashing' || e.state === 'copying') run.dto.current = e.path;
    this.send(run, false);
  }

  private finish(run: Running, set: ExportSet, res: ExportResult): void {
    const failed = res.repos.flatMap((r) => r.failed.map((f) => (f.path === '' ? `${r.repoId}: ${f.error}` : `${r.repoId}/${f.path}: ${f.error}`)));
    const skipped = set.skipped.length === 0 ? null : `${set.skipped.length} file${set.skipped.length === 1 ? ' was' : 's were'} left out (not exportable).`;
    run.dto.current = null;
    if (res.stopped !== null) {
      run.dto.status = res.stopped.why === 'cancelled' ? 'cancelled' : 'failed';
      run.dto.message = res.stopped.message;
    } else if (!res.ok) {
      run.dto.status = 'failed';
      run.dto.message = failed.slice(0, 5).join('; ') + (failed.length > 5 ? `; and ${failed.length - 5} more` : '');
    } else {
      run.dto.status = 'done';
      run.dto.message = skipped;
    }
    this.send(run, true);
  }

  private send(run: Running, always: boolean): void {
    const now = this.h.now();
    if (!always && now - run.lastSent < EXPORT_PROGRESS_MS) return;
    run.lastSent = now;
    try {
      this.h.emitExport({ ...run.dto, repoIds: [...run.dto.repoIds] });
    } catch {
      // a failing listener never stops an export
    }
  }

  /** Keeps the newest finished exports only (a running one is never dropped). */
  private trim(): void {
    const finished = [...this.exportsById.values()].filter((r) => r.dto.status !== 'running');
    for (const r of finished.slice(0, Math.max(0, finished.length - MAX_EXPORTS_LISTED))) this.exportsById.delete(r.dto.id);
  }

  exportCancel(id: string): Promise<ApiResult<null>> {
    const run = this.exportsById.get(id);
    if (run === undefined) return Promise.resolve(fail('NOT_FOUND', 'That export is no longer listed.'));
    if (run.dto.status === 'running') run.ctl.abort(new Error('cancelled'));
    return Promise.resolve(ok(null));
  }

  exports(): Promise<ApiResult<ExportDTO[]>> {
    return Promise.resolve(ok([...this.exportsById.values()].reverse().map((r) => ({ ...r.dto, repoIds: [...r.dto.repoIds] }))));
  }

  /** The repo folders (absolute) a running export reads, each with a label: deletions touching them are refused. */
  activeFolders(): Map<string, string> {
    return new Map(this.running()?.folders ?? []);
  }

  /** Resolves when no export is running (tests, shutdown). */
  async whenIdle(): Promise<void> {
    for (let r = this.running(); r !== undefined; r = this.running()) await r.done;
  }
}
