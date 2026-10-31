import type { LibraryDTO } from '../../shared/api';
import { useLibrary } from './queries';

/** Mirrors the main-process REPO_ID schema: ids with more than one slash cannot be carried over IPC. */
const SELECTABLE_REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
export const isSelectableRepoId = (id: string): boolean => id.length <= 200 && SELECTABLE_REPO_ID.test(id);

export const AMBIGUOUS_NOTE = 'Two repos share this id (model and dataset); deletion is disabled for them in this version.';
export const UNSELECTABLE_ID_NOTE = 'This repo id cannot be selected in this version.';
export const hubMissingText = (hubRoot: string): string => `Cache not found at ${hubRoot}. Is the drive mounted?`;
export const scanErrorText = (message: string): string => `The cache could not be read: ${message}. Fix the permissions and rescan.`;

export interface DeletionBlock {
  /** True while nothing may be selected or deleted for the repo. */
  blocked: boolean;
  /** Why, in words; null while the library is still loading. */
  reason: string | null;
}

/** Pure form of the rule, so the action bar and the detail pane agree. */
export function deletionBlock(lib: LibraryDTO | undefined, repoId: string | null): DeletionBlock {
  if (lib === undefined) return { blocked: true, reason: null };
  if (!lib.hubPresent) return { blocked: true, reason: hubMissingText(lib.hubRoot) };
  if (lib.scanError !== null) return { blocked: true, reason: scanErrorText(lib.scanError) };
  if (repoId !== null) {
    if (!isSelectableRepoId(repoId)) return { blocked: true, reason: UNSELECTABLE_ID_NOTE };
    if (lib.repos.some((r) => r.repoId === repoId && r.ambiguous)) return { blocked: true, reason: AMBIGUOUS_NOTE };
  }
  return { blocked: false, reason: null };
}

export function useDeletionBlock(repoId: string | null): DeletionBlock {
  return deletionBlock(useLibrary().data, repoId);
}
