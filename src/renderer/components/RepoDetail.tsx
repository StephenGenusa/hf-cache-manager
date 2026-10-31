import { useDeletionBlock } from '../lib/deletion-block';
import { useAdvice, useRepoDetail } from '../lib/queries';
import { AdviceBasis } from './AdviceBasis';
import { AdviceCell } from './AdviceCell';
import { Button } from './ui/button';
import { GroupsTable } from './GroupsTable';
import { NameParts } from './NameParts';

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface RepoDetailProps { repoId: string; onDeleteWholeRepo(repoId: string): void; onOpenSettings?(): void }

export function RepoDetail({ repoId, onDeleteWholeRepo, onOpenSettings }: RepoDetailProps) {
  const detail = useRepoDetail(repoId);
  const advice = useAdvice(repoId);
  const block = useDeletionBlock(repoId);
  const d = detail.data;

  if (detail.isError) return <p role="alert" className="text-danger">{detail.error.message}</p>;
  if (d === undefined) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div>
      <div data-testid="repo-detail-header" className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-foreground">{advice.data !== undefined ? <NameParts parts={advice.data.repoParts} /> : d.repoId}</h1>
          <p className="text-xs text-muted-foreground">
            {d.kindLabel}
            {' · '}
            {d.revisionShort !== null ? `revision main (${d.revisionShort})` : 'no revision'}
            {d.downloadedAtMs !== null && ` · downloaded ${isoDate(d.downloadedAtMs)}`}
          </p>
        </div>
        <Button data-testid="btn-delete-repo" variant="destructive" disabled={block.blocked} onClick={() => onDeleteWholeRepo(d.repoId)}>
          Delete entire repo…
        </Button>
      </div>
      {block.reason !== null && <p data-testid="selection-blocked" className="mb-3 text-xs text-warning">{block.reason}</p>}
      {advice.data !== undefined && <AdviceBasis basis={advice.data.basis} onChange={onOpenSettings} />}
      {advice.data?.repoLine != null && (
        <p data-testid="repo-advice-line" data-tint={advice.data.repoLine.tint ?? undefined} className="mb-3 text-xs">
          <AdviceCell advice={advice.data.repoLine} />
        </p>
      )}
      <GroupsTable repo={d} blocked={block.blocked} />
    </div>
  );
}
