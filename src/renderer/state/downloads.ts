import { create } from 'zustand';
import type { DownloadFileDTO, DownloadGroupDTO, DownloadItemDTO, DownloadProgressDTO, HubLookupDTO } from '../../shared/api';

/** The queue as main last listed it, plus the newest progress per item+path. */
interface DownloadsStore {
  items: DownloadItemDTO[];
  live: Record<string, DownloadProgressDTO>;
  disabledReason: string | null;
  setItems(items: DownloadItemDTO[], disabledReason: string | null): void;
  applyProgress(batch: DownloadProgressDTO[]): void;
}

export const progressKey = (id: string, path: string): string => `${id}\n${path}`;

export const useDownloads = create<DownloadsStore>()((set) => ({
  items: [],
  live: {},
  disabledReason: null,
  setItems(items, disabledReason) {
    // A fresh listing is the truth: live entries of files it no longer has are dropped, the rest stay (they are newer).
    set((s) => {
      const keep: Record<string, DownloadProgressDTO> = {};
      for (const i of items) for (const f of i.files) { const k = progressKey(i.id, f.path); if (s.live[k] !== undefined) keep[k] = s.live[k]; }
      return { items, live: keep, disabledReason };
    });
  },
  applyProgress(batch) {
    set((s) => {
      const live = { ...s.live };
      for (const p of batch) live[progressKey(p.id, p.path)] = p;
      return { live };
    });
  },
}));

/** One file as shown: the newest progress event over the listed state. */
export interface ShownFile { path: string; size: number; state: DownloadItemDTO['files'][number]['state']; bytes: number; error: string | null; bytesPerSec: number }
export function shownFiles(item: DownloadItemDTO, live: Record<string, DownloadProgressDTO>): ShownFile[] {
  return item.files.map((f) => {
    const p = live[progressKey(item.id, f.path)];
    return p === undefined ? { ...f, bytesPerSec: 0 } : { path: f.path, size: p.size, state: p.state, bytes: p.bytes, error: p.error, bytesPerSec: p.bytesPerSec };
  });
}

/** Files not yet done, across the queue (the top-bar badge). */
export function unfinishedCount(items: DownloadItemDTO[], live: Record<string, DownloadProgressDTO>): number {
  return items.reduce((n, i) => n + shownFiles(i, live).filter((f) => f.state !== 'done').length, 0);
}

/** A looked-up file as shown: its cache state, or `queued` while an unfinished download of this commit is getting it. */
export type LookupFileState = DownloadFileDTO['state'] | 'queued';
export interface ShownGroup extends Omit<DownloadGroupDTO, 'files'> {
  files: Array<Omit<DownloadFileDTO, 'state'> & { state: LookupFileState }>;
  /** Selectable and something is left to download (not everything is cached or queued). */
  tickable: boolean;
}

/**
 * The queue laid over a look-up, which is a snapshot taken when it was made: a file a download of the same repo and
 * commit has finished counts as cached, one it has not finished as queued. Requires counts only what is left to download.
 */
export function withQueue(lookup: HubLookupDTO, items: DownloadItemDTO[], live: Record<string, DownloadProgressDTO>): ShownGroup[] {
  const queued = new Map<string, LookupFileState>();
  for (const i of items) {
    if (i.repoId !== lookup.repoId || i.type !== lookup.type || i.commit !== lookup.commit) continue;
    for (const f of shownFiles(i, live)) if (queued.get(f.path) !== 'queued') queued.set(f.path, f.state === 'done' ? 'cached' : 'queued');
  }
  return lookup.groups.map((g) => {
    const files = g.files.map((f) => {
      const q = queued.get(f.path);
      return q === undefined || f.state === 'cached' ? f : { ...f, state: q, have: q === 'cached' ? f.size : f.have };
    });
    const left = files.filter((f) => f.state !== 'cached' && f.state !== 'queued');
    const requiresBytes = left.reduce((n, f) => n + (f.state === 'partial' ? Math.max(0, f.size - f.have) : f.size), 0);
    return { ...g, files, requiresBytes, tickable: g.selectable && left.length > 0 };
  });
}
