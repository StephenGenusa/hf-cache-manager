// The one exception to the mkdir ban. userData is normally created by Electron when it takes the single-instance lock and sets up its
// profile. If it is still missing after `whenReady`, this is the ONE place outside SafeFs where src/main creates a
// folder: a single non-recursive mkdir whose parent must already be a real directory (no symlink), re-checked afterwards.
import { dirname } from 'node:path';
import { factsOf, isNotFound, mkdirOneLevel } from '../core/fsx';
import type { ReadFs } from '../core/fsx';

export type UserDataFs = Pick<ReadFs, 'lstat'> & { mkdir?: (p: string) => Promise<void> };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Makes sure `userDataDir` is a real folder; returns the problem text, or null when it is. */
export async function ensureUserDataDir(userDataDir: string, fs: UserDataFs): Promise<string | null> {
  // factsOf reads a link target only for a symlink, which is refused anyway
  const facts_ = (p: string): ReturnType<typeof factsOf> => factsOf({ lstat: fs.lstat, readlink: () => Promise.resolve('') } as unknown as ReadFs, p);
  const notAFolder = `The app data location is not a folder: ${userDataDir}`;
  try {
    const facts = await facts_(userDataDir);
    if (facts !== null) return facts.isDirectory && !facts.isSymlink ? null : notAFolder;
    const parent = await facts_(dirname(userDataDir));
    if (parent === null || !parent.isDirectory || parent.isSymlink) {
      return `The app data folder cannot be created: its parent is not a real folder (${dirname(userDataDir)})`;
    }
    try {
      await (fs.mkdir ?? mkdirOneLevel)(userDataDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return `The app data folder could not be created (${userDataDir}): ${errText(e)}`;
    }
    const after = await facts_(userDataDir);
    return after !== null && after.isDirectory && !after.isSymlink ? null : notAFolder;
  } catch (e) {
    if (isNotFound(e)) return notAFolder;
    return `The app data folder cannot be used (${userDataDir}): ${errText(e)}`;
  }
}
