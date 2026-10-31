import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { serializeState, STATE_FILE, type ViewState } from '../../../src/core/compat/state';
import { applyItemToState, planSync, plansNeverCreate, wantedPaths, type SyncItem, type Wanted } from '../../../src/core/sync/sync';
import { nodeFs } from '../../../src/core/fsx';
import { failingFs } from '../../helpers/failing-fs';
import { tempDir } from '../_temp';
import { MT } from '../../../src/core/views/registry';
import { useCanaries } from '../../helpers/canary';
import { treeDigest } from '../../helpers/tree-digest';
import { loadCase, sha256Hex, type CaseSpec } from '../views/_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const R = 'acme/Tiny-GGUF';
const K = `${R}:Tiny-Q4_K_M.gguf`;
const tiny: CaseSpec = { repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
  { path: 'Tiny-Q4_K_M.gguf', text: 'q4' }] }] }], views: ['lmstudio', 'ollama'] };
const state = (owned: ViewState['owned'] = {}, tombstones: ViewState['tombstones'] = {}): string =>
  serializeState({ version: 1, owned, tombstones });
const stateFile = (s: string): { [STATE_FILE]: string } => ({ [STATE_FILE]: s });

describe('planSync', () => {
  it('test_dry_run_plans_but_writes_nothing', async () => {
    const { c, model, config } = await loadCase(tiny);
    const before = [await treeDigest(c.lmstudio!), await treeDigest(c.ollama!), await treeDigest(c.hub)];
    const p = await planSync(config, model, { offline: true, now: 1 });
    expect(p.views.map((v) => [v.view, v.items.map((i) => [i.key, i.action])])).toEqual([
      ['lmstudio', [[K, 'create']]], ['ollama', [[K, 'create']]]]);
    expect(p.expiresAt).toBe(1 + 600_000);
    expect(p.hubMissing).toBe(false);
    expect(p.views[1]!.collisions).toEqual({});
    expect([await treeDigest(c.lmstudio!), await treeDigest(c.ollama!), await treeDigest(c.hub)]).toEqual(before);
  });

  it('test_absent_cache_dir_does_nothing', async () => {
    const { model, config } = await loadCase(tiny);
    const gone = path.join(await tempDir(), 'no-such-hub');
    const p = await planSync(config, { ...model, hubRoot: gone, repos: [] }, { offline: true, now: 1 });
    const reason = `hub not found or empty: ${gone}; nothing done`;
    expect(p.hubMissing).toBe(true);
    expect(p.views).toEqual([]);
    expect(p.skipped).toEqual([{ view: 'lmstudio', reason }, { view: 'ollama', reason }]);
  });

  it('planSync refuses when the hub has no repos', async () => {
    const { model, config } = await loadCase(tiny);
    const p = await planSync(config, { ...model, repos: [] }, { offline: true, now: 1 });
    expect(p.hubMissing).toBe(true);
    expect(p.views).toEqual([]);
    expect(p.skipped.map((x) => x.view)).toEqual(['lmstudio', 'ollama']);
    expect(p.skipped[0]!.reason).toBe(`hub not found or empty: ${model.hubRoot}; nothing done`);
  });

  it('overlapping view roots (equal or nested) skip both views', async () => {
    const { model, config, c } = await loadCase(tiny);
    const reason = 'LM Studio and Ollama folders overlap; fix config.toml';
    const nested = path.join(c.lmstudio!, 'ollama-inside');
    mkdirSync(nested);
    for (const ollama of [c.lmstudio!, nested]) {
      const cfg = { ...config, views: { ...config.views, ollama: { ...config.views.ollama, root: ollama } } };
      const before = await treeDigest(c.lmstudio!);
      const p = await planSync(cfg, model, { offline: true, now: 1 });
      expect(p.views).toEqual([]);
      expect(p.skipped).toEqual([{ view: 'lmstudio', reason }, { view: 'ollama', reason }]);
      expect(await treeDigest(c.lmstudio!)).toEqual(before);
    }
    // nested the other way round, through a symlink to the root
    const link = path.join(c.dir, 'lm-alias');
    symlinkSync(c.lmstudio!, link);
    const cfg = { ...config, views: { lmstudio: { ...config.views.lmstudio, root: nested }, ollama: { ...config.views.ollama, root: link } } };
    expect((await planSync(cfg, model, { offline: true, now: 1 })).skipped.map((s) => s.reason)).toEqual([reason, reason]);
  });

  it('test_missing_view_root_is_skipped_and_not_created', async () => {
    const { model, config } = await loadCase({ ...tiny, views: ['lmstudio'] });
    const p = await planSync(config, model, { offline: true, now: 1 });
    expect(p.views.map((v) => v.view)).toEqual(['lmstudio']);
    expect(p.skipped).toEqual([{ view: 'ollama', reason: `root does not exist: ${config.views.ollama.root}` }]);
    expect(existsSync(config.views.ollama.root!)).toBe(false);
  });

  it('unconfigured view is skipped with "not configured"; config.problem is reported', async () => {
    const { model, config } = await loadCase(tiny);
    const cfg = { ...config, views: { lmstudio: { root: null, aliases: {} },
      ollama: { root: null, aliases: {}, problem: 'root is not an absolute path: rel' } } };
    const p = await planSync(cfg, model, { offline: true, now: 1 });
    expect(p.skipped).toEqual([{ view: 'lmstudio', reason: 'not configured' },
      { view: 'ollama', reason: 'root is not an absolute path: rel' }]);
  });

  it('corrupt state -> view skipped "aborted: ...", other view still planned', async () => {
    const { c, model, config } = await loadCase({ ...tiny, viewFiles: { lmstudio: stateFile('{not json') } });
    const p = await planSync(config, model, { offline: true, now: 1 });
    expect(p.skipped).toHaveLength(1);
    expect(p.skipped[0]!.view).toBe('lmstudio');
    expect(p.skipped[0]!.reason).toMatch(/^aborted: .*unreadable state file/);
    expect(p.views.map((v) => v.view)).toEqual(['ollama']);
    expect(readFileSync(path.join(c.lmstudio!, STATE_FILE), 'utf8')).toBe('{not json');
  });

  it('a symlinked state file aborts that view (V19)', async () => {
    const lc = await loadCase(tiny);
    const real = path.join(lc.c.dir, 'elsewhere.json');
    writeFileSync(real, state());
    symlinkSync(real, path.join(lc.c.lmstudio!, STATE_FILE));
    const p = await planSync(lc.config, lc.model, { offline: true, now: 1 });
    expect(p.skipped[0]!.reason).toMatch(/^aborted: .*not a regular file/);
  });

  it('owned+correct -> noop; user-deleted primary -> tombstone; owned key gone from cache -> prune with removes', async () => {
    const hub = (b: string): string => `@HUB@/models--acme--Tiny-GGUF/blobs/${b}`;
    const gone = 'other/Gone:g.gguf';
    const lc = await loadCase({ ...tiny, views: ['lmstudio'], viewFiles: { lmstudio: {
      [`${R}/Tiny-Q4_K_M.gguf`]: { link: hub(sha256Hex('q4')) },
      'other/Gone/g.gguf': { link: '@HUB@/nowhere' },
      ...stateFile(state({
        [K]: { paths: [`${R}/Tiny-Q4_K_M.gguf`], sha256: sha256Hex('q4') },
        [gone]: { paths: ['other/Gone/g.gguf'], sha256: 'd'.repeat(64) },
      })) } } });
    let p = await planSync(lc.config, lc.model, { offline: true, now: 1 });
    let v = p.views[0]!;
    expect(v.items.map((i) => [i.key, i.action])).toEqual([[K, 'noop'], [gone, 'prune']]);
    expect(v.items[1]!.removes).toEqual(['other/Gone/g.gguf']);
    expect(v.massRemoval).toBe(false);
    expect(v.ownedCount).toBe(2);
    expect(v.counts).toEqual({ skip: 0, update: 0, foreign: 0, create: 0, noop: 1, tombstone: 0, adopt: 0, prune: 1 });
    expect(v.expect['other/Gone/g.gguf']).toMatchObject({ isSymlink: true });
    // user deletes the primary link
    const lc2 = await loadCase({ ...tiny, views: ['lmstudio'], viewFiles: { lmstudio: stateFile(state({
      [K]: { paths: [`${R}/Tiny-Q4_K_M.gguf`], sha256: sha256Hex('q4') } })) } });
    p = await planSync(lc2.config, lc2.model, { offline: true, now: 1 });
    v = p.views[0]!;
    expect(v.items.map((i) => [i.key, i.action, i.reason])).toEqual([[K, 'tombstone', 'deleted outside sync']]);
    expect(v.massRemoval).toBe(true);
  });

  it('prune shared-path protection simulates the live state after earlier prunes', async () => {
    const shared = 'x/shared.gguf';
    const lc = await loadCase({ ...tiny, views: ['lmstudio'], viewFiles: { lmstudio: {
      [shared]: { link: '@HUB@/nowhere' }, 'x/a.gguf': { link: '@HUB@/nowhere' },
      ...stateFile(state({
        'a/a:a.gguf': { paths: ['x/a.gguf', shared], sha256: '1'.repeat(64) },
        'b/b:b.gguf': { paths: [shared], sha256: '2'.repeat(64) },
        [K]: { paths: [`${R}/none.gguf`], sha256: sha256Hex('q4') },
      })) } } });
    const v = (await planSync(lc.config, lc.model, { offline: true, now: 1 })).views[0]!;
    const a = v.items.find((i) => i.key === 'a/a:a.gguf')!;
    const b = v.items.find((i) => i.key === 'b/b:b.gguf')!;
    expect(a.removes).toEqual(['x/a.gguf']);
    expect(a.keepsShared).toEqual([{ path: shared, owners: ['b/b:b.gguf'] }]);
    // a is pruned first, so by the time b is pruned nobody else owns the path
    expect(b.removes).toEqual([shared]);
    expect(b.keepsShared).toEqual([]);
  });

  it('test_all_entries_gone_from_cache_is_refused_without_the_flag (massRemoval flag)', async () => {
    const lc = await loadCase({ repos: [{ id: 'acme/Docs', main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'README.md', text: 'hi' }] }] }], views: ['lmstudio'], viewFiles: { lmstudio: stateFile(state({
      'z/Z:z.gguf': { paths: ['z/Z/z.gguf'], sha256: 'e'.repeat(64) } })) } });
    const p = await planSync(lc.config, lc.model, { offline: true, now: 1 });
    const v = p.views[0]!;
    expect(p.hubMissing).toBe(false);
    expect(v.items.map((i) => [i.key, i.action])).toEqual([['z/Z:z.gguf', 'prune']]);
    expect(v.massRemoval).toBe(true);
  });

  it('records expect facts for every owned and desired path (null when absent)', async () => {
    const lc = await loadCase({ ...tiny, views: ['lmstudio'], viewFiles: { lmstudio: {
      'acme/Old/x.gguf': { link: '@HUB@/nowhere' },
      ...stateFile(state({ 'acme/Old:x.gguf': { paths: ['acme/Old/x.gguf'], sha256: 'f'.repeat(64) } })) } } });
    const v = (await planSync(lc.config, lc.model, { offline: true, now: 1 })).views[0]!;
    expect(v.expect[`${R}/Tiny-Q4_K_M.gguf`]).toBeNull();
    expect(v.expect['acme/Old/x.gguf']).toMatchObject({ isSymlink: true });
    expect(Object.keys(v.expect).sort()).toEqual(['acme/Old/x.gguf', `${R}/Tiny-Q4_K_M.gguf`]);
    expect(v.root).toBe(realpathSync(lc.c.lmstudio!));
    expect(v.statePath).toBe(path.join(v.root, STATE_FILE));
  });

  it('warns about registry collisions and Ollama shards at plan time', async () => {
    const lc = await loadCase({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', text: 'q4' }, { path: 'sub/tiny-q4_k_m.gguf', text: 'q4b' },
      { path: 'Big-Q8_0-00001-of-00002.gguf', text: 's1' }] }] }], views: ['ollama'] });
    const v = (await planSync(lc.config, lc.model, { offline: true, now: 1 })).views[0]!;
    expect(v.warnings.some((w) => w.startsWith('[ollama] ') && w.includes('collides with'))).toBe(true);
    expect(v.warnings).toContain(`[ollama] ${R}:Big-Q8_0-00001-of-00002.gguf: sharded GGUF not supported by Ollama; skipped`);
    expect(Object.keys(v.collisions).length).toBe(2);
    for (const [k, msg] of Object.entries(v.collisions)) {
      expect(v.warnings).toContain(`[ollama] ${msg}`);
      expect(msg.startsWith(k)).toBe(true);
    }
  });

  it('reports foreign entries per view', async () => {
    const lc = await loadCase({ ...tiny, viewFiles: { lmstudio: { 'mine/user.gguf': { link: '/somewhere/else.gguf' } } } });
    const p = await planSync(lc.config, lc.model, { offline: true, now: 1 });
    const l = p.views.find((v) => v.view === 'lmstudio')!;
    expect(l.foreign.map((f) => f.path)).toEqual(['mine/user.gguf']);
    expect(p.views.find((v) => v.view === 'ollama')!.foreign).toEqual([]);
  });

  it('hub guard needs a directory: a regular file as hubRoot is hubMissing', async () => {
    const { model, config } = await loadCase(tiny);
    const f = path.join(await tempDir(), 'file');
    writeFileSync(f, 'x');
    const p = await planSync(config, { ...model, hubRoot: f }, { offline: false, now: 5 });
    expect(p.hubMissing).toBe(true);
    expect(p.offline).toBe(false);
    expect(p.createdAt).toBe(5);
  });

  it('unconfigured views are left out of skipped when the hub is missing', async () => {
    const { model, config } = await loadCase(tiny);
    const cfg = { ...config, views: { ...config.views, ollama: { root: null, aliases: {} } } };
    const p = await planSync(cfg, { ...model, repos: [] }, { offline: true, now: 1 });
    expect(p.skipped.map((x) => x.view)).toEqual(['lmstudio']);
  });

  it('an unexpected EACCES inside one view aborts only that view', async () => {
    const lc = await loadCase(tiny);
    const bad = lc.c.lmstudio!;
    const fs = failingFs(nodeFs, 'readdir', 'EACCES', (x) => x === realpathSync(bad));
    const p = await planSync(lc.config, lc.model, { offline: true, now: 1, fs });
    expect(p.views.map((v) => v.view)).toEqual(['ollama']);
    expect(p.skipped).toHaveLength(1);
    expect(p.skipped[0]).toMatchObject({ view: 'lmstudio' });
    expect(p.skipped[0]!.reason).toMatch(/^aborted: .*EACCES/);
  });

  it('plan.warnings carries every view warning; colliding keys show as skip with the reason', async () => {
    const lc = await loadCase({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', text: 'q4' }, { path: 'sub/tiny-q4_k_m.gguf', text: 'q4b' }] }] }], views: ['ollama'] });
    const p = await planSync(lc.config, lc.model, { offline: true, now: 1 });
    const v = p.views[0]!;
    expect(p.warnings).toEqual(v.warnings);
    expect(p.warnings.length).toBeGreaterThan(0);
    expect(v.items.map((i) => i.action)).toEqual(['skip', 'skip']);
    for (const i of v.items) expect(i.reason).toBe(v.collisions[i.key]);
    expect(v.counts.skip).toBe(2);
  });

  it('lmstudio stale update: removes lists the old path, owned becomes the created paths', async () => {
    const dangling = '@HUB@/models--acme--Tiny-GGUF/blobs/gone';
    const lc = await loadCase({ ...tiny, views: ['lmstudio'], viewFiles: { lmstudio: {
      [`${R}/Tiny-Q4_K_M.gguf`]: { link: dangling }, [`${R}/old.gguf`]: { link: dangling },
      ...stateFile(state({ [K]: { paths: [`${R}/Tiny-Q4_K_M.gguf`, `${R}/old.gguf`], sha256: 'a'.repeat(64) } })) } } });
    const v = (await planSync(lc.config, lc.model, { offline: true, now: 1 })).views[0]!;
    expect(v.items.map((i) => [i.key, i.action])).toEqual([[K, 'update']]);
    expect(v.items[0]!.removes).toEqual([`${R}/old.gguf`]);
    expect(v.items[0]!.conditional).toEqual([]);
    expect(Object.keys(v.expect).sort()).toEqual([`${R}/Tiny-Q4_K_M.gguf`, `${R}/old.gguf`]);
  });

  it('ollama update: expect covers manifest and blobs; stale blobs are removes and conditional', async () => {
    const q4 = sha256Hex('q4');
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const manifest = JSON.stringify({ schemaVersion: 2, layers: [{ mediaType: MT.model, digest: `sha256:${q4}` }] });
    const oldCfg = `blobs/sha256-${'c'.repeat(64)}`;
    const lc = await loadCase({ ...tiny, views: ['ollama'], aliases: { tiny: K }, viewFiles: { ollama: {
      [`blobs/sha256-${q4}`]: { link: '@HUB@/models--acme--Tiny-GGUF/blobs/gone' },
      [man]: manifest, [oldCfg]: 'cfg',
      ...stateFile(state({ [K]: { paths: [`blobs/sha256-${q4}`, man, oldCfg], sha256: q4 } })) } } });
    const v = (await planSync(lc.config, lc.model, { offline: true, now: 1 })).views[0]!;
    expect(v.items.map((i) => [i.key, i.action])).toEqual([[K, 'update']]);
    expect(v.items[0]!.removes).toEqual([oldCfg]);
    expect(v.items[0]!.conditional).toEqual([oldCfg]);
    expect(Object.keys(v.expect).sort()).toEqual([`blobs/sha256-${q4}`, man, oldCfg, 'manifests/registry.ollama.ai/library/tiny/latest'].sort());
    expect(v.expect[man]).toMatchObject({ isFile: true });
    expect(v.expect['manifests/registry.ollama.ai/library/tiny/latest']).toBeNull();
    expect(v.expect[`blobs/sha256-${q4}`]).toMatchObject({ isSymlink: true });
  });
});

describe('applyItemToState', () => {
  const st = (owned: Record<string, string[]>): ViewState => ({ version: 1, tombstones: {},
    owned: Object.fromEntries(Object.entries(owned).map(([k, paths]) => [k, { paths, sha256: 's' }])) });
  const d = (key: string, paths: string[]): NonNullable<SyncItem['desired']> =>
    ({ key, repoId: 'r', sha256: 'n', paths, links: [] });
  const item = (key: string, action: SyncItem['action'], extra: Partial<SyncItem> = {}): Pick<SyncItem, 'key' | 'action' | 'desired'> =>
    ({ key, action, ...extra });

  it('create unions the previous paths with the created paths and does not mutate the input', () => {
    const before = st({ a: ['p', 'q'] });
    const r = applyItemToState(before, item('a', 'create', { desired: d('a', ['q', 'z']) }));
    expect(r.state.owned['a']).toEqual({ paths: ['p', 'q', 'z'], sha256: 'n' });
    expect(r.removes).toEqual([]);
    expect(before.owned['a']!.paths).toEqual(['p', 'q']);
    const r2 = applyItemToState(before, item('a', 'create', { desired: d('a', ['q', 'z']) }), ['q', 'extra']);
    expect(r2.state.owned['a']!.paths).toEqual(['extra', 'p', 'q']);
  });

  it('adopt records only the link paths (CLI base.py:53-55,166): never a manifest or alias it did not write', () => {
    const desired = { ...d('a', ['m', 'x', 'y']), links: [{ path: 'y', target: '/t/y', primary: true }, { path: 'x', target: '/t/x', primary: false }] };
    const r = applyItemToState(st({}), item('a', 'adopt', { desired }));
    expect(r.state.owned['a']).toEqual({ paths: ['x', 'y'], sha256: 'n' });
  });

  it('create keeps old paths owned, so a later update of another key sees them as shared', () => {
    let s = st({ a: ['p'], b: ['p', 'old'] });
    s = applyItemToState(s, item('a', 'create', { desired: d('a', ['z']) })).state;
    const r = applyItemToState(s, item('b', 'update', { desired: d('b', ['new']) }));
    expect(r.removes).toEqual(['old']);
    expect(r.keepsShared).toEqual([{ path: 'p', owners: ['a'] }]);
    expect(r.state.owned['b']!.paths).toEqual(['new']);
  });

  it('prune and tombstone evaluate against the live state', () => {
    const s = st({ a: ['p', 'q'], b: ['q'] });
    const r = applyItemToState(s, item('a', 'prune'));
    expect(r.removes).toEqual(['p']);
    expect(r.keepsShared).toEqual([{ path: 'q', owners: ['b'] }]);
    expect(Object.keys(r.state.owned)).toEqual(['b']);
    const t = applyItemToState(s, item('b', 'tombstone'));
    expect(t.removes).toEqual([]);
    expect(Object.keys(t.state.tombstones)).toEqual(['b']);
    expect(Object.keys(t.state.owned)).toEqual(['a']);
  });

  it('prune and update never remove a path another item wants as it is; it is kept and handed to that key', () => {
    const s = st({ a: ['p', 'q', 'x'], b: ['r', 'old'] });       // every sha256 is 's'
    const w = (key: string, sha256: string, asIs: boolean): Wanted => ({ key, sha256, asIs });
    const wanted = new Map<string, Wanted>([
      ['p', w('n', 'zzz', true)],      // adopt/noop of other content: taken as it is
      ['q', w('b', 's', false)],       // create/update of the same content
      ['x', w('m', 'zzz', false)],     // create/update of other content: not protected (CLI: removed, rewritten)
      ['old', w('n', 'zzz', true)],
    ]);
    const r = applyItemToState(s, item('a', 'prune'), undefined, { wanted });
    expect(r.removes).toEqual(['x']);
    expect(r.keepsShared).toEqual([{ path: 'p', owners: ['n'] }, { path: 'q', owners: ['b'] }]);
    expect(r.state.owned['b']!.paths).toEqual(['old', 'q', 'r']);   // an owned wanting key takes the path now
    // a not-yet-owned adopt/noop key takes it now (an adopt owns only its links, so it could not take it in its own step)
    expect(r.state.owned['n']).toEqual({ paths: ['p'], sha256: 'zzz' });
    expect(r.state.owned['m']).toBeUndefined();                    // a not-yet-owned create/update key takes it in its own step
    const u = applyItemToState(s, item('b', 'update', { desired: d('b', ['r']) }), undefined, { wanted });
    expect(u.removes).toEqual([]);
    expect(u.keepsShared).toEqual([{ path: 'old', owners: ['n'] }]);
    // a path the item itself wants is not "wanted by another"
    const self = applyItemToState(st({ a: ['p'] }), item('a', 'prune'), undefined, { wanted: new Map([['p', w('a', 's', true)]]) });
    expect(self.removes).toEqual(['p']);
  });

  it('wantedPaths maps create/adopt/update/noop desired paths, first key wins; prune/skip/foreign/tombstone want nothing', () => {
    const items: Array<Pick<SyncItem, 'key' | 'action' | 'desired'>> = [
      { key: 'b', action: 'create', desired: d('b', ['p', 'q']) }, { key: 'a', action: 'noop', desired: d('a', ['p']) },
      { key: 'c', action: 'skip', desired: d('c', ['s']) }, { key: 'e', action: 'foreign', desired: d('e', ['f']) },
      { key: 't', action: 'tombstone', desired: d('t', ['t']) }, { key: 'u', action: 'update', desired: d('u', ['u']) },
      { key: 'v', action: 'adopt', desired: d('v', ['v']) }];
    expect([...wantedPaths(items)]).toEqual([
      ['p', { key: 'a', sha256: 'n', asIs: true }], ['q', { key: 'b', sha256: 'n', asIs: false }],
      ['u', { key: 'u', sha256: 'n', asIs: false }], ['v', { key: 'v', sha256: 'n', asIs: true }]]);
  });

  it('wantedPaths: an Ollama alias path is never taken "as it is" (presence checks only that it exists)', () => {
    const desired = { ...d('k', ['blobs/sha256-x', 'manifests/hf.co/r/T', 'manifests/registry.ollama.ai/library/m/q4']),
      ollama: { entry: {} as never, mmproj: null, tag: 'T', manifestPath: 'manifests/hf.co/r/T', aliasPaths: ['manifests/registry.ollama.ai/library/m/q4'] } };
    const w = wantedPaths([{ key: 'k', action: 'noop', desired }]);
    expect(w.get('blobs/sha256-x')).toEqual({ key: 'k', sha256: 'n', asIs: true });
    expect(w.get('manifests/hf.co/r/T')).toEqual({ key: 'k', sha256: 'n', asIs: true });
    expect(w.get('manifests/registry.ollama.ai/library/m/q4')).toEqual({ key: 'k', sha256: 'n', asIs: false });
  });

  it('conditional marks blobs/ removes only when asked', () => {
    const s = st({ a: ['blobs/sha256-1', 'manifests/m'] });
    expect(applyItemToState(s, item('a', 'prune'), undefined, { conditionalBlobs: true }).conditional).toEqual(['blobs/sha256-1']);
    expect(applyItemToState(s, item('a', 'prune')).conditional).toEqual([]);
  });
});

describe('planSync coverage closers', () => {
  it('a foreign item gets the driver\'s reason only when it has one (an LM Studio regular file has none)', async () => {
    const lc = await loadCase({ ...tiny, views: ['lmstudio'], viewFiles: { lmstudio: { [`${R}/Tiny-Q4_K_M.gguf`]: 'a file of the user' } } });
    const v = (await planSync(lc.config, lc.model, { offline: true, now: 1 })).views[0]!;
    expect(v.items.map((i) => [i.key, i.action, i.reason])).toEqual([[K, 'foreign', undefined]]);
  });

  it('a view whose state file cannot be examined (EPERM) is skipped; any other error is not swallowed', async () => {
    const lc = await loadCase(tiny);
    const bad = lc.c.lmstudio!;
    const eperm = await planSync(lc.config, lc.model, { offline: true, now: 1, fs: failingFs(nodeFs, 'realpath', 'EPERM', (x) => x === bad) });
    expect(eperm.views.map((v) => v.view)).toEqual(['ollama']);
    expect(eperm.skipped[0]!.reason).toMatch(/^aborted: .*EPERM/);
    await expect(planSync(lc.config, lc.model, { offline: true, now: 1, fs: failingFs(nodeFs, 'realpath', 'EIO', (x) => x === bad) }))
      .rejects.toThrow(/EIO/);
  });

  it('applyItemToState: an update of a key that is not owned just takes the desired paths', () => {
    const desired = { key: K, repoId: R, sha256: 'a'.repeat(64), paths: ['x/a.gguf'], links: [] };
    const step = applyItemToState({ version: 1, owned: {}, tombstones: {} }, { key: K, action: 'update', desired });
    expect(step.removes).toEqual([]);
    expect(step.state.owned).toEqual({ [K]: { paths: ['x/a.gguf'], sha256: 'a'.repeat(64) } });
  });

  it('the preview driver refuses to create anything', async () => {
    await expect(plansNeverCreate()).rejects.toThrow('plans never create');
  });
});
