import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { RepoDetail } from '../../src/renderer/components/RepoDetail';
import { useSelection } from '../../src/renderer/state/selection';
import type { FileEntryDTO, LibraryDTO, RepoDetailDTO } from '../../src/shared/api';
import { FLUX_DETAIL, LIBRARY, QWEN_DETAIL, group, makeFakeApi, renderWithProviders } from './fake-api';

const selectedKeys = (): string[] => Object.values(useSelection.getState().byRepo).flatMap((v) => v.groupKeys);

beforeEach(() => {
  expect.hasAssertions();
  useSelection.getState().clear();
});

const FLUX = 'black-forest-labs/FLUX.1-dev';
const detailApi = (d: RepoDetailDTO, lib: Partial<LibraryDTO> = {}) =>
  makeFakeApi({
    repoDetail: () => Promise.resolve({ ok: true, data: d }),
    scan: () => Promise.resolve({ ok: true, data: { ...LIBRARY, ...lib } }),
  });
const rowFor = (key: string): HTMLElement => {
  const el = screen.getAllByTestId('group-row').find((r) => r.getAttribute('data-group-key') === key);
  if (!el) throw new Error(`no row ${key}`);
  return el;
};

test('locked component rows have no checkbox until unlocked with the warning', async () => {
  const user = userEvent.setup();
  renderWithProviders(<RepoDetail repoId={FLUX} onDeleteWholeRepo={vi.fn()} />, detailApi(FLUX_DETAIL));
  await screen.findAllByTestId('group-row');
  const vae = rowFor('component:vae/');
  expect(within(vae).queryByRole('checkbox')).toBeNull();
  expect(within(vae).getByLabelText('Locked component')).toBeVisible();
  expect(within(rowFor('root-file:flux1-dev.safetensors')).getByRole('checkbox')).toBeEnabled();
  await user.click(screen.getByTestId('unlock-toggle'));
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'Removing a component breaks the pipeline. Diffusers will fail to load this model until the component is downloaded again.',
  );
  await user.click(screen.getByRole('button', { name: 'Unlock' }));
  await user.click(within(vae).getByRole('checkbox'));
  expect(useSelection.getState().toSelection()!.repos[0]).toMatchObject({ groupKeys: ['component:vae/'], unlockComponents: true });
});

test('cancelling the unlock warning keeps rows locked', async () => {
  const user = userEvent.setup();
  renderWithProviders(<RepoDetail repoId={FLUX} onDeleteWholeRepo={vi.fn()} />, detailApi(FLUX_DETAIL));
  await screen.findAllByTestId('group-row');
  await user.click(screen.getByTestId('unlock-toggle'));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(within(rowFor('component:vae/')).queryByRole('checkbox')).toBeNull();
  expect(useSelection.getState().toSelection()).toBeNull();
});

test('the locked flag comes from the group DTO: locking again drops a selected component', async () => {
  const user = userEvent.setup();
  renderWithProviders(<RepoDetail repoId={FLUX} onDeleteWholeRepo={vi.fn()} />, detailApi(FLUX_DETAIL));
  await screen.findAllByTestId('group-row');
  await user.click(screen.getByTestId('unlock-toggle'));
  await user.click(screen.getByRole('button', { name: 'Unlock' }));
  await user.click(within(rowFor('component:vae/')).getByRole('checkbox'));
  await user.click(within(rowFor('root-file:flux1-dev.safetensors')).getByRole('checkbox'));
  await user.click(screen.getByTestId('unlock-toggle'));
  expect(within(rowFor('component:vae/')).queryByRole('checkbox')).toBeNull();
  expect(useSelection.getState().toSelection()!.repos[0]).toMatchObject({
    groupKeys: ['root-file:flux1-dev.safetensors'], unlockComponents: false,
  });
});

test('unlock toggle is absent when no group is locked', async () => {
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, detailApi(QWEN_DETAIL));
  await screen.findAllByTestId('group-row');
  expect(screen.queryByTestId('unlock-toggle')).toBeNull();
});

const files: FileEntryDTO[] = [
  { relpath: 'Q8_0/model-00001-of-00002.gguf', commitShort: 'a3f9c1e', current: true, bytes: 14_000_000_000, plainFile: false },
  { relpath: 'Q8_0/model-00002-of-00002.gguf', commitShort: '9d8c7b6', current: false, bytes: 14_700_000_000, plainFile: false },
];
const withFiles: RepoDetailDTO = {
  ...QWEN_DETAIL,
  groups: QWEN_DETAIL.groups.map((g) => (g.key === 'quant:Q8_0' ? { ...g, files, fileCount: 2, shards: { present: 2, expected: 2 } } : g)),
};

test('a row expands to its exact files; superseded files show older revision', async () => {
  const user = userEvent.setup();
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, detailApi(withFiles));
  await screen.findAllByTestId('group-row');
  const row = rowFor('quant:Q8_0');
  expect(screen.queryByText('Q8_0/model-00001-of-00002.gguf')).toBeNull();
  await user.click(within(row).getByTestId('group-expand'));
  expect(within(row).getByTestId('group-expand')).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Q8_0/model-00001-of-00002.gguf')).toBeVisible();
  expect(screen.getByText('Q8_0/model-00002-of-00002.gguf')).toBeVisible();
  expect(screen.getByText('9d8c7b6')).toBeVisible();
  expect(screen.getAllByText('older revision')).toHaveLength(1);
  expect(screen.getByText('14.0 GB')).toBeVisible();
  await user.click(within(row).getByTestId('group-expand'));
  expect(screen.queryByText('Q8_0/model-00001-of-00002.gguf')).toBeNull();
});

test('the label column header is Quant', async () => {
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, detailApi(QWEN_DETAIL));
  await screen.findAllByTestId('group-row');
  expect(screen.getByRole('columnheader', { name: 'Quant' })).toBeVisible();
});

test('header shows repo id, kind, revision, date; Delete entire repo… calls back with the repoId', async () => {
  const user = userEvent.setup();
  const onDelete = vi.fn();
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={onDelete} />, detailApi(QWEN_DETAIL));
  await screen.findAllByTestId('group-row');
  const header = screen.getByTestId('repo-detail-header');
  expect(header).toHaveTextContent('unsloth/Qwen3.6-27B-GGUF');
  expect(header).toHaveTextContent('GGUF quant collection');
  expect(header).toHaveTextContent('revision main (a3f9c1e)');
  expect(header).toHaveTextContent('2026-09-02');
  await user.click(screen.getByTestId('btn-delete-repo'));
  expect(onDelete).toHaveBeenCalledWith('unsloth/Qwen3.6-27B-GGUF');
});

test('columns: label tags, files, used by, reclaimable with the apparent size in a tooltip', async () => {
  const user = userEvent.setup();
  const partial: RepoDetailDTO = {
    ...QWEN_DETAIL,
    groups: QWEN_DETAIL.groups.map((g) => (g.key === 'quant:BF16' ? { ...g, shards: { present: 1, expected: 2 } } : g)),
  };
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, detailApi(partial));
  await screen.findAllByTestId('group-row');
  expect(within(rowFor('quant:BF16')).getByText('partial (1/2)')).toBeVisible();
  expect(rowFor('quant:BF16')).toHaveTextContent('1 shard');
  expect(rowFor('quant:Q8_0')).toHaveTextContent('1 file');
  expect(within(rowFor('mmproj:mmproj-F16')).getByText('vision')).toBeVisible();
  expect(rowFor('quant:UD-Q4_K_XL')).toHaveTextContent('LM Studio · Ollama');
  expect(rowFor('quant:Q8_0')).toHaveTextContent('LM Studio');
  expect(rowFor('quant:Q8_0')).not.toHaveTextContent('Ollama');
  expect(rowFor('quant:BF16')).toHaveTextContent('—');
  const rec = within(rowFor('quant:Q8_0')).getByTestId('group-reclaimable');
  expect(rec).toHaveTextContent('28.7 GB');
  await user.hover(rec);
  expect((await screen.findAllByText(/Apparent size 28\.7 GB/))[0]).toBeInTheDocument();
});

test("reclaimable null shows can't tell, never a number", async () => {
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, detailApi(QWEN_DETAIL));
  await screen.findAllByTestId('group-row');
  expect(within(rowFor('quant:Q6_K')).getByTestId('group-reclaimable')).toHaveTextContent("can't tell");
});

test('a superseded group shows its warning with an icon', async () => {
  const warn = 'An update may be in progress or incomplete: some of these files are the only copy of files missing from the current revision.';
  const d: RepoDetailDTO = {
    ...QWEN_DETAIL,
    groups: [...QWEN_DETAIL.groups, { ...QWEN_DETAIL.groups[0]!, key: 'superseded:', kind: 'superseded', label: 'Older revisions', warning: warn }],
  };
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, detailApi(d));
  await screen.findAllByTestId('group-row');
  const w = within(rowFor('superseded:')).getByTestId('group-warning');
  expect(w).toHaveTextContent(warn);
  expect(within(rowFor('quant:Q8_0')).queryByTestId('group-warning')).toBeNull();
});

test('checkbox toggles the selection store', async () => {
  const user = userEvent.setup();
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, detailApi(QWEN_DETAIL));
  await screen.findAllByTestId('group-row');
  const cb = within(rowFor('quant:Q8_0')).getByTestId('group-checkbox');
  await user.click(cb);
  expect(selectedKeys()).toEqual(['quant:Q8_0']);
  await user.click(cb);
  expect(useSelection.getState().toSelection()).toBeNull();
});

test('ambiguous ids are shown but cannot be selected, with the reason', async () => {
  const user = userEvent.setup();
  const api = detailApi(QWEN_DETAIL, {
    repos: LIBRARY.repos.map((r) => (r.repoId === QWEN_DETAIL.repoId ? { ...r, ambiguous: true } : r)),
  });
  const onDelete = vi.fn();
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={onDelete} />, api);
  await screen.findAllByTestId('group-row');
  await waitFor(() => expect(screen.getByTestId('selection-blocked')).toHaveTextContent(
    'Two repos share this id (model and dataset); deletion is disabled for them in this version.'));
  expect(within(rowFor('quant:Q8_0')).getByTestId('group-checkbox')).toBeDisabled();
  expect(screen.getByTestId('btn-delete-repo')).toBeDisabled();
  await user.click(within(rowFor('quant:Q8_0')).getByTestId('group-checkbox'));
  expect(useSelection.getState().toSelection()).toBeNull();
});

test('an id the schema cannot carry is unselectable with a note', async () => {
  const id = 'a/b/c';
  renderWithProviders(<RepoDetail repoId={id} onDeleteWholeRepo={vi.fn()} />, detailApi({ ...QWEN_DETAIL, repoId: id }));
  await screen.findAllByTestId('group-row');
  expect(screen.getByTestId('selection-blocked')).toHaveTextContent('This repo id cannot be selected in this version.');
  expect(within(rowFor('quant:Q8_0')).getByTestId('group-checkbox')).toBeDisabled();
  expect(screen.getByTestId('btn-delete-repo')).toBeDisabled();
});

test('with the cache unreadable, selection is disabled', async () => {
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, detailApi(QWEN_DETAIL, { scanError: 'EACCES' }));
  await screen.findAllByTestId('group-row');
  await waitFor(() => expect(within(rowFor('quant:Q8_0')).getByTestId('group-checkbox')).toBeDisabled());
  expect(screen.getByTestId('btn-delete-repo')).toBeDisabled();
});

test('a failed detail load shows the error message', async () => {
  const api = makeFakeApi({ repoDetail: () => Promise.resolve({ ok: false, error: { code: 'NOT_FOUND', message: 'gone' } }) });
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, api);
  expect(await screen.findByRole('alert')).toHaveTextContent('gone');
});

test('a "Files only in dev" group is listed and selectable like any other group', async () => {
  const user = userEvent.setup();
  const detail: RepoDetailDTO = { ...QWEN_DETAIL, groups: [...QWEN_DETAIL.groups, group('other:Files only in dev', 'other', 'Files only in dev', 4_000_000_000)] };
  renderWithProviders(<RepoDetail repoId={QWEN_DETAIL.repoId} onDeleteWholeRepo={vi.fn()} />, detailApi(detail));
  await screen.findAllByTestId('group-row');
  const row = rowFor('other:Files only in dev');
  expect(row).toHaveTextContent('Files only in dev');
  await user.click(within(row).getByRole('checkbox'));
  expect(selectedKeys()).toEqual(['other:Files only in dev']);
});
