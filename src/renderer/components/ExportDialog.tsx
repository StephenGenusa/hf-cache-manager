import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Selection } from '../../core/types';
import type { ExportPreviewDTO, TransferVolumeDTO } from '../../shared/api';
import { useApi } from '../lib/api';
import { formatBytes } from '../lib/format';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

export const NO_DRIVE_TEXT = 'No drive was found. Connect a USB drive, then choose Refresh.';
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface ExportDialogProps {
  /** The Library selection to export; null keeps the dialog closed. */
  selection: Selection | null;
  onClose(): void;
  /** The export was started (the caller shows its progress). */
  onStarted(): void;
}

/**
 * Export to drive: pick a drive from the ones connected, see what the selection would write there and whether it
 * fits, then start. The drive is named only by the id main gave it; main re-checks the room when the export starts.
 */
export function ExportDialog({ selection, onClose, onStarted }: ExportDialogProps) {
  const api = useApi();
  const open = selection !== null;
  const [volumes, setVolumes] = useState<TransferVolumeDTO[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExportPreviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const token = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++token.current;
    setVolumes(null);
    setChosen(null);
    setPreview(null);
    setError(null);
    try {
      const r = await api.transferVolumes();
      if (mine !== token.current) return;
      if (!r.ok) { setVolumes([]); setError(r.error.message); return; }
      setVolumes(r.data);
      if (r.data.length === 1) setChosen(r.data[0]!.id);
    } catch (e) {
      if (mine === token.current) { setVolumes([]); setError(errText(e)); }
    }
  }, [api]);

  useEffect(() => {
    if (open) void refresh();
    else token.current += 1;
  }, [open, refresh]);

  // What the selection would write to the chosen drive (nothing is written by asking).
  useEffect(() => {
    if (selection === null || chosen === null) { setPreview(null); return undefined; }
    let live = true;
    setPreview(null);
    setError(null);
    setChecking(true);
    void api.exportPreview(selection, chosen).then((r) => {
      if (!live) return;
      if (r.ok) setPreview(r.data); else setError(r.error.message);
      setChecking(false);
    }, (e: unknown) => { if (live) { setError(errText(e)); setChecking(false); } });
    return () => { live = false; };
  }, [api, selection, chosen]);

  const start = async (): Promise<void> => {
    if (preview === null || !preview.fits || starting) return;
    setStarting(true);
    setError(null);
    try {
      const r = await api.exportStart(preview.previewId);
      if (!r.ok) { setError(r.error.message); setPreview(null); return; }
      onStarted();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent data-testid="export-dialog" className="w-[min(560px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Export to drive</DialogTitle>
          <DialogDescription>
            Copies the selected models into a folder named hf-cache-manager-transfer on the drive, so another computer can load them.
            Nothing else on the drive is changed or removed.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[13px]">
          {volumes === null && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking for drives…</p>}
          {volumes !== null && volumes.length === 0 && error === null && <p data-testid="export-no-drive" className="text-muted-foreground">{NO_DRIVE_TEXT}</p>}
          {volumes !== null && volumes.length > 0 && (
            <fieldset>
              <legend className="mb-1.5 text-xs font-semibold text-muted-foreground">Drive</legend>
              <ul className="flex flex-col gap-1">
                {volumes.map((v) => (
                  <li key={v.id}>
                    <label data-testid="export-volume" data-volume-name={v.name} className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 hover:bg-accent/50">
                      <input type="radio" name="export-volume" checked={chosen === v.id} onChange={() => setChosen(v.id)} />
                      <span className="min-w-0 flex-1 truncate font-mono text-foreground">{v.name}</span>
                      {v.hasTransfer && <Badge>has exports</Badge>}
                      <span className="tabular-nums text-muted-foreground">{`${formatBytes(v.freeBytes)} free of ${formatBytes(v.totalBytes)}`}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          {checking && <p className="mt-3 text-muted-foreground">Checking space…</p>}
          {preview !== null && (
            <div data-testid="export-preview" className="mt-3">
              <p>
                {`${preview.files} ${preview.files === 1 ? 'file' : 'files'} to copy · needs `}
                <b className="text-foreground">{formatBytes(preview.requiresBytes)}</b>
                {` · ${formatBytes(preview.freeBytes)} free on ${preview.volumeName}`}
              </p>
              {preview.reason !== null && (
                <p role={preview.fits ? undefined : 'alert'} data-testid="export-reason" className={preview.fits ? 'mt-1 text-muted-foreground' : 'mt-1 text-danger'}>{preview.reason}</p>
              )}
              {preview.skipped.length > 0 && (
                <div data-testid="export-skipped" className="mt-2 text-xs text-warning">
                  <p>{`${preview.skipped.length} ${preview.skipped.length === 1 ? 'file' : 'files'} cannot be exported and will be left out:`}</p>
                  <ul className="mt-0.5 list-disc pl-4">
                    {preview.skipped.slice(0, 5).map((s) => <li key={s} className="break-all">{s}</li>)}
                    {preview.skipped.length > 5 && <li>{`and ${preview.skipped.length - 5} more`}</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
          {error !== null && <p role="alert" data-testid="export-error" className="mt-3 text-danger">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={() => void refresh()} disabled={volumes === null || starting}>Refresh</Button>
          <span className="ml-auto flex items-center gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button data-testid="export-start" variant="primary" size="md" disabled={preview === null || !preview.fits || starting} onClick={() => void start()}>
              {preview !== null && preview.requiresBytes > 0 ? `Export ${formatBytes(preview.requiresBytes)}` : 'Export'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
