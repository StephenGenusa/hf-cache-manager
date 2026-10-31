// The Sync dialog: a full preview, the mass-removal gate, and an honest result.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { SyncDialog } from '../../src/renderer/components/SyncDialog';
import type {
  ApiResult, HfcmApi, SyncPlanDTO, SyncResultDTO, SyncViewDTO, SyncViewResultDTO,
} from '../../src/shared/api';
import { makeFakeApi, renderWithProviders } from './fake-api';
import { useState } from 'react';

beforeEach(() => expect.hasAssertions());

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (code: 'HUB_MISSING' | 'EXPIRED' | 'UNKNOWN_PLAN' | 'INTERNAL' | 'NOT_FOUND', message: string): ApiResult<never> => ({ ok: false, error: { code, message } });
const view = (over: Partial<SyncViewDTO> = {}): SyncViewDTO => ({
  view: 'lmstudio', rootDisplay: '~/.lmstudio/models', skippedReason: null, adds: [], updates: [], removals: [], tombstones: [],
  adopts: [], foreign: [], skipped: [], ownedCount: 0, wouldRemoveAll: false, warnings: [], ...over,
});
const LM_VIEW = view({ adds: [{ key: 'unsloth/Qwen3.6-27B-GGUF:Q8_0.gguf', paths: ['/home/u/.lmstudio/models/unsloth/Qwen/Q8_0.gguf'], fullPaths: ['/home/u/.lmstudio/models/unsloth/Qwen/Q8_0.gguf'], note: null }], ownedCount: 3 });
const SYNC: SyncPlanDTO = { planId: '00000000-0000-4000-8000-0000000000b1', createdAt: 1, expiresAt: 600_001, views: [LM_VIEW], warnings: [] };
const vres = (over: Partial<SyncViewResultDTO> = {}): SyncViewResultDTO => ({
  view: 'lmstudio', status: 'applied', created: 1, updated: 0, removed: 0, adopted: 0, tombstoned: 0, skipped: 0, error: null,
  partialWrites: [], warnings: [], ...over,
});

function renderSync(plan: Partial<SyncPlanDTO> = {}, over: Partial<HfcmApi> = {}) {
  const api = makeFakeApi({
    planSync: vi.fn(() => Promise.resolve(ok({ ...SYNC, ...plan }))),
    executeSync: vi.fn(() => Promise.resolve(ok<SyncResultDTO>({ ok: true, views: [vres()], massRemovalViews: [] }))),
    ...over,
  });
  const onClose = vi.fn();
  renderWithProviders(<SyncDialog open onClose={onClose} />, api);
  return { api, onClose, user: userEvent.setup() };
}

test('sync dialog lists everything the preview holds, per view, with full paths and notes', async () => {
  renderSync({
    views: [
      view({
        updates: [{ key: 'u:1', paths: ['/p/u1'], fullPaths: ['/p/u1'], note: null }],
        removals: [
          { key: 'gone/repo:x.gguf', paths: ['/home/u/.ollama/models/blobs/sha256-aa', '/home/u/.ollama/models/manifests/x'], fullPaths: ['/home/u/.ollama/models/blobs/sha256-aa', '/home/u/.ollama/models/manifests/x'], note: 'removed only if no manifest uses it: /home/u/.ollama/models/blobs/sha256-aa' },
          { key: 'k/shared', paths: ['/p/s'], fullPaths: ['/p/s'], note: '/p/s kept — also owned by other:model' },
        ],
        tombstones: [{ key: 't:1', paths: ['/p/t'], fullPaths: ['/p/t'], note: null }], adopts: [{ key: 'a:1', paths: ['/p/a'], fullPaths: ['/p/a'], note: null }],
        foreign: [{ key: 'f:1', paths: ['/p/f'], fullPaths: ['/p/f'], note: 'not created by this app' }], skipped: [{ key: 's:1', paths: [], fullPaths: [], note: 'name has a slash' }],
        adds: LM_VIEW.adds,
      }),
      view({ view: 'ollama', skippedReason: 'the Ollama folder is missing' }),
    ],
    warnings: ['plan-level warning'],
  });
  const sections = await screen.findAllByTestId('sync-view');
  expect(sections).toHaveLength(2);
  const lm = within(sections[0]!);
  expect(lm.getByText('Will add (1)')).toBeVisible();
  expect(lm.getByText('Will update (1)')).toBeVisible();
  expect(lm.getByText('Will remove (2)')).toBeVisible();
  expect(lm.getByText('Will start tracking (1)')).toBeVisible();
  expect(lm.getByText('Deleted outside sync — will stop tracking (1)')).toBeVisible();
  expect(lm.getByText('Not ours — never touched (1)')).toBeVisible();
  expect(lm.getByText('Skipped (1)')).toBeVisible();
  expect(lm.getByText('/home/u/.ollama/models/manifests/x')).toBeVisible();
  expect(lm.getByText(/removed only if no other Ollama model uses it/)).toBeVisible();
  expect(lm.queryByText(/no manifest uses it/)).toBeNull();
  expect(lm.getByText('/p/s kept — also owned by other:model')).toBeVisible();
  expect(lm.getAllByTestId('sync-add')).toHaveLength(1);
  expect(lm.getAllByTestId('sync-removal')).toHaveLength(2);
  expect(lm.getByTestId('sync-foreign')).toHaveTextContent('not created by this app');
  expect(lm.getByTestId('sync-skipped')).toHaveTextContent('name has a slash');
  expect(within(sections[1]!).getByText('Skipped: the Ollama folder is missing')).toBeVisible();
  expect(screen.getByText('plan-level warning')).toBeVisible();
  expect(screen.getByTestId('btn-sync-execute')).toBeEnabled();
});

test('mass removal requires the checkbox, names every affected view, and sends allowMassRemoval', async () => {
  const wipe = (v: SyncViewDTO['view']) => view({ view: v, wouldRemoveAll: true, ownedCount: 1, removals: [{ key: 'gone/repo:x.gguf', paths: ['gone/repo/x.gguf'], fullPaths: ['gone/repo/x.gguf'], note: null }] });
  const { api, user } = renderSync({ views: [wipe('lmstudio'), wipe('ollama')] });
  expect(await screen.findByText('Sync would remove every entry it manages in LM Studio (1). This usually means the cache drive is not mounted.')).toBeVisible();
  expect(screen.getByText('Sync would remove every entry it manages in Ollama (1). This usually means the cache drive is not mounted.')).toBeVisible();
  expect(screen.getByTestId('btn-sync-execute')).toBeDisabled();
  expect(screen.getByText(/Allow removing every managed entry \(LM Studio, Ollama\)/)).toBeVisible();
  await user.click(screen.getByTestId('mass-removal-checkbox'));
  await user.click(screen.getByTestId('btn-sync-execute'));
  expect(api.executeSync).toHaveBeenCalledWith(SYNC.planId, { allowMassRemoval: true });
});

test('without mass removal, allowMassRemoval is false and Execute runs once', async () => {
  const { api, user } = renderSync();
  const btn = await screen.findByTestId('btn-sync-execute');
  await user.dblClick(btn);
  await screen.findByTestId('sync-result');
  expect(api.executeSync).toHaveBeenCalledTimes(1);
  expect(api.executeSync).toHaveBeenCalledWith(SYNC.planId, { allowMassRemoval: false });
});

test('nothing to do disables execute', async () => {
  renderSync({ views: [view({ foreign: [{ key: 'f', paths: [], fullPaths: [], note: null }] })] });
  expect(await screen.findByText('Nothing to do')).toBeVisible();
  expect(screen.getByTestId('btn-sync-execute')).toBeDisabled();
});

test('an adopt-only preview can run', async () => {
  renderSync({ views: [view({ adopts: [{ key: 'a', paths: [], fullPaths: [], note: null }] })] });
  await screen.findByTestId('sync-view');
  expect(screen.queryByText('Nothing to do')).toBeNull();
  expect(screen.getByTestId('btn-sync-execute')).toBeEnabled();
});

test('HUB_MISSING shows the message as is', async () => {
  const msg = 'Cache not found or empty at /data/models/hub; sync is disabled so nothing is removed by mistake.';
  renderSync({}, { planSync: vi.fn(() => Promise.resolve(fail('HUB_MISSING', msg))) });
  expect(await screen.findByText(msg)).toBeVisible();
  expect(screen.queryByTestId('btn-sync-execute')).toBeNull();
});

test('a successful run shows the per-view summary', async () => {
  const { user } = renderSync({}, {
    executeSync: vi.fn(() => Promise.resolve(ok<SyncResultDTO>({ ok: true, views: [vres({ created: 2, updated: 1, removed: 3, skipped: 4 })], massRemovalViews: [] }))),
  });
  await user.click(await screen.findByTestId('btn-sync-execute'));
  expect(await screen.findByText('LM Studio: 2 added · 1 updated · 3 removed · 4 skipped')).toBeVisible();
  expect(screen.getByTestId('sync-result-headline')).toHaveTextContent('Sync finished.');
});

test('partial writes show in a red box and the run is not called a success', async () => {
  const { user } = renderSync({}, {
    executeSync: vi.fn(() => Promise.resolve(ok<SyncResultDTO>({
      ok: false, massRemovalViews: [],
      views: [vres({ status: 'aborted', error: 'disk full', partialWrites: ['k:x.gguf: failed after a partial write'] })],
    }))),
  });
  await user.click(await screen.findByTestId('btn-sync-execute'));
  expect(await screen.findByTestId('sync-partial-writes')).toHaveTextContent('k:x.gguf: failed after a partial write');
  expect(screen.getByText('disk full')).toBeVisible();
  expect(screen.getByTestId('sync-result-headline')).toHaveTextContent('Sync did not complete');
  expect(screen.queryByText('Sync finished.')).toBeNull();
});

test('when every view was skipped or refused, there is no success text', async () => {
  const { user } = renderSync({}, {
    executeSync: vi.fn(() => Promise.resolve(ok<SyncResultDTO>({
      ok: false, massRemovalViews: ['lmstudio'], views: [vres({ status: 'refused-mass-removal', created: 0, error: 'refused' })],
    }))),
  });
  await user.click(await screen.findByTestId('btn-sync-execute'));
  expect(await screen.findByTestId('sync-mass-refused')).toHaveTextContent('LM Studio');
  expect(screen.queryByText('Sync finished.')).toBeNull();
});

test('a run that did nothing at all says nothing was changed', async () => {
  const { user } = renderSync({}, { executeSync: vi.fn(() => Promise.resolve(ok<SyncResultDTO>({ ok: false, views: [], massRemovalViews: [] }))) });
  await user.click(await screen.findByTestId('btn-sync-execute'));
  expect(await screen.findByText('Sync did not run: nothing was changed.')).toBeVisible();
});

test('an expired or voided preview leads back to a fresh preview', async () => {
  const planSync = vi.fn(() => Promise.resolve(ok({ ...SYNC })));
  const executeSync = vi.fn()
    .mockResolvedValueOnce(fail('UNKNOWN_PLAN', 'Preview expired — the cache changed; preview Sync again.'))
    .mockResolvedValue(ok<SyncResultDTO>({ ok: true, views: [vres()], massRemovalViews: [] }));
  const { user } = renderSync({}, { planSync, executeSync });
  await user.click(await screen.findByTestId('btn-sync-execute'));
  expect(await screen.findByText('Preview expired — the cache changed; preview Sync again.')).toBeVisible();
  await user.click(await screen.findByTestId('btn-sync-again'));
  await waitFor(() => expect(planSync).toHaveBeenCalledTimes(2));
  await user.click(await screen.findByTestId('btn-sync-execute'));
  await screen.findByTestId('sync-result');
  expect(executeSync).toHaveBeenCalledTimes(2);
});

test('INTERNAL errors are generic with a details toggle', async () => {
  const { user } = renderSync({}, { executeSync: vi.fn(() => Promise.reject(new Error('EIO raw'))) });
  await user.click(await screen.findByTestId('btn-sync-execute'));
  const note = await screen.findByTestId('sync-error');
  expect(note).toHaveTextContent('Something went wrong inside the app.');
  expect(note).not.toHaveTextContent('EIO raw');
  await user.click(within(note).getByRole('button', { name: 'Details' }));
  expect(screen.getByTestId('sync-error-details')).toHaveTextContent('EIO raw');
});

test('Cancel closes the dialog', async () => {
  const { user, onClose } = renderSync();
  await user.click(await screen.findByTestId('btn-sync-close'));
  expect(onClose).toHaveBeenCalled();
});

// ---- edge cases ---------------------------------------------------------------------------------------------------

test('Preview again resets the mass-removal consent', async () => {
  const wipe = view({ wouldRemoveAll: true, ownedCount: 1, removals: [{ key: 'k', paths: ['/p'], fullPaths: ['/p'], note: null }] });
  const executeSync = vi.fn(() => Promise.resolve(fail('UNKNOWN_PLAN', 'Preview expired — the cache changed; preview Sync again.')));
  const { user, api } = renderSync({ views: [wipe] }, { executeSync });
  await user.click(await screen.findByTestId('mass-removal-checkbox'));
  await user.click(screen.getByTestId('btn-sync-execute'));
  await user.click(await screen.findByTestId('btn-sync-again'));
  await waitFor(() => expect(api.planSync).toHaveBeenCalledTimes(2));
  const box = await screen.findByTestId('mass-removal-checkbox');
  expect(box).not.toBeChecked();
  expect(screen.getByTestId('btn-sync-execute')).toBeDisabled();
});

test.each(['BUSY', 'CONFIG', 'HUB_MISSING'] as const)('%s on execute offers Preview again as well as Cancel', async (code) => {
  const executeSync = vi.fn(() => Promise.resolve<ApiResult<never>>({ ok: false, error: { code, message: `${code} text` } }));
  const { user } = renderSync({}, { executeSync });
  await user.click(await screen.findByTestId('btn-sync-execute'));
  expect(await screen.findByText(`${code} text`)).toBeVisible();
  expect(screen.getByTestId('btn-sync-again')).toBeVisible();
  expect(screen.getByTestId('btn-sync-close')).toBeVisible();
});

test('a voided preview is recognised by its code, not its wording', async () => {
  const executeSync = vi.fn(() => Promise.resolve(fail('STALE' as 'EXPIRED', 'something else entirely')));
  const { user } = renderSync({}, { executeSync });
  await user.click(await screen.findByTestId('btn-sync-execute'));
  expect(await screen.findByTestId('btn-sync-again')).toBeVisible();
});

test('reopening the dialog never shows the previous result', async () => {
  function Host() {
    const [open, setOpen] = useState(true);
    return <><button data-testid="toggle" onClick={() => setOpen((o) => !o)}>t</button><SyncDialog open={open} onClose={() => undefined} /></>;
  }
  const api = makeFakeApi({
    planSync: vi.fn(() => Promise.resolve(ok({ ...SYNC }))),
    executeSync: vi.fn(() => Promise.resolve(ok<SyncResultDTO>({ ok: true, views: [vres()], massRemovalViews: [] }))),
  });
  renderWithProviders(<Host />, api);
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('btn-sync-execute'));
  await screen.findByTestId('sync-result');
  act(() => screen.getByTestId('toggle').click());   // close
  expect(screen.queryByTestId('sync-dialog')).toBeNull();
  act(() => screen.getByTestId('toggle').click());   // reopen: the very first paint is a fresh state
  expect(screen.queryByTestId('sync-result')).toBeNull();
  await screen.findByTestId('btn-sync-execute');
});

test('each sync path shows the view-relative label and, below it, the full absolute path as visible text', async () => {
  renderSync({
    views: [view({
      adds: [{ key: 'o/r:a.gguf', paths: ['o/r/a.gguf'], fullPaths: ['/home/u/.lmstudio/models/o/r/a.gguf'], note: null }],
      removals: [{ key: 'gone:x', paths: ['blobs/sha256-aa', 'manifests/x'], fullPaths: ['/home/u/.ollama/models/blobs/sha256-aa', '/home/u/.ollama/models/manifests/x'], note: null }],
    })],
  });
  const add = await screen.findByTestId('sync-add');
  expect(within(add).getByText('o/r/a.gguf')).toBeVisible();
  const full = within(add).getByText('/home/u/.lmstudio/models/o/r/a.gguf');
  expect(full).toBeVisible();
  expect(full).toHaveClass('font-mono');
  const removal = screen.getByTestId('sync-removal');
  for (const p of ['blobs/sha256-aa', 'manifests/x', '/home/u/.ollama/models/blobs/sha256-aa', '/home/u/.ollama/models/manifests/x']) {
    expect(within(removal).getByText(p)).toBeVisible();
  }
  // the full path follows its own label (label, full, label, full)
  expect(within(removal).getAllByText(/sha256-aa|manifests\/x/).map((e) => e.textContent))
    .toEqual(['blobs/sha256-aa', '/home/u/.ollama/models/blobs/sha256-aa', 'manifests/x', '/home/u/.ollama/models/manifests/x']);
});
