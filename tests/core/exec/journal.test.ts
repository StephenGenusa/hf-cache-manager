import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Journal } from '../../../src/core/exec/journal';
import type { DeletionPlan, ExecResult, FileFacts, Op } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { buildTree, type Tree } from '../support/scenarios';

useCanaries();

let t: Tree | null = null;
afterEach(async () => {
  await t?.dispose();
  t = null;
});
const tree = async (): Promise<Tree> => (t = await buildTree({ repos: [] }));

const facts: FileFacts = { dev: 1, ino: 2, size: 3, mtimeMs: 4, nlink: 1, isSymlink: false, isDirectory: false, isFile: true };
const op: Op = { kind: 'unlink', path: '/x/hub/models--a--b/blobs/abc', expect: facts, role: 'repo-blob' };
const op2: Op = { kind: 'rmdir-empty', path: '/x/hub/models--a--b/blobs' };

function plan(id: string, over: Partial<DeletionPlan> = {}): DeletionPlan {
  return {
    id, fingerprint: 'f'.repeat(64), mode: 'permanent', purpose: 'delete', hubRoot: '/x/hub', holdRoot: null,
    deletionId: null, createdAt: 1, expiresAt: 600_001, selection: null, ops: [op, op2],
    freed: { bytes: 3, lines: [] }, apparentBytes: 3, kept: [], viewImpact: [], warnings: [], confirmPhrase: 'a/b',
    ...over,
  };
}
const result = (planId: string): ExecResult => ({
  ok: true, planId, appliedOps: 2, freedBytesPlanned: 3, heldBytes: 0, diskFreeBefore: 10, diskFreeAfter: 13,
});
const clock = (): (() => number) => {
  let n = 1_000;
  return () => n++;
};
const readLines = async (dir: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, 'journal.jsonl'), 'utf8')).trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('Journal', () => {
  it('constructor refuses a relative dir', () => {
    expect(() => new Journal('app-data')).toThrow();
  });

  it('inv7: begin, before, after, end are appended as JSON lines in that order', async () => {
    const tr = await tree();
    const dir = tr.appData;
    const j = new Journal(dir, clock());
    await j.begin(plan('P'));
    await j.before('P', 0, op);
    await j.after('P', 0, { ok: true, note: 'n' });
    await j.end('P', result('P'));
    const lines = await readLines(dir);
    expect(lines.map((l) => l.t)).toEqual(['begin', 'op', 'after', 'end']);
    expect(lines[0]).toMatchObject({ t: 'begin', planId: 'P', mode: 'permanent', purpose: 'delete', at: 1_000 });
    expect(lines[1]).toMatchObject({ planId: 'P', i: 0, op, expect: op.expect });
    expect(lines[1]).toEqual({ t: 'op', planId: 'P', i: 0, op, expect: op.expect, at: 1_001 });
    expect(lines[2]).toEqual({ t: 'after', planId: 'P', i: 0, ok: true, note: 'n', at: 1_002 });
    expect(lines[3]).toEqual({ t: 'end', planId: 'P', result: result('P'), at: 1_003 });
  });

  it('an op without expect is journalled with expect: null; rollback is recorded', async () => {
    const tr = await tree();
    const j = new Journal(tr.appData, clock());
    await j.begin(plan('P'));
    await j.before('P', 1, op2);
    await j.after('P', 1, { ok: false, error: 'EIO' });
    await j.rollback('P', 0, false, 'EBUSY');
    const lines = await readLines(tr.appData);
    expect(lines[1]).toMatchObject({ t: 'op', i: 1, op: op2, expect: null });
    expect(lines[2]).toEqual({ t: 'after', planId: 'P', i: 1, ok: false, error: 'EIO', at: 1_002 });
    expect(lines[3]).toEqual({ t: 'rollback', planId: 'P', i: 0, ok: false, error: 'EBUSY', at: 1_003 });
  });

  it('inv7: a plan with begin but no end is reported by incompletePlans until acknowledged', async () => {
    const tr = await tree();
    const j = new Journal(tr.appData, clock());
    expect(await j.incompletePlans()).toEqual([]);
    await j.begin(plan('DONE'));
    await j.end('DONE', result('DONE'));
    await j.begin(plan('P', { mode: 'hold', purpose: 'restore' }));
    await j.before('P', 0, op);
    await j.after('P', 0, { ok: true });
    await j.before('P', 1, op2);
    await j.begin(plan('Q'));
    const expected = [
      { planId: 'P', mode: 'hold', purpose: 'restore', startedAt: 1_002, opsStarted: 2, lastOp: op2 },
      { planId: 'Q', mode: 'permanent', purpose: 'delete', startedAt: 1_006, opsStarted: 0, lastOp: null },
    ];
    expect(await j.incompletePlans()).toEqual(expected);
    // a fresh instance (after restart) sees the same
    expect(await new Journal(tr.appData).incompletePlans()).toEqual(expected);
    await j.acknowledge('P');
    expect((await j.incompletePlans()).map((p) => p.planId)).toEqual(['Q']);
    await j.end('Q', result('Q'));
    expect(await j.incompletePlans()).toEqual([]);
  });

  it('a torn last line is ignored, and the next record starts on its own line', async () => {
    const tr = await tree();
    const j = new Journal(tr.appData, clock());
    await j.begin(plan('P'));
    await j.end('P', result('P'));
    const file = join(tr.appData, 'journal.jsonl');
    const good = await readFile(file, 'utf8');
    const torn = '{"t":"begin","planId":"T","mode":"perm';
    await tr.fs.writeFile(file, good + torn);
    expect(await j.incompletePlans()).toEqual([]);
    await j.begin(plan('R'));
    expect((await j.incompletePlans()).map((p) => p.planId)).toEqual(['R']);
    const text = await readFile(file, 'utf8');
    expect(text.startsWith(good + torn + '\n')).toBe(true);
  });

  it('journal is append-only: an existing file keeps its earlier bytes', async () => {
    const tr = await tree();
    const file = join(tr.appData, 'journal.jsonl');
    const earlier = '{"t":"note","planId":"old","at":1}\n';
    await tr.fs.writeFile(file, earlier);
    const j = new Journal(tr.appData, clock());
    await j.begin(plan('P'));
    await j.acknowledge('P');
    const text = await readFile(file, 'utf8');
    expect(text.startsWith(earlier)).toBe(true);
    expect(text.slice(earlier.length).trimEnd().split('\n').map((l) => (JSON.parse(l) as { t: string }).t)).toEqual(['begin', 'ack']);
  });

  it.each([['O_NOFOLLOW', undefined], ['lstat/fstat fallback', 0]] as const)(
    'a symlink at journal.jsonl is never written through or read (%s)', async (_label, noFollowFlag) => {
      const tr = await tree();
      const target = join(tr.root, 'victim.txt');
      const victim = '{"t":"begin","planId":"V","mode":"hold","purpose":"delete","at":1}\n';
      await tr.fs.writeFile(target, victim);
      await tr.fs.symlink(target, join(tr.appData, 'journal.jsonl'), 'file');
      const j = new Journal(tr.appData, clock(), { noFollowFlag });
      await expect(j.begin(plan('P'))).rejects.toMatchObject({ code: 'IO' });
      await expect(j.incompletePlans()).rejects.toMatchObject({ code: 'IO' });
      expect(await readFile(target, 'utf8')).toBe(victim);
    });

  it('the lstat/fstat fallback path still appends normally', async () => {
    const tr = await tree();
    const j = new Journal(tr.appData, clock(), { noFollowFlag: 0 });
    await j.begin(plan('P'));
    await j.before('P', 0, op);
    expect((await readLines(tr.appData)).map((l) => l.t)).toEqual(['begin', 'op']);
    expect((await j.incompletePlans()).map((p) => p.planId)).toEqual(['P']);
  });
});
