// Strict argument schemas for every invoke channel. The renderer never sends a filesystem path:
// only repo ids, group keys, plan ids, fingerprints, deletion ids, modes, booleans, a confirm string, a day count,
// the advice settings block (numbers, enums and tool names) and, for download mode, the look-up text and uuids.
import { z } from 'zod';
import type { AdviceSettings } from '../core/advice/profile';
import type { Tool } from './knowledge/rules';
import type { HfcmApi, InvokeMethod } from './api';

export const REPO_ID = z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/);
// 4096, so a `root-file:` / `other:` key for a 250-char filename passes.
export const GROUP_KEY = z.string().min(3).max(4096).regex(/^[a-z][a-z-]*:[^\0\\]*$/);
export const PLAN_ID = z.string().uuid();
export const FINGERPRINT = z.string().regex(/^[0-9a-f]{64}$/);
// A literal copy of the core's DELETION_ID_RE (manifest.ts imports node:path; a test pins the two together).
export const DELETION_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
export const DELETION_ID = z.string().regex(DELETION_ID_PATTERN);
export const CONFIRM_TEXT = z.string().max(256).nullable();
const MAX_TOTAL_GROUP_KEYS = 5000;
export const SELECTION = z.object({
  repos: z.array(z.discriminatedUnion('whole', [
    z.object({ repoId: REPO_ID, whole: z.literal(true) }).strict(),
    z.object({
      repoId: REPO_ID, whole: z.literal(false), groupKeys: z.array(GROUP_KEY).min(1).max(1000), unlockComponents: z.boolean(),
    }).strict(),
  ])).min(1).max(500),
}).strict().superRefine((sel, ctx) => {
  const seen = new Set<string>();
  let keyTotal = 0;
  for (const [i, r] of sel.repos.entries()) {
    if (seen.has(r.repoId)) ctx.addIssue({ code: 'custom', path: ['repos', i, 'repoId'], message: 'repoId repeated in selection' });
    seen.add(r.repoId);
    if (!r.whole) {
      keyTotal += r.groupKeys.length;
      if (new Set(r.groupKeys).size !== r.groupKeys.length) {
        ctx.addIssue({ code: 'custom', path: ['repos', i, 'groupKeys'], message: 'groupKey repeated within a repo' });
      }
    }
  }
  if (keyTotal > MAX_TOTAL_GROUP_KEYS) {
    ctx.addIssue({ code: 'custom', path: ['repos'], message: `more than ${MAX_TOTAL_GROUP_KEYS} group keys in total` });
  }
});

const BYTES = z.number().int().min(1e9).max(1e13).nullable();
const TOOLS = ['llama.cpp', 'lmstudio', 'ollama', 'vllm', 'tabbyapi', 'transformers'] as const satisfies readonly Tool[];
/**
 * The advice block, strict: what `setAdviceSettings` accepts and what settings.json's `advice` key is parsed with
 * (src/main/app-settings.ts imports this one schema, so the two cannot drift).
 */
export const ADVICE_SETTINGS = z.strictObject({
  gpuBytes: BYTES,
  gpuKind: z.enum(['nvidia', 'apple', 'other']).nullable(),
  ramBytes: BYTES,
  drivesDisplay: z.boolean().nullable(),
  context: z.union([z.literal(8192), z.literal(16384), z.literal(32768), z.literal(65536), z.literal(131072)]),
  kvType: z.enum(['f16', 'q8_0']),
  tools: z.array(z.enum(TOOLS)).max(TOOLS.length).refine((t) => new Set(t).size === t.length, 'tool repeated').nullable(),
}) satisfies z.ZodType<AdviceSettings>;

const NONE = z.tuple([]);

/** What the user typed (a repo id, `id@revision` or a Hub URL); main parses it, never as a path. */
export const HUB_INPUT = z.string().min(1).max(400);
/** A look-up's or a preview's id (uuids kept in main for 10 minutes). */
export const LOOKUP_ID = z.string().uuid();
export const PREVIEW_ID = LOOKUP_ID;
export const DOWNLOAD_ID = z.string().uuid();
export const MAX_DOWNLOAD_GROUP_KEYS = 500;
export const DOWNLOAD_GROUP_KEYS = z.array(GROUP_KEY).min(1).max(MAX_DOWNLOAD_GROUP_KEYS)
  .refine((k) => new Set(k).size === k.length, 'groupKey repeated');

export const ARG_SCHEMAS = {
  scan: NONE,
  cancelScan: NONE,
  repoDetail: z.tuple([REPO_ID]),
  previewSelection: z.tuple([SELECTION]),
  planDelete: z.tuple([SELECTION]),
  executePlan: z.tuple([PLAN_ID, FINGERPRINT, z.enum(['hold', 'permanent']), CONFIRM_TEXT]),
  listHeld: NONE,
  planRestore: z.tuple([DELETION_ID]),
  planEmpty: z.tuple([z.union([z.object({ all: z.literal(true) }).strict(), z.object({ deletionId: DELETION_ID }).strict()])]),
  setAutoEmptyDays: z.tuple([z.number().int().min(1).max(3650).nullable()]),
  planSync: NONE,
  executeSync: z.tuple([PLAN_ID, z.object({ allowMassRemoval: z.boolean() }).strict()]),
  settings: NONE,
  diskInfo: NONE,
  startupNotices: NONE,
  ackStartupNotice: z.tuple([z.union([
    PLAN_ID, z.literal('settings-unreadable'), z.literal('held-unreadable'), z.literal('auto-empty-pending'), z.literal('auto-empty-skipped'),
  ])]),
  advice: z.tuple([REPO_ID]),
  machineProfile: NONE,
  setAdviceSettings: z.tuple([ADVICE_SETTINGS]),
  redetectMachine: NONE,
  hubLookup: z.tuple([HUB_INPUT]),
  downloadAdvice: z.tuple([LOOKUP_ID]),
  downloadPreview: z.tuple([LOOKUP_ID, DOWNLOAD_GROUP_KEYS]),
  downloadStart: z.tuple([PREVIEW_ID, FINGERPRINT]),
  downloadPause: z.tuple([DOWNLOAD_ID]),
  downloadResume: z.tuple([DOWNLOAD_ID]),
  downloadCancel: z.tuple([DOWNLOAD_ID]),
  downloads: NONE,
  recentLookups: NONE,
  lookupGroups: z.tuple([LOOKUP_ID]),
} as const satisfies Record<InvokeMethod, z.ZodType>;

export function parseArgs<M extends InvokeMethod>(
  method: M, args: unknown[],
): { ok: true; args: Parameters<HfcmApi[M]> } | { ok: false; message: string; paths: string[] } {
  const r = (ARG_SCHEMAS[method] as z.ZodType).safeParse(args);
  if (!r.success) {
    return {
      ok: false,
      message: r.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; '),
      paths: [...new Set(r.error.issues.map((i) => i.path.join('.') || 'args'))],
    };
  }
  return { ok: true, args: r.data as Parameters<HfcmApi[M]> };
}
