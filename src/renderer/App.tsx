import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Selection } from '../core/types';
import type { ApiError, ApiResult, EmptyTarget, ExecResultDTO, PlanDTO } from '../shared/api';
import { ActionBar } from './components/ActionBar';
import { RepoDetail } from './components/RepoDetail';
import { RepoList } from './components/RepoList';
import { RecentlyDeletedView } from './components/RecentlyDeletedView';
import { ResultToast, resultSummary, showsPopup } from './components/ResultToast';
import { Button } from './components/ui/button';
import { ReviewDialog, type ReviewSource } from './components/ReviewDialog';
import { SettingsView } from './components/SettingsView';
import { StartupNotice } from './components/StartupNotice';
import { SyncDialog } from './components/SyncDialog';
import { DownloadsDrawer } from './components/DownloadsDrawer';
import { DownloadMode } from './components/DownloadMode';
import { TopBar, type AppMode } from './components/TopBar';
import { useDownloadSelection } from './state/download-selection';
import { toast } from './components/ui/toast';
import { useApi } from './lib/api';
import { execErrorText } from './lib/exec-copy';
import { formatBytes } from './lib/format';
import { queryKeys, useLibrary } from './lib/queries';
import { useDownloadsFeed } from './lib/use-downloads-feed';
import { useShortcuts } from './lib/use-shortcuts';
import { useSelection } from './state/selection';
import { useSessionLog } from './state/session-log';

/** An open review and how to plan it again (Review again never retries the old plan; it asks main for a new one). */
interface OpenReview { source: ReviewSource; replan: () => Promise<ReviewSource | null> }

const reviewKey = (s: ReviewSource): string =>
  s.kind === 'delete' ? s.pair.permanent.planId : s.kind === 'restore' ? s.plan.planId : s.batch.plans.map((p) => p.planId).join(',') || 'empty';

/**
 * Layout A: top bar, repo list (left), repo contents (right), action bar (bottom).
 * Review deletion and Delete entire repo plan through main and open the review; Permanently Delete Recent Deletions reviews the held batch.
 * The left-pane nav swaps the right pane between a repo, Recently Deleted and Settings; Sync opens its own dialog.
 */
export function App() {
  useShortcuts();
  const api = useApi();
  const client = useQueryClient();
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [review, setReview] = useState<OpenReview | null>(null);
  const planning = useRef(false);
  const [settingsSection, setSettingsSection] = useState<'advice' | null>(null);
  const [pane, setPane] = useState<'repo' | 'held' | 'settings'>('repo');
  const [syncOpen, setSyncOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [mode, setMode] = useState<AppMode>('library');
  const library = useLibrary();
  const lastAutoEmptyAt = useRef<number | null>(null);
  const autoEmpty = library.data?.lastAutoEmpty ?? null;
  useEffect(() => {
    if (autoEmpty === null || autoEmpty.at === lastAutoEmptyAt.current) return;
    lastAutoEmptyAt.current = autoEmpty.at;
    toast({
      title: `Recently Deleted: emptied ${autoEmpty.count} deletion(s) older than ${autoEmpty.days} days, freeing ${formatBytes(autoEmpty.freedBytes)}.`,
      tone: 'success',
    });
  }, [autoEmpty]);

  useDownloadsFeed((d) => {
    useSessionLog.getState().add(`Downloaded ${d.repoId}`, 'success');
    toast({
      tone: 'success',
      body: (
        <div>
          <p className="text-[13px] font-semibold">{`Downloaded ${d.repoId}. Sync LM Studio + Ollama?`}</p>
          <Button className="mt-2" variant="primary" onClick={() => setSyncOpen(true)}>Open Sync preview</Button>
        </div>
      ),
    });
  });

  const planFailed = (e: ApiError): null => {
    toast({ title: execErrorText(e.code, e.message).text, tone: 'danger' });
    return null;
  };
  const call = async <T,>(fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    try {
      return await fn();
    } catch (e) {
      return { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } };
    }
  };

  const deleteSource = (selection: Selection) => async (): Promise<ReviewSource | null> => {
    const r = await call(() => api.planDelete(selection));
    return r.ok ? { kind: 'delete', selection, pair: r.data } : planFailed(r.error);
  };
  const emptySource = (target: EmptyTarget) => async (): Promise<ReviewSource | null> => {
    const r = await call(() => api.planEmpty(target));
    return r.ok ? { kind: 'empty', batch: r.data } : planFailed(r.error);
  };

  /** One planning request at a time (a double click or a repeated shortcut opens one review). */
  async function open(make: () => Promise<ReviewSource | null>): Promise<void> {
    if (planning.current) return;
    planning.current = true;
    try {
      const source = await make();
      setReview(source === null ? null : { source, replan: make });
    } finally {
      planning.current = false;
    }
  }

  const refresh = (): void => {
    for (const key of [queryKeys.library, ['repo'], ['advice'], queryKeys.held, queryKeys.disk]) void client.invalidateQueries({ queryKey: key });
  };

  const onDone = (r: ExecResultDTO, plan: PlanDTO): void => {
    const s = resultSummary(r, plan);
    const log = useSessionLog.getState();
    log.add(s.text, s.tone);
    for (const n of r.notes) log.add(n, 'default');
    if (showsPopup(r)) toast({ body: <ResultToast result={r} plan={plan} onOpenSync={() => setSyncOpen(true)} />, tone: s.tone });
    if (r.ok && review?.source.kind === 'delete') useSelection.getState().clear();
    setReview(null);
    refresh();
  };

  /** Switching modes never carries a selection across: both selections are cleared. */
  const switchMode = (m: AppMode): void => {
    if (m === mode) return;
    useSelection.getState().clear();
    useDownloadSelection.getState().clear();
    setMode(m);
  };

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TopBar onSync={() => setSyncOpen(true)} mode={mode} onMode={switchMode} onDownloads={() => setDownloadsOpen((v) => !v)} />
      <StartupNotice onOpenHeld={() => setPane('held')} />
      {mode === 'download' ? <DownloadMode /> : (
      <div className="flex min-h-0 flex-1">
        <aside data-testid="left-pane" className="flex w-[270px] shrink-0 flex-col border-r border-border">
          <RepoList
            activeRepoId={pane === 'repo' ? activeRepoId : null} onActivate={(id) => { setActiveRepoId(id); setPane('repo'); }}
            onOpenHeld={() => setPane('held')} heldActive={pane === 'held'}
          />
          <Button data-testid="nav-settings" className="m-2.5 self-start" variant={pane === 'settings' ? 'tonal' : 'default'} aria-pressed={pane === 'settings'} onClick={() => { setSettingsSection(null); setPane('settings'); }}>
            Settings
          </Button>
        </aside>
        <main data-testid="right-pane" className="min-w-0 flex-1 overflow-auto px-4 py-3.5">
          {pane === 'held' ? <RecentlyDeletedView onReview={(source, replan) => setReview({ source, replan })} />
            : pane === 'settings' ? <SettingsView section={settingsSection} />
              : activeRepoId === null
                ? <div data-testid="detail-slot" className="text-muted-foreground">Select a repo to see what it contains.</div>
                : (
              <RepoDetail
                key={activeRepoId} repoId={activeRepoId}
                onDeleteWholeRepo={(repoId) => void open(deleteSource({ repos: [{ repoId, whole: true }] }))}
                onOpenSettings={() => { setSettingsSection('advice'); setPane('settings'); }}
              />
            )}
        </main>
      </div>
      )}
      {downloadsOpen && <DownloadsDrawer onClose={() => setDownloadsOpen(false)} />}
      <SyncDialog open={syncOpen} onClose={() => setSyncOpen(false)} />
      {mode === 'library' && <ActionBar onReview={(sel) => void open(deleteSource(sel))} onEmptyHeld={() => void open(emptySource({ all: true }))} />}
      {review !== null && (
        <ReviewDialog
          key={reviewKey(review.source)}
          source={review.source}
          onClose={() => setReview(null)}
          onDone={onDone}
          onExecuted={refresh}
          onReviewAgain={() => {
            const again = review.replan;
            setReview(null);
            void open(again);
          }}
        />
      )}
    </div>
  );
}
