import { useState } from 'react';
import { useApi } from '../lib/api';
import type { UpdateCheckState } from '../lib/use-update-check';
import { Button } from './ui/button';

const two = (n: number): string => String(n).padStart(2, '0');
/** Local time, as the rest of the app writes dates: 2026-11-20 09:05. */
export const checkedAtText = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const clockText = (ms: number): string => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/**
 * The library's "Check for updates": the button, a progress bar while a run is going (with Cancel), and what the
 * last run found. A check is only ever started here, by hand.
 */
export function UpdateCheckBar({ check }: { check: UpdateCheckState }) {
  const api = useApi();
  const [startError, setStartError] = useState<string | null>(null);
  const d = check.data;
  const p = check.progress;
  const running = p?.running === true;
  const updates = d?.results.filter((r) => r.status === 'update') ?? [];
  const unchecked = d?.results.filter((r) => r.status !== 'update') ?? [];
  const error = startError ?? d?.error ?? null;

  const start = (): void => {
    setStartError(null);
    void api.updateCheckStart().then(
      (r) => { if (r.ok) check.refresh(); else setStartError(r.error.message); },
      (e: unknown) => setStartError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <div data-testid="update-check" className="mx-2.5 mb-2 space-y-1 text-[11px] text-muted-foreground">
      {running && p !== null ? (
        <>
          <div className="flex items-center gap-1.5">
            <div
              role="progressbar" aria-label="Checking for updates" aria-valuemin={0} aria-valuenow={p.done} aria-valuemax={p.total}
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary"
            >
              <div className="h-full bg-primary transition-[width]" style={{ width: `${p.total === 0 ? 0 : Math.round((p.done / p.total) * 100)}%` }} />
            </div>
            <Button size="sm" onClick={() => void api.updateCheckCancel().catch(() => undefined)}>Cancel</Button>
          </div>
          <p className="truncate" title={p.current ?? undefined}>
            {p.waitingUntil !== null ? `The Hub is rate-limiting; continuing at ${clockText(p.waitingUntil)}`
              : `Checking ${p.done} of ${p.total}${p.current === null ? '' : ` · ${p.current}`}`}
          </p>
        </>
      ) : (
        <div className="flex items-center gap-1.5">
          <Button size="sm" disabled={d === undefined || d.disabledReason !== null} onClick={start}>Check for updates</Button>
          {d !== undefined && d.disabledReason === null && (
            <span data-testid="update-summary" className="min-w-0 truncate">
              {d.checkedAt === null ? 'Not checked yet'
                : `${updates.length === 0 ? 'No updates' : `${updates.length} ${updates.length === 1 ? 'repo has' : 'repos have'} updates`} · checked ${checkedAtText(d.checkedAt)}`}
            </span>
          )}
        </div>
      )}
      {!running && d?.disabledReason != null && <p className="text-warning">{d.disabledReason}</p>}
      {!running && unchecked.length > 0 && (
        <p data-testid="update-unchecked" className="cursor-help underline decoration-dotted underline-offset-2" title={unchecked.map((r) => `${r.repoId}: ${r.message ?? 'not checked'}`).join('\n')}>
          {`${unchecked.length} could not be checked`}
        </p>
      )}
      {!running && error !== null && <p role="alert" data-testid="update-error" className="text-warning">{error}</p>}
    </div>
  );
}
