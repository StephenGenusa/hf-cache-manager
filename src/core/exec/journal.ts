// Append-only operation journal: <dir>/journal.jsonl in the app-data dir, one JSON record per line.
// Each record is its own open (append, no symlink following: see openChecked) → write → datasync → close, so a crash loses at most the record
// being written; a torn tail is skipped on read and the next record starts on a fresh line. Never rewritten.
import { constants } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { DeleteMode, DeletionPlan, ExecResult, FileFacts, Op } from '../types';
import { ExecError } from './errors';
import { DEFAULT_NOFOLLOW, openChecked } from './lock';

export const JOURNAL_FILE = 'journal.jsonl';
const MODES: readonly string[] = ['hold', 'permanent'] satisfies DeleteMode[];
const PURPOSES: readonly string[] = ['delete', 'restore', 'empty'] satisfies Array<DeletionPlan['purpose']>;

export interface IncompletePlan {
  planId: string;
  mode: DeleteMode;
  purpose: DeletionPlan['purpose'];
  startedAt: number;
  opsStarted: number;
  lastOp: Op | null;
}

const errno = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';

export class Journal {
  private readonly file: string;
  private readonly nofollow: number;
  private queue: Promise<unknown> = Promise.resolve();

  /** `opts.noFollowFlag` = 0 forces the lstat/fstat-only symlink check (the Windows path; tests use it on POSIX). */
  constructor(dir: string, private readonly now: () => number = Date.now, opts: { noFollowFlag?: number } = {}) {
    if (!isAbsolute(dir)) throw new Error(`Journal dir must be absolute: ${dir}`);
    this.file = join(dir, JOURNAL_FILE);
    this.nofollow = opts.noFollowFlag ?? DEFAULT_NOFOLLOW;
  }

  begin(plan: DeletionPlan): Promise<void> {
    return this.append({
      t: 'begin', planId: plan.id, mode: plan.mode, purpose: plan.purpose, fingerprint: plan.fingerprint,
      hubRoot: plan.hubRoot, holdRoot: plan.holdRoot, deletionId: plan.deletionId, opCount: plan.ops.length,
    });
  }

  before(planId: string, index: number, op: Op): Promise<void> {
    return this.append({ t: 'op', planId, i: index, op, expect: (op as { expect?: FileFacts }).expect ?? null });
  }

  after(planId: string, index: number, outcome: { ok: boolean; note?: string; error?: string }): Promise<void> {
    return this.append({
      t: 'after', planId, i: index, ok: outcome.ok,
      ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
  }

  rollback(planId: string, index: number, ok: boolean, error?: string): Promise<void> {
    return this.append({ t: 'rollback', planId, i: index, ok, ...(error !== undefined ? { error } : {}) });
  }

  end(planId: string, result: ExecResult): Promise<void> {
    return this.append({ t: 'end', planId, result });
  }

  acknowledge(planId: string): Promise<void> {
    return this.append({ t: 'ack', planId });
  }

  /** Plans with a `begin` but neither an `end` nor an `ack`, in begin order. */
  async incompletePlans(): Promise<IncompletePlan[]> {
    await this.queue.catch(() => undefined);
    const text = await this.read();
    const open = new Map<string, IncompletePlan>();
    for (const line of text.split('\n')) {
      const r = parse(line);
      if (!r) continue;
      if (r.t === 'begin') {
        if (typeof r.mode !== 'string' || !MODES.includes(r.mode)) continue;
        if (typeof r.purpose !== 'string' || !PURPOSES.includes(r.purpose)) continue;
        if (typeof r.at !== 'number') continue;
        open.delete(r.planId); // re-insert so order follows the latest begin
        open.set(r.planId, {
          planId: r.planId, mode: r.mode as DeleteMode, purpose: r.purpose as DeletionPlan['purpose'],
          startedAt: r.at, opsStarted: 0, lastOp: null,
        });
      } else if (r.t === 'op') {
        const p = open.get(r.planId);
        if (p && r.op && typeof r.op === 'object') {
          p.opsStarted++;
          p.lastOp = r.op as Op;
        }
      } else if (r.t === 'end' || r.t === 'ack') {
        open.delete(r.planId);
      }
    }
    return [...open.values()];
  }

  private async read(): Promise<string> {
    let fh;
    try {
      fh = await openChecked(this.file, constants.O_RDONLY, undefined, this.nofollow);
    } catch (e) {
      if (errno(e) === 'ENOENT') return '';
      throw new ExecError('IO', `Could not read the operation journal: ${errno(e)}`, this.file);
    }
    try {
      return await fh.readFile('utf8');
    } catch (e) {
      throw new ExecError('IO', `Could not read the operation journal: ${errno(e)}`, this.file);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  private append(rec: Record<string, unknown> & { t: string; planId: string }): Promise<void> {
    const line = `${JSON.stringify({ ...rec, at: this.now() })}\n`;
    const run = this.queue.catch(() => undefined).then(() => this.write(line));
    this.queue = run;
    return run;
  }

  private async write(line: string): Promise<void> {
    let fh;
    try {
      // 'a' plus read access (to see whether the tail is torn), never following a symlink at journal.jsonl.
      fh = await openChecked(this.file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, 0o644, this.nofollow);
    } catch (e) {
      throw new ExecError('IO', `Could not open the operation journal: ${errno(e)}`, this.file);
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new ExecError('IO', 'operation journal is not a regular file', this.file);
      let prefix = '';
      if (st.size > 0) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, st.size - 1);
        if (last[0] !== 0x0a) prefix = '\n'; // torn tail: start this record on its own line
      }
      await fh.write(prefix + line); // O_APPEND: always at the end; earlier bytes are never touched
      await fh.datasync();
    } catch (e) {
      if (e instanceof ExecError) throw e;
      throw new ExecError('IO', `Could not write the operation journal: ${errno(e)}`, this.file);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
}

function parse(line: string): (Record<string, unknown> & { t: string; planId: string }) | null {
  if (line.trim() === '') return null;
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return null; // torn or foreign line
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  if (typeof o.t !== 'string' || typeof o.planId !== 'string') return null;
  return o as Record<string, unknown> & { t: string; planId: string };
}
