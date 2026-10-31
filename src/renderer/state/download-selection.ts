import { create } from 'zustand';

/**
 * Download mode's own selection (group keys of the current look-up). It is separate from the library's deletion
 * selection on purpose: nothing here can reach planDelete or executePlan, and a mode switch clears both.
 */
interface DownloadSelectionStore {
  keys: string[];
  toggle(key: string): void;
  set(keys: string[]): void;
  clear(): void;
}

export const useDownloadSelection = create<DownloadSelectionStore>()((set) => ({
  keys: [],
  toggle: (key) => set((s) => ({ keys: s.keys.includes(key) ? s.keys.filter((k) => k !== key) : [...s.keys, key] })),
  set: (keys) => set({ keys: [...new Set(keys)] }),
  clear: () => set({ keys: [] }),
}));
