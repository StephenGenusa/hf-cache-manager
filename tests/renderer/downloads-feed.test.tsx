// The downloads feed's throttle, unsubscribe, error handling, relists and invalidations.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiProvider } from '../../src/renderer/lib/api';
import { queryKeys } from '../../src/renderer/lib/queries';
import { FLUSH_MS, useDownloadsFeed } from '../../src/renderer/lib/use-downloads-feed';
import { useDownloads } from '../../src/renderer/state/downloads';
import type { HfcmApi } from '../../src/shared/api';
import type { DownloadDoneDTO, DownloadItemDTO, DownloadProgressDTO } from '../../src/shared/api';
import { makeFakeApi } from './fake-api';

const item = (id = 'dl1'): DownloadItemDTO => ({
  id, repoId: 'org/model', type: 'model', revision: 'main', commit: 'a'.repeat(40),
  files: [{ path: 'm.gguf', size: 1000, state: 'downloading', bytes: 0, error: null }],
});
const ev = (bytes: number, id = 'dl1'): DownloadProgressDTO => ({ id, path: 'm.gguf', state: 'downloading', bytes, size: 1000, bytesPerSec: 10, error: null });

function Feed({ onDone }: { onDone: (d: DownloadDoneDTO) => void }) {
  useDownloadsFeed(onDone);
  return null;
}

interface Rig { push: (p: DownloadProgressDTO) => void; done: (d: DownloadDoneDTO) => void; client: QueryClient; unmount: () => void }
function mount(over: Partial<HfcmApi>, onDone: (d: DownloadDoneDTO) => void = () => undefined): Rig {
  const rig = { push: (_: DownloadProgressDTO) => undefined, done: (_: DownloadDoneDTO) => undefined } as Rig;
  const api = makeFakeApi({
    onDownloadProgress: (cb) => { rig.push = cb; return () => undefined; },
    onDownloadDone: (cb) => { rig.done = cb; return () => undefined; },
    ...over,
  });
  rig.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const r = render(<QueryClientProvider client={rig.client}><ApiProvider api={api}><Feed onDone={onDone} /></ApiProvider></QueryClientProvider>);
  rig.unmount = r.unmount;
  return rig;
}
const listing = (items: DownloadItemDTO[]) => vi.fn(() => Promise.resolve({ ok: true as const, data: { items, disabledReason: null, notes: [] } }));
const flushPromises = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  expect.hasAssertions();
  useDownloads.setState({ items: [], live: {}, disabledReason: null });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('progress reaches the store at most 4 times a second, the newest event per file', async () => {
  const batches: DownloadProgressDTO[][] = [];
  const apply = useDownloads.getState().applyProgress;
  useDownloads.setState({ applyProgress: (b) => { batches.push(b); apply(b); } });
  const rig = mount({ downloads: listing([item()]) });
  await flushPromises();
  for (let i = 1; i <= 10; i++) rig.push(ev(i * 10));
  expect(batches).toHaveLength(0);
  await act(async () => { vi.advanceTimersByTime(FLUSH_MS); });
  expect(batches).toEqual([[ev(100)]]);
  rig.push(ev(200));
  await act(async () => { vi.advanceTimersByTime(FLUSH_MS - 1); });
  expect(batches).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(batches).toEqual([[ev(100)], [ev(200)]]);
  expect(FLUSH_MS).toBe(250);
  rig.unmount();
});

test('unmount unsubscribes from both events and stops the timer', async () => {
  const offProgress = vi.fn();
  const offDone = vi.fn();
  const rig = mount({ onDownloadProgress: () => offProgress, onDownloadDone: () => offDone });
  await flushPromises();
  rig.unmount();
  expect(offProgress).toHaveBeenCalledTimes(1);
  expect(offDone).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('a downloads() call that rejects is handled (no unhandled rejection), and the store keeps what it had', async () => {
  useDownloads.setState({ items: [item('kept')] });
  const downloads = vi.fn(() => Promise.reject(new Error('IPC gone')));
  const rig = mount({ downloads });
  await flushPromises();
  rig.push(ev(5, 'unknown'));
  await act(async () => { vi.advanceTimersByTime(FLUSH_MS); });
  await flushPromises();
  expect(downloads.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(useDownloads.getState().items.map((i) => i.id)).toEqual(['kept']);
  rig.unmount();
});

test('late events for a download no longer listed (cancelled) relist once, not on every flush', async () => {
  const downloads = listing([]);
  const rig = mount({ downloads });
  await flushPromises();
  expect(downloads).toHaveBeenCalledTimes(1);   // at mount
  for (let i = 0; i < 5; i++) {
    rig.push(ev(i, 'gone'));
    await act(async () => { vi.advanceTimersByTime(FLUSH_MS); });
    await flushPromises();
  }
  expect(downloads).toHaveBeenCalledTimes(2);
  // a new download is still picked up
  rig.push(ev(1, 'fresh'));
  await act(async () => { vi.advanceTimersByTime(FLUSH_MS); });
  await flushPromises();
  expect(downloads).toHaveBeenCalledTimes(3);
  rig.unmount();
});

test('downloadDone relists and invalidates the library, repo, advice and disk queries, then calls onDone', async () => {
  const onDone = vi.fn();
  const downloads = listing([]);
  const rig = mount({ downloads }, onDone);
  const spy = vi.spyOn(rig.client, 'invalidateQueries');
  await flushPromises();
  act(() => rig.done({ id: 'dl1', repoId: 'org/model', type: 'model' }));
  expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([queryKeys.library, ['repo'], ['advice'], queryKeys.disk]);
  expect(onDone).toHaveBeenCalledWith({ id: 'dl1', repoId: 'org/model', type: 'model' });
  expect(downloads).toHaveBeenCalledTimes(2);
  rig.unmount();
});
