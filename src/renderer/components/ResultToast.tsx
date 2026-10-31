import { useState } from 'react';
import type { ExecResultDTO, PlanDTO } from '../../shared/api';
import { execErrorText } from '../lib/exec-copy';
import { formatBytes } from '../lib/format';
import { Button } from './ui/button';

export interface ResultSummary { text: string; tone: 'success' | 'danger'; details?: string }

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The one-line outcome of an executed plan (precedence): a failure first, then a restore (a hold-mode plan whose
 * heldBytes must not be shown), then an empty or permanent delete, then a hold (wording).
 */
export function resultSummary(r: ExecResultDTO, plan: PlanDTO): ResultSummary {
  if (!r.ok) {
    const e = r.error ?? { code: 'INTERNAL' as const, message: 'The operation did not finish.' };
    if (e.code === 'INTERNAL') {
      return {
        text: `Something went wrong inside the app. It stopped after ${r.appliedOps} of ${r.totalOps} operations; the cache was rescanned — review the repo.`,
        tone: 'danger', details: e.message,
      };
    }
    if (e.code === 'ROLLED_BACK') return { text: execErrorText(e.code, e.message).text, tone: 'danger' };
    return { text: `Failed after ${r.appliedOps} of ${r.totalOps} operations: ${e.message}. The cache was rescanned; review the repo.`, tone: 'danger' };
  }
  // A restore plan also writes its manifest, re-adds .refs and removes empty folders; only the renames move
  // an item back (the plan succeeded, so every one of them ran)
  if (r.purpose === 'restore') {
    return { text: `Restored · ${plural(plan.ops.filter((o) => o.kind === 'restore-rename').length, 'item')} moved back`, tone: 'success' };
  }
  if (r.purpose === 'empty' || r.mode === 'permanent') {
    return {
      text: `Deleted · ${formatBytes(r.freedBytesPlanned)} freed · disk free changed by ${formatBytes(Math.max(0, r.diskFreeDelta))}`,
      tone: 'success',
    };
  }
  return {
    text: `Moved to Recently Deleted · 0 B freed now · ${formatBytes(r.heldBytes)} held · frees ${formatBytes(plan.freedBytes)} when emptied`,
    tone: 'success',
  };
}

/** A success goes to the session log only; a popup is for a failure or a restore that offers the Sync preview. */
export function showsPopup(r: ExecResultDTO): boolean {
  return !r.ok || (r.purpose === 'restore' && r.followUp === 'offer-sync');
}

export interface ResultToastProps { result: ExecResultDTO; plan: PlanDTO; onOpenSync?: () => void }

/** The body of the toast shown after a plan ran: the summary, the core's notes and any follow-up. */
export function ResultToast({ result, plan, onOpenSync }: ResultToastProps) {
  const s = resultSummary(result, plan);
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div
      data-testid="result-toast" data-freed-planned={result.freedBytesPlanned} data-held={result.heldBytes}
      className="max-h-[50vh] overflow-y-auto text-[13px]"
    >
      <p className={s.tone === 'danger' ? 'font-semibold text-danger' : 'font-semibold text-foreground'}>{s.text}</p>
      {s.details !== undefined && (
        <div className="mt-1">
          <Button variant="ghost" size="sm" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>Details</Button>
          {showDetails && <pre className="mt-1 text-[11px] break-all whitespace-pre-wrap text-muted-foreground">{s.details}</pre>}
        </div>
      )}
      {result.notes.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
          {result.notes.map((n, i) => <li key={i} data-testid="result-note">{n}</li>)}
        </ul>
      )}
      {result.ok && result.purpose === 'restore' && result.followUp === 'offer-sync' && onOpenSync !== undefined && (
        <Button className="mt-2" variant="primary" onClick={onOpenSync}>Open Sync preview</Button>
      )}
    </div>
  );
}
