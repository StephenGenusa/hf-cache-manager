import { useDeletionBlock } from '../lib/deletion-block';
import { Loader2 } from 'lucide-react';
import { useAdvice, useRepoDetail } from '../lib/queries';
import { useRepoUpdate, type RepoUpdateState } from '../lib/use-update-check';
import { useSelection } from '../state/selection';
import { AdviceBasis } from './AdviceBasis';
import { AdviceCell } from './AdviceCell';
import { Button } from './ui/button';
import { GroupsTable } from './GroupsTable';
import { NameParts } from './NameParts';
import { hubInputFor, RepoMenu, useOpenRepoPage } from './RepoMenu';

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface RepoDetailProps {
  repoId: string;
  onDeleteWholeRepo(repoId: string): void;
  onOpenSettings?(): void;
  /** Right-click → "Open in Download tab": called with the text to look up on the Hub. */
  onOpenInDownload?(hubInput: string): void;
}

/** What a check of this one repo found (shown only for a repo that had the update badge when it was opened). */
function RepoUpdates({ u, onOpen }: { u: RepoUpdateState; onOpen?: (() => void) | undefined }) {
  const d = u.data;
  const n = d?.files.length ?? 0;
  return (
    <div data-testid="repo-updates" className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      {u.checking ? (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />Checking the Hub for changes…</span>
      ) : u.error !== null ? <span className="text-warning">{`Could not check for changes: ${u.error}`}</span>
        : d === undefined ? null
          : d.status === 'update' ? (
            <>
              <span className="text-warning">{`${n} ${n === 1 ? 'file has' : 'files have'} a newer version on the Hub${d.commit === null ? '' : ` (${d.commit.slice(0, 7)})`}`}</span>
              {onOpen !== undefined && <Button size="sm" onClick={onOpen}>Open in Download tab</Button>}
              {d.message !== null && <span className="text-muted-foreground">{`Could not check again just now: ${d.message}`}</span>}
            </>
          ) : d.status === 'current' ? <span className="text-muted-foreground">Up to date with the Hub</span>
            : <span className="text-warning">{d.message ?? 'Could not check for changes'}</span>}
    </div>
  );
}

export function RepoDetail({ repoId, onDeleteWholeRepo, onOpenSettings, onOpenInDownload }: RepoDetailProps) {
  const openPage = useOpenRepoPage();
  const selectAll = useSelection((s) => s.selectAll);
  const detail = useRepoDetail(repoId);
  const advice = useAdvice(repoId);
  const block = useDeletionBlock(repoId);
  const d = detail.data;
  const update = useRepoUpdate(repoId, d?.type);

  if (detail.isError) return <p role="alert" className="text-danger">{detail.error.message}</p>;
  if (d === undefined) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div>
      <div data-testid="repo-detail-header" className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex text-base font-semibold text-foreground">
            <RepoMenu repoId={d.repoId} type={d.type} onOpenInDownload={onOpenInDownload}>
              <button
                type="button" data-testid="repo-title" aria-label={`Open ${d.repoId} on Hugging Face`} onClick={() => openPage(d.repoId, d.type)}
                className="min-w-0 cursor-pointer truncate text-left hover:underline"
              >
                {advice.data !== undefined ? <NameParts parts={advice.data.repoParts} /> : d.repoId}
              </button>
            </RepoMenu>
          </h1>
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
        <Button data-testid="btn-select-all" disabled={block.blocked} onClick={() => selectAll(d.repoId, d.groups.map((g) => ({ key: g.key, locked: g.locked })))}>
          Select All
        </Button>
      </div>
      {block.reason !== null && <p data-testid="selection-blocked" className="mb-3 text-xs text-warning">{block.reason}</p>}
      {advice.data !== undefined && <AdviceBasis basis={advice.data.basis} onChange={onOpenSettings} />}
      {advice.data?.repoLine != null && (
        <p data-testid="repo-advice-line" data-tint={advice.data.repoLine.tint ?? undefined} className="mb-3 text-xs">
          <AdviceCell advice={advice.data.repoLine} />
        </p>
      )}
      {update.wanted && (
        <RepoUpdates u={update} onOpen={onOpenInDownload === undefined ? undefined : () => onOpenInDownload(hubInputFor(d.type, d.repoId))} />
      )}
      <GroupsTable repo={d} blocked={block.blocked} {...(update.outdated === undefined || update.checking ? {} : { outdated: update.outdated })} />
    </div>
  );
}
