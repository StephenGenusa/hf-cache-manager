import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Selection } from '../../core/types';
import type {
  ApiError, ApiResult, EmptyPlanDTO, ExecResultDTO, FileRowDTO, OpRowDTO, PlanDTO, PlanPairDTO, ViewLineDTO,
} from '../../shared/api';
import { useApi } from '../lib/api';
import { execErrorText } from '../lib/exec-copy';
import { formatAge, formatBytes } from '../lib/format';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { PathCell } from './PathCell';

/**
 * What is reviewed. A delete review renders from `pair.permanent`; the hold note and button use `pair.hold` (the parity
 * guard in main guarantees both touch the same files). An empty review is one plan per held deletion.
 */
export type ReviewSource =
  | { kind: 'delete'; selection: Selection; pair: PlanPairDTO }
  | { kind: 'restore'; plan: PlanDTO }
  | { kind: 'empty'; batch: EmptyPlanDTO };

export interface ReviewDialogProps {
  source: ReviewSource;
  onClose(): void;
  /**
   * A plan ran (successfully, or failed part-way): the caller shows the result toast and closes the dialog. The parent MUST
   * unmount the dialog after this call: the executor latch stays set (the plan is spent), so the dialog cannot run again.
   * A throw here is caught and shown in the dialog; it never leaves the dialog in a half-working state.
   */
  onDone(r: ExecResultDTO, plan: PlanDTO): void;
  /** STALE, EXPIRED, a used plan, ...: the caller plans again and shows a fresh review. Never a silent retry. */
  onReviewAgain(): void;
  /** Something was sent to the executor (main rescans after every execute): the caller refreshes its data. */
  onExecuted?(): void;
}

/** The residual race a restore cannot rule out. */
export const RESTORE_RACE_NOTE =
  'If a download recreates one of these files while restoring, the restored copy (same content) replaces it.';
const EXPIRED_COPY = execErrorText('EXPIRED', '');
const VIEW_LABEL = { lmstudio: 'LM Studio', ollama: 'Ollama' } as const;

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
const dedupe = (xs: string[]): string[] => [...new Set(xs)];
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** The "(2 blobs + 1 plain file)" note under Files removed. null for a restore (nothing is removed). */
function fileBreakdown(files: FileRowDTO[]): string | null {
  const counts = new Map<string, number>();
  for (const f of files) {
    const kind = f.blobShort !== null ? 'blob'
      : f.reason === 'plain-file' ? 'plain file'
        : f.reason === 'link-only' ? 'link'
          : f.reason === 'special-file' ? 'special file'
            : f.reason.startsWith('store-') ? 'shared store file'
              : f.reason === 'restore-move' || f.reason === 'restore-refs' ? null
                : 'file';
    if (kind !== null) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts.size === 0 ? null : `(${[...counts].map(([k, n]) => plural(n, k)).join(' + ')})`;
}

type Problem = { text: string; details?: string; locked: boolean };
type Running = 'hold' | 'permanent' | 'restore' | null;

function copyFor(e: ApiError): { text: string; reviewAgain: boolean; details?: string } {
  return execErrorText(e.code, e.message, {
    ...(e.detailPath !== undefined ? { detailPath: e.detailPath } : {}),
    ...(e.staleOwnLock !== undefined ? { staleOwnLock: e.staleOwnLock } : {}),
  });
}

/** An executor result that changed the disk (or tried to and rolled back) goes to the result toast. */
const executedFailure = (d: ExecResultDTO): boolean =>
  d.appliedOps > 0 || d.error?.code === 'IO' || d.error?.code === 'ROLLED_BACK';

/** Several empty plans that all succeeded, as one result for the toast. */
function aggregate(rs: ExecResultDTO[]): ExecResultDTO {
  const last = rs[rs.length - 1]!;
  return {
    ...last, ok: true, error: null, appliedOps: sum(rs.map((r) => r.appliedOps)), totalOps: sum(rs.map((r) => r.totalOps)),
    freedBytesPlanned: sum(rs.map((r) => r.freedBytesPlanned)), heldBytes: sum(rs.map((r) => r.heldBytes)),
    diskFreeDelta: sum(rs.map((r) => r.diskFreeDelta)), notes: rs.flatMap((r) => r.notes), followUp: null,
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-5 pb-3">
      <h4 className="mt-2.5 mb-1.5 text-[11px] font-medium tracking-[.06em] text-muted-foreground uppercase">{title}</h4>
      {children}
    </div>
  );
}

function Stat({ id, label, value, bytes, note }: { id: string; label: string; value: string; bytes?: number; note?: string | null }) {
  return (
    <div data-testid={id} data-bytes={bytes} className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5">
      <div className="text-[11px] tracking-[.05em] text-muted-foreground uppercase">{label}</div>
      <div className="text-xl font-semibold text-foreground tabular-nums">
        {value}
        {note !== undefined && note !== null && <small className="ml-1.5 text-xs font-normal text-muted-foreground">{note}</small>}
      </div>
    </div>
  );
}

function Amber({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div data-testid={id} className="mx-5 my-2 rounded-lg border border-[#5a4a1c] bg-[#2b2414] px-3 py-2 text-xs text-[#f0d38a]">
      {children}
    </div>
  );
}

const cell = 'border-b border-border/60 px-1.5 py-1 align-top';
const mono = 'font-mono text-[12px] break-all text-foreground/90';

function FileRows({ files, multiRepo }: { files: FileRowDTO[]; multiRepo: boolean }) {
  return (
    <table className="w-full border-collapse text-xs">
      <tbody>
        {files.map((f, i) => (
          <tr key={i} data-testid="file-row">
            <td className={cn(cell, mono)}>
              <PathCell label={multiRepo && f.repoId !== null ? `${f.repoId} · ${f.displayPath}` : f.displayPath} full={f.fullPath} />
            </td>
            <td className={cn(cell, 'text-muted-foreground')}>
              {f.blobShort !== null ? `blob ${f.blobShort} · ${f.reasonText}` : f.reasonText}
              {f.otherLinks > 0 && ` · +${f.otherLinks} more links`}
            </td>
            <td className={cn(cell, 'text-right whitespace-nowrap tabular-nums')}>{formatBytes(f.bytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const actionTone = (a: ViewLineDTO['action']): string =>
  a === 'remove' ? 'text-[#ff9aa5]' : a === 'blocked' || a === 'foreign' ? 'text-warning' : 'text-muted-foreground';

function ViewLines({ lines, unaffected }: { lines: ViewLineDTO[]; unaffected: PlanDTO['viewsUnaffected'] }) {
  return (
    <table className="w-full border-collapse text-xs">
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} data-testid="view-line">
            <td className={cn(cell, mono)}>
              <PathCell label={l.displayPath} full={l.fullPath} />
              {l.key !== null && <div className="font-sans text-[11px] text-muted-foreground">owned by {l.key}</div>}
            </td>
            <td className={cn(cell, actionTone(l.action))}>{l.actionText}</td>
            <td className={cn(cell, 'text-right text-muted-foreground')}>{l.entryKind ?? ''}</td>
          </tr>
        ))}
        {unaffected.map((v) => (
          <tr key={v} data-testid="view-line">
            <td className={cell}>{VIEW_LABEL[v]}</td>
            <td className={cn(cell, 'text-[#7fd39a]')}>no links to these files</td>
            <td className={cell} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OpRows({ ops }: { ops: OpRowDTO[] }) {
  return (
    <>
      {ops.map((o, i) => (
        <tr key={i} data-testid="op-row">
          <td className={cn(cell, 'whitespace-nowrap text-muted-foreground')}>{o.kind}</td>
          <td className={cn(cell, 'whitespace-nowrap text-muted-foreground')}>{o.role ?? ''}</td>
          <td className={cn(cell, mono)}><PathCell label={o.displayPath} full={o.fullPath} /></td>
        </tr>
      ))}
    </>
  );
}

/**
 * The review screen (mockup-review-dialog.html). It renders only from the plan DTOs and changes nothing on
 * disk until one of its action buttons is pressed. Delete Permanently is enabled only while the typed text is exactly
 * the plan's confirm phrase (no trimming, no case folding; the full repo id).
 */
export function ReviewDialog({ source, onClose, onDone, onReviewAgain, onExecuted }: ReviewDialogProps) {
  const api = useApi();
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState<Running>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [showOps, setShowOps] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // set synchronously on the first click, so a double click can never send a second execute
  const busy = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const plans: PlanDTO[] = source.kind === 'delete' ? [source.pair.permanent] : source.kind === 'restore' ? [source.plan] : source.batch.plans;
  const hold = source.kind === 'delete' ? source.pair.hold : null;
  const first = plans[0] ?? null;
  const executable = hold === null ? plans : [...plans, hold];
  const expired = executable.length > 0 && now >= Math.min(...executable.map((p) => p.expiresAt));
  const locked = problem?.locked === true || expired;
  const disabled = running !== null || locked;

  const phrases = dedupe(plans.flatMap((p) => (p.confirmPhrase === null ? [] : [p.confirmPhrase])));
  const phraseOk = phrases.every((p) => typed === p);
  const permanentReady = plans.length > 0 && phraseOk && !disabled;

  const warnings = source.kind === 'delete'
    ? dedupe([...source.pair.permanent.warnings, ...(hold?.warnings ?? [])])
    : source.kind === 'empty' ? dedupe([...source.batch.skipped, ...plans.flatMap((p) => p.warnings)]) : dedupe(source.plan.warnings);
  const files = plans.flatMap((p) => p.files);
  const freed = source.kind === 'empty' ? source.batch.freedBytes : first?.freedBytes ?? 0;
  const apparent = source.kind === 'empty' ? source.batch.apparentBytes : first?.apparentBytes ?? 0;
  const shared = source.kind === 'empty' ? source.batch.sharedBytes : first?.sharedBytes ?? 0;
  const multiRepo = (first?.repoIds.length ?? 0) > 1;
  const allOps = plans.flatMap((p) => p.ops);

  /**
   * Runs the plans in order and stops at the first that is not ok. There are no progress events; a very large
   * hold can take a while (one journal fsync per op, manifest rewrites), so the spinner simply stays until main answers.
   */
  async function execute(which: Exclude<Running, null>, list: Array<{ plan: PlanDTO; confirm: string | null }>): Promise<void> {
    if (busy.current || list.length === 0) return;
    busy.current = true;
    setRunning(which);
    setProblem(null);
    setShowDetails(false);
    const done: ExecResultDTO[] = [];
    const prefix = (): string => (list.length > 1 && done.length > 0
      ? `Emptied ${done.length} of ${list.length} deletions · ${formatBytes(sum(done.map((d) => d.freedBytesPlanned)))} freed. ` : '');
    // Once anything reached the executor the dialog never sends again (a second click after a fast first
    // execute, or a retry of a spent plan); only a refusal that left the plan usable re-arms it
    let rearm = false;
    // a throwing callback must not skip the cleanup below or leave the dialog looking usable while its latch is set
    const notify = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch (e) {
        console.error('ReviewDialog: a callback threw after the operation ran', e);
        setProblem({ text: 'The operation ran, but the app could not show its result. Rescan to see the current state.', locked: true });
        return false;
      }
    };
    try {
      for (const { plan, confirm } of list) {
        let r: ApiResult<ExecResultDTO>;
        try {
          r = await api.executePlan(plan.planId, plan.fingerprint, plan.mode, confirm);
        } catch (e) {
          r = { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } };
        }
        if (!r.ok) {
          // refused before the executor: the plan is still usable unless the copy says to review again
          if (done.length > 0) notify(() => onExecuted?.());
          const c = copyFor(r.error);
          const lock = c.reviewAgain || done.length > 0;
          rearm = !lock;
          setProblem({ text: prefix() + c.text, ...(c.details !== undefined ? { details: c.details } : {}), locked: lock });
          return;
        }
        // no refresh between plans: it would start a library scan, and main refuses the next plan while one runs (BUSY);
        // main already rescans after every plan, so the refresh happens once, when the batch stops or finishes
        const d = r.data;
        if (!d.ok) {
          if (executedFailure(d)) {
            const shown = done.length === 0 ? d : { ...d, notes: [`Emptied ${done.length} of ${list.length} deletions before this one.`, ...d.notes] };
            notify(() => onDone(shown, plan));
            return;
          }
          // the plan was taken and is spent: whatever the reason, only a fresh review can go on
          notify(() => onExecuted?.());
          const e = d.error ?? { code: 'INTERNAL' as const, message: 'The operation did not finish.' };
          const c = copyFor(e);
          setProblem({ text: prefix() + c.text, ...(c.details !== undefined ? { details: c.details } : {}), locked: true });
          return;
        }
        done.push(d);
      }
      notify(() => onExecuted?.());
      notify(() => onDone(done.length === 1 ? done[0]! : aggregate(done), list[0]!.plan));
    } finally {
      if (rearm) busy.current = false;
      setRunning(null);
    }
  }

  // every action button shows the spinner while any of them runs (all are disabled then)
  const spin = () => (running !== null ? <Loader2 data-testid="spinner" className="h-3.5 w-3.5 animate-spin" /> : null);

  const subtitleHead = source.kind === 'delete' ? plural(source.pair.permanent.groupCount, 'group')
    : source.kind === 'restore' ? plural(source.plan.files.length, 'item')
      : plural(plans.length, 'deletion');
  const subtitle = first === null ? `${subtitleHead} · Nothing to empty`
    : `${subtitleHead} · plan computed ${formatAge(now - first.createdAt)} · the cache is re-checked against this plan when you confirm`;
  const title = first?.title ?? 'Empty Recently Deleted';

  const shownProblem: Problem | null = problem ?? (expired ? { text: EXPIRED_COPY.text, locked: true } : null);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && running === null) onClose(); }}>
      <DialogContent
        data-testid="review-dialog"
        hideClose={running !== null}
        onEscapeKeyDown={(e) => { if (running !== null) e.preventDefault(); }}
        onInteractOutside={(e) => { if (running !== null) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {source.kind === 'restore' ? (
            <div className="grid grid-cols-3 gap-2.5 px-5 py-3.5">
              <Stat id="stat-files" label="Items moved back" value={String(files.filter((f) => f.reason === 'restore-move').length)} />
              <Stat id="stat-freed" label="Space freed" value="0 B" bytes={0} note="restoring frees nothing" />
              <Stat id="stat-apparent" label="Size restored" value={formatBytes(apparent)} bytes={apparent} />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2.5 px-5 py-3.5">
              <Stat id="stat-files" label="Files removed" value={String(sum(plans.map((p) => p.filesRemoved)))} note={fileBreakdown(files)} />
              <Stat id="stat-freed" label="Space actually freed" value={formatBytes(freed)} bytes={freed} />
              <Stat id="stat-apparent" label="Apparent size" value={formatBytes(apparent)} bytes={apparent}
                note={shared === 0 ? 'no shared bytes' : `${formatBytes(shared)} shared — not freed`} />
            </div>
          )}

          {source.kind === 'empty' ? (
            <Section title="Files">
              {plans.length === 0 && <p className="text-xs text-muted-foreground">Nothing to empty.</p>}
              {plans.map((p, i) => (
                <div key={p.planId} data-testid="empty-deletion" className="mb-2">
                  <div className="mb-1 text-xs text-muted-foreground">
                    {`Deletion ${i + 1} of ${plans.length}${p.repoIds.length > 0 ? ` — ${p.repoIds.join(', ')}` : ''} · ${formatBytes(p.freedBytes)} freed`}
                  </div>
                  <FileRows files={p.files} multiRepo={false} />
                </div>
              ))}
            </Section>
          ) : (
            <Section title={source.kind === 'restore' ? 'Files moved back' : 'Files'}>
              <FileRows files={files} multiRepo={multiRepo} />
            </Section>
          )}

          {plans.some((p) => p.viewLines.length > 0 || p.viewsUnaffected.length > 0) && (
            <Section title="LM Studio & Ollama links">
              <ViewLines lines={plans.flatMap((p) => p.viewLines)} unaffected={dedupe(plans.flatMap((p) => p.viewsUnaffected)) as PlanDTO['viewsUnaffected']} />
            </Section>
          )}

          {source.kind === 'delete' && (
            <Section title={multiRepo ? 'Kept in these repos' : 'Kept in this repo'}>
              <table className="w-full border-collapse text-xs">
                <tbody>
                  <tr data-testid="kept-row">
                    {source.pair.permanent.kept.length === 0 ? (
                      <td className={cn(cell, 'text-muted-foreground')} colSpan={3}>Nothing kept — the whole repo is removed</td>
                    ) : (
                      <>
                        <td className={cn(cell, mono)}>
                          {source.pair.permanent.kept.map((k) => (multiRepo ? `${k.repoId}: ${k.label}` : k.label)).join(' · ')}
                        </td>
                        <td className={cn(cell, 'text-[#7fd39a]')}>untouched</td>
                        <td className={cn(cell, 'text-right whitespace-nowrap tabular-nums')}>
                          {formatBytes(sum(source.pair.permanent.kept.map((k) => k.bytes)))}
                        </td>
                      </>
                    )}
                  </tr>
                </tbody>
              </table>
              {/* final review M5: the exact files that stay, each with its absolute path */}
              {source.pair.permanent.keptFiles.length > 0 && (
                <>
                  <div data-testid="kept-files-title" className="mt-2 text-[11px] font-medium text-muted-foreground">
                    {`Files kept (${source.pair.permanent.keptFiles.length})`}
                  </div>
                  <ul className="text-xs">
                    {source.pair.permanent.keptFiles.map((k) => (
                      <li key={k.fullPath} data-testid="kept-file" className={cn(cell, mono)}>
                        <PathCell label={multiRepo ? `${k.repoId} · ${k.displayPath}` : k.displayPath} full={k.fullPath} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Section>
          )}

          {warnings.map((w) => <Amber key={w} id="warning">⚠ {w}</Amber>)}
          {source.kind === 'restore' && <Amber id="restore-race-note">{RESTORE_RACE_NOTE}</Amber>}

          <div className="px-5 pb-3">
            <button
              type="button" data-testid="ops-toggle" aria-expanded={showOps} onClick={() => setShowOps((v) => !v)}
              className="mt-2 flex cursor-pointer items-center gap-1 text-[11px] font-medium tracking-[.06em] text-muted-foreground uppercase hover:text-foreground"
            >
              {showOps ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {`All operations (${allOps.length})`}
            </button>
            {showOps && (
              <table className="mt-1.5 w-full border-collapse text-xs">
                <tbody>
                  {source.kind === 'empty'
                    ? plans.map((p, i) => [
                      <tr key={`h${i}`}><td colSpan={3} className="pt-1.5 text-muted-foreground">{`Deletion ${i + 1} of ${plans.length}`}</td></tr>,
                      <OpRows key={`o${i}`} ops={p.ops} />,
                    ])
                    : <OpRows ops={allOps} />}
                </tbody>
              </table>
            )}
          </div>

          {source.kind === 'delete' && (hold !== null ? (
            <Amber id="hold-note">
              {`Files move to Recently Deleted (${hold.holdRootDisplay ?? 'Recently Deleted'}). ${formatBytes(hold.freedBytes)} freed when Recently Deleted is emptied.`}
            </Amber>
          ) : (
            <Amber id="hold-unavailable">{`Move to Recently Deleted is unavailable: ${source.pair.holdUnavailableReason ?? 'no reason given'}`}</Amber>
          ))}
        </div>

        {shownProblem !== null && (
          <div data-testid="stale-message" role="alert" className="mx-5 my-2 rounded-lg border border-[#8a2a38] bg-[#2a1418] px-3 py-2 text-xs text-[#ffd0d6]">
            <span>{shownProblem.text}</span>
            {shownProblem.details !== undefined && (
              <>
                <Button variant="ghost" size="sm" className="ml-2" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>Details</Button>
                {showDetails && <pre className="mt-1 text-[11px] break-all whitespace-pre-wrap">{shownProblem.details}</pre>}
              </>
            )}
            {shownProblem.locked && (
              <Button data-testid="btn-review-again" variant="tonal" className="ml-2" disabled={running !== null} onClick={onReviewAgain}>
                Review again
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button data-testid="btn-cancel" size="md" disabled={running !== null} onClick={onClose}>Cancel</Button>
          <span className="flex-1" />
          {source.kind === 'restore' ? (
            <Button
              data-testid="btn-restore-confirm" variant="primary" size="md" disabled={disabled}
              onClick={() => void execute('restore', [{ plan: source.plan, confirm: source.plan.confirmPhrase }])}
            >
              {spin()}Restore
            </Button>
          ) : (
            <>
              {source.kind === 'delete' && (
                <Button
                  data-testid="btn-hold" variant="tonal" size="md" disabled={hold === null || disabled}
                  title={hold === null ? source.pair.holdUnavailableReason ?? undefined : undefined}
                  onClick={() => { if (hold !== null) void execute('hold', [{ plan: hold, confirm: null }]); }}
                >
                  {spin()}Move to Recently Deleted
                </Button>
              )}
              {phrases.length > 0 && (
                <Input
                  data-testid="confirm-input" aria-label="Confirmation text" className="w-[240px] font-mono text-xs"
                  placeholder={`type ${phrases[0]!} to enable`} autoComplete="off" spellCheck={false} value={typed} disabled={disabled}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                />
              )}
              <Button
                data-testid="btn-permanent" variant="destructive" size="md" disabled={!permanentReady}
                onClick={() => void execute('permanent', plans.map((p) => ({ plan: p, confirm: p.confirmPhrase === null ? null : typed })))}
              >
                {spin()}Delete Permanently
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
