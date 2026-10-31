import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { DownloadGroupDTO, GroupAdviceDTO, HubLookupDTO, RepoAdviceDTO } from '../../shared/api';
import { useApi } from '../lib/api';
import { formatBytes } from '../lib/format';
import { queryKeys, useRecentLookups } from '../lib/queries';
import { useDownloadSelection } from '../state/download-selection';
import { useDownloads, withQueue, type ShownGroup } from '../state/downloads';
import { AdviceBasis } from './AdviceBasis';
import { AdviceCell } from './AdviceCell';
import { DownloadFooter } from './DownloadFooter';
import { HubInput } from './HubInput';
import { NameParts } from './NameParts';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

export const NO_BEST_PICK = 'No best pick for this PC';
export const SHAPES_UNREAD = 'Model shapes could not be read; size advice is unavailable';
const SHAPE_PENDING = 'Reading model shape…';

/** "12.3 / 19.6 GB": the unit is written once when both sides share it. */
const ofTotal = (have: number, size: number): string => {
  const h = formatBytes(have);
  const t = formatBytes(size);
  const unit = (x: string) => x.slice(x.lastIndexOf(' ') + 1);
  return unit(h) === unit(t) ? `${h.slice(0, h.lastIndexOf(' '))} / ${t}` : `${h} / ${t}`;
};

/** One badge for a group's state: queued beats update beats partial beats cached; absent gets none. */
function cacheBadge(g: ShownGroup): { text: string; tone: 'success' | 'warning' | 'neutral' } | null {
  if (g.files.some((f) => f.state === 'queued')) return { text: 'queued', tone: 'neutral' };
  if (g.files.some((f) => f.state === 'update')) return { text: 'update', tone: 'warning' };
  const partial = g.files.filter((f) => f.state === 'partial');
  if (partial.length > 0) {
    const have = g.files.reduce((n, f) => n + (f.state === 'absent' ? 0 : f.have), 0);
    return { text: `partial ${ofTotal(have, g.files.reduce((n, f) => n + f.size, 0))}`, tone: 'warning' };
  }
  if (g.files.length > 0 && g.files.every((f) => f.state === 'cached')) return { text: 'cached', tone: 'success' };
  return null;
}

/** A ticked row is a file to download: the accent blue, not the red the library uses for a deletion. */
const TICKED_ROW = 'data-[checked=true]:bg-accent';
const TICKED_BOX = 'data-[state=checked]:border-primary data-[state=checked]:bg-primary';

/** Size advice for these kinds waits for the GGUF header. */
const needsShape = (g: Pick<DownloadGroupDTO, 'kind'>): boolean => g.kind === 'quant' || g.kind === 'mmproj';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function DownloadMode() {
  const api = useApi();
  const client = useQueryClient();
  const recent = useRecentLookups().data ?? [];
  const keys = useDownloadSelection((s) => s.keys);
  const toggle = useDownloadSelection((s) => s.toggle);
  const setKeys = useDownloadSelection((s) => s.set);
  const clearKeys = useDownloadSelection((s) => s.clear);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<HubLookupDTO | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [advice, setAdvice] = useState<RepoAdviceDTO | null>(null);
  const [pending, setPending] = useState(false);
  const [gatedNote, setGatedNote] = useState<string | null>(null);
  const [adviceNote, setAdviceNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const lastInput = useRef('');
  const token = useRef(0);

  useEffect(() => () => { token.current += 1; }, []);

  // A finished download of the looked-up repo: main has rescanned, so its groups are read again (cached, Requires).
  const shownId = lookup?.lookupId ?? null;
  const shownRepo = lookup?.repoId ?? null;
  const shownType = lookup?.type ?? null;
  useEffect(() => {
    if (shownId === null) return undefined;
    return api.onDownloadDone((d) => {
      if (d.repoId !== shownRepo || d.type !== shownType) return;
      void api.lookupGroups(shownId).then((r) => {
        if (r.ok) setLookup((cur) => (cur?.lookupId === shownId ? { ...cur, groups: r.data } : cur));
      }, () => undefined);   // IPC gone: the look-up keeps what it showed
    });
  }, [api, shownId, shownRepo, shownType]);

  const doLookup = async (text: string): Promise<void> => {
    const mine = ++token.current;
    lastInput.current = text;
    setBusy(true);
    setLookupError(null);
    clearKeys();
    try {
      const r = await api.hubLookup(text);
      if (mine !== token.current) return;
      void client.invalidateQueries({ queryKey: queryKeys.recentLookups });
      if (!r.ok) {
        setLookup(null); setAdvice(null); setPending(false); setGatedNote(null); setAdviceNote(null);
        setLookupError(r.error.message);
        return;
      }
      const l = r.data;
      setLookup(l);
      setAdvice(l.advice);
      setPending(l.shapesPending);
      setGatedNote(null);
      setAdviceNote(null);
      clearKeys();
      setExpanded(new Set());
      if (!l.shapesPending) return;
      void api.downloadAdvice(l.lookupId).then((a) => {
        if (mine !== token.current) return;
        if (a.ok) setAdvice(a.data);
        else if (a.error.code === 'GATED') setGatedNote(a.error.message);
        else setAdviceNote(SHAPES_UNREAD);
        setPending(false);
      }, () => { if (mine === token.current) { setAdviceNote(SHAPES_UNREAD); setPending(false); } });
    } catch (e) {
      if (mine === token.current) setLookupError(errorMessage(e));
    } finally {
      if (mine === token.current) setBusy(false);
    }
  };

  const adviceOf = (key: string): GroupAdviceDTO | undefined => advice?.groups.find((a) => a.key === key);
  const items = useDownloads((s) => s.items);
  const live = useDownloads((s) => s.live);
  const groups = useMemo(() => (lookup === null ? [] : withQueue(lookup, items, live)), [lookup, items, live]);
  const bestPick = groups.filter((g) => g.tickable && adviceOf(g.key)?.tint === 'green').map((g) => g.key);
  const wholeRepo = groups.filter((g) => g.tickable).map((g) => g.key);
  const toggleExpand = (key: string): void => setExpanded((cur) => {
    const next = new Set(cur);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <aside data-testid="left-pane" className="flex w-[270px] shrink-0 flex-col border-r border-border">
          <HubInput value={input} onChange={setInput} onLookup={(t) => void doLookup(t)} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {lookup !== null && (
              <div data-testid="lookup-repo" className="border-b border-border/60 bg-accent px-3 py-2">
                <div className="truncate text-[13px] text-foreground">{lookup.repoId}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <Badge tone="gguf">{lookup.badge}</Badge>
                  {lookup.gated && <Badge tone="warning">gated</Badge>}
                  {lookup.private && <Badge tone="warning">private</Badge>}
                </div>
                {lookup.lastModified !== null && (
                  <div data-testid="lookup-date" className="mt-0.5 text-[11px] text-muted-foreground">Updated {lookup.lastModified.slice(0, 10)}</div>
                )}
              </div>
            )}
            <h3 className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Recent look-ups</h3>
            {recent.length === 0 && <p className="px-3 text-xs text-muted-foreground">Nothing looked up yet.</p>}
            {recent.map((r) => (
              <button
                key={`${r.at}:${r.input}`} type="button" data-testid="recent-lookup"
                onClick={() => { setInput(r.input); void doLookup(r.input); }}
                className="block w-full cursor-pointer truncate border-b border-border/60 px-3 py-2 text-left text-[13px] text-foreground hover:bg-accent/50"
              >
                {r.repoId}{r.revision !== 'main' && <span className="text-muted-foreground">{` @${r.revision}`}</span>}
              </button>
            ))}
          </div>
        </aside>
        <main data-testid="right-pane" className="min-w-0 flex-1 overflow-auto px-4 py-3.5">
          {lookupError !== null && <p role="alert" data-testid="lookup-error" className="text-sm text-danger">{lookupError}</p>}
          {lookup === null && lookupError === null && (
            <div data-testid="detail-slot" className="text-muted-foreground">Look up a Hugging Face repo to see what you can download.</div>
          )}
          {lookup !== null && (
            <TooltipProvider>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">{advice !== null && advice.repoParts.length > 0 ? <NameParts parts={advice.repoParts} /> : lookup.repoId}</h2>
                <span className="font-mono text-xs text-muted-foreground">{`${lookup.revision} · ${lookup.commit.slice(0, 7)}`}</span>
                <span className="ml-auto flex items-center gap-2">
                  <Button disabled={wholeRepo.length === 0 || busy} onClick={() => setKeys(wholeRepo)}>Select whole repo</Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span data-testid="best-pick-wrap" tabIndex={bestPick.length === 0 ? 0 : undefined}>
                        <Button disabled={bestPick.length === 0 || busy} onClick={() => setKeys(bestPick)}>Select the best pick</Button>
                      </span>
                    </TooltipTrigger>
                    {bestPick.length === 0 && <TooltipContent>{pending ? 'Waiting for model shapes…' : NO_BEST_PICK}</TooltipContent>}
                  </Tooltip>
                </span>
              </div>
              {gatedNote !== null && <p role="alert" data-testid="gated-note" className="mb-2 text-sm text-warning">{gatedNote}</p>}
              {!lookup.downloadable && lookup.notDownloadableReason !== null && (
                <p data-testid="not-downloadable" className="mb-2 text-sm text-warning">{lookup.notDownloadableReason}</p>
              )}
              {adviceNote !== null && <p data-testid="advice-note" className="mb-2 text-xs text-muted-foreground">{adviceNote}</p>}
              {advice !== null && <AdviceBasis basis={advice.basis} />}
              <Table>
                <TableHeader>
                  <tr>
                    <TableHead className="w-8"><span className="sr-only">Download</span></TableHead>
                    <TableHead>Quant</TableHead>
                    <TableHead>Advice</TableHead>
                    <TableHead>Files</TableHead>
                    <TableHead className="text-right">Requires</TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {groups.map((g) => {
                    const adv = adviceOf(g.key);
                    const checked = keys.includes(g.key);
                    const badge = cacheBadge(g);
                    const open = expanded.has(g.key);
                    return (
                      <Fragment key={g.key}>
                        <TableRow data-testid="dl-row" data-group-key={g.key} data-checked={checked} data-tint={adv?.tint ?? undefined} className={TICKED_ROW}>
                          <TableCell>
                            <Checkbox
                              data-testid="dl-checkbox" aria-label={`Download ${g.label}`} checked={checked} disabled={!g.tickable || busy} className={TICKED_BOX}
                              onCheckedChange={() => toggle(g.key)}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} files of ${g.label}`}
                                onClick={() => toggleExpand(g.key)} className="cursor-pointer text-muted-foreground hover:text-foreground"
                              >
                                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                              </button>
                              <span>{adv !== undefined ? <NameParts parts={adv.labelParts} /> : g.label}</span>
                              {badge !== null && <Badge tone={badge.tone}>{badge.text}</Badge>}
                              {g.kind === 'mmproj' && <Badge>vision</Badge>}
                            </div>
                            {!g.selectable && g.reason !== null && <p data-testid="dl-reason" className="mt-1 text-xs text-warning">{g.reason}</p>}
                          </TableCell>
                          <TableCell>
                            {pending && needsShape(g) && (adv === undefined || adv.reason === '')
                              ? <span className="text-xs text-muted-foreground">{SHAPE_PENDING}</span>
                              : <AdviceCell advice={adv} />}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{`${g.files.length} ${g.files.length === 1 ? 'file' : 'files'}`}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatBytes(g.requiresBytes)}</TableCell>
                        </TableRow>
                        {open && (
                          <tr data-testid="dl-files">
                            <td />
                            <td colSpan={4} className="border-b border-border/70 pb-2">
                              <ul className="space-y-0.5 text-xs">
                                {g.files.map((f) => {
                                  const parts = adv?.files.find((x) => x.relpath === f.path)?.parts;
                                  return (
                                    <li key={f.path} className="flex items-center gap-2">
                                      <span className="min-w-0 flex-1 truncate font-mono text-foreground">{parts === undefined ? f.path : <NameParts parts={parts} />}</span>
                                      {f.state !== 'absent' && <Badge>{f.state}</Badge>}
                                      <span className="w-20 text-right tabular-nums text-muted-foreground">{formatBytes(f.size)}</span>
                                    </li>
                                  );
                                })}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </TooltipProvider>
          )}
        </main>
      </div>
      <DownloadFooter lookup={lookup} gatedNote={gatedNote} advicePending={pending} lookingUp={busy} onLookupAgain={() => void doLookup(lastInput.current)} />
    </>
  );
}
