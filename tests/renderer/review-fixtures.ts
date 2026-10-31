// Hand-built PlanDTOs for the review dialog and result toast tests. They mirror what main's
// toPlanDTO produces for the Qwen fixture: 3 files, 8250 bytes, phrase = the full repo id.
import type { Selection } from '../../src/core/types';
import type { EmptyPlanDTO, ExecResultDTO, PlanDTO, PlanPairDTO } from '../../src/shared/api';

export const Q = 'unsloth/Qwen3.6-27B-GGUF';
export const SEL: Selection = { repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q8_0', 'quant:BF16'], unlockComponents: false }] };
const FP_P = 'b'.repeat(64);
const FP_H = 'c'.repeat(64);
export const HELD_PAYLOAD_WARNING =
  'unsloth/Qwen3.6-27B-GGUF · Q4_K_M in Recently Deleted needs shared store/9c41…7a to be restored; Delete Permanently removes it for good.';
export const UNREADABLE_WARNING = 'Recently Deleted could not be read: EACCES. A held deletion may need files this plan removes.';
export const SUPERSEDED = 'An update may be in progress or incomplete: some of these files are the only copy of files missing from the current revision.';

export function permanentPlan(over: Partial<PlanDTO> = {}): PlanDTO {
  const now = Date.now();
  return {
    planId: '00000000-0000-4000-8000-0000000000a2', fingerprint: FP_P, mode: 'permanent', purpose: 'delete',
    title: `Review deletion — ${Q}`, repoIds: [Q], groupCount: 2, createdAt: now, expiresAt: now + 600_000,
    filesRemoved: 3, freedBytes: 8250, apparentBytes: 8250, sharedBytes: 0,
    files: [
      { repoId: Q, displayPath: 'snapshots/a3f9c1e/Qwen3.6-27B-Q8_0.gguf', otherLinks: 0, blobShort: '5e1d…a9', bytes: 4000,
        reason: 'only-link', reasonText: 'only link', fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/blobs/5e1d00000000000000000000000000000000000000000000000000000000a9' },
      { repoId: Q, displayPath: 'snapshots/a3f9c1e/BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', otherLinks: 2, blobShort: '9c41…7a',
        bytes: 3000, reason: 'only-link', reasonText: 'only link', fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/blobs/9c4100000000000000000000000000000000000000000000000000000000007a' },
      { repoId: Q, displayPath: 'snapshots/a3f9c1e/BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf', otherLinks: 0, blobShort: null,
        bytes: 1250, reason: 'plain-file', reasonText: 'plain file', fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf' },
    ],
    ops: [
      { kind: 'unlink', role: 'view-link', displayPath: '~/.lmstudio/models/unsloth/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q8_0.gguf',
        fullPath: '/home/u/.lmstudio/models/unsloth/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q8_0.gguf' },
      { kind: 'write-file', role: 'view-state', displayPath: '~/.lmstudio/models/.hfhub-sync.json', fullPath: '/home/u/.lmstudio/models/.hfhub-sync.json' },
      { kind: 'unlink', role: 'snapshot-link', displayPath: 'snapshots/a3f9c1e/Qwen3.6-27B-Q8_0.gguf',
        fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/Qwen3.6-27B-Q8_0.gguf' },
      { kind: 'unlink', role: 'repo-blob', displayPath: 'blobs/5e1d…a9', fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/blobs/5e1dfull' },
      { kind: 'rmdir-empty', role: null, displayPath: 'snapshots/a3f9c1e/BF16', fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/BF16' },
    ],
    viewLines: [
      { view: 'lmstudio', displayPath: '~/.lmstudio/models/unsloth/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q8_0.gguf', action: 'remove',
        actionText: 'will be removed', key: 'unsloth/Qwen3.6-27B-GGUF:Q8_0', note: null, entryKind: 'symlink',
        fullPath: '/home/u/.lmstudio/models/unsloth/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q8_0.gguf' },
    ],
    viewsUnaffected: ['ollama'],
    kept: [
      { repoId: Q, groupKey: 'quant:UD-Q4_K_XL', label: 'UD-Q4_K_XL', bytes: 1000 },
      { repoId: Q, groupKey: 'mmproj:mmproj-F16', label: 'mmproj-F16', bytes: 500 },
    ],
    keptFiles: [
      { repoId: Q, displayPath: 'snapshots/a3f9c1e/Qwen3.6-27B-UD-Q4_K_XL.gguf',
        fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/Qwen3.6-27B-UD-Q4_K_XL.gguf' },
      { repoId: Q, displayPath: 'snapshots/a3f9c1e/mmproj-F16.gguf',
        fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/mmproj-F16.gguf' },
    ],
    warnings: [], confirmPhrase: Q, holdRootDisplay: null,
    ...over,
  };
}

export function holdPlan(over: Partial<PlanDTO> = {}): PlanDTO {
  return permanentPlan({
    planId: '00000000-0000-4000-8000-0000000000a1', fingerprint: FP_H, mode: 'hold', confirmPhrase: null,
    holdRootDisplay: '/data/models/.hfcm-held', ...over,
  });
}

export const qwenPair = (over: Partial<PlanPairDTO> = {}): PlanPairDTO =>
  ({ hold: holdPlan(), holdUnavailableReason: null, permanent: permanentPlan(), ...over });

/** Two repos: the planner's phrase is `delete 2 repos` and file rows carry their repo id. */
export function twoRepoPair(): PlanPairDTO {
  const p = permanentPlan({
    title: 'Review deletion — 2 repos', repoIds: [Q, 'bartowski/gemma-4-31b-it-GGUF'], confirmPhrase: 'delete 2 repos',
    files: [
      ...permanentPlan().files.slice(0, 1),
      { repoId: 'bartowski/gemma-4-31b-it-GGUF', displayPath: 'snapshots/1234567/gemma-4-31b-it-Q4_K_M.gguf', otherLinks: 0,
        blobShort: 'abcd…ef', bytes: 4250, reason: 'only-link', reasonText: 'only link',
        fullPath: '/data/models/hub/models--bartowski--gemma-4-31b-it-GGUF/blobs/abcd00ef' },
    ],
    kept: [], keptFiles: [],
  });
  return { hold: null, holdUnavailableReason: 'Recently Deleted is on a different drive', permanent: p };
}

/** A plan exercising every line kind main can send: warnings, blocked/foreign/kept-shared/folder view lines, Ollama. */
export function busyPlan(): PlanDTO {
  return permanentPlan({
    sharedBytes: 2200, apparentBytes: 10_450,
    files: [
      ...permanentPlan().files,
      { repoId: null, displayPath: 'shared store/77aa…01', otherLinks: 0, blobShort: null, bytes: 2200, reason: 'store-shared',
        reasonText: 'shared with Qwen/Qwen3-32B — not freed', fullPath: '/data/models/hub/blobs/77/77aa0000000000000000000000000000000000000000000000000000000000001' },
      { repoId: Q, displayPath: 'snapshots/a3f9c1e/fifo', otherLinks: 0, blobShort: null, bytes: 0, reason: 'special-file',
        reasonText: 'special file (fifo/socket/device) — no data freed', fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/fifo' },
    ],
    viewLines: [
      ...permanentPlan().viewLines,
      { view: 'lmstudio', displayPath: '~/.lmstudio/models/unsloth/Qwen3.6-27B-GGUF', action: 'remove', actionText: 'empty folder removed',
        key: null, note: null, entryKind: 'folder', fullPath: '/home/u/.lmstudio/models/unsloth/Qwen3.6-27B-GGUF' },
      { view: 'ollama', displayPath: '~/.ollama/models/blobs/sha256-0123456789ab…', action: 'keep-shared',
        actionText: 'kept — another entry still uses it', key: 'qwen3.6:q8', note: null, entryKind: null,
        fullPath: '/home/u/.ollama/models/blobs/sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
      { view: 'ollama', displayPath: '~/.ollama/models/manifests/registry.ollama.ai/library/qwen3.6/q8', action: 'foreign',
        actionText: 'left in place — not created by sync; its link will dangle', key: null, note: 'not created by sync; its link will dangle',
        entryKind: null, fullPath: '/home/u/.ollama/models/manifests/registry.ollama.ai/library/qwen3.6/q8' },
      { view: 'lmstudio', displayPath: '~/.lmstudio/models/other/x.gguf', action: 'blocked', actionText: 'blocked — the view state is unreadable',
        key: null, note: 'the view state is unreadable', entryKind: null, fullPath: '/home/u/.lmstudio/models/other/x.gguf' },
    ],
    viewsUnaffected: [],
    warnings: [HELD_PAYLOAD_WARNING, UNREADABLE_WARNING, SUPERSEDED],
  });
}

export function restorePlan(over: Partial<PlanDTO> = {}): PlanDTO {
  const now = Date.now();
  return {
    planId: '00000000-0000-4000-8000-0000000000b1', fingerprint: 'd'.repeat(64), mode: 'hold', purpose: 'restore',
    title: 'Restore from Recently Deleted', repoIds: [Q], groupCount: 0, createdAt: now, expiresAt: now + 600_000,
    filesRemoved: 3, freedBytes: 0, apparentBytes: 4000, sharedBytes: 4000,
    files: [
      { repoId: Q, displayPath: 'snapshots/a3f9c1e/Qwen3.6-27B-Q8_0.gguf', otherLinks: 0, blobShort: null, bytes: 0, reason: 'restore-move', reasonText: 'moves back',
        fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/Qwen3.6-27B-Q8_0.gguf' },
      { repoId: Q, displayPath: 'blobs/5e1d…a9', otherLinks: 0, blobShort: null, bytes: 4000, reason: 'restore-move', reasonText: 'moves back',
        fullPath: '/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/blobs/5e1d00000000000000000000000000000000000000000000000000000000a9' },
      { repoId: null, displayPath: 'shared store/77aa…01.refs', otherLinks: 0, blobShort: null, bytes: 0, reason: 'restore-refs', reasonText: '.refs re-added',
        fullPath: '/data/models/hub/blobs/77/77aa01.refs' },
    ],
    ops: [
      { kind: 'restore-rename', role: 'snapshot-link', displayPath: 'Recently Deleted/20261025T140307Z-1a2b3c4d/x', fullPath: '/data/models/.hfcm-held/20261025T140307Z-1a2b3c4d/x' },
      { kind: 'restore-rename', role: 'repo-blob', displayPath: 'Recently Deleted/20261025T140307Z-1a2b3c4d/y', fullPath: '/data/models/.hfcm-held/20261025T140307Z-1a2b3c4d/y' },
      { kind: 'store-refs-add', role: null, displayPath: 'shared store/77aa…01.refs', fullPath: '/data/models/hub/blobs/77/77aa01.refs' },
      { kind: 'write-file', role: 'hold-manifest', displayPath: 'Recently Deleted/20261025T140307Z-1a2b3c4d/manifest.json', fullPath: '/data/models/.hfcm-held/20261025T140307Z-1a2b3c4d/manifest.json' },
      { kind: 'rmdir-empty', role: null, displayPath: 'Recently Deleted/20261025T140307Z-1a2b3c4d', fullPath: '/data/models/.hfcm-held/20261025T140307Z-1a2b3c4d' },
    ],
    viewLines: [], viewsUnaffected: [], kept: [], keptFiles: [],
    warnings: ['Run Sync afterwards to recreate the LM Studio and Ollama links this deletion removed.'],
    confirmPhrase: null, holdRootDisplay: null, ...over,
  };
}

export function emptyPlan(i: number, over: Partial<PlanDTO> = {}): PlanDTO {
  const now = Date.now();
  return {
    planId: `00000000-0000-4000-8000-0000000000c${i}`, fingerprint: String(i).repeat(64), mode: 'permanent', purpose: 'empty',
    title: 'Empty Recently Deleted', repoIds: [i === 1 ? Q : `org/repo-${i}`], groupCount: 0, createdAt: now, expiresAt: now + 600_000,
    filesRemoved: 1, freedBytes: 1000 * i, apparentBytes: 1000 * i, sharedBytes: 0,
    files: [{ repoId: null, displayPath: `Recently Deleted/20261025T14030${i}Z-1a2b3c4d/models--x/blobs/aaaa…0${i}`, otherLinks: 0,
      blobShort: null, bytes: 1000 * i, reason: 'only-link', reasonText: 'only link',
      fullPath: `/data/models/.hfcm-held/20261025T14030${i}Z-1a2b3c4d/models--x/blobs/aaaa${i}` }],
    ops: [{ kind: 'unlink', role: 'held-item', displayPath: `Recently Deleted/20261025T14030${i}Z-1a2b3c4d/models--x/blobs/aaaa…0${i}`,
      fullPath: `/data/models/.hfcm-held/20261025T14030${i}Z-1a2b3c4d/models--x/blobs/aaaa${i}` }],
    viewLines: [], viewsUnaffected: [], kept: [], keptFiles: [], warnings: [], confirmPhrase: null, holdRootDisplay: null, ...over,
  };
}

export function emptyBatch(n: number, over: Partial<EmptyPlanDTO> = {}): EmptyPlanDTO {
  const plans = Array.from({ length: n }, (_, k) => emptyPlan(k + 1));
  return {
    plans, skipped: [], freedBytes: plans.reduce((s, p) => s + p.freedBytes, 0),
    apparentBytes: plans.reduce((s, p) => s + p.apparentBytes, 0), sharedBytes: plans.reduce((s, p) => s + p.sharedBytes, 0), ...over,
  };
}

export function execResult(over: Partial<ExecResultDTO> = {}): ExecResultDTO {
  return {
    ok: true, planId: permanentPlan().planId, mode: 'permanent', purpose: 'delete', appliedOps: 5, totalOps: 5, error: null,
    freedBytesPlanned: 8250, heldBytes: 0, diskFreeDelta: 8192, followUp: null, notes: [], ...over,
  };
}
