// ---------- environment ----------
export interface SafeRoots {
  hubRoot: string;            // realpath of the hub
  viewRoots: string[];        // realpaths of configured, existing view roots
  holdRoot: string | null;    // realpath of <parent of hub>/.hf-cache-manager/recently-deleted, if available
}

// ---------- cache model ----------
export type RepoType = 'model' | 'dataset' | 'space';

export interface FileFacts {            // from lstat; mtimeMs rounded down to an integer
  dev: number; ino: number; size: number; mtimeMs: number; nlink: number;
  isSymlink: boolean; isDirectory: boolean; isFile: boolean;
  linkTarget?: string;                  // normalizeLinkText(readlink) when isSymlink
}

export interface RepoBlob {
  path: string;                         // <hub>/<folder>/blobs/<etag> (dir realpath'd, leaf not)
  etag: string;                         // 64-hex name
  facts: FileFacts;                     // lstat of the repo blob itself
  storePath: string | null;             // abspath of store payload if repo blob is a store link (one hop, normalised, not realpath'd)
  size: number;                         // payload size (follows store link); 0 if dangling
  dangling: boolean;                    // store link whose payload is missing
}

export interface SnapshotFile {
  relpath: string;                      // POSIX, within snapshot
  commit: string;                       // snapshot dir name
  linkPath: string;                     // absolute path of the snapshot entry
  facts: FileFacts;
  blobEtag: string | null;              // basename of first hop if symlink to blobs/<64hex>; null for plain files / other
  isCurrent: boolean;                   // true for files of the effective current snapshot: refs/main's snapshot if present and non-empty, else the newest non-empty snapshot (scanner order). currentFiles(repo) returns exactly these.
}

export interface Repo {
  id: string;                           // "org/name"
  type: RepoType;
  folder: string;                       // absolute repo folder
  folderName: string;                   // e.g. "models--org--name"
  mainCommit: string | null;            // refs/main stripped, null if absent
  /** Every ref under refs/ (main included) with the commit it names, stripped, sorted by name; set by the scanner.
   *  null: refs/ could not be read, so every snapshot counts as ref-named (none superseded). Absent: none known. */
  refs?: Array<{ name: string; commit: string }> | null;
  snapshots: string[];                  // commit names; main first, then mtime newest first
  files: SnapshotFile[];                // every entry under every snapshot (dirs excluded)
  blobs: Record<string, RepoBlob>;      // by etag; 64-hex names only
  orphanEtags: string[];                // blobs no snapshot link names
  incomplete: Array<{ path: string; size: number; mtimeMs: number }>;
  snapshotDirs: string[];               // every directory under snapshots/ (for rmdir-empty planning), deepest first
  folderFacts: FileFacts;               // lstat of the repo folder
  otherFiles: Array<{ path: string; facts: FileFacts }>;   // every non-dir entry not in files and not a 64-hex blob (refs/*, 40-hex blobs, .incomplete, .no_exist/**, locks)
  otherDirs: string[];                  // every dir not in snapshotDirs (excl. the folder itself), deepest first
}

export interface StoreFile {
  path: string;                         // <hub>/blobs/<xx>/<hash>
  hash: string;
  facts: FileFacts;
  refsPath: string;                     // path + ".refs"
  refsRaw: string[] | null;             // manifest lines as read; null = missing/unreadable (=> never delete)
  validRefs: string[] | null;           // valid references pointing at THIS path; null => uncertain
  lockPresent: boolean;                 // <hash>.lock or .lock.soft exists
}

export interface CacheModel {
  hubRoot: string;
  repos: Repo[];
  storeMarked: boolean;                 // marker valid "1\n"
  store: Record<string, StoreFile>;     // by absolute path
  scannedAt: number;
}

// ---------- classification ----------
export type RepoKind =
  'gguf' | 'diffusers' | 'transformers' | 'adapter' | 'single-file' | 'diffusion' | 'component' | 'dataset' | 'space' | 'unknown';

export type GroupKind =
  'quant' | 'mmproj' | 'draft' | 'component' | 'weights' | 'tokenizer-config' | 'assets' | 'superseded' | 'root-file' | 'other';

export interface Group {
  key: string;                          // stable: `${kind}:${label}`; unique within a repo
  kind: GroupKind;
  label: string;                        // e.g. "UD-Q4_K_XL", "vae/", "mmproj-F16"
  files: SnapshotFile[];                // current-snapshot files (superseded group: non-current only)
  apparentBytes: number;
  shards?: { present: number; expected: number };
  locked: boolean;                      // true for 'component' groups, and for subfolder groups of a diffusers repo whose model_index.json could not be read
}

export interface RepoView {
  repoId: string;
  type: RepoType;
  kinds: RepoKind[];                    // primary first
  groups: Group[];
  apparentBytes: number;                // sum of unique repo-blob payload sizes + plain files
  partialDownloads: number;             // count of .incomplete
}

// ---------- views ----------
export type ViewName = 'lmstudio' | 'ollama';
export interface EtagUsage { lmstudio: string[]; ollama: string[] }   // view-relative paths / ollama tags using it
export type UsageIndex = Record<string /*etag*/, EtagUsage>;

export interface ViewImpactLine {
  view: ViewName;
  path: string;                         // view-relative POSIX
  action: 'remove' | 'keep-shared' | 'state-update' | 'blocked' | 'foreign';   // foreign = user's own entry, reported, never removed
  key?: string;                         // owned state key
  note?: string;
}

export interface ViewImpactProvider {
  /** Ops + lines that remove view entries resolving to the doomed repo blobs. Must not throw on
   *  disabled/missing views; returns blocked lines instead (e.g. hub-missing guard). */
  impactFor(model: CacheModel, doomedRepoBlobPaths: string[]): Promise<{ ops: Op[]; lines: ViewImpactLine[] }>;
}

// ---------- selection & plans ----------
export type RepoSelection =
  | { repoId: string; whole: true }
  | { repoId: string; whole: false; groupKeys: string[]; unlockComponents: boolean };
export interface Selection { repos: RepoSelection[] }

export type DeleteMode = 'hold' | 'permanent';

export type OpRole =
  'snapshot-link' | 'repo-blob' | 'repo-folder' | 'store-payload' | 'view-link' | 'view-manifest' | 'view-blob' | 'held-item';

export type Op =
  | { kind: 'unlink'; path: string; expect: FileFacts; role: OpRole }
  | { kind: 'rmdir-empty'; path: string }
  | { kind: 'hold-rename'; path: string; dest: string; expect: FileFacts; role: OpRole }
  | { kind: 'restore-rename'; path: string; dest: string; expect: FileFacts; role: OpRole }   // dest must NOT exist
  | { kind: 'store-sweep'; storePath: string; refsPath: string; removeRefs: string[]; expectRefsRaw: string[];
      payload: 'delete' | 'hold' | 'keep'; holdDest?: string; expect: FileFacts }
  | { kind: 'store-refs-add'; refsPath: string; addRefs: string[]; expectRefsRaw: string[] | null }
  | { kind: 'write-file'; path: string; before: string | null; after: string; role: 'view-state' | 'hold-manifest' };

export type FreedReason =
  'only-link' | 'hardlink-others-remain' | 'hardlink-all-planned' | 'store-shared' | 'store-unreferenced' |
  'store-uncertain' | 'link-only' | 'plain-file' | 'special-file';

export interface FreedLine { path: string; bytes: number; reason: FreedReason; sharedWith?: string[] }

export interface DeletionPlan {
  id: string;                           // uuid
  fingerprint: string;                  // sha256 of canonical JSON of everything below except id/fingerprint
  mode: DeleteMode;
  purpose: 'delete' | 'restore' | 'empty';
  hubRoot: string;
  holdRoot: string | null;
  deletionId: string | null;            // hold mode: <ISO-ish timestamp>-<8hex>, the hold subfolder name
  createdAt: number;
  expiresAt: number;                    // createdAt + 10 * 60_000
  selection: Selection | null;
  ops: Op[];                            // execution order
  freed: { bytes: number; lines: FreedLine[] };   // hold: bytes that will be freed when emptied
  apparentBytes: number;
  kept: Array<{ repoId: string; groupKey: string; label: string; bytes: number }>;
  viewImpact: ViewImpactLine[];
  warnings: string[];
  confirmPhrase: string | null;         // permanent only: repo name (single repo) or `delete N repos`
  /** purpose 'delete': hashCanonical of the PERMANENT-mode hub ops, i.e. every doomed
   *  path with its facts, set on both plans of a pair. A whole-repo hold is one folder rename whose op is blind to
   *  entries added or changed deep inside, so the executor re-derives this enumeration from its rescan and compares. */
  contentDigest?: string;
}

export interface PlanPair {
  hold: DeletionPlan | null;
  holdUnavailableReason: string | null;  // e.g. "Recently Deleted is on a different drive"
  permanent: DeletionPlan;
}

// ---------- execution ----------
export type ExecErrorCode =
  'STALE' | 'EXPIRED' | 'USED' | 'UNKNOWN_PLAN' | 'FINGERPRINT' | 'CONFIRM' | 'CONTAINMENT' |
  'LOCKED' | 'ACTIVE_DOWNLOAD' | 'IO' | 'ROLLED_BACK';

export interface ExecResult {
  ok: boolean;
  planId: string;
  appliedOps: number;
  error?: { code: ExecErrorCode; message: string; path?: string };
  freedBytesPlanned: number;
  heldBytes: number;
  diskFreeBefore: number;
  diskFreeAfter: number;
  notes?: string[];                     // e.g. store payload kept, refs rewritten, rmdir-empty skipped
}

export interface ExecHooks {
  beforeFirstOp?(plan: DeletionPlan): Promise<void>;          // a hold writes its manifest here
  afterOp?(plan: DeletionPlan, index: number): Promise<void>;
}
