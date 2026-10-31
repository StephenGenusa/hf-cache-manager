import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { RepoList } from '../../src/renderer/components/RepoList';
import { TopBar } from '../../src/renderer/components/TopBar';
import { SHORTCUT_EVENT, SEARCH_TEST_ID, useShortcuts } from '../../src/renderer/lib/use-shortcuts';
import type { LibraryDTO, RepoSummaryDTO, ScanProgressDTO } from '../../src/shared/api';
import { LIBRARY, makeFakeApi, renderWithProviders } from './fake-api';

beforeEach(() => expect.hasAssertions());

const libApi = (lib: Partial<LibraryDTO>, over = {}) =>
  makeFakeApi({ scan: () => Promise.resolve({ ok: true, data: { ...LIBRARY, ...lib } }), ...over });
const ids = () => screen.getAllByTestId('repo-row').map((r) => r.getAttribute('data-repo-id'));

function manyRepos(n: number): RepoSummaryDTO[] {
  return Array.from({ length: n }, (_, i) => ({
    repoId: `org/model-${String(i).padStart(5, '0')}`, type: 'model' as const, kinds: ['gguf' as const], badge: 'GGUF · 1 quant',
    apparentBytes: 1_000_000 + i, lastModifiedMs: i, usage: { lmstudio: 0, ollama: 0 }, partialDownloads: 0, ambiguous: false,
  }));
}

test('virtualized list renders under 60 rows for 5,000 repos', async () => {
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, libApi({ repos: manyRepos(5000) }));
  const rows = await screen.findAllByTestId('repo-row');
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThan(60);
  expect(screen.getByTestId(SEARCH_TEST_ID)).toHaveAttribute('placeholder', 'Search 5000 repos…');
});

test('rows show id, kind badge, view badges, partial badge and size', async () => {
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />);
  await screen.findAllByTestId('repo-row');
  const q = screen.getAllByTestId('repo-row').find((r) => r.getAttribute('data-repo-id') === 'unsloth/Qwen3.6-27B-GGUF')!;
  expect(q).toHaveTextContent('GGUF · 6 quants');
  expect(q).toHaveTextContent('LM Studio');
  expect(q).toHaveTextContent('Ollama');
  expect(q).toHaveTextContent('118.4 GB');
  expect(q).not.toHaveTextContent('partial');
  const p = screen.getAllByTestId('repo-row').find((r) => r.getAttribute('data-repo-id') === 'org/partial')!;
  expect(p).toHaveTextContent('partial');
  expect(p).not.toHaveTextContent('LM Studio');
  const f = screen.getAllByTestId('repo-row').find((r) => r.getAttribute('data-repo-id') === 'black-forest-labs/FLUX.1-dev')!;
  expect(f).not.toHaveTextContent('Ollama');
});

test('clicking a row activates it; the active row is marked', async () => {
  const user = userEvent.setup();
  const onActivate = vi.fn();
  renderWithProviders(<RepoList activeRepoId="Qwen/Qwen3-32B" onActivate={onActivate} />);
  const rows = await screen.findAllByTestId('repo-row');
  expect(rows.find((r) => r.getAttribute('aria-current') === 'true')).toHaveAttribute('data-repo-id', 'Qwen/Qwen3-32B');
  await user.click(rows[0]!);
  expect(onActivate).toHaveBeenCalledWith(rows[0]!.getAttribute('data-repo-id'));
});

test('hub missing: list shows the not-found message; the held nav stays', async () => {
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, libApi({ hubPresent: false, hubRoot: '/data/models/hub', repos: [] }));
  expect(await screen.findByText('Cache not found at /data/models/hub. Is the drive mounted?')).toBeVisible();
  expect(screen.queryByTestId('repo-row')).toBeNull();
  expect(screen.getByTestId('nav-recently-deleted')).toBeVisible();
});

test('scan error: the hub problem is shown in place of the list', async () => {
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, libApi({ scanError: 'EACCES: permission denied', repos: [] }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The cache could not be read: EACCES: permission denied. Fix the permissions and rescan.');
});

test('hub missing with a specific reason shows it too', async () => {
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />,
    libApi({ hubPresent: false, hubRoot: '/x/hub', repos: [], scanError: 'Cache not found at /x/hub (not a folder)' }));
  expect(await screen.findByText('Cache not found at /x/hub. Is the drive mounted?')).toBeVisible();
  expect(screen.getByText('Cache not found at /x/hub (not a folder)')).toBeVisible();
});

test('search, sort and filter are wired to filterSortRepos', async () => {
  const user = userEvent.setup();
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />);
  await screen.findAllByTestId('repo-row');
  expect(ids()).toEqual(['unsloth/Qwen3.6-27B-GGUF', 'Qwen/Qwen3-32B', 'bartowski/gemma-4-31b-it-GGUF', 'black-forest-labs/FLUX.1-dev', 'org/partial'].sort((a, b) => {
    const size: Record<string, number> = { 'unsloth/Qwen3.6-27B-GGUF': 118.4, 'Qwen/Qwen3-32B': 65.5, 'bartowski/gemma-4-31b-it-GGUF': 54, 'black-forest-labs/FLUX.1-dev': 57.9, 'org/partial': 1 };
    return size[b]! - size[a]!;
  }));
  await user.type(screen.getByTestId(SEARCH_TEST_ID), 'QWEN');
  expect(ids()).toEqual(['unsloth/Qwen3.6-27B-GGUF', 'Qwen/Qwen3-32B']);
  await user.clear(screen.getByTestId(SEARCH_TEST_ID));
  await user.click(screen.getByRole('button', { name: 'LM Studio' }));
  expect(ids()).toEqual(['unsloth/Qwen3.6-27B-GGUF', 'bartowski/gemma-4-31b-it-GGUF']);
  await user.click(screen.getByRole('button', { name: 'LM Studio' }));
  await user.click(screen.getByRole('button', { name: 'Partial downloads' }));
  expect(ids()).toEqual(['org/partial']);
  await user.click(screen.getByRole('button', { name: 'Partial downloads' }));
  await user.click(screen.getByRole('button', { name: 'Diffusers' }));
  expect(ids()).toEqual(['black-forest-labs/FLUX.1-dev']);
  await user.click(screen.getByRole('button', { name: 'Diffusers' }));
  await user.click(screen.getByRole('combobox', { name: 'Sort' }));
  await user.click(await screen.findByRole('option', { name: 'Name' }));
  expect(ids()[0]).toBe('bartowski/gemma-4-31b-it-GGUF');
});

test('"/" focuses the search box; arrow shortcuts move the active repo', async () => {
  const user = userEvent.setup();
  const onActivate = vi.fn();
  function Harness() { useShortcuts(); return <RepoList activeRepoId="Qwen/Qwen3-32B" onActivate={onActivate} />; }
  renderWithProviders(<Harness />);
  await screen.findAllByTestId('repo-row');
  const order = ids();
  act(() => { window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: 'next-repo' })); });
  expect(onActivate).toHaveBeenLastCalledWith(order[order.indexOf('Qwen/Qwen3-32B') + 1]);
  act(() => { window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: 'prev-repo' })); });
  expect(onActivate).toHaveBeenLastCalledWith(order[order.indexOf('Qwen/Qwen3-32B') - 1]);
  await user.click(document.body);
  await user.keyboard('/');
  expect(document.activeElement).toBe(screen.getByTestId(SEARCH_TEST_ID));
});

test('ambiguous repos get a marker and a distinct key', async () => {
  const repos = [
    { ...manyRepos(1)[0]!, repoId: 'o/x', type: 'model' as const, ambiguous: true },
    { ...manyRepos(1)[0]!, repoId: 'o/x', type: 'dataset' as const, kinds: ['dataset' as const], ambiguous: true },
  ];
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} />, libApi({ repos }));
  const rows = await screen.findAllByTestId('repo-row');
  expect(rows).toHaveLength(2);
  for (const r of rows) expect(within(r).getByText('shared id')).toBeVisible();
  expect(err).not.toHaveBeenCalled();
  err.mockRestore();
});

test('with two repos sharing an id, only the clicked row is highlighted', async () => {
  const user = userEvent.setup();
  const repos = [
    { ...manyRepos(1)[0]!, repoId: 'o/x', type: 'model' as const, ambiguous: true, apparentBytes: 9 },
    { ...manyRepos(1)[0]!, repoId: 'o/x', type: 'dataset' as const, ambiguous: true, apparentBytes: 5 },
  ];
  function Host() { const [a, setA] = useState<string | null>(null); return <RepoList activeRepoId={a} onActivate={setA} />; }
  renderWithProviders(<Host />, libApi({ repos }));
  const rows = await screen.findAllByTestId('repo-row');
  await user.click(rows[1]!);
  const now = screen.getAllByTestId('repo-row');
  expect(now[0]).not.toHaveAttribute('aria-current');
  expect(now[1]).toHaveAttribute('aria-current', 'true');
});

test('Recently Deleted nav shows the held size and opens the held view', async () => {
  const user = userEvent.setup();
  const onOpenHeld = vi.fn();
  renderWithProviders(<RepoList activeRepoId={null} onActivate={vi.fn()} onOpenHeld={onOpenHeld} />, libApi({ heldBytes: 12_300_000_000, heldCount: 1 }));
  const nav = await screen.findByTestId('nav-recently-deleted');
  await waitFor(() => expect(nav).toHaveTextContent('Recently Deleted (12.3 GB)'));
  await user.click(nav);
  expect(onOpenHeld).toHaveBeenCalledTimes(1);
});

// ---- TopBar ----
test('top bar: title, Rescan, Sync, disk meter', async () => {
  const user = userEvent.setup();
  const onSync = vi.fn();
  renderWithProviders(<TopBar onSync={onSync} />);
  expect(screen.getByText('HF Cache Manager')).toBeVisible();
  await waitFor(() => expect(screen.getByTestId('btn-rescan')).toBeEnabled());
  await waitFor(() => expect(screen.getByTestId('btn-sync')).toBeEnabled());
  await waitFor(() => expect(screen.getByTestId('disk-info')).toHaveTextContent('Cache 1.0 TB'));
  expect(screen.getByTestId('disk-info')).toHaveTextContent('500.0 GB free of 2.0 TB');
  expect(screen.getByRole('meter', { name: 'Disk used' })).toHaveAttribute('aria-valuenow', '75');
  await user.click(screen.getByTestId('btn-sync'));
  expect(onSync).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  expect(document.documentElement).not.toHaveClass('dark');
});

// The fake disk: 2.0 TB, 1.5 TB used, 500 GB free; the fake hub takes 1.0 TB of it.
test('disk meter: the bar splits the disk into the HF cache, everything else and free space', async () => {
  renderWithProviders(<TopBar onSync={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('meter-cache')).toHaveStyle({ width: '50%' }));
  expect(screen.getByTestId('meter-other')).toHaveStyle({ width: '25%' });
  expect(screen.getByRole('meter', { name: 'Disk used' }))
    .toHaveAttribute('aria-valuetext', 'HF cache 1.0 TB, everything else 500.0 GB, 500.0 GB free of 2.0 TB');
});

test('disk meter hover: the disk, the cache (with Recently Deleted), everything else and free space', async () => {
  const user = userEvent.setup();
  renderWithProviders(<TopBar onSync={vi.fn()} />, libApi({ hubBytes: 900_000_000_000, heldBytes: 100_000_000_000, heldCount: 2 }));
  const meter = await screen.findByRole('meter', { name: 'Disk used' });
  await waitFor(() => expect(screen.getByTestId('disk-info')).toHaveTextContent('Cache 1.0 TB'));
  await user.hover(meter);
  const tip = (await screen.findAllByTestId('disk-breakdown'))[0]!;
  expect(tip).toHaveTextContent('/data/models · 2.0 TB disk');
  expect(tip).toHaveTextContent('HF cache 1.0 TB');
  expect(tip).toHaveTextContent('of which Recently Deleted 100.0 GB');
  expect(tip).toHaveTextContent('Everything else 500.0 GB');
  expect(tip).toHaveTextContent('Free 500.0 GB');
});

test('disk meter: a cache figure larger than the used space fills the used part and leaves nothing for everything else', async () => {
  renderWithProviders(<TopBar onSync={vi.fn()} />, libApi({ hubBytes: 1_600_000_000_000 }));
  await waitFor(() => expect(screen.getByTestId('meter-cache')).toHaveStyle({ width: '75%' }));
  expect(screen.getByTestId('meter-other')).toHaveStyle({ width: '0%' });
});

test('disk meter before the library is loaded: disk figures only, no cache split', async () => {
  renderWithProviders(<TopBar onSync={vi.fn()} />, libApi({}, { scan: () => new Promise(() => undefined) }));
  await waitFor(() => expect(screen.getByTestId('disk-info')).toHaveTextContent('500.0 GB free of 2.0 TB'));
  expect(screen.getByTestId('disk-info')).not.toHaveTextContent('Cache');
  expect(screen.queryByTestId('meter-cache')).toBeNull();
  expect(screen.getByTestId('meter-other')).toHaveStyle({ width: '75%' });
});

test('disk meter after a failed scan or with no hub: no cache figure is shown', async () => {
  const { unmount } = renderWithProviders(<TopBar onSync={vi.fn()} />, libApi({ scanError: 'The cache could not be read', hubBytes: 0 }));
  await waitFor(() => expect(screen.getByTestId('sync-disabled-reason')).toBeVisible());
  expect(screen.getByTestId('disk-info')).not.toHaveTextContent('Cache');
  unmount();
  renderWithProviders(<TopBar onSync={vi.fn()} />, libApi({ hubPresent: false, hubBytes: 0 }));
  await waitFor(() => expect(screen.getByTestId('sync-disabled-reason')).toBeVisible());
  expect(screen.getByTestId('disk-info')).not.toHaveTextContent('Cache');
});

test('Rescan is disabled while scanning and shows progress', async () => {
  let push: (p: ScanProgressDTO) => void = () => undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  renderWithProviders(<TopBar onSync={vi.fn()} />, makeFakeApi({
    scan: async () => { await gate; return { ok: true, data: LIBRARY }; },
    onScanProgress: (cb) => { push = cb; return () => undefined; },
  }));
  expect(screen.getByTestId('btn-rescan')).toBeDisabled();
  expect(screen.getByTestId('btn-rescan')).toHaveTextContent('Scanning…');
  act(() => push({ phase: 'scan', done: 3, total: 40 }));
  expect(screen.getByTestId('btn-rescan')).toHaveTextContent('Scanning… 3/40');
  await act(async () => { release(); await gate; });
  await waitFor(() => expect(screen.getByTestId('btn-rescan')).toBeEnabled());
  expect(screen.getByTestId('btn-rescan')).toHaveTextContent('Rescan');
});

test('hub missing: Sync is disabled with a visible reason', async () => {
  renderWithProviders(<TopBar onSync={vi.fn()} />, libApi({ hubPresent: false, repos: [] }));
  expect(await screen.findByTestId('sync-disabled-reason')).toHaveTextContent('Cache not found');
  expect(screen.getByTestId('btn-sync')).toBeDisabled();
});

test('scan error: Sync is disabled too', async () => {
  renderWithProviders(<TopBar onSync={vi.fn()} />, libApi({ scanError: 'EACCES' }));
  expect(await screen.findByTestId('sync-disabled-reason')).toHaveTextContent('Cache could not be read');
  expect(screen.getByTestId('btn-sync')).toBeDisabled();
});
