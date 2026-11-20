import { useCallback, useEffect, useRef, useState } from 'react';
import type { TransferDriveDTO, TransferRepoDTO, TransferVolumeDTO } from '../../shared/api';
import { useApi } from '../lib/api';
import { formatBytes } from '../lib/format';
import { Button } from './ui/button';

export const NO_EXPORTS_TEXT = 'No drive with exported models was found. Connect the drive, then choose Refresh.';
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface LoadFromDriveProps {
  /** The repo of the drive that is open on the right (highlighted), or null. */
  activeKey: string | null;
  onOpen(volumeId: string, repo: TransferRepoDTO): void;
  onBack(): void;
}

/**
 * Load from USB: looks at every connected drive for a transfer folder. One drive with exports is opened at once;
 * several are listed to choose from. The drive's models are then listed, and choosing one shows its files on the right
 * exactly like a Hub look-up. Nothing about the drive is remembered: the search runs again every time this opens.
 */
export function LoadFromDrive({ activeKey, onOpen, onBack }: LoadFromDriveProps) {
  const api = useApi();
  const [volumes, setVolumes] = useState<TransferVolumeDTO[] | null>(null);
  const [drive, setDrive] = useState<TransferDriveDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);

  const openDrive = useCallback(async (volumeId: string, mine: number): Promise<void> => {
    try {
      const r = await api.transferDrive(volumeId);
      if (mine !== token.current) return;
      if (r.ok) setDrive(r.data); else setError(r.error.message);
    } catch (e) {
      if (mine === token.current) setError(errText(e));
    }
  }, [api]);

  const search = useCallback(async (): Promise<void> => {
    const mine = ++token.current;
    setVolumes(null);
    setDrive(null);
    setError(null);
    try {
      const r = await api.transferVolumes();
      if (mine !== token.current) return;
      if (!r.ok) { setVolumes([]); setError(r.error.message); return; }
      const withExports = r.data.filter((v) => v.hasTransfer);
      setVolumes(withExports);
      if (withExports.length === 1) await openDrive(withExports[0]!.id, mine);
    } catch (e) {
      if (mine === token.current) { setVolumes([]); setError(errText(e)); }
    }
  }, [api, openDrive]);

  useEffect(() => {
    void search();
    return () => { token.current += 1; };
  }, [search]);

  return (
    <div data-testid="load-from-drive" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        <h3 className="min-w-0 flex-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Load from USB</h3>
        <Button size="sm" onClick={() => void search()} disabled={volumes === null}>Refresh</Button>
        <Button size="sm" variant="ghost" onClick={onBack}>Back</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {volumes === null && <p className="px-3 text-xs text-muted-foreground">Looking for drives…</p>}
        {error !== null && <p role="alert" data-testid="drive-error" className="px-3 text-xs text-danger">{error}</p>}
        {volumes !== null && volumes.length === 0 && error === null && <p data-testid="drive-none" className="px-3 text-xs text-muted-foreground">{NO_EXPORTS_TEXT}</p>}
        {drive === null && volumes !== null && volumes.length > 1 && (
          <>
            <p className="px-3 pb-1 text-xs text-muted-foreground">More than one drive has exported models. Choose one.</p>
            {volumes.map((v) => (
              <button
                key={v.id} type="button" data-testid="drive-volume" onClick={() => void openDrive(v.id, token.current)}
                className="block w-full cursor-pointer border-b border-border/60 px-3 py-2 text-left text-[13px] text-foreground hover:bg-accent/50"
              >
                <span className="font-mono">{v.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{`${formatBytes(v.totalBytes - v.freeBytes)} used`}</span>
              </button>
            ))}
          </>
        )}
        {drive !== null && (
          <>
            <p data-testid="drive-name" title={drive.volume.name} className="truncate px-3 pb-1 font-mono text-xs text-muted-foreground">{`On ${drive.volume.name}`}</p>
            {drive.notes.map((n) => <p key={n} data-testid="drive-note" className="px-3 pb-1 text-xs text-warning">{n}</p>)}
            {drive.repos.length === 0 && <p className="px-3 text-xs text-muted-foreground">This drive has no complete export on it.</p>}
            {drive.repos.map((r) => (
              <button
                key={r.key} type="button" data-testid="drive-repo" data-repo-key={r.key} disabled={r.files === 0}
                aria-current={activeKey === r.key ? 'true' : undefined} onClick={() => onOpen(drive.volume.id, r)}
                className={`block w-full cursor-pointer border-b border-border/60 px-3 py-2 text-left hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60 ${activeKey === r.key ? 'bg-accent' : ''}`}
              >
                <div className="truncate text-[13px] text-foreground">{r.repoId}</div>
                <div className="text-[11px] text-muted-foreground">
                  {`${formatBytes(r.bytes)} · ${r.files} ${r.files === 1 ? 'file' : 'files'} · ${r.ref ?? r.commitShort}`}
                  {r.type !== 'model' && ` · ${r.type}`}
                </div>
                {r.incompleteFiles > 0 && (
                  <div className="text-[11px] text-warning">{`${r.incompleteFiles} ${r.incompleteFiles === 1 ? 'file is' : 'files are'} incomplete on the drive and cannot be loaded`}</div>
                )}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
