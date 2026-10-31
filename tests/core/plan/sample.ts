import type { DeletionPlan, Op } from '../../../src/core/types';

const facts = { dev: 1, ino: 2, size: 3, mtimeMs: 4, nlink: 1, isSymlink: false, isDirectory: false, isFile: true };
export function samplePlan(): DeletionPlan {
  return {
    id: 'p1', fingerprint: '', mode: 'permanent', purpose: 'delete', hubRoot: '/h', holdRoot: null, deletionId: null,
    createdAt: 1000, expiresAt: 601_000, selection: null,
    ops: [{ kind: 'unlink', path: '/h/o/a', expect: facts, role: 'repo-blob' } as Op],
    freed: { bytes: 3, lines: [] }, apparentBytes: 3, kept: [], viewImpact: [], warnings: [], confirmPhrase: 'o/a',
  };
}

