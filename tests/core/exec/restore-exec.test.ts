// What the executor and store ops need to run a restore-from-Recently-Deleted plan. The restore plans here are built by hand, in the exact shape and op order that
// planRestore produces, from a real hold of the shared hold scenario.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, readdir, rename, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { executePlan, reCreateKindOf, rollbackError, undoUnlink, type ExecDeps, type RunState } from '../../../src/core/exec/executor';
import { STALE_MESSAGE } from '../../../src/core/exec/errors';
import { factsOf, type FsLike, type ReadFs } from '../../../src/core/fsx';
import { executeHold, MANIFEST_NAME, parseManifest, type HoldManifest } from '../../../src/core/hold/manifest';
import { MANIFEST_NAME as TREE_MANIFEST_NAME, restoreContentDigest, walkTree } from '../../../src/core/hold/tree';
import { fingerprintPlan, hashCanonical } from '../../../src/core/plan/fingerprint';
import { SafeFs, SafeFsError, type AttemptHook } from '../../../src/core/safe-fs';
import { parseRefs } from '../../../src/core/scan/store';
import type { DeletionPlan, Op, OpRole, Selection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { scriptedFs } from '../../helpers/failing-fs';
import { treeDigest } from '../../helpers/tree-digest';
import { buildHoldScenario, HEX, q8Iq2MmprojSelection, type HoldScenario } from '../hold/scenario';

useCanaries();

const ONLY_RMDIR = 'a restore plan unlinks its manifest only after every other change; only rmdir-empty may follow';
const WHOLE: Selection = { repos: [{ repoId: 'org/gguf', whole: true }] };

interface Held { s: HoldScenario; hold: DeletionPlan; dir: string; manifest: HoldManifest; manifestText: string }

/** Builds the scenario and holds `sel` (default: + IQ2 + mmproj of org/gguf) with the real hooks. */
async function held(sel?: (s: HoldScenario) => Promise<Selection>): Promise<Held & { hubBefore: Record<string, string> }> {
  const s = await buildHoldScenario();
  const hubBefore = await treeDigest(s.hub);
  const m = await s.model();
  const hold = await s.holdPlan(sel ? await sel(s) : q8Iq2MmprojSelection(s, m));
  const r = await executeHold(hold, s.execDeps(), { model: m, viewRoots: s.viewRoots });
  expect(r.ok).toBe(true);
  const dir = join(s.roots.holdRoot!, hold.deletionId!);
  const manifestText = await readFile(join(dir, MANIFEST_NAME), 'utf8');
  const parsed = parseManifest(manifestText, { holdRoot: s.roots.holdRoot!, deletionId: hold.deletionId! });
  if (!parsed.ok) throw new Error(parsed.error);
  return { s, hold, dir, manifest: parsed.manifest, manifestText, hubBefore };
}

const byKey = <T>(key: (x: T) => string) => (a: T, b: T): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/**
 * The restore plan planRestore builds when everything is restorable, in restore order: held payloads; repo
 * folders, then repo blobs; store-refs-add per refsPath; snapshot links; then the manifest unlink and every directory
 * of the deletion folder deepest first (the folder itself last). `contentDigest` when it moves a repo folder.
 */
async function restorePlan(h: Held, patch: Partial<DeletionPlan> = {}): Promise<DeletionPlan> {
  const { s, hold, dir, manifest: m } = h;
  const factsAt = async (p: string) => (await factsOf(s.fs, p))!;
  const rr = async (path: string, dest: string, role: OpRole): Promise<Op> =>
    ({ kind: 'restore-rename', path, dest, expect: await factsAt(path), role });
  const ops: Op[] = [];
  for (const it of m.storeItems.filter((x) => x.heldPath !== null).sort(byKey((x) => x.originalPath))) {
    ops.push(await rr(it.heldPath!, it.originalPath, 'store-payload'));
  }
  for (const role of ['repo-folder', 'repo-blob'] as const) {
    for (const it of m.items.filter((x) => x.role === role).sort(byKey((x) => x.originalPath))) ops.push(await rr(it.heldPath, it.originalPath, role));
  }
  for (const it of [...m.storeItems].sort(byKey((x) => x.refsPath))) {
    const cur = existsSync(it.refsPath) ? parseRefs(await readFile(it.refsPath, 'utf8')) : null;
    const addRefs = it.refsRemoved.filter((l) => !(cur ?? []).includes(l));
    if (addRefs.length > 0) ops.push({ kind: 'store-refs-add', refsPath: it.refsPath, addRefs, expectRefsRaw: cur });
  }
  for (const it of m.items.filter((x) => x.role === 'snapshot-link').sort(byKey((x) => x.originalPath))) {
    ops.push(await rr(it.heldPath, it.originalPath, 'snapshot-link'));
  }
  const mp = join(dir, MANIFEST_NAME);
  ops.push({ kind: 'unlink', path: mp, expect: await factsAt(mp), role: 'held-item' });
  const leaves = new Set(m.items.map((x) => x.heldPath));
  const dirs: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const n of (await readdir(d)).sort()) {
      const p = join(d, n);
      if (!leaves.has(p) && (await lstat(p)).isDirectory()) await walk(p);
    }
    dirs.push(d);
  };
  await walk(dir);
  ops.push(...dirs.map((path): Op => ({ kind: 'rmdir-empty', path })));
  const folders = m.items.filter((x) => x.role === 'repo-folder').map((x) => x.heldPath);
  const body: DeletionPlan = {
    id: randomUUID(), fingerprint: '', mode: 'hold', purpose: 'restore', hubRoot: s.roots.hubRoot, holdRoot: s.roots.holdRoot,
    deletionId: hold.deletionId, createdAt: s.now, expiresAt: s.now + 600_000, selection: null, ops,
    freed: { bytes: 0, lines: [] }, apparentBytes: hold.apparentBytes, kept: [], viewImpact: [], warnings: [], confirmPhrase: null,
    ...(folders.length > 0 ? { contentDigest: await restoreContentDigest(s.fs, folders) } : {}),
    ...patch,
  };
  return { ...body, fingerprint: fingerprintPlan(body) };
}

/** A copy of `plan` with `patch` applied and a fingerprint recomputed. */
function forge(plan: DeletionPlan, patch: Partial<DeletionPlan>): DeletionPlan {
  const p = { ...structuredClone(plan), ...patch };
  return { ...p, fingerprint: fingerprintPlan(p) };
}
const run = (s: HoldScenario, plan: DeletionPlan, extra: Partial<ExecDeps> = {}) => executePlan(plan, { ...s.execDeps(), ...extra });
const kindsOf = (plan: DeletionPlan): string[] => plan.ops.map((o) => (o.kind === 'restore-rename' ? `rr:${o.role}` : o.kind));
/** The digest of a tree without its directory entries (a rolled-back restore may leave empty hub dirs:). */
const withoutDirs = (d: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== 'dir'));
const holdStateOf = async (h: Held) => ({ hub: withoutDirs(await treeDigest(h.s.hub)), dir: await treeDigest(h.dir) });

describe('restore round trips', () => {
  test('partial groups: the ordered restore puts every item back byte-identical (renamed, never copied); the deletion folder is gone', async () => {
    const h = await held();
    const inoS1 = (await factsOf(h.s.fs, join(h.manifest.storeItems.find((x) => x.heldPath !== null)!.heldPath!)))!.ino;
    const plan = await restorePlan(h);
    expect(kindsOf(plan)).toEqual([
      'rr:store-payload', 'rr:repo-blob', 'rr:repo-blob', 'rr:repo-blob', 'store-refs-add', 'store-refs-add',
      'rr:snapshot-link', 'rr:snapshot-link', 'rr:snapshot-link', 'unlink', ...Array(plan.ops.length - 10).fill('rmdir-empty'),
    ]);
    expect(plan.contentDigest).toBeUndefined();
    const r = await run(h.s, plan);
    expect(r).toMatchObject({ ok: true, appliedOps: plan.ops.length, heldBytes: 0, freedBytesPlanned: 0 });
    expect(r.error).toBeUndefined();
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
    expect((await lstat(join(h.s.hub, 'blobs', 'aa', HEX.S1))).ino).toBe(inoS1);
    expect(await readdir(h.s.roots.holdRoot!)).toEqual([]);
  });

  test('whole repo: the folder goes back into the hub root (no mkdirp of a root): treeDigest equal, folder inode equal', async () => {
    const h = await held(async () => WHOLE);
    const folder = join(h.s.hub, 'models--org--gguf');
    const item = h.manifest.items.find((x) => x.role === 'repo-folder')!;
    expect(item.originalPath).toBe(folder);
    const ino = (await lstat(item.heldPath)).ino;
    const plan = await restorePlan(h);
    expect(kindsOf(plan).slice(0, 2)).toEqual(['rr:store-payload', 'rr:repo-folder']);
    expect(typeof plan.contentDigest).toBe('string');
    const r = await run(h.s, plan);
    expect(r).toMatchObject({ ok: true, appliedOps: plan.ops.length });
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
    expect((await lstat(folder)).ino).toBe(ino);
    expect(await readdir(h.s.roots.holdRoot!)).toEqual([]);
  });

  test('a hold delete still reports heldBytes; a restore dry run returns exactly plan.ops and reports none', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const hold = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hr = await executeHold(hold, s.execDeps(), { model: m, viewRoots: s.viewRoots });
    expect(hr).toMatchObject({ ok: true, heldBytes: hold.apparentBytes });
    expect(hold.apparentBytes).toBeGreaterThan(0);
    const dir = join(s.roots.holdRoot!, hold.deletionId!);
    const manifestText = await readFile(join(dir, MANIFEST_NAME), 'utf8');
    const parsed = parseManifest(manifestText, { holdRoot: s.roots.holdRoot!, deletionId: hold.deletionId! });
    if (!parsed.ok) throw new Error(parsed.error);
    const plan = await restorePlan({ s, hold, dir, manifest: parsed.manifest, manifestText });
    const before = await treeDigest(s.root);
    const dry = await s.exec(plan, undefined, true);
    expect(dry).toMatchObject({ ok: true, heldBytes: 0 });
    expect(dry.dryRunOps).toEqual(plan.ops);
    expect(await treeDigest(s.root)).toEqual(before);
  });

  test('rollbackError says which operation failed', () => {
    const f = { message: 'm', path: '/p', index: 0, stale: false };
    expect(rollbackError(f, [], 'restore').message).toBe('Restore from Recently Deleted failed: m (/p). Everything already changed was put back.');
    expect(rollbackError(f, [], 'delete').message).toBe('Move to Recently Deleted failed: m (/p). Everything already changed was put back.');
    expect(rollbackError(f, []).message).toBe('Move to Recently Deleted failed: m (/p). Everything already changed was put back.');
    expect(rollbackError(f, ['a'], 'restore')).toMatchObject({ code: 'IO', message: 'Rollback incomplete: m (/p). Not put back: a.' });
  });
});

describe('the rollback\'s own check of which unlinks it may re-create (fix 2)', () => {
  const base = { purpose: 'restore' as const, holdRoot: '/h', deletionId: 'D' };
  const mp = join('/h', 'D', MANIFEST_NAME);
  const unlinkOf = (path: string, role: OpRole = 'held-item'): Extract<Op, { kind: 'unlink' }> =>
    ({ kind: 'unlink', path, role, expect: { dev: 1, ino: 1, size: 1, nlink: 1, mtimeMs: 0, isFile: true, isDirectory: false, isSymlink: false } });

  test('the manifest name is the one manifest.ts uses', () => {
    expect(TREE_MANIFEST_NAME).toBe(MANIFEST_NAME);
  });

  test('reCreateKindOf: a view entry; the restore\'s own <holdRoot>/<deletionId>/manifest.json; null for anything else', () => {
    expect(reCreateKindOf(unlinkOf('/v/x', 'view-link'), base, ['/v'])).toBe('view entry');
    expect(reCreateKindOf(unlinkOf(mp), base, [])).toBe('manifest');
    expect(reCreateKindOf(unlinkOf(join('/h', 'D', 'other')), base, [])).toBeNull();
    expect(reCreateKindOf(unlinkOf(join('/h', 'E', MANIFEST_NAME)), base, [])).toBeNull();
    expect(reCreateKindOf(unlinkOf(mp), { ...base, purpose: 'empty' }, [])).toBeNull();
    expect(reCreateKindOf(unlinkOf(mp), { ...base, purpose: 'delete' }, [])).toBeNull();
    expect(reCreateKindOf(unlinkOf(mp), { ...base, holdRoot: null }, [])).toBeNull();
    expect(reCreateKindOf(unlinkOf(mp), { ...base, deletionId: null }, [])).toBeNull();
    expect(reCreateKindOf({ kind: 'rmdir-empty', path: mp }, base, [])).toBeNull();
  });

  test('undoUnlink: an unlink it may not re-create is a problem naming it, and nothing is attempted', async () => {
    const touched: string[] = [];
    const deps = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return undefined; } }) as ExecDeps;
    expect(await undoUnlink(deps, {} as RunState, unlinkOf('/h/D/x'), null)).toBe('/h/D/x was removed and cannot be put back');
    expect(touched).toEqual([]);
  });
});

describe('the restore precheck row: exactly one manifest unlink, followed only by rmdir-empty', () => {
  test('every other unlink shape → CONTAINMENT, nothing touched', async () => {
    const h = await held();
    const plan = await restorePlan(h);
    const k = plan.ops.findIndex((o) => o.kind === 'unlink');
    const mu = plan.ops[k] as Extract<Op, { kind: 'unlink' }>;
    const rrOp = plan.ops[0]!;
    const otherDir = join(h.s.roots.holdRoot!, '2026-01-01T00-00-00-000Z-0000beef');
    await mkdir(otherDir);
    await writeFile(join(otherDir, MANIFEST_NAME), '{}');
    const otherManifest = join(otherDir, MANIFEST_NAME);
    const heldItem = h.manifest.items[0]!.heldPath;
    const withOps = (ops: Op[], patch: Partial<DeletionPlan> = {}) => forge(plan, { ops, ...patch });
    const head = plan.ops.slice(0, k);
    const tail = plan.ops.slice(k + 1);
    const cases: Array<[DeletionPlan, string]> = [
      [withOps([...head, mu, mu, ...tail]), ONLY_RMDIR],
      [withOps([...head, mu, ...tail, mu]), ONLY_RMDIR],
      [withOps([...head, mu, ...tail, null as unknown as Op]), ONLY_RMDIR],
      [withOps([...head.slice(1), mu, rrOp, ...tail]), ONLY_RMDIR],
      [withOps([...head, mu, tail[0]!, { kind: 'write-file', path: join(h.dir, 'x'), before: null, after: '{}', role: 'hold-manifest' }, ...tail.slice(1)]),
        ONLY_RMDIR],
      [withOps([...head, { ...mu, path: heldItem, expect: (await factsOf(h.s.fs, heldItem))! }, ...tail]), `a restore plan never unlinks ${heldItem}`],
      [withOps([...head, { ...mu, path: otherManifest, expect: (await factsOf(h.s.fs, otherManifest))! }, ...tail]), `a restore plan never unlinks ${otherManifest}`],
      [withOps([...head, { ...mu, role: 'repo-blob' }, ...tail]), `a restore plan never unlinks ${mu.path}`],
      [withOps([...head, { ...mu, role: 'view-link' }, ...tail]), `a restore plan never unlinks ${mu.path}`],
      [withOps([...head, { ...mu, expect: { ...mu.expect, isFile: false, isSymlink: true, linkTarget: 'x' } }, ...tail]),
        `the manifest ${mu.path} is not a regular file`],
      [withOps([...head, { ...mu, expect: { ...mu.expect, isFile: false, isDirectory: true } }, ...tail]), `the manifest ${mu.path} is not a regular file`],
      [withOps([...head, { ...mu, expect: { ...mu.expect, isSymlink: true } }, ...tail]), `the manifest ${mu.path} is not a regular file`],
      [withOps([...head, { ...mu, expect: { ...mu.expect, isDirectory: true } }, ...tail]), `the manifest ${mu.path} is not a regular file`],
      [withOps([...head, { ...mu, expect: { ...mu.expect, size: 'big' as unknown as number } }, ...tail]), 'unlink without valid expected facts'],
      [withOps(plan.ops, { mode: 'permanent' }), 'a restore plan is always hold mode'],
    ];
    const before = await treeDigest(h.s.root);
    for (const [p, why] of cases) {
      const r = await run(h.s, p);
      expect(r, why).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'CONTAINMENT', message: `Refused: ${why}` } });
    }
    expect(await treeDigest(h.s.root)).toEqual(before);
    // the manifest unlink as the very last op (no rmdir-empty after it) is accepted
    const last = withOps([...head, ...tail.filter((o) => o.kind !== 'rmdir-empty'), mu]);
    expect(await run(h.s, last)).toMatchObject({ ok: true, appliedOps: last.ops.length });
    expect(existsSync(mu.path)).toBe(false);
  });
});

describe('a repo-folder restore re-walks the held folder and compares the digest', () => {
  test('restoreContentDigest: order of the folders does not matter; any change deep inside does', async () => {
    const h = await held(async () => WHOLE);
    const folder = h.manifest.items.find((x) => x.role === 'repo-folder')!.heldPath;
    const other = join(h.dir, 'store');
    const d1 = await restoreContentDigest(h.s.fs, [folder, other]);
    expect(await restoreContentDigest(h.s.fs, [other, folder])).toBe(d1);
    expect(await restoreContentDigest(h.s.fs, [folder])).not.toBe(d1);
    expect((await walkTree(h.s.fs, folder)).map((e) => e.rel)).toContain(`snapshots/${HEX.c1}/sub/m-IQ2_XS.gguf`);
    // exactly the documented formula, whatever order readdir returns names in
    expect(await restoreContentDigest(h.s.fs, [folder])).toBe(hashCanonical([{ heldPath: folder, tree: await walkTree(h.s.fs, folder) }]));
    const reversed: ReadFs = { ...h.s.fs, readdir: async (p: string) => (await h.s.fs.readdir(p)).sort().reverse() };
    expect(await restoreContentDigest(reversed, [folder, other])).toBe(d1);
    await writeFile(join(folder, 'snapshots', HEX.c1, 'sub', 'new.txt'), 'x');
    expect(await restoreContentDigest(h.s.fs, [folder, other])).not.toBe(d1);
  });

  test('a file added deep inside the held folder after planning → STALE, nothing touched (the folder\'s own facts are unchanged)', async () => {
    const h = await held(async () => WHOLE);
    const plan = await restorePlan(h);
    const folder = h.manifest.items.find((x) => x.role === 'repo-folder')!.heldPath;
    const deep = join(folder, 'snapshots', HEX.c1, 'sub');
    const folderFacts = await factsOf(h.s.fs, folder);
    await writeFile(join(deep, 'extra.bin'), 'not reviewed');
    expect(await factsOf(h.s.fs, folder)).toEqual(folderFacts);
    const before = await holdStateOf(h);
    const r = await run(h.s, plan);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE', message: STALE_MESSAGE, path: h.dir } });
    expect(await holdStateOf(h)).toEqual(before);
  });

  test('a deep file removed, a deep file\'s size changed, or a deep subfolder swapped for a symlink after planning → STALE, nothing touched', async () => {
    const changes: Array<[string, (folder: string, h: Held) => Promise<void>]> = [
      ['remove a deep file', async (folder) => { await unlink(join(folder, 'snapshots', HEX.c1, 'sub', 'm-IQ2_XS.gguf')); }],
      ['change a deep file\'s size', async (folder) => { await appendFile(join(folder, 'blobs', HEX.A), 'more'); }],
      ['swap a deep subfolder for a symlink', async (folder, h) => {
        const sub = join(folder, 'snapshots', HEX.c1, 'sub');
        const away = join(h.s.root, 'moved-sub');
        await rename(sub, away);
        await symlink(away, sub);
      }],
    ];
    for (const [what, change] of changes) {
      const h = await held(async () => WHOLE);
      const plan = await restorePlan(h);
      const folder = h.manifest.items.find((x) => x.role === 'repo-folder')!.heldPath;
      const folderFacts = await factsOf(h.s.fs, folder);
      await change(folder, h);
      expect(await factsOf(h.s.fs, folder), what).toEqual(folderFacts); // only the digest can see it
      const before = { ...(await holdStateOf(h)), root: await treeDigest(h.s.root) };
      const r = await run(h.s, plan);
      expect(r, what).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE', message: STALE_MESSAGE, path: h.dir } });
      expect({ ...(await holdStateOf(h)), root: await treeDigest(h.s.root) }, what).toEqual(before);
    }
  });

  test('a repo-folder restore without a contentDigest, or with another one → STALE, nothing touched', async () => {
    const h = await held(async () => WHOLE);
    const plan = await restorePlan(h);
    const before = await holdStateOf(h);
    for (const p of [forge(plan, { contentDigest: undefined }), forge(plan, { contentDigest: 'f'.repeat(64) })]) {
      expect(await run(h.s, p)).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE', message: STALE_MESSAGE, path: h.dir } });
    }
    expect(await holdStateOf(h)).toEqual(before);
  });

  test('a partial restore (no repo folder) is not walked: a contentDigest it carries is ignored', async () => {
    const h = await held();
    const plan = await restorePlan(h, { contentDigest: 'f'.repeat(64) });
    expect(await run(h.s, plan)).toMatchObject({ ok: true, appliedOps: plan.ops.length });
  });

  test('the walk failing: an entry that vanished → STALE; an unreadable directory → IO; nothing touched', async () => {
    const h = await held(async () => WHOLE);
    const plan = await restorePlan(h);
    const folder = h.manifest.items.find((x) => x.role === 'repo-folder')!.heldPath;
    const snaps = join(folder, 'snapshots');
    const before = await holdStateOf(h);
    const readdirAt = (fn: (p: string) => Promise<string[]>): ReadFs => ({ ...h.s.fs, readdir: (p: string) => (p === snaps ? fn(p) : h.s.fs.readdir(p)) });
    const ghost = readdirAt(async (p) => [...(await h.s.fs.readdir(p)), 'ghost']);
    expect(await run(h.s, plan, { fs: ghost })).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE', message: STALE_MESSAGE, path: h.dir } });
    const denied = readdirAt(async () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); });
    const r = await run(h.s, plan, { fs: denied });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', path: h.dir } });
    expect(r.error!.message).toBe(`Could not check ${h.dir}: EACCES`);
    expect(await holdStateOf(h)).toEqual(before);
  });
});

describe('a restore refuses while any download in the hub is active', () => {
  test('a fresh .incomplete in any repo → ACTIVE_DOWNLOAD before any change; an old one does not block', async () => {
    const h = await held();
    const plan = await restorePlan(h);
    const inc = join(h.s.hub, 'models--org--other', 'blobs', `${'9'.repeat(64)}.incomplete`);
    await writeFile(inc, 'partial');
    await utimes(inc, new Date(h.s.now), new Date(h.s.now));
    const before = await holdStateOf(h);
    const r = await run(h.s, plan);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'ACTIVE_DOWNLOAD' } });
    expect(r.error!.message).toBe('A download is in progress in this cache; try again when it finishes.');
    expect(await holdStateOf(h)).toEqual(before);
    expect(existsSync(join(h.s.appData, 'journal.jsonl'))).toBe(true); // the hold's journal; the restore wrote no begin record
    expect((await readFile(join(h.s.appData, 'journal.jsonl'), 'utf8'))).not.toContain(plan.id);
    // revalidation runs first: a stale plan is STALE even while a download is active
    const stalePlan = forge(plan, { ops: [{ ...plan.ops[0]!, expect: { ...(plan.ops[0] as Extract<Op, { kind: 'restore-rename' }>).expect, size: 1 } } as Op, ...plan.ops.slice(1)] });
    expect((await run(h.s, stalePlan)).error!.code).toBe('STALE');
    // an .incomplete older than the active window does not block
    await utimes(inc, new Date(0), new Date(0));
    expect(await run(h.s, plan)).toMatchObject({ ok: true, appliedOps: plan.ops.length });
  });
});

/** A SafeFs whose rmdirEmpty of exactly `path` fails with IO before acting. */
function failingRmdir(real: SafeFs, path: string): SafeFs {
  return new Proxy(real, { get: (target, k, recv) => (k !== 'rmdirEmpty' ? Reflect.get(target, k, recv) as unknown
    : async (p: string, hook?: AttemptHook) => {
      if (p === path) throw new SafeFsError('IO', p, 'EIO: injected', 'EIO');
      return target.rmdirEmpty(p, hook);
    }) });
}

describe('a failed restore puts the manifest back', () => {
  test('the last rmdir-empty failing → ROLLED_BACK with the restore wording; manifest byte-identical, every item back at its heldPath', async () => {
    const h = await held();
    const plan = await restorePlan(h);
    expect(plan.ops.at(-1)).toEqual({ kind: 'rmdir-empty', path: h.dir });
    const before = await holdStateOf(h);
    const r = await run(h.s, plan, { safeFs: failingRmdir(h.s.safeFs, h.dir) });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, heldBytes: 0, error: { code: 'ROLLED_BACK', path: h.dir } });
    expect(r.error!.message).toBe(`Restore from Recently Deleted failed: rmdir-empty failed: EIO (${h.dir}). Everything already changed was put back.`);
    expect(await readFile(join(h.dir, MANIFEST_NAME), 'utf8')).toBe(h.manifestText);
    for (const it of [...h.manifest.items, ...h.manifest.storeItems.filter((x) => x.heldPath !== null)]) {
      expect((await lstat(it.heldPath!)).ino, it.heldPath!).toBe(it.facts.ino);
      expect(await factsOf(h.s.fs, it.originalPath), it.originalPath).toBeNull();
    }
    const after = await holdStateOf(h);
    expect(after.hub).toEqual(before.hub);
    // the deletion folder is as it was, except that the manifest is a new file with the same bytes
    const strip = (d: Record<string, string>) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== MANIFEST_NAME));
    expect(strip(after.dir)).toEqual(strip(before.dir));
  });

  test('a manifest unlink that took effect although it reported an error is re-created; one already re-created by someone is not overwritten', async () => {
    const h = await held();
    const plan = await restorePlan(h);
    const mp = join(h.dir, MANIFEST_NAME);
    const before = await holdStateOf(h);
    const r = await run(h.s, plan, { safeFs: await SafeFs.create(h.s.roots, unlinkThenFail(h.s.fs, mp)) });
    expect(r.error).toMatchObject({ code: 'ROLLED_BACK', path: mp });
    expect(await readFile(mp, 'utf8')).toBe(h.manifestText);
    expect((await holdStateOf(h)).hub).toEqual(before.hub);
    // something else at the manifest path when the rollback reaches it: left alone, named
    const h2 = await held();
    const plan2 = await restorePlan(h2);
    const mp2 = join(h2.dir, MANIFEST_NAME);
    const k = plan2.ops.findIndex((o) => o.kind === 'unlink');
    const r2 = await run(h2.s, plan2, { hooks: { afterOp: async (_p, i) => { if (i === k) { await writeFile(mp2, 'someone'); throw new Error('boom'); } } } });
    expect(r2.error!.code).toBe('IO');
    expect(r2.error!.message).toContain(`the manifest ${mp2} was not restored: something else is at ${mp2} now, so it was left as it is`);
    expect(await readFile(mp2, 'utf8')).toBe('someone');
  });
});

const eio = (): Error => Object.assign(new Error('EIO: after'), { code: 'EIO' });
/** `base` whose first unlink of `path` happens and then reports EIO. */
function unlinkThenFail(base: FsLike, path: string): FsLike {
  let n = 0;
  return { ...base, unlink: async (p: string) => { await base.unlink(p); if (p === path && n++ === 0) throw eio(); } };
}
/** `base` whose first rename onto `dest` happens and then reports EIO (later ones, e.g. the rollback's, succeed). */
function renameThenFail(base: FsLike, dest: string): FsLike {
  let n = 0;
  return { ...base, rename: async (a: string, b: string) => { await base.rename(a, b); if (b === dest && n++ === 0) throw eio(); } };
}

describe('a store-refs-add whose write took effect although it reported an error is undone', () => {
  test('.refs created by the failing write (absent before) is removed; the rest is rolled back', async () => {
    const h = await held();
    const plan = await restorePlan(h);
    const add = plan.ops.find((o): o is Extract<Op, { kind: 'store-refs-add' }> => o.kind === 'store-refs-add' && o.expectRefsRaw === null)!;
    expect(existsSync(add.refsPath)).toBe(false);
    const before = await holdStateOf(h);
    const r = await run(h.s, plan, { safeFs: await SafeFs.create(h.s.roots, renameThenFail(h.s.fs, add.refsPath)) });
    expect(r.error).toMatchObject({ code: 'ROLLED_BACK' });
    expect(r.error!.message).toMatch(/^Restore from Recently Deleted failed: store-refs-add failed: EIO/);
    expect(existsSync(add.refsPath)).toBe(false);
    expect(await holdStateOf(h)).toEqual(before);
  });

  test('a write that failed without taking effect is left alone: ROLLED_BACK, .refs untouched', async () => {
    const h = await held();
    const plan = await restorePlan(h);
    const add = plan.ops.find((o): o is Extract<Op, { kind: 'store-refs-add' }> => o.kind === 'store-refs-add' && o.expectRefsRaw !== null)!;
    const before = await holdStateOf(h);
    const sfs = scriptedFs(h.s.fs, [{ method: 'rename', nth: 1, code: 'EIO', pathIncludes: add.refsPath }]);
    const r = await run(h.s, plan, { safeFs: await SafeFs.create(h.s.roots, sfs) });
    expect(r.error).toMatchObject({ code: 'ROLLED_BACK' });
    expect(await holdStateOf(h)).toEqual(before);
  });

  test('.refs rewritten by the failing write gets back its exact earlier bytes', async () => {
    const h = await held();
    const plan = await restorePlan(h);
    const add = plan.ops.find((o): o is Extract<Op, { kind: 'store-refs-add' }> => o.kind === 'store-refs-add' && o.expectRefsRaw !== null)!;
    const text = await readFile(add.refsPath, 'utf8');
    const before = await holdStateOf(h);
    const r = await run(h.s, plan, { safeFs: await SafeFs.create(h.s.roots, renameThenFail(h.s.fs, add.refsPath)) });
    expect(r.error).toMatchObject({ code: 'ROLLED_BACK' });
    expect(await readFile(add.refsPath, 'utf8')).toBe(text);
    expect(await holdStateOf(h)).toEqual(before);
  });
});

describe('a restore plan is always hold mode', () => {
  test('a permanent-mode restore plan → CONTAINMENT before anything is touched, whatever its ops', async () => {
    const h = await held();
    const plan = await restorePlan(h);
    const renamesOnly = plan.ops.filter((o) => o.kind === 'restore-rename' || o.kind === 'store-refs-add');
    const before = await treeDigest(h.s.root);
    for (const ops of [plan.ops, renamesOnly, []]) {
      const r = await run(h.s, forge(plan, { mode: 'permanent', ops }));
      expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'CONTAINMENT', message: 'Refused: a restore plan is always hold mode' } });
    }
    expect(await treeDigest(h.s.root)).toEqual(before);
  });
});

describe('an empty plan is always permanent', () => {
  test('a hold-mode empty plan → CONTAINMENT, nothing touched (it could never be rolled back: an emptied item is gone)', async () => {
    const h = await held();
    const item = h.manifest.items[0]!.heldPath;
    const plan = forge(await restorePlan(h), { purpose: 'empty', ops: [{ kind: 'unlink', path: item, expect: (await factsOf(h.s.fs, item))!, role: 'held-item' }] });
    expect(plan.mode).toBe('hold');
    const before = await treeDigest(h.s.root);
    const r = await run(h.s, plan);
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'CONTAINMENT', message: 'Refused: an empty plan is always permanent' } });
    expect(await treeDigest(h.s.root)).toEqual(before);
    // the same ops in permanent mode pass the pre-check and run
    expect(await run(h.s, forge(plan, { mode: 'permanent' }))).toMatchObject({ ok: true, appliedOps: 1 });
    expect(existsSync(item)).toBe(false);
  });
});

describe('an empty plan never unlinks through a symlinked directory (at apply time)', () => {
  test('a parent swapped for a symlink after revalidation → IO "unlink failed: STALE", the entry behind it is kept', async () => {
    const h = await held();
    const item = h.manifest.items.find((x) => x.role === 'snapshot-link')!.heldPath;
    const parent = join(item, '..');
    const moved = join(h.s.roots.holdRoot!, 'moved-parent');
    const plan = forge(await restorePlan(h), { mode: 'permanent', purpose: 'empty', ops: [{ kind: 'unlink', path: item, expect: (await factsOf(h.s.fs, item))!, role: 'held-item' }] });
    const r = await run(h.s, plan, { hooks: { beforeFirstOp: async () => { await rename(parent, moved); await symlink(moved, parent); } } });
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'IO', path: item } });
    expect(r.error!.message).toContain('unlink failed: STALE');
    expect((await lstat(join(moved, item.slice(parent.length + 1)))).isSymbolicLink()).toBe(true);
  });
});

describe('the restore precheck row for a partial restore (a manifest rewrite, no manifest unlink)', () => {
  /** The ops a partial restore carries: everything up to the manifest unlink, then the rewrite of the manifest. */
  async function partial(h: Held) {
    const plan = await restorePlan(h);
    const k = plan.ops.findIndex((o) => o.kind === 'unlink');
    const mp = join(h.dir, MANIFEST_NAME);
    const write = (path: string, before: string | null = h.manifestText): Op =>
      ({ kind: 'write-file', path, before, after: h.manifestText.replace('"held"', '"partial"'), role: 'hold-manifest' });
    return { plan, head: plan.ops.slice(0, k), mu: plan.ops[k]!, tail: plan.ops.slice(k + 1), mp, write };
  }

  test('a write-file of exactly its own manifest, with no manifest unlink, is accepted and applied', async () => {
    const h = await held();
    const { plan, head, mp, write } = await partial(h);
    const p = forge(plan, { ops: [...head, write(mp)] });
    const r = await run(h.s, p);
    expect(r).toMatchObject({ ok: true, appliedOps: p.ops.length });
    expect(await readFile(mp, 'utf8')).toContain('"partial"');
  });

  test('every other write-file shape in a restore plan → CONTAINMENT, nothing touched', async () => {
    const h = await held();
    const { plan, head, mu, tail, mp, write } = await partial(h);
    const otherDir = join(h.s.roots.holdRoot!, '2026-01-01T00-00-00-000Z-0000beef');
    await mkdir(otherDir);
    await writeFile(join(otherDir, MANIFEST_NAME), '{}');
    await writeFile(join(h.dir, 'x'), '{}');
    const cases: Array<[DeletionPlan, string]> = [
      [forge(plan, { ops: [...head, write(join(h.dir, 'x'), '{}')] }), `a restore plan writes only its own manifest`],
      [forge(plan, { ops: [...head, write(join(otherDir, MANIFEST_NAME), '{}')] }), `hold-manifest ${join(otherDir, MANIFEST_NAME)} is not inside the deletion folder`],
      [forge(plan, { ops: [...head, write(mp), mu, ...tail] }), 'a restore plan that rewrites its manifest never also unlinks it'],
      [forge(plan, { ops: [...head, mu, write(mp), ...tail] }), ONLY_RMDIR],
      // The rewrite is the last op and the only write-file
      [forge(plan, { ops: [...head, write(mp), { kind: 'rmdir-empty', path: join(h.dir, 'store', 'aa') }] }), 'a restore plan rewrites its manifest only as its last op'],
      [forge(plan, { ops: [...head, write(mp), write(mp)] }), 'a restore plan rewrites its manifest only as its last op'],
    ];
    cases.push([forge(h.hold, { ops: [...h.hold.ops, write(mp)] }), 'a delete plan never writes a hold manifest']);
    const before = await treeDigest(h.s.root);
    for (const [p, why] of cases) {
      const r = await run(h.s, p);
      expect(r, why).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'CONTAINMENT', message: `Refused: ${why}` } });
    }
    expect(await treeDigest(h.s.root)).toEqual(before);
  });

  test('a rewritten manifest whose before is not the current text → STALE, nothing touched', async () => {
    const h = await held();
    const { plan, head, mp, write } = await partial(h);
    const before = await holdStateOf(h);
    const r = await run(h.s, forge(plan, { ops: [...head, write(mp, h.manifestText + ' ')] }));
    expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE' } });
    expect(await holdStateOf(h)).toEqual(before);
  });

  test('a rewrite that took effect although it reported an error: the previous manifest text is put back, and every item with it', async () => {
    const h = await held();
    const { plan, head, mp, write } = await partial(h);
    const p = forge(plan, { ops: [...head, write(mp)] });                     // the rewrite is always the last op
    const before = await holdStateOf(h);
    const r = await run(h.s, p, { safeFs: await SafeFs.create(h.s.roots, renameThenFail(h.s.fs, mp)) });
    expect(r).toMatchObject({ ok: false, error: { code: 'ROLLED_BACK' } });
    expect(await readFile(mp, 'utf8')).toBe(h.manifestText);                  // the previous text, byte for byte
    const after = await holdStateOf(h);
    expect(after.hub).toEqual(before.hub);
    const strip = (d: Record<string, string>) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== MANIFEST_NAME));
    expect(strip(after.dir)).toEqual(strip(before.dir));
  });
});
