// planRestore and the byte-identical round trip. Every restore here is planned by planRestore from a real hold of the
// shared hold scenario and executed
// by the real executor; outcomes are asserted on disk (treeDigest, inodes, readdir).
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { appendFile, link, mkdir, readFile, rename, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { executePlan } from '../../../src/core/exec/executor';
import { SafeFsError, type AttemptHook } from '../../../src/core/safe-fs';
import { factsOf } from '../../../src/core/fsx';
import { HeldError, listHeld, planRestore, RESTORE_REASONS, RESTORE_SYNC_HINT, type HeldDeletion } from '../../../src/core/hold/held';
import { createHoldHooks, finalizeHold, executeHold, MANIFEST_NAME, parseManifest, serializeManifest, type HoldManifest } from '../../../src/core/hold/manifest';
import { restoreContentDigest } from '../../../src/core/hold/tree';
import { fingerprintPlan } from '../../../src/core/plan/fingerprint';
import { PlanError } from '../../../src/core/plan/closure';
import type { DeletionPlan, Op, Selection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { failingFs } from '../../helpers/failing-fs';
import { treeDigest } from '../../helpers/tree-digest';
import { diffTrees, snapshotTree } from '../support/observe';
import { assertR1, buildHoldScenario, HEX, q8Iq2MmprojSelection, type HoldScenario } from './scenario';

useCanaries();

// planRestore's active-download guard is wrapped so a test can make it throw something other than the active-download refusal
const guard = vi.hoisted(() => ({ override: null as (() => void) | null }));
vi.mock('../../../src/core/plan/planner', async (orig) => {
  const actual = await orig<typeof import('../../../src/core/plan/planner')>();
  return { ...actual, assertNoActiveDownload: (...a: Parameters<typeof actual.assertNoActiveDownload>) =>
    (guard.override !== null ? guard.override() : actual.assertNoActiveDownload(...a)) };
});

const WHOLE: Selection = { repos: [{ repoId: 'org/gguf', whole: true }] };
type OkDeletion = Extract<HeldDeletion, { ok: true }>;

interface Held { s: HoldScenario; d: OkDeletion; hubBefore: Record<string, string>; deletionId: string }

/** Builds the scenario, records the hub, and holds `sel` (default: + IQ2 + mmproj of org/gguf) with executeHold. */
async function held(sel?: (s: HoldScenario) => Promise<Selection>, prep?: (s: HoldScenario) => Promise<void>): Promise<Held> {
  const s = await buildHoldScenario();
  await prep?.(s);
  const hubBefore = await treeDigest(s.hub);
  const m = await s.model();
  const hold = await s.holdPlan(sel ? await sel(s) : q8Iq2MmprojSelection(s, m));
  const r = await executeHold(hold, s.execDeps(), { model: m, viewRoots: s.viewRoots, fs: s.fs });
  expect(r.ok).toBe(true);
  return { s, d: await only(s), hubBefore, deletionId: hold.deletionId! };
}
/** The one held deletion, freshly listed. */
async function only(s: HoldScenario): Promise<OkDeletion> {
  const d = (await listHeld(s.roots)).at(0)!;
  if (!d.ok) throw new Error(d.error);
  return d;
}
const q4Only = async (s: HoldScenario): Promise<Selection> => ({ repos: [{ repoId: 'org/gguf', whole: false,
  unlockComponents: false, groupKeys: [s.keyFor(await s.model(), 'org/gguf', 'quant', 'Q4_K_M')] }] });

const kindsOf = (plan: DeletionPlan): string[] => plan.ops.map((o) => (o.kind === 'restore-rename' ? `rr:${o.role}` : o.kind));
const renames = (plan: DeletionPlan) => plan.ops.filter((o): o is Extract<Op, { kind: 'restore-rename' }> => o.kind === 'restore-rename');
const refsAdds = (plan: DeletionPlan) => plan.ops.filter((o): o is Extract<Op, { kind: 'store-refs-add' }> => o.kind === 'store-refs-add');
const plan = (h: Held, now = h.s.now): Promise<DeletionPlan> => h.s.model().then((m) => planRestore(h.d, m, h.s.roots, now));

const gguf = (s: HoldScenario, ...p: string[]): string => join(s.hub, 'models--org--gguf', ...p);
const snap = (s: HoldScenario, name: string): string => gguf(s, 'snapshots', HEX.c1, ...name.split('/'));
const held1 = (h: Held, originalPath: string): string => h.d.manifest.items.find((i) => i.originalPath === originalPath)!.heldPath;
const s1 = (s: HoldScenario): string => join(s.hub, 'blobs', 'aa', HEX.S1);
const s2 = (s: HoldScenario): string => join(s.hub, 'blobs', 'bb', HEX.S2);

describe('treeDigest (the existing helper, imported)', () => {
  test('treeDigest sees inode changes and ignores .refs line order', async () => {
    const s = await buildHoldScenario();
    const a = join(s.root, 'digest');
    await mkdir(a);
    await writeFile(join(a, 'f'), 'bytes');
    await writeFile(join(a, 'x.refs'), 'one\ntwo\n');
    const before = await treeDigest(a);
    await writeFile(join(a, 'x.refs'), 'two\none\n');
    expect(await treeDigest(a)).toEqual(before);                       // reordered refs: same digest
    await rename(join(a, 'f'), join(a, 'g'));
    await rename(join(a, 'g'), join(a, 'f'));
    expect(await treeDigest(a)).toEqual(before);                       // renamed away and back: same inode
    await writeFile(join(a, 'copy'), await readFile(join(a, 'f')));   // a new inode while the old one is still live
    await rename(join(a, 'copy'), join(a, 'f'));
    expect(await treeDigest(a)).not.toEqual(before);                   // a copy has another inode
  });
});

describe('planRestore: the byte-identical round trip', () => {
  test('hold then restore yields a byte-identical hub (partial groups)', async () => {
    const s = await buildHoldScenario();
    const before = await treeDigest(s.hub);
    const inoS1 = lstatSync(s1(s)).ino;
    const m = await s.model();
    const hold = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hooks = createHoldHooks({ safeFs: s.safeFs, fs: s.fs, model: m, viewRoots: s.viewRoots, now: () => 1_000 });
    const hr = await s.exec(hold, hooks);
    await finalizeHold(hold, hr, s);
    expect(hr.ok).toBe(true);
    expect(existsSync(s1(s))).toBe(false);                             // payload left the hub
    const d = (await listHeld(s.roots)).at(0)!;
    const p = await planRestore(d, await s.model(), s.roots, s.now);   // the executor's clock (2_000 would be expired)
    expect(p).toMatchObject({ mode: 'hold', purpose: 'restore', deletionId: hold.deletionId, selection: null,
      hubRoot: s.roots.hubRoot, holdRoot: s.roots.holdRoot, kept: [], viewImpact: [],
      freed: { bytes: 0, lines: [] }, confirmPhrase: null, createdAt: s.now, expiresAt: s.now + 600_000 });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.warnings).toEqual([RESTORE_SYNC_HINT]);
    expect(p.contentDigest).toBeUndefined();                           // No repo-folder op
    expect(p.apparentBytes).toBe(2000 + 500);                          // the restored regular files: payload S1 and blob C
    // Held payloads; repo blobs; refs; snapshot links; manifest; folders
    expect(kindsOf(p)).toEqual([
      'rr:store-payload', 'rr:repo-blob', 'rr:repo-blob', 'rr:repo-blob',
      'store-refs-add', 'store-refs-add',
      'rr:snapshot-link', 'rr:snapshot-link', 'rr:snapshot-link',
      'unlink', ...Array(p.ops.length - 10).fill('rmdir-empty'),
    ]);
    expect(renames(p).map((o) => o.dest)).toEqual([
      s1(s), gguf(s, 'blobs', HEX.B), gguf(s, 'blobs', HEX.C), gguf(s, 'blobs', HEX.D),
      snap(s, 'm-Q8_0.gguf'), snap(s, 'mmproj-F16.gguf'), snap(s, 'sub/m-IQ2_XS.gguf'),
    ]);
    for (const o of renames(p)) expect(o.expect).toEqual(await factsOf(s.fs, o.path));
    expect(refsAdds(p)).toEqual([
      { kind: 'store-refs-add', refsPath: s1(s) + '.refs', addRefs: [`models--org--gguf/blobs/${HEX.B}`], expectRefsRaw: null },
      { kind: 'store-refs-add', refsPath: s2(s) + '.refs', addRefs: [`models--org--gguf/blobs/${HEX.D}`],
        expectRefsRaw: [`models--org--other/blobs/${HEX.D}`] },
    ]);
    const dir = join(s.roots.holdRoot!, hold.deletionId!);
    expect(p.ops[9]).toEqual({ kind: 'unlink', path: join(dir, MANIFEST_NAME), expect: await factsOf(s.fs, join(dir, MANIFEST_NAME)), role: 'held-item' });
    const rmdirs = p.ops.slice(10).map((o) => (o as Extract<Op, { kind: 'rmdir-empty' }>).path);
    const depth = (x: string): number => x.split('/').length;
    expect(rmdirs.map(depth)).toEqual([...rmdirs.map(depth)].sort((a, b) => b - a));   // deepest first
    expect(rmdirs).toContain(join(dir, 'store', 'aa'));
    expect(rmdirs).toContain(join(dir, 'models--org--gguf', 'snapshots', HEX.c1, 'sub'));
    expect(p.ops.at(-1)).toEqual({ kind: 'rmdir-empty', path: dir });
    expect(p.fingerprint).toBe(fingerprintPlan(p));
    assertR1(p);

    const rr = await s.exec(p);
    expect(rr.error).toBeUndefined();
    expect(rr.ok).toBe(true);
    expect(await treeDigest(s.hub)).toEqual(before);
    expect(lstatSync(s1(s)).ino).toBe(inoS1);                          // renamed, never copied
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
  });

  test('hold then restore yields a byte-identical hub (whole repo folder)', async () => {
    const h = await held(async () => WHOLE);
    const folder = gguf(h.s);
    const item = h.d.manifest.items.find((x) => x.role === 'repo-folder')!;
    const ino = lstatSync(item.heldPath).ino;
    const p = await plan(h);
    expect(kindsOf(p)).toEqual(['rr:store-payload', 'rr:repo-folder', 'store-refs-add', 'store-refs-add', 'unlink',
      ...Array(p.ops.length - 5).fill('rmdir-empty')]);
    expect(renames(p)[1]).toMatchObject({ role: 'repo-folder', path: item.heldPath, dest: folder });
    expect(p.contentDigest).toBe(await restoreContentDigest(h.s.fs, [item.heldPath]));
    expect(p.warnings).toEqual([RESTORE_SYNC_HINT]);
    // every regular file in the folder once (blob C, A, E, refs/main) plus the held payload S1
    expect(p.apparentBytes).toBe(500 + 1000 + 50 + 40 + 2000);
    expect(p.ops.at(-1)).toEqual({ kind: 'rmdir-empty', path: h.d.dir });
    assertR1(p);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
    expect(lstatSync(folder).ino).toBe(ino);
    expect(readdirSync(h.s.roots.holdRoot!)).toEqual([]);
  });

  test('restore dry run returns exactly plan.ops and changes nothing', async () => {
    const h = await held();
    const p = await plan(h);
    const hub = await treeDigest(h.s.hub);
    const hold = await treeDigest(h.s.roots.holdRoot!);
    const r = await h.s.exec(p, undefined, true);
    expect(r.dryRunOps).toEqual(p.ops);
    expect(await treeDigest(h.s.hub)).toEqual(hub);
    expect(await treeDigest(h.s.roots.holdRoot!)).toEqual(hold);
  });

  test('no Sync hint when the deletion removed no view entries; a plan with no store op', async () => {
    const h = await held(q4Only);
    expect(RESTORE_SYNC_HINT).toBe('Run Sync afterwards to recreate the LM Studio and Ollama links this deletion removed.');
    expect(h.d.manifest.viewEntriesRemoved).toEqual([]);
    const p = await plan(h);
    expect(p.warnings).toEqual([]);
    expect(kindsOf(p).slice(0, 3)).toEqual(['rr:repo-blob', 'rr:snapshot-link', 'unlink']);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
  });

  test('a rolled-back restore leaves every item held; the hub differs at most by empty directories', async () => {
    const h = await held();
    const p = await plan(h);
    const hubBefore = await snapshotTree(h.s.hub);
    const refsBefore = await readFile(s2(h.s) + '.refs', 'utf8');
    const holdBefore = await treeDigest(h.d.dir);
    const safeFs = new Proxy(h.s.safeFs, { get: (target, k, recv) => (k !== 'rmdirEmpty' ? Reflect.get(target, k, recv) as unknown
      : async (q: string, hook?: AttemptHook) => {
        if (q === h.d.dir) throw new SafeFsError('IO', q, 'EIO: injected', 'EIO');
        return target.rmdirEmpty(q, hook);
      }) });
    const r = await executePlan(p, { ...h.s.execDeps(), safeFs });
    expect(r.error?.code).toBe('ROLLED_BACK');
    const diff = diffTrees(hubBefore, await snapshotTree(h.s.hub), { ignoreIno: 'dirs+links' });
    expect(diff.removed).toEqual([]);
    // a .refs the restore rewrote and the rollback put back is a new inode with the same bytes
    expect(diff.changed).toEqual([s2(h.s) + '.refs']);
    expect(await readFile(s2(h.s) + '.refs', 'utf8')).toBe(refsBefore);
    for (const a of diff.added) expect(lstatSync(a).isDirectory() && readdirSync(a).length === 0, a).toBe(true);
    const strip = (x: Record<string, string>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== MANIFEST_NAME));
    expect(strip(await treeDigest(h.d.dir))).toEqual(strip(holdBefore));
    expect(await readFile(join(h.d.dir, MANIFEST_NAME), 'utf8')).toBe(h.d.manifestText);
  });
});

describe('planRestore: plan-level refusals', () => {
  test.each([
    ['no hold root', 'NO_HOLD_ROOT'], ['corrupt deletion', 'CORRUPT'], ['bad deletion id', 'CORRUPT'],
    ['model of another hub', 'HUB_MISMATCH'], ['manifest of another hub', 'HUB_MISMATCH'],
    ['deletion dir gone', 'NOT_FOUND'], ['deletion dir is a symlink', 'NOT_FOUND'], ['manifest text changed', 'STALE_MANIFEST'],
  ])('planRestore throws HeldError %s', async (name, code) => {
    const h = await held();
    const m = await h.s.model();
    let d: HeldDeletion = h.d;
    let roots = h.s.roots;
    let model = m;
    if (name === 'no hold root') roots = { ...roots, holdRoot: null };
    if (name === 'corrupt deletion') d = { ok: false, deletionId: h.d.deletionId, dir: h.d.dir, error: 'x' };
    if (name === 'bad deletion id') d = { ...h.d, deletionId: '../' + h.d.deletionId };
    if (name === 'model of another hub') model = { ...m, hubRoot: join(h.s.root, 'elsewhere') };
    if (name === 'manifest of another hub') {
      roots = { ...roots, hubRoot: join(h.s.root, 'elsewhere') };
      model = { ...m, hubRoot: roots.hubRoot };
    }
    if (name === 'deletion dir gone') await rename(h.d.dir, h.d.dir + '-moved');
    if (name === 'deletion dir is a symlink') {
      await rename(h.d.dir, h.d.dir + '-moved');
      await symlink(h.d.dir + '-moved', h.d.dir);
    }
    if (name === 'manifest text changed') d = { ...h.d, manifestText: h.d.manifestText + ' ' };
    const err = await planRestore(d, model, roots, h.s.now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeldError);
    expect(err).toMatchObject({ code });
  });

  test('the caller-supplied manifest object is never used to build ops; only deletionId and manifestText count', async () => {
    const h = await held();
    const forged: HoldManifest = structuredClone(h.d.manifest);
    forged.items = forged.items.map((i) => ({ ...i, originalPath: '/etc/passwd' }));
    forged.storeItems = [];
    forged.viewEntriesRemoved = [];
    const a = await plan(h);
    const b = await planRestore({ ...h.d, manifest: forged, dir: '/tmp' }, await h.s.model(), h.s.roots, h.s.now);
    expect(b.ops).toEqual(a.ops);
    expect(b.warnings).toEqual(a.warnings);
  });
});

describe('planRestore: per-item decisions come from the disk', () => {
  test('a moving manifest with stale done flags, one item never moved: no op and no warning for it; the rest restores', async () => {
    const h = await held();
    const mp = join(h.d.dir, MANIFEST_NAME);
    const stale: HoldManifest = { ...h.d.manifest, status: 'moving',
      items: h.d.manifest.items.map((i) => ({ ...i, done: false })),
      storeItems: h.d.manifest.storeItems.map((i) => ({ ...i, done: false })) };
    await writeFile(mp, serializeManifest(stale));
    const q8 = snap(h.s, 'm-Q8_0.gguf');
    await rename(held1(h, q8), q8);                                    // as if the hold never moved it
    h.d = await only(h.s);
    expect(h.d.interrupted).toBe(true);
    const p = await plan(h);
    expect(renames(p).some((o) => o.dest === q8)).toBe(false);
    expect(renames(p)).toHaveLength(6);
    expect(p.warnings).toEqual([RESTORE_SYNC_HINT]);
    expect(p.ops.at(-1)).toEqual({ kind: 'rmdir-empty', path: h.d.dir });
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
    expect(readdirSync(h.s.roots.holdRoot!)).toEqual([]);
  });

  test('exists: the original path is occupied by another inode; the item is not restored', async () => {
    const h = await held();
    const q8 = snap(h.s, 'm-Q8_0.gguf');
    await symlink(`../../blobs/${HEX.B}`, q8);                         // re-downloaded
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_REASONS.exists(q8), RESTORE_SYNC_HINT]);
    expect(renames(p).some((o) => o.dest === q8)).toBe(false);
    expect(renames(p).some((o) => o.dest === gguf(h.s, 'blobs', HEX.B))).toBe(true);
    // the deletion folder and its manifest stay (the manifest is rewritten, never unlinked)
    expect(p.ops.some((o) => o.kind === 'unlink' || (o.kind === 'rmdir-empty' && o.path === h.d.dir))).toBe(false);
    expect(p.ops.at(-1)).toMatchObject({ kind: 'write-file', role: 'hold-manifest', path: join(h.d.dir, MANIFEST_NAME) });
  });

  test('missingHeld: an item no longer in the deletion folder; its snapshot link then has no target (targetMissing)', async () => {
    const h = await held();
    const blobC = gguf(h.s, 'blobs', HEX.C);
    const iq2 = snap(h.s, 'sub/m-IQ2_XS.gguf');
    await unlink(held1(h, blobC));
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_REASONS.missingHeld(blobC), RESTORE_REASONS.targetMissing(iq2), RESTORE_SYNC_HINT]);
    expect(renames(p).map((o) => o.dest)).not.toContain(blobC);
    expect(renames(p).map((o) => o.dest)).not.toContain(iq2);
  });

  test('changed: a held item replaced by something else is not restored; its target blob still is', async () => {
    const h = await held();
    const iq2 = snap(h.s, 'sub/m-IQ2_XS.gguf');
    await unlink(held1(h, iq2));
    await symlink(`../../../blobs/${HEX.A}`, held1(h, iq2));
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_REASONS.changed(iq2), RESTORE_SYNC_HINT]);
    expect(renames(p).map((o) => o.dest)).not.toContain(iq2);
    expect(renames(p).map((o) => o.dest)).toContain(gguf(h.s, 'blobs', HEX.C));
  });

  test('changed: a regular held file whose size changed', async () => {
    const h = await held();
    const blobC = gguf(h.s, 'blobs', HEX.C);
    await appendFile(held1(h, blobC), 'x');
    const p = await plan(h);
    expect(p.warnings[0]).toBe(RESTORE_REASONS.changed(blobC));
    expect(renames(p).map((o) => o.dest)).not.toContain(blobC);
  });

  test('a held item reached through a symlinked directory inside the deletion folder is changed', async () => {
    const h = await held();
    const folder = join(h.d.dir, 'models--org--gguf');
    await rename(folder, join(h.d.dir, 'elsewhere'));
    await symlink('elsewhere', folder);
    const p = await plan(h);
    for (const it of h.d.manifest.items) expect(p.warnings).toContain(RESTORE_REASONS.changed(it.originalPath));
    expect(p.warnings).toContain(RESTORE_REASONS.storeUnused(s1(h.s)));
    expect(p.ops).toEqual([]);
  });

  test('storeGone: a kept payload that is gone refuses its repo blob, and the link to that blob (targetMissing)', async () => {
    const h = await held();
    const model = await h.s.model();                                   // before other/blobs/D dangles
    await unlink(s2(h.s));
    await unlink(s2(h.s) + '.refs');
    const blobD = gguf(h.s, 'blobs', HEX.D);
    const linkD = snap(h.s, 'mmproj-F16.gguf');
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings).toEqual([RESTORE_REASONS.storeGone(blobD), RESTORE_REASONS.targetMissing(linkD), RESTORE_SYNC_HINT]);
    expect(refsAdds(p).some((o) => o.refsPath.includes(HEX.S2))).toBe(false);
    expect(renames(p).map((o) => o.dest)).toEqual([s1(h.s), gguf(h.s, 'blobs', HEX.B), gguf(h.s, 'blobs', HEX.C),
      snap(h.s, 'm-Q8_0.gguf'), snap(h.s, 'sub/m-IQ2_XS.gguf')]);
    assertR1(p);
  });

  test('a held payload whose .refs exists again with a valid reference of its own stays held (storeRefsPresent); its blob and link are refused', async () => {
    const h = await held();
    const model = await h.s.model();                                   // scanned before the dangling link exists
    // another repo now links to the payload path and is listed (a .refs of only removed or invalid lines is stale)
    await symlink(`../../blobs/aa/${HEX.S1}`, join(h.s.hub, 'models--org--other', 'blobs', HEX.B));
    await writeFile(s1(h.s) + '.refs', `models--org--gguf/blobs/${HEX.B}\nmodels--org--other/blobs/${HEX.B}\n`);
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings).toEqual([
      RESTORE_REASONS.storeGone(gguf(h.s, 'blobs', HEX.B)), RESTORE_REASONS.targetMissing(snap(h.s, 'm-Q8_0.gguf')),
      RESTORE_REASONS.storeRefsPresent(s1(h.s)), RESTORE_SYNC_HINT]);
    expect(renames(p).some((o) => o.role === 'store-payload')).toBe(false);
    expect(refsAdds(p).map((o) => o.refsPath)).toEqual([s2(h.s) + '.refs']);
    assertR1(p);
  });

  test.each([
    ['a regular file', (p: string) => writeFile(p, 'not a link')],
    ['a symlink to another blob', (p: string) => symlink(HEX.A, p)],
  ])('R16: a held payload nothing restored would reference stays held (storeUnused) — %s at the blob path is no reference', async (_n, occupy) => {
    const h = await held();
    const blobB = gguf(h.s, 'blobs', HEX.B);
    await occupy(blobB);
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_REASONS.exists(blobB), RESTORE_REASONS.storeUnused(s1(h.s)), RESTORE_SYNC_HINT]);
    expect(renames(p).some((o) => o.role === 'store-payload')).toBe(false);
    expect(refsAdds(p).some((o) => o.refsPath === s1(h.s) + '.refs')).toBe(false);
  });

  test.each([
    ['missingHeld', (p: string) => unlink(p)],
    ['changed', (p: string) => appendFile(p, 'x')],
  ])('a held payload that is %s stays where it is; its blob and link are refused', async (reason, mutate) => {
    const h = await held();
    await mutate(h.d.manifest.storeItems.find((x) => x.heldPath !== null)!.heldPath!);
    const p = await plan(h);
    expect(p.warnings).toEqual([
      RESTORE_REASONS.storeGone(gguf(h.s, 'blobs', HEX.B)), RESTORE_REASONS.targetMissing(snap(h.s, 'm-Q8_0.gguf')),
      RESTORE_REASONS[reason as 'missingHeld' | 'changed'](s1(h.s)), RESTORE_SYNC_HINT]);
    expect(renames(p).some((o) => o.role === 'store-payload')).toBe(false);
    expect(refsAdds(p).map((o) => o.refsPath)).toEqual([s2(h.s) + '.refs']);
  });

  test('a regular file in a snapshot (no link target to check) goes back byte-identical', async () => {
    const h = await held(q4Only, async (s) => {
      const f = snap(s, 'm-Q4_K_M.gguf');
      await unlink(f);
      await writeFile(f, 'plain weights');
    });
    const item = h.d.manifest.items.find((i) => i.originalPath === snap(h.s, 'm-Q4_K_M.gguf'))!;
    expect(item.facts.isFile).toBe(true);
    const p = await plan(h);
    expect(p.warnings).toEqual([]);
    expect(p.apparentBytes).toBe('plain weights'.length);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
  });

  test('a payload already back in the store stays held (storePresent); its blob is restored; no .refs is invented for it', async () => {
    const h = await held();
    await writeFile(s1(h.s), 'downloaded again');
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_REASONS.storePresent(s1(h.s)), RESTORE_SYNC_HINT]);
    expect(renames(p).some((o) => o.role === 'store-payload')).toBe(false);
    expect(renames(p).map((o) => o.dest)).toContain(gguf(h.s, 'blobs', HEX.B));
    expect(refsAdds(p).map((o) => o.refsPath)).toEqual([s2(h.s) + '.refs']);
  });

  test('a store .refs that is not a regular file: the kept payload is treated as gone for its blobs', async () => {
    const h = await held();
    await unlink(s2(h.s) + '.refs');
    await mkdir(s2(h.s) + '.refs');
    const p = await plan(h);
    expect(p.warnings[0]).toBe(RESTORE_REASONS.storeGone(gguf(h.s, 'blobs', HEX.D)));
    expect(refsAdds(p).some((o) => o.refsPath.includes(HEX.S2))).toBe(false);
  });

  test('re-adds only refs lines that are missing (a line already back is not written again)', async () => {
    const h = await held();
    await appendFile(s2(h.s) + '.refs', `models--org--gguf/blobs/${HEX.D}\n`);
    const p = await plan(h);
    expect(refsAdds(p).map((o) => o.refsPath)).toEqual([s1(h.s) + '.refs']);
  });
});

describe('planRestore: whole repo folders', () => {
  test.each([
    ['a file added deep inside', async (f: string) => { await writeFile(join(f, 'snapshots', HEX.c1, 'new.txt'), 'x'); }],
    ['a file removed deep inside', async (f: string) => { await unlink(join(f, 'snapshots', HEX.c1, 'README.md')); }],
    ['a file changed deep inside', async (f: string) => { await appendFile(join(f, 'blobs', HEX.E), 'x'); }],
    ['a deep mtime changed', async (f: string) => { await utimes(join(f, 'blobs', HEX.A), new Date(0), new Date(0)); }],
    ['a second link to a deep file', async (f: string) => { await link(join(f, 'blobs', HEX.A), join(f, 'extra')); }],
  ])('%s: the folder is changed, not restored, and its payload stays held', async (_n, mutate) => {
    const h = await held(async () => WHOLE);
    const item = h.d.manifest.items.find((x) => x.role === 'repo-folder')!;
    await mutate(item.heldPath);
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_REASONS.changed(item.originalPath), RESTORE_REASONS.storeUnused(s1(h.s)), RESTORE_SYNC_HINT]);
    expect(p.ops).toEqual([]);
    expect(p.contentDigest).toBeUndefined();
  });

  test('a restored folder whose shared-store file is gone: restored anyway, folderStoreGone, its refs dropped', async () => {
    const h = await held(async () => WHOLE);
    const model = await h.s.model();
    await unlink(s2(h.s));
    await unlink(s2(h.s) + '.refs');
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings).toEqual([RESTORE_REASONS.folderStoreGone('org/gguf', 1), RESTORE_SYNC_HINT]);
    expect(kindsOf(p).slice(0, 3)).toEqual(['rr:store-payload', 'rr:repo-folder', 'store-refs-add']);
    expect(refsAdds(p).map((o) => o.refsPath)).toEqual([s1(h.s) + '.refs']);
  });

  test('a repo folder that exists again is refused whole', async () => {
    const h = await held(async () => WHOLE);
    await mkdir(gguf(h.s));
    const p = await plan(h);
    expect(p.warnings.at(0)).toBe(RESTORE_REASONS.exists(gguf(h.s)));
    expect(renames(p)).toEqual([]);
  });
});

describe('planRestore: active downloads', () => {
  const fresh = async (p: string): Promise<void> => { await writeFile(p, 'partial'); };
  test('an .incomplete in a destination repo refuses with ACTIVE_DOWNLOAD', async () => {
    const h = await held(q4Only);
    await fresh(gguf(h.s, 'blobs', 'f'.repeat(64) + '.incomplete'));
    const err = await plan(h, Date.now()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeldError);
    expect(err).toMatchObject({ code: 'ACTIVE_DOWNLOAD' });
  });

  test('an .incomplete elsewhere in the hub refuses a plan with store ops, not one without', async () => {
    const a = await held(q4Only);
    await fresh(join(a.s.hub, 'models--org--other', 'blobs', 'f'.repeat(64) + '.incomplete'));
    expect((await plan(a, Date.now())).ops.length).toBeGreaterThan(0);
    const b = await held();
    await fresh(join(b.s.hub, 'models--org--other', 'blobs', 'f'.repeat(64) + '.incomplete'));
    await expect(plan(b, Date.now())).rejects.toMatchObject({ code: 'ACTIVE_DOWNLOAD' });
  });

  test('an old .incomplete does not block', async () => {
    const h = await held();
    const inc = gguf(h.s, 'blobs', 'f'.repeat(64) + '.incomplete');
    await fresh(inc);
    await utimes(inc, new Date(0), new Date(0));
    expect((await plan(h, Date.now())).ops.length).toBeGreaterThan(0);
  });
});

/** Rewrites the deletion's manifest with `edit` and re-lists it (a hand-edited manifest the parser still accepts). */
async function editManifest(h: Held, edit: (m: HoldManifest) => void): Promise<void> {
  const m = structuredClone(h.d.manifest);
  edit(m);
  await writeFile(join(h.d.dir, MANIFEST_NAME), serializeManifest(m));
  h.d = await only(h.s);
}

describe('planRestore: which refs lines come back (mutation-driven)', () => {
  test('a repo blob that never left the hub still counts as a reference: the payload goes back and its line is re-added', async () => {
    const h = await held();
    const blobB = gguf(h.s, 'blobs', HEX.B);
    const model = await h.s.model();                                   // before B dangles in the hub
    await rename(held1(h, blobB), blobB);
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings).toEqual([RESTORE_SYNC_HINT]);
    expect(renames(p).map((o) => o.dest)).not.toContain(blobB);
    expect(refsAdds(p)).toContainEqual({ kind: 'store-refs-add', refsPath: s1(h.s) + '.refs', addRefs: [`models--org--gguf/blobs/${HEX.B}`], expectRefsRaw: null });
    assertR1(p);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
  });

  test('a held payload already back in the hub without .refs is ours: no move, no warning, its line re-added', async () => {
    const h = await held();
    const it = h.d.manifest.storeItems.find((x) => x.heldPath !== null)!;
    await rename(it.heldPath!, it.originalPath);
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_SYNC_HINT]);
    expect(renames(p).some((o) => o.role === 'store-payload')).toBe(false);
    expect(refsAdds(p).map((o) => [o.refsPath, o.expectRefsRaw])).toEqual([[s1(h.s) + '.refs', null], [s2(h.s) + '.refs', [`models--org--other/blobs/${HEX.D}`]]]);
    expect(renames(p).map((o) => o.dest)).toContain(gguf(h.s, 'blobs', HEX.B));
  });

  test('a recorded line whose restored blob links to another payload is not re-added', async () => {
    const h = await held();
    await editManifest(h, (m) => {
      const kept = m.storeItems.find((x) => x.heldPath === null)!;
      kept.refsRemoved = [...kept.refsRemoved, `models--org--gguf/blobs/${HEX.B}`];
    });
    const p = await plan(h);
    expect(refsAdds(p).find((o) => o.refsPath === s2(h.s) + '.refs')!.addRefs).toEqual([`models--org--gguf/blobs/${HEX.D}`]);
  });

  test('whole folder: a recorded line for a blob the folder does not hold, or one linking elsewhere, is not re-added', async () => {
    const h = await held(async () => WHOLE);
    await editManifest(h, (m) => {
      const kept = m.storeItems.find((x) => x.heldPath === null)!;
      kept.refsRemoved = [...kept.refsRemoved, `models--org--gguf/blobs/${HEX.B}`, `models--org--gguf/blobs/${'9'.repeat(64)}`];
    });
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_SYNC_HINT]);
    expect(refsAdds(p).find((o) => o.refsPath === s2(h.s) + '.refs')!.addRefs).toEqual([`models--org--gguf/blobs/${HEX.D}`]);
  });

  test('a repo blob linking to a payload the manifest does not record is refused (storeGone)', async () => {
    const h = await held();
    await editManifest(h, (m) => { m.storeItems = m.storeItems.filter((x) => x.heldPath !== null); });
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_REASONS.storeGone(gguf(h.s, 'blobs', HEX.D)),
      RESTORE_REASONS.targetMissing(snap(h.s, 'mmproj-F16.gguf')), RESTORE_SYNC_HINT]);
  });

  test('an unrestored held entry that is an empty directory keeps the deletion folder (no cleanup)', async () => {
    const h = await held(q4Only);
    const q4 = snap(h.s, 'm-Q4_K_M.gguf');
    await unlink(held1(h, q4));
    await mkdir(held1(h, q4));
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_REASONS.changed(q4)]);
    expect(kindsOf(p)).toEqual(['rr:repo-blob', 'rmdir-empty', 'write-file']);   // the emptied blobs/ folder, then the rewrite
  });
});

describe('planRestore: active downloads, more (mutation-driven)', () => {
  test('a refs-only plan (payload already back) is refused while another repo downloads', async () => {
    const h = await held();
    await writeFile(s1(h.s), 'downloaded again');
    await writeFile(join(h.s.hub, 'models--org--other', 'blobs', 'f'.repeat(64) + '.incomplete'), 'partial');
    await expect(plan(h, Date.now())).rejects.toMatchObject({ code: 'ACTIVE_DOWNLOAD' });
  });

  test('only the repos receiving items are checked: another repo downloading does not block a plan without store ops', async () => {
    const h = await held(async (s) => ({ repos: [{ repoId: 'org/other', whole: false, unlockComponents: false,
      groupKeys: [s.keyFor(await s.model(), 'org/other', 'quant', 'IQ2_XS')] }] }));
    await writeFile(gguf(h.s, 'blobs', 'f'.repeat(64) + '.incomplete'), 'partial');
    const p = await plan(h, Date.now());
    expect(refsAdds(p)).toEqual([]);
    expect(renames(p).length).toBeGreaterThan(0);
  });
});

type WriteOp = Extract<Op, { kind: 'write-file' }>;
const writeOf = (p: DeletionPlan): WriteOp => {
  const w = p.ops.at(-1)!;
  if (w.kind !== 'write-file') throw new Error(`last op is ${w.kind}`);
  return w;
};
const afterOf = (p: DeletionPlan): HoldManifest => JSON.parse(writeOf(p).after) as HoldManifest;
const rmdirs = (p: DeletionPlan): string[] => p.ops.flatMap((o) => (o.kind === 'rmdir-empty' ? [o.path] : []));

describe('refusals and the partial restore (the manifest is rewritten, never unlinked)', () => {
  test('an item whose original path exists is refused; the rest restores and the manifest keeps only that item', async () => {
    const h = await held();
    const link = snap(h.s, 'm-Q8_0.gguf');
    await symlink(`../../blobs/${HEX.B}`, link);                        // re-downloaded
    const p = await plan(h);
    expect(p.warnings).toContain(RESTORE_REASONS.exists(link));
    expect(renames(p).some((o) => o.dest === link)).toBe(false);
    const w = writeOf(p);
    expect(w).toMatchObject({ kind: 'write-file', role: 'hold-manifest', path: join(h.d.dir, MANIFEST_NAME), before: h.d.manifestText });
    const after = afterOf(p);
    expect(after.status).toBe('partial');
    expect(after.items.map((i) => i.originalPath)).toEqual([link]);
    expect(after.storeItems).toEqual([]);                               // S1 is back and S2's line is re-added
    expect(after.repos).toEqual(h.d.manifest.repos);
    expect(after.viewEntriesRemoved).toEqual(h.d.manifest.viewEntriesRemoved);
    expect(w.after).toBe(serializeManifest(after));
    expect(p.ops.some((o) => o.kind === 'unlink')).toBe(false);
    expect(parseManifest(w.after, { holdRoot: h.s.roots.holdRoot!, deletionId: h.deletionId })).toMatchObject({ ok: true });
    expect(p.fingerprint).toBe(fingerprintPlan(p));
    assertR1(p);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(await listHeld(h.s.roots)).toMatchObject([{ ok: true, heldCount: 1, otherEntries: 0, interrupted: false }]);
    expect(await readFile(join(h.d.dir, MANIFEST_NAME), 'utf8')).toBe(w.after);
    expect(lstatSync(s1(h.s)).isFile()).toBe(true);
  });

  test('a partial restore can be planned again: the second restore of the same deletion restores the rest once it is free', async () => {
    const h = await held();
    const link = snap(h.s, 'm-Q8_0.gguf');
    await symlink(`../../blobs/${HEX.B}`, link);
    expect((await h.s.exec(await plan(h))).ok).toBe(true);
    await unlink(link);                                                 // the re-download is removed again
    h.d = await only(h.s);
    const p2 = await plan(h);
    expect(kindsOf(p2).slice(0, 1)).toEqual(['rr:snapshot-link']);
    expect(p2.ops.some((o) => o.kind === 'unlink')).toBe(true);         // now complete
    expect(p2.ops.some((o) => o.kind === 'write-file')).toBe(false);
    expect((await h.s.exec(p2)).ok).toBe(true);
    expect(readdirSync(h.s.roots.holdRoot!)).toEqual([]);
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
  });

  test('the whole repo folder is refused when the repo was downloaded again; nothing is planned', async () => {
    const h = await held(async () => WHOLE);
    await mkdir(gguf(h.s));
    const p = await plan(h);
    expect(p.warnings[0]).toBe(RESTORE_REASONS.exists(gguf(h.s)));
    expect(p.ops.some((o) => o.kind === 'restore-rename')).toBe(false);
    expect(p.ops).toEqual([]);                                          // nothing changed, so the manifest is not rewritten
  });

  test('an item that changed while held is refused; its manifest entry stays and the target blob still goes back', async () => {
    const h = await held();
    const iq2 = snap(h.s, 'sub/m-IQ2_XS.gguf');
    await unlink(held1(h, iq2));
    await symlink(`../../../blobs/${HEX.A}`, held1(h, iq2));
    const p = await plan(h);
    expect(p.warnings).toContain(RESTORE_REASONS.changed(iq2));
    expect(renames(p).map((o) => o.dest)).toContain(gguf(h.s, 'blobs', HEX.C));   // the orphan blob is safe
    expect(afterOf(p).items.map((i) => i.originalPath)).toEqual([iq2]);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(lstatSync(held1(h, iq2)).isSymbolicLink()).toBe(true);     // the swapped entry was left alone
  });

  test('a kept payload that is gone: its blob and link stay held; the manifest keeps them and the store line', async () => {
    const h = await held();
    const model = await h.s.model();
    await unlink(s2(h.s));
    await unlink(s2(h.s) + '.refs');
    const blobD = gguf(h.s, 'blobs', HEX.D);
    const linkD = snap(h.s, 'mmproj-F16.gguf');
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings).toEqual(expect.arrayContaining([RESTORE_REASONS.storeGone(blobD), RESTORE_REASONS.targetMissing(linkD)]));
    expect(p.ops.some((o) => o.kind === 'store-refs-add' && o.refsPath.includes(HEX.S2))).toBe(false);
    const after = afterOf(p);
    expect(after.items.map((i) => i.originalPath).sort()).toEqual([blobD, linkD].sort());
    expect(after.storeItems.map((x) => [x.originalPath, x.refsRemoved])).toEqual([[s2(h.s), [`models--org--gguf/blobs/${HEX.D}`]]]);
  });

  test('a moving manifest: items that never moved are dropped, items missing from the deletion folder are dropped, the rest stays', async () => {
    const h = await held();
    const stale: HoldManifest = { ...h.d.manifest, status: 'moving',
      items: h.d.manifest.items.map((i) => ({ ...i, done: false })), storeItems: h.d.manifest.storeItems.map((i) => ({ ...i, done: false })) };
    await writeFile(join(h.d.dir, MANIFEST_NAME), serializeManifest(stale));
    const q8 = snap(h.s, 'm-Q8_0.gguf');
    const blobC = gguf(h.s, 'blobs', HEX.C);
    const iq2 = snap(h.s, 'sub/m-IQ2_XS.gguf');
    await rename(held1(h, q8), q8);                                     // never moved
    await unlink(held1(h, blobC));                                      // not at its held path
    h.d = await only(h.s);
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_REASONS.missingHeld(blobC), RESTORE_REASONS.targetMissing(iq2), RESTORE_SYNC_HINT]);
    const after = afterOf(p);
    expect(after.status).toBe('partial');
    expect(after.items.map((i) => i.originalPath)).toEqual([iq2]);      // only what is still held and was refused
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(await listHeld(h.s.roots)).toMatchObject([{ ok: true, heldCount: 1, interrupted: false }]);
  });

  test('a payload already back in the store: kept held with its manifest entry; its .refs lines are still re-added when the store has a .refs', async () => {
    const h = await held();
    await writeFile(s1(h.s), 'downloaded again');
    await writeFile(s1(h.s) + '.refs', `models--org--other/blobs/${HEX.E}\n`);
    const p = await plan(h);
    expect(p.warnings).toContain(RESTORE_REASONS.storePresent(s1(h.s)));
    expect(refsAdds(p).find((o) => o.refsPath === s1(h.s) + '.refs')).toMatchObject({
      addRefs: [`models--org--gguf/blobs/${HEX.B}`], expectRefsRaw: [`models--org--other/blobs/${HEX.E}`] });
    const after = afterOf(p);
    expect(after.items).toEqual([]);
    expect(after.storeItems.map((x) => x.originalPath)).toEqual([s1(h.s)]);
    expect(after.storeItems[0]!.refsRemoved).toEqual([]);                // the line is back, the payload is still held
    expect(after.bytesHeld).toBe(2000);
    expect(after.bytesFreedWhenEmptied).toBe(Math.min(h.d.manifest.bytesFreedWhenEmptied, 2000));
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(await listHeld(h.s.roots)).toMatchObject([{ ok: true, heldCount: 1 }]);
  });

  test('a payload back in the store without a .refs: no .refs is created and the line stays in the manifest', async () => {
    const h = await held();
    await writeFile(s1(h.s), 'downloaded again');
    const p = await plan(h);
    expect(refsAdds(p).some((o) => o.refsPath === s1(h.s) + '.refs')).toBe(false);
    const after = afterOf(p);
    expect(after.storeItems.map((x) => [x.originalPath, x.refsRemoved])).toEqual([[s1(h.s), [`models--org--gguf/blobs/${HEX.B}`]]]);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(existsSync(s1(h.s) + '.refs')).toBe(false);
  });

  test('bytesHeld counts the remaining regular files and held payloads once; bytesFreedWhenEmptied never grows', async () => {
    const h = await held();
    const blobC = gguf(h.s, 'blobs', HEX.C);
    await writeFile(blobC, 'x');                                        // C is "downloaded again" as a regular file
    const p = await plan(h);
    const after = afterOf(p);
    expect(after.items.map((i) => i.originalPath)).toEqual([blobC]);
    expect(after.bytesHeld).toBe(500);
    expect(after.bytesFreedWhenEmptied).toBe(Math.min(h.d.manifest.bytesFreedWhenEmptied, 500));
    expect(after.bytesFreedWhenEmptied).toBeLessThanOrEqual(after.bytesHeld);
  });

  test('a remaining repo folder counts the regular files of its recorded tree, each inode once', async () => {
    const h = await held(async () => WHOLE);
    const item = h.d.manifest.items.find((i) => i.role === 'repo-folder')!;
    await appendFile(join(item.heldPath, 'blobs', HEX.C), 'x');         // the folder changed: it stays held
    await unlink(h.d.manifest.storeItems.find((x) => x.heldPath !== null)!.heldPath!);   // S1 is gone: a manifest change to write
    const p = await plan(h);
    expect(p.warnings).toContain(RESTORE_REASONS.changed(item.originalPath));
    const after = afterOf(p);
    expect(after.items.map((i) => i.originalPath)).toEqual([item.originalPath]);
    const files = new Map(item.tree!.filter((e) => e.facts.isFile).map((e) => [`${e.facts.dev}:${e.facts.ino}`, e.facts.size]));
    expect(after.bytesHeld).toBe([...files.values()].reduce((a, b) => a + b, 0));
    expect(after.bytesHeld).toBeGreaterThan(0);
  });

  test('directories the restore leaves empty are removed deepest first, before the manifest rewrite; others stay', async () => {
    const h = await held();
    const link = snap(h.s, 'm-Q8_0.gguf');
    await symlink(`../../blobs/${HEX.B}`, link);
    const p = await plan(h);
    const d = rmdirs(p);
    const depth = (x: string): number => x.split('/').length;
    expect(d.map(depth)).toEqual([...d.map(depth)].sort((a, b) => b - a));
    expect(d).toEqual(expect.arrayContaining([join(h.d.dir, 'store', 'aa'), join(h.d.dir, 'store'),
      join(h.d.dir, 'models--org--gguf', 'blobs'), join(h.d.dir, 'models--org--gguf', 'snapshots', HEX.c1, 'sub')]));
    expect(d).not.toContain(h.d.dir);
    expect(d).not.toContain(join(h.d.dir, 'models--org--gguf', 'snapshots', HEX.c1));   // still holds the Q8 link
    expect(p.ops.lastIndexOf(p.ops.filter((o) => o.kind === 'rmdir-empty').at(-1)!)).toBe(p.ops.length - 2);
    const hubBefore = await treeDigest(h.s.hub);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(existsSync(join(h.d.dir, 'store'))).toBe(false);
    expect(existsSync(join(h.d.dir, 'models--org--gguf', 'snapshots', HEX.c1))).toBe(true);
    expect(await treeDigest(h.s.hub)).not.toEqual(hubBefore);
  });

  test('a restored item whose repo folder is gone from the hub warns that only the restored files go back', async () => {
    const h = await held();
    const blobC = gguf(h.s, 'blobs', HEX.C);
    await appendFile(held1(h, blobC), 'x');                             // one item stays held, so this is a partial restore
    const model = await h.s.model();
    await rename(gguf(h.s), join(h.s.root, 'elsewhere'));
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings).toContain(RESTORE_REASONS.repoFolderGone('org/gguf'));
    expect(RESTORE_REASONS.repoFolderGone('org/gguf')).toBe('org/gguf: the repo folder is gone; only the restored files will be put back.');
    expect(p.warnings.filter((w) => w === RESTORE_REASONS.repoFolderGone('org/gguf'))).toHaveLength(1);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(existsSync(snap(h.s, 'm-Q8_0.gguf'))).toBe(true);
  });

  test('strays in the deletion folder are kept and reported; the manifest is rewritten with no items', async () => {
    const h = await held();
    await writeFile(join(h.d.dir, 'stray.bin'), 'not ours');
    const p = await plan(h);
    expect(p.warnings).toContain(RESTORE_REASONS.strays);
    expect(p.warnings.filter((w) => w === RESTORE_REASONS.strays)).toHaveLength(1);
    expect(p.ops.at(-1)!.kind).toBe('write-file');
    expect(p.ops.some((o) => o.kind === 'unlink')).toBe(false);
    expect(rmdirs(p)).not.toContain(h.d.dir);
    const after = afterOf(p);
    expect([after.items, after.storeItems]).toEqual([[], []]);
    expect(after.bytesHeld).toBe(0);
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(await listHeld(h.s.roots)).toMatchObject([{ ok: true, heldCount: 0, otherEntries: 1 }]);
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
    expect(RESTORE_REASONS.strays).toBe('Recently Deleted still holds files for this deletion that were not part of it; empty it to remove them.');
  });

  test('a directory entry the deletion folder holds that is not in the manifest is a stray too (its files are not walked as items)', async () => {
    const h = await held();
    await mkdir(join(h.d.dir, 'extra'));
    await writeFile(join(h.d.dir, 'extra', 'f'), 'x');
    const p = await plan(h);
    expect(p.warnings).toContain(RESTORE_REASONS.strays);
    expect(rmdirs(p)).not.toContain(join(h.d.dir, 'extra'));
  });

  test('the cleanup: an rmdir-empty is planned only where the parent is a real path', async () => {
    const h = await held();
    await writeFile(join(h.d.dir, 'stray.bin'), 'x');
    const store = join(h.d.dir, 'store');
    const lying: typeof h.s.fs = { ...h.s.fs, realpath: async (q) => (q === store ? join(h.s.root, 'elsewhere') : h.s.fs.realpath(q)) };
    const p = await planRestore(h.d, await h.s.model(), h.s.roots, h.s.now, lying);
    expect(rmdirs(p)).not.toContain(join(store, 'aa'));                 // its parent resolves elsewhere
    expect(rmdirs(p)).not.toContain(store);
    for (const q of rmdirs(p)) expect(await h.s.fs.realpath(dirname(q))).toBe(dirname(q));
  });
});

describe('store items in the rewritten manifest', () => {
  const extraLine = `models--org--gguf/blobs/${HEX.A}`;                    // a recorded line whose blob is not coming back
  const withExtra = (m: HoldManifest): void => { m.storeItems.find((x) => x.originalPath.includes(HEX.S1))!.refsRemoved.push(extraLine); };

  test('a restored payload keeps the lines it could not write, as a store item whose payload is in the hub', async () => {
    const h = await held();
    await editManifest(h, withExtra);
    await symlink(`../../blobs/${HEX.B}`, snap(h.s, 'm-Q8_0.gguf'));   // one item stays held: a partial restore
    const p = await plan(h);
    expect(renames(p).some((o) => o.role === 'store-payload')).toBe(true);
    const item = afterOf(p).storeItems.find((x) => x.originalPath === s1(h.s))!;
    expect(item).toMatchObject({ heldPath: null, refsRemoved: [extraLine] });
    expect(parseManifest(writeOf(p).after, { holdRoot: h.s.roots.holdRoot!, deletionId: h.deletionId })).toMatchObject({ ok: true });
    expect((await h.s.exec(p)).ok).toBe(true);
    expect(readFileSync(s1(h.s) + '.refs', 'utf8')).toBe(`models--org--gguf/blobs/${HEX.B}\n`);
  });

  test('a payload that never left the hub keeps its unwritten lines too (it is in the hub)', async () => {
    const h = await held();
    await editManifest(h, withExtra);
    const held1S = h.d.manifest.storeItems.find((x) => x.originalPath === s1(h.s))!.heldPath!;
    await rename(held1S, s1(h.s));
    await writeFile(s1(h.s) + '.refs', `models--org--other/blobs/${HEX.E}\n`);
    await symlink(`../../blobs/${HEX.B}`, snap(h.s, 'm-Q8_0.gguf'));   // one item stays held: a partial restore
    const p = await plan(h);
    const item = afterOf(p).storeItems.find((x) => x.originalPath === s1(h.s))!;
    expect(item).toMatchObject({ heldPath: null, refsRemoved: [extraLine] });
  });

  test('a payload that is gone from the deletion folder and not in the hub is dropped, with its lines', async () => {
    const h = await held();
    await editManifest(h, withExtra);
    await unlink(h.d.manifest.storeItems.find((x) => x.originalPath === s1(h.s))!.heldPath!);
    await symlink(`../../blobs/${HEX.B}`, snap(h.s, 'm-Q8_0.gguf'));   // one item stays held: a partial restore
    const p = await plan(h);
    expect(p.warnings).toContain(RESTORE_REASONS.missingHeld(s1(h.s)));
    expect(afterOf(p).storeItems.map((x) => x.originalPath)).not.toContain(s1(h.s));
  });
});

describe('a restore that fails after the manifest rewrite puts the previous manifest back', () => {
  test('the rewrite failing, or a later failure → ROLLED_BACK; the manifest text and every item are as before', async () => {
    const h = await held();
    await symlink(`../../blobs/${HEX.B}`, snap(h.s, 'm-Q8_0.gguf'));
    const p = await plan(h);
    const mp = join(h.d.dir, MANIFEST_NAME);
    const holdBefore = await treeDigest(h.d.dir);
    let failed = false;                                                 // only the plan's own write fails; the rollback's passes
    const safeFs = new Proxy(h.s.safeFs, { get: (target, k, recv) => (k !== 'writeFileAtomic' ? Reflect.get(target, k, recv) as unknown
      : async (q: string, ...a: Parameters<typeof target.writeFileAtomic> extends [string, ...infer R] ? R : never) => {
        if (q === mp && !failed) {
          failed = true;
          await target.writeFileAtomic(q, ...a);                        // the write takes effect ...
          throw new SafeFsError('IO', q, 'EIO: injected', 'EIO');       // ... but reports an error
        }
        return target.writeFileAtomic(q, ...a);
      }) });
    const r = await executePlan(p, { ...h.s.execDeps(), safeFs });
    expect(r.error, JSON.stringify(r.error)).toMatchObject({ code: 'ROLLED_BACK' });
    expect(await readFile(mp, 'utf8')).toBe(h.d.manifestText);
    const strip = (x: Record<string, string>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== MANIFEST_NAME));
    expect(strip(await treeDigest(h.d.dir))).toEqual(strip(holdBefore));
    for (const it of h.d.manifest.items) expect(lstatSync(it.heldPath).ino).toBe(it.facts.ino);
  });
});

describe('first match wins when two refusal reasons apply to one item', () => {
  test('original path exists and the held entry changed: only "exists" is reported, once', async () => {
    const h = await held();
    const q8 = snap(h.s, 'm-Q8_0.gguf');
    await symlink(`../../blobs/${HEX.B}`, q8);                          // exists ...
    await unlink(held1(h, q8));
    await symlink(`../../blobs/${HEX.A}`, held1(h, q8));                // ... and the held entry changed
    const p = await plan(h);
    expect(p.warnings.filter((w) => w.includes(q8))).toEqual([RESTORE_REASONS.exists(q8)]);
  });

  test('the held blob changed and its shared-store payload is gone: only "changed" is reported for it', async () => {
    const h = await held();
    const model = await h.s.model();
    const blobD = gguf(h.s, 'blobs', HEX.D);
    await unlink(held1(h, blobD));
    await symlink(`../../blobs/aa/${HEX.S1}`, held1(h, blobD));
    await unlink(s2(h.s));
    await unlink(s2(h.s) + '.refs');
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings.filter((w) => w.includes(blobD))).toEqual([RESTORE_REASONS.changed(blobD)]);
  });
});

describe('the active-download guard and vanishing entries', () => {
  test('only an ACTIVE_DOWNLOAD PlanError becomes a HeldError; any other error is rethrown unchanged', async () => {
    const h = await held(q4Only);
    const other = new PlanError('UNKNOWN_REPO', 'nope');
    const odd = new TypeError('boom');
    try {
      guard.override = () => { throw other; };
      await expect(plan(h)).rejects.toBe(other);
      guard.override = () => { throw odd; };
      await expect(plan(h)).rejects.toBe(odd);
      guard.override = () => { throw new PlanError('ACTIVE_DOWNLOAD', 'busy'); };
      await expect(plan(h)).rejects.toMatchObject({ name: 'HeldError', code: 'ACTIVE_DOWNLOAD', message: 'busy' });
    } finally {
      guard.override = null;
    }
  });

  test.each([
    ['the realpath of a held parent', 'realpath', (h: Held) => dirname(held1(h, gguf(h.s, 'blobs', HEX.C)))],
    ['the walk of a held repo folder', 'readdir', (h: Held) => h.d.manifest.items.find((i) => i.role === 'repo-folder')!.heldPath],
    ['the walk of the deletion folder', 'readdir', (h: Held) => h.d.dir],
  ] as const)('%s vanishing mid-plan is a HeldError STALE_MANIFEST, not a plain Error', async (name, method, target) => {
    const h = await held(name.includes('repo folder') ? async () => WHOLE : undefined);
    const fs = failingFs(h.s.fs, method, 'ENOENT', (q) => q === target(h));
    const err = await planRestore(h.d, await h.s.model(), h.s.roots, h.s.now, fs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeldError);
    expect(err).toMatchObject({ code: 'STALE_MANIFEST' });
  });

  test('any other read error mid-plan propagates unchanged', async () => {
    const h = await held();
    const fs = failingFs(h.s.fs, 'readdir', 'EIO', (q) => q === h.d.dir);
    const err = await planRestore(h.d, await h.s.model(), h.s.roots, h.s.now, fs).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HeldError);
    expect(err).toMatchObject({ code: 'EIO' });
  });
});

describe('a full restore never leaves an entry it does not move behind a removed manifest', () => {
  test.each([['the deletion folder', []], ['a nested directory', ['store', 'aa']]] as const)(
    'a file added to %s after planning → STALE naming it, nothing touched', async (_where, rel) => {
      const h = await held();
      const p = await plan(h);
      expect(p.ops.some((o) => o.kind === 'unlink')).toBe(true);                 // a full restore
      const added = join(h.d.dir, ...rel, 'added-later');
      await writeFile(added, 'new');
      const before = await treeDigest(h.s.root);
      const r = await h.s.exec(p);
      expect(r).toMatchObject({ ok: false, appliedOps: 0, error: { code: 'STALE', path: added } });
      expect(await treeDigest(h.s.root)).toEqual(before);
    });

  test('a file added during the run → the restore rolls back; the manifest and every item are back', async () => {
    const h = await held();
    const p = await plan(h);
    const nested = join(h.d.dir, 'store', 'aa');
    const r = await h.s.exec(p, { beforeFirstOp: async () => { await writeFile(join(nested, 'raced-in'), 'x'); } });
    expect(r.error).toMatchObject({ code: 'ROLLED_BACK', path: nested });
    expect(r.error!.message).toContain('rmdir-empty failed: ENOTEMPTY');
    expect(await readFile(join(h.d.dir, MANIFEST_NAME), 'utf8')).toBe(h.d.manifestText);
    for (const it of h.d.manifest.items) expect(lstatSync(it.heldPath).ino).toBe(it.facts.ino);
    expect(await readFile(join(nested, 'raced-in'), 'utf8')).toBe('x');
  });
});
