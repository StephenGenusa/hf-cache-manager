import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ResultToast, resultSummary, showsPopup } from '../../src/renderer/components/ResultToast';
import type { ExecResultDTO, PlanDTO } from '../../src/shared/api';
import { execResult, holdPlan, permanentPlan, restorePlan } from './review-fixtures';

beforeEach(() => expect.hasAssertions());

function renderToast(over: Partial<ExecResultDTO>, plan: PlanDTO = holdPlan(), onOpenSync = vi.fn()) {
  render(<ResultToast result={execResult(over)} plan={plan} onOpenSync={onOpenSync} />);
  return { onOpenSync };
}

test.each([
  ['hold', { mode: 'hold', heldBytes: 8250 }, 'Moved to Recently Deleted · 0 B freed now · 8.3 kB held · frees 8.3 kB when emptied'],
  ['permanent', { mode: 'permanent', freedBytesPlanned: 5380, diskFreeDelta: 8192 }, 'Deleted · 5.4 kB freed · disk free changed by 8.2 kB'],
  ['empty', { mode: 'permanent', purpose: 'empty', freedBytesPlanned: 1000, diskFreeDelta: -50 }, 'Deleted · 1.0 kB freed · disk free changed by 0 B'],
  ['io', { ok: false, appliedOps: 2, totalOps: 9, error: { code: 'IO', message: 'EACCES' } }, 'Failed after 2 of 9 operations: EACCES. The cache was rescanned; review the repo.'],
  ['rolled back', { ok: false, appliedOps: 0, error: { code: 'ROLLED_BACK', message: 'EXDEV on rename' } }, 'Nothing was moved: EXDEV on rename. All changes were rolled back.'],
] as const)('%s toast copy', (_, r, text) => {
  renderToast(r as Partial<ExecResultDTO>);
  expect(screen.getByTestId('result-toast')).toHaveTextContent(text);
});

test('the hold toast says how much is freed when emptied, from the plan', () => {
  renderToast({ mode: 'hold', heldBytes: 10_000 }, holdPlan({ freedBytes: 7000 }));
  expect(screen.getByTestId('result-toast')).toHaveTextContent('Moved to Recently Deleted · 0 B freed now · 10.0 kB held · frees 7.0 kB when emptied');
});

test('data attributes carry the planned and held bytes', () => {
  renderToast({ mode: 'hold', heldBytes: 8250, freedBytesPlanned: 0 });
  expect(screen.getByTestId('result-toast')).toHaveAttribute('data-freed-planned', '0');
  expect(screen.getByTestId('result-toast')).toHaveAttribute('data-held', '8250');
});

test('a restore (a hold-mode plan) reads Restored, never held bytes, and offers Sync preview', async () => {
  // the plan has 2 restore-renames among 5 ops (.refs add, manifest write, rmdir): only the renames are items moved back
  const { onOpenSync } = renderToast({ mode: 'hold', purpose: 'restore', appliedOps: 5, totalOps: 5, heldBytes: 9999, followUp: 'offer-sync' }, restorePlan());
  const t = screen.getByTestId('result-toast');
  expect(t).toHaveTextContent('Restored · 2 items moved back');
  expect(t).not.toHaveTextContent('held');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open Sync preview' }));
  expect(onOpenSync).toHaveBeenCalledTimes(1);
});

test('a restore without the follow-up has no Sync button; one rename reads 1 item', () => {
  renderToast({ mode: 'hold', purpose: 'restore', appliedOps: 3, followUp: null },
    restorePlan({ ops: restorePlan().ops.filter((o, i) => o.kind !== 'restore-rename' || i === 0) }));
  expect(screen.getByTestId('result-toast')).toHaveTextContent('Restored · 1 item moved back');
  expect(screen.queryByRole('button', { name: 'Open Sync preview' })).not.toBeInTheDocument();
});

test('notes render as a list under the text', () => {
  renderToast({ mode: 'permanent', notes: ['store payload kept: shared store/9c41…7a is still referenced', 'Could not update the Recently Deleted record'] }, permanentPlan());
  const items = screen.getAllByTestId('result-note').map((n) => n.textContent);
  expect(items).toEqual(['store payload kept: shared store/9c41…7a is still referenced', 'Could not update the Recently Deleted record']);
});

test('only a failure or a restore that offers Sync shows a popup', () => {
  expect(showsPopup(execResult({ mode: 'hold' }))).toBe(false);
  expect(showsPopup(execResult({ mode: 'permanent' }))).toBe(false);
  expect(showsPopup(execResult({ mode: 'permanent', purpose: 'empty' }))).toBe(false);
  expect(showsPopup(execResult({ mode: 'hold', purpose: 'restore', followUp: null }))).toBe(false);
  expect(showsPopup(execResult({ mode: 'hold', purpose: 'restore', followUp: 'offer-sync' }))).toBe(true);
  expect(showsPopup(execResult({ ok: false, error: { code: 'STALE', message: 'm' } }))).toBe(true);
});

test('the popup body is height-limited and scrolls, so the dismiss button stays in view', () => {
  renderToast({ ok: false, appliedOps: 0, error: { code: 'STALE', message: 'm' }, notes: Array.from({ length: 200 }, (_, i) => `note ${i}`) });
  expect(screen.getByTestId('result-toast')).toHaveClass('max-h-[50vh]', 'overflow-y-auto');
});

test('INTERNAL failure: generic text, raw message only behind Details', async () => {
  renderToast({ ok: false, appliedOps: 0, error: { code: 'INTERNAL', message: 'TypeError: x is undefined' } });
  expect(screen.getByTestId('result-toast')).toHaveTextContent('Something went wrong inside the app.');
  expect(screen.queryByText('TypeError: x is undefined')).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText('TypeError: x is undefined')).toBeVisible();
});

test('resultSummary gives the one-line text and tone (for the session log)', () => {
  expect(resultSummary(execResult({ mode: 'permanent', freedBytesPlanned: 5380, diskFreeDelta: 8192 }), permanentPlan()))
    .toEqual({ text: 'Deleted · 5.4 kB freed · disk free changed by 8.2 kB', tone: 'success' });
  expect(resultSummary(execResult({ ok: false, appliedOps: 1, totalOps: 2, error: { code: 'IO', message: 'x' } }), permanentPlan()).tone).toBe('danger');
});
