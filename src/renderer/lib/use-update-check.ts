import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UpdateCheckDTO, UpdateCheckProgressDTO, UpdateRepoDTO } from '../../shared/api';
import type { HubRepoType } from '../../shared/hub-input';
import { unwrap, useApi } from './api';
import { useLibrary } from './queries';

export const updateCheckKey = ['update-check'] as const;

export interface UpdateCheckState {
  /** What the last check found, as it holds against the present scan; undefined until first read. */
  data: UpdateCheckDTO | undefined;
  /** The newest progress: the latest event, else what main reported when asked. */
  progress: UpdateCheckProgressDTO | null;
  refresh(): void;
}

/**
 * The update check's findings and live progress. The findings are read again after every scan, after a finished
 * download (a refreshed repo's update clears in main) and when a run ends; progress comes from events.
 */
export function useUpdateCheck(): UpdateCheckState {
  const api = useApi();
  const client = useQueryClient();
  const scannedAt = useLibrary().data?.scannedAt ?? 0;
  const q = useQuery({
    queryKey: [...updateCheckKey, scannedAt], queryFn: async () => unwrap(await api.updateCheck()),
    staleTime: Infinity, retry: false, placeholderData: keepPreviousData,
  });
  const [live, setLive] = useState<UpdateCheckProgressDTO | null>(null);
  useEffect(() => api.onUpdateCheckProgress((p) => {
    setLive(p);
    if (!p.running) void client.invalidateQueries({ queryKey: updateCheckKey });
  }), [api, client]);
  // A finished download: main has rescanned, so an update that was just fetched is gone from the findings.
  useEffect(() => api.onDownloadDone(() => { void client.invalidateQueries({ queryKey: updateCheckKey }); }), [api, client]);
  const refresh = useCallback(() => { void client.invalidateQueries({ queryKey: updateCheckKey }); }, [client]);
  return { data: q.data, progress: live ?? q.data?.progress ?? null, refresh };
}

export interface RepoUpdateState {
  /** The repo has (or had, when it was opened) the update badge, so it is checked on its own. */
  wanted: boolean;
  checking: boolean;
  data: UpdateRepoDTO | undefined;
  error: string | null;
  /** The paths the Hub has a newer version of; undefined when there are none to mark. */
  outdated: ReadonlySet<string> | undefined;
}

/**
 * Opening a repo that has the update badge checks that one repo against the Hub (one request), every time it is
 * opened. A repo without the badge is never asked about. The findings are read again once the answer is in.
 */
export function useRepoUpdate(repoId: string, type: HubRepoType | undefined): RepoUpdateState {
  const api = useApi();
  const check = useUpdateCheck();
  const badged = type !== undefined && (check.data?.results.some((r) => r.repoId === repoId && r.type === type && r.status === 'update') ?? false);
  // latched: the answer may clear the badge, and the line saying so must stay
  const [wanted, setWanted] = useState(false);
  if (badged && !wanted) setWanted(true);
  const q = useQuery({
    queryKey: ['update-repo', type ?? '', repoId], enabled: wanted && type !== undefined,
    queryFn: async () => unwrap(await api.updateCheckRepo(repoId, type ?? 'model')),
    staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const { refresh } = check;
  const answeredAt = q.dataUpdatedAt;
  useEffect(() => { if (answeredAt > 0) refresh(); }, [answeredAt, refresh]);
  const outdated = useMemo(() => (q.data !== undefined && q.data.files.length > 0 ? new Set(q.data.files.map((f) => f.path)) : undefined), [q.data]);
  return { wanted, checking: q.isFetching, data: q.data, error: q.isError ? q.error.message : null, outdated };
}
