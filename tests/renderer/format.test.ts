import { beforeEach, expect, test } from 'vitest';
import { execErrorText } from '../../src/renderer/lib/exec-copy';
import { formatAge, formatBytes } from '../../src/renderer/lib/format';

beforeEach(() => expect.hasAssertions());

test('formatBytes', () => {
  expect([0, 512, 8250, 2_000_000, 82_500_000_000, 1_420_000_000_000].map(formatBytes))
    .toEqual(['0 B', '512 B', '8.3 kB', '2.0 MB', '82.5 GB', '1.4 TB']);
});

test('formatAge', () => {
  expect([0, 4_999, 5_000, 59_000, 60_000, 3_599_000, 3_600_000, 86_399_000, 86_400_000, 3 * 86_400_000].map(formatAge))
    .toEqual(['just now', 'just now', '5 seconds ago', '59 seconds ago', '1 minute ago', '59 minutes ago', '1 hour ago',
      '23 hours ago', '1 day ago', '3 days ago']);
  expect(formatAge(-5_000)).toBe('just now');
});

test('execErrorText: review-again codes', () => {
  expect(execErrorText('STALE', 'x')).toEqual({ text: 'The cache changed since you reviewed — please review again.', reviewAgain: true });
  expect(execErrorText('FINGERPRINT', 'x').text).toBe('The cache changed since you reviewed — please review again.');
  expect(execErrorText('EXPIRED', 'x')).toEqual({ text: 'This review is more than 10 minutes old — please review again.', reviewAgain: true });
  for (const c of ['USED', 'UNKNOWN_PLAN'] as const) {
    expect(execErrorText(c, 'x')).toEqual({ text: 'This review was already used or is no longer valid — please review again.', reviewAgain: true });
  }
});

test('execErrorText: terminal codes', () => {
  expect(execErrorText('CONFIRM', 'x')).toEqual({ text: 'The confirmation text did not match.', reviewAgain: false });
  expect(execErrorText('LOCKED', 'x')).toEqual({ text: 'Another operation (sync or deletion) is running. Try again when it finishes.', reviewAgain: false });
  expect(execErrorText('ACTIVE_DOWNLOAD', 'x').text).toBe('A download is in progress in this repo. Try again when it finishes.');
  expect(execErrorText('CONTAINMENT', 'x').text).toBe('Refused: the plan touched a path outside the cache. Nothing was changed.');
  expect(execErrorText('ROLLED_BACK', 'EXDEV on rename')).toEqual({ text: 'Nothing was moved: EXDEV on rename. All changes were rolled back.', reviewAgain: false });
});

test('execErrorText: other codes show the message as given (CONFIG, IO)', () => {
  expect(execErrorText('CONFIG', 'config.toml is unreadable')).toEqual({ text: 'config.toml is unreadable', reviewAgain: false });
  expect(execErrorText('IO', 'disk full')).toEqual({ text: 'disk full', reviewAgain: false });
});

test('execErrorText: INTERNAL never shows raw text as user copy (carry)', () => {
  const r = execErrorText('INTERNAL', 'TypeError: boom at /x/y.js:1');
  expect(r.text).not.toContain('boom');
  expect(r.text).toBe('Something went wrong inside the app. Nothing was changed by this step.');
  expect(r.details).toBe('TypeError: boom at /x/y.js:1');
  expect(execErrorText('IO', 'disk full').details).toBeUndefined();
});

test('execErrorText: a stale lock of our own (structured flag from main) adds the manual fix', () => {
  const r = execErrorText('LOCKED', 'whatever the core says', { detailPath: '/ud/.lock', staleOwnLock: true });
  expect(r.text).toBe('Another operation (sync or deletion) is running. Try again when it finishes. '
    + 'If no other copy of this app is running on this or any other computer that uses this cache, quit the app and delete /ud/.lock.');
  // the message text is never parsed: a pid in it does nothing without the flag
  expect(execErrorText('LOCKED', 'in progress (process 4242).', { detailPath: '/ud/.lock' }).text)
    .toBe('Another operation (sync or deletion) is running. Try again when it finishes.');
  expect(execErrorText('LOCKED', 'x', { staleOwnLock: true }).text)
    .toBe('Another operation (sync or deletion) is running. Try again when it finishes.');
});
