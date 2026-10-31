import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { useDownloadSelection } from '../../src/renderer/state/download-selection';
import { useDownloads } from '../../src/renderer/state/downloads';
import { useSelection } from '../../src/renderer/state/selection';
import type { DlState, DownloadDoneDTO, DownloadItemDTO } from '../../src/shared/api';
import { HUB_LOOKUP, hubAdvice, makeFakeApi, renderWithProviders } from './fake-api';

beforeEach(() => {
  expect.hasAssertions();
  useDownloadSelection.getState().clear();
  useSelection.getState().clear();
});

async function openDownload(api = makeFakeApi(), input = 'unsloth/Qwen3.6-27B-GGUF') {
  const user = userEvent.setup();
  renderWithProviders(<App />, api);
  await user.click(screen.getByRole('button', { name: 'Download' }));
  const field = screen.getByTestId('hub-input');
  await user.type(field, `${input}{Enter}`);
  await screen.findAllByTestId('dl-row');
  return user;
}
const row = (key: string) => document.querySelector(`[data-testid="dl-row"][data-group-key="${key}"]`) as HTMLElement;
const footerBtn = () => screen.getByTestId('download-button');

test('the switch shows Download mode with the input; Library brings the library back', async () => {
  const user = userEvent.setup();
  renderWithProviders(<App />);
  expect(screen.queryByTestId('hub-input')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Download' }));
  expect(screen.getByTestId('hub-input')).toBeInTheDocument();
  expect(screen.queryByTestId('action-bar')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Library' }));
  expect(screen.queryByTestId('hub-input')).toBeNull();
  expect(screen.getByTestId('action-bar')).toBeInTheDocument();
});

test('Enter and Look up call hubLookup; a parse error shows inline without calling', async () => {
  const hubLookup = vi.fn(makeFakeApi().hubLookup);
  const user = await openDownload(makeFakeApi({ hubLookup }));
  expect(hubLookup).toHaveBeenCalledWith('unsloth/Qwen3.6-27B-GGUF');
  await user.clear(screen.getByTestId('hub-input'));
  await user.type(screen.getByTestId('hub-input'), 'nonsense');
  await user.click(screen.getByRole('button', { name: 'Look up' }));
  expect(screen.getByTestId('hub-input-error')).toHaveTextContent(/org\/name|Not a valid|Expected/i);
  expect(hubLookup).toHaveBeenCalledTimes(1);
});

test('a lookup error is shown', async () => {
  const user = userEvent.setup();
  renderWithProviders(<App />, makeFakeApi({ hubLookup: () => Promise.resolve({ ok: false, error: { code: 'OFFLINE', message: 'Offline mode is on' } }) }));
  await user.click(screen.getByRole('button', { name: 'Download' }));
  await user.type(screen.getByTestId('hub-input'), 'a/b{Enter}');
  expect(await screen.findByTestId('lookup-error')).toHaveTextContent('Offline mode is on');
});

test('the left list shows the repo with its badge and the recent look-ups; a recent one fills the input and looks it up', async () => {
  const hubLookup = vi.fn(makeFakeApi().hubLookup);
  const user = await openDownload(makeFakeApi({ hubLookup }));
  expect(within(screen.getByTestId('lookup-repo')).getByText('unsloth/Qwen3.6-27B-GGUF')).toBeInTheDocument();
  expect(screen.getByTestId('lookup-repo')).toHaveTextContent('GGUF · 6 quants');
  expect(screen.getByTestId('lookup-date')).toHaveTextContent('2026-10-01');   // The commit date
  await user.click(await screen.findByTestId('recent-lookup'));
  expect(screen.getByTestId('hub-input')).toHaveValue('bartowski/gemma-4-31b-it-GGUF');
  expect(hubLookup).toHaveBeenLastCalledWith('bartowski/gemma-4-31b-it-GGUF');
});

test('gated and private flags show on the repo', async () => {
  const lookup = { ...HUB_LOOKUP, gated: true, private: true, downloadable: false, notDownloadableReason: 'Gated: accept the licence on the Hub' };
  await openDownload(makeFakeApi({ hubLookup: () => Promise.resolve({ ok: true, data: lookup }) }));
  expect(screen.getByTestId('lookup-repo')).toHaveTextContent('gated');
  expect(screen.getByTestId('lookup-repo')).toHaveTextContent('private');
  expect(footerBtn()).toBeDisabled();
  expect(screen.getByTestId('download-reason')).toHaveTextContent('Gated: accept the licence on the Hub');
});

test('the table has Requires, badges, tints, name hints; nothing is ticked; unselectable rows show their reason', async () => {
  await openDownload();
  expect(screen.getByRole('columnheader', { name: 'Requires' })).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Reclaimable' })).toBeNull();
  for (const c of screen.getAllByTestId('dl-checkbox')) expect(c).toHaveAttribute('aria-checked', 'false');
  expect(row('quant:UD-Q4_K_XL')).toHaveTextContent('17.6 GB');
  expect(row('quant:Q6_K')).toHaveTextContent('cached');
  expect(row('quant:Q8_0')).toHaveTextContent('partial 12.3 / 19.6 GB');
  expect(row('quant:Q5_K_M')).toHaveTextContent('update');
  const bad = row('quant:IQ2_M');
  expect(bad).toHaveTextContent('Shard 2 of 2 is missing on the Hub');
  expect(within(bad).getByTestId('dl-checkbox')).toBeDisabled();
  await waitFor(() => expect(row('quant:UD-Q4_K_XL')).toHaveAttribute('data-tint', 'green'));
  expect(row('quant:BF16')).toHaveAttribute('data-tint', 'red');
  expect(within(row('quant:UD-Q4_K_XL')).getAllByTestId('name-part-known').length).toBeGreaterThan(0);
  expect(screen.getByTestId('advice-basis')).toHaveTextContent('Linux, 64 GB RAM');
});

test('size advice reads "Reading model shape…" until downloadAdvice answers', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  await openDownload(makeFakeApi({ downloadAdvice: async () => { await gate; return { ok: true, data: hubAdvice(HUB_LOOKUP, true) }; } }));
  expect(within(row('quant:UD-Q4_K_XL')).getByText('Reading model shape…')).toBeInTheDocument();
  release();
  await waitFor(() => expect(screen.queryByText('Reading model shape…')).toBeNull());
  expect(row('quant:UD-Q4_K_XL')).toHaveAttribute('data-tint', 'green');
});

test('a GATED refusal from downloadAdvice shows in the header and disables Download', async () => {
  const user = await openDownload(makeFakeApi({ downloadAdvice: () => Promise.resolve({ ok: false, error: { code: 'GATED', message: 'Accept the licence first' } }) }));
  expect(await screen.findByTestId('gated-note')).toHaveTextContent('Accept the licence first');
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  expect(footerBtn()).toBeDisabled();
});

test('Select the best pick ticks the green quant and green mmproj only', async () => {
  const user = await openDownload();
  const btn = screen.getByRole('button', { name: 'Select the best pick' });
  await waitFor(() => expect(btn).toBeEnabled());
  await user.click(btn);
  const ticked = screen.getAllByTestId('dl-row').filter((r) => r.getAttribute('data-checked') === 'true').map((r) => r.getAttribute('data-group-key'));
  expect(ticked.sort()).toEqual(['mmproj:mmproj-F16', 'quant:UD-Q4_K_XL']);
});

test('with no green the best pick is disabled with a tooltip', async () => {
  const none = { ...hubAdvice(HUB_LOOKUP, true), groups: hubAdvice(HUB_LOOKUP, true).groups.map((g) => ({ ...g, tint: g.tint === 'green' ? null : g.tint })) };
  const user = await openDownload(makeFakeApi({ downloadAdvice: () => Promise.resolve({ ok: true, data: none }) }));
  const btn = screen.getByRole('button', { name: 'Select the best pick' });
  await waitFor(() => expect(screen.queryByText('Reading model shape…')).toBeNull());
  expect(btn).toBeDisabled();
  await user.hover(screen.getByTestId('best-pick-wrap'));
  expect((await screen.findAllByText('No best pick for this PC')).length).toBeGreaterThan(0);
});

test('the footer counts the selection; Download is disabled with a reason when empty', async () => {
  const user = await openDownload();
  expect(footerBtn()).toBeDisabled();
  expect(screen.getByTestId('download-reason')).toHaveTextContent('Nothing selected');
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  await user.click(within(row('mmproj:mmproj-F16')).getByTestId('dl-checkbox'));
  await waitFor(() => expect(screen.getByTestId('download-footer')).toHaveTextContent('Selected: 2 files · requires 18.5 GB · 500.0 GB free on /data/models'));
  await waitFor(() => expect(footerBtn()).toBeEnabled());
  expect(footerBtn()).toHaveTextContent('Download 18.5 GB');   // The button names what it fetches
});

test('Download is disabled when the preview says it does not fit', async () => {
  const user = await openDownload(makeFakeApi({
    downloadPreview: () => Promise.resolve({ ok: true, data: { previewId: 'p', fingerprint: 'f', requiresBytes: 1, freeBytes: 0, fits: false, reason: 'Needs 17.6 GB, 1.0 GB free', files: 1 } }),
  }));
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  await waitFor(() => expect(screen.getByTestId('download-reason')).toHaveTextContent('Needs 17.6 GB, 1.0 GB free'));
  expect(footerBtn()).toBeDisabled();
});

test('Download calls downloadPreview then downloadStart with the previewId and fingerprint', async () => {
  const order: string[] = [];
  const base = makeFakeApi();
  const downloadPreview = vi.fn((...a: Parameters<typeof base.downloadPreview>) => { order.push('preview'); return base.downloadPreview(...a); });
  const downloadStart = vi.fn((...a: Parameters<typeof base.downloadStart>) => { order.push('start'); return base.downloadStart(...a); });
  const user = await openDownload(makeFakeApi({ downloadPreview, downloadStart }));
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  await waitFor(() => expect(footerBtn()).toBeEnabled());
  await user.click(footerBtn());
  await waitFor(() => expect(downloadStart).toHaveBeenCalledWith('p1', 'f'.repeat(64)));
  expect(downloadPreview).toHaveBeenCalledWith(HUB_LOOKUP.lookupId, ['quant:UD-Q4_K_XL']);
  expect(order.at(-2)).toBe('preview');
  expect(order.at(-1)).toBe('start');
});

test('a STALE start shows "The repo changed — look up again" with a button that looks up again', async () => {
  const hubLookup = vi.fn(makeFakeApi().hubLookup);
  const user = await openDownload(makeFakeApi({ hubLookup, downloadStart: () => Promise.resolve({ ok: false, error: { code: 'STALE', message: 'moved' } }) }));
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  await waitFor(() => expect(footerBtn()).toBeEnabled());
  await user.click(footerBtn());
  expect(await screen.findByText('The repo changed — look up again')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Look up again' }));
  await waitFor(() => expect(hubLookup).toHaveBeenCalledTimes(2));
});

test('switching modes never carries a selection; a full tick + Download flow never plans or executes a delete', async () => {
  const base = makeFakeApi();
  const planDelete = vi.fn(base.planDelete);
  const executePlan = vi.fn(base.executePlan);
  const user = await openDownload(makeFakeApi({ planDelete, executePlan }));
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  expect(useDownloadSelection.getState().keys).toHaveLength(1);
  await waitFor(() => expect(footerBtn()).toBeEnabled());
  await user.click(footerBtn());
  await waitFor(() => expect(useDownloadSelection.getState().keys).toHaveLength(0));
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  useSelection.setState({ byRepo: { x: { groupKeys: ['quant:a'], unlockComponents: false } } });
  await user.click(screen.getByRole('button', { name: 'Library' }));
  expect(useDownloadSelection.getState().keys).toHaveLength(0);
  expect(useSelection.getState().groupCount()).toBe(0);
  expect(planDelete).not.toHaveBeenCalled();
  expect(executePlan).not.toHaveBeenCalled();
});

test('overlapping look-ups: checkboxes are disabled in flight, the late old result is dropped, ticks are cleared', async () => {
  const base = makeFakeApi();
  const releases: Array<() => void> = [];
  const hubLookup = vi.fn(async (t: string) => {
    const r = await base.hubLookup(t);
    await new Promise<void>((res) => { releases.push(res); });
    return r.ok ? { ok: true as const, data: { ...r.data, repoId: t, lookupId: `id-${t}` } } : r;
  });
  const user = userEvent.setup();
  renderWithProviders(<App />, makeFakeApi({ hubLookup }));
  await user.click(screen.getByRole('button', { name: 'Download' }));
  await user.type(screen.getByTestId('hub-input'), 'a/one{Enter}');
  await waitFor(() => expect(releases).toHaveLength(1));
  releases[0]?.();
  await screen.findAllByTestId('dl-row');
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  expect(useDownloadSelection.getState().keys).toHaveLength(1);
  await user.clear(screen.getByTestId('hub-input'));
  await user.type(screen.getByTestId('hub-input'), 'a/two{Enter}');
  await waitFor(() => expect(releases).toHaveLength(2));
  expect(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox')).toBeDisabled();
  await user.clear(screen.getByTestId('hub-input'));
  await user.type(screen.getByTestId('hub-input'), 'a/three{Enter}');
  await waitFor(() => expect(releases).toHaveLength(3));
  releases[2]?.();
  await waitFor(() => expect(screen.getByTestId('lookup-repo')).toHaveTextContent('a/three'));
  releases[1]?.();
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.getByTestId('lookup-repo')).toHaveTextContent('a/three');
  expect(useDownloadSelection.getState().keys).toHaveLength(0);
  expect(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox')).toBeEnabled();
});

test('Download waits for the advice check and for a current preview, and a preview error disables it', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const user = await openDownload(makeFakeApi({ downloadAdvice: async () => { await gate; return { ok: true, data: hubAdvice(HUB_LOOKUP, true) }; } }));
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  expect(footerBtn()).toBeDisabled();
  expect(screen.getByTestId('download-reason')).toHaveTextContent('Reading model shape…');
  release();
  await waitFor(() => expect(footerBtn()).toBeEnabled());
});

test('before the preview answers Download says "Checking space…"', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const base = makeFakeApi();
  const user = await openDownload(makeFakeApi({ downloadPreview: async (...a) => { await gate; return base.downloadPreview(...a); } }));
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  await waitFor(() => expect(screen.getByTestId('download-reason')).toHaveTextContent('Checking space…'));
  expect(footerBtn()).toBeDisabled();
  release();
  await waitFor(() => expect(footerBtn()).toBeEnabled());
});

test('a preview error is shown and disables Download', async () => {
  const user = await openDownload(makeFakeApi({ downloadPreview: () => Promise.resolve({ ok: false, error: { code: 'NETWORK', message: 'The Hub did not answer' } }) }));
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  await waitFor(() => expect(screen.getByTestId('download-reason')).toHaveTextContent('The Hub did not answer'));
  expect(footerBtn()).toBeDisabled();
});

test('a STALE answer from the reactive preview shows the look-up-again note', async () => {
  const hubLookup = vi.fn(makeFakeApi().hubLookup);
  const user = await openDownload(makeFakeApi({ hubLookup, downloadPreview: () => Promise.resolve({ ok: false, error: { code: 'UNKNOWN_PLAN', message: 'expired' } }) }));
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  expect(await screen.findByText('The repo changed — look up again')).toBeInTheDocument();
  expect(footerBtn()).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Look up again' }));
  await waitFor(() => expect(hubLookup).toHaveBeenCalledTimes(2));
});

test('a non-GATED downloadAdvice failure shows a muted note', async () => {
  await openDownload(makeFakeApi({ downloadAdvice: () => Promise.resolve({ ok: false, error: { code: 'NETWORK', message: 'x' } }) }));
  expect(await screen.findByTestId('advice-note')).toHaveTextContent('Model shapes could not be read; size advice is unavailable');
});

test('the best-pick tooltip says "Waiting for model shapes…" while the shapes are pending', async () => {
  const user = await openDownload(makeFakeApi({ downloadAdvice: () => new Promise(() => undefined) }));
  await user.hover(screen.getByTestId('best-pick-wrap'));
  expect((await screen.findAllByText('Waiting for model shapes…')).length).toBeGreaterThan(0);
});

test('the queue overlays the look-up: queued files say queued, finished ones cached; nothing left to fetch → no checkbox', async () => {
  const item = (id: string, files: Array<[string, DlState]>, commit = HUB_LOOKUP.commit): DownloadItemDTO => ({
    id, repoId: HUB_LOOKUP.repoId, type: 'model', revision: 'main', commit,
    files: files.map(([path, state]) => ({ path, size: 1, state, bytes: 0, error: null })),
  });
  const queue = [
    item('a', [['Qwen3.6-27B-UD-Q4_K_XL.gguf', 'downloading']]),
    item('b', [['mmproj-F16.gguf', 'done']]),
    item('c', [['Qwen3.6-27B-BF16.gguf', 'paused']], 'b'.repeat(40)),   // another commit: not this look-up's
  ];
  const downloads = () => Promise.resolve({ ok: true as const, data: { items: queue, disabledReason: null, notes: [] } });
  try {
    await openDownload(makeFakeApi({ downloads }));
    await waitFor(() => expect(row('quant:UD-Q4_K_XL')).toHaveTextContent('queued'));
    const q4 = row('quant:UD-Q4_K_XL');
    expect(q4).toHaveTextContent('queued');
    expect(q4).toHaveTextContent('0 B');   // Requires: nothing more to fetch
    expect(within(q4).getByTestId('dl-checkbox')).toBeDisabled();
    const mm = row('mmproj:mmproj-F16');
    expect(mm).toHaveTextContent('cached');
    expect(within(mm).getByTestId('dl-checkbox')).toBeDisabled();
    expect(within(row('quant:BF16')).getByTestId('dl-checkbox')).toBeEnabled();
    expect(row('quant:BF16')).not.toHaveTextContent('queued');
    // a group that is only cached is not tickable either: there is nothing to download
    expect(within(row('quant:Q6_K')).getByTestId('dl-checkbox')).toBeDisabled();
    expect(within(row('quant:Q8_0')).getByTestId('dl-checkbox')).toBeEnabled();   // partial: the rest can be fetched
  } finally {
    useDownloads.getState().setItems([], null);
  }
});

test('Select whole repo ticks every group that has something to fetch (cached, queued and unselectable ones stay off)', async () => {
  const user = await openDownload();
  await user.click(screen.getByRole('button', { name: 'Select whole repo' }));
  const ticked = screen.getAllByTestId('dl-row').filter((r) => r.getAttribute('data-checked') === 'true').map((r) => r.getAttribute('data-group-key'));
  const want = HUB_LOOKUP.groups.filter((g) => g.selectable && g.files.some((f) => f.state !== 'cached')).map((g) => g.key);
  expect(want).not.toContain('quant:Q6_K');
  expect(want).not.toContain('quant:IQ2_M');
  expect(ticked.sort()).toEqual(want.sort());
});

test('Select whole repo is disabled when nothing is left to fetch', async () => {
  const lookup = { ...HUB_LOOKUP, groups: HUB_LOOKUP.groups.filter((g) => g.key === 'quant:Q6_K') };
  await openDownload(makeFakeApi({ hubLookup: () => Promise.resolve({ ok: true, data: lookup }) }));
  expect(screen.getByRole('button', { name: 'Select whole repo' })).toBeDisabled();
});

test('a finished download of the looked-up repo reads its groups again: cached, nothing to download, not tickable', async () => {
  const subs: Array<(d: DownloadDoneDTO) => void> = [];
  const fresh = HUB_LOOKUP.groups.map((g) => g.key !== 'quant:UD-Q4_K_XL' ? g
    : { ...g, requiresBytes: 0, files: g.files.map((f) => ({ ...f, state: 'cached' as const, have: f.size })) });
  const lookupGroups = vi.fn(() => Promise.resolve({ ok: true as const, data: fresh }));
  await openDownload(makeFakeApi({ lookupGroups, onDownloadDone: (cb) => { subs.push(cb); return () => undefined; } }));
  expect(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox')).toBeEnabled();
  act(() => subs.forEach((cb) => cb({ id: 'x', repoId: 'other/repo', type: 'model' })));
  expect(lookupGroups).not.toHaveBeenCalled();
  act(() => subs.forEach((cb) => cb({ id: 'x', repoId: HUB_LOOKUP.repoId, type: 'model' })));
  await waitFor(() => expect(row('quant:UD-Q4_K_XL')).toHaveTextContent('cached'));
  expect(lookupGroups).toHaveBeenCalledWith(HUB_LOOKUP.lookupId);
  expect(row('quant:UD-Q4_K_XL')).toHaveTextContent('0 B');
  expect(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox')).toBeDisabled();
});

test('a ticked download row is highlighted in the accent blue, never the deletion red', async () => {
  const user = await openDownload();
  await user.click(within(row('quant:UD-Q4_K_XL')).getByTestId('dl-checkbox'));
  const r = row('quant:UD-Q4_K_XL');
  expect(r).toHaveAttribute('data-checked', 'true');
  expect(r.className).toContain('data-[checked=true]:bg-accent');
  expect(r.className).not.toContain('danger');
  const box = within(r).getByTestId('dl-checkbox');
  expect(box.className).toContain('data-[state=checked]:bg-primary');
  expect(box.className).not.toContain('#e0566a');
});
