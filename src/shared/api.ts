// The typed contract between the renderer and the main process. Type-only imports from the core:
// this file is compiled by the web project too, so it must not pull in anything that needs Node types.
import type { AdviceSettings, GpuKind, MachineProfile } from '../core/advice/profile';
import type { HubRepoType } from './hub-input';
import type { Tool } from './knowledge/rules';
import type {
  DeleteMode, ExecErrorCode, FreedReason, GroupKind, Op, RepoKind, RepoType, Selection, ViewImpactLine, ViewName,
} from '../core/types';

export type ApiErrorCode =
  ExecErrorCode | 'INVALID_INPUT' | 'FORBIDDEN' | 'NOT_FOUND' | 'BUSY' | 'HUB_MISSING' | 'CONFIG' | 'SETTINGS' | 'INTERNAL'
  /** Download mode is off (HF_HUB_OFFLINE, or an HF_ENDPOINT that cannot be used); the message says why. */
  | 'OFFLINE'
  /** The Hub could not be reached or answered with an error. */
  | 'NETWORK'
  /** A gated or private repo the token cannot open. */
  | 'GATED';
/**
 * `detailPath` is display-only: it is never sent back to the main process. `staleOwnLock` is set by main on
 * a LOCKED error when the lock file names this app's own process: a lock left behind, which the user can delete by hand.
 */
export interface ApiError { code: ApiErrorCode; message: string; detailPath?: string; staleOwnLock?: boolean }
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** The progress phases, in order. `ScanProgressDTO.phase` is derived from it, so the worker-message validator cannot drift. */
export const SCAN_PHASES = ['scan', 'classify', 'usage', 'done', 'error'] as const;
export interface ScanProgressDTO { phase: (typeof SCAN_PHASES)[number]; done: number; total: number; message?: string }
export interface UsageCountsDTO { lmstudio: number; ollama: number }
export interface RepoSummaryDTO {
  repoId: string; type: RepoType; kinds: RepoKind[]; badge: string;
  apparentBytes: number; lastModifiedMs: number; usage: UsageCountsDTO; partialDownloads: number;
  /** Another repo of a different type has this id; deletion is disabled for it. List keys are `${type}:${repoId}`. */
  ambiguous: boolean;
}
export interface LibraryDTO {
  hubRoot: string; hubPresent: boolean; scannedAt: number; repos: RepoSummaryDTO[];
  /** The space the hub takes on disk, each file counted once (hardlinks and the shared store are not doubled); 0 without a scan. */
  hubBytes: number;
  heldBytes: number; heldCount: number;
  /** `days` is the limit that run used (the setting may have changed since). */
  lastAutoEmpty: { at: number; count: number; freedBytes: number; days: number } | null;
  /** Set when the scan failed; deletion, sync and auto-empty are then disabled. */
  scanError: string | null;
}
export interface FileEntryDTO { relpath: string; commitShort: string; current: boolean; bytes: number; plainFile: boolean }
export interface GroupDTO {
  key: string; kind: GroupKind; label: string; fileCount: number;
  /** null when the planner cannot tell (shown as "can't tell"), never a guessed 0. */
  apparentBytes: number; reclaimableBytes: number | null;
  shards: { present: number; expected: number } | null; locked: boolean;
  usedBy: { lmstudio: string[]; ollama: string[] }; files: FileEntryDTO[];
  /** Set on a superseded group that may hold the only copy of files missing from the current revision. */
  warning: string | null;
}
export interface RepoDetailDTO {
  repoId: string; type: RepoType; kinds: RepoKind[]; kindLabel: string;
  revisionShort: string | null; downloadedAtMs: number | null; apparentBytes: number;
  hasLockedGroups: boolean; groups: GroupDTO[];
}
export interface SelectionPreviewDTO { groupCount: number; freedBytes: number; viewLinksAffected: number; warnings: string[] }

/** A restore plan frees nothing; its rows are the files it moves back and the `.refs` lines it re-adds. */
export type FileRowReason = FreedReason | 'restore-move' | 'restore-refs';
/** `fullPath` is the exact absolute file, full hash included; the review shows it as well as the label. */
export interface FileRowDTO {
  repoId: string | null; displayPath: string; otherLinks: number; blobShort: string | null;
  bytes: number; reason: FileRowReason; reasonText: string; fullPath: string;
}
/** `displayPath` is shortened (no full hashes); `fullPath` is the absolute path, for a tooltip or detail view. */
export interface OpRowDTO { kind: Op['kind']; role: string | null; displayPath: string; fullPath: string }
/** `entryKind` mirrors the matching op role (symlink, manifest, blob, state) or `folder` for an `rmdir-empty` line. */
export type ViewEntryKind = 'symlink' | 'manifest' | 'blob' | 'state' | 'folder';
export interface ViewLineDTO {
  view: ViewName; displayPath: string; action: ViewImpactLine['action']; actionText: string;
  key: string | null; note: string | null; entryKind: ViewEntryKind | null;
  /** The absolute path (the view-relative path when the view has no known root), for a tooltip or detail view. */
  fullPath: string;
}
export interface KeptRowDTO { repoId: string; groupKey: string; label: string; bytes: number }
/** One snapshot entry a partial deletion leaves in place; `fullPath` is its absolute path. */
export interface KeptFileDTO { repoId: string; displayPath: string; fullPath: string }
export interface PlanDTO {
  planId: string; fingerprint: string; mode: DeleteMode; purpose: 'delete' | 'restore' | 'empty';
  title: string; repoIds: string[]; groupCount: number; createdAt: number; expiresAt: number;
  filesRemoved: number; freedBytes: number; apparentBytes: number; sharedBytes: number;
  files: FileRowDTO[]; ops: OpRowDTO[]; viewLines: ViewLineDTO[]; viewsUnaffected: ViewName[];
  kept: KeptRowDTO[]; keptFiles: KeptFileDTO[]; warnings: string[]; confirmPhrase: string | null; holdRootDisplay: string | null;
}
export interface PlanPairDTO { hold: PlanDTO | null; holdUnavailableReason: string | null; permanent: PlanDTO }
/** One plan per deletion; each is registered on its own and executed in order by the renderer. */
export interface EmptyPlanDTO { plans: PlanDTO[]; skipped: string[]; freedBytes: number; apparentBytes: number; sharedBytes: number }
export interface ExecResultDTO {
  ok: boolean; planId: string; mode: DeleteMode; purpose: PlanDTO['purpose']; appliedOps: number; totalOps: number;
  error: ApiError | null; freedBytesPlanned: number; heldBytes: number; diskFreeDelta: number;
  followUp: 'offer-sync' | null;
  /** The core's `ExecResult.notes` (a payload kept, a record that could not be updated, ...). */
  notes: string[];
}
/** `held` and `partial` offer Restore and Delete Permanently, `interrupted` Restore only, `leftover` Delete
 *  Permanently only, `corrupt` nothing (the error is shown). `bytes` is 0 and `heldAtMs` 0 when the manifest is unusable. */
export type HeldStatus = 'held' | 'partial' | 'interrupted' | 'corrupt' | 'leftover';
export interface HeldDeletionDTO {
  deletionId: string; status: HeldStatus; error: string | null; repoIds: string[]; groupLabels: string[];
  bytes: number; heldAtMs: number; otherEntries: number;
  /** In the set the auto-empty-pending notice announced (still to be emptied this session). */
  pendingAutoEmpty: boolean;
}
export interface HeldListDTO {
  available: boolean; unavailableReason: string | null; totalBytes: number;
  items: HeldDeletionDTO[]; autoEmptyDays: number | null;
  /** When the announced deletions will be emptied: the armed countdown's deadline, null when none is running. */
  autoEmptyAt: number | null;
}
export type EmptyTarget = { all: true } | { deletionId: string };
/** `paths` are view-relative ('/'-separated); `fullPaths` the same paths joined to the view root, absolute. */
export interface SyncEntryDTO { key: string; paths: string[]; fullPaths: string[]; note: string | null }
export interface SyncViewDTO {
  view: ViewName; rootDisplay: string | null; skippedReason: string | null;
  adds: SyncEntryDTO[]; updates: SyncEntryDTO[]; removals: SyncEntryDTO[]; tombstones: SyncEntryDTO[];
  adopts: SyncEntryDTO[]; foreign: SyncEntryDTO[]; skipped: SyncEntryDTO[]; ownedCount: number; wouldRemoveAll: boolean;
  warnings: string[];
}
export interface SyncPlanDTO { planId: string; createdAt: number; expiresAt: number; views: SyncViewDTO[]; warnings: string[] }
export type SyncViewStatus = 'applied' | 'refused-mass-removal' | 'stale' | 'aborted' | 'skipped';
export interface SyncViewResultDTO {
  view: ViewName; status: SyncViewStatus; created: number; updated: number; removed: number; adopted: number;
  tombstoned: number; skipped: number; error: string | null;
  /** Entries that failed after a partial write; rendered prominently. */
  partialWrites: string[]; warnings: string[];
}
/** `ok` is false when nothing ran, any executed view was not applied, or any entry failed after a partial write.
 *  `massRemovalViews` names every view refused for wanting to remove all it owns (one checkbox covers them all). */
export interface SyncResultDTO { ok: boolean; views: SyncViewResultDTO[]; massRemovalViews: ViewName[] }
export interface SettingsViewDTO {
  view: ViewName; root: string | null; rootExists: boolean; statePath: string | null;
  aliases: Record<string, string>; problem: string | null;
}
export interface SettingsDTO {
  hubRoot: string; hubPresent: boolean; configPath: string; configExists: boolean;
  /** Set when config.toml could not be read; view-touching operations then return `CONFIG`. */
  configError: string | null;
  /** Set when the app's own settings.json could not be read: auto-empty is then off until Settings is saved. */
  settingsError: string | null;
  views: SettingsViewDTO[];
  holdRoot: string | null; holdUnavailableReason: string | null; journalPath: string;
  symlinks: { ok: boolean; detail: string };
  autoEmptyDays: number | null;
  /** A plain string; the web project has no Node types (`NodeJS.Platform`). */
  platform: 'linux' | 'darwin' | 'win32' | (string & {});
}
export interface DiskInfoDTO { pathDisplay: string; totalBytes: number; freeBytes: number; usedBytes: number }
/** A journal notice comes from the journal's incomplete plans and is acknowledged through the journal. */
export interface JournalNoticeDTO {
  kind: 'journal'; planId: string; startedAtMs: number; purpose: PlanDTO['purpose']; mode: DeleteMode;
  opsStarted: number; lastOpPath: string | null; message: string;
}
/** App-level notices. Acknowledging one only hides it for the session; no file is changed. */
export interface SettingsUnreadableNoticeDTO { kind: 'settings-unreadable'; id: 'settings-unreadable'; message: string }
export interface HeldUnreadableNoticeDTO { kind: 'held-unreadable'; id: 'held-unreadable'; message: string }
/** Auto-empty is due and will run after a grace period; acknowledging it cancels auto-empty for the session. */
/** `emptyAt` (epoch ms) is the deadline, set when main starts the countdown (the notice was delivered); null before that. */
export interface AutoEmptyPendingNoticeDTO { kind: 'auto-empty-pending'; id: 'auto-empty-pending'; message: string; emptyAt: number | null }
/** The clock looked wrong, so auto-empty is off for the session. Acknowledging only hides it. */
export interface AutoEmptySkippedNoticeDTO { kind: 'auto-empty-skipped'; id: 'auto-empty-skipped'; message: string }
export type StartupNoticeDTO =
  | JournalNoticeDTO | SettingsUnreadableNoticeDTO | HeldUnreadableNoticeDTO | AutoEmptyPendingNoticeDTO | AutoEmptySkippedNoticeDTO;

/** One part of a repo id, quant label or file name. The renderer looks `entryId` up in `KNOWLEDGE`. */
export interface NamePartDTO { text: string; entryId: string | null; looksLikeTag: boolean }
export interface GroupAdviceDTO {
  key: string; tint: 'green' | 'yellow' | 'red' | null; reason: string; explanation: string; facts: string[];
  labelParts: NamePartDTO[]; files: Array<{ relpath: string; parts: NamePartDTO[] }>;
}
/** Keep advice for the current snapshot: one entry per group of `repoDetail`, in the same order. */
export interface RepoAdviceDTO { repoId: string; repoParts: NamePartDTO[]; basis: string; repoLine: GroupAdviceDTO | null; groups: GroupAdviceDTO[] }
/** `defaultTools` is what `settings.tools` null means: llama.cpp plus each view configured in config.toml.
 *  `adviceError` says why settings.json's advice block was ignored (the defaults are then in `settings`), else null. */
export interface MachineProfileDTO {
  detected: MachineProfile; settings: AdviceSettings; adviceError: string | null;
  effective: { gpuBytes: number | null; ramBytes: number; gpuKind: GpuKind }; defaultTools: Tool[];
}

// ---------------------------------------------------------------- download mode

/** A file's state in a download. Shared with the engine (src/main/download/queue.ts re-exports it). */
export const DL_STATES = ['queued', 'waiting-other', 'downloading', 'paused', 'paused-disk', 'verifying', 'done', 'failed'] as const;
export type DlState = (typeof DL_STATES)[number];
/** One file of a looked-up repo: `state` against the scanned cache, `have` the bytes already on disk (cached: all). */
export interface DownloadFileDTO { path: string; size: number; state: 'absent' | 'cached' | 'partial' | 'update'; have: number }
/**
 * One group of the looked-up repo, by the library's classifier. `complete`: every shard of the set is listed on the Hub.
 * `selectable` false (an incomplete set, files that cannot be verified or were refused) comes with the `reason`.
 */
export interface DownloadGroupDTO {
  key: string; kind: GroupKind; label: string; files: DownloadFileDTO[];
  requiresBytes: number; complete: boolean; selectable: boolean; reason: string | null;
}
/**
 * A Hub look-up. `lookupId` (a uuid, 10 minutes) is what the renderer sends back with group keys; the
 * listing itself stays in main. `advice` (and `downloadAdvice`) has one entry per classified group, in order (the extra "cannot be verified"
 * and "refused" groups at the end of `groups` have none).
 */
export interface HubLookupDTO {
  lookupId: string; repoId: string; type: HubRepoType; revision: string; commit: string; badge: string;
  gated: boolean; private: boolean; lastModified: string | null;
  downloadable: boolean; notDownloadableReason: string | null; groups: DownloadGroupDTO[];
  /** Format and tool advice only: every GGUF shape is still unknown here. */
  advice: RepoAdviceDTO;
  /** Some group's size advice waits for its GGUF header: show "Reading model shape…" until downloadAdvice answers. */
  shapesPending: boolean;
}
/** A fingerprinted download preview: `files` is the number of files still to fetch. */
export interface DownloadPreviewDTO {
  previewId: string; fingerprint: string; requiresBytes: number; freeBytes: number; fits: boolean; reason: string | null; files: number;
}
/** Progress event: at most 4 per second per file, plus one on every state change. */
export interface DownloadProgressDTO { id: string; path: string; state: DlState; bytes: number; size: number; bytesPerSec: number; error: string | null }
/** Sent once when every file of a download is done and the library has been rescanned (the renderer offers Sync). */
export interface DownloadDoneDTO { id: string; repoId: string; type: HubRepoType }
export interface DownloadItemDTO {
  id: string; repoId: string; type: HubRepoType; revision: string; commit: string;
  files: Array<{ path: string; size: number; state: DlState; bytes: number; error: string | null }>;
}
/**
 * The queue. `disabledReason`: download mode is off (offline, a bad HF_ENDPOINT, no cache); the saved queue is then
 * listed as saved and nothing can be started or resumed. `notes`: why the queue could not be saved, or the app lock
 * could not be released.
 */
export interface DownloadsDTO { items: DownloadItemDTO[]; disabledReason: string | null; notes: string[] }
/** A recent look-up (newest first, at most 20). `input` looks it up again as typed into the field. */
export interface RecentLookupDTO { input: string; repoId: string; type: HubRepoType; revision: string; at: number }

export interface HfcmApi {
  scan(): Promise<ApiResult<LibraryDTO>>;
  cancelScan(): Promise<ApiResult<null>>;
  repoDetail(repoId: string): Promise<ApiResult<RepoDetailDTO>>;
  previewSelection(selection: Selection): Promise<ApiResult<SelectionPreviewDTO>>;
  planDelete(selection: Selection): Promise<ApiResult<PlanPairDTO>>;
  executePlan(planId: string, fingerprint: string, mode: DeleteMode, confirmText: string | null): Promise<ApiResult<ExecResultDTO>>;
  listHeld(): Promise<ApiResult<HeldListDTO>>;
  planRestore(deletionId: string): Promise<ApiResult<PlanDTO>>;
  planEmpty(target: EmptyTarget): Promise<ApiResult<EmptyPlanDTO>>;
  setAutoEmptyDays(days: number | null): Promise<ApiResult<null>>;
  planSync(): Promise<ApiResult<SyncPlanDTO>>;
  executeSync(planId: string, opts: { allowMassRemoval: boolean }): Promise<ApiResult<SyncResultDTO>>;
  settings(): Promise<ApiResult<SettingsDTO>>;
  diskInfo(): Promise<ApiResult<DiskInfoDTO>>;
  startupNotices(): Promise<ApiResult<StartupNoticeDTO[]>>;
  ackStartupNotice(idOrPlanId: string): Promise<ApiResult<null>>;
  advice(repoId: string): Promise<ApiResult<RepoAdviceDTO>>;
  machineProfile(): Promise<ApiResult<MachineProfileDTO>>;
  /** Saves the advice block (autoEmptyDays is kept) and returns the profile it gives. SETTINGS (nothing written) when
   *  settings.json cannot be read. */
  setAdviceSettings(s: AdviceSettings): Promise<ApiResult<MachineProfileDTO>>;
  /** Runs machine detection again (Settings → "Detect again"). */
  redetectMachine(): Promise<ApiResult<MachineProfileDTO>>;
  /** Looks up `org/name[@rev]` or a Hub URL; OFFLINE when download mode is off. Records a recent look-up. */
  hubLookup(input: string): Promise<ApiResult<HubLookupDTO>>;
  /** The look-up's advice with GGUF shapes read from the Hub (range reads, 4 at a time, cached per look-up). */
  downloadAdvice(lookupId: string): Promise<ApiResult<RepoAdviceDTO>>;
  /** The fingerprinted preview of the chosen groups of a look-up; nothing is written. */
  downloadPreview(lookupId: string, groupKeys: string[]): Promise<ApiResult<DownloadPreviewDTO>>;
  /** Starts a previewed download (single use). STALE ("look up again") when the Hub commit moved or the repo folder changed. */
  downloadStart(previewId: string, fingerprint: string): Promise<ApiResult<{ id: string }>>;
  downloadPause(id: string): Promise<ApiResult<null>>;
  downloadResume(id: string): Promise<ApiResult<null>>;
  /** Drops the download from the queue; partial files stay on disk. */
  downloadCancel(id: string): Promise<ApiResult<null>>;
  downloads(): Promise<ApiResult<DownloadsDTO>>;
  recentLookups(): Promise<ApiResult<RecentLookupDTO[]>>;
  /** The look-up's groups with their cache states read again from the current scan (after a download); no Hub request. */
  lookupGroups(lookupId: string): Promise<ApiResult<DownloadGroupDTO[]>>;
  onScanProgress(cb: (p: ScanProgressDTO) => void): () => void;
  onDownloadProgress(cb: (p: DownloadProgressDTO) => void): () => void;
  onDownloadDone(cb: (p: DownloadDoneDTO) => void): () => void;
}
/** The events: subscriptions, not invoke channels. */
export type EventMethod = 'onScanProgress' | 'onDownloadProgress' | 'onDownloadDone';
export type InvokeMethod = Exclude<keyof HfcmApi, EventMethod>;

/** The 30 invoke methods, in declaration order (a literal checked against `InvokeMethod`, never a bare declaration). */
export const API_METHODS = [
  'scan', 'cancelScan', 'repoDetail', 'previewSelection', 'planDelete', 'executePlan', 'listHeld', 'planRestore',
  'planEmpty', 'setAutoEmptyDays', 'planSync', 'executeSync', 'settings', 'diskInfo', 'startupNotices',
  'ackStartupNotice', 'advice', 'machineProfile', 'setAdviceSettings', 'redetectMachine',
  'hubLookup', 'downloadAdvice', 'downloadPreview', 'downloadStart', 'downloadPause', 'downloadResume', 'downloadCancel', 'downloads', 'recentLookups',
  'lookupGroups',
] as const satisfies readonly InvokeMethod[];

export const CHANNELS: Record<InvokeMethod, `hfcm:${InvokeMethod}`> =
  Object.fromEntries(API_METHODS.map((m) => [m, `hfcm:${m}`])) as Record<InvokeMethod, `hfcm:${InvokeMethod}`>;
export const SCAN_PROGRESS_EVENT = 'hfcm:scan-progress';
export const DOWNLOAD_PROGRESS_EVENT = 'hfcm:download-progress';
export const DOWNLOAD_DONE_EVENT = 'hfcm:download-done';

declare global { interface Window { api: HfcmApi } }
