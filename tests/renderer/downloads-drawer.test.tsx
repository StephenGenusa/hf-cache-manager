import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { Toaster, resetToasts } from '../../src/renderer/components/ui/toast';
import { useDownloads } from '../../src/renderer/state/downloads';
import { useSessionLog } from '../../src/renderer/state/session-log';
import type { DownloadDoneDTO, DownloadItemDTO, DownloadProgressDTO } from '../../src/shared/api';
import { makeFakeApi, renderWithProviders } from './fake-api';

const item = (over: Partial<DownloadItemDTO['files'][number]> = {}, id = 'dl1'): DownloadItemDTO => ({
  id, repoId: 'org/model', type: 'model', revision: 'main', commit: 'a'.repeat(40),
  files: [{ path: 'model-Q4_K_M.gguf', size: 10_000_000_000, state: 'paused', bytes: 2_000_000_000, error: null, ...over }],
});
const queue = (items: DownloadItemDTO[]) => () => Promise.resolve({ ok: true as const, data: { items, disabledReason: null, notes: [] } });

beforeEach(() => {
  expect.hasAssertions();
  useDownloads.setState({ items: [], live: {}, disabledReason: null });
  useSessionLog.getState().clear();
  resetToasts();
});

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId('btn-downloads'));
  return { user, drawer: await screen.findByTestId('downloads-drawer') };
}

test('restored items appear paused at startup with the badge count, and Resume calls the API', async () => {
  const resume = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
  renderWithProviders(<App />, makeFakeApi({ downloads: queue([item()]), downloadResume: resume }));
  await waitFor(() => expect(screen.getByTestId('downloads-badge')).toHaveTextContent('1'));
  const { user, drawer } = await open();
  expect(within(drawer).getByTestId('download-state')).toHaveTextContent('Paused');
  expect(drawer).toHaveTextContent('2.0 GB / 10.0 GB');
  await user.click(within(drawer).getByRole('button', { name: 'Resume' }));
  expect(resume).toHaveBeenCalledWith('dl1');
});

test('progress shows bytes, speed and time left (throttled), and Pause calls the API', async () => {
  let push: (p: DownloadProgressDTO) => void = () => undefined;
  const pause = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
  renderWithProviders(<App />, makeFakeApi({
    downloads: queue([item({ state: 'downloading' })]), downloadPause: pause,
    onDownloadProgress: (cb) => { push = cb; return () => undefined; },
  }));
  await waitFor(() => expect(screen.getByTestId('downloads-badge')).toBeInTheDocument());
  const { user, drawer } = await open();
  act(() => push({ id: 'dl1', path: 'model-Q4_K_M.gguf', state: 'downloading', bytes: 5_000_000_000, size: 10_000_000_000, bytesPerSec: 100_000_000, error: null }));
  await waitFor(() => expect(drawer).toHaveTextContent('5.0 GB / 10.0 GB'));
  expect(drawer).toHaveTextContent('100.0 MB/s');
  expect(drawer).toHaveTextContent('50 s left');
  await user.click(within(drawer).getByRole('button', { name: 'Pause' }));
  expect(pause).toHaveBeenCalledWith('dl1');
});

test.each([
  ['waiting-other', 'Another program is downloading this file — waiting'],
  ['paused-disk', 'Paused: disk nearly full'],
] as const)('%s shows its reason', async (state, text) => {
  renderWithProviders(<App />, makeFakeApi({ downloads: queue([item({ state })]) }));
  await waitFor(() => expect(screen.getByTestId('downloads-badge')).toBeInTheDocument());
  const { drawer } = await open();
  expect(within(drawer).getByTestId('download-state')).toHaveTextContent(text);
});

test('a failed file shows its error with the path and Retry resumes', async () => {
  const resume = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
  renderWithProviders(<App />, makeFakeApi({ downloads: queue([item({ state: 'failed', error: 'Cannot write /data/models/hub/x.incomplete' })]), downloadResume: resume }));
  await waitFor(() => expect(screen.getByTestId('downloads-badge')).toBeInTheDocument());
  const { user, drawer } = await open();
  expect(within(drawer).getByTestId('download-error')).toHaveTextContent('Cannot write /data/models/hub/x.incomplete');
  await user.click(within(drawer).getByRole('button', { name: 'Retry' }));
  expect(resume).toHaveBeenCalledWith('dl1');
});

test('Cancel asks first and only then calls the API', async () => {
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
  renderWithProviders(<App />, makeFakeApi({ downloads: queue([item()]), downloadCancel: cancel }));
  await waitFor(() => expect(screen.getByTestId('downloads-badge')).toBeInTheDocument());
  const { user, drawer } = await open();
  await user.click(within(drawer).getByRole('button', { name: 'Cancel' }));
  expect(cancel).not.toHaveBeenCalled();
  expect(drawer).toHaveTextContent('Cancel this download? The partial file stays on disk.');
  await user.click(within(drawer).getByRole('button', { name: 'Cancel download' }));
  expect(cancel).toHaveBeenCalledWith('dl1');
});

test('downloadDone invalidates the library, logs it and toasts an offer that opens the Sync preview', async () => {
  let done: (d: DownloadDoneDTO) => void = () => undefined;
  let scans = 0;
  const base = makeFakeApi();
  const user = userEvent.setup();
  renderWithProviders(<Toaster><App /></Toaster>, makeFakeApi({
    scan: () => { scans++; return base.scan(); },
    onDownloadDone: (cb) => { done = cb; return () => undefined; },
  }));
  await waitFor(() => expect(scans).toBe(1));
  act(() => done({ id: 'dl1', repoId: 'org/model', type: 'model' }));
  expect(await screen.findByText('Downloaded org/model. Sync LM Studio + Ollama?')).toBeInTheDocument();
  await waitFor(() => expect(scans).toBe(2));
  expect(useSessionLog.getState().entries.map((e) => e.text)).toContain('Downloaded org/model');
  expect(screen.queryByRole('dialog')).toBeNull();   // the Sync preview opens only on the button
  await user.click(screen.getByRole('button', { name: 'Open Sync preview' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
});

test('Escape closes the drawer and focus goes back to the Downloads button', async () => {
  renderWithProviders(<App />, makeFakeApi({ downloads: queue([item()]) }));
  await waitFor(() => expect(screen.getByTestId('downloads-badge')).toBeInTheDocument());
  const { user } = await open();
  expect(screen.getByTestId('btn-downloads')).toHaveFocus();
  await user.click(screen.getByTestId('downloads-drawer'));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByTestId('downloads-drawer')).toBeNull());
  expect(screen.getByTestId('btn-downloads')).toHaveFocus();
});

test('a done file shows its note (a ref left as it was, a partial file left behind)', async () => {
  const note = 'refs/main was moved by another download meanwhile; not changed';
  renderWithProviders(<App />, makeFakeApi({ downloads: queue([item({ state: 'done', bytes: 10_000_000_000, error: note }), item({ state: 'paused' }, 'dl2')]) }));
  await waitFor(() => expect(screen.getByTestId('downloads-badge')).toBeInTheDocument());
  const { drawer } = await open();
  expect(within(drawer).getByTestId('download-note')).toHaveTextContent(note);
  expect(within(drawer).queryByTestId('download-error')).toBeNull();
});

test('a finished download has no Cancel: Clear drops it from the list at once (nothing on disk changes)', async () => {
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
  renderWithProviders(<App />, makeFakeApi({ downloads: queue([item({ state: 'done', bytes: 10_000_000_000 })]), downloadCancel: cancel }));
  const { user, drawer } = await open();
  await within(drawer).findByTestId('download-item');
  expect(within(drawer).queryByRole('button', { name: 'Cancel' })).toBeNull();
  await user.click(within(drawer).getByRole('button', { name: 'Clear' }));
  expect(within(drawer).queryByRole('alertdialog')).toBeNull();
  expect(cancel).toHaveBeenCalledWith('dl1');
});

test('an unfinished download has Cancel and no Clear', async () => {
  renderWithProviders(<App />, makeFakeApi({ downloads: queue([item()]) }));
  const { drawer } = await open();
  await within(drawer).findByTestId('download-item');
  expect(within(drawer).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  expect(within(drawer).queryByRole('button', { name: 'Clear' })).toBeNull();
});
