import { Download, Moon, RefreshCw, Sun } from 'lucide-react';
import { useLibrary, useScanProgress } from '../lib/queries';
import { useTheme } from '../lib/theme';
import { unfinishedCount, useDownloads } from '../state/downloads';
import { Button } from './ui/button';
import { DiskMeter } from './DiskMeter';
import { SessionLog } from './SessionLog';

export type AppMode = 'library' | 'download';

export function TopBar({ onSync, mode = 'library', onMode, onDownloads }: { onSync(): void; mode?: AppMode; onMode?(m: AppMode): void; onDownloads?(): void }) {
  const { theme, toggle } = useTheme();
  const unfinished = useDownloads((s) => unfinishedCount(s.items, s.live));
  const library = useLibrary();
  const progress = useScanProgress();
  const scanning = library.isFetching;
  const lib = library.data;
  const showProgress = scanning && progress !== null && progress.phase !== 'done' && progress.phase !== 'error';
  const rescanLabel = !scanning ? 'Rescan' : showProgress ? `Scanning… ${progress.done}/${progress.total}` : 'Scanning…';
  const syncReason = lib === undefined ? null
    : !lib.hubPresent ? 'Cache not found'
      : lib.scanError !== null ? 'Cache could not be read'
        : null;

  return (
    <header data-testid="top-bar" className="flex items-center gap-2.5 border-b border-border bg-bar px-3.5 py-2.5">
      <span className="font-semibold text-foreground dark:text-white">HF Cache Manager</span>
      {onMode !== undefined && (
        <div role="group" aria-label="Mode" className="flex gap-0.5 rounded-md border border-border p-0.5">
          <Button size="sm" variant={mode === 'library' ? 'tonal' : 'ghost'} aria-pressed={mode === 'library'} onClick={() => onMode('library')}>Library</Button>
          <Button size="sm" variant={mode === 'download' ? 'tonal' : 'ghost'} aria-pressed={mode === 'download'} onClick={() => onMode('download')}>Download</Button>
        </div>
      )}
      <Button data-testid="btn-rescan" onClick={() => void library.refetch()} disabled={scanning}>
        <RefreshCw className={scanning ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> {rescanLabel}
      </Button>
      <Button data-testid="btn-sync" variant="primary" onClick={onSync} disabled={lib === undefined || syncReason !== null || scanning}>
        Sync LM Studio + Ollama
      </Button>
      {syncReason !== null && <span data-testid="sync-disabled-reason" className="text-xs text-warning">{syncReason}</span>}
      <DiskMeter />
      {onDownloads !== undefined && (
        <Button data-testid="btn-downloads" onClick={onDownloads}>
          <Download className="h-3.5 w-3.5" /> Downloads
          {unfinished > 0 && <span data-testid="downloads-badge" aria-label={`${unfinished} unfinished`} className="ml-1 rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground">{unfinished}</span>}
        </Button>
      )}
      <SessionLog />
      <Button variant="ghost" size="icon" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
        {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>
    </header>
  );
}
