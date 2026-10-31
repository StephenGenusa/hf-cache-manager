import { mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readFs, type ReadFs } from '../../../src/core/fsx';
import { HeldError, autoEmptyDue, listHeld, rereadHeld } from '../../../src/core/hold/held';
import { createHoldHooks, MAX_MANIFEST_BYTES, MANIFEST_NAME, type HoldManifest } from '../../../src/core/hold/manifest';
import { useCanaries } from '../../helpers/canary';
import { treeDigest } from '../../helpers/tree-digest';
import { buildHoldScenario, q8Iq2MmprojSelection, type HoldScenario } from './scenario';

useCanaries();

const JUNK_ID = '2026-10-25T14-03-07-000Z-deadbeef';

async function holdAt(s: HoldScenario, now: number, sel?: Parameters<HoldScenario['holdPlan']>[0]): Promise<string> {
  const m = await s.model();
  const plan = await s.holdPlan(sel ?? q8Iq2MmprojSelection(s, m));
  const hooks = createHoldHooks({ safeFs: s.safeFs, fs: s.fs, model: m, viewRoots: s.viewRoots, now: () => now });
  const r = await s.exec(plan, hooks);
  expect(r.ok).toBe(true);
  return plan.deletionId!;
}
const readM = (s: HoldScenario, id: string): HoldManifest =>
  JSON.parse(readFileSync(join(s.roots.holdRoot!, id, MANIFEST_NAME), 'utf8')) as HoldManifest;
const writeM = (s: HoldScenario, id: string, m: unknown): void =>
  writeFileSync(join(s.roots.holdRoot!, id, MANIFEST_NAME), JSON.stringify(m, null, 2) + '\n');

describe('listHeld', () => {
  test('returns [] when the hold root does not exist or is unavailable', async () => {
    const s = await buildHoldScenario();
    expect(await listHeld({ hubRoot: s.hub, holdRoot: join(s.root, 'nope') })).toEqual([]);
    expect(await listHeld({ hubRoot: s.hub, holdRoot: null })).toEqual([]);
  });

  test('lists held deletions newest first with disk-derived counts', async () => {
    const s = await buildHoldScenario();
    const a = await holdAt(s, 1_000);
    const b = await holdAt(s, 2_000, { repos: [{ repoId: 'org/gguf', whole: false, unlockComponents: false,
      groupKeys: [s.keyFor(await s.model(), 'org/gguf', 'quant', 'Q4_K_M')] }] });
    const list = await listHeld(s.roots);
    expect(list.map((d) => d.ok && d.manifest.createdAt)).toEqual([2_000, 1_000]);
    expect(list.map((d) => d.deletionId)).toEqual([b, a]);
    const first = list.at(0)!;
    expect(first).toMatchObject({ ok: true, interrupted: false, otherEntries: 0, dir: join(s.roots.holdRoot!, b) });
    const second = list.at(1)!;
    expect(second).toMatchObject({ ok: true, interrupted: false, otherEntries: 0 });
    if (!second.ok || !first.ok) throw new Error('unreachable');
    expect(second.heldCount).toBe(second.manifest.items.length + second.manifest.storeItems.filter((x) => x.heldPath !== null).length);
    expect(second.heldCount).toBeGreaterThan(0);
    expect(first.manifestText).toBe(readFileSync(join(first.dir, 'manifest.json'), 'utf8'));
  });

  test('corrupt entries follow the ok ones, ordered by name', async () => {
    const s = await buildHoldScenario();
    await holdAt(s, 1_000);
    const z = '2026-10-25T14-03-07-000Z-ffffffff';
    mkdirSync(join(s.roots.holdRoot!, z));
    mkdirSync(join(s.roots.holdRoot!, JUNK_ID));
    const list = await listHeld(s.roots);
    expect(list.map((d) => d.ok)).toEqual([true, false, false]);
    expect(list.slice(1).map((d) => d.deletionId)).toEqual([JUNK_ID, z]);
  });

  test('sorts equal createdAt by id', async () => {
    const s = await buildHoldScenario();
    const a = await holdAt(s, 1_000);
    const b = await holdAt(s, 1_000, { repos: [{ repoId: 'org/gguf', whole: false, unlockComponents: false,
      groupKeys: [s.keyFor(await s.model(), 'org/gguf', 'quant', 'Q4_K_M')] }] });
    const ids = (await listHeld(s.roots)).map((d) => d.deletionId);
    expect(ids).toEqual([a, b].sort().reverse());
  });

  test('a tampered manifest is corrupt and nothing on disk changes', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const m = readM(s, id);
    m.items[0]!.originalPath = '/etc/passwd';
    writeM(s, id, m);
    const before = await treeDigest(s.roots.holdRoot!);
    const d = (await listHeld(s.roots)).at(0)!;
    expect(d).toMatchObject({ ok: false, deletionId: id, dir: join(s.roots.holdRoot!, id), error: expect.stringMatching(/originalPath/) });
    expect(await treeDigest(s.roots.holdRoot!)).toEqual(before);
  });

  test('a manifest for another hub is corrupt', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const d = (await listHeld({ ...s.roots, hubRoot: join(s.root, 'other-hub') })).at(0)!;
    expect(d).toMatchObject({ ok: false, deletionId: id, error: expect.stringMatching(/hub/) });
  });

  test('missing, linked, invalid and oversized manifests are corrupt', async () => {
    const s = await buildHoldScenario();
    const hr = s.roots.holdRoot!;
    const ids = ['2026-10-25T14-03-07-000Z-00000001', '2026-10-25T14-03-07-000Z-00000002',
      '2026-10-25T14-03-07-000Z-00000003', '2026-10-25T14-03-07-000Z-00000004', '2026-10-25T14-03-07-000Z-00000005'];
    for (const id of ids) mkdirSync(join(hr, id));
    writeFileSync(join(hr, ids[0]!, 'stray'), 'x');                      // A folder of only directories is a leftover
    symlinkSync(join(s.root, 'elsewhere.json'), join(hr, ids[1]!, MANIFEST_NAME));
    writeFileSync(join(hr, ids[2]!, MANIFEST_NAME), '{nope');
    writeFileSync(join(hr, ids[3]!, MANIFEST_NAME), '');
    truncateSync(join(hr, ids[3]!, MANIFEST_NAME), MAX_MANIFEST_BYTES + 1);
    mkdirSync(join(hr, ids[4]!, MANIFEST_NAME));
    const list = await listHeld(s.roots);
    expect(list.map((d) => !d.ok && d.error)).toEqual([
      'manifest.json missing',
      'manifest.json is not a regular file',
      'manifest is not valid JSON',
      'manifest too large',
      'manifest.json is not a regular file',
    ]);
  });

  test('ignores foreign names; a symlinked or plain-file deletion folder is corrupt and never followed', async () => {
    const s = await buildHoldScenario();
    const real = await holdAt(s, 1_000);
    const hr = s.roots.holdRoot!;
    writeFileSync(join(hr, 'notes.txt'), 'x');
    mkdirSync(join(hr, '.tmp-x'));
    symlinkSync(join(hr, real), join(hr, JUNK_ID));
    const fileId = '2026-10-25T14-03-07-000Z-00000009';
    writeFileSync(join(hr, fileId), 'x');
    const list = await listHeld(s.roots);
    expect(list.map((d) => d.deletionId)).toEqual([real, fileId, JUNK_ID]);
    expect(list.slice(1)).toEqual([
      { ok: false, deletionId: fileId, dir: join(hr, fileId), error: 'not a directory' },
      { ok: false, deletionId: JUNK_ID, dir: join(hr, JUNK_ID), error: 'not a directory' },
    ]);
    expect(readdirSync(hr).sort()).toEqual(['.tmp-x', real, JUNK_ID, fileId, 'notes.txt'].sort());
  });

  test('heldCount comes from the disk, not the done flags (crashed run)', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const m = readM(s, id);
    const expected = m.items.length + m.storeItems.filter((x) => x.heldPath !== null).length;
    for (const it of m.items) it.done = false;
    for (const it of m.storeItems) it.done = false;
    m.status = 'moving';
    writeM(s, id, m);
    const d = (await listHeld(s.roots)).at(0)!;
    expect(d).toMatchObject({ ok: true, interrupted: true, heldCount: expected, otherEntries: 0 });
  });

  test('a missing or replaced held file is not counted', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const m = readM(s, id);
    const total = m.items.length + m.storeItems.filter((x) => x.heldPath !== null).length;
    const link = m.items.find((i) => i.role === 'snapshot-link')!;
    unlinkSync(link.heldPath);
    expect((await listHeld(s.roots)).at(0)).toMatchObject({ ok: true, heldCount: total - 1, otherEntries: 0 });
    writeFileSync(link.heldPath, 'impostor');
    expect((await listHeld(s.roots)).at(0)).toMatchObject({ ok: true, heldCount: total - 1, otherEntries: 1 });
    const stored = m.storeItems.find((x) => x.heldPath !== null)!;
    unlinkSync(stored.heldPath!);
    writeFileSync(stored.heldPath!, 'impostor');
    expect((await listHeld(s.roots)).at(0)).toMatchObject({ ok: true, heldCount: total - 2, otherEntries: 2 });
  });

  test('otherEntries counts unexpected non-directory entries at any depth, links included, directories excluded', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const dir = join(s.roots.holdRoot!, id);
    mkdirSync(join(dir, 'extra', 'deeper'), { recursive: true });
    writeFileSync(join(dir, 'extra', 'deeper', 'f.txt'), 'x');
    symlinkSync('/nonexistent-target', join(dir, 'stray-link'));
    expect((await listHeld(s.roots)).at(0)).toMatchObject({ ok: true, otherEntries: 2 });
  });

  test('a whole-repo hold counts the folder and its recorded tree; extra files inside it are other entries', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000, { repos: [{ repoId: 'org/other', whole: true }] });
    const m = readM(s, id);
    const folder = m.items.find((i) => i.role === 'repo-folder')!;
    expect((await listHeld(s.roots)).at(0)).toMatchObject({ ok: true, otherEntries: 0, heldCount: m.items.length + m.storeItems.filter((x) => x.heldPath !== null).length });
    writeFileSync(join(folder.heldPath, 'stray.txt'), 'x');
    expect((await listHeld(s.roots)).at(0)).toMatchObject({ ok: true, otherEntries: 1 });
  });

  test('an impostor repo folder (different directory at the held path) is not held; its files are other entries', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000, { repos: [{ repoId: 'org/other', whole: true }] });
    const m = readM(s, id);
    const total = m.items.length + m.storeItems.filter((x) => x.heldPath !== null).length;
    const folder = m.items.find((i) => i.role === 'repo-folder')!;
    const aside = join(s.root, 'moved-aside');
    renameSync(folder.heldPath, aside);
    mkdirSync(folder.heldPath);
    writeFileSync(join(folder.heldPath, 'a.txt'), 'a');
    writeFileSync(join(folder.heldPath, 'b.txt'), 'b');
    const d = (await listHeld(s.roots)).at(0)!;
    expect(d).toMatchObject({ ok: true, heldCount: total - 1, otherEntries: 2 });
  });

  test('a folder holding only the manifest and empty directories holds nothing and is due at age 0', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const m = readM(s, id);
    const aside = join(s.root, 'aside');
    mkdirSync(aside);
    const paths = [...m.items.map((i) => i.heldPath), ...m.storeItems.flatMap((x) => (x.heldPath === null ? [] : [x.heldPath]))];
    paths.forEach((p, i) => renameSync(p, join(aside, String(i))));
    const d = (await listHeld(s.roots)).at(0)!;
    expect(d).toMatchObject({ ok: true, heldCount: 0, otherEntries: 0 });
    expect(autoEmptyDue([d], 1_000, 14)).toEqual([d]);
  });

  test('a read failure inside a deletion folder is reported as corrupt, not thrown', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const dir = join(s.roots.holdRoot!, id);
    const denied: ReadFs = { ...readFs, readdir: async (p) => {
      if (p === dir) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
      return readFs.readdir(p);
    } };
    expect((await listHeld(s.roots, denied)).at(0)).toEqual({ ok: false, deletionId: id, dir, error: 'EACCES: denied' });
  });

  test('a hold-root read failure other than ENOENT is thrown', async () => {
    const s = await buildHoldScenario();
    const denied: ReadFs = { ...readFs, readdir: async () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); } };
    await expect(listHeld(s.roots, denied)).rejects.toThrow('EACCES');
  });
});

describe('rereadHeld', () => {
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { expect(e).toBeInstanceOf(HeldError); return (e as HeldError).code; }
    return 'none';
  };

  test('re-reads and re-parses an unchanged deletion', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const d = (await listHeld(s.roots)).at(0)!;
    if (!d.ok) throw new Error('unreachable');
    const r = await rereadHeld(s.roots, id, d.manifestText);
    expect(r.dir).toBe(d.dir);
    expect(r.manifest).toEqual(d.manifest);
  });

  test('refuses bad ids, missing or linked folders, bad manifest files and unavailable roots', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const hr = s.roots.holdRoot!;
    const text = readFileSync(join(hr, id, MANIFEST_NAME), 'utf8');
    expect(await codeOf(rereadHeld(s.roots, '../x', text))).toBe('CORRUPT');
    expect(await codeOf(rereadHeld(s.roots, JUNK_ID, text))).toBe('NOT_FOUND');
    symlinkSync(join(hr, id), join(hr, JUNK_ID));
    expect(await codeOf(rereadHeld(s.roots, JUNK_ID, text))).toBe('NOT_FOUND');
    expect(await codeOf(rereadHeld({ ...s.roots, holdRoot: null }, id, text))).toBe('NO_HOLD_ROOT');
    expect(await codeOf(rereadHeld({ ...s.roots, hubRoot: join(s.root, 'other-hub') }, id, text))).toBe('HUB_MISMATCH');
    const empty = '2026-10-25T14-03-07-000Z-00000001';
    mkdirSync(join(hr, empty));
    expect(await codeOf(rereadHeld(s.roots, empty, text))).toBe('CORRUPT');
    mkdirSync(join(hr, empty, MANIFEST_NAME));
    expect(await codeOf(rereadHeld(s.roots, empty, text))).toBe('CORRUPT');
    const big = '2026-10-25T14-03-07-000Z-00000002';
    mkdirSync(join(hr, big));
    writeFileSync(join(hr, big, MANIFEST_NAME), '');
    truncateSync(join(hr, big, MANIFEST_NAME), MAX_MANIFEST_BYTES + 1);
    await expect(rereadHeld(s.roots, big, text)).rejects.toMatchObject({ code: 'CORRUPT', message: 'manifest too large' });
  });

  test('refuses a changed manifest as STALE_MANIFEST and an unparsable one as CORRUPT', async () => {
    const s = await buildHoldScenario();
    const id = await holdAt(s, 1_000);
    const mp = join(s.roots.holdRoot!, id, MANIFEST_NAME);
    const text = readFileSync(mp, 'utf8');
    await expect(rereadHeld(s.roots, id, text + ' ')).rejects.toMatchObject({
      code: 'STALE_MANIFEST', message: 'Recently Deleted changed — please review again.' });
    writeFileSync(mp, '{nope');
    expect(await codeOf(rereadHeld(s.roots, id, '{nope'))).toBe('CORRUPT');
  });
});
