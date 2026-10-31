// The Recently Deleted view, its auto-empty select and its wiring in the App shell.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { RecentlyDeletedView } from '../../src/renderer/components/RecentlyDeletedView';
import { ReviewDialog } from '../../src/renderer/components/ReviewDialog';
import { resetToasts, Toaster } from '../../src/renderer/components/ui/toast';
import type { ApiResult, EmptyTarget, ExecResultDTO, HeldDeletionDTO, HeldListDTO, HfcmApi } from '../../src/shared/api';
import { makeFakeApi, renderWithProviders } from './fake-api';
import { emptyBatch, execResult, restorePlan, Q, SEL, qwenPair } from './review-fixtures';

beforeEach(() => {
  expect.hasAssertions();
  resetToasts();
});

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const ID1 = '20261025T140307Z-1a2b3c4d';
const ID2 = '20261026T090000Z-5e6f7a8b';
const row = (over: Partial<HeldDeletionDTO> = {}): HeldDeletionDTO => ({
  deletionId: ID1, status: 'held', error: null, repoIds: [Q], groupLabels: ['Q8_0', 'BF16'], bytes: 82_500_000_000,
  heldAtMs: Date.now() - 3 * 86_400_000, otherEntries: 0, pendingAutoEmpty: false, ...over,
});
const held = (items: HeldDeletionDTO[], over: Partial<HeldListDTO> = {}): HeldListDTO => ({
  available: true, unavailableReason: null, totalBytes: items.reduce((a, i) => a + i.bytes, 0), items, autoEmptyDays: 14, autoEmptyAt: null, ...over,
});

function setup(list: HeldListDTO, over: Partial<HfcmApi> = {}) {
  const api = makeFakeApi({ listHeld: vi.fn(() => Promise.resolve(ok(list))), ...over });
  const onReview = vi.fn();
  renderWithProviders(<RecentlyDeletedView onReview={onReview} />, api);
  return { api, onReview, user: userEvent.setup() };
}

test('held rows show repo, groups, size, age and the header total', async () => {
  setup(held([row(), row({ deletionId: ID2, repoIds: ['a/b'], groupLabels: ['x'], bytes: 1_000 })]));
  const rows = await screen.findAllByTestId('held-row');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveAttribute('data-deletion-id', ID1);
  expect(within(rows[0]!).getByText(Q)).toBeVisible();
  expect(within(rows[0]!).getByText('Q8_0 · BF16')).toBeVisible();
  expect(within(rows[0]!).getByText(/82\.5 GB · 3 days ago/)).toBeVisible();
  expect(screen.getByTestId('held-total')).toHaveTextContent('82.5 GB held');
  expect(within(rows[0]!).getByRole('button', { name: 'Delete Permanently' })).toBeVisible();
});

test('Restore plans the restore and hands the review a replan closure', async () => {
  const plan = restorePlan();
  const planRestore = vi.fn(() => Promise.resolve(ok(plan)));
  const r = setup(held([row()]), { planRestore });
  await r.user.click(await screen.findByTestId('btn-restore'));
  await waitFor(() => expect(r.onReview).toHaveBeenCalledTimes(1));
  expect(planRestore).toHaveBeenCalledWith(ID1);
  expect(r.onReview.mock.calls[0]![0]).toEqual({ kind: 'restore', plan });
  const replan = r.onReview.mock.calls[0]![1] as () => Promise<unknown>;
  expect(await replan()).toEqual({ kind: 'restore', plan });
  expect(planRestore).toHaveBeenCalledTimes(2);
});

test('empty all and per-item delete call planEmpty with the right target', async () => {
  const planEmpty = vi.fn((_t: EmptyTarget) => Promise.resolve(ok(emptyBatch(1))));
  const r = setup(held([row()]), { planEmpty });
  await r.user.click(await screen.findByTestId('btn-held-delete'));
  await waitFor(() => expect(r.onReview).toHaveBeenCalledTimes(1));
  expect(planEmpty).toHaveBeenLastCalledWith({ deletionId: ID1 });
  expect(r.onReview.mock.calls[0]![0]).toMatchObject({ kind: 'empty' });
  await r.user.click(screen.getByTestId('btn-empty-all'));
  await waitFor(() => expect(planEmpty).toHaveBeenLastCalledWith({ all: true }));
});

test('a planning failure is shown in the view and nothing opens', async () => {
  const planRestore = vi.fn(() => Promise.resolve<ApiResult<never>>({ ok: false, error: { code: 'NOT_FOUND', message: 'That deletion is gone.' } }));
  const r = setup(held([row()]), { planRestore });
  await r.user.click(await screen.findByTestId('btn-restore'));
  expect(await screen.findByText('That deletion is gone.')).toBeVisible();
  expect(r.onReview).not.toHaveBeenCalled();
});

test('INTERNAL planning errors show a generic message with a details toggle', async () => {
  const planRestore = vi.fn(() => Promise.reject(new Error('EIO: secret detail')));
  const r = setup(held([row()]), { planRestore });
  await r.user.click(await screen.findByTestId('btn-restore'));
  const note = await screen.findByTestId('held-error');
  expect(note).toHaveTextContent('Something went wrong inside the app.');
  expect(note).not.toHaveTextContent('secret detail');
  await r.user.click(within(note).getByRole('button', { name: 'Details' }));
  expect(screen.getByTestId('held-error-details')).toHaveTextContent('EIO: secret detail');
});

test('auto-empty select offers 7/14/30/Never and maps Never to null', async () => {
  const setAutoEmptyDays = vi.fn((_d: number | null) => Promise.resolve(ok(null)));
  const r = setup(held([row()]), { setAutoEmptyDays });
  const sel = await screen.findByTestId('auto-empty-select');
  expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['After 7 days', 'After 14 days', 'After 30 days', 'Never']);
  expect(sel).toHaveValue('14');
  expect(screen.getByTestId('auto-empty-label')).toHaveTextContent('Auto-empty: after 14 days');
  await r.user.selectOptions(sel, 'Never');
  expect(setAutoEmptyDays).toHaveBeenLastCalledWith(null);
  await r.user.selectOptions(sel, 'After 30 days');
  expect(setAutoEmptyDays).toHaveBeenLastCalledWith(30);
});

test('Never is shown when auto-empty is off, and a failed save is reported', async () => {
  const setAutoEmptyDays = vi.fn(() => Promise.resolve<ApiResult<null>>({ ok: false, error: { code: 'IO', message: 'disk full' } }));
  const r = setup(held([row()], { autoEmptyDays: null }), { setAutoEmptyDays });
  const sel = await screen.findByTestId('auto-empty-select');
  expect(sel).toHaveValue('never');
  expect(screen.getByTestId('auto-empty-label')).toHaveTextContent('Auto-empty: never');
  await r.user.selectOptions(sel, 'After 7 days');
  expect(await screen.findByTestId('auto-empty-error')).toHaveTextContent('disk full');
});

test('unavailable hold shows the reason and no actions', async () => {
  setup(held([], { available: false, unavailableReason: 'Recently Deleted is not available: the cache is on a drive that cannot hold it.' }));
  expect((await screen.findAllByText(/cannot hold it/)).length).toBeGreaterThan(0);
  expect(screen.getByTestId('held-unavailable')).toHaveTextContent('cannot hold it');
  expect(screen.queryByTestId('btn-empty-all')).toBeNull();
  expect(screen.queryByTestId('btn-restore')).toBeNull();
  expect(screen.getByTestId('auto-empty-label')).toHaveTextContent('Auto-empty: off: Recently Deleted is not available');
});

test('empty state', async () => {
  setup(held([]));
  expect(await screen.findByText('Nothing in Recently Deleted.')).toBeVisible();
  expect(screen.getByTestId('btn-empty-all')).toBeDisabled();
});

test('each status offers exactly its actions', async () => {
  setup(held([
    row({ deletionId: 'a', status: 'partial' }),
    row({ deletionId: 'b', status: 'interrupted' }),
    row({ deletionId: 'c', status: 'leftover', repoIds: [], groupLabels: [] }),
    row({ deletionId: 'd', status: 'corrupt', error: 'manifest.json is not valid JSON', bytes: 0, heldAtMs: 0 }),
  ]));
  await screen.findAllByTestId('held-row');
  const r = (id: string) => document.querySelector<HTMLElement>(`[data-deletion-id="${id}"]`)!;
  expect(within(r('a')).queryByTestId('btn-restore')).not.toBeNull();
  expect(within(r('a')).queryByTestId('btn-held-delete')).not.toBeNull();
  expect(within(r('b')).queryByTestId('btn-restore')).not.toBeNull();
  expect(within(r('b')).queryByTestId('btn-held-delete')).toBeNull();
  expect(within(r('b')).getByText('A move into Recently Deleted did not finish. Restore it to recover the files.')).toBeVisible();
  expect(within(r('c')).queryByTestId('btn-restore')).toBeNull();
  expect(within(r('c')).queryByTestId('btn-held-delete')).not.toBeNull();
  expect(within(r('d')).queryByTestId('btn-restore')).toBeNull();
  expect(within(r('d')).queryByTestId('btn-held-delete')).toBeNull();
  expect(within(r('d')).getByText('manifest.json is not valid JSON')).toBeVisible();
  expect(screen.getByTestId('held-total')).toHaveTextContent('247.5 GB held'); // corrupt rows count 0
});

// ---- App wiring --------------------------------------------------------------------------------------------------

function app(list: HeldListDTO, over: Partial<HfcmApi> = {}) {
  const api = makeFakeApi({ listHeld: vi.fn(() => Promise.resolve(ok(list))), ...over });
  renderWithProviders(<Toaster><App /></Toaster>, api);
  return { api, user: userEvent.setup() };
}

test('the nav swaps the right pane between Recently Deleted, Settings and a repo', async () => {
  const r = app(held([row()]));
  await r.user.click(await screen.findByTestId('nav-recently-deleted'));
  expect(await screen.findByTestId('held-view')).toBeVisible();
  await r.user.click(screen.getByTestId('nav-settings'));
  expect(await screen.findByTestId('settings-view')).toBeVisible();
  expect(screen.queryByTestId('held-view')).toBeNull();
});

test('a restore review runs through the Review dialog and Review again re-plans the restore', async () => {
  const planRestore = vi.fn(() => Promise.resolve(ok(restorePlan())));
  const executePlan = vi.fn(() => Promise.resolve<ApiResult<ExecResultDTO>>({ ok: false, error: { code: 'STALE', message: 'stale' } }));
  const r = app(held([row()]), { planRestore, executePlan });
  await r.user.click(await screen.findByTestId('nav-recently-deleted'));
  await r.user.click(await screen.findByTestId('btn-restore'));
  await screen.findByTestId('review-dialog');
  await r.user.click(screen.getByTestId('btn-restore-confirm'));
  await r.user.click(await screen.findByTestId('btn-review-again'));
  await waitFor(() => expect(planRestore).toHaveBeenCalledTimes(2));
  await screen.findByTestId('review-dialog');
});

// ---- ReviewDialog: a throwing callback cannot wedge the dialog ---------------------------------------------

test('a throwing onDone is caught: the dialog shows a notice and is not left running', async () => {
  const api = makeFakeApi({ executePlan: vi.fn((planId: string, _f: string, mode: 'hold' | 'permanent') => Promise.resolve(ok(execResult({ planId, mode })))) });
  const pair = qwenPair();
  renderWithProviders(
    <ReviewDialog
      source={{ kind: 'delete', selection: SEL, pair }} onClose={() => undefined} onReviewAgain={() => undefined}
      onDone={() => { throw new Error('boom'); }}
    />, api);
  await userEvent.setup().click(screen.getByTestId('btn-hold'));
  expect(await screen.findByText(/could not show its result/)).toBeVisible();
  expect(screen.queryByTestId('spinner')).toBeNull();
  await act(async () => { await Promise.resolve(); });
});

test('a throwing onDone is logged, not swallowed silently', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const api = makeFakeApi({ executePlan: vi.fn((planId: string, _f: string, mode: 'hold' | 'permanent') => Promise.resolve(ok(execResult({ planId, mode })))) });
    renderWithProviders(
      <ReviewDialog source={{ kind: 'delete', selection: SEL, pair: qwenPair() }} onClose={() => undefined} onReviewAgain={() => undefined}
        onDone={() => { throw new Error('boom'); }} />, api);
    await userEvent.setup().click(screen.getByTestId('btn-hold'));
    await screen.findByText(/could not show its result/);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ReviewDialog'), expect.objectContaining({ message: 'boom' }));
  } finally {
    spy.mockRestore();
  }
});

test('a row in the announced auto-empty set is badged with the time it will be emptied', async () => {
  const at = new Date(2026, 9, 29, 14, 30).getTime();
  setup(held([row({ pendingAutoEmpty: true }), row({ deletionId: ID2 })], { autoEmptyAt: at }));
  const rows = await screen.findAllByTestId('held-row');
  expect(within(rows[0]!).getByTestId('held-auto-empty-badge')).toHaveTextContent(`will be emptied at ${new Date(at).toLocaleTimeString()}`);
  expect(within(rows[1]!).queryByTestId('held-auto-empty-badge')).toBeNull();
});

test('an announced row before the countdown starts says it will be emptied soon', async () => {
  setup(held([row({ pendingAutoEmpty: true })]));
  expect(await screen.findByTestId('held-auto-empty-badge')).toHaveTextContent('will be emptied automatically soon');
});

test('opening a review (restore or one deletion) refreshes the held list and the notices', async () => {
  const spy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
  try {
    const r = setup(held([row({ pendingAutoEmpty: true })], { autoEmptyAt: 1 }), {
      planRestore: vi.fn(() => Promise.resolve(ok(restorePlan()))),
      planEmpty: vi.fn(() => Promise.resolve(ok(emptyBatch(1)))),
    });
    const keys = (): unknown[] => spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);
    await r.user.click(await screen.findByTestId('btn-restore'));
    await waitFor(() => expect(r.onReview).toHaveBeenCalledTimes(1));
    expect(keys()).toEqual(expect.arrayContaining([['held'], ['notices']]));
    spy.mockClear();
    await r.user.click(screen.getByTestId('btn-held-delete'));
    await waitFor(() => expect(r.onReview).toHaveBeenCalledTimes(2));
    expect(keys()).toEqual(expect.arrayContaining([['held'], ['notices']]));
    spy.mockClear();
    await r.user.click(screen.getByTestId('btn-empty-all'));   // empty all withdraws nothing: no refresh needed
    await waitFor(() => expect(r.onReview).toHaveBeenCalledTimes(3));
    expect(keys()).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});
