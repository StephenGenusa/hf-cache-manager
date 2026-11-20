// A repo commit on a transfer drive, as the byte source a look-up, its advice and the download engine read from in
// place of the Hub. It holds the drive's path in memory only; nothing built from it is saved.
import type { ReadFs } from '../../core/fsx';
import { openObject, readDrive, readObjectAt, transferRoot, type DriveRepo } from '../../core/transfer/drive-reader';
import type { TransferFile } from '../../core/transfer/format';
import type { ReadAt } from '../../core/views/gguf-header';
import type { HubClient } from '../hub/client';

export const DRIVE_GONE_TEXT = 'The drive was removed or changed since it was read; load from the drive again.';

export interface DriveSource {
  /** The repo as it is on the drive now, or null when the drive, the repo or one of `paths` is no longer there. */
  current(paths: readonly string[]): Promise<DriveRepo | null>;
  open: HubClient['open'];
  readAt(path: string): ReadAt;
}

export function driveSource(volumeRoot: string, repo: DriveRepo, fs?: ReadFs): DriveSource {
  const root = transferRoot(volumeRoot);
  const files = new Map<string, TransferFile>(repo.files.map((f) => [f.path, f]));
  const need = (path: string): TransferFile => {
    const f = files.get(path);
    if (f === undefined) throw new Error(`${path} is not on the drive`);
    return f;
  };
  return {
    current: async (paths) => {
      try {
        const now = (await readDrive(volumeRoot, fs))?.repos.find((r) => r.key === repo.key);
        if (now === undefined) return null;
        const etags = new Map(now.files.map((f) => [f.path, f.etag]));
        return paths.every((p) => etags.get(p) === files.get(p)?.etag) ? now : null;
      } catch {
        return null;
      }
    },
    // async, so a path that is not on the drive rejects like a Hub error does
    open: async (_repoId, _type, _commit, path, fromByte, signal) => {
      const f = need(path);
      return { status: fromByte > 0 ? 206 : 200, body: openObject(root, f, fromByte, signal), size: f.size };
    },
    readAt: (path) => {
      const f = need(path);
      return (offset, length) => readObjectAt(root, f, offset, length);
    },
  };
}
