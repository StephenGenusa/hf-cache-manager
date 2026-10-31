// Hold, restore and empty edge cases. Every scenario is built from a real hold
// of the shared hold scenario and executed by the real executor; outcomes are asserted on disk.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { autoEmptyDue, EMPTY_LEFTOVER, EMPTY_SKIPPED, EMPTY_WARNINGS, listHeld, planEmpty, planRestore, RESTORE_REASONS, RESTORE_SYNC_HINT, type HeldDeletion } from '../../../src/core/hold/held';
import {
  createHoldHooks, executeHold, finalizeHold, MANIFEST_NAME, manifestFromPlan, parseManifest, serializeManifest, TOO_MANY_FILES, type HoldManifest,
} from '../../../src/core/hold/manifest';
import type { DeletionPlan, Op, Selection } from '../../../src/core/types';
import type { ReadFs, StatLike } from '../../../src/core/fsx';
import { executePlan } from '../../../src/core/exec/executor';
import { SafeFsError } from '../../../src/core/safe-fs';
import { fingerprintPlan } from '../../../src/core/plan/fingerprint';
import { useCanaries } from '../../helpers/canary';
import { treeDigest } from '../../helpers/tree-digest';
import { assertR1, buildHoldScenario, HEX, q8Iq2MmprojSelection, type HoldScenario } from './scenario';

useCanaries();

type OkDeletion = Extract<HeldDeletion, { ok: true }>;
const WHOLE: Selection = { repos: [{ repoId: 'org/gguf', whole: true }] };

interface Held { s: HoldScenario; d: OkDeletion; hubBefore: Record<string, string>; deletionId: string }

async function held(sel?: (s: HoldScenario) => Promise<Selection>, s0?: HoldScenario): Promise<Held> {
  const s = s0 ?? await buildHoldScenario();
  const hubBefore = await treeDigest(s.hub);
  const m = await s.model();
  const hold = await s.holdPlan(sel ? await sel(s) : q8Iq2MmprojSelection(s, m));
  const r = await executeHold(hold, s.execDeps(), { model: m, viewRoots: s.viewRoots, fs: s.fs });
  expect(r.ok).toBe(true);
  return { s, d: await only(s, hold.deletionId!), hubBefore, deletionId: hold.deletionId! };
}
async function only(s: HoldScenario, id: string): Promise<OkDeletion> {
  const d = (await listHeld(s.roots)).find((x) => x.deletionId === id)!;
  if (!d.ok) throw new Error(d.error);
  return d;
}
const plan = (h: Held): Promise<DeletionPlan> => h.s.model().then((m) => planRestore(h.d, m, h.s.roots, h.s.now));
const mpOf = (h: Held): string => join(h.d.dir, MANIFEST_NAME);
const readM = (h: Held): HoldManifest => JSON.parse(readFileSync(mpOf(h), 'utf8')) as HoldManifest;
const writeM = (h: Held, m: unknown): Promise<void> => writeFile(mpOf(h), JSON.stringify(m, null, 2) + '\n');

/** Every `dev` number anywhere in the manifest, plus one (as after a reboot that renumbers the device). */
function bumpDevs(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(bumpDevs);
  if (typeof x === 'object' && x !== null) {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'dev' && typeof v === 'number' ? v + 1 : bumpDevs(v)]));
  }
  return x;
}

describe('identity never compares a recorded st_dev with a live one', () => {
  test.each([
    ['partial groups', undefined],
    ['whole repo', async () => WHOLE],
    // blob C is hardlinked between the two repos: the restored bytes count its inode once
    ['whole repo plus a group of another repo', async (s: HoldScenario) => ({ repos: [...WHOLE.repos, { repoId: 'org/other', whole: false,
      unlockComponents: false, groupKeys: [s.keyFor(await s.model(), 'org/other', 'quant', 'IQ2_XS')] }] })],
  ] as Array<[string, ((s: HoldScenario) => Promise<Selection>) | undefined]>)('%s: every recorded dev renumbered — listed as held, restored completely', async (_n, sel) => {
    const h = await held(sel);
    const before = h.d.heldCount;
    const m = readM(h);
    const bytes = (await plan(h)).apparentBytes;
    expect(before).toBe(m.items.length + m.storeItems.filter((x) => x.heldPath !== null).length);
    await writeM(h, bumpDevs(m));
    h.d = await only(h.s, h.deletionId);
    expect(h.d.manifest.items[0]!.facts.dev).toBe(m.items[0]!.facts.dev + 1);
    expect(h.d.heldCount).toBe(before);
    expect(h.d.otherEntries).toBe(0);
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_SYNC_HINT]);
    expect(p.apparentBytes).toBe(bytes);
    expect(p.ops.filter((o) => o.kind === 'restore-rename')).toHaveLength(m.items.length + m.storeItems.filter((x) => x.heldPath !== null).length);
    const r = await h.s.exec(p);
    expect(r.error).toBeUndefined();
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
    expect(readdirSync(h.s.roots.holdRoot!)).toEqual([]);
    expect(existsSync(h.d.dir)).toBe(false);
  });
});

describe('finalizeHold reconciles done flags on the live device', () => {
  test('a manifest whose recorded devs differ from the live ones still marks the held entries done', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const hold = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const r = await executeHold(hold, s.execDeps(), { model: m, viewRoots: s.viewRoots, fs: s.fs });
    expect(r.ok).toBe(true);
    const h = { d: await only(s, hold.deletionId!) } as Held;
    await writeM(h, bumpDevs(readM(h)));
    const fin = await finalizeHold(hold, { ...r, ok: false }, { safeFs: s.safeFs, fs: s.fs });
    expect(fin!.items.every((i) => i.done)).toBe(true);
    expect(fin!.storeItems.filter((i) => i.heldPath !== null).every((i) => i.done)).toBe(true);
  });
});

/** `base`, with lstat of exactly `paths` reporting another device (as a mount would). */
function otherDevAt(base: ReadFs, paths: string[]): ReadFs {
  return Object.assign(Object.create(base) as ReadFs, {
    lstat: async (p: string) => {
      const st = await base.lstat(p);
      return paths.includes(p) ? Object.assign(Object.create(st) as StatLike, { dev: st.dev + 1 }) : st;
    },
  });
}

describe('entries must be on the live device of their folder', () => {
  test('a held item on another device than the deletion folder is changed; so is a repo folder whose tree has one', async () => {
    const h = await held(async () => WHOLE);
    const folder = h.d.manifest.items.find((i) => i.role === 'repo-folder')!;
    const inner = join(folder.heldPath, 'blobs', HEX.A);
    const m = await h.s.model();
    const a = await planRestore(h.d, m, h.s.roots, h.s.now, otherDevAt(h.s.fs, [inner]));
    expect(a.warnings).toContain(RESTORE_REASONS.changed(folder.originalPath));
    const b = await planRestore(h.d, m, h.s.roots, h.s.now, otherDevAt(h.s.fs, [folder.heldPath]));
    expect(b.warnings).toContain(RESTORE_REASONS.changed(folder.originalPath));
    const c = await planRestore(h.d, m, h.s.roots, h.s.now);
    expect(c.warnings).toEqual([RESTORE_SYNC_HINT]);
  });
});

const q4Only = async (s: HoldScenario): Promise<Selection> => ({ repos: [{ repoId: 'org/gguf', whole: false,
  unlockComponents: false, groupKeys: [s.keyFor(await s.model(), 'org/gguf', 'quant', 'Q4_K_M')] }] });

describe('an interrupted deletion that restore cannot change is acknowledged by the restore', () => {
  test('a moving manifest whose items all exist again: one write-file to partial, then planEmpty plans it', async () => {
    const h = await held(q4Only);
    await writeM(h, { ...readM(h), status: 'moving' });
    for (const it of h.d.manifest.items) await writeFile(it.originalPath, 're-downloaded');
    h.d = await only(h.s, h.deletionId);
    expect(h.d.interrupted).toBe(true);
    const p = await plan(h);
    expect(p.ops.map((o) => o.kind)).toEqual(['write-file']);
    const w = p.ops[0] as Extract<Op, { kind: 'write-file' }>;
    expect(JSON.parse(w.after)).toEqual({ ...JSON.parse(h.d.manifestText), status: 'partial' });
    expect((await h.s.exec(p)).error).toBeUndefined();
    h.d = await only(h.s, h.deletionId);
    expect(h.d.interrupted).toBe(false);
    const e = await planEmpty([h.d], h.s.roots, h.s.now);
    expect(e.skipped).toEqual([]);
    expect(e.plans).toHaveLength(1);
  });

  test('a held (not moving) manifest that nothing changes gets no write', async () => {
    const h = await held(q4Only);
    for (const it of h.d.manifest.items) await writeFile(it.originalPath, 're-downloaded');
    expect((await plan(h)).ops).toEqual([]);
  });
});

const s1Of = (s: HoldScenario): string => join(s.hub, 'blobs', 'aa', HEX.S1);
const ggufBlob = (s: HoldScenario, hash: string): string => join(s.hub, 'models--org--gguf', 'blobs', hash);

describe('a stale .refs left by a crash between the payload move and the .refs unlink', () => {
  test('.refs lists exactly the removed line: blobs back first, then the payload; no refs write needed', async () => {
    const h = await held();
    const lineB = `models--org--gguf/blobs/${HEX.B}`;
    await writeFile(s1Of(h.s) + '.refs', `${lineB}\n`);                 // the crash state, built by hand
    const ino = lstatSync(h.d.manifest.storeItems.find((x) => x.originalPath === s1Of(h.s))!.heldPath!).ino;
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_SYNC_HINT]);
    const kinds = p.ops.map((o) => (o.kind === 'restore-rename' ? `rr:${o.role}` : o.kind));
    expect(kinds.slice(0, 6)).toEqual(['rr:repo-blob', 'rr:repo-blob', 'rr:repo-blob', 'store-refs-add', 'rr:store-payload', 'rr:snapshot-link']);
    expect(p.ops.filter((o) => o.kind === 'store-refs-add').map((o) => o.refsPath)).toEqual([join(s1Of(h.s), '..', `${HEX.S2}.refs`).replace('/aa/', '/bb/')]);
    assertR1(p);
    expect((await h.s.exec(p)).error).toBeUndefined();
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
    expect(lstatSync(s1Of(h.s)).ino).toBe(ino);
    expect(readdirSync(h.s.roots.holdRoot!)).toEqual([]);
  });

  test('.refs lists only an invalid line: the removed line is added to it, then the payload moves', async () => {
    const h = await held();
    const junk = 'models--org--zzz/blobs/nothing';
    await writeFile(s1Of(h.s) + '.refs', `${junk}\n`);
    const p = await plan(h);
    expect(p.warnings).toEqual([RESTORE_SYNC_HINT]);
    const add = p.ops.findIndex((o) => o.kind === 'store-refs-add' && o.refsPath === s1Of(h.s) + '.refs');
    expect(p.ops[add]).toEqual({ kind: 'store-refs-add', refsPath: s1Of(h.s) + '.refs',
      addRefs: [`models--org--gguf/blobs/${HEX.B}`], expectRefsRaw: [junk] });
    const pay = p.ops.findIndex((o) => o.kind === 'restore-rename' && o.dest === s1Of(h.s));
    const blob = p.ops.findIndex((o) => o.kind === 'restore-rename' && o.dest === ggufBlob(h.s, HEX.B));
    expect(blob).toBeLessThan(add);
    expect(add).toBeLessThan(pay);
    assertR1(p);
    expect((await h.s.exec(p)).error).toBeUndefined();
    expect(readFileSync(s1Of(h.s) + '.refs', 'utf8')).toBe(`models--org--gguf/blobs/${HEX.B}\n${junk}\n`);
    expect(existsSync(s1Of(h.s))).toBe(true);
  });

  test('a failing late payload move rolls back: the refs add is undone and the blobs go back to Recently Deleted', async () => {
    const h = await held();
    const junk = 'models--org--zzz/blobs/nothing';
    await writeFile(s1Of(h.s) + '.refs', `${junk}\n`);
    const p = await plan(h);
    const holdBefore = await treeDigest(h.d.dir);
    const safeFs = new Proxy(h.s.safeFs, { get: (target, k, recv) => (k !== 'rename' ? Reflect.get(target, k, recv) as unknown
      : async (from: string, to: string, ...rest: unknown[]) => {
        if (to === s1Of(h.s)) throw new SafeFsError('IO', to, 'EIO: injected', 'EIO');
        return (target.rename as (...a: unknown[]) => Promise<void>).call(target, from, to, ...rest);
      }) });
    const r = await executePlan(p, { ...h.s.execDeps(), safeFs });
    expect(r.error?.code).toBe('ROLLED_BACK');
    expect(readFileSync(s1Of(h.s) + '.refs', 'utf8')).toBe(`${junk}\n`);
    expect(existsSync(s1Of(h.s))).toBe(false);
    expect(existsSync(ggufBlob(h.s, HEX.B))).toBe(false);
    expect(await treeDigest(h.d.dir)).toEqual(holdBefore);
  });

  test('a plan whose only store op is a late payload move still checks the whole hub for a download', async () => {
    const h = await held(async (s) => ({ repos: [{ repoId: 'org/gguf', whole: false, unlockComponents: false,
      groupKeys: [s.keyFor(await s.model(), 'org/gguf', 'quant', 'Q8_0')] }] }));
    await writeFile(s1Of(h.s) + '.refs', `models--org--gguf/blobs/${HEX.B}\n`);
    const p = await plan(h);
    expect(p.ops.filter((o) => o.kind === 'store-refs-add')).toEqual([]);
    expect(p.ops.filter((o) => o.kind === 'restore-rename').map((o) => o.role)).toEqual(['repo-blob', 'store-payload', 'snapshot-link']);
    await writeFile(join(h.s.hub, 'models--org--other', 'blobs', 'f'.repeat(64) + '.incomplete'), 'partial');
    await expect(h.s.model().then((m) => planRestore(h.d, m, h.s.roots, Date.now()))).rejects.toMatchObject({ code: 'ACTIVE_DOWNLOAD' });
  });

  test('a stale .refs whose removed line nothing restores keeps the payload held (storeUnused)', async () => {
    const h = await held();
    await writeFile(s1Of(h.s) + '.refs', `models--org--gguf/blobs/${HEX.B}\n`);
    await writeFile(ggufBlob(h.s, HEX.B), 're-downloaded as a regular file');
    const p = await plan(h);
    expect(p.warnings).toContain(RESTORE_REASONS.storeUnused(s1Of(h.s)));
    expect(p.ops.some((o) => o.kind === 'restore-rename' && o.dest === s1Of(h.s))).toBe(false);
  });

  test('a .refs line that cannot be checked (lstat EACCES) is not stale: the payload stays held (storeRefsPresent)', async () => {
    const h = await held();
    await writeFile(s1Of(h.s) + '.refs', 'models--org--zzz/blobs/locked\n');
    const locked = join(h.s.hub, 'models--org--zzz', 'blobs', 'locked');
    const fs = Object.assign(Object.create(h.s.fs) as ReadFs, {
      lstat: async (q: string) => {
        if (q === locked) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return h.s.fs.lstat(q);
      },
    });
    const p = await planRestore(h.d, await h.s.model(), h.s.roots, h.s.now, fs);
    expect(p.warnings).toContain(RESTORE_REASONS.storeRefsPresent(s1Of(h.s)));
  });
});

describe('a payload an interrupted restore of this deletion already put back gets its .refs lines', () => {
  test('a restore that stops right after op 0 (the payload move): the next restore creates .refs with the restored lines', async () => {
    const h = await held();
    const p = await plan(h);
    expect(p.ops[0]).toMatchObject({ kind: 'restore-rename', role: 'store-payload', dest: s1Of(h.s) });
    // the crash: only op 0 ran, nothing rolled back (the same plan cut after op 0, executed by the real executor)
    const body = { ...p, ops: p.ops.slice(0, 1) };
    const cut = { ...body, fingerprint: fingerprintPlan(body) };
    expect((await h.s.exec(cut)).error).toBeUndefined();
    expect(existsSync(s1Of(h.s))).toBe(true);
    expect(existsSync(s1Of(h.s) + '.refs')).toBe(false);
    h.d = await only(h.s, h.deletionId);
    const q = await plan(h);
    expect(q.warnings).toEqual([RESTORE_SYNC_HINT]);
    const add = q.ops.findIndex((o) => o.kind === 'store-refs-add' && o.refsPath === s1Of(h.s) + '.refs');
    expect(q.ops[add]).toEqual({ kind: 'store-refs-add', refsPath: s1Of(h.s) + '.refs',
      addRefs: [`models--org--gguf/blobs/${HEX.B}`], expectRefsRaw: null });
    expect(q.ops.findIndex((o) => o.kind === 'restore-rename' && o.dest === ggufBlob(h.s, HEX.B))).toBeLessThan(add);
    assertR1(q);
    expect((await h.s.exec(q)).error).toBeUndefined();
    expect(readFileSync(s1Of(h.s) + '.refs', 'utf8')).toBe(`models--org--gguf/blobs/${HEX.B}\n`);
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
    expect(readdirSync(h.s.roots.holdRoot!)).toEqual([]);
  });

  test('a foreign payload without .refs (another inode) still gets no invented .refs', async () => {
    const h = await held();
    await writeFile(s1Of(h.s), 'downloaded again by someone else');
    const p = await plan(h);
    expect(p.ops.some((o) => o.kind === 'store-refs-add' && o.refsPath === s1Of(h.s) + '.refs')).toBe(false);
    expect(p.warnings).toContain(RESTORE_REASONS.storePresent(s1Of(h.s)));
  });
});

describe('a hold whose manifest would be too large to read back is refused before anything moves', () => {
  test('beforeFirstOp refuses past the limit: Could not prepare, nothing moved, no deletion folder left', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const hold = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const hub = await treeDigest(s.hub);
    const hooks = createHoldHooks({ safeFs: s.safeFs, fs: s.fs, model: m, viewRoots: s.viewRoots, now: () => 1, maxManifestBytes: 200 });
    const r = await s.exec(hold, hooks);
    expect(r.error?.code).toBe('IO');
    expect(r.error?.message).toContain(TOO_MANY_FILES);
    expect(TOO_MANY_FILES).toBe('Too many files to move to Recently Deleted — use Delete Permanently.');
    expect(await treeDigest(s.hub)).toEqual(hub);
    expect(readdirSync(s.roots.holdRoot!)).toEqual([]);
    expect(hooks.wrote(hold.id)).toBe(false);
  });

  test('exactly at the limit is accepted; the manifest is written compactly and a pretty one still parses', async () => {
    const s = await buildHoldScenario();
    const m = await s.model();
    const hold = await s.holdPlan(q8Iq2MmprojSelection(s, m));
    const probe = createHoldHooks({ safeFs: s.safeFs, fs: s.fs, model: m, viewRoots: s.viewRoots, now: () => 1 });
    expect((await s.exec(hold, probe)).ok).toBe(true);
    const text = readFileSync(join(s.roots.holdRoot!, hold.deletionId!, MANIFEST_NAME), 'utf8');
    const man = JSON.parse(text) as HoldManifest;
    expect(text).toBe(JSON.stringify(man) + '\n');
    expect(serializeManifest(man)).toBe(text);
    const pretty = parseManifest(JSON.stringify(man, null, 2), { holdRoot: s.roots.holdRoot!, deletionId: hold.deletionId! });
    expect(pretty).toEqual({ ok: true, manifest: man });

    const s2 = await buildHoldScenario();
    const m2 = await s2.model();
    const hold2 = await s2.holdPlan(q8Iq2MmprojSelection(s2, m2));
    // the moving manifest of the same plan shape: its size is the limit, so every write fits exactly or is smaller
    const first = serializeManifest(await manifestFromPlan(hold2, { model: m2, viewRoots: s2.viewRoots, fs: s2.fs, now: 1 }));
    const exact = createHoldHooks({ safeFs: s2.safeFs, fs: s2.fs, model: m2, viewRoots: s2.viewRoots, now: () => 1,
      maxManifestBytes: Buffer.byteLength(first) });
    expect((await s2.exec(hold2, exact)).error).toBeUndefined();
  });
});

const mmprojOf = (repoId: string) => async (s: HoldScenario): Promise<Selection> => ({ repos: [{ repoId, whole: false,
  unlockComponents: false, groupKeys: [s.keyFor(await s.model(), repoId, 'mmproj', '')] }] });
const s2Of = (s: HoldScenario): string => join(s.hub, 'blobs', 'bb', HEX.S2);

/** A holds org/gguf's mmproj while org/other still links to S2 (kept, heldPath null); B then holds org/other's mmproj,
 *  which takes S2 into B's folder. */
async function sharedPayload(): Promise<{ a: Held; b: Held }> {
  const a = await held(mmprojOf('org/gguf'));
  expect(a.d.manifest.storeItems.find((x) => x.originalPath === s2Of(a.s))!.heldPath).toBeNull();
  const b = await held(mmprojOf('org/other'), a.s);
  expect(b.d.manifest.storeItems.find((x) => x.originalPath === s2Of(a.s))!.heldPath).not.toBeNull();
  a.d = await only(a.s, a.deletionId);
  return { a, b };
}

describe('a store payload one deletion needs and another holds', () => {
  test('restoring A alone names B as the deletion to restore first', async () => {
    const { a, b } = await sharedPayload();
    const p = await plan(a);
    const blobD = ggufBlob(a.s, HEX.D);
    expect(p.warnings).toContain(RESTORE_REASONS.storeHeldElsewhere(blobD, `org/other (${b.deletionId})`));
    expect(p.warnings).not.toContain(RESTORE_REASONS.storeGone(blobD));
    expect(p.ops.some((o) => o.kind === 'restore-rename' && o.dest === blobD)).toBe(false);
  });

  test('a payload no other deletion still holds (unlisted there, or gone from its folder) is storeGone', async () => {
    const { a, b } = await sharedPayload();
    await held(q4Only, a.s);                                                   // a third deletion, without S2
    const bHeld = b.d.manifest.storeItems.find((x) => x.originalPath === s2Of(a.s))!.heldPath!;
    await rename(bHeld, join(a.s.root, 'moved-away'));
    const p = await plan(a);
    expect(p.warnings).toContain(RESTORE_REASONS.storeGone(ggufBlob(a.s, HEX.D)));
  });

  test('restoring a whole folder whose blob needs a payload B holds names B too', async () => {
    const a = await held(async () => WHOLE);
    const b = await held(mmprojOf('org/other'), a.s);
    a.d = await only(a.s, a.deletionId);
    const p = await plan(a);
    expect(p.warnings).toContain(RESTORE_REASONS.folderStoreHeldElsewhere('org/gguf', 1, `org/other (${b.deletionId})`));
    expect(p.warnings.some((w) => w.includes('no longer exists'))).toBe(false);
  });

  test('emptying B warns that A needs the payload; emptying both together does not', async () => {
    const { a, b } = await sharedPayload();
    const e = await planEmpty([b.d], b.s.roots, b.s.now);
    expect(e.plans[0]!.warnings).toEqual([EMPTY_WARNINGS.neededBy(s2Of(a.s), `org/gguf (${a.deletionId})`)]);
    const all = await planEmpty('all', b.s.roots, b.s.now);
    expect(all.plans.flatMap((x) => x.warnings)).toEqual([]);
  });

  test('autoEmptyDue (pure, from the listed deletions) defers B while A depends on its payload and is not due', async () => {
    const { a, b } = await sharedPayload();
    const list = await listHeld(a.s.roots);
    const day = 86_400_000;
    const at = (d: HeldDeletion, t: number): HeldDeletion => (d.ok ? { ...d, manifest: { ...d.manifest, createdAt: t } } : d);
    const now = 100 * day;
    const bOld = at(list.find((d) => d.deletionId === b.deletionId)!, 0);
    const aNew = at(list.find((d) => d.deletionId === a.deletionId)!, now);
    expect(autoEmptyDue([aNew, bOld], now, 14)).toEqual([]);                      // B deferred: A needs S2
    const aOld = at(aNew, 0);
    expect(autoEmptyDue([aOld, bOld], now, 14)).toEqual([aOld, bOld]);             // both due: B goes with A
    expect(autoEmptyDue([bOld], now, 14)).toEqual([bOld]);                         // A not listed: nothing depends
    const aMoving = aOld.ok ? { ...aOld, interrupted: true } : aOld;
    expect(autoEmptyDue([aMoving, bOld], now, 14)).toEqual([]);                    // A never due: B waits
  });
});

describe('emptying never walks into another device (a mount inside the deletion folder)', () => {
  test.each([['a directory', 'models--org--gguf'], ['a file', 'store']])('%s on another device than the deletion folder → skipped as changed, no plan', async (_n, top) => {
    const h = await held();
    let inside = join(h.d.dir, top);
    if (top === 'store') inside = h.d.manifest.storeItems.find((x) => x.heldPath !== null)!.heldPath!;
    const e = await planEmpty([h.d], h.s.roots, h.s.now, otherDevAt(h.s.fs, [inside]));
    expect(e).toEqual({ plans: [], skipped: [EMPTY_SKIPPED.changed(h.deletionId)] });
    expect((await planEmpty([h.d], h.s.roots, h.s.now)).plans).toHaveLength(1);
  });
});

const q8Only = async (s: HoldScenario): Promise<Selection> => ({ repos: [{ repoId: 'org/gguf', whole: false,
  unlockComponents: false, groupKeys: [s.keyFor(await s.model(), 'org/gguf', 'quant', 'Q8_0')] }] });

describe('a snapshot link is restored only when its target blob resolves', () => {
  test('the target blob is in the hub but is a store link whose payload is gone → targetMissing', async () => {
    const h = await held(q8Only);
    const model = await h.s.model();                                           // scanned before the dangling link exists
    const q8 = h.d.manifest.items.find((x) => x.role === 'snapshot-link')!.originalPath;
    await symlink(`../../blobs/aa/${HEX.S1}`, ggufBlob(h.s, HEX.B));          // a blob link, but S1 is held …
    await rename(h.d.manifest.storeItems.find((x) => x.heldPath !== null)!.heldPath!, join(h.s.root, 'S1-away'));  // … and then lost
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings).toContain(RESTORE_REASONS.targetMissing(q8));
    expect(p.ops.some((o) => o.kind === 'restore-rename' && o.dest === q8)).toBe(false);
  });

  test('a target blob linking to a payload that is in the hub → the snapshot link is restored', async () => {
    const h = await held(q8Only);
    const model = await h.s.model();
    const q8 = h.d.manifest.items.find((x) => x.role === 'snapshot-link')!.originalPath;
    await symlink(`../../blobs/bb/${HEX.S2}`, ggufBlob(h.s, HEX.B));
    await rename(h.d.manifest.storeItems.find((x) => x.heldPath !== null)!.heldPath!, join(h.s.root, 'S1-away'));
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings).not.toContain(RESTORE_REASONS.targetMissing(q8));
    expect(p.ops.some((o) => o.kind === 'restore-rename' && o.dest === q8)).toBe(true);
  });

  test('the same blob link whose payload this plan brings back → the snapshot link is restored', async () => {
    const h = await held(q8Only);
    const model = await h.s.model();
    const q8 = h.d.manifest.items.find((x) => x.role === 'snapshot-link')!.originalPath;
    await symlink(`../../blobs/aa/${HEX.S1}`, ggufBlob(h.s, HEX.B));
    const p = await planRestore(h.d, model, h.s.roots, h.s.now);
    expect(p.warnings).toContain(RESTORE_REASONS.exists(ggufBlob(h.s, HEX.B)));
    expect(p.ops.some((o) => o.kind === 'restore-rename' && o.dest === s1Of(h.s))).toBe(true);
    expect(p.ops.some((o) => o.kind === 'restore-rename' && o.dest === q8)).toBe(true);
  });
});

/** A complete restore of `h` that stops right after its manifest unlink (a crash): only empty directories are left. */
async function crashAfterManifestUnlink(h: Held): Promise<void> {
  const p = await plan(h);
  const k = p.ops.findIndex((o) => o.kind === 'unlink');
  const body = { ...p, ops: p.ops.slice(0, k + 1) };
  expect((await h.s.exec({ ...body, fingerprint: fingerprintPlan(body) })).error).toBeUndefined();
  expect(existsSync(mpOf(h))).toBe(false);
}

describe('a deletion folder left with only empty directories (a crash after the manifest unlink)', () => {
  test('listHeld reports it as an empty leftover; planEmpty plans only rmdir-empty ops, deepest first; the executor runs it', async () => {
    const h = await held();
    await crashAfterManifestUnlink(h);
    const listed = await listHeld(h.s.roots);
    expect(listed).toEqual([{ ok: false, deletionId: h.deletionId, dir: h.d.dir, error: EMPTY_LEFTOVER, emptyLeftover: true }]);
    const e = await planEmpty('all', h.s.roots, h.s.now);
    expect(e.skipped).toEqual([]);
    const p = e.plans[0]!;
    expect(p).toMatchObject({ mode: 'permanent', purpose: 'empty', deletionId: h.deletionId, freed: { bytes: 0, lines: [] },
      apparentBytes: 0, warnings: [], confirmPhrase: null });
    expect(p.ops.every((o) => o.kind === 'rmdir-empty')).toBe(true);
    const paths = p.ops.map((o) => (o as { path: string }).path);
    const depth = (x: string): number => x.split('/').length;
    expect(paths.map(depth)).toEqual([...paths.map(depth)].sort((a, b) => b - a));
    expect(paths.at(-1)).toBe(h.d.dir);
    expect(paths).toContain(join(h.d.dir, 'store', 'aa'));
    expect((await h.s.exec(p)).error).toBeUndefined();
    expect(readdirSync(h.s.roots.holdRoot!)).toEqual([]);
    expect(await treeDigest(h.s.hub)).toEqual(h.hubBefore);
  });

  test('a manifest-less folder holding a file is corrupt, not a leftover, and is skipped', async () => {
    const h = await held();
    await crashAfterManifestUnlink(h);
    await writeFile(join(h.d.dir, 'store', 'stray'), 'x');
    const [d] = await listHeld(h.s.roots);
    expect(d).toEqual({ ok: false, deletionId: h.deletionId, dir: h.d.dir, error: 'manifest.json missing' });
    expect((await planEmpty('all', h.s.roots, h.s.now)).plans).toEqual([]);
  });

  test.each([
    ['a file appears', async (h: Held) => { await writeFile(join(h.d.dir, 'late'), 'x'); }, null],
    ['a manifest appears', async (h: Held) => { await writeFile(mpOf(h), '{}'); }, null],
    ['the folder is gone', async (h: Held) => { await rename(h.d.dir, h.d.dir + '-x'); }, 'gone'],
  ] as Array<[string, (h: Held) => Promise<void>, 'gone' | null]>)('a leftover that changed after listing (%s) is skipped', async (_n, change, how) => {
    const h = await held();
    await crashAfterManifestUnlink(h);
    const listed = await listHeld(h.s.roots);
    await change(h);
    const e = await planEmpty(listed, h.s.roots, h.s.now);
    expect(e).toEqual({ plans: [], skipped: [how === 'gone' ? EMPTY_SKIPPED.gone(h.deletionId) : EMPTY_SKIPPED.changed(h.deletionId)] });
  });

  test('a caller-supplied leftover with a bad id, or whose folder is now a symlink, is skipped', async () => {
    const h = await held();
    await crashAfterManifestUnlink(h);
    const [d] = await listHeld(h.s.roots);
    const bad = { ...d!, deletionId: '../x' } as HeldDeletion;
    expect((await planEmpty([bad], h.s.roots, h.s.now)).skipped).toEqual([EMPTY_SKIPPED.corrupt('../x', '"../x" is not a deletion id.')]);
    await rename(h.d.dir, h.d.dir + '-real');
    await symlink(h.d.dir + '-real', h.d.dir);
    expect((await planEmpty([d!], h.s.roots, h.s.now)).skipped).toEqual([EMPTY_SKIPPED.gone(h.deletionId)]);
  });

  test('a leftover directory reached through a symlink, or on another device, is skipped as changed', async () => {
    const h = await held();
    await crashAfterManifestUnlink(h);
    const listed = await listHeld(h.s.roots);
    const sub = join(h.d.dir, 'store');
    const viaLink = Object.assign(Object.create(h.s.fs) as ReadFs, {
      realpath: async (q: string) => (q === sub ? '/elsewhere' : h.s.fs.realpath(q)),
    });
    expect((await planEmpty(listed, h.s.roots, h.s.now, viaLink)).skipped).toEqual([EMPTY_SKIPPED.changed(h.deletionId)]);
    expect((await planEmpty(listed, h.s.roots, h.s.now, otherDevAt(h.s.fs, [sub]))).skipped).toEqual([EMPTY_SKIPPED.changed(h.deletionId)]);
  });
});
