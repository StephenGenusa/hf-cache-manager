// The transfer format: what Export writes below <volume>/hf-cache-manager-transfer/ and Load reads back.
//   FORMAT                              "1\n"
//   objects/<xx>/<etag>.000, .001, ...  a file's bytes in parts (xx = etag[:2]); every part but the last has partSize bytes
//   manifests/<sha256 of its text>.json one export of one repo commit: the files, by repo path, with etag and size
// Every name on the drive is lowercase hex, digits and a fixed word, so the layout is the same on FAT32, exFAT, NTFS and
// ext4; repo ids and repo paths live only inside the manifests. A manifest is named by the SHA-256 of its own text, so a
// truncated or edited one is recognised and ignored. Nothing here touches a disk: this file is pure.
import { createHash } from 'node:crypto';
import { isCommitHash, safeRef } from '../../shared/hub-input';
import { isSafeSiblingPath, repoFolderName, type RawListing } from '../download/remote-repo';
import { compareStrings } from '../paths';
import type { RepoType } from '../types';

export const TRANSFER_DIR = 'hf-cache-manager-transfer';
export const FORMAT_FILE = 'FORMAT';
export const FORMAT_TEXT = '1\n';
export const OBJECTS_DIR = 'objects';
export const MANIFESTS_DIR = 'manifests';
/** 1 GiB: below FAT32's 4 GiB file limit with room to spare, and the unit a stopped export resumes by. */
export const PART_SIZE = 2 ** 30;
/** FAT32 holds files of at most 4 GiB - 1 byte; a manifest naming a larger part size is refused. */
export const MAX_PART_SIZE = 2 ** 32 - 1;
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_FILES = 100_000;
const MAX_PATH = 4096;

const ETAG = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MANIFEST_NAME = /^([0-9a-f]{64})(?:-[1-9]\d{0,3})?\.json$/;
const TYPES: readonly string[] = ['model', 'dataset', 'space'];

/** One file of an exported repo commit. `partSize` is the size its object's parts were written with. */
export interface TransferFile { path: string; size: number; etag: string; lfs: boolean; partSize: number }
/** `ref`: the branch or tag that named the commit when it was exported (null: none did). */
export interface TransferManifest {
  version: 1; repoId: string; type: RepoType; commit: string; ref: string | null; exportedAt: number; files: TransferFile[];
}
/** Every manifest of one repo commit on a drive, merged. */
export interface TransferRepo {
  repoId: string; type: RepoType; commit: string; ref: string | null; exportedAt: number; files: TransferFile[];
}

// ---------------------------------------------------------------------------------------------------------------------
// objects

/** A file is at least one part (an empty file is one empty part), so every exported file has an object on the drive. */
export function partCount(size: number, partSize: number): number {
  return Math.max(1, Math.ceil(size / partSize));
}

/** The byte count of every part, in order. */
export function partSizes(size: number, partSize: number): number[] {
  const n = partCount(size, partSize);
  return Array.from({ length: n }, (_, i) => (i < n - 1 ? partSize : size - partSize * (n - 1)));
}

/** objects/<xx>: POSIX-relative to the transfer folder. Throws on anything but a hex etag (it becomes a file name). */
export function objectDir(etag: string): string {
  if (typeof etag !== 'string' || !ETAG.test(etag)) throw new Error(`not an etag: ${JSON.stringify(etag)}`);
  return `${OBJECTS_DIR}/${etag.slice(0, 2)}`;
}

/** objects/<xx>/<etag>.<index, at least 3 digits>. */
export function partPath(etag: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`not a part index: ${String(index)}`);
  return `${objectDir(etag)}/${etag}.${String(index).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// manifests

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Canonical text: fixed key order, files sorted by path, one trailing newline. The same export always gives the same text. */
export function serializeManifest(m: TransferManifest): string {
  const files = [...m.files].sort((a, b) => compareStrings(a.path, b.path))
    .map((f) => ({ path: f.path, size: f.size, etag: f.etag, lfs: f.lfs, partSize: f.partSize }));
  return JSON.stringify({
    version: 1, repoId: m.repoId, type: m.type, commit: m.commit, ref: m.ref, exportedAt: m.exportedAt, files,
  }) + '\n';
}

/** manifests/<sha256 of text>.json, or with `-<n>` when that name is taken by a file with other bytes (n >= 1). */
export function manifestName(text: string, n = 0): string {
  return `${sha256(text)}${n === 0 ? '' : `-${n}`}.json`;
}

class Bad extends Error {}
const bad = (field: string, why: string): never => { throw new Bad(`${field}: ${why}`); };
type Rec = Record<string, unknown>;

function obj(x: unknown, field: string, allowed: readonly string[]): Rec {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return bad(field, 'must be an object');
  for (const k of Object.keys(x)) if (!allowed.includes(k)) bad(field, `unknown field ${JSON.stringify(k)}`);
  return x as Rec;
}
const nat = (x: unknown, field: string): number =>
  (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : bad(field, 'must be a non-negative integer'));

function parseFile(x: unknown, i: number): TransferFile {
  const f = `files[${i}]`;
  const o = obj(x, f, ['path', 'size', 'etag', 'lfs', 'partSize']);
  const path = typeof o.path === 'string' && o.path.length <= MAX_PATH && isSafeSiblingPath(o.path) ? o.path : bad(`${f}.path`, 'must be a safe relative path');
  const etag = typeof o.etag === 'string' && ETAG.test(o.etag) ? o.etag : bad(`${f}.etag`, 'must be 40 or 64 lowercase hex');
  const lfs = typeof o.lfs === 'boolean' ? o.lfs : bad(`${f}.lfs`, 'must be a boolean');
  if (lfs !== (etag.length === 64)) bad(`${f}.lfs`, 'an LFS file has a 64-hex etag, any other a 40-hex one');
  const partSize = nat(o.partSize, `${f}.partSize`);
  if (partSize < 1 || partSize > MAX_PART_SIZE) bad(`${f}.partSize`, 'must be between 1 byte and 4 GiB - 1');
  return { path, size: nat(o.size, `${f}.size`), etag, lfs, partSize };
}

function parseValue(v: unknown): TransferManifest {
  const o = obj(v, 'manifest', ['version', 'repoId', 'type', 'commit', 'ref', 'exportedAt', 'files']);
  if (o.version !== 1) bad('version', `unsupported manifest version ${JSON.stringify(o.version)}`);
  const type = typeof o.type === 'string' && TYPES.includes(o.type) ? (o.type as RepoType) : bad('type', 'must be model, dataset or space');
  const repoId = typeof o.repoId === 'string' && o.repoId.length <= 200 ? o.repoId : bad('repoId', 'must be a string');
  try {
    repoFolderName(repoId, type);
  } catch {
    bad('repoId', 'is not a repo id the cache can hold');
  }
  const commit = typeof o.commit === 'string' && COMMIT.test(o.commit) ? o.commit : bad('commit', 'must be a 40-hex commit');
  let ref: string | null = null;
  if (o.ref !== null) {
    ref = typeof o.ref === 'string' && o.ref.length <= 256 && safeRef(o.ref) && !isCommitHash(o.ref) ? o.ref : bad('ref', 'must be a ref name or null');
  }
  if (!Array.isArray(o.files)) bad('files', 'must be an array');
  const raw = o.files as unknown[];
  if (raw.length === 0 || raw.length > MAX_MANIFEST_FILES) bad('files', `must list between 1 and ${MAX_MANIFEST_FILES} files`);
  const files = raw.map(parseFile);
  const seen = new Set<string>();
  const sizeOf = new Map<string, number>();
  const partOf = new Map<string, number>();
  files.forEach((f, i) => {
    if (seen.has(f.path)) bad(`files[${i}].path`, `duplicate path ${f.path}`);
    seen.add(f.path);
    // One object per etag: two paths naming it must agree on what it holds.
    if ((sizeOf.get(f.etag) ?? f.size) !== f.size || (partOf.get(f.etag) ?? f.partSize) !== f.partSize) bad(`files[${i}]`, `${f.etag} is listed with two sizes`);
    sizeOf.set(f.etag, f.size);
    partOf.set(f.etag, f.partSize);
  });
  return { version: 1, repoId, type, commit, ref, exportedAt: nat(o.exportedAt, 'exportedAt'), files };
}

/**
 * A manifest read from a drive is untrusted: its name must be the SHA-256 of its text (so a truncated or edited file is
 * refused), and every field that later becomes a path or a hash is checked here.
 */
export function parseManifest(text: string, name: string): { ok: true; manifest: TransferManifest } | { ok: false; error: string } {
  const m = MANIFEST_NAME.exec(name);
  if (m === null) return { ok: false, error: 'not a manifest name' };
  if (sha256(text) !== m[1]) return { ok: false, error: 'the manifest does not match its name (incomplete or changed)' };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the manifest is not valid JSON' };
  }
  try {
    return { ok: true, manifest: parseValue(v) };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.message };
    throw e;
  }
}

/** `<type>:<repoId>@<commit>`: one repo commit on a drive. */
export function repoKey(r: { repoId: string; type: RepoType; commit: string }): string {
  return `${r.type}:${r.repoId}@${r.commit}`;
}

/**
 * Every export of the same repo commit adds a manifest; here they become one repo with the union of their files.
 * Manifests are taken oldest first (then by text order of their files, so the result does not depend on read order). A
 * manifest that disagrees with what is already merged (another etag for a path, another size or part size for an etag)
 * is left out whole and named in `conflicts`. The ref is the newest non-null one.
 */
export function mergeManifests(manifests: readonly TransferManifest[]): { repos: TransferRepo[]; conflicts: string[] } {
  const ordered = [...manifests].sort((a, b) => a.exportedAt - b.exportedAt || compareStrings(serializeManifest(a), serializeManifest(b)));
  const repos = new Map<string, TransferRepo>();
  const conflicts: string[] = [];
  for (const m of ordered) {
    const key = repoKey(m);
    const into = repos.get(key) ?? { repoId: m.repoId, type: m.type, commit: m.commit, ref: null, exportedAt: 0, files: [] };
    const byPath = new Map(into.files.map((f) => [f.path, f]));
    const byEtag = new Map(into.files.map((f) => [f.etag, f]));
    const clash = m.files.some((f) => {
      const p = byPath.get(f.path);
      const e = byEtag.get(f.etag);
      return (p !== undefined && p.etag !== f.etag) || (e !== undefined && (e.size !== f.size || e.partSize !== f.partSize));
    });
    if (clash) {
      conflicts.push(key);
      continue;
    }
    for (const f of m.files) if (!byPath.has(f.path)) into.files.push({ ...f });
    into.files.sort((a, b) => compareStrings(a.path, b.path));
    into.exportedAt = Math.max(into.exportedAt, m.exportedAt);
    if (m.ref !== null) into.ref = m.ref;
    repos.set(key, into);
  }
  return { repos: [...repos.values()].sort((a, b) => compareStrings(repoKey(a), repoKey(b))), conflicts: [...new Set(conflicts)] };
}

/** The repo as a Hub listing, for toRemoteListing's safety gate and everything download mode does with one. */
export function toRawListing(r: TransferRepo): RawListing {
  return { repoId: r.repoId, type: r.type, commit: r.commit, files: r.files.map((f) => ({ path: f.path, size: f.size, etag: f.etag, lfs: f.lfs })) };
}
