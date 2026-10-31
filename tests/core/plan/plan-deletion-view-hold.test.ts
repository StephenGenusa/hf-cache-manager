import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_HELD_VIEW_FILE_BYTES, MAX_HELD_VIEW_TOTAL_BYTES } from '../../../src/core/hold/view-limits';
import { planDeletion } from '../../../src/core/plan/planner';
import type { CacheModel, FileFacts, Op, OpRole, Selection, ViewImpactLine } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { buildTree, f, groupKeyFor, type Tree } from '../support/scenarios';
import { stubViews } from '../support/stub-views';

useCanaries();
beforeEach(() => expect.hasAssertions());

const MIB = 1024 * 1024;
const reg = (size: number): FileFacts => ({ dev: 1, ino: 9, size, mtimeMs: 1, nlink: 1, isSymlink: false, isDirectory: false, isFile: true });
const lnk: FileFacts = { dev: 1, ino: 9, size: 10, mtimeMs: 1, nlink: 1, isSymlink: true, isDirectory: false, isFile: false, linkTarget: '/x' };

async function setup(): Promise<{ t: Tree; m: CacheModel; selection: Selection }> {
  const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000) } } }] });
  const m = await t.scan();
  return { t, m, selection: { repos: [{ repoId: 'o/a', whole: false, groupKeys: [groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf')], unlockComponents: false }] } };
}
const unlinkOp = (t: Tree, rel: string, expect_: FileFacts, role: OpRole): Op =>
  ({ kind: 'unlink', path: join(t.lmstudioRoot, ...rel.split('/')), expect: expect_, role });
const lineFor = (rel: string, view: ViewImpactLine['view']): ViewImpactLine => ({ view, path: rel, action: 'remove' });
const reasonFor = (rel: string, folder: string): string =>
  `Recently Deleted can't hold ${rel} (a regular file in the ${folder} folder larger than 1 MiB) — use Delete Permanently`;
const notLinkReason = (rel: string, folder: string): string =>
  `Recently Deleted can't hold ${rel} (a regular file in the ${folder} folder, not a link) — use Delete Permanently`;
const notFileReason = (rel: string, folder: string): string =>
  `Recently Deleted can't hold ${rel} (not a regular file or link in the ${folder} folder) — use Delete Permanently`;
const dir: FileFacts = { ...reg(0), isFile: false, isDirectory: true };

describe('planDeletion: regular view files and the hold plan (before confirm)', () => {
  it('the shared limits are 1 MiB per file and 4 MiB in total', () => {
    expect([MAX_HELD_VIEW_FILE_BYTES, MAX_HELD_VIEW_TOTAL_BYTES]).toEqual([MIB, 4 * MIB]);
  });
  it('a regular view-blob or view-manifest of exactly 1 MiB and symlinks of any size keep the hold plan', async () => {
    const { t, m, selection } = await setup();
    const ops = [unlinkOp(t, 'blobs/sha256-a', reg(MIB), 'view-blob'), unlinkOp(t, 'manifests/big', reg(1), 'view-manifest'),
      unlinkOp(t, 'l1', { ...lnk, size: 5 * MIB }, 'view-blob'), unlinkOp(t, 'l2', lnk, 'view-link')];
    const pair = await planDeletion({ model: m, selection, roots: t.roots, views: stubViews({ ops }), now: t.now });
    expect(pair.hold).not.toBeNull();
    expect(pair.holdUnavailableReason).toBeNull();
  });
  it('a regular view-manifest over 1 MiB (even 50 MiB) refuses the hold', async () => {
    const { t, m, selection } = await setup();
    for (const size of [MIB + 1, 50 * MIB]) {
      const pair = await planDeletion({
        model: m, selection, roots: t.roots, now: t.now,
        views: stubViews({ ops: [unlinkOp(t, 'manifests/big', reg(size), 'view-manifest')], lines: [lineFor('manifests/big', 'ollama')] }),
      });
      expect(pair.hold).toBeNull();
      expect(pair.holdUnavailableReason).toBe(reasonFor('manifests/big', 'Ollama'));
    }
  });
  it('a directory (non-file, non-symlink) view-blob or view-manifest refuses the hold as not a regular file or link', async () => {
    const { t, m, selection } = await setup();
    for (const role of ['view-blob', 'view-manifest'] as const) {
      const pair = await planDeletion({
        model: m, selection, roots: t.roots, now: t.now,
        views: stubViews({ ops: [unlinkOp(t, 'd', dir, role)], lines: [lineFor('d', 'ollama')] }),
      });
      expect(pair.hold).toBeNull();
      expect(pair.holdUnavailableReason).toBe(notFileReason('d', 'Ollama'));
    }
  });
  it('more than 4 MiB of view data in total refuses the hold; exactly 4 MiB keeps it', async () => {
    const { t, m, selection } = await setup();
    const mk = (sizes: number[]): Op[] => sizes.map((n, i) => unlinkOp(t, `b${i}`, reg(n), 'view-blob'));
    const lines = [lineFor('b0', 'lmstudio'), lineFor('x', 'lmstudio')];
    // base64 of 786432 bytes is exactly 1 MiB: four of them (as 3 blobs + a manifest) make 4 MiB
    // a view-manifest counts at 6 bytes per byte (worst-case \\uXXXX escaping): 174762 bytes = 1048572
    const exact = [...mk([786432, 786432, 786432]), unlinkOp(t, 'mf', reg(174762), 'view-manifest')];
    const keep = await planDeletion({ model: m, selection, roots: t.roots, now: t.now, views: stubViews({ ops: exact, lines }) });
    expect(keep.hold).not.toBeNull();
    const over = [...mk([786432, 786432, 786432]), unlinkOp(t, 'mf', reg(174762), 'view-manifest'), unlinkOp(t, 'x', reg(4), 'view-blob')];
    const pair = await planDeletion({ model: m, selection, roots: t.roots, now: t.now, views: stubViews({ ops: over, lines }) });
    expect(pair.hold).toBeNull();
    expect(pair.holdUnavailableReason).toBe("Recently Deleted can't hold this many LM Studio files (over 4 MiB of view data) — use Delete Permanently");
    const generic = await planDeletion({ model: m, selection, roots: t.roots, now: t.now, views: stubViews({ ops: over }) });
    expect(generic.holdUnavailableReason).toBe("Recently Deleted can't hold this many view files (over 4 MiB of view data) — use Delete Permanently");
  });
  it('a 1 MiB view-manifest is refused by the total (control characters escape to 6 bytes), a normal one is held', async () => {
    const { t, m, selection } = await setup();
    const lines = [lineFor('manifests/big', 'ollama')];
    const big = await planDeletion({ model: m, selection, roots: t.roots, now: t.now,
      views: stubViews({ ops: [unlinkOp(t, 'manifests/big', reg(MIB), 'view-manifest')], lines }) });
    expect(big.hold).toBeNull();
    expect(big.holdUnavailableReason).toBe("Recently Deleted can't hold this many Ollama files (over 4 MiB of view data) — use Delete Permanently");
    const normal = await planDeletion({ model: m, selection, roots: t.roots, now: t.now,
      views: stubViews({ ops: [unlinkOp(t, 'manifests/ok', reg(1200), 'view-manifest')], lines }) });
    expect(normal.hold).not.toBeNull();
  });
  it('a regular view-blob over 1 MiB gives hold null with the exact reason; the permanent plan is unchanged', async () => {
    const { t, m, selection } = await setup();
    const ops = [unlinkOp(t, 'blobs/sha256-a', reg(MIB + 1), 'view-blob')];
    const lines = [lineFor('blobs/sha256-a', 'ollama')];
    const pair = await planDeletion({ model: m, selection, roots: t.roots, views: stubViews({ ops, lines }), now: t.now });
    expect(pair.hold).toBeNull();
    expect(pair.holdUnavailableReason).toBe(reasonFor('blobs/sha256-a', 'Ollama'));
    expect(pair.permanent.ops.slice(0, 1)).toEqual(ops);
    expect(pair.permanent.mode).toBe('permanent');
  });
  it('a regular view-link also refuses the hold, naming LM Studio and saying "not a link"', async () => {
    const { t, m, selection } = await setup();
    const pair = await planDeletion({
      model: m, selection, roots: t.roots, now: t.now,
      views: stubViews({ ops: [unlinkOp(t, 'o/a/copy.gguf', reg(10), 'view-link')], lines: [lineFor('o/a/copy.gguf', 'lmstudio')] }),
    });
    expect(pair.hold).toBeNull();
    expect(pair.holdUnavailableReason).toBe(notLinkReason('o/a/copy.gguf', 'LM Studio'));
  });
  it('without a matching impact line the folder is named generically', async () => {
    const { t, m, selection } = await setup();
    const pair = await planDeletion({
      model: m, selection, roots: t.roots, now: t.now, views: stubViews({ ops: [unlinkOp(t, 'x/y', reg(10), 'view-link')] }),
    });
    expect(pair.hold).toBeNull();
    expect(pair.holdUnavailableReason).toBe(notLinkReason('x/y', 'view'));
  });
});
