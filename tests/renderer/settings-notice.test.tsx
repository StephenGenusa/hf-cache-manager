// Settings and the startup notices, including the auto-empty countdown carries.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { SettingsView } from '../../src/renderer/components/SettingsView';
import { NOTICE_POLL_MS, StartupNotice } from '../../src/renderer/components/StartupNotice';
import { resetToasts, Toaster } from '../../src/renderer/components/ui/toast';
import type { ApiResult, HfcmApi, SettingsDTO, StartupNoticeDTO } from '../../src/shared/api';
import { LIBRARY, makeFakeApi, renderWithProviders } from './fake-api';

beforeEach(() => {
  expect.hasAssertions();
  resetToasts();
});

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const SETTINGS: SettingsDTO = {
  hubRoot: '/data/models/hub', hubPresent: true, configPath: '/home/u/.config/hfhub/config.toml', configExists: true, configError: null, settingsError: null,
  views: [
    { view: 'lmstudio', root: '/home/u/.lmstudio/models', rootExists: true, statePath: '/home/u/.lmstudio/state.json', aliases: { 'a/b': 'c' }, problem: null },
    { view: 'ollama', root: '/home/u/.ollama/models', rootExists: false, statePath: null, aliases: {}, problem: 'VIEW_ROOTS_OVERLAP: overlaps LM Studio' },
  ],
  holdRoot: '/data/models/.hfcm-held', holdUnavailableReason: null, journalPath: '/ud/journal', symlinks: { ok: true, detail: '' },
  autoEmptyDays: 14, platform: 'linux',
};
const journal: StartupNoticeDTO = {
  kind: 'journal', planId: 'plan-1', startedAtMs: 1, purpose: 'delete', mode: 'hold', opsStarted: 2, lastOpPath: null,
  message: 'An operation did not finish: a delete (plan plan-1) started 2 step(s).',
};
const notice = (kind: Exclude<StartupNoticeDTO['kind'], 'journal'>, message: string): StartupNoticeDTO =>
  ({ kind, id: kind, message }) as StartupNoticeDTO;
const PENDING = { ...notice('auto-empty-pending', '3 item(s) in Recently Deleted are older than 14 days and will be emptied in 10 minutes (4.2 GB freed). Open Recently Deleted to restore any you want to keep.'), emptyAt: null } as StartupNoticeDTO;

test('settings shows every field, including auto-empty with Never, and saves through main', async () => {
  const setAutoEmptyDays = vi.fn((_d: number | null) => Promise.resolve(ok(null)));
  renderWithProviders(<SettingsView />, makeFakeApi({ settings: () => Promise.resolve(ok(SETTINGS)), setAutoEmptyDays }));
  expect(await screen.findByTestId('set-hub')).toHaveTextContent('/data/models/hub');
  expect(screen.getByTestId('set-config')).toHaveTextContent('/home/u/.config/hfhub/config.toml (found)');
  expect(screen.getByTestId('set-view-lmstudio')).toHaveTextContent('/home/u/.lmstudio/models (exists)');
  expect(screen.getByTestId('set-view-lmstudio')).toHaveTextContent('alias a/b → c');
  expect(screen.getByTestId('set-view-ollama')).toHaveTextContent('(missing)');
  expect(screen.getByTestId('set-view-ollama')).toHaveTextContent('VIEW_ROOTS_OVERLAP');
  expect(screen.getByTestId('set-hold')).toHaveTextContent('/data/models/.hfcm-held');
  expect(screen.getByTestId('set-journal')).toHaveTextContent('/ud/journal');
  expect(screen.getByTestId('set-symlinks')).toHaveTextContent('supported');
  expect(screen.getByTestId('set-platform')).toHaveTextContent('linux');
  // The config.toml rows are read-only: no inputs inside the definition list (the Advice section has its own fields).
  expect(within(screen.getByTestId('set-hub').closest('dl')!).queryAllByRole('textbox')).toHaveLength(0);
  expect(within(screen.getByTestId('set-hub').closest('dl')!).getAllByRole('combobox')).toHaveLength(1);
  expect(screen.getByTestId('settings-note')).toHaveTextContent('read-only');
  const adviceSection = screen.getByTestId('advice-settings');
  const all = [...screen.getByTestId('settings-view').querySelectorAll('input, select, textarea')];
  expect(all.length).toBeGreaterThan(0);
  for (const el of all) {
    if (el.getAttribute('data-testid') === 'auto-empty-select') continue;
    expect(adviceSection.contains(el)).toBe(true);
  }
  const sel = screen.getByTestId('auto-empty-select');
  expect(sel).toHaveValue('14');
  await userEvent.setup().selectOptions(sel, 'Never');
  expect(setAutoEmptyDays).toHaveBeenCalledWith(null);
});

test('settings shows a config error and the settings-unreadable notice', async () => {
  renderWithProviders(<SettingsView />, makeFakeApi({
    settings: () => Promise.resolve(ok({ ...SETTINGS, configError: 'bad TOML at line 3', settingsError: 'bad json', autoEmptyDays: null })),
  }));
  expect(await screen.findByText('bad TOML at line 3')).toBeVisible();
  expect(await screen.findByTestId('settings-unreadable')).toHaveTextContent('bad json');
  expect(screen.getByTestId('auto-empty-select')).toHaveValue('never');
});

test('startup notice shows each kind with its message and acknowledges on dismiss', async () => {
  const notices = [
    journal,
    notice('settings-unreadable', 'settings msg'), notice('held-unreadable', 'held msg'), notice('auto-empty-skipped', 'clock msg'),
  ];
  let current = notices;
  const ackStartupNotice = vi.fn((id: string) => { current = current.filter((n) => (n.kind === 'journal' ? n.planId : n.id) !== id); return Promise.resolve(ok(null)); });
  renderWithProviders(<StartupNotice />, makeFakeApi({ startupNotices: () => Promise.resolve(ok(current)), ackStartupNotice }));
  const banners = await screen.findAllByTestId('startup-notice');
  expect(banners.map((b) => b.getAttribute('data-kind'))).toEqual(['journal', 'settings-unreadable', 'held-unreadable', 'auto-empty-skipped']);
  expect(banners[0]).toHaveTextContent('An operation did not finish');
  await userEvent.setup().click(within(banners[0]!).getByTestId('notice-dismiss'));
  expect(ackStartupNotice).toHaveBeenCalledWith('plan-1');
  await waitFor(() => expect(screen.getAllByTestId('startup-notice')).toHaveLength(3));
  await userEvent.setup().click(within(screen.getAllByTestId('startup-notice')[0]!).getByTestId('notice-dismiss'));
  expect(ackStartupNotice).toHaveBeenLastCalledWith('settings-unreadable');
});

test('nothing renders when there are no notices', async () => {
  renderWithProviders(<StartupNotice />, makeFakeApi());
  await waitFor(() => expect(screen.queryByTestId('startup-notices')).toBeNull());
});

test('auto-empty-pending shows count, days and bytes, a keep-them dismissal and a link to Recently Deleted', async () => {
  const onOpenHeld = vi.fn();
  const ackStartupNotice = vi.fn(() => Promise.resolve(ok(null)));
  renderWithProviders(<StartupNotice onOpenHeld={onOpenHeld} />, makeFakeApi({ startupNotices: () => Promise.resolve(ok([PENDING])), ackStartupNotice }));
  const banner = await screen.findByTestId('startup-notice');
  expect(banner).toHaveTextContent('3 item(s)');
  expect(banner).toHaveTextContent('14 days');
  expect(banner).toHaveTextContent('4.2 GB');
  const user = userEvent.setup();
  await user.click(within(banner).getByTestId('notice-open-held'));
  expect(onOpenHeld).toHaveBeenCalled();
  await user.click(within(banner).getByRole('button', { name: 'Dismiss — keep them this session' }));
  expect(ackStartupNotice).toHaveBeenCalledWith('auto-empty-pending');
});

test('dismissing after the run started (NOT_FOUND) is information, not an error', async () => {
  const msg = 'Recently Deleted was already being emptied; anything not emptied yet is kept for this session.';
  const ackStartupNotice = vi.fn(() => Promise.resolve<ApiResult<null>>({ ok: false, error: { code: 'NOT_FOUND', message: msg } }));
  renderWithProviders(<StartupNotice />, makeFakeApi({ startupNotices: () => Promise.resolve(ok([PENDING])), ackStartupNotice }));
  await userEvent.setup().click(await screen.findByTestId('notice-dismiss'));
  const info = await screen.findByTestId('notice-info');
  expect(info).toHaveTextContent(msg);
  expect(info).toHaveAttribute('data-tone', 'info');
  expect(screen.queryByTestId('notice-error')).toBeNull();
});

test('any other dismissal failure is an error', async () => {
  const ackStartupNotice = vi.fn(() => Promise.resolve<ApiResult<null>>({ ok: false, error: { code: 'NOT_FOUND', message: 'That notice is no longer pending.' } }));
  renderWithProviders(<StartupNotice />, makeFakeApi({ startupNotices: () => Promise.resolve(ok([journal])), ackStartupNotice }));
  await userEvent.setup().click(await screen.findByTestId('notice-dismiss'));
  expect(await screen.findByTestId('notice-error')).toHaveTextContent('no longer pending');
});

test('the library is refreshed when the pending notice clears', async () => {
  const scan = vi.fn(() => Promise.resolve(ok(LIBRARY)));
  let current: StartupNoticeDTO[] = [PENDING];
  const ackStartupNotice = vi.fn(() => { current = []; return Promise.resolve(ok(null)); });
  const api: HfcmApi = makeFakeApi({ scan, startupNotices: () => Promise.resolve(ok(current)), ackStartupNotice });
  renderWithProviders(<Toaster><App /></Toaster>, api);
  await screen.findByTestId('startup-notice');
  await waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
  await userEvent.setup().click(screen.getByTestId('notice-dismiss'));
  await waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
});

test('an auto-empty run shows a toast once', async () => {
  const lib = { ...LIBRARY, lastAutoEmpty: { at: 99, count: 2, freedBytes: 4_200_000_000, days: 7 } };
  renderWithProviders(<Toaster><App /></Toaster>, makeFakeApi({ scan: () => Promise.resolve(ok(lib)) }));
  expect(await screen.findByText('Recently Deleted: emptied 2 deletion(s) older than 7 days, freeing 4.2 GB.')).toBeVisible();
});

test('the top-bar Sync button opens the sync dialog', async () => {
  const planSync = vi.fn(() => Promise.resolve(ok({ planId: 'p', createdAt: 0, expiresAt: 1, views: [], warnings: [] })));
  renderWithProviders(<Toaster><App /></Toaster>, makeFakeApi({ planSync }));
  const btn = await screen.findByTestId('btn-sync');
  await waitFor(() => expect(btn).toBeEnabled());
  await userEvent.setup().click(btn);
  expect(await screen.findByTestId('sync-dialog')).toBeVisible();
  expect(planSync).toHaveBeenCalledTimes(1);
});

// ---- edge cases ---------------------------------------------------------------------------------------------------

test('a notice main posts after the scan finishes is fetched when the scan settles and the banner shows', async () => {
  let scanned = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const scan = vi.fn(async () => { await gate; scanned = true; return ok(LIBRARY); });
  const startupNotices = vi.fn(() => Promise.resolve(ok(scanned ? [PENDING] : [])));
  renderWithProviders(<StartupNotice />, makeFakeApi({ scan, startupNotices }));
  await waitFor(() => expect(startupNotices).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('startup-notice')).toBeNull();
  release();
  const banner = await screen.findByTestId('startup-notice');
  expect(banner).toHaveAttribute('data-kind', 'auto-empty-pending');
  expect(startupNotices.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('the notices are also polled every 30 seconds', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    expect(NOTICE_POLL_MS).toBe(30_000);
    let current: StartupNoticeDTO[] = [];
    const startupNotices = vi.fn(() => Promise.resolve(ok(current)));
    renderWithProviders(<StartupNotice />, makeFakeApi({ startupNotices }));
    await waitFor(() => expect(startupNotices).toHaveBeenCalledTimes(1));
    current = [journal];
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS); });
    await waitFor(() => expect(screen.queryByTestId('startup-notice')).not.toBeNull());
  } finally {
    vi.useRealTimers();
  }
});

test('a failed notices fetch shows an error with Retry, and Retry fetches again', async () => {
  const startupNotices = vi.fn()
    .mockRejectedValueOnce(new Error('ipc down'))
    .mockResolvedValue(ok([journal]));
  renderWithProviders(<StartupNotice />, makeFakeApi({ startupNotices }));
  const err = await screen.findByTestId('notices-error');
  expect(err).toHaveTextContent('Startup notices could not be read');
  await userEvent.setup().click(within(err).getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('startup-notice')).toHaveTextContent('An operation did not finish');
  expect(screen.queryByTestId('notices-error')).toBeNull();
});

test('Settings shows the unreadable-settings state from the settings DTO, with no banner involved', async () => {
  renderWithProviders(<SettingsView />, makeFakeApi({
    settings: () => Promise.resolve(ok({ ...SETTINGS, settingsError: 'EACCES: settings.json' })),
    startupNotices: () => Promise.resolve(ok([])),   // the banner was dismissed
  }));
  expect(await screen.findByTestId('settings-unreadable')).toHaveTextContent('EACCES: settings.json');
  expect(screen.getByTestId('settings-unreadable')).toHaveTextContent('auto-empty is off');
});

test('an armed pending notice shows the clock time and the minutes left, recomputed on each render', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  try {
    const t0 = new Date(2026, 9, 29, 12, 0, 0).getTime();
    vi.setSystemTime(t0);
    const armed = { ...PENDING, emptyAt: t0 + 10 * 60_000, message: 'armed message' } as StartupNoticeDTO;
    renderWithProviders(<StartupNotice />, makeFakeApi({ startupNotices: () => Promise.resolve(ok([armed])) }));
    const cd = await screen.findByTestId('notice-countdown');
    expect(cd).toHaveTextContent(`will be emptied at ${new Date(t0 + 600_000).toLocaleTimeString()} (in 10 min)`);
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * NOTICE_POLL_MS); });
    expect(screen.getByTestId('notice-countdown')).toHaveTextContent('(in 9 min)');   // the poll returned identical data, yet the time left moved
  } finally {
    vi.useRealTimers();
  }
});

test('an unarmed pending notice (emptyAt null) shows no countdown line', async () => {
  renderWithProviders(<StartupNotice />, makeFakeApi({ startupNotices: () => Promise.resolve(ok([PENDING])) }));
  await screen.findByTestId('startup-notice');
  expect(screen.queryByTestId('notice-countdown')).toBeNull();
});

test('a pending notice that arrives while a dialog is open also appears as an alert toast', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    let current: StartupNoticeDTO[] = [];
    const planSync = vi.fn(() => Promise.resolve(ok({ planId: 'p', createdAt: 0, expiresAt: 1, views: [], warnings: [] })));
    renderWithProviders(<Toaster><App /></Toaster>, makeFakeApi({ planSync, startupNotices: () => Promise.resolve(ok(current)) }));
    const btn = await screen.findByTestId('btn-sync');
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(btn);
    await screen.findByTestId('sync-dialog');
    current = [PENDING];
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS); });
    const alert = await screen.findByTestId('pending-toast');
    expect(alert).toHaveTextContent('3 item(s) in Recently Deleted');
    expect(screen.getByTestId('sync-dialog')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
