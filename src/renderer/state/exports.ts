import { create } from 'zustand';
import type { ExportDTO } from '../../shared/api';

interface ExportsState {
  /** This session's exports, newest first. */
  items: ExportDTO[];
  setItems(items: ExportDTO[]): void;
  /** A progress event: replaces the export it names, or puts a new one first. */
  apply(e: ExportDTO): void;
}

export const useExports = create<ExportsState>((set) => ({
  items: [],
  setItems: (items) => set({ items }),
  apply: (e) => set((s) => ({ items: s.items.some((x) => x.id === e.id) ? s.items.map((x) => (x.id === e.id ? e : x)) : [e, ...s.items] })),
}));

export const runningExports = (items: readonly ExportDTO[]): number => items.filter((e) => e.status === 'running').length;
