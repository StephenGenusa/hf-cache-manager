import { makeTempRoot, removeTempRoot } from '../helpers/tmp';
import { currentCanaries } from '../helpers/canary';

/** A fresh real temp dir under os.tmpdir(), removed when the current test ends (requires useCanaries()). */
export async function tempDir(): Promise<string> {
  const canaries = currentCanaries();
  if (!canaries) throw new Error('tempDir requires useCanaries() in this test file');
  const d = await makeTempRoot('hfcm-t-');
  canaries.onCleanup(() => removeTempRoot(d));
  return d;
}
