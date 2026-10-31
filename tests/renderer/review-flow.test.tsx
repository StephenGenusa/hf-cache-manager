// App wiring: Review → planDelete → ReviewDialog → executePlan → result toast + refresh; Review again re-plans.
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { resetToasts, Toaster } from '../../src/renderer/components/ui/toast';
import { useSessionLog } from '../../src/renderer/state/session-log';
import { useSelection } from '../../src/renderer/state/selection';
import type { ApiResult, HfcmApi, PlanPairDTO, SelectionPreviewDTO } from '../../src/shared/api';
import { LIBRARY, makeFakeApi, renderWithProviders } from './fake-api';
import { emptyBatch, execResult, Q, qwenPair } from './review-fixtures';

beforeEach(() => {
  expect.hasAssertions();
  useSelection.getState().clear();
  useSessionLog.getState().clear();
  resetToasts();
});

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const preview = (): Promise<ApiResult<SelectionPreviewDTO>> =>
  Promise.resolve(ok({ groupCount: 1, freedBytes: 8250, viewLinksAffected: 1, warnings: [] }));

function setup(over: Partial<HfcmApi> = {}) {
  const api = makeFakeApi({
    previewSelection: vi.fn(preview),
    planDelete: vi.fn(() => Promise.resolve(ok(qwenPair()))),
    executePlan: vi.fn((planId: string, _f: string, mode: 'hold' | 'permanent') => Promise.resolve(ok(execResult({ planId, mode, heldBytes: mode === 'hold' ? 8250 : 0 })))),
    scan: vi.fn(() => Promise.resolve(ok(LIBRARY))),
    ...over,
  });
  renderWithProviders(<Toaster><App /></Toaster>, api);
  return { api, user: userEvent.setup() };
}

async function openReview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  act(() => useSelection.getState().toggleGroup(Q, 'quant:Q8_0', false));
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  await user.click(screen.getByTestId('btn-review'));
  await screen.findByTestId('review-dialog');
}

test('Review deletion plans the selection and opens the review; nothing executes until a button is pressed', async () => {
  const { api, user } = setup();
  await openReview(user);
  expect(api.planDelete).toHaveBeenCalledWith({ repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q8_0'], unlockComponents: false }] });
  expect(api.executePlan).not.toHaveBeenCalled();
});

test('a confirmed hold closes the review, logs it with no popup and refreshes the library', async () => {
  const { api, user } = setup();
  await openReview(user);
  const scans = (api.scan as ReturnType<typeof vi.fn>).mock.calls.length;
  await user.click(screen.getByTestId('btn-hold'));
  await waitFor(() => expect(screen.queryByTestId('review-dialog')).not.toBeInTheDocument());
  await waitFor(() => expect((api.scan as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(scans));
  expect(screen.queryByTestId('result-toast')).not.toBeInTheDocument(); // a success shows no popup
  expect(useSessionLog.getState().entries.map((e) => e.text)).toEqual(['Moved to Recently Deleted · 0 B freed now · 8.3 kB held · frees 8.3 kB when emptied']);
  expect(useSelection.getState().toSelection()).toBeNull(); // the deleted selection is cleared
  await user.click(screen.getByTestId('btn-session-log'));
  expect(screen.getAllByTestId('session-log-entry').map((e) => e.textContent)).toEqual([
    expect.stringContaining('Moved to Recently Deleted · 0 B freed now · 8.3 kB held')]);
});

test("a success's notes go to the session log, not a popup", async () => {
  const { user } = setup({
    executePlan: vi.fn(() => Promise.resolve(ok(execResult({ mode: 'hold', heldBytes: 8250, notes: ['note one', 'note two'] })))),
  });
  await openReview(user);
  await user.click(screen.getByTestId('btn-hold'));
  await waitFor(() => expect(useSessionLog.getState().entries.map((e) => e.text)).toEqual([
    expect.stringContaining('Moved to Recently Deleted'), 'note one', 'note two']));
  expect(screen.queryByTestId('result-toast')).not.toBeInTheDocument();
});

test('a batch of several plans runs every plan: no library scan is started between them (main would refuse BUSY)', async () => {
  // main refuses an execute while a scan is in flight; the fake models that, with each scan taking a moment
  let scanning = 0;
  const scan = vi.fn(async () => {
    scanning++;
    await new Promise((r) => setTimeout(r, 20));
    scanning--;
    return ok({ ...LIBRARY, heldCount: 3, heldBytes: 6000 });
  });
  const executePlan = vi.fn(async (planId: string) => (scanning > 0
    ? { ok: false as const, error: { code: 'BUSY' as const, message: 'Another operation is running — try again when it finishes.' } }
    : ok(execResult({ planId, purpose: 'empty' }))));
  const b = emptyBatch(3);
  const { user } = setup({ scan, executePlan, planEmpty: vi.fn(() => Promise.resolve(ok(b))) });
  await user.click(await screen.findByRole('button', { name: 'Permanently Delete Recent Deletions' }));
  await screen.findByTestId('review-dialog');
  await waitFor(() => expect(scanning).toBe(0));
  await user.click(screen.getByTestId('btn-permanent'));
  await waitFor(() => expect(screen.queryByTestId('review-dialog')).not.toBeInTheDocument());
  expect(executePlan.mock.results.length).toBe(3);
  for (const r of executePlan.mock.results) expect(await r.value).toMatchObject({ ok: true });
});

test('Review again re-plans the same selection and shows the fresh plan', async () => {
  const second = qwenPair();
  const fresh: PlanPairDTO = { ...second, permanent: { ...second.permanent, planId: '00000000-0000-4000-8000-0000000000f2' } };
  const planDelete = vi.fn().mockResolvedValueOnce(ok(qwenPair())).mockResolvedValueOnce(ok(fresh));
  const { api, user } = setup({
    planDelete,
    executePlan: vi.fn(() => Promise.resolve(ok(execResult({ ok: false, appliedOps: 0, error: { code: 'STALE', message: 'm' } })))),
  });
  await openReview(user);
  await user.type(screen.getByTestId('confirm-input'), Q);
  await user.click(screen.getByTestId('btn-permanent'));
  await user.click(await screen.findByTestId('btn-review-again'));
  await waitFor(() => expect(planDelete).toHaveBeenCalledTimes(2));
  expect(planDelete.mock.calls[1]).toEqual(planDelete.mock.calls[0]);
  await waitFor(() => expect(screen.queryByTestId('stale-message')).not.toBeInTheDocument());
  expect(screen.getByTestId('confirm-input')).toHaveValue(''); // a fresh review starts untyped
  await user.type(screen.getByTestId('confirm-input'), Q);
  await user.click(screen.getByTestId('btn-permanent'));
  await waitFor(() => expect((api.executePlan as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toBe(fresh.permanent.planId));
});

test('the review shortcut is ignored while the review is open', async () => {
  const { api, user } = setup();
  await openReview(user);
  await user.keyboard('{Control>}{Backspace}{/Control}');
  await act(async () => { await Promise.resolve(); });
  expect(api.planDelete).toHaveBeenCalledTimes(1);
});

test('a failed plan request shows its message and opens nothing', async () => {
  const { user } = setup({ planDelete: vi.fn(() => Promise.resolve({ ok: false as const, error: { code: 'BUSY' as const, message: 'A scan is running.' } })) });
  act(() => useSelection.getState().toggleGroup(Q, 'quant:Q8_0', false));
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  await user.click(screen.getByTestId('btn-review'));
  expect(await screen.findByText('A scan is running.')).toBeInTheDocument();
  expect(screen.queryByTestId('review-dialog')).not.toBeInTheDocument();
});

test('Delete entire repo plans the whole repo', async () => {
  const { api, user } = setup();
  await user.click(await screen.findByText(Q));
  await user.click(await screen.findByTestId('btn-delete-repo'));
  await screen.findByTestId('review-dialog');
  expect(api.planDelete).toHaveBeenCalledWith({ repos: [{ repoId: Q, whole: true }] });
});

test('Permanently Delete Recent Deletions plans every held deletion and reviews the batch', async () => {
  const planEmpty = vi.fn(() => Promise.resolve(ok(emptyBatch(2))));
  const { user } = setup({ scan: vi.fn(() => Promise.resolve(ok({ ...LIBRARY, heldCount: 2, heldBytes: 3000 }))), planEmpty });
  await user.click(await screen.findByRole('button', { name: 'Permanently Delete Recent Deletions' }));
  await screen.findByTestId('review-dialog');
  expect(planEmpty).toHaveBeenCalledWith({ all: true });
  expect(screen.getAllByTestId('empty-deletion')).toHaveLength(2);
});
