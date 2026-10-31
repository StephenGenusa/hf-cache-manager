// Reader/serializer for a view's `.hfhub-state.json`, byte-compatible with hfhub/state.py.
// Sync deletes exactly what this file lists, so loading is strict: anything the CLI would reject is rejected here too.
import path from 'node:path';
import { isNotFound, readFs, type ReadFs } from '../fsx';
import { isPyMap, pyDumpsIndent1, pyLoads, pySort, type PyJson } from './pyjson';

export const STATE_FILE = '.hfhub-state.json';
export const MAX_STATE_BYTES = 16 * 1024 * 1024;

export class StateError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = 'StateError';
  }
}

export interface OwnedEntry { paths: string[]; sha256: string }
export interface ViewState { version: 1; owned: Record<string, OwnedEntry>; tombstones: Record<string, string> }
export interface LoadedState { path: string; raw: string | null; state: ViewState }

export const emptyState = (): ViewState => ({ version: 1, owned: {}, tombstones: {} });

const fix = (s: string): string => s.replaceAll('\\', '/');

/**
 * Mirror of `_within_view`: non-empty, not absolute, no drive (any single code point before ':', as PureWindowsPath on
 * Python 3.12+), no `..` component. The view drivers skip a desired entry whose path fails it, so a state file this
 * app writes always loads again.
 */
export function withinView(rel: string): boolean {
  return rel !== '' && !rel.startsWith('/') && !/^[^/]:/u.test(rel) && !rel.split('/').includes('..');
}

export async function loadState(viewRoot: string, fs: ReadFs = readFs): Promise<LoadedState> {
  const p = path.join(viewRoot, STATE_FILE);
  const bad = (why: string): StateError => new StateError(`${p}: ${why}`, p);
  let st;
  try {
    st = await fs.lstat(p);
  } catch (e) {
    if (isNotFound(e)) return { path: p, raw: null, state: emptyState() };
    throw bad(`unreadable state file (${(e as Error).message}); move it aside to continue`);
  }
  if (!st.isFile()) throw bad('state file is not a regular file');
  if (st.size > MAX_STATE_BYTES) throw bad('state file too large');
  let raw: string;
  let data: PyJson;
  try {
    const buf = await fs.readFile(p);
    if (buf.length > MAX_STATE_BYTES) throw new Error('state file too large');
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    data = pyLoads(raw);
  } catch (e) {
    throw bad(`unreadable state file (${(e as Error).message}); move it aside to continue`);
  }
  // Stricter than Python (`true`/`1.0` == 1 there): only the integer 1 is accepted.
  if (!isPyMap(data) || data.get('version') !== 1) throw bad('unsupported state version');

  const rawOwned = data.has('owned') ? data.get('owned') : new Map<string, PyJson>();
  if (!isPyMap(rawOwned)) throw bad('malformed state file (owned must be an object)');
  const owned = new Map<string, OwnedEntry>();
  for (const [k, v] of rawOwned) {
    if (!isPyMap(v)) throw bad(`malformed state file (owned[${JSON.stringify(k)}] must be an object)`);
    const paths = v.get('paths');
    if (!Array.isArray(paths) || !paths.every((x): x is string => typeof x === 'string')) {
      throw bad(`malformed state file (owned[${JSON.stringify(k)}].paths must be a list of strings)`);
    }
    const sha256 = v.get('sha256');
    if (typeof sha256 !== 'string') throw bad(`malformed state file (owned[${JSON.stringify(k)}].sha256 must be a string)`);
    owned.set(fix(k), { paths: paths.map(fix), sha256 }); // later key wins on collision, like a Python dict
  }
  const rawTomb = data.has('tombstones') ? data.get('tombstones') : new Map<string, PyJson>();
  if (!isPyMap(rawTomb)) throw bad('malformed state file (tombstones must be an object of string to string)');
  const tombstones = new Map<string, string>();
  for (const [k, v] of rawTomb) {
    if (typeof v !== 'string') throw bad('malformed state file (tombstones must be an object of string to string)');
    tombstones.set(fix(k), v);
  }
  for (const [k, o] of owned) {
    for (const x of o.paths) {
      if (!withinView(x)) throw bad(`owned[${JSON.stringify(k)}] path ${JSON.stringify(x)} lies outside the view`);
    }
  }
  return {
    path: p,
    raw,
    state: { version: 1, owned: Object.fromEntries(owned), tombstones: Object.fromEntries(tombstones) },
  };
}

/** `json.dumps(indent=1)` of version, owned (sorted), tombstones (sorted); no trailing newline. `paths` are written as given. */
export function serializeState(s: ViewState): string {
  const owned = new Map<string, PyJson>();
  for (const k of pySort(Object.keys(s.owned))) {
    const o = s.owned[k]!;
    owned.set(k, new Map<string, PyJson>([['paths', [...o.paths]], ['sha256', o.sha256]]));
  }
  const tombstones = new Map<string, PyJson>();
  for (const k of pySort(Object.keys(s.tombstones))) tombstones.set(k, s.tombstones[k]!);
  return pyDumpsIndent1(new Map<string, PyJson>([['version', s.version], ['owned', owned], ['tombstones', tombstones]]));
}
