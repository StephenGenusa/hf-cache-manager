import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ApiError, SyncEntryDTO, SyncPlanDTO, SyncResultDTO, SyncViewDTO, SyncViewResultDTO } from '../../shared/api';
import { useApi } from '../lib/api';
import { queryKeys } from '../lib/queries';
import { ErrorNote } from './ErrorNote';
import { PathCell } from './PathCell';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

const LABEL = { lmstudio: 'LM Studio', ollama: 'Ollama' } as const;
const ACTIONABLE = ['adds', 'updates', 'removals', 'tombstones', 'adopts'] as const;

/** Nothing to do iff no view has an add, update, removal, tombstone or adopt. */
export const hasWork = (plan: SyncPlanDTO): boolean => plan.views.some((v) => ACTIONABLE.some((k) => v[k].length > 0));

/** An error after which a fresh preview is the way on: a voided plan, or a refusal that left nothing changed. By code, never by wording. */
const needsNewPreview = (e: ApiError): boolean =>
  e.code === 'EXPIRED' || e.code === 'UNKNOWN_PLAN' || e.code === 'USED' || e.code === 'STALE'
  || e.code === 'BUSY' || e.code === 'CONFIG' || e.code === 'HUB_MISSING';

type State =
  | { kind: 'planning' }
  | { kind: 'preview'; plan: SyncPlanDTO }
  | { kind: 'running'; plan: SyncPlanDTO }
  | { kind: 'result'; result: SyncResultDTO }
  | { kind: 'error'; error: ApiError; again: boolean };

/** UI copy for main's machine note: a conditional removal is kept when another Ollama model still uses the blob. */
export const noteText = (note: string): string => note.replace('removed only if no manifest uses it', 'removed only if no other Ollama model uses it');

function Entries({ title, entries, testId }: { title: string; entries: SyncEntryDTO[]; testId: string }) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-xs font-semibold text-foreground">{title} ({entries.length})</div>
      <ul className="mt-1 flex flex-col gap-1">
        {entries.map((e, i) => (
          <li key={`${e.key}:${i}`} data-testid={testId} data-key={e.key} className="rounded border border-border px-2 py-1 text-xs">
            <div className="font-medium break-all text-foreground">{e.key}</div>
            {/* final review M4: the view-relative path, then its exact absolute path, as the deletion review shows them */}
            {e.paths.map((p, pi) => (
              <div key={`${pi}:${p}`} className="font-mono text-[11px] break-all text-muted-foreground">
                <PathCell label={p} full={e.fullPaths[pi] ?? p} />
              </div>
            ))}
            {e.note !== null && <div className="text-[11px] text-muted-foreground">{noteText(e.note)}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ViewSection({ v }: { v: SyncViewDTO }) {
  const label = LABEL[v.view];
  return (
    <section data-testid="sync-view" data-view={v.view} className="rounded-lg border border-border px-3 py-2.5">
      <h3 className="text-[13px] font-semibold text-foreground">{label}{v.rootDisplay !== null && <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">{v.rootDisplay}</span>}</h3>
      {v.skippedReason !== null && <p data-testid="sync-view-skipped" className="mt-1 text-xs text-warning">Skipped: {v.skippedReason}</p>}
      {v.wouldRemoveAll && (
        <p data-testid="mass-removal-warning" className="mt-2 rounded-md border border-danger bg-danger-soft px-2.5 py-1.5 text-xs text-danger">
          Sync would remove every entry it manages in {label} ({v.ownedCount}). This usually means the cache drive is not mounted.
        </p>
      )}
      {v.warnings.map((w, wi) => <p key={`${wi}:${w}`} className="mt-1 text-xs text-warning">{w}</p>)}
      <Entries title="Will add" entries={v.adds} testId="sync-add" />
      <Entries title="Will update" entries={v.updates} testId="sync-update" />
      <Entries title="Will remove" entries={v.removals} testId="sync-removal" />
      <Entries title="Will start tracking" entries={v.adopts} testId="sync-adopt" />
      <Entries title="Deleted outside sync — will stop tracking" entries={v.tombstones} testId="sync-tombstone" />
      <Entries title="Not ours — never touched" entries={v.foreign} testId="sync-foreign" />
      <Entries title="Skipped" entries={v.skipped} testId="sync-skipped" />
    </section>
  );
}

export const summaryLine = (v: SyncViewResultDTO): string => {
  const extra = `${v.adopted > 0 ? ` · ${v.adopted} now tracked` : ''}${v.tombstoned > 0 ? ` · ${v.tombstoned} no longer tracked` : ''}`;
  return `${LABEL[v.view]}: ${v.created} added · ${v.updated} updated · ${v.removed} removed · ${v.skipped} skipped${extra}`;
};

function ResultView({ result }: { result: SyncResultDTO }) {
  const ranNothing = result.views.length === 0;
  return (
    <div data-testid="sync-result" data-ok={result.ok} className="flex flex-col gap-2">
      <p data-testid="sync-result-headline" className={result.ok ? 'font-semibold text-foreground' : 'font-semibold text-danger'}>
        {result.ok ? 'Sync finished.' : ranNothing ? 'Sync did not run: nothing was changed.' : 'Sync did not complete. Check each view below.'}
      </p>
      {result.massRemovalViews.length > 0 && (
        <p data-testid="sync-mass-refused" className="rounded-md border border-danger bg-danger-soft px-2.5 py-1.5 text-xs text-danger">
          Refused: sync would remove every entry it manages in {result.massRemovalViews.map((x) => LABEL[x]).join(' and ')}. Preview again and tick the box to allow it.
        </p>
      )}
      {result.views.map((v) => (
        <div key={v.view} data-testid="sync-view-result" data-view={v.view} data-status={v.status} className="rounded-lg border border-border px-3 py-2 text-xs">
          <div className="text-foreground">{summaryLine(v)}</div>
          {v.error !== null && <div data-testid="sync-view-error" className="mt-1 text-danger">{v.error}</div>}
          {v.partialWrites.length > 0 && (
            <div data-testid="sync-partial-writes" className="mt-1.5 rounded-md border border-danger bg-danger-soft px-2.5 py-1.5 text-danger">
              <div className="font-semibold">Failed after a partial write — check these entries by hand:</div>
              <ul className="list-disc pl-4">{v.partialWrites.map((p, pi) => <li key={`${pi}:${p}`} className="break-all">{p}</li>)}</ul>
            </div>
          )}
          {v.warnings.map((w, wi) => <div key={`${wi}:${w}`} className="mt-1 text-warning">{w}</div>)}
        </div>
      ))}
    </div>
  );
}

/**
 * The sync preview and run. Opening it plans; Execute runs that exact preview once. Mass removal needs the
 * checkbox naming every affected view. A voided or expired preview leads back to a fresh preview, never a retry.
 */
export function SyncDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const api = useApi();
  const client = useQueryClient();
  const [state, setState] = useState<State>({ kind: 'planning' });
  const [allow, setAllow] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);

  const preview = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    busy.current = false;
    setAllow(false);
    setState({ kind: 'planning' });
    let next: State;
    try {
      const r = await api.planSync();
      next = r.ok ? { kind: 'preview', plan: r.data } : { kind: 'error', error: r.error, again: needsNewPreview(r.error) };
    } catch (e) {
      next = { kind: 'error', error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) }, again: false };
    }
    if (mine === generation.current) setState(next);
  }, [api]);

  // layout effect: a reopened dialog is reset before its first paint, so it never flashes the last preview or result
  useLayoutEffect(() => {
    if (open) void preview();
    else {
      generation.current++;
      busy.current = false;
      setAllow(false);
      setState({ kind: 'planning' });
    }
  }, [open, preview]);

  async function execute(plan: SyncPlanDTO): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setState({ kind: 'running', plan });
    let next: State;
    try {
      const r = await api.executeSync(plan.planId, { allowMassRemoval: allow });
      next = r.ok ? { kind: 'result', result: r.data } : { kind: 'error', error: r.error, again: needsNewPreview(r.error) };
    } catch (e) {
      next = { kind: 'error', error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) }, again: false };
    }
    // main rescans and re-lists after any sync that ran
    for (const key of [queryKeys.library, ['repo'], ['advice'], queryKeys.held, queryKeys.disk]) void client.invalidateQueries({ queryKey: key });
    setState(next);
  }

  const plan = state.kind === 'preview' || state.kind === 'running' ? state.plan : null;
  const massViews = plan === null ? [] : plan.views.filter((v) => v.wouldRemoveAll).map((v) => v.view);
  const work = plan !== null && hasWork(plan);
  const canRun = state.kind === 'preview' && work && (massViews.length === 0 || allow);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && state.kind !== 'running') onClose(); }}>
      <DialogContent data-testid="sync-dialog" aria-describedby="sync-desc">
        <DialogHeader>
          <DialogTitle>Sync LM Studio + Ollama</DialogTitle>
          <DialogDescription id="sync-desc">Preview of what sync will change. Nothing changes until you press Execute.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-5 py-4">
          {state.kind === 'planning' && <p className="text-muted-foreground"><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />Building the preview…</p>}
          {state.kind === 'error' && (
            <>
              <ErrorNote error={state.error} testId="sync-error" verbatim />
              {state.again && <div><Button data-testid="btn-sync-again" variant="primary" onClick={() => void preview()}>Preview again</Button></div>}
            </>
          )}
          {plan !== null && (
            <>
              {plan.warnings.map((w, wi) => <p key={`${wi}:${w}`} className="rounded-md border border-border bg-secondary px-3 py-2 text-xs text-warning">{w}</p>)}
              {plan.views.map((v) => <ViewSection key={v.view} v={v} />)}
              {!work && <p data-testid="sync-nothing" className="text-muted-foreground">Nothing to do</p>}
              {massViews.length > 0 && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-danger">
                  <Checkbox data-testid="mass-removal-checkbox" checked={allow} onCheckedChange={(c) => setAllow(c === true)} disabled={state.kind === 'running'} />
                  Allow removing every managed entry ({massViews.map((x) => LABEL[x]).join(', ')})
                </label>
              )}
            </>
          )}
          {state.kind === 'result' && <ResultView result={state.result} />}
        </div>
        <DialogFooter className="justify-end">
          <Button data-testid="btn-sync-close" onClick={onClose} disabled={state.kind === 'running'}>{state.kind === 'result' ? 'Close' : 'Cancel'}</Button>
          {state.kind !== 'result' && state.kind !== 'error' && (
            <Button data-testid="btn-sync-execute" variant="primary" disabled={!canRun} onClick={() => plan !== null && void execute(plan)}>
              {state.kind === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Execute
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
