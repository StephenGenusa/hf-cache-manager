import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { applyTheme, readTheme, THEME_KEY, useTheme } from '../../src/renderer/lib/theme';

beforeEach(() => expect.hasAssertions());

test('dark by default; stored light wins; garbage falls back to dark', () => {
  expect(readTheme()).toBe('dark');
  localStorage.setItem(THEME_KEY, 'light');
  expect(readTheme()).toBe('light');
  localStorage.setItem(THEME_KEY, 'neon');
  expect(readTheme()).toBe('dark');
});

test('applyTheme toggles the html class and stores the choice', () => {
  applyTheme('dark');
  expect(document.documentElement).toHaveClass('dark');
  applyTheme('light');
  expect(document.documentElement).not.toHaveClass('dark');
  expect(localStorage.getItem('hfcm.theme')).toBe('light');
});

test('useTheme starts dark, toggles, and persists', () => {
  const { result } = renderHook(() => useTheme());
  expect(result.current.theme).toBe('dark');
  expect(document.documentElement).toHaveClass('dark');
  act(() => result.current.toggle());
  expect(result.current.theme).toBe('light');
  expect(localStorage.getItem(THEME_KEY)).toBe('light');
  act(() => result.current.toggle());
  expect(result.current.theme).toBe('dark');
});

test('blocked storage never throws', () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(readTheme()).toBe('dark');
  expect(() => applyTheme('light')).not.toThrow();
  expect(document.documentElement).not.toHaveClass('dark');
  get.mockRestore();
  set.mockRestore();
});
