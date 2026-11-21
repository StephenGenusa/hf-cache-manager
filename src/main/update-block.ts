// What a "Check for updates" run leaves in settings.json (`updateCheck`), and the schema that block must pass.
// Parsed like `recentLookups`: a missing block is absent, a bad one is empty, and nothing else in the file changes.
// Only repos with something to say are kept (an update, a failure, a skip); a repo that is current has no entry.
import { z } from 'zod';
import { isSafeSiblingPath } from '../core/download/remote-repo';
import type { RepoType } from '../core/types';

export type UpdateStatus = 'update' | 'failed' | 'skipped';
export interface UpdateFile { path: string; size: number; etag: string; lfs: boolean }
/**
 * `files` (status `update`): the Hub's versions, at `commit`, of files the cache held an older version of. They are
 * compared with the cache again on every read, so an entry clears itself as its files are downloaded.
 */
export interface UpdateCheckEntry {
  repoId: string; type: RepoType; status: UpdateStatus; commit: string | null; files: UpdateFile[];
  message: string | null; checkedAt: number;
}
export interface UpdateCheckBlock { version: 1; checkedAt: number | null; entries: UpdateCheckEntry[] }
export const EMPTY_UPDATE_CHECK: UpdateCheckBlock = { version: 1, checkedAt: null, entries: [] };

export const MAX_UPDATE_ENTRIES = 20_000;
/** Files kept per repo; a repo with more outdated files than this still reads as having an update. */
export const MAX_UPDATE_FILES = 2_000;
const AT = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const FILE = z.strictObject({
  path: z.string().min(1).max(4096).refine(isSafeSiblingPath, 'unsafe path'),
  size: AT,
  etag: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  lfs: z.boolean(),
});

const ENTRY = z.strictObject({
  repoId: z.string().min(1).max(200),
  type: z.enum(['model', 'dataset', 'space']),
  status: z.enum(['update', 'failed', 'skipped']),
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  files: z.array(FILE).max(MAX_UPDATE_FILES),
  message: z.string().max(4000).nullable(),
  checkedAt: AT,
});

export const UPDATE_CHECK_BLOCK = z.strictObject({
  version: z.literal(1),
  checkedAt: AT.nullable(),
  entries: z.array(ENTRY).max(MAX_UPDATE_ENTRIES),
}) satisfies z.ZodType<UpdateCheckBlock>;
