// The only code that writes to a transfer drive. It adds and never takes away: a folder is made one level at a time, a
// file is created exclusively or appended to, and that is all. There is no delete, no rename, no truncate and no
// overwrite in this file (tests/safety pins that), so nothing already on the user's drive can be lost by an export.
// SafeFs is not used here on purpose: it revalidates by device, inode and mtime, which FAT32 and exFAT do not keep
// stable. Every name written is built in format.ts from a hex etag, an index or a SHA-256, never from a repo path.
// A stopped export leaves its parts where they are; the next export of the same file continues the short one.
import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  FORMAT_FILE, FORMAT_TEXT, MANIFESTS_DIR, MAX_MANIFEST_BYTES, OBJECTS_DIR, TRANSFER_DIR, manifestName, partPath,
} from './format';

export type DriveErrorCode =
  /** The volume is missing or not a folder. */
  | 'NO_DRIVE'
  /** Something on the drive is not what this format puts there (a file where a folder belongs, another FORMAT). */
  | 'LAYOUT'
  /** The drive is full. */
  | 'FULL'
  | 'IO';

export class DriveError extends Error {
  constructor(readonly code: DriveErrorCode, readonly path: string, message: string) {
    super(message);
    this.name = 'DriveError';
  }
}

const NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;
const CREATE = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW;
const APPEND = fsConstants.O_WRONLY | fsConstants.O_APPEND | NOFOLLOW;
const FULL = new Set(['ENOSPC', 'EDQUOT']);
const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const missing = (e: unknown): boolean => codeOf(e) === 'ENOENT';

function wrap(e: unknown, path: string): DriveError {
  if (e instanceof DriveError) return e;
  const text = e instanceof Error ? e.message : String(e);
  return FULL.has(codeOf(e) ?? '') ? new DriveError('FULL', path, 'The drive is full.') : new DriveError('IO', path, text);
}

/** An open part: `write` appends every byte, `close` flushes the part to the drive, `abandon` closes it as it is. */
export interface PartWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abandon(): Promise<void>;
}

export class DriveWriter {
  /** <volume>/hf-cache-manager-transfer */
  readonly root: string;

  constructor(private readonly volumeRoot: string) {
    this.root = join(volumeRoot, TRANSFER_DIR);
  }

  private at(rel: string): string {
    return join(this.root, ...rel.split('/'));
  }

  /** `p` is a real directory (made now, one level, when absent); a link or a file there is LAYOUT. */
  private async dir(p: string): Promise<void> {
    try {
      await fsp.mkdir(p);
    } catch (e) {
      if (codeOf(e) !== 'EEXIST') throw wrap(e, p);
    }
    let st;
    try {
      st = await fsp.lstat(p);
    } catch (e) {
      throw wrap(e, p);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new DriveError('LAYOUT', p, `${p} is not a folder`);
  }

  /** Creates `p` with `text`, flushed. The caller has checked that nothing is there (O_EXCL fails otherwise). */
  private async create(p: string, text: string): Promise<void> {
    let fh;
    try {
      fh = await fsp.open(p, CREATE);
    } catch (e) {
      throw wrap(e, p);
    }
    let failure: unknown = null;
    try {
      await fh.writeFile(text, 'utf8');
      await fh.datasync();
    } catch (e) {
      failure = e;
    }
    try {
      await fh.close();
    } catch (e) {
      failure ??= e;
    }
    if (failure !== null) throw wrap(failure, p);
  }

  /**
   * The transfer folder with FORMAT, objects/ and manifests/, each made only when absent. A FORMAT with other text was
   * written by another version of the format and is left alone (LAYOUT).
   */
  async prepare(): Promise<void> {
    try {
      if (!(await fsp.stat(this.volumeRoot)).isDirectory()) throw new DriveError('NO_DRIVE', this.volumeRoot, `${this.volumeRoot} is not a drive`);
    } catch (e) {
      if (e instanceof DriveError) throw e;
      throw new DriveError('NO_DRIVE', this.volumeRoot, `${this.volumeRoot} cannot be opened`);
    }
    await this.dir(this.root);
    const format = join(this.root, FORMAT_FILE);
    let text: string | null = null;
    try {
      const st = await fsp.lstat(format);
      if (!st.isFile() || st.isSymbolicLink()) throw new DriveError('LAYOUT', format, `${format} is not a file`);
      text = await fsp.readFile(format, 'utf8');
    } catch (e) {
      if (!missing(e)) throw wrap(e, format);
    }
    if (text === null) await this.create(format, FORMAT_TEXT);
    else if (text !== FORMAT_TEXT) throw new DriveError('LAYOUT', format, `${this.root} was written by a version of the app this one cannot add to`);
    await this.dir(join(this.root, OBJECTS_DIR));
    await this.dir(join(this.root, MANIFESTS_DIR));
  }

  /**
   * Opens part `index` of the object to add bytes after its first `have`: created exclusively when `have` is 0 and
   * nothing is there, else the regular file of exactly `have` bytes that is there is appended to. Anything else at the
   * path (another size, a link, a folder) is LAYOUT and is left untouched.
   */
  async openPart(etag: string, index: number, have: number): Promise<PartWriter> {
    const p = this.at(partPath(etag, index));
    await this.dir(dirname(p));
    let size: number | null = null;
    try {
      const st = await fsp.lstat(p);
      if (!st.isFile() || st.isSymbolicLink()) throw new DriveError('LAYOUT', p, `${p} is not a file`);
      size = st.size;
    } catch (e) {
      if (!missing(e)) throw wrap(e, p);
    }
    if ((size ?? 0) !== have) throw new DriveError('LAYOUT', p, `${p} changed while it was being written`);
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(p, size === null ? CREATE : APPEND);
      if (size !== null && (await fh.stat()).size !== have) {
        await fh.close();
        throw new DriveError('LAYOUT', p, `${p} changed while it was being written`);
      }
    } catch (e) {
      throw wrap(e, p);
    }
    let open = true;
    const shut = async (flush: boolean): Promise<void> => {
      if (!open) return;
      open = false;
      let failure: unknown = null;
      if (flush) {
        try {
          await fh.datasync();
        } catch (e) {
          failure = e;
        }
      }
      try {
        await fh.close();
      } catch (e) {
        failure ??= e;
      }
      if (failure !== null) throw wrap(failure, p);
    };
    return {
      write: async (chunk) => {
        try {
          let off = 0;
          while (off < chunk.length) {
            const { bytesWritten } = await fh.write(chunk, off, chunk.length - off);
            if (bytesWritten <= 0) throw new DriveError('IO', p, `short write to ${p}`);
            off += bytesWritten;
          }
        } catch (e) {
          throw wrap(e, p);
        }
      },
      close: () => shut(true),
      abandon: () => shut(false).catch(() => undefined),
    };
  }

  /**
   * Adds the manifest under the SHA-256 of its text and returns its name. The same text already there is not written
   * again. A file of that name with other bytes (an earlier write that was cut short) is left as it is, and the manifest
   * goes under `<sha>-1.json`, `-2`, and so on.
   */
  async addManifest(text: string): Promise<string> {
    if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new DriveError('IO', this.root, 'Too many files for one export record.');
    for (let n = 0; n < 10_000; n += 1) {
      const name = manifestName(text, n);
      const p = join(this.root, MANIFESTS_DIR, name);
      let there: string | null = null;
      try {
        const st = await fsp.lstat(p);
        there = st.isFile() && !st.isSymbolicLink() && st.size <= MAX_MANIFEST_BYTES ? await fsp.readFile(p, 'utf8') : '';
      } catch (e) {
        if (!missing(e)) throw wrap(e, p);
      }
      if (there === text) return name;
      if (there !== null) continue;
      await this.create(p, text);
      return name;
    }
    throw new DriveError('LAYOUT', this.root, 'The export record could not be added: too many unreadable records with its name.');
  }
}
