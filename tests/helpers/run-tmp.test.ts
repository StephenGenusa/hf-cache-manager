import { afterEach, beforeEach, expect, test } from 'vitest';
import { realpathSync } from 'node:fs';
import { access, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { endRunTmp, OWNER_FILE, RUN_PREFIX, startRunTmp, sweepStaleRuns } from './run-tmp';
import { makeTempRoot, removeTempRoot, tmpBase } from './tmp';

beforeEach(() => expect.hasAssertions());
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await removeTempRoot(r); });
async function base(): Promise<string> {
  const r = await makeTempRoot('hfcm-t-');
  roots.push(r);
  return r;
}
/** A pid no process can have: above Linux's highest possible pid_max (2^22) and macOS's 99998. */
const deadPid = (): number => 2 ** 22 + 1;
async function fakeRun(b: string, name: string, pid: number | null): Promise<string> {
  const d = join(b, name);
  await mkdir(d);
  await mkdir(join(d, 'hfcm-fx-abc123', 'deep'), { recursive: true });
  await writeFile(join(d, 'hfcm-fx-abc123', 'deep', 'f.bin'), 'x');
  if (pid !== null) await writeFile(join(d, OWNER_FILE), String(pid));
  return d;
}
const exists = (p: string) => access(p).then(() => true, () => false);

test('every test runs with its temp dir inside a per-run hfcm-run- dir owned by a live process', async () => {
  expect(basename(tmpBase())).toMatch(/^hfcm-run-/);
  expect(tmpBase()).toBe(realpathSync(tmpdir()));
  expect(Number(await readFile(join(tmpBase(), OWNER_FILE), 'utf8'))).not.toBe(process.pid); // the main vitest process
});

test('startRunTmp makes an hfcm-run- dir under the base recording this pid; endRunTmp removes it with its contents', async () => {
  const b = await base();
  const run = await startRunTmp(b);
  expect(dirname(run)).toBe(b);
  expect(basename(run).startsWith(RUN_PREFIX)).toBe(true);
  expect(await readFile(join(run, OWNER_FILE), 'utf8')).toBe(String(process.pid));
  await mkdir(join(run, 'hfcm-canary-x', 'a'), { recursive: true });
  await writeFile(join(run, 'hfcm-canary-x', 'a', 'f'), 'x');
  await endRunTmp(b, run);
  expect(await exists(run)).toBe(false);
});

test('endRunTmp never follows a symlink out of the run dir', async () => {
  const b = await base();
  const outside = join(b, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.bin'), 'k');
  const run = await startRunTmp(b);
  await symlink(outside, join(run, 'link'));
  await endRunTmp(b, run);
  expect(await exists(run)).toBe(false);
  expect(await readFile(join(outside, 'keep.bin'), 'utf8')).toBe('k');
});

test('endRunTmp refuses anything that is not an hfcm-run- child of the base', async () => {
  const b = await base();
  await mkdir(join(b, 'hfcm-fx-x'));
  await expect(endRunTmp(b, join(b, 'hfcm-fx-x'))).rejects.toThrow(/refuses/);
  await expect(endRunTmp(b, b)).rejects.toThrow(/refuses/);
  await expect(endRunTmp(b, join(b, 'a', `${RUN_PREFIX}x`))).rejects.toThrow(/refuses/);
  await symlink(join(b, 'hfcm-fx-x'), join(b, `${RUN_PREFIX}link`));
  await expect(endRunTmp(b, join(b, `${RUN_PREFIX}link`))).rejects.toThrow(/not a real directory/);
  expect(await exists(join(b, 'hfcm-fx-x'))).toBe(true);
});

test('endRunTmp of a run dir that is already gone is fine', async () => {
  const b = await base();
  await expect(endRunTmp(b, join(b, `${RUN_PREFIX}gone00`))).resolves.toBeUndefined();
});

test('sweepStaleRuns removes run dirs whose owner has exited and keeps everything else', async () => {
  const b = await base();
  const stale = await fakeRun(b, `${RUN_PREFIX}stale0`, deadPid());
  const live = await fakeRun(b, `${RUN_PREFIX}live00`, process.pid);
  const noOwner = await fakeRun(b, `${RUN_PREFIX}nopid0`, null);
  const badOwner = await fakeRun(b, `${RUN_PREFIX}badpid`, null);
  await writeFile(join(badOwner, OWNER_FILE), 'not-a-pid');
  const other = await fakeRun(b, 'hfcm-fx-other0', deadPid());
  await writeFile(join(b, `${RUN_PREFIX}file00`), String(deadPid()));
  await symlink(stale, join(b, `${RUN_PREFIX}link00`));

  expect(await sweepStaleRuns(b)).toEqual([stale]);
  expect(await exists(stale)).toBe(false);
  for (const d of [live, noOwner, badOwner, other]) expect((await lstat(d)).isDirectory()).toBe(true);
  expect((await lstat(join(b, `${RUN_PREFIX}file00`))).isFile()).toBe(true);
  expect((await lstat(join(b, `${RUN_PREFIX}link00`))).isSymbolicLink()).toBe(true);
});

test('startRunTmp sweeps stale runs first', async () => {
  const b = await base();
  const stale = await fakeRun(b, `${RUN_PREFIX}stale1`, deadPid());
  const run = await startRunTmp(b);
  expect(await exists(stale)).toBe(false);
  await endRunTmp(b, run);
});
