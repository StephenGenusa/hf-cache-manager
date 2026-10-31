import { classifyRepo } from '../classify/classify';
import { isHex40Blob, targetOf } from '../classify/target';
import { compareStrings as cmp } from '../paths';
import type { CacheModel, FileFacts, Group, Repo, RepoSelection, Selection, SnapshotFile } from '../types';

export { targetOf, type Target } from '../classify/target';

export type PlanErrorCode = 'UNKNOWN_REPO' | 'UNKNOWN_GROUP' | 'LOCKED_GROUP' | 'INVALID_SELECTION' | 'ACTIVE_DOWNLOAD';

/** Planning refusal: planning stops and returns nothing. */
export class PlanError extends Error {
  constructor(readonly code: PlanErrorCode, message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export interface Closure {
  repo: Repo;
  whole: boolean;
  selectedGroupKeys: string[];
  /** Doomed snapshot entries, sorted by linkPath. */
  links: SnapshotFile[];
  /** Doomed repo blobs (64-hex RepoBlobs and 40-hex otherFiles directly in `<folder>/blobs`), sorted by path. */
  blobs: Array<{ path: string; facts: FileFacts }>;
  /** Whole repo only: every otherFile that is not a 40-hex blob (refs, .incomplete, .no_exist, locks...), sorted. */
  others: Array<{ path: string; facts: FileFacts }>;
  /**
   * Selected links kept because a link outside the selection uses the same blob, sorted by linkPath.
   * sameAs/groupLabel name the first such link (current first, then grouped, then by path) and its group; groupLabel
   * is null when that link is in no group, and `snapshot` then names its snapshot and refs. `alsoIn`: the other places.
   */
  refused: Array<{ file: SnapshotFile; sameAs: string; groupLabel: string | null; snapshot?: string; alsoIn?: string[] }>;
}


const invalid = (msg: string): PlanError => new PlanError('INVALID_SELECTION', msg);

/** Structural checks on untrusted input (the selection crosses IPC); PlanError INVALID_SELECTION on any malformation. */
export function checkShape(selection: Selection): RepoSelection[] {
  const repos = (selection as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos) || repos.length === 0) throw invalid('Selection names no repos');
  const seen = new Set<string>();
  for (const r of repos as unknown[]) {
    const s = r as { repoId?: unknown; whole?: unknown; groupKeys?: unknown } | null;
    if (s === null || typeof s !== 'object' || typeof s.repoId !== 'string') throw invalid('Selection entry has no repo id');
    if (seen.has(s.repoId)) throw invalid(`${s.repoId} is selected twice`);
    seen.add(s.repoId);
    if (s.whole === true) continue;
    if (s.whole !== false) throw invalid(`${s.repoId}: whole must be true or false`);
    const keys = s.groupKeys;
    if (!Array.isArray(keys) || keys.length === 0) throw invalid(`${s.repoId}: no groups selected`);
    if (!keys.every((k) => typeof k === 'string')) throw invalid(`${s.repoId}: group keys must be strings`);
    if (new Set(keys).size !== keys.length) throw invalid(`${s.repoId}: a group is selected twice`);
  }
  return repos as RepoSelection[];
}

interface Resolved { sel: RepoSelection; repo: Repo; groups: Group[]; chosen: Group[] }

function resolve(model: CacheModel, sel: RepoSelection): Resolved {
  const repo = model.repos.find((r) => r.id === sel.repoId);
  if (!repo) throw new PlanError('UNKNOWN_REPO', `${sel.repoId} is not in the cache`);
  const groups = classifyRepo(repo).groups;
  if (sel.whole) return { sel, repo, groups, chosen: groups };
  const chosen = sel.groupKeys.map((key) => {
    const g = groups.find((x) => x.key === key);
    if (!g) throw new PlanError('UNKNOWN_GROUP', `${sel.repoId} has no group ${key}`);
    if (g.locked && sel.unlockComponents !== true) {
      throw new PlanError('LOCKED_GROUP', `${sel.repoId}: ${g.label} is locked; unlock component deletion to select it`);
    }
    return g;
  });
  return { sel, repo, groups, chosen };
}

function closeWhole({ repo, groups }: Resolved): Closure {
  const hex40 = repo.otherFiles.filter((o) => isHex40Blob(repo, o.path));
  return {
    repo, whole: true, selectedGroupKeys: groups.map((g) => g.key),
    links: [...repo.files].sort((a, b) => cmp(a.linkPath, b.linkPath)),
    blobs: [...Object.values(repo.blobs).map((b) => ({ path: b.path, facts: b.facts })), ...hex40.map((o) => ({ path: o.path, facts: o.facts }))]
      .sort((a, b) => cmp(a.path, b.path)),
    others: repo.otherFiles.filter((o) => !isHex40Blob(repo, o.path)).map((o) => ({ path: o.path, facts: o.facts }))
      .sort((a, b) => cmp(a.path, b.path)),
    refused: [],
  };
}

/**
 * The one kind of link outside the selection that may go with its blob: an older-revision
 * link (not current) in no group, in a snapshot no ref names (such a link only shares a current file's blob).
 * With refs/ unreadable (null) every snapshot may be ref-named, so none may.
 */
function cascadable(repo: Repo, grouped: ReadonlySet<string>): (x: SnapshotFile) => boolean {
  if (repo.refs === null) return () => false;
  const named = new Set([...(repo.refs ?? []).map((r) => r.commit), ...(repo.mainCommit === null ? [] : [repo.mainCommit])]);
  return (x) => !x.isCurrent && !grouped.has(x.linkPath) && !named.has(x.commit);
}

/**
 * S = files of the chosen groups. A blob target of S is doomed only when every link to it is in S, or is a
 * cascadable older-revision link; then all those links are doomed too, so no link outlives its blob and no blob is
 * orphaned. Any other link to it (a current file, a file of another group, a link in no group of a ref-named
 * snapshot) keeps the blob, and the selected links to it are refused. Plain and other targets of S are doomed as
 * links alone.
 */
function closePartial({ repo, groups, chosen }: Resolved): Closure {
  const S = new Map<string, SnapshotFile>();
  for (const g of chosen) for (const file of g.files) S.set(file.linkPath, file);
  const groupOf = new Map<string, Group>();
  for (const g of groups) for (const file of g.files) groupOf.set(file.linkPath, g);
  const mayGo = cascadable(repo, new Set(groupOf.keys()));
  const refNames = (commit: string): string[] => (repo.refs ?? []).filter((r) => r.commit === commit).map((r) => r.name);
  const placeOf = (x: SnapshotFile): string => {
    const g = groupOf.get(x.linkPath);
    if (g !== undefined) return `unselected group ${g.label}`;
    const names = refNames(x.commit);
    return names.length === 0 ? `snapshot ${x.commit}` : `snapshot ${x.commit} (${names.join(', ')})`;
  };
  const rank = (x: SnapshotFile): number => (x.isCurrent ? 0 : groupOf.has(x.linkPath) ? 1 : 2);

  const linksTo = new Map<string, { facts: FileFacts; files: SnapshotFile[] }>();
  for (const file of repo.files) {
    const t = targetOf(repo, file);
    if (t.kind !== 'blob') continue;
    const e = linksTo.get(t.path) ?? { facts: t.facts, files: [] };
    e.files.push(file);
    linksTo.set(t.path, e);
  }

  const links = new Map<string, SnapshotFile>();
  const blobs: Closure['blobs'] = [];
  const refused: Closure['refused'] = [];
  const done = new Set<string>();
  for (const file of S.values()) {
    const t = targetOf(repo, file);
    if (t.kind !== 'blob') {
      links.set(file.linkPath, file);
      continue;
    }
    if (done.has(t.path)) continue;
    done.add(t.path);
    const L = linksTo.get(t.path)!.files;
    const blockers = L.filter((x) => !S.has(x.linkPath) && !mayGo(x))
      .sort((a, b) => rank(a) - rank(b) || cmp(a.linkPath, b.linkPath));
    if (blockers.length === 0) {
      blobs.push({ path: t.path, facts: t.facts });
      for (const x of L) links.set(x.linkPath, x);
    } else {
      const b = blockers[0]!;
      const g = groupOf.get(b.linkPath);
      const first = placeOf(b);
      const alsoIn = [...new Set(blockers.map(placeOf))].filter((p) => p !== first);
      const why = {
        sameAs: b.relpath, groupLabel: g === undefined ? null : g.label,
        ...(g === undefined ? { snapshot: first } : {}), ...(alsoIn.length > 0 ? { alsoIn } : {}),
      };
      for (const x of L) if (S.has(x.linkPath)) refused.push({ file: x, ...why });
    }
  }
  return {
    repo, whole: false, selectedGroupKeys: chosen.map((g) => g.key),
    links: [...links.values()].sort((a, b) => cmp(a.linkPath, b.linkPath)),
    blobs: blobs.sort((a, b) => cmp(a.path, b.path)),
    others: [],
    refused: refused.sort((a, b) => cmp(a.file.linkPath, b.file.linkPath)),
  };
}

/**
 * The closure invariant, checked by planCore on every partial closure: no link outside the selection is doomed, except a
 * cascadable older-revision link whose blob is doomed; and no doomed blob keeps a link. Throws (an internal error,
 * never a PlanError) otherwise. A whole-repo closure dooms everything by definition.
 */
export function checkClosure(c: Closure): void {
  if (c.whole) return;
  const repo = c.repo;
  const groups = classifyRepo(repo).groups;
  const selected = new Set(c.selectedGroupKeys);
  const S = new Set(groups.filter((g) => selected.has(g.key)).flatMap((g) => g.files.map((x) => x.linkPath)));
  const mayGo = cascadable(repo, new Set(groups.flatMap((g) => g.files.map((x) => x.linkPath))));
  const blobOf = new Map<string, string>();
  for (const x of repo.files) {
    const t = targetOf(repo, x);
    if (t.kind === 'blob') blobOf.set(x.linkPath, t.path);
  }
  const doomedBlobs = new Set(c.blobs.map((b) => b.path));
  const doomedLinks = new Set(c.links.map((x) => x.linkPath));
  for (const x of c.links) {
    if (S.has(x.linkPath)) continue;
    // a link that is not a blob's has no entry, and an undefined path is never a doomed blob
    if (!mayGo(x) || !doomedBlobs.has(blobOf.get(x.linkPath)!)) throw new Error(`closure: ${x.linkPath} is not selected but would be deleted`);
  }
  for (const [link, blob] of blobOf) {
    if (doomedBlobs.has(blob) && !doomedLinks.has(link)) throw new Error(`closure: blob ${blob} would be deleted while ${link} still links it`);
  }
}

/**
 * Turns a selection into the exact doomed snapshot entries, repo blobs and (whole repo) other files, one Closure per
 * selected repo in selection order. Every repo and group is validated before any closure is built.
 */
export function closeSelection(model: CacheModel, selection: Selection): Closure[] {
  const resolved = checkShape(selection).map((sel) => resolve(model, sel));
  return resolved.map((r) => (r.sel.whole ? closeWhole(r) : closePartial(r)));
}
