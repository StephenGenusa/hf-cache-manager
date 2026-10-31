// The machine profile and the advice settings: pure data with no Node and no core imports, so the
// renderer's project (tsconfig.web.json) can type the IPC DTOs with them.
import type { Platform, Tool } from '../../shared/knowledge/rules';

export type GpuKind = 'nvidia' | 'apple' | 'other';

export interface MachineProfile {
  platform: Platform; ramBytes: number; gpuName: string | null; gpuBytes: number | null;
  gpuKind: GpuKind; computeCap: number | null; drivesDisplay: boolean;
}

export interface AdviceSettings {
  gpuBytes: number | null; gpuKind: GpuKind | null; ramBytes: number | null; drivesDisplay: boolean | null;
  context: 8192 | 16384 | 32768 | 65536 | 131072; kvType: 'f16' | 'q8_0'; tools: Tool[] | null;
}
