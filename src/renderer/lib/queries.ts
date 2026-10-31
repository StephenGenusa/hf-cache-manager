import { useEffect, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  DiskInfoDTO, HeldListDTO, LibraryDTO, MachineProfileDTO, RecentLookupDTO, RepoAdviceDTO, RepoDetailDTO, ScanProgressDTO, SettingsDTO, StartupNoticeDTO,
} from '../../shared/api';
import { unwrap, useApi } from './api';

export const queryKeys = {
  library: ['library'] as const,
  repo: (repoId: string) => ['repo', repoId] as const,
  advice: (repoId: string) => ['advice', repoId] as const,
  held: ['held'] as const,
  settings: ['settings'] as const,
  machineProfile: ['machine-profile'] as const,
  disk: ['disk'] as const,
  recentLookups: ['recent-lookups'] as const,
};

/** A scan walks the whole cache, so the library is never refetched on its own: callers refetch it (Rescan, after a change). */
export function useLibrary(): UseQueryResult<LibraryDTO> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.library, queryFn: async () => unwrap(await api.scan()), staleTime: Infinity, refetchOnWindowFocus: false });
}

export function useRepoDetail(repoId: string | null): UseQueryResult<RepoDetailDTO> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.repo(repoId ?? ''), enabled: repoId !== null, staleTime: Infinity,
    queryFn: async () => unwrap(await api.repoDetail(repoId ?? '')),
  });
}

/** Keep advice and name parts for a repo. Failure or loading is not an error to show: callers fall back to plain names. */
export function useAdvice(repoId: string | null): UseQueryResult<RepoAdviceDTO> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.advice(repoId ?? ''), enabled: repoId !== null, staleTime: Infinity, retry: false,
    queryFn: async () => unwrap(await api.advice(repoId ?? '')),
  });
}

export function useMachineProfile(): UseQueryResult<MachineProfileDTO> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.machineProfile, queryFn: async () => unwrap(await api.machineProfile()), staleTime: Infinity });
}

export function useHeld(): UseQueryResult<HeldListDTO> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.held, queryFn: async () => unwrap(await api.listHeld()) });
}

export function useSettings(): UseQueryResult<SettingsDTO> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.settings, queryFn: async () => unwrap(await api.settings()) });
}

export function useDiskInfo(): UseQueryResult<DiskInfoDTO> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.disk, queryFn: async () => unwrap(await api.diskInfo()) });
}

/** The latest scan progress event, or null before the first. Subscribes for the component's lifetime. */
export function useScanProgress(): ScanProgressDTO | null {
  const api = useApi();
  const [p, setP] = useState<ScanProgressDTO | null>(null);
  useEffect(() => api.onScanProgress(setP), [api]);
  return p;
}

export const noticeKey = ['notices'] as const;

/** The startup notices; `refetchMs` polls (used while an auto-empty countdown is showing). */
export function useStartupNotices(refetchMs?: number | false): UseQueryResult<StartupNoticeDTO[]> {
  const api = useApi();
  return useQuery({
    queryKey: noticeKey, queryFn: async () => unwrap(await api.startupNotices()), staleTime: Infinity,
    refetchInterval: refetchMs ?? false,
  });
}

export function useRecentLookups(): UseQueryResult<RecentLookupDTO[]> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.recentLookups, queryFn: async () => unwrap(await api.recentLookups()), staleTime: Infinity, retry: false });
}
