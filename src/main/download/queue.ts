// The download queue's shapes and the zod schema that settings.json's
// `downloads` block must pass (parsed like `advice`, a bad block is an empty queue, nothing else changes).
// Kept apart from engine.ts so app-settings.ts can parse the block without loading the engine.
import { z } from 'zod';
import type { RepoType } from '../../core/types';
import { isSafeSiblingPath } from '../../core/download/remote-repo';
import { DL_STATES, type DlState } from '../../shared/api';
import { isCommitHash, safeRef } from '../../shared/hub-input';

export { DL_STATES, type DlState, type DownloadProgressDTO } from '../../shared/api';

export interface QueueFile { path: string; etag: string; size: number; lfs: boolean; state: DlState; bytes: number; error: string | null }
/**
 * `links`: files whose blob is already in the repo, linked into snapshots/<commit> before the ref moves.
 * `refAtStart`: the commit refs/<revision> named when the download was started (null: absent, or a commit revision).
 * The ref is moved at the end only while it still names that commit, so it never goes back to an older one. Missing
 * (an item saved before this field existed): unknown, so the ref is never moved for it.
 */
export interface QueueItem {
  id: string; repoId: string; type: RepoType; revision: string; commit: string; refAtStart?: string | null;
  files: QueueFile[]; links: Array<{ path: string; etag: string }>;
}
export interface DownloadsBlock { version: 1; items: QueueItem[] }
export const EMPTY_DOWNLOADS: DownloadsBlock = { version: 1, items: [] };


export const MAX_QUEUE_ITEMS = 1000;
export const MAX_ITEM_FILES = 100_000;
const MAX_PATH = 4096;

const ETAG = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SIZE = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const FILE = z.strictObject({
  path: z.string().min(1).max(MAX_PATH).refine(isSafeSiblingPath, 'unsafe path'),
  etag: z.string().regex(ETAG),
  size: SIZE,
  lfs: z.boolean(),
  state: z.enum(DL_STATES),
  bytes: SIZE,
  error: z.string().max(4000).nullable(),
}).refine((f) => f.lfs === (f.etag.length === 64), 'an LFS file has a 64-hex etag, any other a 40-hex one')
  .refine((f) => f.bytes <= f.size, 'more bytes than the file has');

const LINK = z.strictObject({ path: z.string().min(1).max(MAX_PATH).refine(isSafeSiblingPath, 'unsafe path'), etag: z.string().regex(ETAG) });

const unique = (paths: string[]): boolean => new Set(paths).size === paths.length;

export const QUEUE_ITEM = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  repoId: z.string().min(1).max(200),
  type: z.enum(['model', 'dataset', 'space']),
  revision: z.string().min(1).max(256).refine((r) => safeRef(r) || isCommitHash(r), 'unsafe revision'),
  commit: z.string().regex(COMMIT),
  refAtStart: z.string().regex(COMMIT).nullable().optional(),
  files: z.array(FILE).min(1).max(MAX_ITEM_FILES).refine((fs) => unique(fs.map((f) => f.path)), 'a path is listed twice'),
  links: z.array(LINK).max(MAX_ITEM_FILES),
}).refine((i) => unique([...i.files.map((f) => f.path), ...i.links.map((l) => l.path)]), 'a path is both downloaded and linked')
  .refine((i) => !isCommitHash(i.revision) || i.revision.toLowerCase() === i.commit, 'a commit revision names the item commit')
  .refine((i) => !isCommitHash(i.revision) || i.refAtStart == null, 'a commit revision has no ref') satisfies z.ZodType<QueueItem>;

export const DOWNLOADS_BLOCK = z.strictObject({
  version: z.literal(1),
  items: z.array(QUEUE_ITEM).max(MAX_QUEUE_ITEMS).refine((is) => unique(is.map((i) => i.id)), 'an id is listed twice'),
}) satisfies z.ZodType<DownloadsBlock>;

/** Recent look-ups kept. */
export const MAX_RECENT_LOOKUPS = 20;
/** One recent look-up in settings.json: what is needed to look it up again, and when. */
export interface RecentLookup { repoId: string; type: RepoType; revision: string; at: number }
export const RECENT_LOOKUPS = z.array(z.strictObject({
  repoId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
  type: z.enum(['model', 'dataset', 'space']),
  revision: z.string().min(1).max(256).refine((r) => safeRef(r) || isCommitHash(r), 'unsafe revision'),
  at: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
})).max(MAX_RECENT_LOOKUPS) satisfies z.ZodType<RecentLookup[]>;
