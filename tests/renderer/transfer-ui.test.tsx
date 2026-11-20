// The transfer UI in jsdom. Substitute: the main process (`window.api`), which a jsdom test cannot reach; every call
// below goes to the fake API of fake-api.tsx. These are tests of the components, not of export, load or any drive.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { Selection } from '../../src/core/types';
import { App } from '../../src/renderer/App';
import { ActionBar } from '../../src/renderer/components/ActionBar';
import { DownloadsDrawer } from '../../src/renderer/components/DownloadsDrawer';
import { ExportDialog, NO_DRIVE_TEXT } from '../../src/renderer/components/ExportDialog';
import { LoadFromDrive, NO_EXPORTS_TEXT } from '../../src/renderer/components/LoadFromDrive';
import { useDownloadSelection } from '../../src/renderer/state/download-selection';
import { useDownloads } from '../../src/renderer/state/downloads';
import { useExports } from '../../src/renderer/state/exports';
import { useSelection } from '../../src/renderer/state/selection';
import { useSessionLog } from '../../src/renderer/state/session-log';
import type { ApiResult, ExportDTO, ExportPreviewDTO, TransferDriveDTO, TransferRepoDTO, TransferVolumeDTO } from '../../src/shared/api';
import { HUB_LOOKUP, hubAdvice, makeFakeApi, renderWithProviders } from './fake-api';

beforeEach(() => {
  expect.hasAssertions();
  useSelection.getState().clear();
  useDownloadSelection.getState().clear();
  useExports.getState().setItems([]);
  useDownloads.getState().setItems([], null);
});

const ok = <T,>(data: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, data });
const GB = 1_000_000_000;
const USB: TransferVolumeDTO = { id: 'aaaaaaaaaaaaaaaa', name: 'E:', totalBytes: 64 * GB, freeBytes: 40 * GB, hasTransfer: true };
const EMPTY_USB: TransferVolumeDTO = { id: 'bbbbbbbbbbbbbbbb', name: 'F:', totalBytes: 32 * GB, freeBytes: 30 * GB, hasTransfer: false };
const SEL: Selection = { repos: [{ repoId: 'unsloth/Qwen3.6-27B-GGUF', whole: true }] };
const PREVIEW: ExportPreviewDTO = {
  previewId: '11111111-1111-4111-8111-111111111111', volumeName: 'E:', repos: 1, files: 3, requiresBytes: 20 * GB, freeBytes: 40 * GB,
  fits: true, reason: null, skipped: [],
};
const REPO: TransferRepoDTO = {
  key: `model:unsloth/Qwen3.6-27B-GGUF@${'c'.repeat(40)}`, repoId: 'unsloth/Qwen3.6-27B-GGUF', type: 'model', commitShort: 'cccccccc', ref: 'main',
  exportedAtMs: 1, bytes: 20 * GB, files: 3, incompleteFiles: 0,
};
const DRIVE: TransferDriveDTO = { volume: USB, repos: [REPO], notes: [] };

// ------------------------------------------------------------------------------------------------- ExportDialog

test('ExportDialog: with no drive it says so and Export stays off; Refresh searches again', async () => {
  const transferVolumes = vi.fn(() => ok<TransferVolumeDTO[]>([]));
  const user = userEvent.setup();
  renderWithProviders(<ExportDialog selection={SEL} onClose={vi.fn()} onStarted={vi.fn()} />, makeFakeApi({ transferVolumes }));
  expect(await screen.findByTestId('export-no-drive')).toHaveTextContent(NO_DRIVE_TEXT);
  expect(screen.getByTestId('export-start')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(transferVolumes).toHaveBeenCalledTimes(2));
});

test('ExportDialog: closed while there is no selection (nothing is asked of main)', () => {
  const transferVolumes = vi.fn(() => ok<TransferVolumeDTO[]>([USB]));
  renderWithProviders(<ExportDialog selection={null} onClose={vi.fn()} onStarted={vi.fn()} />, makeFakeApi({ transferVolumes }));
  expect(screen.queryByTestId('export-dialog')).toBeNull();
  expect(transferVolumes).not.toHaveBeenCalled();
});

test('ExportDialog: the only drive is chosen, its preview is shown, and Export starts that preview', async () => {
  const exportPreview = vi.fn(() => ok(PREVIEW));
  const exportStart = vi.fn(() => ok({ id: 'ex1' }));
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(<ExportDialog selection={SEL} onClose={onClose} onStarted={onStarted} />,
    makeFakeApi({ transferVolumes: () => ok([USB]), exportPreview, exportStart }));
  expect(await screen.findByTestId('export-preview')).toHaveTextContent('3 files to copy · needs 20.0 GB · 40.0 GB free on E:');
  expect(exportPreview).toHaveBeenCalledWith(SEL, USB.id);
  expect(screen.getByTestId('export-volume')).toHaveTextContent('40.0 GB free of 64.0 GB');
  expect(screen.getByTestId('export-volume')).toHaveTextContent('has exports');
  const start = screen.getByTestId('export-start');
  expect(start).toHaveTextContent('Export 20.0 GB');
  await user.click(start);
  expect(exportStart).toHaveBeenCalledWith(PREVIEW.previewId);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onStarted).toHaveBeenCalledTimes(1);
});

test('ExportDialog: with two drives none is chosen until the user picks one', async () => {
  const exportPreview = vi.fn(() => ok({ ...PREVIEW, volumeName: 'F:' }));
  const user = userEvent.setup();
  renderWithProviders(<ExportDialog selection={SEL} onClose={vi.fn()} onStarted={vi.fn()} />,
    makeFakeApi({ transferVolumes: () => ok([USB, EMPTY_USB]), exportPreview }));
  const rows = await screen.findAllByTestId('export-volume');
  expect(rows).toHaveLength(2);
  expect(exportPreview).not.toHaveBeenCalled();
  expect(screen.getByTestId('export-start')).toBeDisabled();
  await user.click(within(rows[1]!).getByRole('radio'));
  await screen.findByTestId('export-preview');
  expect(exportPreview).toHaveBeenCalledWith(SEL, EMPTY_USB.id);
});

test('ExportDialog: a selection that does not fit shows why and cannot be started', async () => {
  const reason = 'The selected models need 20.0 GB on E:, but only 4.00 GB is free. They will not fit.';
  renderWithProviders(<ExportDialog selection={SEL} onClose={vi.fn()} onStarted={vi.fn()} />, makeFakeApi({
    transferVolumes: () => ok([USB]), exportPreview: () => ok({ ...PREVIEW, freeBytes: 4 * GB, fits: false, reason }),
  }));
  expect(await screen.findByTestId('export-reason')).toHaveTextContent(reason);
  expect(screen.getByRole('alert')).toHaveTextContent('They will not fit.');
  expect(screen.getByTestId('export-start')).toBeDisabled();
});

test('ExportDialog: files that cannot be exported are listed; a refused start shows its message and stays open', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(<ExportDialog selection={SEL} onClose={onClose} onStarted={vi.fn()} />, makeFakeApi({
    transferVolumes: () => ok([USB]),
    exportPreview: () => ok({ ...PREVIEW, skipped: ['org/a: x.bin (its data is missing from the cache)'] }),
    exportStart: () => Promise.resolve({ ok: false, error: { code: 'BUSY', message: 'An export is already running — wait for it to finish or cancel it.' } }),
  }));
  expect(await screen.findByTestId('export-skipped')).toHaveTextContent('1 file cannot be exported and will be left out:');
  expect(screen.getByTestId('export-skipped')).toHaveTextContent('org/a: x.bin (its data is missing from the cache)');
  await user.click(screen.getByTestId('export-start'));
  expect(await screen.findByTestId('export-error')).toHaveTextContent('An export is already running');
  expect(onClose).not.toHaveBeenCalled();
});

// ------------------------------------------------------------------------------------------------- LoadFromDrive

test('LoadFromDrive: drives without exports do not count; with none it says so', async () => {
  renderWithProviders(<LoadFromDrive activeKey={null} onOpen={vi.fn()} onBack={vi.fn()} />, makeFakeApi({ transferVolumes: () => ok([EMPTY_USB]) }));
  expect(await screen.findByTestId('drive-none')).toHaveTextContent(NO_EXPORTS_TEXT);
});

test('LoadFromDrive: the one drive with exports is opened at once and its models can be chosen', async () => {
  const transferDrive = vi.fn(() => ok(DRIVE));
  const onOpen = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(<LoadFromDrive activeKey={null} onOpen={onOpen} onBack={vi.fn()} />,
    makeFakeApi({ transferVolumes: () => ok([EMPTY_USB, USB]), transferDrive }));
  const row = await screen.findByTestId('drive-repo');
  expect(transferDrive).toHaveBeenCalledWith(USB.id);
  expect(row).toHaveTextContent('unsloth/Qwen3.6-27B-GGUF');
  expect(row).toHaveTextContent('20.0 GB · 3 files · main');
  expect(screen.getByTestId('drive-name')).toHaveTextContent('On E:');
  await user.click(row);
  expect(onOpen).toHaveBeenCalledWith(USB.id, REPO);
});

test('LoadFromDrive: two drives with exports are listed to choose from; incomplete files and notes are shown', async () => {
  const other: TransferVolumeDTO = { ...USB, id: 'cccccccccccccccc', name: 'G:' };
  const transferDrive = vi.fn((id: string) => ok<TransferDriveDTO>({
    volume: id === other.id ? other : USB, notes: ['1 export record on the drive could not be read and was left out.'],
    repos: [{ ...REPO, incompleteFiles: 2 }, { ...REPO, key: `model:org/empty@${'d'.repeat(40)}`, repoId: 'org/empty', files: 0, bytes: 0, incompleteFiles: 1 }],
  }));
  const user = userEvent.setup();
  renderWithProviders(<LoadFromDrive activeKey={null} onOpen={vi.fn()} onBack={vi.fn()} />, makeFakeApi({ transferVolumes: () => ok([USB, other]), transferDrive }));
  const drives = await screen.findAllByTestId('drive-volume');
  expect(drives.map((d) => d.textContent)).toEqual([expect.stringContaining('E:'), expect.stringContaining('G:')]);
  expect(transferDrive).not.toHaveBeenCalled();
  await user.click(drives[1]!);
  const rows = await screen.findAllByTestId('drive-repo');
  expect(transferDrive).toHaveBeenCalledWith(other.id);
  expect(rows[0]).toHaveTextContent('2 files are incomplete on the drive and cannot be loaded');
  expect(rows[1]).toBeDisabled();
  expect(screen.getByTestId('drive-note')).toHaveTextContent('could not be read');
});

test('LoadFromDrive: a drive that went away shows the refusal; Back calls onBack', async () => {
  const onBack = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(<LoadFromDrive activeKey={null} onOpen={vi.fn()} onBack={onBack} />, makeFakeApi({ transferVolumes: () => ok([USB]) }));
  expect(await screen.findByTestId('drive-error')).toHaveTextContent('That drive is no longer connected. Choose a drive again.');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalledTimes(1);
});

// ------------------------------------------------------------------------------------------------- in the app

test('Download mode: Load from USB lists the drive, opens a model as a look-up, and the footer says Load', async () => {
  const transferOpen = vi.fn(() => ok({ ...HUB_LOOKUP, advice: hubAdvice(HUB_LOOKUP, false) }));
  const hubLookup = vi.fn(makeFakeApi().hubLookup);
  const downloadStart = vi.fn(() => ok({ id: 'dl1' }));
  const user = userEvent.setup();
  renderWithProviders(<App />, makeFakeApi({ transferVolumes: () => ok([USB]), transferDrive: () => ok(DRIVE), transferOpen, hubLookup, downloadStart }));
  await user.click(screen.getByRole('button', { name: 'Download' }));
  expect(screen.getByText('Recent look-ups')).toBeInTheDocument();
  await user.click(screen.getByTestId('btn-load-usb'));
  expect(screen.queryByText('Recent look-ups')).toBeNull();
  await user.click(await screen.findByTestId('drive-repo'));
  expect(transferOpen).toHaveBeenCalledWith(USB.id, REPO.key);
  expect(hubLookup).not.toHaveBeenCalled();
  await screen.findAllByTestId('dl-row');
  expect(screen.getByTestId('lookup-from-drive')).toHaveTextContent('from drive');
  expect(screen.getByTestId('drive-repo')).toHaveAttribute('aria-current', 'true');
  const box = document.querySelector('[data-group-key="quant:UD-Q4_K_XL"] [data-testid="dl-checkbox"]') as HTMLElement;
  await user.click(box);
  await waitFor(() => expect(screen.getByTestId('download-button')).toBeEnabled());
  expect(screen.getByTestId('download-button')).toHaveTextContent('Load 17.6 GB');
  await user.click(screen.getByTestId('download-button'));
  await waitFor(() => expect(downloadStart).toHaveBeenCalledTimes(1));
  // Back brings the recent look-ups back; the opened model stays shown
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByText('Recent look-ups')).toBeInTheDocument();
  expect(screen.getAllByTestId('dl-row').length).toBeGreaterThan(0);
});

test('Library: Export to drive appears with a selection and hands the selection on', async () => {
  const onExport = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} onExport={onExport} />);
  expect(screen.queryByTestId('btn-export')).toBeNull();
  act(() => { useSelection.getState().toggleGroup('unsloth/Qwen3.6-27B-GGUF', 'quant:Q8_0', false); });
  await waitFor(() => expect(screen.getByTestId('btn-export')).toBeEnabled());
  await user.click(screen.getByTestId('btn-export'));
  expect(onExport).toHaveBeenCalledWith({ repos: [{ repoId: 'unsloth/Qwen3.6-27B-GGUF', whole: false, groupKeys: ['quant:Q8_0'], unlockComponents: false }] });
});

test('Library: without onExport the action bar has no export button', async () => {
  renderWithProviders(<ActionBar onReview={vi.fn()} onEmptyHeld={vi.fn()} />);
  act(() => { useSelection.getState().toggleGroup('unsloth/Qwen3.6-27B-GGUF', 'quant:Q8_0', false); });
  await waitFor(() => expect(screen.getByTestId('btn-review')).toBeEnabled());
  expect(screen.queryByTestId('btn-export')).toBeNull();
});

// ------------------------------------------------------------------------------------------------- progress

const EXPORT: ExportDTO = {
  id: '22222222-2222-4222-8222-222222222222', volumeName: 'E:', repoIds: ['unsloth/Qwen3.6-27B-GGUF'], status: 'running', message: null,
  bytes: 5 * GB, totalBytes: 20 * GB, filesDone: 1, filesTotal: 3, current: 'Qwen3.6-27B-Q8_0.gguf',
};

test('Downloads drawer: a running export shows its progress and can be cancelled; a finished one cannot', async () => {
  const exportCancel = vi.fn(() => ok(null));
  const user = userEvent.setup();
  act(() => { useExports.getState().setItems([EXPORT]); });
  renderWithProviders(<DownloadsDrawer onClose={vi.fn()} />, makeFakeApi({ exportCancel }));
  const item = screen.getByTestId('export-item');
  expect(item).toHaveTextContent('Export to E:');
  expect(item).toHaveTextContent('5.0 GB / 20.0 GB · 1 of 3 files · Copying');
  expect(item).toHaveTextContent('Qwen3.6-27B-Q8_0.gguf');
  await user.click(within(item).getByRole('button', { name: 'Cancel' }));
  expect(exportCancel).toHaveBeenCalledWith(EXPORT.id);
  act(() => { useExports.getState().apply({ ...EXPORT, status: 'failed', current: null, message: 'The drive is full.' }); });
  expect(screen.getByTestId('export-state')).toHaveTextContent('Failed');
  expect(screen.getByTestId('export-message')).toHaveTextContent('The drive is full.');
  expect(within(screen.getByTestId('export-item')).queryByRole('button', { name: 'Cancel' })).toBeNull();
});

test('Downloads drawer: a download loaded from a drive is marked', () => {
  act(() => {
    useDownloads.getState().setItems([{
      id: 'd1', repoId: 'org/a', type: 'model', revision: 'main', commit: 'c'.repeat(40), fromDrive: true,
      files: [{ path: 'a.gguf', size: 10, state: 'done', bytes: 10, error: null }],
    }], null);
  });
  renderWithProviders(<DownloadsDrawer onClose={vi.fn()} />);
  expect(screen.getByTestId('download-from-drive')).toHaveTextContent('from drive');
});

test('App: export events fill the list; the end of an export is announced once', async () => {
  let emit: (e: ExportDTO) => void = () => undefined;
  const api = makeFakeApi({ onExportProgress: (cb) => { emit = cb; return () => undefined; } });
  renderWithProviders(<App />, api);
  await waitFor(() => expect(emit).not.toBe(undefined));
  act(() => { emit(EXPORT); });
  expect(useExports.getState().items).toEqual([EXPORT]);
  act(() => { emit({ ...EXPORT, status: 'done', bytes: 20 * GB, filesDone: 3, current: null }); });
  act(() => { emit({ ...EXPORT, status: 'done', bytes: 20 * GB, filesDone: 3, current: null }); });
  expect(useExports.getState().items[0]!.status).toBe('done');
  // Announced once (the session log; the toast host is not mounted in this test), though the event came twice
  expect(useSessionLog.getState().entries.filter((x) => x.text === 'Exported to E:: unsloth/Qwen3.6-27B-GGUF')).toHaveLength(1);
});
