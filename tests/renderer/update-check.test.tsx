import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { RepoDetail } from '../../src/renderer/components/RepoDetail';
import { RepoList } from '../../src/renderer/components/RepoList';
import type { FileEntryDTO, HfcmApi, RepoDetailDTO, UpdateCheckDTO, UpdateCheckProgressDTO } from '../../src/shared/api';
import { group, makeFakeApi, NO_UPDATE_CHECK, QWEN_DETAIL, renderWithProviders } from './fake-api';

beforeEach(() => expect.hasAssertions());

const Q = 'unsloth/Qwen3.6-27B-GGUF';
const CHECKED_AT = new Date(2026, 10, 20, 9, 5).getTime();
const FOUND: UpdateCheckDTO = {
  ...NO_UPDATE_CHECK, checkedAt: CHECKED_AT,
  results: [
    { repoId: Q, type: 'model', status: 'update', updateFiles: 2, message: null, checkedAt: CHECKED_AT },
    { repoId: 'Qwen/Qwen3-32B', type: 'model', status: 'failed', message: 'Gated: accept the terms on huggingface.co and make sure your token is set', updateFiles: 0, checkedAt: CHECKED_AT },
    { repoId: 'org/partial', type: 'model', status: 'skipped', message: 'Not checked: pinned', updateFiles: 0, checkedAt: CHECKED_AT },
  ],
};
const ids = () => screen.getAllByTestId('repo-row').map((r) => r.getAttribute('data-repo-id'));
const rowOf = (id: string): HTMLElement => {
  const el = screen.getAllByTestId('repo-row').find((r) => r.getAttribute('data-repo-id') === id);
  if (!el) throw new Error(`no row ${id}`);
  return el;
};
const bar = () => screen.getByTestId('update-check');

/** An api whose update-check events the test sends, and whose state the test can change. */
function liveApi(first: UpdateCheckDTO = NO_UPDATE_CHECK, over: Partial<HfcmApi> = {}) {
  const box = { state: first, emit: (_p: UpdateCheckProgressDTO): void => undefined };
  const api = makeFakeApi({
    updateCheck: vi.fn(() => Promise.resolve({ ok: true as const, data: box.state })),
    updateCheckStart: vi.fn<HfcmApi['updateCheckStart']>(() => Promise.resolve({ ok: true, data: null })),
    updateCheckCancel: vi.fn<HfcmApi['updateCheckCancel']>(() => Promise.resolve({ ok: true, data: null })),
    onUpdateCheckProgress: (cb) => { box.emit = cb; return () => undefined; },
    ...over,
  });
  return { api, box };
}

test('before any check: the button, no summary, no update badges', async () => {
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />);
  await screen.findAllByTestId('repo-row');
  expect(within(bar()).getByRole('button', { name: 'Check for updates' })).toBeEnabled();
  expect(bar()).toHaveTextContent('Not checked yet');
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByTestId('update-badge')).toBeNull();
});

test('findings: an update badge on the row, a summary with when it was checked, and the repos that could not be checked', async () => {
  const { api } = liveApi(FOUND);
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, api);
  await screen.findByTestId('update-badge');
  expect(within(rowOf(Q)).getByTestId('update-badge')).toHaveTextContent('update');
  expect(within(rowOf(Q)).getByTestId('update-badge')).toHaveAttribute('title', '2 files have a newer version on the Hub');
  expect(screen.getAllByTestId('update-badge')).toHaveLength(1);
  expect(screen.getByTestId('update-summary')).toHaveTextContent('1 repo has updates');
  expect(screen.getByTestId('update-summary')).toHaveTextContent('checked 2026-11-20 09:05');
  const not = screen.getByTestId('update-unchecked');
  expect(not).toHaveTextContent('2 could not be checked');
  expect(not).toHaveAttribute('title', expect.stringContaining('Qwen/Qwen3-32B: Gated'));
  expect(not).toHaveAttribute('title', expect.stringContaining('org/partial: Not checked: pinned'));
});

test('the Updates chip keeps only the repos with an update; it works with the search', async () => {
  const user = userEvent.setup();
  const { api } = liveApi(FOUND);
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, api);
  await screen.findByTestId('update-badge');
  expect(ids().length).toBeGreaterThan(1);
  const chip = screen.getByRole('button', { name: 'Updates' });
  await user.click(chip);
  expect(chip).toHaveAttribute('aria-pressed', 'true');
  expect(ids()).toEqual([Q]);
  await user.type(screen.getByLabelText('Search repos'), 'flux');
  expect(screen.queryAllByTestId('repo-row')).toHaveLength(0);
  await user.clear(screen.getByLabelText('Search repos'));
  await user.click(chip);
  expect(ids().length).toBeGreaterThan(1);
});

test('Check for updates starts a run: a progress bar with the count and the repo, Cancel, and the findings once it ends', async () => {
  const user = userEvent.setup();
  const { api, box } = liveApi();
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, api);
  await screen.findAllByTestId('repo-row');
  await user.click(within(bar()).getByRole('button', { name: 'Check for updates' }));
  expect(api.updateCheckStart).toHaveBeenCalledTimes(1);
  act(() => box.emit({ running: true, done: 2, total: 5, current: 'org/partial', waitingUntil: null }));
  const progress = screen.getByRole('progressbar', { name: 'Checking for updates' });
  expect(progress).toHaveAttribute('aria-valuenow', '2');
  expect(progress).toHaveAttribute('aria-valuemax', '5');
  expect(bar()).toHaveTextContent('Checking 2 of 5');
  expect(bar()).toHaveTextContent('org/partial');
  expect(within(bar()).queryByRole('button', { name: 'Check for updates' })).toBeNull();
  await user.click(within(bar()).getByRole('button', { name: 'Cancel' }));
  expect(api.updateCheckCancel).toHaveBeenCalledTimes(1);
  box.state = FOUND;
  act(() => box.emit({ running: false, done: 5, total: 5, current: null, waitingUntil: null }));
  await screen.findByTestId('update-badge');
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(within(bar()).getByRole('button', { name: 'Check for updates' })).toBeEnabled();
  expect(screen.getByTestId('update-summary')).toHaveTextContent('1 repo has updates');
});

test('a run already going when the list opens shows its progress; a rate-limit wait says when it goes on', async () => {
  const { api, box } = liveApi({ ...NO_UPDATE_CHECK, progress: { running: true, done: 1, total: 4, current: Q, waitingUntil: null } });
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, api);
  expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  act(() => box.emit({ running: true, done: 1, total: 4, current: Q, waitingUntil: new Date(2026, 10, 20, 9, 7, 30).getTime() }));
  expect(bar()).toHaveTextContent('The Hub is rate-limiting; continuing at 09:07:30');
});

test('with download mode off the button is disabled and the reason is shown', async () => {
  const { api } = liveApi({ ...NO_UPDATE_CHECK, disabledReason: 'Offline mode is on (HF_HUB_OFFLINE)' });
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, api);
  await waitFor(() => expect(bar()).toHaveTextContent('Offline mode is on (HF_HUB_OFFLINE)'));
  expect(within(bar()).getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  expect(screen.queryByTestId('update-summary')).toBeNull();
});

test('a start that is refused, and a run that stopped early, say why', async () => {
  const user = userEvent.setup();
  const { api } = liveApi({ ...FOUND, error: 'The check stopped: the Hub could not be reached.' }, {
    updateCheckStart: () => Promise.resolve({ ok: false, error: { code: 'BUSY', message: 'A check for updates is already running.' } }),
  });
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, api);
  expect(await screen.findByTestId('update-error')).toHaveTextContent('The check stopped: the Hub could not be reached.');
  await user.click(within(bar()).getByRole('button', { name: 'Check for updates' }));
  expect(await screen.findByTestId('update-error')).toHaveTextContent('A check for updates is already running.');
});

test('a finished download reads the findings again (main has rescanned), so a refreshed repo loses its badge', async () => {
  let done: (d: { id: string; repoId: string; type: 'model' }) => void = () => undefined;
  const { api, box } = liveApi(FOUND, { onDownloadDone: (cb) => { done = cb; return () => undefined; } });
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, api);
  await screen.findByTestId('update-badge');
  box.state = { ...FOUND, results: FOUND.results.filter((r) => r.status !== 'update') };
  act(() => done({ id: 'd1', repoId: Q, type: 'model' }));
  await waitFor(() => expect(screen.queryByTestId('update-badge')).toBeNull());
  expect(screen.getByTestId('update-summary')).toHaveTextContent('No updates');
});

const file = (relpath: string): FileEntryDTO => ({ relpath, commitShort: 'a3f9c1e', current: true, bytes: 10, plainFile: false });
const DETAIL: RepoDetailDTO = {
  ...QWEN_DETAIL,
  groups: [
    group('quant:Q8_0', 'quant', 'Q8_0', 100, { files: [file('Qwen3.6-27B-Q8_0.gguf')] }),
    group('quant:BF16', 'quant', 'BF16', 200, { fileCount: 2, files: [file('BF16/a-00001-of-00002.gguf'), file('BF16/a-00002-of-00002.gguf')] }),
    group('assets:README', 'assets', 'README', 5, { files: [file('README.md')] }),
  ],
};
const groupRow = (key: string): HTMLElement => {
  const el = screen.getAllByTestId('group-row').find((r) => r.getAttribute('data-group-key') === key);
  if (!el) throw new Error(`no group ${key}`);
  return el;
};

test('opening a repo that has the update badge checks that repo and marks the groups and files with a newer version', async () => {
  const user = userEvent.setup();
  const updateCheckRepo = vi.fn<HfcmApi['updateCheckRepo']>((repoId, type) => Promise.resolve({ ok: true, data: {
    repoId, type, status: 'update', commit: 'e7'.repeat(20), message: null, checkedAt: CHECKED_AT,
    files: [{ path: 'BF16/a-00002-of-00002.gguf', size: 30 }, { path: 'README.md', size: 4 }],
  } }));
  const onOpenInDownload = vi.fn();
  const { api } = liveApi(FOUND, { updateCheckRepo, repoDetail: () => Promise.resolve({ ok: true, data: DETAIL }) });
  renderWithProviders(<RepoDetail repoId={Q} onDeleteWholeRepo={vi.fn()} onOpenInDownload={onOpenInDownload} />, api);
  const line = await screen.findByTestId('repo-updates');
  await waitFor(() => expect(line).toHaveTextContent('2 files have a newer version on the Hub (e7e7e7e)'));
  expect(updateCheckRepo).toHaveBeenCalledExactlyOnceWith(Q, 'model');
  expect(within(groupRow('quant:BF16')).getByTestId('group-update')).toHaveTextContent('update');
  expect(within(groupRow('assets:README')).getByTestId('group-update')).toBeInTheDocument();
  expect(within(groupRow('quant:Q8_0')).queryByTestId('group-update')).toBeNull();
  await user.click(within(groupRow('quant:BF16')).getByTestId('group-expand'));
  const files = within(screen.getByTestId('group-files')).getAllByRole('listitem');
  expect(files[0]).not.toHaveTextContent('newer on the Hub');
  expect(files[1]).toHaveTextContent('newer on the Hub');
  await user.click(within(line).getByRole('button', { name: 'Open in Download tab' }));
  expect(onOpenInDownload).toHaveBeenCalledWith(Q);
});

test('a repo without the badge is not checked; one found current says so and the findings are read again', async () => {
  const updateCheckRepo = vi.fn<HfcmApi['updateCheckRepo']>((repoId, type) => Promise.resolve({ ok: true, data: {
    repoId, type, status: 'current', commit: null, files: [], message: null, checkedAt: CHECKED_AT } }));
  const plain = liveApi(NO_UPDATE_CHECK, { updateCheckRepo, repoDetail: () => Promise.resolve({ ok: true, data: DETAIL }) });
  const first = renderWithProviders(<RepoDetail repoId={Q} onDeleteWholeRepo={vi.fn()} />, plain.api);
  await screen.findAllByTestId('group-row');
  await waitFor(() => expect(plain.api.updateCheck).toHaveBeenCalled());
  expect(updateCheckRepo).not.toHaveBeenCalled();
  expect(screen.queryByTestId('repo-updates')).toBeNull();
  first.unmount();

  let answer: () => void = () => undefined;
  const gate = new Promise<void>((r) => { answer = r; });
  const slow: HfcmApi['updateCheckRepo'] = async (repoId, type) => { await gate; return updateCheckRepo(repoId, type); };
  const badged = liveApi(FOUND, { updateCheckRepo: slow, repoDetail: () => Promise.resolve({ ok: true, data: DETAIL }) });
  renderWithProviders(<RepoDetail repoId={Q} onDeleteWholeRepo={vi.fn()} />, badged.api);
  expect(await screen.findByTestId('repo-updates')).toHaveTextContent('Checking the Hub for changes…');
  answer();
  await waitFor(() => expect(screen.getByTestId('repo-updates')).toHaveTextContent('Up to date with the Hub'));
  await waitFor(() => expect(vi.mocked(badged.api.updateCheck).mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(screen.queryByTestId('group-update')).toBeNull();
});

test('when the Hub cannot be asked the earlier finding stays, with the reason', async () => {
  const updateCheckRepo = vi.fn<HfcmApi['updateCheckRepo']>((repoId, type) => Promise.resolve({ ok: true, data: {
    repoId, type, status: 'update', commit: 'e7'.repeat(20), message: 'Network error: getaddrinfo ENOTFOUND', checkedAt: CHECKED_AT,
    files: [{ path: 'README.md', size: 4 }] } }));
  const { api } = liveApi(FOUND, { updateCheckRepo, repoDetail: () => Promise.resolve({ ok: true, data: DETAIL }) });
  renderWithProviders(<RepoDetail repoId={Q} onDeleteWholeRepo={vi.fn()} />, api);
  await waitFor(() => expect(screen.getByTestId('repo-updates')).toHaveTextContent('1 file has a newer version on the Hub (e7e7e7e)'));
  expect(screen.getByTestId('repo-updates')).toHaveTextContent('Could not check again just now: Network error: getaddrinfo ENOTFOUND');
});
