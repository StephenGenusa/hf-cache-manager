import { mkdir, readFile, readdir, symlink, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { AUTO_EMPTY_DEFAULT_DAYS } from '../../src/core/hold/held';
import { SafeFs } from '../../src/core/safe-fs';
import { EMPTY_DOWNLOADS, type QueueItem } from '../../src/main/download/queue';
import { AppSettingsStore, type AppSettings, DEFAULT_ADVICE, DEFAULT_SETTINGS, diskInfoFrom, probeSymlinks, queueUnreadable } from '../../src/main/app-settings';
import { useCanaries } from '../helpers/canary';
import { failingFs } from '../helpers/failing-fs';
import { guardedFs } from '../helpers/guarded-fs';
import { makeTempRoot, removeTempRoot } from '../helpers/tmp';

useCanaries();
beforeEach(() => expect.hasAssertions());
const made: string[] = [];
afterEach(async () => { for (const d of made.splice(0)) await removeTempRoot(d); });
/** A `userdata` folder inside a fresh temp root (guardedFs wants the root strictly inside the temp dir). */
const makeTmp = async (_name: string): Promise<string> => {
  const root = await makeTempRoot('hfcm-t-');
  made.push(root);
  const d = join(root, 'userdata');
  await mkdir(d);
  return d;
};

const userSafe = (dir: string, fs = guardedFs()) => () => SafeFs.create({ hubRoot: dir, viewRoots: [], holdRoot: null }, fs);

test('the default is the spec 14 days, with Never available', () => {
  expect(DEFAULT_SETTINGS).toEqual({ autoEmptyDays: 14, advice: DEFAULT_ADVICE });
  expect(DEFAULT_SETTINGS.autoEmptyDays).toBe(AUTO_EMPTY_DEFAULT_DAYS);
});

test('missing or corrupt settings.json gives defaults; save round-trips atomically inside userData', async () => {
  const dir = await makeTmp('hfcm-settings-');
  const store = new AppSettingsStore(dir, { makeSafeFs: userSafe(dir) });
  expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  await store.save({ autoEmptyDays: null, advice: DEFAULT_ADVICE });
  expect(await store.load()).toEqual({ autoEmptyDays: null, advice: DEFAULT_ADVICE });
  expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toEqual({ autoEmptyDays: null, advice: DEFAULT_ADVICE });
  expect((await readdir(dir)).sort()).toEqual(['settings.json']);   // no temp file left
  await store.save({ autoEmptyDays: 30, advice: DEFAULT_ADVICE });
  expect(await store.load()).toEqual({ autoEmptyDays: 30, advice: DEFAULT_ADVICE });
  await writeFile(join(dir, 'settings.json'), '{"autoEmptyDays":7,"ackedJournalPlans":["x"]}');
  expect(await store.load()).toEqual({ autoEmptyDays: 7, advice: DEFAULT_ADVICE });
});

test('the store refuses to write outside userData', async () => {
  const dir = await makeTmp('hfcm-settings-');
  const other = await makeTmp('hfcm-settings-other-');
  await writeFile(join(other, 'target.json'), 'untouched');
  await symlink(join(other, 'target.json'), join(dir, 'settings.json'));
  const store = new AppSettingsStore(dir, { makeSafeFs: userSafe(dir) });
  await expect(store.save({ autoEmptyDays: 3, advice: DEFAULT_ADVICE })).rejects.toThrow();
  expect(await readFile(join(other, 'target.json'), 'utf8')).toBe('untouched');
  expect((await readdir(other)).sort()).toEqual(['target.json']);
  // the default SafeFs is rooted at userData too: it works on a plain folder
  const plain = await makeTmp('hfcm-settings-plain-');
  await new AppSettingsStore(plain).save({ autoEmptyDays: 5, advice: DEFAULT_ADVICE });
  expect(await readFile(join(plain, 'settings.json'), 'utf8')).toContain('5');
});

test('probeSymlinks creates, removes and leaves nothing behind', async () => {
  const dir = await makeTmp('hfcm-probe-');
  expect(await probeSymlinks(dir, { makeSafeFs: userSafe(dir) })).toEqual({ ok: true, detail: 'Symlinks available' });
  expect(await readdir(dir)).toEqual([]);
  expect(await probeSymlinks(dir)).toEqual({ ok: true, detail: 'Symlinks available' });
});

test('probeSymlinks failure: Windows copy, or the error code elsewhere; still cleans up', async () => {
  const dir = await makeTmp('hfcm-probe-');
  const noLink = (): ReturnType<typeof userSafe> => userSafe(dir, failingFs(guardedFs(), 'symlink', 'EPERM'));
  expect(await probeSymlinks(dir, { makeSafeFs: noLink(), platform: 'win32' })).toEqual({
    ok: false, detail: 'Symlinks need Developer Mode or administrator rights (Settings → For developers).' });
  expect(await probeSymlinks(dir, { makeSafeFs: noLink(), platform: 'linux' })).toEqual({ ok: false, detail: 'Symlink creation failed: EPERM' });
  expect(await readdir(dir)).toEqual([]);
  // a non-SafeFs error still reports a code, and an unknown one is UNKNOWN
  const boom = async (): Promise<SafeFs> => { throw new Error('no safe fs'); };
  expect(await probeSymlinks(dir, { makeSafeFs: boom, platform: 'linux' })).toEqual({ ok: false, detail: 'Symlink creation failed: UNKNOWN' });
});

test('probeSymlinks tolerates leftovers from a crashed probe', async () => {
  const dir = await makeTmp('hfcm-probe-');
  await mkdir(join(dir, '.symlink-probe'));
  await symlink('x', join(dir, '.symlink-probe', 'link'));
  const r = await probeSymlinks(dir, { makeSafeFs: userSafe(dir) });
  expect(r.ok).toBe(true);
  expect(await readdir(dir)).toEqual([]);
  await expect(lstat(join(dir, '.symlink-probe'))).rejects.toThrow();
});

test('diskInfoFrom', () => {
  expect(diskInfoFrom({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 }, '/data/models'))
    .toEqual({ pathDisplay: '/data/models', totalBytes: 4_096_000, freeBytes: 1_228_800, usedBytes: 2_457_600 });
});

test('an unreadable or invalid settings.json turns auto-empty off, reports why and is never rewritten', async () => {
  const dir = await makeTmp('hfcm-settings-');
  const file = join(dir, 'settings.json');
  expect(await new AppSettingsStore(dir, { makeSafeFs: userSafe(dir) }).loadChecked()).toEqual({ settings: DEFAULT_SETTINGS, error: null, adviceError: null, downloadsError: null });   // ENOENT
  for (const bad of ['{not json', '[]', 'null', '{"autoEmptyDays":"7"}', '{"autoEmptyDays":0}', '{"autoEmptyDays":2.5}', '{"autoEmptyDays":-1}', '{}', '']) {
    await writeFile(file, bad);
    const store = new AppSettingsStore(dir, { makeSafeFs: userSafe(dir) });
    const r = await store.loadChecked();
    expect(r.settings, bad).toEqual({ autoEmptyDays: null, advice: DEFAULT_ADVICE });
    expect(r.error, bad).toMatch(/./);
    expect(await store.load(), bad).toEqual({ autoEmptyDays: null, advice: DEFAULT_ADVICE });
    expect(await readFile(file, 'utf8'), bad).toBe(bad);
  }
  await writeFile(file, '{"autoEmptyDays":9}');
  const denied = new AppSettingsStore(dir, { fs: failingFs(guardedFs(), 'readFile', 'EACCES'), makeSafeFs: userSafe(dir) });
  const r = await denied.loadChecked();
  expect(r.settings).toEqual({ autoEmptyDays: null, advice: DEFAULT_ADVICE });
  expect(r.error).toMatch(/EACCES/);
  expect(await readFile(file, 'utf8')).toBe('{"autoEmptyDays":9}');
});

const FULL_ADVICE = { gpuBytes: 24e9, gpuKind: 'nvidia', ramBytes: 64e9, drivesDisplay: false, context: 65536, kvType: 'q8_0', tools: ['llama.cpp', 'ollama'] } as const;
const loadFrom = async (text: string) => {
  const dir = await makeTmp('hfcm-settings-');
  await writeFile(join(dir, 'settings.json'), text);
  return new AppSettingsStore(dir, { makeSafeFs: userSafe(dir) }).loadChecked();
};

test('a Phase 1 file without advice gets the advice defaults and no errors', async () => {
  expect(await loadFrom('{"autoEmptyDays":14}')).toEqual({ settings: { autoEmptyDays: 14, advice: DEFAULT_ADVICE }, error: null, adviceError: null, downloadsError: null });
});

test('a broken advice block keeps autoEmptyDays', async () => {
  const r = await loadFrom('{"autoEmptyDays":14,"advice":{"context":7}}');
  expect(r.settings).toEqual({ autoEmptyDays: 14, advice: DEFAULT_ADVICE });
  expect(r.error).toBeNull();
  expect(r.adviceError).toMatch(/advice/);
});

test('unknown keys, bad values and a non-object block give defaults for advice only', async () => {
  const ok = { ...FULL_ADVICE };
  const bads = [{ ...ok, extra: 1 }, { ...ok, gpuBytes: 5e8 }, { ...ok, gpuBytes: 2e13 }, { ...ok, ramBytes: 1.5e9 + 0.5 },
    { ...ok, gpuKind: 'amd' }, { ...ok, kvType: 'q4_0' }, { ...ok, tools: ['nope'] }, { ...ok, drivesDisplay: 'yes' }, [], null, 'x'];
  for (const advice of bads) {
    const r = await loadFrom(JSON.stringify({ autoEmptyDays: 7, advice }));
    expect(r.settings, JSON.stringify(advice)).toEqual({ autoEmptyDays: 7, advice: DEFAULT_ADVICE });
    expect(r.error).toBeNull();
    expect(r.adviceError, JSON.stringify(advice)).toMatch(/./);
  }
});

test('a bad autoEmptyDays still turns auto-empty off whatever the advice says', async () => {
  const r = await loadFrom(JSON.stringify({ autoEmptyDays: 0, advice: FULL_ADVICE }));
  expect(r.settings.autoEmptyDays).toBeNull();
  expect(r.error).toMatch(/./);
  expect(r.adviceError).toBeNull();
});

test('a full advice block round-trips and a save keeps both keys', async () => {
  const dir = await makeTmp('hfcm-settings-');
  const store = new AppSettingsStore(dir, { makeSafeFs: userSafe(dir) });
  const settings: AppSettings = { autoEmptyDays: 21, advice: { ...FULL_ADVICE, tools: ['llama.cpp', 'ollama'] } };
  await store.save(settings);
  expect(await store.loadChecked()).toEqual({ settings, error: null, adviceError: null, downloadsError: null });
  expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toEqual(settings);
});

test('byte bounds: 1e9 and 1e13 are accepted, one byte outside is rejected, auto-empty untouched', async () => {
  for (const key of ['gpuBytes', 'ramBytes'] as const) {
    for (const v of [1e9, 1e13]) {
      const r = await loadFrom(JSON.stringify({ autoEmptyDays: 7, advice: { ...FULL_ADVICE, [key]: v } }));
      expect(r.adviceError, `${key} ${v}`).toBeNull();
      expect(r.settings.advice[key]).toBe(v);
    }
    for (const v of [1e9 - 1, 1e13 + 1]) {
      const r = await loadFrom(JSON.stringify({ autoEmptyDays: 7, advice: { ...FULL_ADVICE, [key]: v } }));
      expect(r.settings, `${key} ${v}`).toEqual({ autoEmptyDays: 7, advice: DEFAULT_ADVICE });
      expect(r.error).toBeNull();
      expect(r.adviceError).toMatch(/./);
    }
  }
});

test('update() runs overlapping read-modify-writes one after another, each seeing the previous result', async () => {
  const dir = await makeTmp('hfcm-settings-');
  const store = new AppSettingsStore(dir, { makeSafeFs: userSafe(dir) });
  const advice = { ...DEFAULT_ADVICE, gpuBytes: 12e9 };
  const seen: Array<number | null> = [];
  const a = store.update((cur) => { seen.push(cur.settings.autoEmptyDays); return { ...cur.settings, advice }; });
  const b = store.update((cur) => { seen.push(cur.settings.autoEmptyDays); return { ...cur.settings, autoEmptyDays: null }; });
  const c = store.update((cur) => { seen.push(cur.settings.autoEmptyDays); expect(cur.settings.advice).toEqual(advice); return null; });
  expect(await c).toBeNull();
  expect(await a).toEqual({ autoEmptyDays: 14, advice });
  expect(await b).toEqual({ autoEmptyDays: null, advice });
  expect(seen).toEqual([14, 14, null]);
  expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toEqual({ autoEmptyDays: null, advice });
});

test('a failing update does not block the ones after it', async () => {
  const dir = await makeTmp('hfcm-settings-');
  const store = new AppSettingsStore(dir, { makeSafeFs: userSafe(dir) });
  const bad = store.update(() => { throw new Error('boom'); });
  const good = store.update((cur) => ({ ...cur.settings, autoEmptyDays: 3 }));
  await expect(bad).rejects.toThrow('boom');
  expect(await good).toEqual({ autoEmptyDays: 3, advice: DEFAULT_ADVICE });
});

const ITEM: QueueItem = {
  id: 'a1b2', repoId: 'org/name', type: 'model', revision: 'main', commit: 'c'.repeat(40), refAtStart: 'b'.repeat(40),
  files: [{ path: 'w/x.gguf', etag: 'e'.repeat(64), size: 10, lfs: true, state: 'paused', bytes: 4, error: null }],
  links: [{ path: 'config.json', etag: 'f'.repeat(40) }],
};

test('a downloads block round-trips, and saving keeps it next to the other keys', async () => {
  const dir = await makeTmp('hfcm-settings-');
  const store = new AppSettingsStore(dir, { makeSafeFs: userSafe(dir) });
  const settings: AppSettings = { autoEmptyDays: 9, advice: DEFAULT_ADVICE, downloads: { version: 1, items: [ITEM] } };
  await store.save(settings);
  expect(await store.loadChecked()).toEqual({ settings, error: null, adviceError: null, downloadsError: null });
  expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toEqual(settings);
  await store.update((cur) => ({ ...cur.settings, autoEmptyDays: 3 }));
  expect((await store.load()).downloads).toEqual({ version: 1, items: [ITEM] });
});

test('a bad downloads block is an empty queue with a reason; autoEmptyDays and advice untouched', async () => {
  const f = ITEM.files[0]!;
  const bads: unknown[] = [null, [], 'x', { version: 2, items: [] }, { version: 1 }, { version: 1, items: [], extra: 1 },
    { version: 1, items: [{ ...ITEM, files: [{ ...f, path: '../x' }] }] }, { version: 1, items: [{ ...ITEM, files: [{ ...f, etag: 'E'.repeat(64) }] }] },
    { version: 1, items: [{ ...ITEM, files: [{ ...f, lfs: false }] }] }, { version: 1, items: [{ ...ITEM, files: [{ ...f, bytes: 11 }] }] },
    { version: 1, items: [{ ...ITEM, files: [{ ...f, state: 'gone' }] }] }, { version: 1, items: [{ ...ITEM, revision: '../x' }] },
    { version: 1, items: [{ ...ITEM, commit: 'C'.repeat(40) }] }, { version: 1, items: [ITEM, ITEM] },
    { version: 1, items: [{ ...ITEM, files: [f, f] }] }, { version: 1, items: [{ ...ITEM, links: [{ path: f.path, etag: 'f'.repeat(40) }] }] },
    { version: 1, items: [{ ...ITEM, revision: 'd'.repeat(40) }] }, { version: 1, items: [{ ...ITEM, refAtStart: 'B'.repeat(40) }] },
    { version: 1, items: [{ ...ITEM, revision: 'c'.repeat(40), refAtStart: 'b'.repeat(40) }] }];
  for (const downloads of bads) {
    const r = await loadFrom(JSON.stringify({ autoEmptyDays: 7, advice: FULL_ADVICE, downloads }));
    expect(r.settings, JSON.stringify(downloads)).toEqual({ autoEmptyDays: 7, advice: FULL_ADVICE, downloads: EMPTY_DOWNLOADS });
    expect(r.error).toBeNull();
    expect(r.adviceError).toBeNull();
    expect(r.downloadsError, JSON.stringify(downloads)).toMatch(/^downloads ignored: /);
  }
});

test('a queue item saved before refAtStart existed still parses (its ref is "unknown")', async () => {
  const legacy: Partial<QueueItem> = { ...ITEM };
  delete legacy.refAtStart;
  const r = await loadFrom(JSON.stringify({ autoEmptyDays: 7, downloads: { version: 1, items: [legacy] } }));
  expect(r.downloadsError).toBeNull();
  expect(r.settings.downloads).toEqual({ version: 1, items: [legacy] });
  expect('refAtStart' in r.settings.downloads!.items[0]!).toBe(false);
});

test('valid JSON that is not an object makes the saved queue unreadable (fail closed)', async () => {
  for (const text of ['[]', '"x"', 'null', '5', 'true']) {
    const r = await loadFrom(text);
    expect(r.downloadsError, text).toBe('downloads ignored: settings.json is not a JSON object');
    expect(queueUnreadable(r), text).toBe('downloads ignored: settings.json is not a JSON object');
    expect(r.settings.downloads, text).toBeUndefined();
  }
  for (const text of ['{}', '{"autoEmptyDays":7}']) expect(queueUnreadable(await loadFrom(text)), text).toBeNull();
});
