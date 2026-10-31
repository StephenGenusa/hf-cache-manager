import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ActionBar } from '../../src/renderer/components/ActionBar';
import { SHORTCUT_EVENT } from '../../src/renderer/lib/use-shortcuts';
import { useLibrary } from '../../src/renderer/lib/queries';
import { useSelection } from '../../src/renderer/state/selection';
import type { ApiResult, LibraryDTO, RepoDetailDTO, SelectionPreviewDTO } from '../../src/shared/api';
import { LIBRARY, QWEN_DETAIL, makeFakeApi, renderWithProviders } from './fake-api';

const selectedKeys = (): string[] => Object.values(useSelection.getState().byRepo).flatMap((v) => v.groupKeys);

beforeEach(() => {
  expect.hasAssertions();
  useSelection.getState().clear();
});

const QWEN = 'unsloth/Qwen3.6-27B-GGUF';
const select = (...keys: string[]) => act(() => { for (const k of keys) useSelection.getState().toggleGroup(QWEN, k, false); });
const preview = (over: Partial<SelectionPreviewDTO> = {}): ApiResult<SelectionPreviewDTO> =>
  ({ ok: true, data: { groupCount: 2, freedBytes: 82_500_000_000, viewLinksAffected: 1, warnings: [], ...over } });

test('action bar shows planner totals with exact copy', async () => {
  const api = makeFakeApi({ previewSelection: vi.fn(() => Promise.resolve(preview())) });
  select('quant:Q8_0', 'quant:BF16');
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />, api);
  await waitFor(() => expect(screen.getByTestId('action-bar')).toHaveTextContent(
    '2 groups selected · 82.5 GB would be freed · 1 LM Studio / Ollama links affected'));
  expect(screen.getByTestId('action-bar-freed')).toHaveAttribute('data-bytes', '82500000000');
  expect(api.previewSelection).toHaveBeenCalledTimes(1);
  expect(api.previewSelection).toHaveBeenCalledWith({
    repos: [{ repoId: QWEN, whole: false, groupKeys: ['quant:BF16', 'quant:Q8_0'], unlockComponents: false }],
  });
});

test('singular group wording', async () => {
  select('quant:Q8_0');
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />,
    makeFakeApi({ previewSelection: () => Promise.resolve(preview({ groupCount: 1, freedBytes: 5, viewLinksAffected: 0 })) }));
  await waitFor(() => expect(screen.getByTestId('action-bar')).toHaveTextContent('1 group selected · 5 B would be freed · 0 LM Studio / Ollama links affected'));
});

test('debounces 150 ms: rapid selection changes make one planner call', async () => {
  const api = makeFakeApi({ previewSelection: vi.fn(() => Promise.resolve(preview())) });
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />, api);
  select('quant:Q8_0');
  select('quant:BF16');
  select('quant:Q6_K');
  expect(api.previewSelection).not.toHaveBeenCalled();
  expect(screen.getByTestId('action-bar')).toHaveTextContent('calculating…');
  await waitFor(() => expect(api.previewSelection).toHaveBeenCalledTimes(1));
});

test('action bar ignores a slow stale preview response', async () => {
  let resolveFirst: (r: ApiResult<SelectionPreviewDTO>) => void = () => undefined;
  const first = new Promise<ApiResult<SelectionPreviewDTO>>((r) => { resolveFirst = r; });
  const prev = vi.fn()
    .mockImplementationOnce(() => first)
    .mockImplementationOnce(() => Promise.resolve(preview({ groupCount: 2, freedBytes: 2_000_000_000 })));
  select('quant:Q8_0');
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />, makeFakeApi({ previewSelection: prev }));
  await waitFor(() => expect(prev).toHaveBeenCalledTimes(1));
  select('quant:BF16');
  await waitFor(() => expect(screen.getByTestId('action-bar')).toHaveTextContent('2.0 GB would be freed'));
  await act(async () => { resolveFirst(preview({ groupCount: 1, freedBytes: 9_000_000_000 })); await first; });
  expect(screen.getByTestId('action-bar')).toHaveTextContent('2.0 GB would be freed');
  expect(screen.getByTestId('action-bar')).not.toHaveTextContent('9.0 GB');
});

test('a response arriving after the selection was cleared is ignored', async () => {
  let resolveIt: (r: ApiResult<SelectionPreviewDTO>) => void = () => undefined;
  const slow = new Promise<ApiResult<SelectionPreviewDTO>>((r) => { resolveIt = r; });
  select('quant:Q8_0');
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />, makeFakeApi({ previewSelection: () => slow }));
  await waitFor(() => expect(screen.getByTestId('action-bar')).toHaveTextContent('calculating…'));
  act(() => useSelection.getState().clear());
  await act(async () => { resolveIt(preview()); await slow; });
  expect(screen.getByTestId('action-bar')).toHaveTextContent('Nothing selected');
});

test('review button disabled with 0 groups and while calculating', async () => {
  const user = userEvent.setup();
  const onReview = vi.fn();
  renderWithProviders(<ActionBar onReview={onReview} onEmptyHeld={vi.fn()} />);
  expect(screen.getByTestId('btn-review')).toBeDisabled();
  let resolveIt: (r: ApiResult<SelectionPreviewDTO>) => void = () => undefined;
  const slow = new Promise<ApiResult<SelectionPreviewDTO>>((r) => { resolveIt = r; });
  const api = makeFakeApi({ previewSelection: () => slow });
  const { unmount } = renderWithProviders(<ActionBar onReview={onReview} onEmptyHeld={vi.fn()} />, api);
  select('quant:Q8_0');
  const bars = screen.getAllByTestId('btn-review');
  const pending = bars[bars.length - 1]!;
  expect(pending).toBeDisabled();
  await user.click(pending);
  expect(onReview).not.toHaveBeenCalled();
  await act(async () => { resolveIt(preview()); await slow; });
  await waitFor(() => expect(screen.getAllByTestId('btn-review')[1]).toBeEnabled());
  await user.click(screen.getAllByTestId('btn-review')[1]!);
  expect(onReview).toHaveBeenCalledWith({
    repos: [{ repoId: QWEN, whole: false, groupKeys: ['quant:Q8_0'], unlockComponents: false }],
  });
  unmount();
});

test('Ctrl+Backspace (review shortcut) opens review only with a selection', async () => {
  const onReview = vi.fn();
  renderWithProviders(<ActionBar onReview={onReview} onEmptyHeld={vi.fn()} />,
    makeFakeApi({ previewSelection: () => Promise.resolve(preview()) }));
  act(() => { window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: 'review' })); });
  expect(onReview).not.toHaveBeenCalled();
  select('quant:Q8_0');
  act(() => { window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: 'review' })); });
  expect(onReview).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  act(() => { window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: 'review' })); });
  expect(onReview).toHaveBeenCalledTimes(1);
});

test('the review shortcut is ignored while any dialog is open', async () => {
  const onReview = vi.fn();
  renderWithProviders(<ActionBar onReview={onReview} onEmptyHeld={vi.fn()} />,
    makeFakeApi({ previewSelection: () => Promise.resolve(preview()) }));
  select('quant:Q8_0');
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  const dlg = document.createElement('div');
  dlg.setAttribute('role', 'dialog');
  document.body.appendChild(dlg);
  act(() => { window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: 'review' })); });
  expect(onReview).not.toHaveBeenCalled();
  dlg.remove();
  act(() => { window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: 'review' })); });
  expect(onReview).toHaveBeenCalledTimes(1);
});

test('with no selection and held data: Recently Deleted holds … and Permanently Delete Recent Deletions', async () => {
  const user = userEvent.setup();
  const onEmpty = vi.fn();
  const lib = { ...LIBRARY, heldBytes: 12_300_000_000, heldCount: 2 };
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={onEmpty} />, makeFakeApi({ scan: () => Promise.resolve({ ok: true, data: lib }) }));
  expect(await screen.findByText('Recently Deleted holds 12.3 GB')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Permanently Delete Recent Deletions' }));
  expect(onEmpty).toHaveBeenCalledTimes(1);
});

test('nothing selected and nothing held', async () => {
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />);
  expect(screen.getByTestId('action-bar')).toHaveTextContent('Nothing selected');
  expect(screen.queryByRole('button', { name: 'Permanently Delete Recent Deletions' })).toBeNull();
});

test('planner warnings and errors are shown; review is disabled on error', async () => {
  select('quant:Q8_0');
  const { unmount } = renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />,
    makeFakeApi({ previewSelection: () => Promise.resolve(preview({ warnings: ['careful now'] })) }));
  expect(await screen.findByText('careful now')).toBeVisible();
  unmount();
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />,
    makeFakeApi({ previewSelection: () => Promise.resolve({ ok: false, error: { code: 'INVALID_INPUT', message: 'nope' } }) }));
  expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  expect(screen.getByTestId('btn-review')).toBeDisabled();
});

test('selection is dropped and review disabled when the cache is unreadable', async () => {
  select('quant:Q8_0');
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />, makeFakeApi({
    scan: () => Promise.resolve({ ok: true, data: { ...LIBRARY, scanError: 'EACCES' } }),
    previewSelection: () => Promise.resolve(preview()),
  }));
  await waitFor(() => expect(useSelection.getState().toSelection()).toBeNull());
  expect(screen.getByTestId('btn-review')).toBeDisabled();
});

function Rescanner() {
  const lib = useLibrary();
  return <button type="button" onClick={() => void lib.refetch()}>refetch</button>;
}

interface Live { lib: LibraryDTO; detail: RepoDetailDTO; scans: number; detailGate: Promise<void> | null }
function liveApi(): { live: Live; api: ReturnType<typeof makeFakeApi> } {
  const live: Live = { lib: LIBRARY, detail: QWEN_DETAIL, scans: 0, detailGate: null };
  const api = makeFakeApi({
    scan: () => { live.scans++; return Promise.resolve({ ok: true, data: { ...live.lib, scannedAt: 5_000 + live.scans } }); },
    repoDetail: async () => { if (live.detailGate) await live.detailGate; return { ok: true, data: live.detail }; },
    previewSelection: () => Promise.resolve(preview()),
  });
  return { live, api };
}
const refetch = async (user: ReturnType<typeof userEvent.setup>, live: Live) => {
  const before = live.scans;
  await user.click(screen.getByRole('button', { name: 'refetch' }));
  await waitFor(() => expect(live.scans).toBe(before + 1));
};
const mountBar = (api: ReturnType<typeof makeFakeApi>) =>
  renderWithProviders(<><Rescanner /><ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} /></>, api);

test('a refresh that removes a group drops it from the selection', async () => {
  const user = userEvent.setup();
  const { live, api } = liveApi();
  select('quant:Q8_0', 'quant:BF16');
  mountBar(api);
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  expect(selectedKeys()).toEqual(['quant:Q8_0', 'quant:BF16']);
  live.detail = { ...QWEN_DETAIL, groups: QWEN_DETAIL.groups.filter((g) => g.key !== 'quant:Q8_0') };
  await refetch(user, live);
  await waitFor(() => expect(selectedKeys()).toEqual(['quant:BF16']));
});

test('a refresh that removes the repo drops it silently', async () => {
  const user = userEvent.setup();
  const { live, api } = liveApi();
  select('quant:Q8_0');
  mountBar(api);
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  expect(selectedKeys()).toEqual(['quant:Q8_0']);
  live.lib = { ...LIBRARY, repos: LIBRARY.repos.filter((r) => r.repoId !== QWEN) };
  await refetch(user, live);
  await waitFor(() => expect(useSelection.getState().toSelection()).toBeNull());
});

test('a repo that becomes ambiguous after a rescan is dropped before the detail re-fetch returns', async () => {
  const user = userEvent.setup();
  const { live, api } = liveApi();
  select('quant:Q8_0');
  mountBar(api);
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  live.detailGate = new Promise<void>(() => undefined);
  live.lib = { ...LIBRARY, repos: LIBRARY.repos.map((r) => (r.repoId === QWEN ? { ...r, ambiguous: true } : r)) };
  await refetch(user, live);
  await waitFor(() => expect(useSelection.getState().toSelection()).toBeNull());
});

test('a repo whose id is unselectable is dropped on refresh', async () => {
  const user = userEvent.setup();
  const { live, api } = liveApi();
  act(() => useSelection.getState().toggleGroup('a/b/c', 'quant:Q8_0', false));
  live.lib = { ...LIBRARY, repos: [...LIBRARY.repos, { ...LIBRARY.repos[0]!, repoId: 'a/b/c' }] };
  mountBar(api);
  await waitFor(() => expect(useSelection.getState().toSelection()).toBeNull());
  void user;
});

test('Review is disabled while the reconcile after a refresh is pending', async () => {
  const user = userEvent.setup();
  const { live, api } = liveApi();
  select('quant:Q8_0');
  mountBar(api);
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  let release: () => void = () => undefined;
  live.detailGate = new Promise<void>((r) => { release = r; });
  await refetch(user, live);
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeDisabled());
  await act(async () => { release(); await live.detailGate; });
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  expect(selectedKeys()).toEqual(['quant:Q8_0']);
});

test('a selected repo whose detail cannot be fetched is dropped rather than sent', async () => {
  select('quant:Q8_0');
  const api = makeFakeApi({ repoDetail: () => Promise.resolve({ ok: false, error: { code: 'NOT_FOUND', message: 'x' } }) });
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />, api);
  await waitFor(() => expect(useSelection.getState().toSelection()).toBeNull());
});
