import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DlState, DownloadItemDTO } from '../../shared/api';
import { formatBytes } from '../lib/format';
import { unwrap, useApi } from '../lib/api';
import { useAdvice } from '../lib/queries';
import { shownFiles, useDownloads, type ShownFile } from '../state/downloads';
import { NameParts } from './NameParts';
import { Button } from './ui/button';
import { toast } from './ui/toast';

const STATE_TEXT: Record<DlState, string> = {
  queued: 'Queued', 'waiting-other': 'Another program is downloading this file — waiting', downloading: 'Downloading', paused: 'Paused',
  'paused-disk': 'Paused: disk nearly full', verifying: 'Verifying', done: 'Done', failed: 'Failed',
};

function timeLeft(f: ShownFile): string {
  if (f.state !== 'downloading' || f.bytesPerSec <= 0) return '';
  const s = Math.ceil((f.size - f.bytes) / f.bytesPerSec);
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min left` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s left` : `${s} s left`;
}

function FileLine({ repoId, f }: { repoId: string; f: ShownFile }) {
  const advice = useAdvice(repoId).data;
  const parts = advice?.groups.flatMap((g) => g.files).find((x) => x.relpath === f.path)?.parts;
  const left = timeLeft(f);
  return (
    <li data-testid="download-file" className="py-1 text-xs">
      <div className="break-all font-mono">{parts !== undefined ? <NameParts parts={parts} /> : f.path}</div>
      <div className="text-muted-foreground">
        {formatBytes(f.bytes)} / {formatBytes(f.size)}
        {f.state === 'downloading' && f.bytesPerSec > 0 && <> · {formatBytes(f.bytesPerSec)}/s</>}
        {left !== '' && <> · {left}</>}
        {' · '}<span data-testid="download-state" className={f.state === 'failed' ? 'text-danger' : undefined}>{STATE_TEXT[f.state]}</span>
      </div>
      {f.state === 'failed' && f.error !== null && <div data-testid="download-error" className="break-all text-danger">{f.error}</div>}
      {f.state === 'done' && f.error !== null && <div data-testid="download-note" className="break-all text-muted-foreground">{f.error}</div>}
    </li>
  );
}

function ItemBlock({ item }: { item: DownloadItemDTO }) {
  const api = useApi();
  const live = useDownloads((s) => s.live);
  const [confirm, setConfirm] = useState(false);
  const files = shownFiles(item, live);
  const unfinished = files.filter((f) => f.state !== 'done');
  const running = unfinished.some((f) => f.state === 'queued' || f.state === 'downloading' || f.state === 'verifying' || f.state === 'waiting-other');
  const resumable = unfinished.some((f) => f.state === 'paused' || f.state === 'paused-disk' || f.state === 'failed');
  const failed = unfinished.some((f) => f.state === 'failed');

  const run = async (fn: () => ReturnType<typeof api.downloadPause>): Promise<void> => {
    try { unwrap(await fn()); } catch (e) { toast({ title: e instanceof Error ? e.message : String(e), tone: 'danger' }); }
    try {
      const r = await api.downloads();
      if (r.ok) useDownloads.getState().setItems(r.data.items, r.data.disabledReason);
    } catch {
      // IPC gone: the drawer keeps the last listing
    }
  };

  return (
    <section data-testid="download-item" aria-label={item.repoId} className="border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{item.repoId}</span>
        {running && <Button size="sm" onClick={() => void run(() => api.downloadPause(item.id))}>Pause</Button>}
        {resumable && <Button size="sm" onClick={() => void run(() => api.downloadResume(item.id))}>{failed && !running ? 'Retry' : 'Resume'}</Button>}
        {unfinished.length === 0
          // finished: nothing is left to cancel; Clear only drops it from the list
          ? <Button size="sm" variant="ghost" onClick={() => void run(() => api.downloadCancel(item.id))}>Clear</Button>
          : <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>Cancel</Button>}
      </div>
      {confirm && (
        <div role="alertdialog" aria-label="Cancel download" className="my-1.5 rounded-md border border-border p-2 text-xs">
          <p>Cancel this download? The partial file stays on disk.</p>
          <div className="mt-1.5 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => { setConfirm(false); void run(() => api.downloadCancel(item.id)); }}>Cancel download</Button>
            <Button size="sm" onClick={() => setConfirm(false)}>Keep downloading</Button>
          </div>
        </div>
      )}
      <ul>{files.map((f) => <FileLine key={f.path} repoId={item.repoId} f={f} />)}</ul>
    </section>
  );
}

/** The right-side Downloads panel: every queued file with its progress and the controls main allows (per download). */
export function DownloadsDrawer({ onClose }: { onClose(): void }) {
  const items = useDownloads((s) => s.items);
  const disabledReason = useDownloads((s) => s.disabledReason);
  // Escape closes it; focus goes back to what had it when the drawer opened (the Downloads button)
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);
  return (
    <aside data-testid="downloads-drawer" aria-label="Downloads" className="fixed top-0 right-0 bottom-0 z-40 flex w-[440px] max-w-full flex-col border-l border-border bg-card text-card-foreground shadow-xl">
      <header className="flex items-center border-b border-border px-4 py-3">
        <h2 className="flex-1 text-[15px] font-semibold">Downloads</h2>
        <Button variant="ghost" size="icon" aria-label="Close downloads" onClick={onClose}><X className="h-4 w-4" /></Button>
      </header>
      {disabledReason !== null && <p className="px-4 py-2 text-xs text-warning">{disabledReason}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? <p className="px-4 py-3 text-xs text-muted-foreground">No downloads.</p> : items.map((i) => <ItemBlock key={i.id} item={i} />)}
      </div>
    </aside>
  );
}
