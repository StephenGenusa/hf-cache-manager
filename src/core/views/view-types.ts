import type { OwnedEntry } from '../compat/state';
import type { ReadFs } from '../fsx';
import type { SafeFs } from '../safe-fs';
import type { FileFacts, ViewName } from '../types';

/** One GGUF file of a model repo as the CLI's views see it. */
export interface GgufEntry {
  key: string;            // `${repoId}:${relpath}`
  repoId: string;
  folderName: string;
  relpath: string;
  basename: string;
  blobPath: string;       // repo blob path (not the store payload)
  sha256: string;         // repo blob name
  size: number;           // payload size
  isMmproj: boolean;
  isShard: boolean;
  isCurrent: boolean;     // snapshot name == refs/main (false for all when refs/main is absent)
}

export type Presence = 'absent' | 'partial' | 'correct' | 'wrong';

export interface LinkSpec { path: string; target: string; primary: boolean }   // path view-relative POSIX; target absolute

export interface Desired {
  key: string;
  repoId: string;
  sha256: string;
  paths: string[];        // pySorted
  links: LinkSpec[];
  ollama?: { entry: GgufEntry; mmproj: GgufEntry | null; tag: string; manifestPath: string; aliasPaths: string[] };
}

export interface ForeignEntry { key: string; path: string; target?: string }

export class SkipEntry extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipEntry';
  }
}

/**
 * A `create` that failed AFTER its first write. `SkipEntry` means "nothing was written"; this means "some paths were":
 * `written` (view-relative, POSIX) lists every path the create touched, so the caller can own them (union with the
 * previous paths) and a later sync repairs or prunes them. `cause` is the original error.
 */
export class CreateIncomplete extends Error {
  constructor(readonly written: string[], readonly cause: unknown) {
    super(`${cause instanceof Error ? cause.message : String(cause)}; ${written.length} path(s) were already written`);
    this.name = 'CreateIncomplete';
  }
}

/** `fs` is read-only: every mutation goes through `safeFs`. `ReadFs` accepts an `FsLike` too. */
export interface ApplyCtx {
  safeFs: SafeFs;
  fs: ReadFs;
  expect: (rel: string) => FileFacts | null | undefined;
  warnings: string[];
}

export interface ViewDriver {
  readonly name: ViewName;
  readonly root: string;   // realpath of the view root
  desired(entries: GgufEntry[], warnings: string[]): Desired[];
  presence(d: Desired): Promise<Presence>;
  isStale(d: Desired, owned: OwnedEntry): Promise<boolean>;
  foreign(ownedPaths: ReadonlySet<string>): Promise<ForeignEntry[]>;
  /** Why a desired entry that reconciles as `foreign` is not ours (shown as the item's reason), if the driver knows. */
  foreignReason(d: Desired): Promise<string | undefined>;
  /**
   * Throws SkipEntry before any view write. `prev` is the key's ownership before an update: the Ollama driver then
   * also overwrites (atomically, under the plan's expect) an alias that `prev` owns and that still names `prev`'s model.
   * Nothing is ever removed before create: a skipped create leaves the view exactly as it was.
   */
  create(d: Desired, ctx: ApplyCtx, prev?: OwnedEntry): Promise<string[]>;
  remove(paths: string[], ctx: ApplyCtx, sha256: string): Promise<string[]>;   // returns paths actually removed
}

