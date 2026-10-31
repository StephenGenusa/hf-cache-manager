import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, expect, test } from 'vitest';
import { ApiCallError, ApiProvider, unwrap } from '../../src/renderer/lib/api';
import { useDiskInfo, useHeld, useLibrary, useRepoDetail, useScanProgress, useSettings } from '../../src/renderer/lib/queries';
import type { HfcmApi, ScanProgressDTO } from '../../src/shared/api';
import { LIBRARY, makeFakeApi, QWEN_DETAIL } from './fake-api';

beforeEach(() => expect.hasAssertions());

const wrapper = (api: HfcmApi) => ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ApiProvider api={api}>{children}</ApiProvider>
  </QueryClientProvider>
);

test('unwrap returns data and throws ApiCallError with the code and detailPath', () => {
  expect(unwrap({ ok: true, data: 5 })).toBe(5);
  try {
    unwrap({ ok: false, error: { code: 'LOCKED', message: 'busy', detailPath: '/ud/.lock' } });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiCallError);
    expect(e).toMatchObject({ code: 'LOCKED', message: 'busy', detailPath: '/ud/.lock', name: 'ApiCallError' });
  }
  expect(() => unwrap({ ok: false, error: { code: 'NOT_FOUND', message: 'x' } })).toThrow(expect.objectContaining({ detailPath: undefined }));
});

test('query hooks read through the injected api', async () => {
  const w = wrapper(makeFakeApi());
  const lib = renderHook(() => useLibrary(), { wrapper: w });
  await waitFor(() => expect(lib.result.current.data).toEqual(LIBRARY));
  const detail = renderHook(() => useRepoDetail('unsloth/Qwen3.6-27B-GGUF'), { wrapper: w });
  await waitFor(() => expect(detail.result.current.data).toEqual(QWEN_DETAIL));
  const held = renderHook(() => useHeld(), { wrapper: w });
  await waitFor(() => expect(held.result.current.data?.available).toBe(true));
  const settings = renderHook(() => useSettings(), { wrapper: w });
  await waitFor(() => expect(settings.result.current.data?.platform).toBe('linux'));
  const disk = renderHook(() => useDiskInfo(), { wrapper: w });
  await waitFor(() => expect(disk.result.current.data?.freeBytes).toBe(500_000_000_000));
});

test('useRepoDetail(null) does not call the api', () => {
  let calls = 0;
  const api = makeFakeApi({ repoDetail: () => { calls++; return Promise.reject(new Error('no')); } });
  const r = renderHook(() => useRepoDetail(null), { wrapper: wrapper(api) });
  expect(r.result.current.fetchStatus).toBe('idle');
  expect(calls).toBe(0);
});

test('a failed result becomes a query error carrying the code', async () => {
  const api = makeFakeApi({ scan: () => Promise.resolve({ ok: false, error: { code: 'HUB_MISSING', message: 'no hub' } }) });
  const r = renderHook(() => useLibrary(), { wrapper: wrapper(api) });
  await waitFor(() => expect(r.result.current.error).toBeInstanceOf(ApiCallError));
  expect(r.result.current.error).toMatchObject({ code: 'HUB_MISSING' });
});

test('useScanProgress follows the subscription and unsubscribes on unmount', () => {
  let push: (p: ScanProgressDTO) => void = () => undefined;
  let unsubscribed = false;
  const api = makeFakeApi({ onScanProgress: (cb) => { push = cb; return () => { unsubscribed = true; }; } });
  const r = renderHook(() => useScanProgress(), { wrapper: wrapper(api) });
  expect(r.result.current).toBeNull();
  act(() => push({ phase: 'scan', done: 3, total: 10 }));
  expect(r.result.current).toEqual({ phase: 'scan', done: 3, total: 10 });
  r.unmount();
  expect(unsubscribed).toBe(true);
});
