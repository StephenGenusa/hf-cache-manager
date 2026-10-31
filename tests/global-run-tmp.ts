import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { endRunTmp, startRunTmp } from './helpers/run-tmp';

// Global setup for vitest and Playwright: points TMPDIR at a fresh hfcm-run- dir for the whole run (the test processes
// start after this and inherit it) and removes that dir at the end. HFCM_KEEP_TMP=1 keeps it for inspection.
export default async function globalRunTmp(): Promise<() => Promise<void>> {
  const base = realpathSync(tmpdir());
  const run = await startRunTmp(base);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = run;
  return async () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    if (process.env.HFCM_KEEP_TMP === '1') {
      console.log(`HFCM_KEEP_TMP=1: test temp dirs kept in ${run}`);
      return;
    }
    await endRunTmp(base, run);
  };
}
