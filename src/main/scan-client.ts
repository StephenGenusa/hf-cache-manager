import { Worker } from 'node:worker_threads';
import { SCAN_PHASES, type ScanProgressDTO } from '../shared/api';
import { runScanJob, type ScanMessage, type ScanOutput } from './scan-job';

export type ScanRunner = (hubRoot: string, onProgress: (p: ScanProgressDTO) => void, signal: AbortSignal) => Promise<ScanOutput>;
export interface WorkerLike {
  on(ev: 'message' | 'error' | 'exit', fn: (x: unknown) => void): void;
  terminate(): Promise<number>;
}

const abortError = (): Error => Object.assign(new Error('Scan cancelled'), { name: 'AbortError' });
const errText = (x: unknown): string => (x instanceof Error ? x.message : String(x));

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const PHASES: ReadonlySet<string> = new Set<string>(SCAN_PHASES);
const MALFORMED = 'scan worker sent a malformed message';

/** null: not a protocol message (ignored). Throws on a known type with a bad payload. */
function asMessage(x: unknown): ScanMessage | null {
  if (!isObj(x)) return null;
  const bad = (): never => { throw new Error(MALFORMED); };
  if (x.type === 'progress') {
    const p = x.p;
    if (!isObj(p) || typeof p.phase !== 'string' || !PHASES.has(p.phase) || typeof p.done !== 'number' || typeof p.total !== 'number') bad();
    return x as unknown as ScanMessage;
  }
  if (x.type === 'done') {
    const o = x.output;
    if (!isObj(o) || !isObj(o.model) || !Array.isArray(o.views)) bad();
    return x as unknown as ScanMessage;
  }
  if (x.type === 'error') {
    if (typeof x.message !== 'string') bad();
    return x as unknown as ScanMessage;
  }
  return null;
}

/**
 * Runs a scan in a worker. Settles exactly once: done resolves; an error message, a worker error, ANY exit before done
 * (a crash must surface as a scan error, never hang) or an abort rejects. The worker is terminated on every path.
 */
export function makeWorkerScanRunner(spawn: (hubRoot: string) => WorkerLike): ScanRunner {
  return (hubRoot, onProgress, signal) =>
    new Promise<ScanOutput>((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      let worker: WorkerLike;
      try {
        worker = spawn(hubRoot);
      } catch (e) {
        return reject(e instanceof Error ? e : new Error(String(e)));
      }
      let settled = false;
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        act();
        worker.terminate().catch(() => undefined);
      };
      const fail = (err: Error) => finish(() => reject(err));
      const onAbort = (): void => fail(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (x) => {
        if (settled) return;
        try {
          const m = asMessage(x);
          if (m === null) return;
          if (m.type === 'progress') onProgress(m.p);
          else if (m.type === 'done') finish(() => resolve(m.output));
          else fail(new Error(m.message));
        } catch (e) {
          fail(e instanceof Error ? e : new Error(errText(e)));
        }
      });
      worker.on('error', (x) => fail(x instanceof Error ? x : new Error(errText(x))));
      worker.on('exit', (code) =>
        fail(new Error(code === 0 ? 'The scan worker stopped before finishing' : `The scan worker exited with code ${String(code)} before finishing`)));
    });
}

/** Production runner. The worker is a second main-build entry (`scan-worker`), emitted beside the main bundle. */
export const runScanInWorker: ScanRunner = makeWorkerScanRunner(
  (hubRoot) => new Worker(new URL('./scan-worker.js', import.meta.url), { workerData: { hubRoot } }),
);

/** Tests only: the same job on the calling thread. Abort is honoured at every progress step and rejects at once. */
export const inProcessScanRunner: ScanRunner = async (hubRoot, onProgress, signal) => {
  if (signal.aborted) throw abortError();
  let result: ScanOutput | null = null;
  let failure: string | null = null;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([
      aborted,
      runScanJob(hubRoot, (m) => {
        if (signal.aborted) return;
        if (m.type === 'progress') onProgress(m.p);
        else if (m.type === 'done') result = m.output;
        else failure = m.message;
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (failure !== null) throw new Error(failure);
  return result!;
};
