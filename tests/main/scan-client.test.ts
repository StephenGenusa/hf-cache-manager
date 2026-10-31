import { EventEmitter } from 'node:events';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ScanProgressDTO } from '../../src/shared/api';
import { inProcessScanRunner, makeWorkerScanRunner, type WorkerLike } from '../../src/main/scan-client';
import type { ScanOutput } from '../../src/main/scan-job';
import { buildAppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';

useCanaries();
beforeEach(() => expect.hasAssertions());

interface FakeWorker extends WorkerLike {
  emit(ev: 'message' | 'error' | 'exit', x: unknown): void;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
}
function fakeWorker(): FakeWorker {
  const em = new EventEmitter();
  return {
    on: (ev, fn) => void em.on(ev, fn),
    emit: (ev, x) => void em.emit(ev, x),
    terminate: vi.fn(async () => 0),
  };
}
const OUT = { model: {}, views: [] } as unknown as ScanOutput;

test('forwards progress, resolves on done and terminates the worker', async () => {
  const w = fakeWorker();
  const seen: ScanProgressDTO[] = [];
  const p = makeWorkerScanRunner(() => w)('/tmp/h', (x) => seen.push(x), new AbortController().signal);
  w.emit('message', { type: 'progress', p: { phase: 'scan', done: 0, total: 1 } });
  w.emit('message', { type: 'done', output: OUT });
  await expect(p).resolves.toBe(OUT);
  expect(seen).toEqual([{ phase: 'scan', done: 0, total: 1 }]);
  expect(w.terminate).toHaveBeenCalledTimes(1);
  w.emit('exit', 0); // late events after settling are ignored
  expect(w.terminate).toHaveBeenCalledTimes(1);
});

test('passes the hub root to the spawner', async () => {
  const w = fakeWorker();
  const spawn = vi.fn((_hub: string) => w);
  const p = makeWorkerScanRunner(spawn)('/some/hub', () => {}, new AbortController().signal);
  w.emit('message', { type: 'done', output: OUT });
  await p;
  expect(spawn).toHaveBeenCalledWith('/some/hub');
});

test('abort terminates the worker and rejects with AbortError', async () => {
  const w = fakeWorker();
  const ac = new AbortController();
  const p = makeWorkerScanRunner(() => w)('/tmp/h', () => {}, ac.signal);
  ac.abort();
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  expect(w.terminate).toHaveBeenCalled();
});

test('an already-aborted signal rejects without spawning', async () => {
  const spawn = vi.fn(() => fakeWorker());
  const ac = new AbortController();
  ac.abort();
  await expect(makeWorkerScanRunner(spawn)('/tmp/h', () => {}, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(spawn).not.toHaveBeenCalled();
});

test('rejects on an error message from the job', async () => {
  const w = fakeWorker();
  const p = makeWorkerScanRunner(() => w)('/tmp/h', () => {}, new AbortController().signal);
  w.emit('message', { type: 'error', message: 'EACCES: denied' });
  await expect(p).rejects.toThrow('EACCES: denied');
  expect(w.terminate).toHaveBeenCalled();
});

test('rejects on a worker error event, with the error message', async () => {
  const w = fakeWorker();
  const p = makeWorkerScanRunner(() => w)('/tmp/h', () => {}, new AbortController().signal);
  w.emit('error', new Error('worker blew up'));
  await expect(p).rejects.toThrow('worker blew up');
  expect(w.terminate).toHaveBeenCalled();
});

test('a non-Error worker error is still reported', async () => {
  const w = fakeWorker();
  const p = makeWorkerScanRunner(() => w)('/tmp/h', () => {}, new AbortController().signal);
  w.emit('error', 'plain');
  await expect(p).rejects.toThrow('plain');
});

test.each([1, 137])('rejects on exit code %i before done (never hangs)', async (code) => {
  const w = fakeWorker();
  const p = makeWorkerScanRunner(() => w)('/tmp/h', () => {}, new AbortController().signal);
  w.emit('exit', code);
  await expect(p).rejects.toThrow(`exited with code ${code}`);
});

test('rejects on a zero exit before done as well', async () => {
  const w = fakeWorker();
  const p = makeWorkerScanRunner(() => w)('/tmp/h', () => {}, new AbortController().signal);
  w.emit('exit', 0);
  await expect(p).rejects.toThrow(/before finishing/);
});

test('a synchronous spawn failure rejects', async () => {
  const runner = makeWorkerScanRunner(() => { throw new Error('no worker file'); });
  await expect(runner('/tmp/h', () => {}, new AbortController().signal)).rejects.toThrow('no worker file');
});

test('malformed messages are ignored', async () => {
  const w = fakeWorker();
  const seen: ScanProgressDTO[] = [];
  const p = makeWorkerScanRunner(() => w)('/tmp/h', (x) => seen.push(x), new AbortController().signal);
  w.emit('message', null);
  w.emit('message', 'x');
  w.emit('message', { type: 'other' });
  w.emit('message', { type: 'done', output: OUT });
  await expect(p).resolves.toBe(OUT);
  expect(seen).toEqual([]);
});

test('terminate failure after settling does not become an unhandled rejection', async () => {
  const w = fakeWorker();
  w.terminate.mockRejectedValue(new Error('already gone'));
  const p = makeWorkerScanRunner(() => w)('/tmp/h', () => {}, new AbortController().signal);
  w.emit('message', { type: 'done', output: OUT });
  await expect(p).resolves.toBe(OUT);
});

test('inProcessScanRunner scans a real fixture and reports progress', async () => {
  const fx = await buildAppFixture();
  const seen: ScanProgressDTO[] = [];
  const out = await inProcessScanRunner(fx.hubRoot, (p) => seen.push(p), new AbortController().signal);
  expect(out.views).toHaveLength(7);
  expect(seen.at(-1)).toEqual({ phase: 'classify', done: 7, total: 7 });
});

test('inProcessScanRunner rejects on a job error and on abort', async () => {
  const fx = await buildAppFixture();
  await expect(inProcessScanRunner(`${fx.root}/nope`, () => {}, new AbortController().signal)).rejects.toThrow(/nope/);
  const ac = new AbortController();
  ac.abort();
  await expect(inProcessScanRunner(fx.hubRoot, () => {}, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

const MALFORMED = 'scan worker sent a malformed message';
const GOOD_DONE = { type: 'done', output: { model: { repos: [] }, views: [] } };
test.each([
  ['done without output', { type: 'done' }],
  ['done with a non-object output', { type: 'done', output: 5 }],
  ['done without a model', { type: 'done', output: { views: [] } }],
  ['done with null model', { type: 'done', output: { model: null, views: [] } }],
  ['done with views not an array', { type: 'done', output: { model: {}, views: {} } }],
  ['error without a message', { type: 'error' }],
  ['error with a non-string message', { type: 'error', message: 3 }],
  ['progress without p', { type: 'progress' }],
  ['progress with non-numeric counts', { type: 'progress', p: { phase: 'scan', done: 'a', total: 1 } }],
  ['progress with a null p', { type: 'progress', p: null }],
  ['progress with a bad phase', { type: 'progress', p: { phase: 7, done: 0, total: 1 } }],
])('%s rejects as malformed and terminates the worker', async (_n, msg) => {
  const w = fakeWorker();
  const seen: ScanProgressDTO[] = [];
  const p = makeWorkerScanRunner(() => w)('/tmp/h', (x) => seen.push(x), new AbortController().signal);
  w.emit('message', msg);
  await expect(p).rejects.toThrow(MALFORMED);
  expect(w.terminate).toHaveBeenCalled();
  expect(seen).toEqual([]);
});

test('a well-formed done is accepted', async () => {
  const w = fakeWorker();
  const p = makeWorkerScanRunner(() => w)('/tmp/h', () => {}, new AbortController().signal);
  w.emit('message', GOOD_DONE);
  await expect(p).resolves.toEqual(GOOD_DONE.output);
});

test('a late message after settling is ignored', async () => {
  const w = fakeWorker();
  const seen: ScanProgressDTO[] = [];
  const p = makeWorkerScanRunner(() => w)('/tmp/h', (x) => seen.push(x), new AbortController().signal);
  w.emit('message', { type: 'error', message: 'first' });
  w.emit('message', { type: 'progress', p: { phase: 'scan', done: 0, total: 1 } });
  w.emit('message', GOOD_DONE);
  await expect(p).rejects.toThrow('first');
  expect(seen).toEqual([]);
});

test('an onProgress that throws rejects the scan and terminates the worker', async () => {
  const w = fakeWorker();
  const p = makeWorkerScanRunner(() => w)('/tmp/h', () => { throw new Error('listener broke'); }, new AbortController().signal);
  w.emit('message', { type: 'progress', p: { phase: 'scan', done: 0, total: 1 } });
  await expect(p).rejects.toThrow('listener broke');
  expect(w.terminate).toHaveBeenCalled();
});

test('inProcessScanRunner honours an abort raised while scanning', async () => {
  const fx = await buildAppFixture();
  const ac = new AbortController();
  const seen: ScanProgressDTO[] = [];
  const p = inProcessScanRunner(fx.hubRoot, (x) => { seen.push(x); if (x.phase === 'classify' && x.done === 2) ac.abort(); }, ac.signal);
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  expect(seen.at(-1)).toEqual({ phase: 'classify', done: 2, total: 7 });
});
