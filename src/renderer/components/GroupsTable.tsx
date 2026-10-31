import { AlertTriangle, ChevronDown, ChevronRight, Lock } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import type { GroupAdviceDTO, GroupDTO, RepoDetailDTO } from '../../shared/api';
import { useAdvice } from '../lib/queries';
import { formatBytes } from '../lib/format';
import { SHORTCUT_EVENT } from '../lib/use-shortcuts';
import type { ShortcutAction } from '../lib/shortcuts';
import { useSelection } from '../state/selection';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle,
} from './ui/alert-dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { AdviceCell } from './AdviceCell';
import { NameParts } from './NameParts';
import { Checkbox } from './ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

export const UNLOCK_WARNING =
  'Removing a component breaks the pipeline. Diffusers will fail to load this model until the component is downloaded again.';
const RECLAIMABLE_NOTE = 'Reclaimable is what deleting the group would actually free; files shared with other groups stay, so group sizes need not add up to the repo size.';

const usedByText = (g: GroupDTO): string => {
  const parts = [g.usedBy.lmstudio.length > 0 ? 'LM Studio' : null, g.usedBy.ollama.length > 0 ? 'Ollama' : null].filter((p) => p !== null);
  return parts.length === 0 ? '—' : parts.join(' · ');
};
const usedByTitle = (g: GroupDTO): string | undefined => {
  const names = [...g.usedBy.lmstudio.map((n) => `LM Studio: ${n}`), ...g.usedBy.ollama.map((n) => `Ollama: ${n}`)];
  return names.length === 0 ? undefined : names.join('\n');
};

const fileParts = (adv: GroupAdviceDTO | undefined, relpath: string): ReactNode => {
  const parts = adv?.files.find((x) => x.relpath === relpath)?.parts;
  return parts === undefined ? relpath : <NameParts parts={parts} />;
};

function Reclaimable({ g }: { g: GroupDTO }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-testid="group-reclaimable" tabIndex={0} className="cursor-help">
          {g.reclaimableBytes === null ? "can't tell" : formatBytes(g.reclaimableBytes)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="font-sans break-normal">
        Apparent size {formatBytes(g.apparentBytes)}. {RECLAIMABLE_NOTE}
      </TooltipContent>
    </Tooltip>
  );
}

export interface GroupsTableProps {
  repo: RepoDetailDTO;
  /** True when nothing may be selected for this repo (ambiguous id, unreadable cache, ...). */
  blocked: boolean;
}

export function GroupsTable({ repo, blocked }: GroupsTableProps) {
  const advice = useAdvice(repo.repoId).data;
  const sel = useSelection((s) => s.byRepo[repo.repoId]);
  const toggleGroup = useSelection((s) => s.toggleGroup);
  const setUnlock = useSelection((s) => s.setUnlock);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const unlocked = sel?.unlockComponents === true;
  const lockedKeys = repo.groups.filter((g) => g.locked).map((g) => g.key);

  // Up/Down inside the table move focus between the row checkboxes.
  useEffect(() => {
    const onShortcut = (e: Event) => {
      const a = (e as CustomEvent<ShortcutAction>).detail;
      if (a !== 'next-row' && a !== 'prev-row') return;
      const boxes = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[data-testid="group-checkbox"]:not(:disabled)') ?? []);
      if (boxes.length === 0) return;
      const i = boxes.findIndex((b) => b === document.activeElement);
      const next = a === 'next-row' ? Math.min(boxes.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
      boxes[next]?.focus();
    };
    window.addEventListener(SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(SHORTCUT_EVENT, onShortcut);
  }, []);

  const toggleExpand = (key: string) => setExpanded((cur) => {
    const next = new Set(cur);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  return (
    <TooltipProvider>
      <div ref={wrap} data-shortcut-context="groups">
        {repo.hasLockedGroups && (
          <div className="mb-2 flex items-center gap-2">
            <Button
              data-testid="unlock-toggle" disabled={blocked}
              onClick={() => (unlocked ? setUnlock(repo.repoId, false, lockedKeys) : setConfirmOpen(true))}
            >
              {unlocked ? 'Lock components again' : 'Unlock component deletion'}
            </Button>
            <span className="text-xs text-muted-foreground">Pipeline components are locked because removing one breaks the model.</span>
          </div>
        )}
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogTitle>Unlock component deletion?</AlertDialogTitle>
            <AlertDialogDescription>{UNLOCK_WARNING}</AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => setUnlock(repo.repoId, true, lockedKeys)}>Unlock</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Table>
          <TableHeader>
            <tr>
              <TableHead className="w-8"><span className="sr-only">Delete</span></TableHead>
              <TableHead>Quant</TableHead>
              <TableHead>Advice</TableHead>
              <TableHead>Files</TableHead>
              <TableHead>Used by</TableHead>
              <TableHead className="text-right">Reclaimable</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {repo.groups.map((g) => {
              const checked = sel?.groupKeys.includes(g.key) === true;
              const open = expanded.has(g.key);
              const showLock = g.locked && !unlocked;
              const adv = advice?.groups.find((a) => a.key === g.key);
              const partial = g.shards !== null && g.shards.present < g.shards.expected;
              return (
                <Fragment key={g.key}>
                  <TableRow data-testid="group-row" data-group-key={g.key} data-checked={checked} data-tint={adv?.tint ?? undefined}>
                    <TableCell>
                      {showLock ? (
                        <Lock aria-label="Locked component" role="img" className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <Checkbox
                          data-testid="group-checkbox" aria-label={`Select ${g.label}`} checked={checked} disabled={blocked}
                          onCheckedChange={() => toggleGroup(repo.repoId, g.key, g.locked)}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button" data-testid="group-expand" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} files of ${g.label}`}
                          onClick={() => toggleExpand(g.key)} className="cursor-pointer text-muted-foreground hover:text-foreground"
                        >
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                        <span>{adv !== undefined ? <NameParts parts={adv.labelParts} /> : g.label}</span>
                        {partial && g.shards !== null && <Badge tone="warning">{`partial (${g.shards.present}/${g.shards.expected})`}</Badge>}
                        {g.kind === 'mmproj' && <Badge>vision</Badge>}
                      </div>
                      {g.warning !== null && (
                        <p data-testid="group-warning" className="mt-1 flex items-start gap-1 text-xs text-warning">
                          <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
                          <span>{g.warning}</span>
                        </p>
                      )}
                    </TableCell>
                    <TableCell><AdviceCell advice={adv} /></TableCell>
                    <TableCell className="text-muted-foreground">
                      {g.shards !== null ? `${g.shards.present} ${g.shards.present === 1 ? 'shard' : 'shards'}` : `${g.fileCount} ${g.fileCount === 1 ? 'file' : 'files'}`}
                    </TableCell>
                    <TableCell className="text-muted-foreground" title={usedByTitle(g)}>{usedByText(g)}</TableCell>
                    <TableCell className="text-right tabular-nums"><Reclaimable g={g} /></TableCell>
                  </TableRow>
                  {open && (
                    <tr data-testid="group-files">
                      <td />
                      <td colSpan={5} className="border-b border-border/70 pb-2">
                        <ul className="space-y-0.5 text-xs">
                          {g.files.map((f) => (
                            <li key={`${f.commitShort}:${f.relpath}`} className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate font-mono text-foreground">{fileParts(adv, f.relpath)}</span>
                              <span className="font-mono text-muted-foreground">{f.commitShort}</span>
                              {!f.current && <Badge tone="warning">older revision</Badge>}
                              <span className="w-20 text-right tabular-nums text-muted-foreground">{formatBytes(f.bytes)}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </TooltipProvider>
  );
}
