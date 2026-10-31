// Generators for the deletion property tests. Trees are plain TreeSpec data built by buildTree inside the
// fixture's guarded temp root; nothing here touches the disk.
// Coverage outranks fixed lists, so the generator also draws
// 40-hex (git-sha1) blobs, model_index.json files that lock groups, orphan blobs and store locks.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { classifyRepo } from '../../../src/core/classify/classify';
import type { CacheModel, DeleteMode, RepoSelection, Selection } from '../../../src/core/types';
import type { FileKind, FileSpec, RepoSpec, TreeSpec } from '../support/scenarios';

export const RELPATHS = ['a-Q4_K_M.gguf', 'a-Q8_0.gguf', 'sub/b-Q2_K.gguf', 'README.md', 'config.json'] as const;
export const IDS = ['A', 'B', 'C', 'D'] as const;         // few ids, so contents collide on purpose
export const SIZES = [100, 1000, 5000] as const;
/** 'small' is a 40-hex (git-sha1) blob, the non-LFS file kind. */
export const KINDS = ['blob', 'store', 'hardlink', 'plain', 'small'] as const satisfies readonly FileKind[];
/** Age of the optional `.incomplete`: old enough never to count as an active download. */
export const OLD_INCOMPLETE_MS = 3_600_000;
/** A model_index.json naming `sub` as a diffusers component: `sub/` and the index become locked groups. */
export const VALID_INDEX = '{"_class_name":"FluxPipeline","_diffusers_version":"0.30.0","sub":["diffusers","Component"]}';
/** An unparseable model_index.json: classify fails closed and locks every subfolder group and the index. */
export const GARBAGE_INDEX = '{"_class_name": "FluxPipeline", ';

type RawFile = { id: string; size: number; kind: FileKind };
type RawSnapshot = Partial<Record<(typeof RELPATHS)[number], RawFile>>;
type IndexKind = 'none' | 'valid' | 'garbage';
type OrphanKind = 'none' | '64' | '40';
interface RawRepo { snapshots: RawSnapshot[]; incomplete: boolean; index: IndexKind; orphan: OrphanKind }

const weighted = <T>(...xs: Array<[number, T]>): fc.Arbitrary<T> =>
  fc.oneof(...xs.map(([weight, v]) => ({ weight, arbitrary: fc.constant(v) })));

// Kinds weighted toward the sharing shapes (hardlinks across repos, shared store), which need two draws to coincide
const arbKind: fc.Arbitrary<FileKind> = weighted<FileKind>([2, 'blob'], [2, 'store'], [3, 'hardlink'], [1, 'plain'], [2, 'small']);
const arbFile: fc.Arbitrary<RawFile> = fc.record({
  id: fc.constantFrom(...IDS), size: fc.constantFrom(...SIZES), kind: arbKind,
});
// Every relpath optional, and 1 in 6 snapshots empty on purpose (an already-empty snapshot dir is outside every closure)
const arbSnapshot: fc.Arbitrary<RawSnapshot> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<RawSnapshot>({}) },
  { weight: 5, arbitrary: fc.record(
    Object.fromEntries(RELPATHS.map((r) => [r, arbFile])) as Record<(typeof RELPATHS)[number], fc.Arbitrary<RawFile>>,
    { requiredKeys: [] }) },
);
const arbRepo: fc.Arbitrary<RawRepo> = fc.record({
  snapshots: fc.array(arbSnapshot, { minLength: 1, maxLength: 2 }),
  incomplete: fc.boolean(),
  index: weighted<IndexKind>([4, 'none'], [1, 'valid'], [1, 'garbage']),
  orphan: weighted<OrphanKind>([3, 'none'], [1, '64'], [1, '40']),
});

const hex = (algo: 'sha256' | 'sha1', s: string): string => createHash(algo).update(s).digest('hex');

/**
 * Normalizes raw draws into a buildable TreeSpec:
 *  - repos `o/r0`..`o/r2`, snapshots `c0`, `c1`, main = the last one (buildTree's default);
 *  - with `mirror` (a fork or second download of the same files), o/r1's main snapshot also holds o/r0's main files,
 *    so cross-repo hardlinks, shared store payloads and identical blobs are common;
 *  - the first kind drawn for an id wins for every later use of that id, hub-wide. The brief says per repo+id, but
 *    the fixture keys blob content by id+size across repos and refuses one key with two storages, so per-repo
 *    consistency alone could not be built; hub-wide keeps every cross-repo collision (hardlinks, shared store) valid;
 *  - a model_index.json (valid or garbage) is a plain file in the main snapshot, written through `extra`;
 *  - an orphan blob (64- or 40-hex name, linked by nothing) is a regular file in `blobs/`, written through `extra`;
 *  - lmstudio links resolve `pick % candidates` over the non-plain files of each repo's main snapshot (the fixture
 *    links a view entry to a repo blob, which a plain file does not have);
 *  - with `storeLock`, the first store file drawn gets a `.lock` beside its payload.
 */
function normalize(raw: { repos: RawRepo[]; links: number[]; storeMarked: boolean; storeLock: boolean; mirror: boolean }): TreeSpec {
  const kindOf = new Map<string, FileKind>();
  const lastOf = (r: RawRepo): RawSnapshot => r.snapshots[r.snapshots.length - 1]!;
  const raws = raw.repos.map((r, i) => (raw.mirror && i === 1
    ? { ...r, snapshots: [...r.snapshots.slice(0, -1), { ...lastOf(r), ...lastOf(raw.repos[0]!) }] }
    : r));
  const repos: RepoSpec[] = raws.map((r, i) => {
    const id = `o/r${i}`;
    const snapshots: RepoSpec['snapshots'] = {};
    r.snapshots.forEach((s, c) => {
      const files: Record<string, FileSpec> = {};
      for (const rel of RELPATHS) {
        const x = s[rel];
        if (x === undefined) continue;
        if (!kindOf.has(x.id)) kindOf.set(x.id, x.kind);
        files[rel] = { kind: kindOf.get(x.id)!, id: x.id, size: x.size };
      }
      snapshots[`c${c}`] = files;
    });
    const extra: Record<string, string> = {};
    if (r.index !== 'none') extra[`snapshots/c${r.snapshots.length - 1}/model_index.json`] = r.index === 'valid' ? VALID_INDEX : GARBAGE_INDEX;
    if (r.orphan !== 'none') extra[`blobs/${hex(r.orphan === '64' ? 'sha256' : 'sha1', `orphan:${id}`)}`] = `orphan:${id}\n`;
    const etag = hex('sha256', `incomplete:${id}`);
    return {
      id, snapshots,
      ...(r.incomplete ? { incomplete: [{ etag, ageMs: OLD_INCOMPLETE_MS }] } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };
  });
  const candidates = repos.flatMap((r) => {
    const commits = Object.keys(r.snapshots);
    const main = r.snapshots[commits[commits.length - 1]!]!;
    return Object.entries(main).filter(([, x]) => x.kind !== 'plain').map(([file]) => ({ repo: r.id, file }));
  });
  const lmstudio = candidates.length === 0 ? [] : raw.links.map((n, i) => ({ rel: `pub/l${i}.gguf`, ...candidates[n % candidates.length]! }));
  const storeFile = repos.flatMap((r) => Object.values(r.snapshots).flatMap((s) => Object.values(s))).find((x) => x.kind === 'store');
  return {
    repos,
    ...(lmstudio.length > 0 ? { lmstudio } : {}),
    ...(raw.storeMarked ? {} : { storeMarked: false }),
    ...(raw.storeLock && storeFile ? { storeLocks: [{ id: storeFile.id, size: storeFile.size }] } : {}),
  };
}

/**
 * 1–3 repos, 1–2 snapshots each, files drawn from RELPATHS × IDS × SIZES × KINDS (40-hex 'small' included), 0–3 LM
 * Studio links, optional old .incomplete, optional model_index.json (valid or garbage, locking groups), optional orphan
 * blob (64- or 40-hex), (1 in 5) an unmarked shared store, (1 in 4) a locked store payload, (1 in 3) o/r1 mirroring
 * o/r0's main files.
 */
export const arbTreeSpec: fc.Arbitrary<TreeSpec> = fc.record({
  repos: fc.array(arbRepo, { minLength: 1, maxLength: 3, size: 'max' }), // 'max': 2–3 repos as often as 1
  links: fc.array(fc.nat({ max: 99 }), { maxLength: 3 }),
  // now and then an unmarked shared store: every payload is then kept and counted 0 ("on any doubt")
  storeMarked: weighted([4, true], [1, false]),
  storeLock: weighted([3, false], [1, true]),
  mirror: weighted([2, false], [1, true]),
}).map(normalize);

export interface Pick { seed: number; whole: boolean; mode: DeleteMode; tryLocked: boolean }

export const arbPick: fc.Arbitrary<Pick> = fc.record({
  seed: fc.integer({ min: 0, max: 0x7fff_ffff }),
  whole: fc.boolean(),
  mode: fc.constantFrom<DeleteMode>('hold', 'permanent'),
  // 2 in 5: a chosen locked group is requested without unlockComponents, which planning must refuse (LOCKED_GROUP)
  tryLocked: weighted([3, false], [2, true]),
});

/**
 * A selection driven by the bits of `seed`, consumed in order (repos sorted by id, then each selected repo's groups in
 * classifyRepo order). A repo whose bit is set is selected; with none set, repo `seed % n` is. With `whole` every
 * selected repo is selected whole; otherwise each gets the groups whose bit is set (at least group `seed % g`), and
 * `unlockComponents` is true exactly when a chosen group is locked, unless `tryLocked` (then always false). A repo
 * with no groups (every snapshot empty) can only be selected whole.
 */
export function selectionFrom(model: CacheModel, pick: { seed: number; whole: boolean; tryLocked?: boolean }): Selection {
  let k = 0;
  const bit = (): boolean => ((pick.seed >>> (k++ % 31)) & 1) === 1;
  const repos = [...model.repos].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (repos.length === 0) throw new Error('selectionFrom: the model has no repos');
  let chosen = repos.filter(() => bit());
  if (chosen.length === 0) chosen = [repos[pick.seed % repos.length]!];
  return {
    repos: chosen.map((repo): RepoSelection => {
      const groups = classifyRepo(repo).groups;
      if (pick.whole || groups.length === 0) return { repoId: repo.id, whole: true };
      let gs = groups.filter(() => bit());
      if (gs.length === 0) gs = [groups[pick.seed % groups.length]!];
      return {
        repoId: repo.id, whole: false, groupKeys: gs.map((g) => g.key),
        unlockComponents: pick.tryLocked !== true && gs.some((g) => g.locked),
      };
    }),
  };
}

/** True when `selection` asks for a locked group without unlockComponents (planning must refuse with LOCKED_GROUP). */
export function asksLockedWithoutUnlock(model: CacheModel, selection: Selection): boolean {
  return selection.repos.some((s) => {
    if (s.whole || s.unlockComponents) return false;
    const repo = model.repos.find((r) => r.id === s.repoId)!;
    const locked = new Set(classifyRepo(repo).groups.filter((g) => g.locked).map((g) => g.key));
    return s.groupKeys.some((k) => locked.has(k));
  });
}
