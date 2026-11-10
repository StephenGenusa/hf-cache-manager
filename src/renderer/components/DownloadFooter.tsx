import { useEffect, useState } from 'react';
import type { DownloadGroupDTO, DownloadPreviewDTO, HubLookupDTO } from '../../shared/api';
import { useApi } from '../lib/api';
import { formatBytes } from '../lib/format';
import { useDiskInfo } from '../lib/queries';
import { useDownloadSelection } from '../state/download-selection';
import { Button } from './ui/button';
import { toast } from './ui/toast';

/** Files and bytes still to fetch for the ticked groups (a file shared by two groups counts once). */
export function selectionTotals(groups: DownloadGroupDTO[]): { files: number; bytes: number } {
  const seen = new Set<string>();
  let bytes = 0;
  for (const g of groups) {
    for (const f of g.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      bytes += f.state === 'cached' ? 0 : f.size - (f.state === 'partial' ? f.have : 0);
    }
  }
  return { files: seen.size, bytes };
}

const STALE_CODES = new Set(['STALE', 'UNKNOWN_PLAN', 'EXPIRED']);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface DownloadFooterProps {
  lookup: HubLookupDTO | null;
  /** The gated reason found by downloadAdvice, or null. */
  gatedNote: string | null;
  /** downloadAdvice has not answered yet: the gated check is not done, so Download waits. */
  advicePending: boolean;
  /** A look-up is in flight: the ticks belong to the old one. */
  lookingUp: boolean;
  onLookupAgain(): void;
}

export function DownloadFooter({ lookup, gatedNote, advicePending, lookingUp, onLookupAgain }: DownloadFooterProps) {
  const api = useApi();
  const keys = useDownloadSelection((s) => s.keys);
  const clear = useDownloadSelection((s) => s.clear);
  const disk = useDiskInfo().data;
  const [preview, setPreview] = useState<{ sig: string; data: DownloadPreviewDTO } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the server's reason a look-up again is needed (expired, cache changed, Hub commit moved), or null
  const [stale, setStale] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // only keys of the current look-up's groups can ever count or be previewed
  const selected = lookup === null ? [] : lookup.groups.filter((g) => keys.includes(g.key));
  const validKeys = selected.map((g) => g.key);
  const totals = selectionTotals(selected);
  const sig = `${lookup?.lookupId ?? ''}|${validKeys.join(',')}`;

  // The fit check: a preview of the current ticks (nothing is written). Download asks again so its fingerprint is fresh.
  useEffect(() => {
    setStale(null);
    setError(null);
    if (lookup === null || validKeys.length === 0) { setPreview(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void api.downloadPreview(lookup.lookupId, validKeys).then((r) => {
        if (!live) return;
        if (r.ok) setPreview({ sig, data: r.data });
        else if (STALE_CODES.has(r.error.code)) setStale(r.error.message);
        else { setPreview(null); setError(r.error.message); }
      }, (e: unknown) => { if (live) setError(errText(e)); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [api, sig]);

  const current = preview !== null && preview.sig === sig ? preview.data : null;
  const requires = current?.requiresBytes ?? totals.bytes;
  const reason = lookup === null ? 'Look up a repo first'
    : !lookup.downloadable ? (lookup.notDownloadableReason ?? 'This repo cannot be downloaded')
      : gatedNote !== null ? gatedNote
        : validKeys.length === 0 ? 'Nothing selected'
          : lookingUp ? 'Looking up…'
            : advicePending ? 'Reading model shape…'
              : error !== null ? error
                : current === null ? 'Checking space…'
                  : !current.fits ? (current.reason ?? 'It does not fit on the disk')
                    : null;

  const start = async (): Promise<void> => {
    if (lookup === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.downloadPreview(lookup.lookupId, validKeys);
      if (!p.ok) {
        if (STALE_CODES.has(p.error.code)) setStale(p.error.message); else setError(p.error.message);
        return;
      }
      if (!p.data.fits) { setPreview({ sig, data: p.data }); return; }
      const s = await api.downloadStart(p.data.previewId, p.data.fingerprint);
      if (!s.ok) {
        if (STALE_CODES.has(s.error.code)) setStale(s.error.message); else setError(s.error.message);
        return;
      }
      toast({ title: `Download started: ${lookup.repoId}`, tone: 'success' });
      clear();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <footer data-testid="download-footer" className="flex items-center gap-3 border-t border-border bg-bar px-3.5 py-2.5 text-[13px]">
      <span data-testid="download-summary">
        {`Selected: ${totals.files} ${totals.files === 1 ? 'file' : 'files'} · requires ${formatBytes(requires)}`}
        {disk !== undefined && ` · ${formatBytes(disk.freeBytes)} free on ${disk.pathDisplay}`}
      </span>
      {stale !== null && (
        <span role="alert" data-testid="stale-note" className="flex items-center gap-2 text-warning">
          {stale}
          <Button onClick={onLookupAgain}>Look up again</Button>
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        {reason !== null && <span data-testid="download-reason" className="text-xs text-muted-foreground">{reason}</span>}
        <Button data-testid="download-button" variant="primary" size="md" disabled={reason !== null || busy || stale !== null} onClick={() => void start()}>
          {requires > 0 ? `Download ${formatBytes(requires)}` : 'Download'}
        </Button>
      </span>
    </footer>
  );
}
