import { formatBytes } from '../lib/format';
import { useDiskInfo, useLibrary } from '../lib/queries';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

const pct = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

export function DiskMeter() {
  const disk = useDiskInfo();
  const lib = useLibrary().data;
  const d = disk.data;
  if (!d) return <div data-testid="disk-info" className="ml-auto" />;
  // The cache figure exists only after a good scan. Recently Deleted still takes space, so it counts as cache. The cache
  // is drawn inside the used part of the disk, never past it.
  const cache = lib && lib.hubPresent && lib.scanError === null ? lib.hubBytes + lib.heldBytes : null;
  const cacheShown = cache === null ? 0 : Math.min(cache, d.usedBytes);
  const other = d.usedBytes - cacheShown;
  const freeText = `${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`;
  const valueText = cache === null
    ? `${formatBytes(d.usedBytes)} used, ${freeText}`
    : `HF cache ${formatBytes(cache)}, everything else ${formatBytes(other)}, ${freeText}`;
  return (
    <div data-testid="disk-info" className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
      {cache !== null && <span>Cache <b className="font-semibold text-foreground">{formatBytes(cache)}</b></span>}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="meter" aria-label="Disk used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(pct(d.usedBytes, d.totalBytes)))}
              aria-valuetext={valueText} tabIndex={0} className="flex h-1.5 w-[160px] cursor-help overflow-hidden rounded-[3px] bg-border"
            >
              {cache !== null && <i data-testid="meter-cache" className="block h-full bg-gradient-to-r from-[#5b8cff] to-[#a06bff]" style={{ width: `${pct(cacheShown, d.totalBytes)}%` }} />}
              <i data-testid="meter-other" className="block h-full bg-muted-foreground/60" style={{ width: `${pct(other, d.totalBytes)}%` }} />
            </span>
          </TooltipTrigger>
          <TooltipContent className="font-sans break-normal">
            <div data-testid="disk-breakdown" className="space-y-0.5">
              <div>{d.pathDisplay} · {formatBytes(d.totalBytes)} disk</div>
              {cache !== null && <div>HF cache {formatBytes(cache)}</div>}
              {cache !== null && lib!.heldBytes > 0 && <div className="pl-3">of which Recently Deleted {formatBytes(lib!.heldBytes)}</div>}
              <div>{cache === null ? 'Used' : 'Everything else'} {formatBytes(other)}</div>
              <div>Free {formatBytes(d.freeBytes)}</div>
            </div>
          </TooltipContent>
      </Tooltip>
      </TooltipProvider>
      <span>{freeText}</span>
    </div>
  );
}
