// Limits on the regular view files Recently Deleted records inline. A leaf module (imports nothing), shared by the
// planner (which refuses the hold before the user confirms) and manifestFromPlan (which enforces the same rules).
import type { FileFacts } from '../types';

/** The largest regular view file (blob or manifest) a hold records inline. */
export const MAX_HELD_VIEW_FILE_BYTES = 1024 * 1024;
/** The most view content one hold records (see viewHoldCost), keeping the hold manifest far below MAX_MANIFEST_BYTES. */
export const MAX_HELD_VIEW_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * Why a view unlink cannot be recorded. 'not-a-file': a directory, FIFO or other non-file that is not a symlink.
 * 'not-a-link': a regular file whose role is neither blob nor manifest. 'too-large': a file over the limit.
 * Null for a symlink or a recordable file.
 */
export function viewHoldProblem(role: string, expect: FileFacts): 'not-a-file' | 'not-a-link' | 'too-large' | null {
  if (expect.isSymlink) return null;
  if (!expect.isFile) return 'not-a-file';
  if (role !== 'view-blob' && role !== 'view-manifest') return 'not-a-link';
  return expect.size > MAX_HELD_VIEW_FILE_BYTES ? 'too-large' : null;
}

/**
 * What a recorded view unlink adds to the hold manifest, estimated from the planned facts: 0 for a link, the base64
 * length for a blob, and for a manifest its worst-case JSON-escaped size (6 bytes per byte, `\\uXXXX`).
 */
export function viewHoldCost(role: string, expect: FileFacts): number {
  if (expect.isSymlink) return 0;
  return role === 'view-blob' ? Math.ceil(expect.size / 3) * 4 : expect.size * 6;
}
