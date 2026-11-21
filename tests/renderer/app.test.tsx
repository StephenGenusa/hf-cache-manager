import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { SHORTCUT_EVENT } from '../../src/renderer/lib/use-shortcuts';
import { contextOf } from '../../src/renderer/lib/shortcuts';
import { makeFakeApi, renderWithProviders } from './fake-api';

beforeEach(() => expect.hasAssertions());

test('layout A shell: top bar, left pane, right pane, action bar; disk info from the api', async () => {
  renderWithProviders(<App />);
  for (const id of ['top-bar', 'left-pane', 'right-pane', 'action-bar']) expect(screen.getByTestId(id)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId('disk-info')).toHaveTextContent('Cache 1.0 TB'));
  expect(screen.getByTestId('disk-info')).toHaveTextContent('500.0 GB free of 2.0 TB');
  expect(screen.getByRole('meter', { name: 'Disk used' })).toHaveAttribute('aria-valuenow', '75');
  await waitFor(() => expect(screen.getByTestId('repo-search')).toHaveAttribute('placeholder', 'Search 5 repos…'));
});

test('the theme button flips dark/light and remembers it', async () => {
  const user = userEvent.setup();
  renderWithProviders(<App />);
  expect(document.documentElement).toHaveClass('dark');
  await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  expect(document.documentElement).not.toHaveClass('dark');
  expect(localStorage.getItem('hfcm.theme')).toBe('light');
  await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
  expect(document.documentElement).toHaveClass('dark');
});

test('Rescan calls scan again', async () => {
  const user = userEvent.setup();
  let scans = 0;
  renderWithProviders(<App />, makeFakeApi({ scan: async () => { scans++; return { ok: true, data: (await import('./fake-api')).LIBRARY }; } }));
  await waitFor(() => expect(scans).toBe(1));
  await waitFor(() => expect(screen.getByRole('button', { name: /Rescan/ })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /Rescan/ }));
  await waitFor(() => expect(scans).toBe(2));
});

test('/ focuses search; typing / inside it does not steal focus', async () => {
  const user = userEvent.setup();
  renderWithProviders(<App />);
  await user.keyboard('/');
  expect(screen.getByTestId('repo-search')).toHaveFocus();
  await user.keyboard('/');
  expect(screen.getByTestId('repo-search')).toHaveValue('/');
});

test('one keydown listener dispatches navigation and review events', async () => {
  const user = userEvent.setup();
  renderWithProviders(<App />);
  const seen: string[] = [];
  const on = (e: Event) => seen.push((e as CustomEvent<string>).detail);
  window.addEventListener(SHORTCUT_EVENT, on);
  await user.keyboard('{ArrowDown}{ArrowUp}{Control>}{Backspace}{/Control}');
  await act(async () => { await Promise.resolve(); });
  window.removeEventListener(SHORTCUT_EVENT, on);
  expect(seen).toEqual(['next-repo', 'prev-repo', 'review']);
});

test('contextOf: inputs, checkboxes in the groups table, plain elements', () => {
  document.body.innerHTML = '<input id="t"><div data-shortcut-context="groups"><input id="c" type="checkbox"><span id="s"></span></div><p id="p"></p>';
  const el = (id: string) => document.getElementById(id);
  expect(contextOf(el('t'))).toBe('input');
  expect(contextOf(el('c'))).toBe('groups');
  expect(contextOf(el('s'))).toBe('groups');
  expect(contextOf(el('p'))).toBe('other');
  expect(contextOf(null)).toBe('other');
  expect(contextOf(document)).toBe('other');
  document.body.innerHTML = '';
});

test('right-click a repo title → Open in Download tab switches mode and looks the repo up', async () => {
  const user = userEvent.setup();
  const hubLookup = vi.fn(makeFakeApi().hubLookup);
  renderWithProviders(<App />, makeFakeApi({ hubLookup }));
  await user.click(await screen.findByText('unsloth/Qwen3.6-27B-GGUF'));
  const title = await screen.findByTestId('repo-title');
  await user.pointer({ keys: '[MouseRight]', target: title });
  await user.click(await screen.findByRole('menuitem', { name: 'Open in Download tab' }));
  expect(await screen.findByTestId('lookup-repo')).toHaveTextContent('unsloth/Qwen3.6-27B-GGUF');
  expect(hubLookup).toHaveBeenCalledWith('unsloth/Qwen3.6-27B-GGUF');
  expect(screen.getByTestId('hub-input')).toHaveValue('unsloth/Qwen3.6-27B-GGUF');
  expect(within(screen.getByRole('group', { name: 'Mode' })).getByRole('button', { name: 'Download' })).toHaveAttribute('aria-pressed', 'true');
});

test('the repo lists carry the right-click menu: the library list (Hub page, Download tab) and the recent look-ups (Hub page)', async () => {
  const user = userEvent.setup();
  const openRepoPage = vi.fn(makeFakeApi().openRepoPage);
  renderWithProviders(<App />, makeFakeApi({ openRepoPage }));
  const rowOf = async (id: string): Promise<HTMLElement> => {
    const el = (await screen.findAllByTestId('repo-row')).find((r) => r.getAttribute('data-repo-id') === id);
    if (!el) throw new Error(`no row ${id}`);
    return el;
  };
  await user.pointer({ keys: '[MouseRight]', target: await rowOf('Qwen/Qwen3-32B') });
  await user.click(await screen.findByRole('menuitem', { name: 'Open on Hugging Face' }));
  expect(openRepoPage).toHaveBeenLastCalledWith('Qwen/Qwen3-32B', 'model');
  expect(screen.queryByTestId('repo-title')).toBeNull();   // a right-click does not activate the row
  await user.pointer({ keys: '[MouseRight]', target: await rowOf('Qwen/Qwen3-32B') });
  await user.click(await screen.findByRole('menuitem', { name: 'Open in Download tab' }));
  expect(await screen.findByTestId('hub-input')).toHaveValue('Qwen/Qwen3-32B');
  await user.pointer({ keys: '[MouseRight]', target: await screen.findByTestId('recent-lookup') });
  expect(screen.queryByRole('menuitem', { name: 'Open in Download tab' })).toBeNull();
  await user.click(await screen.findByRole('menuitem', { name: 'Open on Hugging Face' }));
  expect(openRepoPage).toHaveBeenLastCalledWith('bartowski/gemma-4-31b-it-GGUF', 'model');
  expect(openRepoPage).toHaveBeenCalledTimes(2);
});
