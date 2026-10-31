import { lstat, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { removeTree } from './tmp';

// One temp dir per test run (vitest and Playwright global setup): every temp root a test makes lands inside it, and the
// run removes it at the end. Per-test cleanup cannot run when a run is killed (Ctrl-C, a timeout, a Stryker worker),
// so the next run sweeps run dirs whose owner process has exited.

export const RUN_PREFIX = 'hfcm-run-';
export const OWNER_FILE = '.owner-pid';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function ownerPid(dir: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(join(dir, OWNER_FILE), 'utf8');
  } catch {
    return null;
  }
  return /^[1-9][0-9]*$/.test(text) ? Number(text) : null;
}

/**
 * Removes the `hfcm-run-*` dirs directly under `base` whose recorded owner has exited. A dir without a readable owner
 * (one being created right now, or not ours) and anything that is not a real directory are left alone.
 */
export async function sweepStaleRuns(base: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of (await readdir(base)).sort()) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    const dir = join(base, name);
    if (!(await lstat(dir)).isDirectory()) continue;
    const pid = await ownerPid(dir);
    if (pid === null || alive(pid)) continue;
    await removeTree(dir);
    removed.push(dir);
  }
  return removed;
}

/** Sweeps stale runs, then makes this run's dir under `base` (a realpath) and records this process as its owner. */
export async function startRunTmp(base: string): Promise<string> {
  await sweepStaleRuns(base);
  const run = await realpath(await mkdtemp(join(base, RUN_PREFIX)));
  await writeFile(join(run, OWNER_FILE), String(process.pid));
  return run;
}

/** Removes this run's dir and everything in it. Refuses anything that is not an `hfcm-run-*` child of `base`. */
export async function endRunTmp(base: string, run: string): Promise<void> {
  if (dirname(run) !== base || !basename(run).startsWith(RUN_PREFIX)) throw new Error(`endRunTmp refuses ${run}`);
  try {
    await lstat(run);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  await removeTree(run);
}
