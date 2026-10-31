import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test } from 'vitest';
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
