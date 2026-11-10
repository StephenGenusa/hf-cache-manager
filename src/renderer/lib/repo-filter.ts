import type { RepoSummaryDTO } from '../../shared/api';
import type { RepoKind } from '../../core/types';

export type SortKey = 'size' | 'name' | 'modified' | 'kind';
export interface FilterOptions {
  query: string; sort: SortKey; kinds: RepoKind[]; lmstudio: boolean; ollama: boolean; partial: boolean;
}

/** The order of the `RepoKind` union, used by the "kind" sort. */
export const KIND_ORDER: readonly RepoKind[] = [
  'gguf', 'diffusers', 'transformers', 'adapter', 'single-file', 'diffusion', 'component', 'dataset', 'space', 'unknown',
];

const kindRank = (r: RepoSummaryDTO): number => {
  const k = r.kinds[0];
  const i = k === undefined ? -1 : KIND_ORDER.indexOf(k);
  return i === -1 ? KIND_ORDER.length : i;
};

/** Filters (all conditions AND) then sorts a copy. Ties always break by repo id so the order is stable. */
export function filterSortRepos(repos: RepoSummaryDTO[], o: FilterOptions): RepoSummaryDTO[] {
  const q = o.query.trim().toLowerCase();
  const kept = repos.filter((r) =>
    (q === '' || r.repoId.toLowerCase().includes(q))
    && (o.kinds.length === 0 || r.kinds.some((k) => o.kinds.includes(k)))
    && (!o.lmstudio || r.usage.lmstudio > 0)
    && (!o.ollama || r.usage.ollama > 0)
    && (!o.partial || r.partialDownloads > 0));
  const byId = (a: RepoSummaryDTO, b: RepoSummaryDTO) => a.repoId.toLowerCase().localeCompare(b.repoId.toLowerCase());
  const cmp: Record<SortKey, (a: RepoSummaryDTO, b: RepoSummaryDTO) => number> = {
    size: (a, b) => b.apparentBytes - a.apparentBytes,
    name: byId,
    modified: (a, b) => b.lastModifiedMs - a.lastModifiedMs,
    kind: (a, b) => kindRank(a) - kindRank(b) || b.apparentBytes - a.apparentBytes,
  };
  return kept.sort((a, b) => cmp[o.sort](a, b) || byId(a, b));
}
