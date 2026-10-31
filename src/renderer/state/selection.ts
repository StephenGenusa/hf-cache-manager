import { create } from 'zustand';
import type { Selection } from '../../core/types';

export interface RepoSelectionState { groupKeys: string[]; unlockComponents: boolean }

interface SelectionStore {
  byRepo: Record<string, RepoSelectionState>;
  /** Selects or deselects a group. A locked group is ignored until the repo's components are unlocked. */
  toggleGroup(repoId: string, key: string, locked: boolean): void;
  /** Turning unlock off also drops the selected locked groups (`lockedKeys` are the repo's locked group keys). */
  setUnlock(repoId: string, on: boolean, lockedKeys: string[]): void;
  clear(): void;
  /** After a rescan: drops repos and group keys that no longer exist, silently. */
  reconcile(lib: Array<{ repoId: string; groupKeys: string[] }>): void;
  toSelection(): Selection | null;
  groupCount(): number;
}

const without = (rec: Record<string, RepoSelectionState>, repoId: string): Record<string, RepoSelectionState> => {
  const next = { ...rec };
  delete next[repoId];
  return next;
};

export const useSelection = create<SelectionStore>()((set, get) => ({
  byRepo: {},

  toggleGroup(repoId, key, locked) {
    set((s) => {
      const cur = s.byRepo[repoId] ?? { groupKeys: [], unlockComponents: false };
      if (locked && !cur.unlockComponents) return s;
      const groupKeys = cur.groupKeys.includes(key) ? cur.groupKeys.filter((k) => k !== key) : [...cur.groupKeys, key];
      if (groupKeys.length === 0 && !cur.unlockComponents) return { byRepo: without(s.byRepo, repoId) };
      return { byRepo: { ...s.byRepo, [repoId]: { groupKeys, unlockComponents: cur.unlockComponents } } };
    });
  },

  setUnlock(repoId, on, lockedKeys) {
    set((s) => {
      const cur = s.byRepo[repoId] ?? { groupKeys: [], unlockComponents: false };
      const groupKeys = on ? cur.groupKeys : cur.groupKeys.filter((k) => !lockedKeys.includes(k));
      if (groupKeys.length === 0 && !on) return { byRepo: without(s.byRepo, repoId) };
      return { byRepo: { ...s.byRepo, [repoId]: { groupKeys, unlockComponents: on } } };
    });
  },

  clear() {
    set({ byRepo: {} });
  },

  reconcile(lib) {
    set((s) => {
      const known = new Map(lib.map((r) => [r.repoId, new Set(r.groupKeys)]));
      let changed = false;
      const byRepo: Record<string, RepoSelectionState> = {};
      for (const [repoId, cur] of Object.entries(s.byRepo)) {
        const keys = known.get(repoId);
        if (keys === undefined) { changed = true; continue; }
        const groupKeys = cur.groupKeys.filter((k) => keys.has(k));
        if (groupKeys.length !== cur.groupKeys.length) changed = true;
        if (groupKeys.length === 0 && !cur.unlockComponents) continue;
        byRepo[repoId] = groupKeys.length === cur.groupKeys.length ? cur : { ...cur, groupKeys };
      }
      return changed ? { byRepo } : s;
    });
  },

  toSelection() {
    const repos = Object.entries(get().byRepo)
      .filter(([, v]) => v.groupKeys.length > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([repoId, v]) => ({
        repoId, whole: false as const, groupKeys: [...v.groupKeys].sort(), unlockComponents: v.unlockComponents,
      }));
    return repos.length === 0 ? null : { repos };
  },

  groupCount() {
    return Object.values(get().byRepo).reduce((n, v) => n + v.groupKeys.length, 0);
  },
}));
