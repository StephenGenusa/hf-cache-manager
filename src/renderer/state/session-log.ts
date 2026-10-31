import { create } from 'zustand';

/** What this run of the app did, in memory only (the journal stays the durable log). Newest last. */
export interface SessionLogEntry { id: number; at: number; text: string; tone: 'success' | 'danger' | 'default' }

interface SessionLogStore {
  entries: SessionLogEntry[];
  add(text: string, tone: SessionLogEntry['tone']): void;
  clear(): void;
}

let nextId = 1;

export const useSessionLog = create<SessionLogStore>()((set) => ({
  entries: [],
  add(text, tone) {
    set((s) => ({ entries: [...s.entries, { id: nextId++, at: Date.now(), text, tone }] }));
  },
  clear() {
    set({ entries: [] });
  },
}));
