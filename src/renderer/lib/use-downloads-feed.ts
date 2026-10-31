import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { DownloadDoneDTO, DownloadProgressDTO } from '../../shared/api';
import { progressKey, useDownloads } from '../state/downloads';
import { useApi } from './api';
import { queryKeys } from './queries';

/** Re-render at most 4 times a second. */
export const FLUSH_MS = 250;

/**
 * Listens to download events once (App level): progress is buffered and flushed to the store 4 times a second;
 * the queue is listed at mount (restored paused items) and again whenever an event names something not listed.
 * `onDone` runs for each finished download (the Sync offer).
 */
export function useDownloadsFeed(onDone: (d: DownloadDoneDTO) => void): void {
  const api = useApi();
  const client = useQueryClient();
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    let alive = true;
    const pending = new Map<string, DownloadProgressDTO>();
    /** Files a relist was already asked for: a late event of a cancelled download relists once, not on every flush. */
    const relisted = new Set<string>();
    const load = async (): Promise<void> => {
      try {
        const r = await api.downloads();
        if (alive && r.ok) useDownloads.getState().setItems(r.data.items, r.data.disabledReason);
      } catch {
        // IPC gone (window closing): the drawer keeps the last listing
      }
    };
    const flush = (): void => {
      if (pending.size === 0) return;
      const batch = [...pending.values()];
      pending.clear();
      const known = useDownloads.getState().items;
      const unknown = batch.map((p) => progressKey(p.id, p.path)).filter((k, n) => {
        const p = batch[n]!;
        return !relisted.has(k) && !known.some((i) => i.id === p.id && i.files.some((f) => f.path === p.path));
      });
      useDownloads.getState().applyProgress(batch);
      if (unknown.length > 0) {
        for (const k of unknown) relisted.add(k);
        void load();
      }
    };
    const timer = setInterval(flush, FLUSH_MS);
    const offProgress = api.onDownloadProgress((p) => { pending.set(progressKey(p.id, p.path), p); });
    const offDone = api.onDownloadDone((d) => {
      flush();
      void load();
      for (const key of [queryKeys.library, ['repo'], ['advice'], queryKeys.disk]) void client.invalidateQueries({ queryKey: key });
      doneRef.current(d);
    });
    void load();
    return () => { alive = false; clearInterval(timer); offProgress(); offDone(); };
  }, [api, client]);
}
