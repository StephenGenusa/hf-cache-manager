import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepoKind } from '../../core/types';
import type { RepoSummaryDTO } from '../../shared/api';
import { hubMissingText, scanErrorText } from '../lib/deletion-block';
import { formatBytes } from '../lib/format';
import { useLibrary } from '../lib/queries';
import { filterSortRepos, KIND_ORDER, type SortKey } from '../lib/repo-filter';
import { SEARCH_TEST_ID, SHORTCUT_EVENT } from '../lib/use-shortcuts';
import type { ShortcutAction } from '../lib/shortcuts';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export const ROW_HEIGHT = 52;
const OVERSCAN = 8;
/** jsdom / initial-layout fallback: used only while the scroller's measured height is 0 (jsdom never has layout), so the first paint is not empty. */
const FALLBACK_RECT = { width: 270, height: 600 };
const KIND_LABEL: Record<RepoKind, string> = {
  gguf: 'GGUF', diffusers: 'Diffusers', transformers: 'Transformers', adapter: 'Adapter', 'single-file': 'Single file', diffusion: 'Diffusion',
  component: 'Component', dataset: 'Dataset', space: 'Space', unknown: 'Unknown',
};
const SORT_LABEL: Record<SortKey, string> = { size: 'Size', name: 'Name', modified: 'Last modified', kind: 'Kind' };

const badgeTone = (r: RepoSummaryDTO) => (r.kinds[0] === 'gguf' ? 'gguf' : r.kinds[0] === 'diffusers' || r.kinds[0] === 'diffusion' ? 'diffusers' : r.kinds[0] === 'transformers' ? 'safetensors' : 'neutral');
const repos0Type = (repos: RepoSummaryDTO[], id: string | null): string | null => repos.find((r) => r.repoId === id)?.type ?? null;
const rowKey = (r: RepoSummaryDTO) => `${r.type}:${r.repoId}`;

export interface RepoListProps {
  activeRepoId: string | null;
  onActivate(repoId: string): void;
  /** Opens the Recently Deleted view. */
  onOpenHeld?(): void;
  heldActive?: boolean;
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: string }) {
  return (
    <button
      type="button" aria-pressed={on} onClick={onClick}
      className={cn('cursor-pointer rounded-full border px-2 py-px text-[11px]', on ? 'border-primary bg-primary/25 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}
    >
      {children}
    </button>
  );
}

export function RepoList({ activeRepoId, onActivate, onOpenHeld, heldActive = false }: RepoListProps) {
  const library = useLibrary();
  const lib = library.data;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('size');
  const [kinds, setKinds] = useState<RepoKind[]>([]);
  const [lmstudio, setLm] = useState(false);
  const [ollama, setOllama] = useState(false);
  const [partial, setPartial] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Two repos can share an id: remember which row was clicked so only that one highlights.
  const [clicked, setClicked] = useState<{ type: string; repoId: string } | null>(null);
  const activeType = clicked !== null && clicked.repoId === activeRepoId
    ? clicked.type : repos0Type(lib?.repos ?? [], activeRepoId);
  const isActive = (r: RepoSummaryDTO) => !heldActive && r.repoId === activeRepoId && r.type === activeType;

  const repos = useMemo(
    () => filterSortRepos(lib?.repos ?? [], { query, sort, kinds, lmstudio, ollama, partial }),
    [lib, query, sort, kinds, lmstudio, ollama, partial],
  );
  const presentKinds = useMemo(() => {
    const seen = new Set<RepoKind>((lib?.repos ?? []).flatMap((r) => r.kinds));
    return KIND_ORDER.filter((k) => seen.has(k));
  }, [lib]);

  const virtualizer = useVirtualizer({
    count: repos.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: OVERSCAN,
    initialRect: FALLBACK_RECT,
    observeElementRect: (inst, cb) => observeElementRect(inst, (r) => cb(r.height === 0 ? FALLBACK_RECT : r)), getItemKey: (i) => (repos[i] ? rowKey(repos[i]) : i),
  });

  // Up/Down move the active repo through the filtered list (the window shortcut handler dispatches the event).
  const stepRef = useRef<(d: 1 | -1) => void>(() => undefined);
  stepRef.current = (d) => {
    if (repos.length === 0) return;
    const cur = repos.findIndex((r) => r.repoId === activeRepoId);
    const next = Math.min(repos.length - 1, Math.max(0, cur === -1 ? 0 : cur + d));
    const target = repos[next];
    if (target === undefined) return;
    virtualizer.scrollToIndex(next);
    onActivate(target.repoId);
  };
  useEffect(() => {
    const onShortcut = (e: Event) => {
      const a = (e as CustomEvent<ShortcutAction>).detail;
      if (a === 'next-repo') stepRef.current(1);
      else if (a === 'prev-repo') stepRef.current(-1);
    };
    window.addEventListener(SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(SHORTCUT_EVENT, onShortcut);
  }, []);

  const toggleKind = (k: RepoKind) => setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const problem = lib === undefined ? null : !lib.hubPresent ? 'missing' : lib.scanError !== null ? 'unreadable' : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative m-2.5 mb-1.5">
        <Search className="pointer-events-none absolute top-2 left-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          data-testid={SEARCH_TEST_ID} className="pl-8" aria-label="Search repos" value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={lib === undefined ? 'Search repos…' : `Search ${lib.repos.length} repos…`}
        />
      </div>
      <div className="mx-2.5 mb-1.5 flex items-center gap-1.5">
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger aria-label="Sort" className="h-6 flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => <SelectItem key={k} value={k}>{SORT_LABEL[k]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="mx-2.5 mb-2 flex flex-wrap gap-1">
        {presentKinds.map((k) => <Chip key={k} on={kinds.includes(k)} onClick={() => toggleKind(k)}>{KIND_LABEL[k]}</Chip>)}
        <Chip on={lmstudio} onClick={() => setLm((v) => !v)}>LM Studio</Chip>
        <Chip on={ollama} onClick={() => setOllama((v) => !v)}>Ollama</Chip>
        <Chip on={partial} onClick={() => setPartial((v) => !v)}>Partial downloads</Chip>
      </div>

      {problem !== null && lib !== undefined ? (
        <div role={problem === 'unreadable' ? 'alert' : undefined} data-testid="hub-problem" className="mx-2.5 flex-1 space-y-1 text-[13px] text-warning">
          {problem === 'missing' ? (
            <>
              <p>{hubMissingText(lib.hubRoot)}</p>
              {lib.scanError !== null && <p className="text-xs text-muted-foreground">{lib.scanError}</p>}
            </>
          ) : (
            <p>{scanErrorText(lib.scanError ?? '')}</p>
          )}
        </div>
      ) : (
        <div ref={scrollRef} data-testid="repo-scroll" className="min-h-0 flex-1 overflow-y-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const r = repos[v.index];
              if (r === undefined) return null;
              return (
                <button
                  key={v.key} type="button" data-testid="repo-row" data-repo-id={r.repoId} data-index={v.index}
                  aria-current={isActive(r) ? 'true' : undefined}
                  onClick={() => { setClicked({ type: r.type, repoId: r.repoId }); onActivate(r.repoId); }}
                  className={cn(
                    'absolute top-0 left-0 flex w-full cursor-pointer flex-col justify-center gap-0.5 border-b border-border/60 px-3 text-left hover:bg-accent/50',
                    isActive(r) && 'bg-accent',
                  )}
                  style={{ height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}
                >
                  <span className="truncate text-[13px] text-foreground">{r.repoId}</span>
                  <span className="flex items-center gap-1 overflow-hidden">
                    <Badge tone={badgeTone(r)}>{r.badge}</Badge>
                    {r.usage.lmstudio > 0 && <Badge>LM Studio</Badge>}
                    {r.usage.ollama > 0 && <Badge>Ollama</Badge>}
                    {r.partialDownloads > 0 && <Badge tone="warning">partial</Badge>}
                    {r.ambiguous && <Badge tone="danger" title="Another repo of a different type has this id">shared id</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">{formatBytes(r.apparentBytes)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <button
        type="button" data-testid="nav-recently-deleted" onClick={onOpenHeld} aria-current={heldActive ? 'true' : undefined}
        className={cn('cursor-pointer border-t border-border px-3 py-2.5 text-left text-[13px] text-muted-foreground hover:bg-accent/50', heldActive && 'bg-accent text-foreground')}
      >
        Recently Deleted ({formatBytes(lib?.heldBytes ?? 0)})
      </button>
    </div>
  );
}
