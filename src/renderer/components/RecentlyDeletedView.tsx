import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { ApiError, ApiResult, HeldDeletionDTO } from '../../shared/api';
import { useApi } from '../lib/api';
import { formatAge, formatBytes } from '../lib/format';
import { noticeKey, queryKeys, useHeld } from '../lib/queries';
import { AutoEmptySelect } from './AutoEmptySelect';
import { ErrorNote } from './ErrorNote';
import type { ReviewSource } from './ReviewDialog';
import { Button } from './ui/button';

export const INTERRUPTED_NOTE = 'A move into Recently Deleted did not finish. Restore it to recover the files.';

export interface RecentlyDeletedViewProps {
  /** A plan was built; the caller opens the review. `replan` builds a fresh one (Review again never retries the old plan). */
  onReview(source: ReviewSource, replan: () => Promise<ReviewSource | null>): void;
}

const canRestore = (s: HeldDeletionDTO['status']): boolean => s === 'held' || s === 'partial' || s === 'interrupted';
const canDelete = (s: HeldDeletionDTO['status']): boolean => s === 'held' || s === 'partial' || s === 'leftover';

/** Recently Deleted: the held deletions with Restore and Delete Permanently; every action opens a review. */
export function RecentlyDeletedView({ onReview }: RecentlyDeletedViewProps) {
  const api = useApi();
  const client = useQueryClient();
  const held = useHeld();
  const [error, setError] = useState<ApiError | null>(null);
  const planning = useRef(false);

  const fail = (e: unknown): ApiResult<never> => ({ ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } });

  /**
   * One planning request at a time; a failure is shown in the view, a plan opens the review. `withdraws`:
   * main has taken this deletion out of a pending auto-empty run, so the list badges and the notice are refetched.
   */
  async function plan(make: () => Promise<ReviewSource | ApiError>, withdraws = false): Promise<void> {
    if (planning.current) return;
    planning.current = true;
    setError(null);
    try {
      const replan = async (): Promise<ReviewSource | null> => {
        const s = await make();
        if ('code' in s) { setError(s); return null; }
        return s;
      };
      const source = await replan();
      if (withdraws) for (const key of [queryKeys.held, noticeKey]) void client.invalidateQueries({ queryKey: key });
      if (source !== null) onReview(source, replan);
    } finally {
      planning.current = false;
    }
  }

  const restore = (deletionId: string) => async (): Promise<ReviewSource | ApiError> => {
    const r = await api.planRestore(deletionId).catch(fail);
    return r.ok ? { kind: 'restore', plan: r.data } : r.error;
  };
  const empty = (target: { all: true } | { deletionId: string }) => async (): Promise<ReviewSource | ApiError> => {
    const r = await api.planEmpty(target).catch(fail);
    return r.ok ? { kind: 'empty', batch: r.data } : r.error;
  };

  if (held.isPending) return <div data-testid="held-view" className="text-muted-foreground">Loading Recently Deleted…</div>;
  if (held.isError) {
    return (
      <div data-testid="held-view">
        <ErrorNote error={{ code: 'INTERNAL', message: held.error.message }} />
      </div>
    );
  }
  const list = held.data;
  const now = Date.now();
  return (
    <div data-testid="held-view" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-foreground">Recently Deleted</h2>
        {list.available && <span data-testid="held-total" className="text-xs text-muted-foreground">{formatBytes(list.totalBytes)} held</span>}
        <span className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span data-testid="auto-empty-label">
            Auto-empty: {!list.available ? `off: ${list.unavailableReason ?? 'Recently Deleted is not available.'}`
              : list.autoEmptyDays === null ? 'never' : `after ${list.autoEmptyDays} days`}
          </span>
          {list.available && (<>
            <AutoEmptySelect days={list.autoEmptyDays} />
            <Button data-testid="btn-empty-all" variant="destructive" disabled={list.items.length === 0} onClick={() => void plan(empty({ all: true }))}>
              Empty all
            </Button>
          </>)}
        </span>
      </div>
      {error !== null && <ErrorNote error={error} testId="held-error" />}
      {!list.available && (
        <p data-testid="held-unavailable" className="rounded-md border border-border bg-secondary px-3 py-2 text-xs text-warning">
          {list.unavailableReason ?? 'Recently Deleted is not available.'}
        </p>
      )}
      {list.available && list.items.length === 0 && <p className="text-muted-foreground">Nothing in Recently Deleted.</p>}
      {list.available && list.items.map((d) => (
        <div key={d.deletionId} data-testid="held-row" data-deletion-id={d.deletionId} data-status={d.status} className="rounded-lg border border-border bg-card px-3.5 py-2.5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium break-all text-foreground">{d.repoIds.length > 0 ? d.repoIds.join(', ') : d.deletionId}</div>
              <div className="text-xs text-muted-foreground">{d.groupLabels.join(' · ')}</div>
              <div className="text-xs text-muted-foreground">
                {d.status === 'corrupt' ? '' : formatBytes(d.bytes)}
                {d.heldAtMs > 0 ? ` · ${formatAge(now - d.heldAtMs)}` : ''}
                {d.status === 'partial' ? ' · partly restored' : ''}
              </div>
              {d.status === 'interrupted' && <p data-testid="held-note" className="mt-1 text-xs text-warning">{INTERRUPTED_NOTE}</p>}
              {d.status === 'leftover' && <p data-testid="held-note" className="mt-1 text-xs text-muted-foreground">Leftover files from an earlier deletion.</p>}
              {d.error !== null && <p data-testid="held-row-error" className="mt-1 text-xs text-danger">{d.error}</p>}
              {d.pendingAutoEmpty && (
                <p data-testid="held-auto-empty-badge" className="mt-1 inline-block rounded border border-warning px-1.5 py-0.5 text-[11px] text-warning">
                  {list.autoEmptyAt === null ? 'will be emptied automatically soon' : `will be emptied at ${new Date(list.autoEmptyAt).toLocaleTimeString()}`}
                </p>
              )}
            </div>
            {canRestore(d.status) && (
              <Button data-testid="btn-restore" onClick={() => void plan(restore(d.deletionId), true)}>Restore</Button>
            )}
            {canDelete(d.status) && (
              <Button data-testid="btn-held-delete" variant="destructive" onClick={() => void plan(empty({ deletionId: d.deletionId }), true)}>
                Delete Permanently
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
