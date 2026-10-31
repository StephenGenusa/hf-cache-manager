import { beforeEach, expect, test } from 'vitest';
import { shortcutFor } from '../../src/renderer/lib/shortcuts';

beforeEach(() => expect.hasAssertions());

type Ctx = 'input' | 'groups' | 'other';
const k = (key: string, context: Ctx = 'other', mod: { ctrlKey?: boolean; metaKey?: boolean } = {}) =>
  shortcutFor({ key, ctrlKey: false, metaKey: false, context, ...mod });

test('/ focuses search except while typing', () => {
  expect(k('/')).toBe('focus-search');
  expect(k('/', 'groups')).toBe('focus-search');
  expect(k('/', 'input')).toBeNull();
});

test('arrows navigate repos, or rows inside the groups table, never inside an input', () => {
  expect(k('ArrowDown')).toBe('next-repo');
  expect(k('ArrowUp')).toBe('prev-repo');
  expect(k('ArrowDown', 'groups')).toBe('next-row');
  expect(k('ArrowUp', 'groups')).toBe('prev-row');
  expect(k('ArrowDown', 'input')).toBeNull();
  expect(k('ArrowUp', 'input')).toBeNull();
});

test('Ctrl/Cmd+Backspace opens review in other and groups contexts, not in an input', () => {
  expect(k('Backspace', 'other', { ctrlKey: true })).toBe('review');
  expect(k('Backspace', 'other', { metaKey: true })).toBe('review');
  expect(k('Backspace', 'groups', { ctrlKey: true })).toBe('review');
  expect(k('Backspace', 'input', { ctrlKey: true })).toBeNull();
  expect(k('Backspace', 'other')).toBeNull();
});

test('space is native on a focused checkbox; other keys do nothing', () => {
  expect(k(' ')).toBeNull();
  expect(k(' ', 'groups')).toBeNull();
  expect(k('a')).toBeNull();
});

test('modified navigation keys and slash are ignored', () => {
  expect(k('ArrowDown', 'other', { ctrlKey: true })).toBeNull();
  expect(k('/', 'other', { metaKey: true })).toBeNull();
});
