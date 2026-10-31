import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiError, StartupNoticeDTO } from '../../shared/api';
import { useApi } from '../lib/api';
import { noticeKey, queryKeys, useLibrary, useStartupNotices } from '../lib/queries';
import { ErrorNote } from './ErrorNote';
import { Button } from './ui/button';
import { toast } from './ui/toast';

/**
 * How often the notices are re-read. Main posts some notices (auto-empty-pending, auto-empty-skipped, held-unreadable) only
 * after the first scan finishes, so they are also re-read whenever a scan settles.
 */
export const NOTICE_POLL_MS = 30_000;

const idOf = (n: StartupNoticeDTO): string => (n.kind === 'journal' ? n.planId : n.id);

/**
 * One amber banner per startup notice. Dismiss acknowledges it through main. The auto-empty-pending banner has a
 * "keep them" dismissal and a link to Recently Deleted; when it clears (dismissed, or the run happened) the library is
 * refreshed. A dismissal that main answers with NOT_FOUND ("already being emptied") is information, not an error.
 */
export function StartupNotice({ onOpenHeld }: { onOpenHeld?: () => void }) {
  const api = useApi();
  const client = useQueryClient();
  const notices = useStartupNotices(NOTICE_POLL_MS);
  const library = useLibrary();
  const scannedAt = library.dataUpdatedAt;
  const [info, setInfo] = useState<ApiError | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const hadPending = useRef(false);
  // the countdown is recomputed on every poll (even when the poll returns identical data) so it never overstates the time left
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), NOTICE_POLL_MS);
    return () => clearInterval(t);
  }, [notices.dataUpdatedAt]);

  const list = notices.data ?? [];
  const pending = list.some((n) => n.kind === 'auto-empty-pending');
  // A scan that settles may have posted notices; fetch them now rather than at the next poll
  useEffect(() => {
    if (scannedAt > 0) void client.invalidateQueries({ queryKey: noticeKey });
  }, [scannedAt, client]);
  useEffect(() => {
    if (hadPending.current && !pending) {
      for (const key of [queryKeys.library, ['repo'], ['advice'], queryKeys.held, queryKeys.disk]) void client.invalidateQueries({ queryKey: key });
    }
    hadPending.current = pending;
  }, [pending, client]);

  // the warning must be visible whatever screen is open (a modal can cover the banner): also raise a persistent toast
  const pendingNotice = list.find((n) => n.kind === 'auto-empty-pending');
  const pendingMessage = pendingNotice?.message ?? null;
  const toasted = useRef(false);
  useEffect(() => {
    if (pendingMessage === null) { toasted.current = false; return; }
    if (toasted.current) return;
    toasted.current = true;
    toast({ title: 'Recently Deleted will be emptied automatically', description: pendingMessage, tone: 'danger', testId: 'pending-toast' });
  }, [pendingMessage]);

  async function dismiss(n: StartupNoticeDTO): Promise<void> {
    setInfo(null);
    setFailure(null);
    let error: ApiError | null = null;
    try {
      const r = await api.ackStartupNotice(idOf(n));
      if (!r.ok) error = r.error;
    } catch (e) {
      error = { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
    }
    if (error !== null) {
      if (n.kind === 'auto-empty-pending' && error.code === 'NOT_FOUND') setInfo(error);
      else setFailure(error);
    }
    await client.invalidateQueries({ queryKey: noticeKey });
  }

  if (list.length === 0 && info === null && failure === null && !notices.isError) return null;
  return (
    <div data-testid="startup-notices" className="flex flex-col gap-1.5 border-b border-border px-3.5 py-2">
      {notices.isError && (
        <div data-testid="notices-error" className="flex items-center gap-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-xs text-danger">
          <p className="min-w-0 flex-1">Startup notices could not be read, so a pending automatic emptying of Recently Deleted may not be shown. Retrying every 30 seconds.</p>
          <Button onClick={() => void notices.refetch()}>Retry</Button>
        </div>
      )}
      {list.map((n) => (
        <div
          key={idOf(n)} data-testid="startup-notice" data-kind={n.kind}
          className="flex items-start gap-3 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning"
        >
          <p className="min-w-0 flex-1">
            {n.message}
            {n.kind === 'auto-empty-pending' && n.emptyAt !== null && (
              <span data-testid="notice-countdown" className="block font-semibold">
                will be emptied at {new Date(n.emptyAt).toLocaleTimeString()} (in {Math.max(0, Math.floor((n.emptyAt - now) / 60_000))} min)
              </span>
            )}
          </p>
          {n.kind === 'auto-empty-pending' && onOpenHeld !== undefined && (
            <Button data-testid="notice-open-held" variant="ghost" onClick={onOpenHeld}>Open Recently Deleted</Button>
          )}
          <Button data-testid="notice-dismiss" onClick={() => void dismiss(n)}>
            {n.kind === 'auto-empty-pending' ? 'Dismiss — keep them this session' : 'Dismiss'}
          </Button>
        </div>
      ))}
      {info !== null && <ErrorNote error={info} tone="info" testId="notice-info" />}
      {failure !== null && <ErrorNote error={failure} testId="notice-error" />}
    </div>
  );
}
