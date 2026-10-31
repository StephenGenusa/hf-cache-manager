import { beforeEach, describe, expect, it } from 'vitest';
import type { ViewState } from '../../../src/core/compat/state';
import {
  applyOrder, isMassRemoval, reconcile, removablePaths,
  type ReconcileInput, type SyncAction,
} from '../../../src/core/views/reconcile';
import { useCanaries } from '../../helpers/canary';

useCanaries();
beforeEach(() => expect.hasAssertions());

const st = (owned: Record<string, string[]>, tomb: string[] = []): ViewState => ({ version: 1,
  owned: Object.fromEntries(Object.entries(owned).map(([k, p]) => [k, { paths: p, sha256: 'x' }])),
  tombstones: Object.fromEntries(tomb.map(k => [k, '2026-10-25T00:00:00'])) });

describe('reconcile', () => {
  it.each<[string, ReconcileInput, ViewState, SyncAction, string | undefined]>([
    ['tombstoned wins', { key: 'k', presence: 'absent', stale: false }, st({}, ['k']), 'skip', 'tombstoned'],
    ['tombstoned even if owned+wrong', { key: 'k', presence: 'wrong', stale: true }, st({ k: ['a'] }, ['k']), 'skip', 'tombstoned'],
    ['owned stale -> update', { key: 'k', presence: 'wrong', stale: true }, st({ k: ['a'] }), 'update', undefined],
    ['test_owned_but_wrong_is_reported_not_touched', { key: 'k', presence: 'wrong', stale: false }, st({ k: ['a'] }), 'foreign', undefined],
    ['not owned wrong -> foreign', { key: 'k', presence: 'wrong', stale: false }, st({}), 'foreign', undefined],
    ['not owned, stale ignored', { key: 'k', presence: 'wrong', stale: true }, st({}), 'foreign', undefined],
    ['partial owned -> create', { key: 'k', presence: 'partial', stale: false }, st({ k: ['a'] }), 'create', undefined],
    ['partial not owned -> create', { key: 'k', presence: 'partial', stale: false }, st({}), 'create', undefined],
    ['owned correct -> noop', { key: 'k', presence: 'correct', stale: false }, st({ k: ['a'] }), 'noop', undefined],
    ['owned absent -> tombstone', { key: 'k', presence: 'absent', stale: false }, st({ k: ['a'] }), 'tombstone', 'deleted outside sync'],
    ['correct not owned -> adopt', { key: 'k', presence: 'correct', stale: false }, st({}), 'adopt', undefined],
    ['absent not owned -> create', { key: 'k', presence: 'absent', stale: false }, st({}), 'create', undefined],
  ])('%s', (_n, input, state, action, reason) => {
    expect(reconcile([input], state)).toEqual([{ key: 'k', action, ...(reason ? { reason } : {}) }]);
  });

  it('owned key not desired -> prune', () => {
    expect(reconcile([], st({ 'o/n:a.gguf': ['o/n/a.gguf'] })))
      .toEqual([{ key: 'o/n:a.gguf', action: 'prune', reason: 'no longer in cache' }]);
  });

  it('is sorted by code point, prunes included; inherited names are not owned', () => {
    const out = reconcile(
      [{ key: '\u{1F600}', presence: 'absent', stale: false }, { key: 'b', presence: 'absent', stale: false },
        { key: 'toString', presence: 'absent', stale: false }],
      st({ '～': ['p'], a: ['q'] }));
    expect(out.map(i => `${i.key}:${i.action}`)).toEqual(
      ['a:prune', 'b:create', 'toString:create', '～:prune', '\u{1F600}:create']);
  });
});

describe('applyOrder', () => {
  it('runs prunes first', () => {
    const items = reconcile([{ key: 'a', presence: 'absent', stale: false }], st({ z: ['p'] }));
    expect(applyOrder(items).map(i => i.action)).toEqual(['prune', 'create']);
  });
  it('key-sorts each group and does not mutate the input', () => {
    const items = [
      { key: 'c', action: 'create' as const }, { key: 'b', action: 'prune' as const },
      { key: 'a', action: 'noop' as const }, { key: 'z', action: 'prune' as const }, { key: 'A', action: 'prune' as const }];
    const copy = [...items];
    expect(applyOrder(items).map(i => i.key)).toEqual(['A', 'b', 'z', 'a', 'c']);
    expect(items).toEqual(copy);
  });
});

describe('isMassRemoval', () => {
  it('is "all owned keys pruned or tombstoned", even n=1', () => {
    expect(isMassRemoval(reconcile([], st({ k: ['a'] })), st({ k: ['a'] }))).toBe(true);
    const s = st({ k: ['a'], j: ['b'] });
    expect(isMassRemoval(reconcile([{ key: 'j', presence: 'correct', stale: false }], s), s)).toBe(false);
    expect(isMassRemoval([], st({}))).toBe(false);
  });
  it('counts tombstones, mixed with prunes, and fails if any owned key survives', () => {
    const s = st({ k: ['a'], j: ['b'] });
    const mixed = reconcile([{ key: 'k', presence: 'absent', stale: false }], s);
    expect(isMassRemoval(mixed, s)).toBe(true);
    const kept = reconcile([{ key: 'k', presence: 'absent', stale: false }, { key: 'j', presence: 'wrong', stale: false }], s);
    expect(isMassRemoval(kept, s)).toBe(false);
    expect(isMassRemoval([{ key: 'k', action: 'prune' }], s)).toBe(false);
    expect(isMassRemoval([{ key: 'k', action: 'noop' }], st({ k: ['a'] }))).toBe(false);
  });
});

describe('removablePaths', () => {
  it('test_apply_prune_keeps_paths_owned_by_others', () => {
    expect(removablePaths('k', ['x/a', 'x/shared'], st({ k: ['x/a', 'x/shared'], j: ['x/shared'] })))
      .toEqual({ remove: ['x/a'], keepShared: [{ path: 'x/shared', owners: ['j'] }] });
  });
  it('lists every other owner sorted, ignores the key itself, and handles empties', () => {
    const s = st({ k: ['p'], z: ['p'], b: ['p', 'q'] });
    expect(removablePaths('k', ['p', 'r'], s)).toEqual({ remove: ['r'], keepShared: [{ path: 'p', owners: ['b', 'z'] }] });
    expect(removablePaths('k', [], s)).toEqual({ remove: [], keepShared: [] });
  });
});
