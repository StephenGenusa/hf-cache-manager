import { pyCompare } from '../compat/pyjson';
import type { ViewState } from '../compat/state';
import type { Presence } from './view-types';

export type SyncAction = 'skip' | 'update' | 'foreign' | 'create' | 'noop' | 'tombstone' | 'adopt' | 'prune';
export interface ReconcileInput { key: string; presence: Presence; stale: boolean }   // stale only meaningful when owned
export interface ReconcileItem { key: string; action: SyncAction; reason?: string }

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const byKey = (a: ReconcileItem, b: ReconcileItem): number => pyCompare(a.key, b.key);

function decide(i: ReconcileInput, state: ViewState): ReconcileItem {
  const { key, presence } = i;
  const owned = has(state.owned, key);
  if (has(state.tombstones, key)) return { key, action: 'skip', reason: 'tombstoned' };
  if (presence === 'wrong' && owned && i.stale) return { key, action: 'update' };
  if (presence === 'wrong') return { key, action: 'foreign' };
  if (presence === 'partial') return { key, action: 'create' };
  if (owned && presence === 'correct') return { key, action: 'noop' };
  if (owned && presence === 'absent') return { key, action: 'tombstone', reason: 'deleted outside sync' };
  if (presence === 'correct') return { key, action: 'adopt' };
  return { key, action: 'create' };
}

/** The decision table, first match wins; the result is sorted by key (prunes included). */
export function reconcile(desired: ReconcileInput[], state: ViewState): ReconcileItem[] {
  const items = desired.map(d => decide(d, state));
  const wanted = new Set(desired.map(d => d.key));
  for (const key of Object.keys(state.owned)) {
    if (!wanted.has(key)) items.push({ key, action: 'prune', reason: 'no longer in cache' });
  }
  return items.sort(byKey);
}

/** Prunes first (a renamed file's old key must give up its names before the new key takes them), each group key-sorted. */
export function applyOrder(items: ReconcileItem[]): ReconcileItem[] {
  const sorted = [...items].sort(byKey);
  return [...sorted.filter(i => i.action === 'prune'), ...sorted.filter(i => i.action !== 'prune')];
}

/** Owned is non-empty and every owned key is pruned or tombstoned (even n = 1). */
export function isMassRemoval(items: ReconcileItem[], state: ViewState): boolean {
  const owned = Object.keys(state.owned);
  if (owned.length === 0) return false;
  const removed = new Set(items.filter(i => i.action === 'prune' || i.action === 'tombstone').map(i => i.key));
  return owned.every(k => removed.has(k));
}

/** Candidate paths that no OTHER owned key lists may be removed; the rest are kept and their owners named. */
export function removablePaths(key: string, candidates: string[], state: ViewState):
  { remove: string[]; keepShared: Array<{ path: string; owners: string[] }> } {
  const remove: string[] = [];
  const keepShared: Array<{ path: string; owners: string[] }> = [];
  for (const path of candidates) {
    const owners = Object.keys(state.owned)
      .filter(k => k !== key && state.owned[k]!.paths.includes(path))
      .sort(pyCompare);
    if (owners.length > 0) keepShared.push({ path, owners });
    else remove.push(path);
  }
  return { remove, keepShared };
}
