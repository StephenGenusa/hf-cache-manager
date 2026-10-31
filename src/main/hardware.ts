// Machine detection for file advice: RAM from os, the GPU from one allow-listed nvidia-smi call.
// This is the only file allowed to import node:child_process, and only execFile (no shell, no exec/spawn).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MachineProfile } from '../core/advice/types';

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  opts: { timeout: number; maxBuffer: number; windowsHide: true },
) => Promise<{ stdout: string }>;

export const NVIDIA_SMI_ARGS: readonly string[] = [
  '--query-gpu=name,memory.total,compute_cap,display_active',
  '--format=csv,noheader,nounits',
];

const MIB = 1_048_576;
const EXEC_OPTS = { timeout: 5000, maxBuffer: 65536, windowsHide: true } as const;

const execFileAsync = promisify(execFile) as unknown as (
  file: string,
  args: readonly string[],
  opts: object,
) => Promise<{ stdout: string }>;

/** The production exec: execFile with no shell. */
export const productionExec: ExecFileLike = (file, args, opts) => execFileAsync(file, args, opts);

export interface SmiCard { name: string; bytes: number; computeCap: number | null; drivesDisplay: boolean }

/** Parses `name, memory.total (MiB), compute_cap, display_active` rows; null when nothing usable. */
export function parseNvidiaSmi(stdout: string): SmiCard[] | null {
  const cards: SmiCard[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 4) return null;
    // Count from the right so a comma inside the name cannot shift the numeric columns.
    const [mem, cap, display] = parts.slice(-3) as [string, string, string];
    const name = parts.slice(0, -3).join(', ');
    if (name === '' || name.startsWith('[')) return null;
    if (!/^\d+$/.test(mem)) return null;
    const mib = Number(mem);
    if (!Number.isSafeInteger(mib * MIB) || mib <= 0) return null;
    const capNum = /^\d+(\.\d+)?$/.test(cap) ? Number(cap) : null;
    cards.push({ name, bytes: mib * MIB, computeCap: capNum, drivesDisplay: display === 'Enabled' });
  }
  return cards.length > 0 ? cards : null;
}

export async function detectMachine(d: {
  platform: NodeJS.Platform;
  /** `os.arch()`: only an arm64 Mac (Apple Silicon) has unified memory. */
  arch: string;
  totalmem: () => number;
  exec: ExecFileLike;
}): Promise<MachineProfile> {
  const ramBytes = d.totalmem();
  const base = { platform: d.platform, ramBytes };
  const none: MachineProfile = { ...base, gpuKind: 'other', gpuName: null, gpuBytes: null, computeCap: null, drivesDisplay: false };
  if (d.platform === 'darwin') {
    return d.arch !== 'arm64' ? none   // an Intel Mac: no unified memory, and nvidia-smi is not run there
      : { ...base, gpuKind: 'apple', gpuName: null, gpuBytes: Math.floor(ramBytes * 0.75), computeCap: null, drivesDisplay: false };
  }
  try {
    const { stdout } = await d.exec('nvidia-smi', NVIDIA_SMI_ARGS, EXEC_OPTS);
    const cards = parseNvidiaSmi(String(stdout));
    if (cards === null) return none;
    const best = cards.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    return { ...base, gpuKind: 'nvidia', gpuName: best.name, gpuBytes: best.bytes, computeCap: best.computeCap, drivesDisplay: best.drivesDisplay };
  } catch {
    return none;
  }
}
