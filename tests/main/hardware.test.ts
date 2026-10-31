import { describe, expect, it, vi } from 'vitest';
import { detectMachine, NVIDIA_SMI_ARGS, parseNvidiaSmi, type ExecFileLike } from '../../src/main/hardware';

const GIB = 1024 ** 3;
const OTHER = { gpuKind: 'other', gpuName: null, gpuBytes: null, computeCap: null, drivesDisplay: false };
const execOk = (stdout: string): ExecFileLike => vi.fn(async () => ({ stdout }));

describe('parseNvidiaSmi', () => {
  it('parses one card (MiB to bytes)', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 5090, 24564, 8.9, Enabled\n')).toEqual([
      { name: 'NVIDIA GeForce RTX 5090', bytes: 24564 * 1048576, computeCap: 8.9, drivesDisplay: true },
    ]);
  });
  it('maps [N/A] compute cap to null and Disabled to false', () => {
    expect(parseNvidiaSmi('Tesla K80, 11441, [N/A], Disabled')).toEqual([
      { name: 'Tesla K80', bytes: 11441 * 1048576, computeCap: null, drivesDisplay: false },
    ]);
  });
  it.each(['', 'garbage', 'a, b, c, d', 'x, -5, 8.0, Enabled', 'x, 0, 8.0, Enabled', '[N/A], [N/A], [N/A], [N/A]'])('rejects %j', (s) => {
    expect(parseNvidiaSmi(s)).toBeNull();
  });
});

describe('detectMachine', () => {
  it('detects one card on linux', async () => {
    const exec = execOk('NVIDIA GeForce RTX 5090, 24564, 8.9, Enabled\n');
    const m = await detectMachine({ arch: 'x64', platform: 'linux', totalmem: () => 64 * GIB, exec });
    expect(m).toEqual({
      platform: 'linux', ramBytes: 64 * GIB, gpuKind: 'nvidia', gpuName: 'NVIDIA GeForce RTX 5090',
      gpuBytes: 24564 * 1048576, computeCap: 8.9, drivesDisplay: true,
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('nvidia-smi', NVIDIA_SMI_ARGS, { timeout: 5000, maxBuffer: 65536, windowsHide: true });
  });
  it('uses exactly the documented args', () => {
    expect(NVIDIA_SMI_ARGS).toEqual(['--query-gpu=name,memory.total,compute_cap,display_active', '--format=csv,noheader,nounits']);
  });
  it('picks the largest of several cards', async () => {
    const m = await detectMachine({ arch: 'x64',
      platform: 'win32', totalmem: () => 32 * GIB,
      exec: execOk('NVIDIA GeForce RTX 5060 Ti, 12288, 8.6, Enabled\nNVIDIA GeForce RTX 5090, 24576, 8.6, Disabled\n'),
    });
    expect(m).toMatchObject({ gpuName: 'NVIDIA GeForce RTX 5090', gpuBytes: 24576 * 1048576, drivesDisplay: false, gpuKind: 'nvidia' });
  });
  it('null compute cap', async () => {
    const m = await detectMachine({ arch: 'x64', platform: 'linux', totalmem: () => GIB, exec: execOk('Tesla K80, 11441, [N/A], Disabled') });
    expect(m.computeCap).toBeNull();
    expect(m.gpuKind).toBe('nvidia');
  });
  it.each([
    ['timeout', Object.assign(new Error('timed out'), { killed: true, code: null })],
    ['ENOENT', Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' })],
  ])('%s is not detected', async (_n, err) => {
    const m = await detectMachine({ arch: 'x64', platform: 'linux', totalmem: () => 8 * GIB, exec: async () => { throw err; } });
    expect(m).toEqual({ platform: 'linux', ramBytes: 8 * GIB, ...OTHER });
  });
  it('garbage output is not detected', async () => {
    const m = await detectMachine({ arch: 'x64', platform: 'linux', totalmem: () => 8 * GIB, exec: execOk('NVIDIA-SMI has failed') });
    expect(m).toMatchObject(OTHER);
  });
  it('an Intel Mac has no Apple unified memory: no GPU detected, exec never called', async () => {
    const exec = execOk('x');
    const m = await detectMachine({ arch: 'x64', platform: 'darwin', totalmem: () => 16 * GIB, exec });
    expect(m).toEqual({ platform: 'darwin', ramBytes: 16 * GIB, ...OTHER });
    expect(exec).not.toHaveBeenCalled();
  });
  it('darwin: apple, 75% of RAM floored, exec never called', async () => {
    const exec = execOk('x');
    const m = await detectMachine({ arch: 'arm64', platform: 'darwin', totalmem: () => 16 * GIB + 3, exec });
    expect(m).toEqual({
      platform: 'darwin', ramBytes: 16 * GIB + 3, gpuKind: 'apple', gpuName: null,
      gpuBytes: Math.floor(0.75 * (16 * GIB + 3)), computeCap: null, drivesDisplay: false,
    });
    expect(exec).not.toHaveBeenCalled();
  });
});
