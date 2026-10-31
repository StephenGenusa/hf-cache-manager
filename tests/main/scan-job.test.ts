import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import type { ScanProgressDTO } from '../../src/shared/api';
import { runScanJob, type ScanMessage } from '../../src/main/scan-job';
import { buildAppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';
import { treeDigest } from '../helpers/tree-digest';

useCanaries();
beforeEach(() => expect.hasAssertions());

type Progress = Extract<ScanMessage, { type: 'progress' }>;
type Done = Extract<ScanMessage, { type: 'done' }>;
const progressOf = (msgs: ScanMessage[]): ScanProgressDTO[] => msgs.filter((m): m is Progress => m.type === 'progress').map((m) => m.p);

test('posts scan, per-repo classify progress, then done with a model and views', async () => {
  const fx = await buildAppFixture();
  const msgs: ScanMessage[] = [];
  await runScanJob(fx.hubRoot, (m) => msgs.push(m));
  const prog = progressOf(msgs);
  expect(prog[0]).toEqual({ phase: 'scan', done: 0, total: 1 });
  expect(prog[1]).toEqual({ phase: 'scan', done: 1, total: 1 });
  const classify = prog.filter((p) => p.phase === 'classify');
  expect(classify.map((p) => p.done)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(classify.at(-1)).toEqual({ phase: 'classify', done: 7, total: 7 });
  const done = msgs.at(-1) as Done;
  expect(done.type).toBe('done');
  expect(msgs.filter((m) => m.type === 'done')).toHaveLength(1);
  expect(done.output.views.map((v) => v.repoId).sort()).toEqual([
    'bartowski/tiny-GGUF', 'black-forest-labs/FLUX.1-dev', 'org/dupe', 'org/partial', 'org/shared-a', 'org/shared-b', 'unsloth/Qwen3.6-27B-GGUF',
  ]);
  expect(done.output.model.repos).toHaveLength(7);
});

test('scanning is read-only', async () => {
  const fx = await buildAppFixture();
  const before = await treeDigest(fx.root);
  await runScanJob(fx.hubRoot, () => {});
  expect(await treeDigest(fx.root)).toEqual(before);
});

test('a missing hub posts exactly one error, not an empty model', async () => {
  const fx = await buildAppFixture();
  const msgs: ScanMessage[] = [];
  await runScanJob(join(fx.root, 'nope'), (m) => msgs.push(m));
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ type: 'error', message: expect.stringContaining('nope') });
});

test('a scan failure other than a missing hub is posted as an error with its message', async () => {
  const fx = await buildAppFixture();
  const msgs: ScanMessage[] = [];
  await runScanJob(join(fx.hubRoot, 'blobs', '.huggingface-shared-blobs'), (m) => msgs.push(m)); // a file, not a directory
  expect(msgs.at(-1)).toMatchObject({ type: 'error' });
  expect(msgs.some((m) => m.type === 'done')).toBe(false);
});
