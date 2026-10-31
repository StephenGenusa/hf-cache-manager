import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ReviewDialog, RESTORE_RACE_NOTE, type ReviewSource } from '../../src/renderer/components/ReviewDialog';
import { formatBytes } from '../../src/renderer/lib/format';
import type { ApiResult, EmptyPlanDTO, ExecResultDTO, HfcmApi, PlanPairDTO } from '../../src/shared/api';
import { makeFakeApi, renderWithProviders } from './fake-api';
import {
  busyPlan, emptyBatch, execResult, HELD_PAYLOAD_WARNING, holdPlan, permanentPlan, Q, qwenPair, restorePlan, SEL, SUPERSEDED,
  twoRepoPair, UNREADABLE_WARNING,
} from './review-fixtures';

beforeEach(() => expect.hasAssertions());

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const STALE_TEXT = 'The cache changed since you reviewed — please review again.';
const EXPIRED_TEXT = 'This review is more than 10 minutes old — please review again.';

interface Rendered {
  api: HfcmApi; onClose: ReturnType<typeof vi.fn>; onDone: ReturnType<typeof vi.fn>; onReviewAgain: ReturnType<typeof vi.fn>;
  onExecuted: ReturnType<typeof vi.fn>; user: ReturnType<typeof userEvent.setup>;
}

function renderSource(source: ReviewSource, over: Partial<HfcmApi> = {}): Rendered {
  const api = makeFakeApi({
    executePlan: vi.fn((planId: string, _fp: string, mode: ExecResultDTO['mode']) => Promise.resolve(ok(execResult({ planId, mode })))),
    ...over,
  });
  const onClose = vi.fn();
  const onDone = vi.fn();
  const onReviewAgain = vi.fn();
  const onExecuted = vi.fn();
  renderWithProviders(
    <ReviewDialog source={source} onClose={onClose} onDone={onDone} onReviewAgain={onReviewAgain} onExecuted={onExecuted} />, api);
  return { api, onClose, onDone, onReviewAgain, onExecuted, user: userEvent.setup() };
}
const renderReview = (pair: PlanPairDTO, over: Partial<HfcmApi> = {}): Rendered =>
  renderSource({ kind: 'delete', selection: SEL, pair }, over);
const renderEmpty = (batch: EmptyPlanDTO, over: Partial<HfcmApi> = {}): Rendered => renderSource({ kind: 'empty', batch }, over);

async function typeAndDelete(r: Rendered, phrase = Q): Promise<void> {
  await r.user.type(screen.getByTestId('confirm-input'), phrase);
  await r.user.click(screen.getByTestId('btn-permanent'));
}

test('renders every mockup element from the plan', () => {
  renderReview(qwenPair());
  const d = screen.getByTestId('review-dialog');
  expect(d).toHaveTextContent(`Review deletion — ${Q}`);
  expect(d).toHaveTextContent('2 groups · plan computed just now · the cache is re-checked against this plan when you confirm');
  expect(screen.getByTestId('stat-files')).toHaveTextContent('3');
  expect(screen.getByTestId('stat-files')).toHaveTextContent('(2 blobs + 1 plain file)');
  expect(screen.getByTestId('stat-freed')).toHaveAttribute('data-bytes', '8250');
  expect(screen.getByTestId('stat-freed')).toHaveTextContent('8.3 kB');
  expect(screen.getByTestId('stat-apparent')).toHaveAttribute('data-bytes', '8250');
  expect(screen.getByTestId('stat-apparent')).toHaveTextContent('no shared bytes');
  const rows = screen.getAllByTestId('file-row');
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent(/snapshots\/a3f9c1e\/.*blob .{4}….{2} · only link/);
  expect(rows[0]).toHaveTextContent('4.0 kB');
  expect(rows[1]).toHaveTextContent('+2 more links');
  expect(rows[2]).toHaveTextContent('plain file');
  expect(rows[2]).not.toHaveTextContent('blob');
  expect(screen.getAllByTestId('view-line').map((r) => r.textContent)).toEqual([
    expect.stringContaining('Qwen3.6-27B-Q8_0.gguf'), expect.stringContaining('Ollama')]);
  expect(screen.getAllByTestId('view-line')[0]).toHaveTextContent('will be removed');
  expect(screen.getAllByTestId('view-line')[0]).toHaveTextContent('symlink');
  expect(screen.getAllByTestId('view-line')[1]).toHaveTextContent('no links to these files');
  expect(screen.getByTestId('kept-row')).toHaveTextContent('UD-Q4_K_XL · mmproj-F16');
  expect(screen.getByTestId('kept-row')).toHaveTextContent('untouched');
  expect(screen.getByTestId('kept-row')).toHaveTextContent('1.5 kB');
  // The exact files kept, each with its absolute path as visible text
  expect(screen.getByTestId('kept-files-title')).toHaveTextContent('Files kept (2)');
  const keptFiles = screen.getAllByTestId('kept-file');
  expect(keptFiles.map((k) => k.textContent)).toEqual([
    'snapshots/a3f9c1e/Qwen3.6-27B-UD-Q4_K_XL.gguf/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/Qwen3.6-27B-UD-Q4_K_XL.gguf',
    'snapshots/a3f9c1e/mmproj-F16.gguf/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/mmproj-F16.gguf',
  ]);
  expect(screen.getByText('/data/models/hub/models--unsloth--Qwen3.6-27B-GGUF/snapshots/a3f9c1e0/mmproj-F16.gguf')).toBeVisible();
  expect(screen.getByTestId('hold-note')).toHaveTextContent(
    'Files move to Recently Deleted (/data/models/.hfcm-held). 8.3 kB freed when Recently Deleted is emptied.');
  expect(screen.getByTestId('btn-hold')).toHaveTextContent('Move to Recently Deleted');
  expect(screen.getByTestId('btn-permanent')).toHaveTextContent('Delete Permanently');
  expect(screen.getByTestId('btn-cancel')).toHaveTextContent('Cancel');
  expect(screen.queryByTestId('stale-message')).not.toBeInTheDocument();
  expect(d).not.toHaveTextContent(/Trash/);
});

test('every file, size, view line and warning of the plan is rendered; nothing is dropped', () => {
  const p = busyPlan();
  renderReview(qwenPair({ permanent: p }));
  const rows = screen.getAllByTestId('file-row');
  expect(rows).toHaveLength(p.files.length);
  p.files.forEach((f, i) => {
    expect(rows[i]).toHaveTextContent(f.displayPath);
    expect(rows[i]).toHaveTextContent(f.reasonText);
    expect(rows[i]).toHaveTextContent(formatBytes(f.bytes));
    expect(within(rows[i]!).getByText(f.fullPath)).toBeVisible(); // the exact file, full hash, no hover needed
  });
  const lines = screen.getAllByTestId('view-line');
  expect(lines).toHaveLength(p.viewLines.length); // no view is unaffected: foreign and kept lines are always shown
  p.viewLines.forEach((l, i) => {
    expect(lines[i]).toHaveTextContent(l.displayPath);
    expect(lines[i]).toHaveTextContent(l.actionText);
    expect(within(lines[i]!).getByText(l.fullPath)).toBeVisible();
  });
  expect(lines[1]).toHaveTextContent('folder');
  expect(screen.queryByText('no links to these files')).not.toBeInTheDocument();
  const warnings = screen.getAllByTestId('warning').map((w) => w.textContent);
  expect(warnings).toEqual([expect.stringContaining(HELD_PAYLOAD_WARNING), expect.stringContaining(UNREADABLE_WARNING),
    expect.stringContaining(SUPERSEDED)]);
  expect(screen.getByTestId('stat-apparent')).toHaveTextContent('2.2 kB shared — not freed');
  expect(screen.getByTestId('stat-apparent')).toHaveAttribute('data-bytes', '10450');
});

test('Ollama paths: the short label first, then the full path as visible text (no tooltip-only content)', () => {
  renderReview(qwenPair({ permanent: busyPlan() }));
  const line = screen.getAllByTestId('view-line').find((l) => l.textContent?.includes('sha256-0123456789ab…'))!;
  const full = within(line).getByText('/home/u/.ollama/models/blobs/sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  expect(full).toBeVisible();
  expect(full).toHaveClass('font-mono', 'break-all');
  expect(within(line).getByText('~/.ollama/models/blobs/sha256-0123456789ab…')).toBeVisible();
});

test('a warning only the hold plan carries is shown too, once', () => {
  renderReview(qwenPair({ permanent: permanentPlan({ warnings: [UNREADABLE_WARNING] }), hold: holdPlan({ warnings: [UNREADABLE_WARNING, HELD_PAYLOAD_WARNING] }) }));
  expect(screen.getAllByTestId('warning').map((w) => w.textContent)).toEqual([
    expect.stringContaining(UNREADABLE_WARNING), expect.stringContaining(HELD_PAYLOAD_WARNING)]);
});

test('Delete Permanently unlocks only on the exact full repo id and sends it', async () => {
  const r = renderReview(qwenPair());
  const btn = screen.getByTestId('btn-permanent');
  const input = screen.getByTestId('confirm-input');
  expect(input).toHaveAttribute('placeholder', `type ${Q} to enable`);
  expect(btn).toBeDisabled();
  for (const t of ['unsloth/Qwen3.6-27B-GG', 'Unsloth/Qwen3.6-27B-GGUF', 'unsloth/qwen3.6-27b-gguf', ` ${Q}`, `${Q} `,
    'Qwen3.6-27B-GGUF', `${Q}x`]) {
    await r.user.clear(input);
    await r.user.type(input, t);
    expect(btn).toBeDisabled();
  }
  await r.user.clear(input);
  await r.user.type(input, `${Q}{Enter}`);
  expect(r.api.executePlan).not.toHaveBeenCalled(); // Enter never submits
  expect(btn).toBeEnabled();
  await r.user.click(btn);
  const p = permanentPlan();
  expect(r.api.executePlan).toHaveBeenCalledWith(p.planId, p.fingerprint, 'permanent', Q);
  expect(r.api.executePlan).toHaveBeenCalledTimes(1);
});

test('multi-repo plan: phrase placeholder and repo-prefixed file rows', () => {
  renderReview(twoRepoPair());
  expect(screen.getByTestId('confirm-input')).toHaveAttribute('placeholder', 'type delete 2 repos to enable');
  const rows = screen.getAllByTestId('file-row');
  expect(rows[0]).toHaveTextContent(`${Q} · snapshots/a3f9c1e/Qwen3.6-27B-Q8_0.gguf`);
  expect(rows[1]).toHaveTextContent('bartowski/gemma-4-31b-it-GGUF · snapshots/1234567/gemma-4-31b-it-Q4_K_M.gguf');
  expect(screen.getByTestId('kept-row')).toHaveTextContent('Nothing kept — the whole repo is removed');
  expect(screen.queryByTestId('kept-files-title')).toBeNull();
});

test('Move to Recently Deleted sends the hold plan with a null confirm; no typing needed', async () => {
  const r = renderReview(qwenPair());
  await r.user.click(screen.getByTestId('btn-hold'));
  const h = holdPlan();
  expect(r.api.executePlan).toHaveBeenCalledWith(h.planId, h.fingerprint, 'hold', null);
  await waitFor(() => expect(r.onDone).toHaveBeenCalledTimes(1));
  expect(r.onDone.mock.calls[0]![1]).toMatchObject({ planId: h.planId, mode: 'hold' });
  expect(r.onExecuted).toHaveBeenCalled();
});

test('hold unavailable: button disabled and the reason is visible text before confirming', () => {
  renderReview(qwenPair({ hold: null, holdUnavailableReason: 'Recently Deleted is on a different drive' }));
  expect(screen.getByTestId('btn-hold')).toBeDisabled();
  expect(screen.getByTestId('hold-unavailable')).toHaveTextContent('Move to Recently Deleted is unavailable: Recently Deleted is on a different drive');
  expect(screen.getByTestId('hold-unavailable')).toBeVisible();
  expect(screen.queryByTestId('hold-note')).not.toBeInTheDocument();
});

test('a regular-file view blob refusal from the planner is shown before confirm', () => {
  const why = "Recently Deleted can't hold blobs/sha256-x (a regular file in the Ollama folder, not a link) — use Delete Permanently";
  renderReview(qwenPair({ hold: null, holdUnavailableReason: why }));
  expect(screen.getByTestId('hold-unavailable')).toHaveTextContent(`Move to Recently Deleted is unavailable: ${why}`);
  expect(screen.getByTestId('btn-hold')).toBeDisabled();
});

test('stale result shows the message, locks actions, offers Review again', async () => {
  const r = renderReview(qwenPair(), {
    executePlan: vi.fn(() => Promise.resolve(ok(execResult({ ok: false, appliedOps: 0, error: { code: 'STALE', message: 'm' } })))),
  });
  await typeAndDelete(r);
  expect(await screen.findByTestId('stale-message')).toHaveTextContent(STALE_TEXT);
  expect(screen.getByTestId('btn-permanent')).toBeDisabled();
  expect(screen.getByTestId('btn-hold')).toBeDisabled();
  expect(screen.getByTestId('confirm-input')).toBeDisabled();
  expect(r.onDone).not.toHaveBeenCalled();
  expect(r.onExecuted).toHaveBeenCalled(); // main rescanned: the library must be refreshed
  await r.user.click(screen.getByTestId('btn-review-again'));
  expect(r.onReviewAgain).toHaveBeenCalledTimes(1);
  expect(r.api.executePlan).toHaveBeenCalledTimes(1); // never a silent retry
});

test.each([
  ['EXPIRED', EXPIRED_TEXT],
  ['UNKNOWN_PLAN', 'This review was already used or is no longer valid — please review again.'],
  ['FINGERPRINT', STALE_TEXT],
] as const)('%s refusal from main shows its copy and Review again', async (code, text) => {
  const r = renderReview(qwenPair(), { executePlan: vi.fn(() => Promise.resolve({ ok: false as const, error: { code, message: 'x' } })) });
  await r.user.click(screen.getByTestId('btn-hold'));
  expect(await screen.findByTestId('stale-message')).toHaveTextContent(text);
  expect(screen.getByTestId('btn-hold')).toBeDisabled();
  expect(screen.getByTestId('btn-permanent')).toBeDisabled();
  await r.user.click(screen.getByTestId('btn-review-again'));
  expect(r.onReviewAgain).toHaveBeenCalledTimes(1);
  expect(r.api.executePlan).toHaveBeenCalledTimes(1);
});

test('a review past its expiry says so before anything is sent', () => {
  const t = Date.now() - 700_000;
  renderReview(qwenPair({ permanent: permanentPlan({ createdAt: t, expiresAt: t + 600_000 }), hold: holdPlan({ createdAt: t, expiresAt: t + 600_000 }) }));
  expect(screen.getByTestId('stale-message')).toHaveTextContent(EXPIRED_TEXT);
  expect(screen.getByTestId('btn-hold')).toBeDisabled();
  expect(screen.getByTestId('btn-permanent')).toBeDisabled();
  expect(screen.getByTestId('btn-review-again')).toBeEnabled();
  expect(screen.getByTestId('review-dialog')).toHaveTextContent('plan computed 11 minutes ago');
});

test('a refusal that left the plan usable (CONFIRM, BUSY) does not lock the dialog', async () => {
  const exec = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: { code: 'BUSY', message: 'A scan is running. Try again when it finishes.' } })
    .mockResolvedValueOnce(ok(execResult()));
  const r = renderReview(qwenPair(), { executePlan: exec });
  await typeAndDelete(r);
  expect(await screen.findByTestId('stale-message')).toHaveTextContent('A scan is running. Try again when it finishes.');
  expect(screen.queryByTestId('btn-review-again')).not.toBeInTheDocument();
  expect(screen.getByTestId('btn-permanent')).toBeEnabled();
  await r.user.click(screen.getByTestId('btn-permanent'));
  await waitFor(() => expect(r.onDone).toHaveBeenCalledTimes(1));
});

test('an error after the plan was taken (LOCKED) locks the dialog: the plan is single-use; stale own lock shows the fix', async () => {
  const r = renderReview(qwenPair(), {
    executePlan: vi.fn(() => Promise.resolve(ok(execResult({
      ok: false, appliedOps: 0, error: { code: 'LOCKED', message: 'Another operation is in progress (process 7).', detailPath: '/mnt/.hf-cache-manager/app.lock', staleOwnLock: true },
    })))),
  });
  await typeAndDelete(r);
  const msg = await screen.findByTestId('stale-message');
  expect(msg).toHaveTextContent('Another operation (sync or deletion) is running. Try again when it finishes. If no other copy of this app is running on this or any other computer that uses this cache, quit the app and delete /mnt/.hf-cache-manager/app.lock.');
  expect(screen.getByTestId('btn-permanent')).toBeDisabled();
  expect(screen.getByTestId('btn-review-again')).toBeEnabled();
});

test('INTERNAL shows a generic message with a details toggle, never the raw text as the headline', async () => {
  const r = renderReview(qwenPair(), { executePlan: vi.fn(() => Promise.resolve({ ok: false as const, error: { code: 'INTERNAL' as const, message: 'TypeError: boom' } })) });
  await typeAndDelete(r);
  const msg = await screen.findByTestId('stale-message');
  expect(msg).toHaveTextContent('Something went wrong inside the app. Nothing was changed by this step.');
  expect(screen.queryByText('TypeError: boom')).not.toBeInTheDocument();
  await r.user.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText('TypeError: boom')).toBeVisible();
});

test('an executed failure (IO after some ops) goes to the result toast', async () => {
  const res = execResult({ ok: false, appliedOps: 2, totalOps: 9, error: { code: 'IO', message: 'EACCES' } });
  const r = renderReview(qwenPair(), { executePlan: vi.fn(() => Promise.resolve(ok(res))) });
  await typeAndDelete(r);
  await waitFor(() => expect(r.onDone).toHaveBeenCalledWith(res, expect.objectContaining({ mode: 'permanent' })));
});

test('buttons disabled with a spinner while executing; a double click executes once; Escape does not close', async () => {
  let release: (v: ApiResult<ExecResultDTO>) => void = () => undefined;
  const pending = new Promise<ApiResult<ExecResultDTO>>((res) => { release = res; });
  const r = renderReview(qwenPair(), { executePlan: vi.fn(() => pending) });
  await r.user.type(screen.getByTestId('confirm-input'), Q);
  await r.user.dblClick(screen.getByTestId('btn-permanent'));
  expect(screen.getByTestId('btn-permanent')).toBeDisabled();
  expect(screen.getByTestId('btn-hold')).toBeDisabled();
  expect(screen.getByTestId('btn-cancel')).toBeDisabled();
  expect(screen.getByTestId('confirm-input')).toBeDisabled();
  expect(within(screen.getByTestId('btn-permanent')).getByTestId('spinner')).toBeInTheDocument();
  expect(within(screen.getByTestId('btn-hold')).getByTestId('spinner')).toBeInTheDocument(); // every action button
  await r.user.click(screen.getByTestId('dialog-overlay')); // an overlay click (outside the content)
  await r.user.keyboard('{Escape}');
  expect(r.onClose).not.toHaveBeenCalled();
  expect(screen.getByTestId('review-dialog')).toBeInTheDocument();
  await act(async () => { release(ok(execResult())); await pending; });
  expect(r.api.executePlan).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(r.onDone).toHaveBeenCalledTimes(1));
});

test('Escape and Cancel close the dialog when idle', async () => {
  const r = renderReview(qwenPair());
  await r.user.keyboard('{Escape}');
  expect(r.onClose).toHaveBeenCalledTimes(1);
  await r.user.click(screen.getByTestId('btn-cancel'));
  expect(r.onClose).toHaveBeenCalledTimes(2);
  expect(r.api.executePlan).not.toHaveBeenCalled();
});

test('all operations list is collapsed and expands to every op', async () => {
  const r = renderReview(qwenPair());
  const p = permanentPlan();
  expect(screen.getByTestId('ops-toggle')).toHaveTextContent(`All operations (${p.ops.length})`);
  expect(screen.queryAllByTestId('op-row')).toHaveLength(0);
  await r.user.click(screen.getByTestId('ops-toggle'));
  const ops = screen.getAllByTestId('op-row');
  expect(ops).toHaveLength(p.ops.length);
  p.ops.forEach((o, i) => {
    expect(ops[i]).toHaveTextContent(o.kind);
    expect(ops[i]).toHaveTextContent(o.displayPath);
    if (o.role !== null) expect(ops[i]).toHaveTextContent(o.role);
    expect(within(ops[i]!).getByText(o.fullPath)).toBeVisible();
  });
});

test('restore source shows Restore only, the moved files, the sync hint and the race note', async () => {
  const p = restorePlan();
  const r = renderSource({ kind: 'restore', plan: p });
  const d = screen.getByTestId('review-dialog');
  expect(d).toHaveTextContent('Restore from Recently Deleted');
  expect(screen.queryByTestId('btn-hold')).not.toBeInTheDocument();
  expect(screen.queryByTestId('btn-permanent')).not.toBeInTheDocument();
  expect(screen.queryByTestId('confirm-input')).not.toBeInTheDocument();
  expect(screen.getAllByTestId('file-row').map((x) => x.textContent)).toEqual([
    expect.stringContaining('moves back'), expect.stringContaining('moves back'), expect.stringContaining('.refs re-added')]);
  // Only the restore-move rows are items moved back (not the .refs line)
  expect(screen.getByTestId('stat-files')).toHaveTextContent('Items moved back2');
  expect(d).toHaveTextContent('Run Sync afterwards to recreate the LM Studio and Ollama links this deletion removed.');
  expect(d).toHaveTextContent(RESTORE_RACE_NOTE);
  expect(RESTORE_RACE_NOTE).toBe('If a download recreates one of these files while restoring, the restored copy (same content) replaces it.');
  await r.user.click(screen.getByTestId('btn-restore-confirm'));
  expect(r.api.executePlan).toHaveBeenCalledWith(p.planId, p.fingerprint, 'hold', null);
  await waitFor(() => expect(r.onDone).toHaveBeenCalledTimes(1));
});

test('empty source: totals, every deletion grouped, skipped as warnings, no phrase needed', async () => {
  const b = emptyBatch(2, { skipped: ['20261025T140309Z-1a2b3c4d: the manifest could not be read'] });
  const r = renderEmpty(b, {
    executePlan: vi.fn((planId: string) => Promise.resolve(ok(execResult({ planId, purpose: 'empty', notes: [`note ${planId.slice(-2)}`] })))),
  });
  const d = screen.getByTestId('review-dialog');
  expect(d).toHaveTextContent('Empty Recently Deleted');
  expect(screen.getByTestId('stat-freed')).toHaveAttribute('data-bytes', '3000');
  expect(screen.getByTestId('stat-files')).toHaveTextContent('2');
  expect(screen.getAllByTestId('empty-deletion')).toHaveLength(2);
  expect(screen.getAllByTestId('file-row')).toHaveLength(2);
  expect(screen.getAllByTestId('warning').map((w) => w.textContent)).toEqual([expect.stringContaining('the manifest could not be read')]);
  expect(screen.queryByTestId('confirm-input')).not.toBeInTheDocument();
  expect(screen.queryByTestId('btn-hold')).not.toBeInTheDocument();
  await r.user.click(screen.getByTestId('btn-permanent'));
  await waitFor(() => expect(r.onDone).toHaveBeenCalledTimes(1));
  expect((r.api.executePlan as ReturnType<typeof vi.fn>).mock.calls).toEqual(b.plans.map((p) => [p.planId, p.fingerprint, 'permanent', null]));
  expect(r.onDone.mock.calls[0]![0]).toMatchObject({ ok: true, purpose: 'empty', freedBytesPlanned: 16_500, appliedOps: 10, notes: ['note c1', 'note c2'] });
});

test('empty source requires the phrase when a plan carries one', async () => {
  const b = emptyBatch(1);
  b.plans[0] = { ...b.plans[0]!, confirmPhrase: 'empty' };
  const r = renderEmpty(b);
  expect(screen.getByTestId('btn-permanent')).toBeDisabled();
  await r.user.type(screen.getByTestId('confirm-input'), 'empty');
  await r.user.click(screen.getByTestId('btn-permanent'));
  expect(r.api.executePlan).toHaveBeenCalledWith(b.plans[0]!.planId, b.plans[0]!.fingerprint, 'permanent', 'empty');
});

test('an empty batch stops at the first failure and sends the stale plan back for review', async () => {
  const b = emptyBatch(3);
  const exec = vi.fn()
    .mockResolvedValueOnce(ok(execResult({ planId: b.plans[0]!.planId, purpose: 'empty' })))
    .mockResolvedValueOnce(ok(execResult({ ok: false, appliedOps: 0, planId: b.plans[1]!.planId, purpose: 'empty', error: { code: 'STALE', message: 'm' } })))
    .mockResolvedValue(ok(execResult()));
  const r = renderEmpty(b, { executePlan: exec });
  await r.user.click(screen.getByTestId('btn-permanent'));
  const msg = await screen.findByTestId('stale-message');
  expect(msg).toHaveTextContent('Emptied 1 of 3 deletions · 8.3 kB freed.');
  expect(msg).toHaveTextContent(STALE_TEXT);
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec.mock.calls.map((c) => c[0])).toEqual([b.plans[0]!.planId, b.plans[1]!.planId]);
  expect(r.onDone).not.toHaveBeenCalled();
  expect(r.onExecuted).toHaveBeenCalled();
  expect(screen.getByTestId('btn-permanent')).toBeDisabled();
  await r.user.click(screen.getByTestId('btn-review-again'));
  expect(r.onReviewAgain).toHaveBeenCalledTimes(1);
});

test('an empty batch whose first plan is refused runs nothing else', async () => {
  const b = emptyBatch(2);
  const exec = vi.fn().mockResolvedValue({ ok: false, error: { code: 'EXPIRED', message: 'x' } });
  const r = renderEmpty(b, { executePlan: exec });
  await r.user.click(screen.getByTestId('btn-permanent'));
  expect(await screen.findByTestId('stale-message')).toHaveTextContent(EXPIRED_TEXT);
  expect(screen.getByTestId('stale-message')).not.toHaveTextContent('Emptied');
  expect(exec).toHaveBeenCalledTimes(1);
});

test('an empty batch with nothing to empty cannot be confirmed', () => {
  renderEmpty(emptyBatch(0, { skipped: ['x: unreadable'] }));
  expect(screen.getByTestId('btn-permanent')).toBeDisabled();
  expect(screen.getByTestId('review-dialog')).toHaveTextContent('Nothing to empty');
});

test('Escape or an overlay click closes when idle, but neither closes nor cancels while executing', async () => {
  let release: (v: ApiResult<ExecResultDTO>) => void = () => undefined;
  const pending = new Promise<ApiResult<ExecResultDTO>>((res) => { release = res; });
  const r = renderReview(qwenPair(), { executePlan: vi.fn(() => pending) });
  await r.user.click(screen.getByTestId('btn-hold'));
  await r.user.click(screen.getByTestId('dialog-overlay')); // an overlay click (outside the content)
  await r.user.keyboard('{Escape}');
  expect(r.onClose).not.toHaveBeenCalled();
  expect(screen.getByTestId('review-dialog')).toBeInTheDocument();
  await act(async () => { release(ok(execResult({ mode: 'hold' }))); await pending; });
  await waitFor(() => expect(r.onDone).toHaveBeenCalledTimes(1)); // it ran to the end: nothing was cancelled
});

test('an overlay click closes the idle dialog', async () => {
  const r = renderReview(qwenPair());
  await r.user.click(screen.getByTestId('dialog-overlay'));
  expect(r.onClose).toHaveBeenCalledTimes(1);
});

test('a double click on Move to Recently Deleted executes once', async () => {
  const r = renderReview(qwenPair());
  await r.user.dblClick(screen.getByTestId('btn-hold'));
  await waitFor(() => expect(r.onDone).toHaveBeenCalledTimes(1));
  expect(r.api.executePlan).toHaveBeenCalledTimes(1);
});

test('two clicks in the same tick (before any re-render) still execute once', async () => {
  const r = renderReview(qwenPair());
  act(() => {
    fireEvent.click(screen.getByTestId('btn-hold'));
    fireEvent.click(screen.getByTestId('btn-hold'));
  });
  await waitFor(() => expect(r.onDone).toHaveBeenCalledTimes(1));
  expect(r.api.executePlan).toHaveBeenCalledTimes(1);
});

test('an empty batch refused before take on a later plan shows what was emptied and runs nothing after it', async () => {
  const b = emptyBatch(3);
  const exec = vi.fn()
    .mockResolvedValueOnce(ok(execResult({ planId: b.plans[0]!.planId, purpose: 'empty', freedBytesPlanned: 1000 })))
    .mockResolvedValueOnce({ ok: false, error: { code: 'BUSY', message: 'A scan is running. Try again when it finishes.' } })
    .mockResolvedValue(ok(execResult()));
  const r = renderEmpty(b, { executePlan: exec });
  await r.user.click(screen.getByTestId('btn-permanent'));
  const msg = await screen.findByTestId('stale-message');
  expect(msg).toHaveTextContent('Emptied 1 of 3 deletions · 1.0 kB freed. A scan is running. Try again when it finishes.');
  expect(exec).toHaveBeenCalledTimes(2);
  expect(r.onExecuted).toHaveBeenCalled();
  expect(r.onDone).not.toHaveBeenCalled();
  // the batch was partly run: the rest must be planned and reviewed again, never re-sent
  expect(screen.getByTestId('btn-permanent')).toBeDisabled();
  expect(screen.getByTestId('btn-review-again')).toBeEnabled();
});

test('the empty review shows the shared bytes main computed, not UI arithmetic', () => {
  renderEmpty(emptyBatch(2, { sharedBytes: 500 })); // apparent == freed here; only main's figure says 500
  expect(screen.getByTestId('stat-apparent')).toHaveTextContent('500 B shared — not freed');
});
