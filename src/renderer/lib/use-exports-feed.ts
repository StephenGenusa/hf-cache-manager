import { useEffect, useRef } from 'react';
import type { ExportDTO } from '../../shared/api';
import { useExports } from '../state/exports';
import { useApi } from './api';

/**
 * Listens to export events once (App level): the list is read at mount and every event updates its export.
 * `onEnd` runs once for each export that stops running (done, failed or cancelled).
 */
export function useExportsFeed(onEnd: (e: ExportDTO) => void): void {
  const api = useApi();
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    let alive = true;
    const ended = new Set<string>();
    void api.exports().then((r) => {
      if (!alive || !r.ok) return;
      for (const e of r.data) if (e.status !== 'running') ended.add(e.id);
      useExports.getState().setItems(r.data);
    }, () => undefined);   // IPC gone (window closing)
    const off = api.onExportProgress((e) => {
      useExports.getState().apply(e);
      if (e.status === 'running' || ended.has(e.id)) return;
      ended.add(e.id);
      endRef.current(e);
    });
    return () => { alive = false; off(); };
  }, [api]);
}
