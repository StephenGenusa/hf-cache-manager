import { describe, expect, test } from 'vitest';
import { AUTO_EMPTY_DEFAULT_DAYS, DAY_MS, autoEmptyDue, type HeldDeletion } from '../../../src/core/hold/held';
import type { HoldManifest } from '../../../src/core/hold/manifest';

const T = 1_800_000_000_000;
type Ok = Extract<HeldDeletion, { ok: true }>;

function held(createdAt: number, extra: Partial<Ok> = {}): Ok {
  const manifest = { createdAt, storeItems: [] } as unknown as HoldManifest;
  return { ok: true, deletionId: `d-${createdAt}`, dir: `/h/d-${createdAt}`, manifest, manifestText: '{}',
    heldCount: 1, otherEntries: 0, interrupted: false, ...extra };
}

describe('autoEmptyDue', () => {
  test('due at exactly 14 days, not 1 ms before', () => {
    const d = held(T);
    expect(autoEmptyDue([d], T + 14 * DAY_MS - 1, 14)).toEqual([]);
    expect(autoEmptyDue([d], T + 14 * DAY_MS, 14)).toEqual([d]);
  });
  test('custom days, never, and zero', () => {
    const d = held(T);
    expect(autoEmptyDue([d], T + 3 * DAY_MS, 3)).toEqual([d]);
    expect(autoEmptyDue([d], T + 10_000 * DAY_MS, 'never')).toEqual([]);
    expect(autoEmptyDue([held(T, { heldCount: 0 })], T + 10_000 * DAY_MS, 'never')).toEqual([]);
    expect(autoEmptyDue([d], T, 0)).toEqual([d]);
  });
  test('a createdAt in the future is never due', () => {
    expect(autoEmptyDue([held(T + DAY_MS)], T, 0)).toEqual([]);
  });
  test('corrupt and interrupted deletions are never due; a deletion holding nothing is due now', () => {
    const corrupt: HeldDeletion = { ok: false, deletionId: 'x-00000000', dir: '/h/x-00000000', error: 'JSON' };
    const moving = held(T - 100 * DAY_MS, { interrupted: true });
    const empty = held(T, { heldCount: 0 });
    expect(autoEmptyDue([corrupt, moving, empty], T, 14)).toEqual([empty]);
  });
  test('all done flags false but a real held file: not due at age 0', () => {
    const d = held(T, { heldCount: 1, otherEntries: 0 });
    expect(autoEmptyDue([d], T, 14)).toEqual([]);
  });
  test('nothing held but unaccounted entries: the age rule applies', () => {
    const d = held(T, { heldCount: 0, otherEntries: 2 });
    expect(autoEmptyDue([d], T, 14)).toEqual([]);
    expect(autoEmptyDue([d], T + 14 * DAY_MS, 14)).toEqual([d]);
  });
  test('keeps input order', () => {
    const a = held(T - 20 * DAY_MS);
    const b = held(T - 30 * DAY_MS);
    expect(autoEmptyDue([a, b], T, 14)).toEqual([a, b]);
  });
  test.each([-1, 1.5, NaN, Infinity])('rejects days=%s', (bad) => {
    expect(() => autoEmptyDue([], T, bad)).toThrow(expect.objectContaining({ code: 'BAD_DAYS' }));
  });
  test('a deletion waits while one that needs its payload is not due, along a chain', () => {
    const P = (n: number): string => `/hub/blobs/0${n}/0${n}${'f'.repeat(62)}`;
    const item = (n: number, heldPath: string | null) => ({ originalPath: P(n), heldPath });
    const withStore = (d: Ok, items: Array<{ originalPath: string; heldPath: string | null }>): Ok =>
      ({ ...d, manifest: { ...d.manifest, storeItems: items } as unknown as HoldManifest });
    // x needs P1, which y holds; y needs P2, which z holds; y also holds P3 nobody needs
    const x = withStore(held(T, { deletionId: 'x' }), [item(1, null)]);
    const y = withStore(held(T - 30 * DAY_MS, { deletionId: 'y' }), [item(1, '/h/y/store/01/p'), item(2, null), item(3, '/h/y/store/03/p')]);
    const z = withStore(held(T - 30 * DAY_MS, { deletionId: 'z' }), [item(2, '/h/z/store/02/p')]);
    expect(autoEmptyDue([x, y, z], T, 14)).toEqual([]);                       // x not due → y waits → z waits
    expect(autoEmptyDue([y, z], T, 14)).toEqual([y, z]);
    expect(autoEmptyDue([x, z], T, 14)).toEqual([z]);                         // x needs nothing z holds
    const x2 = withStore(x, [item(3, null)]);                                // a payload held by y, needed by x
    expect(autoEmptyDue([x2, y, z], T, 14)).toEqual([]);
    expect(autoEmptyDue([withStore(x, [item(1, '/h/x/store/01/p')]), y, z], T, 14)).toEqual([y, z]);   // x holds it too: no need
  });
  test('AUTO_EMPTY_DEFAULT_DAYS is 14', () => expect(AUTO_EMPTY_DEFAULT_DAYS).toBe(14));
});
