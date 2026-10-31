// Compile-time only: enforced by `npm run typecheck` (tests/** is in tsconfig.node.json).
import { readFs, nodeFs, type ReadFs, type FsLike } from '../../src/core/fsx';

export async function readOnlyConsumer(fs: ReadFs = readFs, p = 'x'): Promise<void> {
  await fs.lstat(p);
  await fs.readFile(p, 'utf8');
  // @ts-expect-error ReadFs exposes no mutators
  await fs.unlink(p);
  // @ts-expect-error ReadFs exposes no mutators
  await readFs.rename(p, p);
  // @ts-expect-error ReadFs exposes no mutators
  await readFs.writeFile(p, 'x');
}

// FsLike still satisfies ReadFs, so mutating callers can pass their fs to read-only code.
export const widened: ReadFs = nodeFs;
export const full: FsLike = nodeFs;
