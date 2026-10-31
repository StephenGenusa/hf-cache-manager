import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadState, serializeState, STATE_FILE, type ViewState } from '../../../src/core/compat/state';
import { AppLock } from '../../../src/core/exec/lock';
import type { FsLike } from '../../../src/core/fsx';
import { SafeFs } from '../../../src/core/safe-fs';
import { executeSync, planSync, type ExecuteSyncDeps, type SyncPlan } from '../../../src/core/sync/sync';
import { MT } from '../../../src/core/views/registry';
import { createViewImpactProvider } from '../../../src/core/views/impact';
import { scanHub } from '../../../src/core/scan/scanner';
import { useCanaries } from '../../helpers/canary';
import { failingFs } from '../../helpers/failing-fs';
import { guardedFs } from '../../helpers/guarded-fs';
import { treeDigest } from '../../helpers/tree-digest';
import { applyViewOps, doomRepo, fakeFetch, ggufBytes, loadCase, sha256Hex, type CaseSpec, type LoadedCase } from '../views/_case';

const canaries = useCanaries();
beforeEach(() => expect.hasAssertions());

const R = 'acme/Tiny-GGUF';
const FOLDER = 'models--acme--Tiny-GGUF';
const K = `${R}:Tiny-Q4_K_M.gguf`;
const q4 = sha256Hex('q4');
const NOW = new Date(2026, 9, 25, 14, 3, 7);
const tiny: CaseSpec = { repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
  { path: 'Tiny-Q4_K_M.gguf', text: 'q4' }] }] }], views: ['lmstudio', 'ollama'] };
const g7 = { arch: 'llama', fileType: 7, tensors: [[4, 4]] };
const g8 = { arch: 'llama', fileType: 8, tensors: [[4, 4]] };
const g15 = { arch: 'llama', fileType: 15, tensors: [[4, 4]] };
const stateText = (owned: ViewState['owned'] = {}, tombstones: ViewState['tombstones'] = {}): string =>
  serializeState({ version: 1, owned, tombstones });
const manifestOf = (model: string): string =>
  JSON.stringify({ schemaVersion: 2, layers: [{ mediaType: MT.model, digest: `sha256:${model}` }] });
const modelDigest = (file: string): unknown =>
  (JSON.parse(readFileSync(file, 'utf8')) as { layers: Array<{ mediaType: string; digest: string }> })
    .layers.find((l) => l.mediaType === MT.model)?.digest;

interface Setup extends LoadedCase {
  deps: ExecuteSyncDeps;
  lm: string;
  ol: string;
  lockDir: string;
  plan(offline?: boolean): Promise<SyncPlan>;
}

async function setup(spec: CaseSpec, over: Partial<ExecuteSyncDeps> = {}): Promise<Setup> {
  const lc = await loadCase(spec);
  const lockDir = path.join(lc.c.dir, 'app-lock');
  const deps: ExecuteSyncDeps = {
    safeFs: lc.safeFs, fs: lc.fs, fetch: fakeFetch(new Error('network disabled in tests')), allowMassRemoval: false,
    token: null, now: () => NOW, lock: new AppLock(lockDir), ...over,
  };
  const real = (p: string | null): string => (p !== null && existsSync(p) ? realpathSync(p) : '');
  return {
    ...lc, deps, lockDir, lm: real(lc.c.lmstudio), ol: real(lc.c.ollama),
    plan: (offline = true) => planSync(lc.config, lc.model, { offline, now: NOW.getTime() }),
  };
}

const read = (p: string): string => readFileSync(p, 'utf8');
const load = async (root: string): Promise<ViewState> => (await loadState(root)).state;

describe('executeSync', () => {
  it('applies creates and writes the state file byte-exactly', async () => {
    const s = await setup(tiny);
    const r = await executeSync(await s.plan(), s.deps);
    expect(r.views.map((v) => v.status)).toEqual(['applied', 'applied']);
    const lmState = read(path.join(s.lm, STATE_FILE));
    expect(lmState).toBe(serializeState({ version: 1, tombstones: {},
      owned: { [K]: { paths: [`${R}/Tiny-Q4_K_M.gguf`], sha256: q4 } } }));
    expect(lmState.endsWith('\n')).toBe(false);
    expect(readlinkSync(path.join(s.lm, R, 'Tiny-Q4_K_M.gguf'))).toBe(path.join(s.model.hubRoot, FOLDER, 'blobs', q4));
    expect(r.views[0]).toMatchObject({ view: 'lmstudio', applied: [{ key: K, action: 'create' }],
      createdPaths: [`${R}/Tiny-Q4_K_M.gguf`], removedPaths: [], skippedEntries: [] });
    // Ollama is offline with no registry cache: the entry is skipped and nothing is owned, but the state is saved (CLI).
    expect(r.views[1]!.skippedEntries).toEqual([{ key: K, reason: expect.stringMatching(/offline/) }]);
    expect(read(path.join(s.ol, STATE_FILE))).toBe(stateText());
    expect(r.planId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('second plan after execute is all noop (both views, online registry 404 -> synthesised manifest)', async () => {
    const s = await setup({ ...tiny, repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', gguf: g15 }] }] }] }, { fetch: fakeFetch({ status: 404 }) });
    const r = await executeSync(await s.plan(false), s.deps);
    expect(r.views.map((v) => [v.view, v.status, v.applied])).toEqual([
      ['lmstudio', 'applied', [{ key: K, action: 'create' }]], ['ollama', 'applied', [{ key: K, action: 'create' }]]]);
    const sha = sha256Hex(ggufBytes(g15));
    const man = path.join(s.ol, 'manifests', 'hf.co', R, 'Q4_K_M');
    expect(modelDigest(man)).toBe(`sha256:${sha}`);
    const olOwned = (await load(s.ol)).owned[K]!;
    expect(olOwned.sha256).toBe(sha);
    expect(olOwned.paths).toContain(`blobs/sha256-${sha}`);
    expect(olOwned.paths).toContain(`manifests/hf.co/${R}/Q4_K_M`);
    const before = [read(path.join(s.lm, STATE_FILE)), read(path.join(s.ol, STATE_FILE))];
    const p2 = await s.plan(false);
    expect(p2.views.map((v) => v.items.map((i) => i.action))).toEqual([['noop'], ['noop']]);
    const r2 = await executeSync(p2, s.deps);
    expect(r2.views.map((v) => [v.status, v.applied, v.removedPaths, v.createdPaths])).toEqual([
      ['applied', [], [], []], ['applied', [], [], []]]);
    expect([read(path.join(s.lm, STATE_FILE)), read(path.join(s.ol, STATE_FILE))]).toEqual(before);
  });

  it('test_user_deletion_is_tombstoned (local ISO seconds) and the link is not recreated', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] }, { allowMassRemoval: true });
    await executeSync(await s.plan(), s.deps);
    const link = path.join(s.lm, R, 'Tiny-Q4_K_M.gguf');
    unlinkSync(link);
    const r = await executeSync(await s.plan(), s.deps);
    expect(r.views[0]).toMatchObject({ status: 'applied', applied: [{ key: K, action: 'tombstone' }], removedPaths: [] });
    const state = await load(s.lm);
    expect(state.tombstones).toEqual({ [K]: '2026-10-25T14:03:07' });
    expect(state.owned).toEqual({});
    expect(existsSync(link)).toBe(false);
    const p3 = await s.plan();
    expect(p3.views[0]!.items.map((i) => [i.action, i.reason])).toEqual([['skip', 'tombstoned']]);
    await executeSync(p3, s.deps);
    expect(existsSync(link)).toBe(false);
  });

  it('prune removes owned paths except those another key owns; empty parents removed; root kept', async () => {
    const blob = `@HUB@/${FOLDER}/blobs/${q4}`;
    const s = await setup({ ...tiny, views: ['lmstudio'], viewFiles: { lmstudio: {
      [`${R}/Tiny-Q4_K_M.gguf`]: { link: blob },
      'x/shared.gguf': { link: '@HUB@/nowhere' },
      'old/deep/a.gguf': { link: '@HUB@/nowhere' },
      [STATE_FILE]: stateText({
        [K]: { paths: [`${R}/Tiny-Q4_K_M.gguf`, 'x/shared.gguf'], sha256: q4 },
        'gone/A:a.gguf': { paths: ['old/deep/a.gguf', 'x/shared.gguf'], sha256: 'a'.repeat(64) },
      }) } } });
    const plan = await s.plan();
    expect(plan.views[0]!.items.map((i) => [i.key, i.action])).toEqual([[K, 'noop'], ['gone/A:a.gguf', 'prune']]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]).toMatchObject({ status: 'applied', removedPaths: ['old/deep/a.gguf'],
      applied: [{ key: 'gone/A:a.gguf', action: 'prune' }] });
    expect(existsSync(path.join(s.lm, 'old'))).toBe(false);
    expect(lstatSync(path.join(s.lm, 'x', 'shared.gguf')).isSymbolicLink()).toBe(true);
    expect(lstatSync(s.lm).isDirectory()).toBe(true);
    expect(Object.keys((await load(s.lm)).owned)).toEqual([K]);
  });

  it('test_a_file_renamed_in_the_cache_takes_its_alias_along_in_one_sync (prunes run first)', async () => {
    const K1 = `${R}:M-Q4_K_M.gguf`;
    const K2 = `${R}:M-UD-Q4_K_M.gguf`;
    const KQ8 = `${R}:M-Q8_0.gguf`;
    const old = 'b'.repeat(64);
    const s8 = sha256Hex(ggufBytes(g8));
    const s7 = sha256Hex(ggufBytes(g7));
    const alias = 'manifests/registry.ollama.ai/library/m/q4';
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'M-UD-Q4_K_M.gguf', gguf: g7 }, { path: 'M-Q8_0.gguf', gguf: g8 }] }] }], views: ['ollama'],
    aliases: { 'm:q4': K2 }, viewFiles: { ollama: {
      [`blobs/sha256-${old}`]: { link: `@HUB@/${FOLDER}/blobs/${old}` },
      [`manifests/hf.co/${R}/Q4_K_M`]: manifestOf(old),
      [alias]: manifestOf(old),
      [`blobs/sha256-${s8}`]: { link: `@HUB@/${FOLDER}/blobs/${s8}` },
      [`manifests/hf.co/${R}/Q8_0`]: manifestOf(s8),
      [STATE_FILE]: stateText({
        [K1]: { paths: [`blobs/sha256-${old}`, alias, `manifests/hf.co/${R}/Q4_K_M`], sha256: old },
        [KQ8]: { paths: [`blobs/sha256-${s8}`, `manifests/hf.co/${R}/Q8_0`], sha256: s8 },
      }) } } }, { fetch: fakeFetch({ status: 404 }) });
    const plan = await s.plan(false);
    expect(plan.views[0]!.items.map((i) => [i.key, i.action])).toEqual([[K1, 'prune'], [KQ8, 'noop'], [K2, 'create']]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]!.status).toBe('applied');
    expect(r.views[0]!.applied).toEqual([{ key: K1, action: 'prune' }, { key: K2, action: 'create' }]);
    expect(modelDigest(path.join(s.ol, alias))).toBe(`sha256:${s7}`);
    expect(existsSync(path.join(s.ol, 'manifests', 'hf.co', R, 'Q4_K_M'))).toBe(false);
    const st = await load(s.ol);
    expect(Object.keys(st.owned)).toEqual([KQ8, K2]);
    expect(st.owned[K2]!.paths).toContain(alias);
    expect((await s.plan(false)).views[0]!.items.map((i) => i.action)).toEqual(['noop', 'noop']);
  });

  it('same-content move within the repo (LM Studio): the link is kept, handed to the new key, and the next sync is a no-op', async () => {
    const K1 = K;
    const K2 = `${R}:sub/Tiny-Q4_K_M.gguf`;
    const rel = `${R}/Tiny-Q4_K_M.gguf`;
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'sub/Tiny-Q4_K_M.gguf', text: 'q4' }] }] }], views: ['lmstudio'], viewFiles: { lmstudio: {
      [rel]: { link: `@HUB@/${FOLDER}/blobs/${q4}` },
      [STATE_FILE]: stateText({ [K1]: { paths: [rel], sha256: q4 } }) } } }, { allowMassRemoval: true });
    const link = path.join(s.lm, R, 'Tiny-Q4_K_M.gguf');
    const ino = lstatSync(link).ino;
    const plan = await s.plan();
    const v = plan.views[0]!;
    expect(v.items.map((i) => [i.key, i.action, i.removes])).toEqual([[K1, 'prune', []], [K2, 'adopt', []]]);
    expect(v.items[0]!.keepsShared).toEqual([{ path: rel, owners: [K2] }]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]).toMatchObject({ status: 'applied', removedPaths: [] });
    expect(lstatSync(link).ino).toBe(ino);
    expect((await load(s.lm)).owned).toEqual({ [K2]: { paths: [rel], sha256: q4 } });
    const p2 = await s.plan();
    expect(p2.views[0]!.items.map((i) => [i.key, i.action])).toEqual([[K2, 'noop']]);
    await executeSync(p2, s.deps);
    const st = await load(s.lm);
    expect(st.tombstones).toEqual({});
    expect(lstatSync(link).ino).toBe(ino);
  });

  it('same-content move within the repo (Ollama, same tag): blob link and manifest are kept and handed over', async () => {
    const sha = sha256Hex(ggufBytes(g15));
    const K1 = K;
    const K2 = `${R}:sub/Tiny-Q4_K_M.gguf`;
    const blob = `blobs/sha256-${sha}`;
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'sub/Tiny-Q4_K_M.gguf', gguf: g15 }] }] }], views: ['ollama'], viewFiles: { ollama: {
      [blob]: { link: `@HUB@/${FOLDER}/blobs/${sha}` }, [man]: manifestOf(sha),
      [STATE_FILE]: stateText({ [K1]: { paths: [blob, man], sha256: sha } }) } } }, { allowMassRemoval: true });
    const manIno = lstatSync(path.join(s.ol, man)).ino;
    const plan = await s.plan(true);
    const v = plan.views[0]!;
    expect(v.items.map((i) => [i.key, i.action, i.removes])).toEqual([[K1, 'prune', []], [K2, 'adopt', []]]);
    expect(v.items[0]!.keepsShared).toEqual([{ path: blob, owners: [K2] }, { path: man, owners: [K2] }]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]).toMatchObject({ status: 'applied', removedPaths: [] });
    expect(lstatSync(path.join(s.ol, blob)).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(s.ol, man)).ino).toBe(manIno);
    expect((await load(s.ol)).owned).toEqual({ [K2]: { paths: [blob, man], sha256: sha } });
    const p2 = await s.plan(true);
    expect(p2.views[0]!.items.map((i) => [i.key, i.action])).toEqual([[K2, 'noop']]);
    await executeSync(p2, s.deps);
    expect((await load(s.ol)).tombstones).toEqual({});
  });

  it('an alias retargeted to a noop key while its old key is pruned: removed (old digest), rewritten by the next sync', async () => {
    const sha = sha256Hex(ggufBytes(g15));
    const old = 'b'.repeat(64);
    const K1 = 'old/M-GGUF:M-Q4_K_M.gguf';
    const alias = 'manifests/registry.ollama.ai/library/m/q4';
    const blob = `blobs/sha256-${sha}`;
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const oldMan = 'manifests/hf.co/old/M-GGUF/Q4_K_M';
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', gguf: g15 }] }] }], views: ['ollama'], aliases: { 'm:q4': K }, viewFiles: { ollama: {
      [blob]: { link: `@HUB@/${FOLDER}/blobs/${sha}` }, [man]: manifestOf(sha),
      [`blobs/sha256-${old}`]: { link: '@HUB@/models--old--M-GGUF/blobs/gone' }, [oldMan]: manifestOf(old), [alias]: manifestOf(old),
      [STATE_FILE]: stateText({
        [K]: { paths: [blob, man], sha256: sha },
        [K1]: { paths: [`blobs/sha256-${old}`, alias, oldMan], sha256: old },
      }) } } }, { fetch: fakeFetch({ status: 404 }) });
    const plan = await s.plan(false);
    const v = plan.views[0]!;
    expect(v.items.map((i) => [i.key, i.action])).toEqual([[K, 'noop'], [K1, 'prune']]);
    expect(v.items[1]!.removes).toEqual([`blobs/sha256-${old}`, alias, oldMan]);
    expect(v.items[1]!.keepsShared).toEqual([]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]!.status).toBe('applied');
    expect(existsSync(path.join(s.ol, alias))).toBe(false);
    expect((await load(s.ol)).owned[K]).toEqual({ paths: [blob, man], sha256: sha });
    const p2 = await s.plan(false);
    expect(p2.views[0]!.items.map((i) => [i.key, i.action])).toEqual([[K, 'create']]);
    await executeSync(p2, s.deps);
    expect(modelDigest(path.join(s.ol, alias))).toBe(`sha256:${sha}`);
    expect((await load(s.ol)).owned[K]!.paths).toContain(alias);
  });

  it('a path handed to a create key whose create is then skipped is kept, and a warning says it is no longer owned', async () => {
    const sha = sha256Hex(ggufBytes(g15));
    const K2 = `${R}:sub/Tiny-Q4_K_M.gguf`;
    const blob = `blobs/sha256-${sha}`;
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'sub/Tiny-Q4_K_M.gguf', gguf: g15 }] }] }], views: ['ollama'], aliases: { tiny: K2 }, viewFiles: { ollama: {
      [blob]: { link: `@HUB@/${FOLDER}/blobs/${sha}` }, [man]: manifestOf(sha),
      [STATE_FILE]: stateText({ [K]: { paths: [blob, man], sha256: sha } }) } } }, { allowMassRemoval: true });
    const plan = await s.plan(true);
    expect(plan.views[0]!.items.map((i) => [i.key, i.action, i.removes])).toEqual([[K, 'prune', []], [K2, 'create', []]]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]!.skippedEntries).toEqual([{ key: K2, reason: expect.stringMatching(/offline/) }]);
    expect(r.views[0]!.warnings).toEqual(expect.arrayContaining([
      `${blob}: kept but no longer owned; next sync will re-check`, `${man}: kept but no longer owned; next sync will re-check`]));
    expect(lstatSync(path.join(s.ol, blob)).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(s.ol, man))).toBe(true);
    expect((await load(s.ol)).owned).toEqual({});
  });

  it('applies the state read at revalidation, not the plan copy (a plan whose state was altered cannot drop ownership)', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    await executeSync(await s.plan(), s.deps);
    const plan = await s.plan();
    const forged = { ...plan, views: [{ ...plan.views[0]!, state: { version: 1 as const, owned: {}, tombstones: {} } }] };
    const r = await executeSync(forged, s.deps);
    expect(r.views[0]!.status).toBe('applied');
    expect(Object.keys((await load(s.lm)).owned)).toEqual([K]);
  });

  it('test_all_entries_gone_from_disk_is_refused_without_the_flag', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    await executeSync(await s.plan(), s.deps);
    unlinkSync(path.join(s.lm, R, 'Tiny-Q4_K_M.gguf'));
    const statePath = path.join(s.lm, STATE_FILE);
    const stateBefore = read(statePath);
    const plan = await s.plan();
    const r = await executeSync(plan, { ...s.deps, allowMassRemoval: false });
    expect(r.views[0]).toMatchObject({ status: 'refused-mass-removal',
      message: '[lmstudio] refused: plan would remove every owned entry (1); confirm "allow mass removal" if this is intended' });
    expect(read(statePath)).toBe(stateBefore);
    const r2 = await executeSync(plan, { ...s.deps, allowMassRemoval: true });
    expect(r2.views[0]!.status).toBe('applied');
    expect(Object.keys((await load(s.lm)).tombstones)).toEqual([K]);
  });

  it('executeSync reports stale when an owned link changed after planning', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    await executeSync(await s.plan(), s.deps);
    const statePath = path.join(s.lm, STATE_FILE);
    const stateBefore = read(statePath);
    const ownedLink = path.join(s.lm, R, 'Tiny-Q4_K_M.gguf');
    const plan = await s.plan();
    unlinkSync(ownedLink);
    symlinkSync('/elsewhere', ownedLink);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]).toMatchObject({ status: 'stale',
      message: '[lmstudio] the view changed since the preview — preview again', applied: [] });
    expect(readlinkSync(ownedLink)).toBe('/elsewhere');
    expect(read(statePath)).toBe(stateBefore);
  });

  it('stale when an owned Ollama manifest or alias was rewritten after planning, or a file appeared at a desired-absent path', async () => {
    const sha = sha256Hex(ggufBytes(g15));
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const alias = 'manifests/registry.ollama.ai/library/tiny/latest';
    const blob = `blobs/sha256-${sha}`;
    const spec: CaseSpec = { repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', gguf: g15 }] }] }], views: ['ollama', 'lmstudio'], aliases: { tiny: K }, viewFiles: { ollama: {
      [blob]: { link: `@HUB@/${FOLDER}/blobs/${sha}` }, [man]: manifestOf(sha), [alias]: manifestOf(sha),
      [STATE_FILE]: stateText({ [K]: { paths: [blob, alias, man], sha256: sha } }) } } };
    for (const rel of [man, alias]) {
      const s = await setup(spec, { fetch: fakeFetch({ status: 404 }) });
      const plan = await s.plan(false);
      const before = await treeDigest(s.ol);
      writeFileSync(path.join(s.ol, rel), manifestOf('f'.repeat(64)));   // Ollama rewrote it
      const after = await treeDigest(s.ol);
      const r = await executeSync(plan, s.deps);
      expect(r.views.find((x) => x.view === 'ollama')!.status).toBe('stale');
      expect(await treeDigest(s.ol)).toEqual(after);
      expect(after).not.toEqual(before);
    }
    // LM Studio: the plan expects the create path to be absent; the user puts a file there
    const s = await setup(spec, { fetch: fakeFetch({ status: 404 }) });
    const plan = await s.plan(false);
    const lmPlan = plan.views.find((x) => x.view === 'lmstudio')!;
    expect(lmPlan.expect[`${R}/Tiny-Q4_K_M.gguf`]).toBeNull();
    mkdirSync(path.join(s.lm, R), { recursive: true });
    writeFileSync(path.join(s.lm, R, 'Tiny-Q4_K_M.gguf'), 'the user\'s own copy');
    const r = await executeSync(plan, s.deps);
    expect(r.views.find((x) => x.view === 'lmstudio')!.status).toBe('stale');
    expect(read(path.join(s.lm, R, 'Tiny-Q4_K_M.gguf'))).toBe('the user\'s own copy');
    expect(existsSync(path.join(s.lm, STATE_FILE))).toBe(false);
  });

  it('stale when the state file changed after planning (e.g. a CLI sync ran)', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    const plan = await s.plan();
    const statePath = path.join(s.lm, STATE_FILE);
    const cli = stateText({}, { [K]: '2026-01-01T00:00:00' });
    writeFileSync(statePath, cli);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]!.status).toBe('stale');
    expect(read(statePath)).toBe(cli);
    expect(existsSync(path.join(s.lm, R))).toBe(false);
  });

  it('stale when the view root was replaced after planning; a missing root is never created', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    const plan = await s.plan();
    const moved = `${s.lm}-moved`;
    renameSync(s.lm, moved);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]!.status).toBe('stale');
    expect(existsSync(s.lm)).toBe(false);
    symlinkSync(moved, s.lm);   // same contents, reached through a link: still not the previewed root
    expect((await executeSync(plan, s.deps)).views[0]!.status).toBe('stale');
    expect(existsSync(path.join(moved, STATE_FILE))).toBe(false);
    unlinkSync(s.lm);
    renameSync(moved, s.lm);
    // a plan whose state path is not <root>/.hfhub-state.json is refused
    const v = plan.views[0]!;
    const forged = { ...plan, views: [{ ...v, statePath: path.join(s.c.dir, 'elsewhere.json') }] };
    expect((await executeSync(forged, s.deps)).views[0]!.status).toBe('stale');
    expect(existsSync(path.join(s.c.dir, 'elsewhere.json'))).toBe(false);
  });

  it('V12: an expired plan is refused as stale and nothing is written', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    const plan = await planSync(s.config, s.model, { offline: true, now: NOW.getTime() - 10 * 60_000 - 1 });
    const r = await executeSync(plan, s.deps);
    expect(r.views).toEqual([expect.objectContaining({ view: 'lmstudio', status: 'stale',
      message: '[lmstudio] preview expired — preview again' })]);
    expect(existsSync(path.join(s.lm, STATE_FILE))).toBe(false);
    expect(existsSync(path.join(s.lm, R))).toBe(false);
  });

  it('V11: takes the AppLock; when another operation holds it every view is skipped and nothing is written', async () => {
    const s = await setup(tiny);
    // A live holder as the default isPidAlive sees it: our parent process.
    const other = new AppLock(s.lockDir, { pid: process.ppid });
    await other.acquire(NOW.getTime());
    const r = await executeSync(await s.plan(), s.deps);
    expect(r.views.map((v) => [v.view, v.status, v.message])).toEqual([
      ['lmstudio', 'skipped', '[lmstudio] another operation is running'],
      ['ollama', 'skipped', '[ollama] another operation is running']]);
    expect(existsSync(path.join(s.lm, STATE_FILE))).toBe(false);
    expect(existsSync(path.join(s.lm, R))).toBe(false);
    await other.release();
    // released after a successful run: a second instance can take it straight away
    await executeSync(await s.plan(), s.deps);
    const third = new AppLock(s.lockDir, { pid: process.ppid });
    await expect(third.acquire(NOW.getTime())).resolves.toBeUndefined();
    await third.release();
  });

  it('V11: a lock that cannot be taken skips every view; a release failure is reported as a warning, not thrown', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    class BrokenAcquire extends AppLock {
      override async acquire(): Promise<void> { throw new Error('disk on fire'); }
    }
    const r = await executeSync(await s.plan(), { ...s.deps, lock: new BrokenAcquire(s.lockDir) });
    expect(r.views.map((v) => [v.status, v.message])).toEqual([['skipped', '[lmstudio] the app lock could not be taken: disk on fire']]);
    expect(existsSync(path.join(s.lm, STATE_FILE))).toBe(false);
    class BrokenRelease extends AppLock {
      override async release(): Promise<void> { await super.release(); throw new Error('cannot unlink'); }
    }
    const r2 = await executeSync(await s.plan(), { ...s.deps, lock: new BrokenRelease(s.lockDir) });
    expect(r2.views[0]!.status).toBe('applied');
    expect(r2.views[0]!.warnings).toContain('the app lock could not be released: cannot unlink');
    expect(existsSync(path.join(s.lm, STATE_FILE))).toBe(true);
  });

  it('the hub re-check needs at least one repo folder (lost+found only, or missing, skips every view)', async () => {
    const s = await setup(tiny);
    const plan = await s.plan();
    const empty = path.join(s.c.dir, 'mnt');
    mkdirSync(path.join(empty, 'lost+found'), { recursive: true });
    writeFileSync(path.join(empty, 'notes.txt'), 'x');
    for (const hubRoot of [empty, path.join(s.c.dir, 'no-such-hub'), path.join(empty, 'notes.txt')]) {
      const r = await executeSync({ ...plan, hubRoot }, s.deps);
      expect(r.views.map((v) => [v.view, v.status, v.message])).toEqual([
        ['lmstudio', 'skipped', 'hub not found or has no repos'], ['ollama', 'skipped', 'hub not found or has no repos']]);
    }
    expect(existsSync(path.join(s.lm, STATE_FILE))).toBe(false);
    expect(existsSync(path.join(s.ol, STATE_FILE))).toBe(false);
  });

  it('executeSync saves state for completed items when one item fails', async () => {
    const q5 = sha256Hex('q5');
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', text: 'q4' }, { path: 'Tiny-Q5_K_M.gguf', text: 'q5' }, { path: 'Tiny-Q8_0.gguf', text: 'q8' }] }] }],
    views: ['lmstudio', 'ollama'] });
    // V24: inject the failure instead of chmod; SafeFs.symlink passes the link TEXT (the hub blob) first.
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots, failingFs(guardedFs(), 'symlink', 'EACCES', (p) => p.endsWith(q5))) };
    const firstKey = K;
    const r = await executeSync(await s.plan(), deps);
    expect(r.views[0]!.status).toBe('aborted');
    expect(r.views[0]!.message).toMatch(/^\[lmstudio\] aborted: .*EACCES/);
    expect(r.views[0]!.applied).toEqual([{ key: firstKey, action: 'create' }]);
    const loadedState = await load(s.lm);
    expect(Object.keys(loadedState.owned)).toEqual([firstKey]);
    expect(existsSync(path.join(s.lm, R, 'Tiny-Q5_K_M.gguf'))).toBe(false);
    expect(existsSync(path.join(s.lm, R, 'Tiny-Q8_0.gguf'))).toBe(false);
    expect(r.views[0]!.warnings).toContain(`${R}:Tiny-Q8_0.gguf: create not applied`);
    // one view's failure does not stop the next
    expect(r.views[1]!.status).toBe('applied');
  });

  it('CreateIncomplete: the written paths are owned (union with the previous ones), the item is reported, the run continues', async () => {
    const sha = sha256Hex(ggufBytes(g15));
    const zsha = sha256Hex(ggufBytes(g8));
    const ZK = 'zeta/Z-GGUF:Z-Q8_0.gguf';
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const extra = `blobs/sha256-${'d'.repeat(64)}`;
    const s = await setup({ repos: [
      { id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [{ path: 'Tiny-Q4_K_M.gguf', gguf: g15 }] }] },
      { id: 'zeta/Z-GGUF', main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [{ path: 'Z-Q8_0.gguf', gguf: g8 }] }] }],
    views: ['ollama'], aliases: { tiny: K }, viewFiles: { ollama: {
      [`blobs/sha256-${sha}`]: { link: `@HUB@/${FOLDER}/blobs/${sha}` }, [man]: manifestOf(sha), [extra]: 'x',
      [STATE_FILE]: stateText({ [K]: { paths: [`blobs/sha256-${sha}`, extra, man], sha256: sha } }) } } },
    { fetch: fakeFetch({ status: 404 }) });
    // The alias is the last write of K's create: its temp file write fails after the config blob and manifest were written.
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots,
      failingFs(guardedFs(), 'writeFile', 'EIO', (p) => p.includes('/library/tiny/latest.'))) };
    const plan = await s.plan(false);
    expect(plan.views[0]!.items.map((i) => [i.key, i.action])).toEqual([[K, 'create'], [ZK, 'create']]);
    const r = await executeSync(plan, deps);
    const v = r.views[0]!;
    expect(v.status).toBe('applied');
    expect(v.skippedEntries).toEqual([{ key: K, reason: expect.stringMatching(/^failed after a partial write: .*EIO.*2 path\(s\) were already written/), partialWrite: true }]);
    expect(v.applied).toEqual([{ key: ZK, action: 'create' }]);
    const st = await load(s.ol);
    const cfg = st.owned[K]!.paths.find((p) => p.startsWith('blobs/') && p !== extra && p !== `blobs/sha256-${sha}`)!;
    expect(st.owned[K]).toEqual({ paths: [`blobs/sha256-${sha}`, extra, cfg, man].sort(), sha256: sha });
    expect(existsSync(path.join(s.ol, cfg))).toBe(true);
    expect(st.owned[ZK]!.sha256).toBe(zsha);
    expect(v.createdPaths).toEqual(expect.arrayContaining([cfg, man, `blobs/sha256-${zsha}`]));
  });

  it('update whose old-path removal fails: aborted, and both the created and the old paths stay owned', async () => {
    const mm = `${R}/mmproj-F16.gguf`;
    const primary = `${R}/Tiny-Q4_K_M.gguf`;
    const old = `${R}/old.gguf`;
    const dangling = `@HUB@/${FOLDER}/blobs/gone`;
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', text: 'q4' }, { path: 'mmproj-F16.gguf', text: 'mm' }] }] }], views: ['lmstudio'],
    viewFiles: { lmstudio: { [primary]: { link: dangling }, [old]: { link: dangling },
      [STATE_FILE]: stateText({ [K]: { paths: [primary, old], sha256: q4 } }) } } });
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots,
      failingFs(guardedFs(), 'unlink', 'EIO', (p) => p.endsWith('/old.gguf'))) };
    const plan = await s.plan();
    expect(plan.views[0]!.items.map((i) => [i.action, i.removes])).toEqual([['update', [old]]]);
    const r = await executeSync(plan, deps);
    expect(r.views[0]!.status).toBe('aborted');
    expect(r.views[0]!.message).toMatch(/^\[lmstudio\] aborted: .*EIO/);
    expect(lstatSync(path.join(s.lm, mm)).isSymbolicLink()).toBe(true);
    expect((await load(s.lm)).owned[K]).toEqual({ paths: [mm, primary, old].sort(), sha256: q4 });
  });

  it('test_apply_skip_on_create_failure_leaves_state_clean (SkipEntry -> skip, key not owned)', async () => {
    const s = await setup({ ...tiny, views: ['ollama'] });
    const r = await executeSync(await s.plan(true), s.deps);
    expect(r.views[0]!.status).toBe('applied');
    expect(r.views[0]!.skippedEntries).toEqual([{ key: K, reason: expect.stringMatching(/offline/) }]);
    expect(r.views[0]!.applied).toEqual([]);
    expect((await load(s.ol)).owned).toEqual({});
    expect(existsSync(path.join(s.ol, 'manifests'))).toBe(false);
    expect(existsSync(path.join(s.ol, 'blobs'))).toBe(false);
  });

  it('hubMissing plan does nothing', async () => {
    const s = await setup(tiny);
    const missingPlan = await planSync(s.config, { ...s.model, repos: [] }, { offline: true, now: NOW.getTime() });
    expect(missingPlan.hubMissing).toBe(true);
    const before = [await treeDigest(s.lm), await treeDigest(s.ol)];
    expect((await executeSync(missingPlan, s.deps)).views).toEqual([]);
    expect([await treeDigest(s.lm), await treeDigest(s.ol)]).toEqual(before);
    expect(existsSync(s.lockDir)).toBe(false);
  });

  it('never writes outside the view roots (canaries) and never creates a missing root', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] }, { fetch: fakeFetch({ status: 404 }) });
    const ollamaRoot = s.config.views.ollama.root!;
    expect(existsSync(ollamaRoot)).toBe(false);
    await canaries.plant(path.join(s.c.dir, 'beside-views.txt'), 'next to the view roots\n');
    await canaries.plant(path.join(s.c.dir, 'nested', 'beside.gguf'), 'gguf-looking canary\n');
    await canaries.plant(path.join(s.model.hubRoot, 'stray-in-hub.txt'), 'in the hub\n');
    const link = path.join(s.c.dir, 'canary-link.gguf');
    symlinkSync(path.join(s.model.hubRoot, FOLDER, 'blobs', q4), link);
    await canaries.protect([link]);
    const hubBefore = await treeDigest(s.model.hubRoot);
    const r = await executeSync(await s.plan(false), s.deps);
    expect(r.views.map((v) => [v.view, v.status])).toEqual([['lmstudio', 'applied']]);
    expect(await canaries.verify()).toEqual([]);
    expect(await treeDigest(s.model.hubRoot)).toEqual(hubBefore);
    expect(existsSync(ollamaRoot)).toBe(false);
  });

  it('ollama update: create re-links the blob and rewrites manifest and alias in place', async () => {
    const sha = sha256Hex(ggufBytes(g15));
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const alias = 'manifests/registry.ollama.ai/library/tiny/latest';
    const oldCfg = `blobs/sha256-${'c'.repeat(64)}`;
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', gguf: g15 }] }] }], views: ['ollama'], aliases: { tiny: K }, viewFiles: { ollama: {
      [`blobs/sha256-${sha}`]: { link: `@HUB@/${FOLDER}/blobs/gone` },
      [man]: manifestOf(sha), [alias]: manifestOf(sha), [oldCfg]: 'cfg',
      [STATE_FILE]: stateText({ [K]: { paths: [`blobs/sha256-${sha}`, oldCfg, alias, man], sha256: sha } }) } } },
    { fetch: fakeFetch({ status: 404 }) });
    const plan = await s.plan(false);
    expect(plan.views[0]!.items.map((i) => [i.action, i.removes])).toEqual([['update', [oldCfg]]]);
    const r = await executeSync(plan, s.deps);
    const v = r.views[0]!;
    expect(v.status).toBe('applied');
    expect(v.skippedEntries).toEqual([]);
    expect(v.applied).toEqual([{ key: K, action: 'update' }]);
    expect(v.removedPaths).toEqual([oldCfg]);
    expect(existsSync(path.join(s.ol, oldCfg))).toBe(false);
    expect(readlinkSync(path.join(s.ol, 'blobs', `sha256-${sha}`))).toBe(path.join(s.model.hubRoot, FOLDER, 'blobs', sha));
    expect(read(path.join(s.ol, alias))).toBe(read(path.join(s.ol, man)));
    expect(read(path.join(s.ol, man))).not.toBe(manifestOf(sha));
    const st = await load(s.ol);
    expect(st.owned[K]!.paths).toContain(alias);
    expect(st.owned[K]!.paths).not.toContain(oldCfg);
    expect((await s.plan(false)).views[0]!.items.map((i) => i.action)).toEqual(['noop']);
  });

  it('ollama update: an alias create refuses (another model) is never passed to remove and stays owned', async () => {
    const sha = sha256Hex(ggufBytes(g15));
    const other = 'e'.repeat(64);
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const alias = 'manifests/registry.ollama.ai/library/tiny/latest';
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', gguf: g15 }] }] }], views: ['ollama'], aliases: { tiny: K }, viewFiles: { ollama: {
      [`blobs/sha256-${sha}`]: { link: `@HUB@/${FOLDER}/blobs/gone` },
      [man]: manifestOf(sha), [alias]: manifestOf(other),
      [STATE_FILE]: stateText({ [K]: { paths: [`blobs/sha256-${sha}`, alias, man], sha256: sha } }) } } },
    { fetch: fakeFetch({ status: 404 }) });
    const plan = await s.plan(false);
    expect(plan.views[0]!.items.map((i) => [i.action, i.removes])).toEqual([['update', []]]);
    const r = await executeSync(plan, s.deps);
    const v = r.views[0]!;
    expect(v.status).toBe('applied');
    expect(v.removedPaths).toEqual([]);
    expect(v.warnings).toContain(`${K}: alias ${alias} exists and belongs to another model; not overwritten`);
    expect(v.warnings).toContain(`${alias}: not in the previewed removals; kept and still owned`);
    expect(v.warnings.some((w) => w.includes('manifest changed by Ollama'))).toBe(false);
    expect(read(path.join(s.ol, alias))).toBe(manifestOf(other));
    expect((await load(s.ol)).owned[K]!.paths).toContain(alias);
  });

  it('V37: the final state save passes expect; a state file changed during sync aborts and lists what is not recorded', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    const statePath = path.join(s.lm, STATE_FILE);
    const intruder = stateText({}, { 'x/y:z.gguf': '2026-01-01T00:00:00' });
    const base = guardedFs();
    const sneaky: FsLike = { ...base, symlink: async (t, p, type) => {
      writeFileSync(statePath, intruder);
      await base.symlink(t, p, type);
    } };
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots, sneaky) };
    const r = await executeSync(await s.plan(), deps);
    expect(r.views[0]!.status).toBe('aborted');
    expect(r.views[0]!.message).toBe(`[lmstudio] aborted: the state file changed during sync; not recorded: ${R}/Tiny-Q4_K_M.gguf`);
    expect(read(statePath)).toBe(intruder);
  });

  it('a state save that fails with an I/O error aborts the view and names what is not recorded', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots,
      failingFs(guardedFs(), 'writeFile', 'ENOSPC', (p) => p.includes(`${STATE_FILE}.`))) };
    const r = await executeSync(await s.plan(), deps);
    expect(r.views[0]!.status).toBe('aborted');
    expect(r.views[0]!.message).toMatch(/^\[lmstudio\] aborted: the state file could not be saved \(.*ENOSPC.*\); not recorded: acme\/Tiny-GGUF\/Tiny-Q4_K_M\.gguf$/);
    expect(existsSync(path.join(s.lm, STATE_FILE))).toBe(false);
  });

  it('adopt records a correct link the user made, without touching it', async () => {
    const blob = `@HUB@/${FOLDER}/blobs/${q4}`;
    const s = await setup({ ...tiny, views: ['lmstudio'], viewFiles: { lmstudio: { [`${R}/Tiny-Q4_K_M.gguf`]: { link: blob } } } });
    const link = path.join(s.lm, R, 'Tiny-Q4_K_M.gguf');
    const ino = lstatSync(link).ino;
    const plan = await s.plan();
    expect(plan.views[0]!.items.map((i) => i.action)).toEqual(['adopt']);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]).toMatchObject({ status: 'applied', applied: [{ key: K, action: 'adopt' }], createdPaths: [], removedPaths: [] });
    expect(lstatSync(link).ino).toBe(ino);
    expect(read(path.join(s.lm, STATE_FILE))).toBe(stateText({ [K]: { paths: [`${R}/Tiny-Q4_K_M.gguf`], sha256: q4 } }));
  });

  it('update whose create is skipped (offline) changes nothing: no removal, state as before', async () => {
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const oldCfg = `blobs/sha256-${'c'.repeat(64)}`;
    const before = stateText({ [K]: { paths: [`blobs/sha256-${q4}`, oldCfg, man], sha256: q4 } });
    const s = await setup({ ...tiny, views: ['ollama'], viewFiles: { ollama: {
      [`blobs/sha256-${q4}`]: { link: `@HUB@/${FOLDER}/blobs/gone` }, [man]: manifestOf(q4), [oldCfg]: 'cfg',
      [STATE_FILE]: before } } });
    const plan = await s.plan(true);
    expect(plan.views[0]!.items.map((i) => [i.action, i.removes])).toEqual([['update', [oldCfg]]]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]).toMatchObject({ status: 'applied', applied: [], removedPaths: [],
      skippedEntries: [{ key: K, reason: expect.stringMatching(/offline/) }] });
    expect(read(path.join(s.ol, oldCfg))).toBe('cfg');
    expect(readlinkSync(path.join(s.ol, 'blobs', `sha256-${q4}`))).toBe(path.join(s.c.hub, FOLDER, 'blobs', 'gone'));
    expect(read(path.join(s.ol, STATE_FILE))).toBe(before);
  });

  it('refuses a view whose root is not a root of the given SafeFs (nothing written)', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    const hubOnly = await SafeFs.create({ hubRoot: s.model.hubRoot, viewRoots: [], holdRoot: null }, guardedFs());
    const r = await executeSync(await s.plan(), { ...s.deps, safeFs: hubOnly });
    expect(r.views[0]).toMatchObject({ status: 'skipped', message: `[lmstudio] not covered by the SafeFs roots: ${s.lm}` });
    // a SafeFs over another hub is refused the same way (its exclusions would protect the wrong hub)
    const otherHub = path.join(s.c.dir, 'other-hub');
    mkdirSync(otherHub);
    const wrongHub = await SafeFs.create({ hubRoot: otherHub, viewRoots: [s.lm], holdRoot: null }, guardedFs());
    const r2 = await executeSync(await s.plan(), { ...s.deps, safeFs: wrongHub });
    expect(r2.views[0]!.status).toBe('skipped');
    expect(existsSync(path.join(s.lm, STATE_FILE))).toBe(false);
  });
});

describe('executeSync coverage closers', () => {
  it('lock failures that are not Error objects are reported by their text', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    class StringAcquire extends AppLock { override async acquire(): Promise<void> { throw 'no lock for you'; } }
    const r = await executeSync(await s.plan(), { ...s.deps, lock: new StringAcquire(s.lockDir) });
    expect(r.views[0]!.message).toBe('[lmstudio] the app lock could not be taken: no lock for you');
    class StringRelease extends AppLock { override async release(): Promise<void> { await super.release(); throw 'stuck'; } }
    const r2 = await executeSync(await s.plan(), { ...s.deps, lock: new StringRelease(s.lockDir) });
    expect(r2.views[0]!.warnings).toContain('the app lock could not be released: stuck');
  });

  it('a state save that fails when nothing was created names no unrecorded paths', async () => {
    const s = await setup({ ...tiny, views: ['ollama'] });
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots,
      failingFs(guardedFs(), 'writeFile', 'ENOSPC', (p) => p.includes(`${STATE_FILE}.`))) };
    const r = await executeSync(await s.plan(true), deps);
    expect(r.views[0]!.status).toBe('aborted');
    expect(r.views[0]!.createdPaths).toEqual([]);
    expect(r.views[0]!.message).toMatch(/^\[ollama\] aborted: the state file could not be saved \(.*ENOSPC.*\)$/);
  });

  it('after an abort, later items that change nothing are not reported as "not applied"', async () => {
    const q5 = sha256Hex('q5');
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'Tiny-Q4_K_M.gguf', text: 'q4' }, { path: 'Tiny-Q5_K_M.gguf', text: 'q5' }, { path: 'Tiny-Q8_0.gguf', text: 'q8' }] }] }],
    views: ['lmstudio'] });
    await executeSync(await s.plan(), s.deps);
    const K5 = `${R}:Tiny-Q5_K_M.gguf`;
    const st = await load(s.lm);
    const { [K5]: dropped, ...rest } = st.owned;
    expect(dropped).toBeDefined();
    unlinkSync(path.join(s.lm, R, 'Tiny-Q5_K_M.gguf'));
    writeFileSync(path.join(s.lm, STATE_FILE), stateText(rest));
    const plan = await s.plan();
    expect(plan.views[0]!.items.map((i) => [i.key, i.action])).toEqual([[K, 'noop'], [K5, 'create'], [`${R}:Tiny-Q8_0.gguf`, 'noop']]);
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots, failingFs(guardedFs(), 'symlink', 'EACCES', (p) => p.endsWith(q5))) };
    const r = await executeSync(plan, deps);
    expect(r.views[0]!.status).toBe('aborted');
    expect(r.views[0]!.warnings.filter((w) => w.includes('not applied'))).toEqual([]);
  });

  describe('plans altered after the preview (data that crossed a process boundary)', () => {
    it('a create item without its desired entry aborts the view with a clear message', async () => {
      const s = await setup({ ...tiny, views: ['lmstudio'] });
      const plan = await s.plan();
      delete plan.views[0]!.items[0]!.desired;
      const r = await executeSync(plan, s.deps);
      expect(r.views[0]!.status).toBe('aborted');
      expect(r.views[0]!.message).toBe(`[lmstudio] aborted: ${K}: create without a desired entry`);
      expect(existsSync(path.join(s.lm, R))).toBe(false);
    });

    it('an update of a key that is not owned aborts; a prune of a key that is not owned does nothing', async () => {
      const s = await setup({ ...tiny, views: ['lmstudio'] });
      const upd = await s.plan();
      upd.views[0]!.items[0]!.action = 'update';
      const r = await executeSync(upd, s.deps);
      expect(r.views[0]!.message).toBe(`[lmstudio] aborted: ${K}: update of a key that is not owned`);
      const pr = await s.plan();
      pr.views[0]!.items[0]!.action = 'prune';
      const r2 = await executeSync(pr, s.deps);
      expect(r2.views[0]).toMatchObject({ status: 'applied', applied: [], removedPaths: [] });
      expect(existsSync(path.join(s.lm, R))).toBe(false);
    });

    it('a prune whose removal list was trimmed keeps the unlisted path, owned again, with a warning', async () => {
      const blob = `@HUB@/${FOLDER}/blobs/${q4}`;
      const s = await setup({ ...tiny, views: ['lmstudio'], viewFiles: { lmstudio: {
        'old/a.gguf': { link: blob },
        [STATE_FILE]: stateText({ 'gone/A:a.gguf': { paths: ['old/a.gguf'], sha256: 'a'.repeat(64) } }) } } }, { allowMassRemoval: true });
      const plan = await s.plan();
      const prune = plan.views[0]!.items.find((i) => i.action === 'prune')!;
      expect(prune.removes).toEqual(['old/a.gguf']);
      prune.removes = [];
      const r = await executeSync(plan, s.deps);
      expect(r.views[0]!.warnings).toContain('old/a.gguf: not in the previewed removals; kept and still owned');
      expect(lstatSync(path.join(s.lm, 'old', 'a.gguf')).isSymbolicLink()).toBe(true);
      expect((await load(s.lm)).owned['gone/A:a.gguf']).toEqual({ paths: ['old/a.gguf'], sha256: 'a'.repeat(64) });
    });
  });
});

describe('executeSync coverage closers, part 2', () => {
  it('a throw out of the apply phase still releases the lock and propagates', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    const broken = Object.create(s.safeFs) as SafeFs;
    Object.defineProperty(broken, 'roots', { get: () => { throw new Error('roots exploded'); } });
    await expect(executeSync(await s.plan(), { ...s.deps, safeFs: broken })).rejects.toThrow('roots exploded');
    const next = new AppLock(s.lockDir);
    await expect(next.acquire(NOW.getTime())).resolves.toBeUndefined();
    await next.release();
  });

  it('a lock that cannot be released while an error propagates does not replace that error', async () => {
    const s = await setup({ ...tiny, views: ['lmstudio'] });
    const broken = Object.create(s.safeFs) as SafeFs;
    Object.defineProperty(broken, 'roots', { get: () => { throw new Error('roots exploded'); } });
    class StuckRelease extends AppLock { override async release(): Promise<void> { throw new Error('release failed too'); } }
    await expect(executeSync(await s.plan(), { ...s.deps, safeFs: broken, lock: new StuckRelease(s.lockDir) })).rejects.toThrow('roots exploded');
  });

  it('a handed-over path the taker then writes is owned again; one it does not write is reported as orphaned', async () => {
    const sha = sha256Hex(ggufBytes(g15));
    const K2 = `${R}:sub/Tiny-Q4_K_M.gguf`;
    const blob = `blobs/sha256-${sha}`;
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const s = await setup({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
      { path: 'sub/Tiny-Q4_K_M.gguf', gguf: g15 }] }] }], views: ['ollama'], aliases: { tiny: K2 }, viewFiles: { ollama: {
      [blob]: { link: `@HUB@/${FOLDER}/blobs/${sha}` }, [man]: manifestOf(sha),
      [STATE_FILE]: stateText({ [K]: { paths: [blob, man], sha256: sha },
        'other/Keep:keep.gguf': { paths: ['blobs/sha256-' + 'c'.repeat(64)], sha256: 'c'.repeat(64) } }) } } },
    { allowMassRemoval: true, fetch: fakeFetch({ status: 404 }) });
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots,
      failingFs(guardedFs(), 'writeFile', 'EACCES', (p) => p.includes('/library/tiny/'))) };
    const plan = await s.plan(false);
    const r = await executeSync(plan, deps);
    expect(r.views[0]!.skippedEntries).toEqual([{ key: K2, reason: expect.stringMatching(/^failed after a partial write/), partialWrite: true }]);
    const orphan = r.views[0]!.warnings.filter((w) => w.includes('kept but no longer owned'));
    expect(orphan).toEqual([`${blob}: kept but no longer owned; next sync will re-check`]);
    expect((await load(s.ol)).owned[K2]!.paths).toContain(man);
    expect((await load(s.ol)).owned[K2]!.paths).not.toContain(blob);
  });
});

describe('a model the user pulled with Ollama is never ours to remove', () => {
  const O = 'other/Keep-GGUF';
  const otherRepo = { id: O, main: 'd1', snapshots: [{ commit: 'd1', mtime: 1, files: [{ path: 'Keep-Q8_0.gguf', text: 'k8' }] }] };
  const blob = `blobs/sha256-${q4}`;
  const man = `manifests/hf.co/${R}/Q4_K_M`;
  const WEIGHTS = 'the weights ollama pulled itself';
  /** `ollama pull hf.co/acme/Tiny-GGUF:Q4_K_M`: a regular model blob and Ollama's own manifest at our manifest path. */
  const pulled = (state?: string): CaseSpec => ({ repos: [tiny.repos[0]!, otherRepo], views: ['ollama'], viewFiles: { ollama: {
    [blob]: WEIGHTS, [man]: manifestOf(q4), ...(state === undefined ? {} : { [STATE_FILE]: state }) } } });
  /** Moves the repo out of the hub (never deleted) and plans again, so its key is pruned. */
  const pruneAfterRepoLeaves = async (s: Setup): Promise<SyncPlan> => {
    renameSync(path.join(s.model.hubRoot, FOLDER), path.join(s.c.dir, 'moved-out-of-hub'));
    return planSync(s.config, await scanHub(s.model.hubRoot), { offline: true, now: NOW.getTime() });
  };
  const survived = (s: Setup): void => {
    expect(read(path.join(s.ol, man))).toBe(manifestOf(q4));
    expect(lstatSync(path.join(s.ol, blob)).isFile()).toBe(true);
    expect(read(path.join(s.ol, blob))).toBe(WEIGHTS);
  };

  it('adopt records only the blob link (CLI base.py:53-55,166); a later prune keeps the manifest and the weights', async () => {
    const s = await setup(pulled(), { allowMassRemoval: true });
    const plan = await s.plan();
    expect(plan.views[0]!.items.map((i) => [i.key, i.action])).toEqual([[K, 'adopt'], [`${O}:Keep-Q8_0.gguf`, 'create']]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]).toMatchObject({ status: 'applied', applied: [{ key: K, action: 'adopt' }], removedPaths: [] });
    expect((await load(s.ol)).owned).toEqual({ [K]: { paths: [blob], sha256: q4 } });
    const p2 = await pruneAfterRepoLeaves(s);
    expect(p2.views[0]!.items.map((i) => [i.key, i.action, i.removes])).toEqual([[K, 'prune', [blob]], [`${O}:Keep-Q8_0.gguf`, 'create', []]]);
    const r2 = await executeSync(p2, s.deps);
    expect(r2.views[0]).toMatchObject({ status: 'applied', applied: [{ key: K, action: 'prune' }], removedPaths: [] });
    survived(s);
    expect((await load(s.ol)).owned).toEqual({});
  });

  it('adopt then an app delete of the repo: no op touches the manifest or the weights', async () => {
    const s = await setup(pulled());
    await executeSync(await s.plan(), s.deps);
    const { ops } = await createViewImpactProvider(s.config, s.fs).impactFor(s.model, doomRepo(s.model, R));
    expect(ops.filter((o) => o.kind === 'unlink')).toEqual([]);
    await applyViewOps(ops, s.safeFs);
    survived(s);
  });

  it('a state that already owns the pulled manifest (older adopt): prune leaves it with a warning', async () => {
    const s = await setup(pulled(stateText({ [K]: { paths: [blob, man], sha256: q4 } })), { allowMassRemoval: true });
    const r = await executeSync(await pruneAfterRepoLeaves(s), s.deps);
    expect(r.views[0]).toMatchObject({ status: 'applied', applied: [{ key: K, action: 'prune' }], removedPaths: [] });
    expect(r.views[0]!.warnings).toContain(`${man}: model downloaded by Ollama; left in place`);
    survived(s);
  });
});

describe('an update never unlinks an alias before create; create replaces it in place', () => {
  const old = 'b'.repeat(64);
  const sha = sha256Hex(ggufBytes(g15));
  const man = `manifests/hf.co/${R}/Q4_K_M`;
  const alias = 'manifests/registry.ollama.ai/library/tiny/latest';
  const oldBlob = `blobs/sha256-${old}`;
  /** The repo file changed (new sha): the owned manifest and alias still name the old model, so the plan is an update. */
  const changed = (): CaseSpec => ({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
    { path: 'Tiny-Q4_K_M.gguf', gguf: g15 }] }] }], views: ['ollama'], aliases: { tiny: K }, viewFiles: { ollama: {
    [oldBlob]: { link: `@HUB@/${FOLDER}/blobs/${old}` }, [man]: manifestOf(old), [alias]: manifestOf(old),
    [STATE_FILE]: stateText({ [K]: { paths: [oldBlob, alias, man], sha256: old } }) } } });

  it('registry unreachable (offline, no cache): create is skipped and the alias is left exactly as it was', async () => {
    const s = await setup(changed());
    const aliasIno = lstatSync(path.join(s.ol, alias)).ino;
    const before = read(path.join(s.ol, STATE_FILE));
    const plan = await s.plan(true);
    expect(plan.views[0]!.items.map((i) => [i.action, i.removes])).toEqual([['update', [oldBlob]]]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]).toMatchObject({ status: 'applied', applied: [], removedPaths: [], createdPaths: [],
      skippedEntries: [{ key: K, reason: expect.stringMatching(/offline/) }] });
    expect(lstatSync(path.join(s.ol, alias)).ino).toBe(aliasIno);
    expect(read(path.join(s.ol, alias))).toBe(manifestOf(old));
    expect(read(path.join(s.ol, STATE_FILE))).toBe(before);
  });

  it('online: the owned alias naming the previous model is overwritten atomically, never reported as removed', async () => {
    const s = await setup(changed(), { fetch: fakeFetch({ status: 404 }) });
    const plan = await s.plan(false);
    const r = await executeSync(plan, s.deps);
    const v = r.views[0]!;
    expect(v).toMatchObject({ status: 'applied', applied: [{ key: K, action: 'update' }], skippedEntries: [] });
    expect(v.removedPaths).toEqual([oldBlob]);
    expect(v.warnings.filter((w) => w.includes(alias))).toEqual([]);
    expect(modelDigest(path.join(s.ol, alias))).toBe(`sha256:${sha}`);
    expect(read(path.join(s.ol, alias))).toBe(read(path.join(s.ol, man)));
    expect((await load(s.ol)).owned[K]).toMatchObject({ sha256: sha });
    expect((await load(s.ol)).owned[K]!.paths).toContain(alias);
    expect((await s.plan(false)).views[0]!.items.map((i) => i.action)).toEqual(['noop']);
  });

  it('an update whose manifest write fails keeps the previous sha256, so the next sync updates again and finishes', async () => {
    const s = await setup(changed(), { fetch: fakeFetch({ status: 404 }) });
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots,
      failingFs(guardedFs(), 'writeFile', 'EIO', (p) => p.includes('/hf.co/'))) };
    const r = await executeSync(await s.plan(false), deps);
    const v = r.views[0]!;
    expect(v.skippedEntries).toEqual([{ key: K, reason: expect.stringMatching(/^failed after a partial write: .*EIO/), partialWrite: true }]);
    expect(v.removedPaths).toEqual([]);
    expect(modelDigest(path.join(s.ol, man))).toBe(`sha256:${old}`);
    const st = (await load(s.ol)).owned[K]!;
    expect(st.sha256).toBe(old);
    expect(st.paths).toEqual(expect.arrayContaining([oldBlob, alias, man, `blobs/sha256-${sha}`]));
    const p2 = await s.plan(false);
    expect(p2.views[0]!.items.map((i) => i.action)).toEqual(['update']);
    const r2 = await executeSync(p2, s.deps);
    expect(r2.views[0]).toMatchObject({ status: 'applied', applied: [{ key: K, action: 'update' }], removedPaths: [oldBlob] });
    expect((await load(s.ol)).owned[K]!.sha256).toBe(sha);
    expect((await s.plan(false)).views[0]!.items.map((i) => i.action)).toEqual(['noop']);
  });

  it('once the new manifest is written, a later failure (the alias) records the new sha256', async () => {
    const s = await setup(changed(), { fetch: fakeFetch({ status: 404 }) });
    const deps = { ...s.deps, safeFs: await SafeFs.create(s.safeFs.roots,
      failingFs(guardedFs(), 'writeFile', 'EIO', (p) => p.includes('/library/tiny/latest.'))) };
    const r = await executeSync(await s.plan(false), deps);
    expect(r.views[0]!.skippedEntries).toEqual([{ key: K, reason: expect.stringMatching(/^failed after a partial write/), partialWrite: true }]);
    expect(modelDigest(path.join(s.ol, man))).toBe(`sha256:${sha}`);
    expect((await load(s.ol)).owned[K]!.sha256).toBe(sha);
  });

  it('an alias the previous key did not own, naming the previous model, is still refused', async () => {
    const spec = changed();
    spec.viewFiles!.ollama![STATE_FILE] = stateText({ [K]: { paths: [oldBlob, man], sha256: old } });
    const s = await setup(spec, { fetch: fakeFetch({ status: 404 }) });
    const r = await executeSync(await s.plan(false), s.deps);
    expect(r.views[0]!.warnings).toContain(`${K}: alias ${alias} exists and belongs to another model; not overwritten`);
    expect(read(path.join(s.ol, alias))).toBe(manifestOf(old));
  });
});

describe('a new revision never overwrites a manifest the user pulled with Ollama', () => {
  it('pull, adopt, new revision in the cache, sync: the manifest and the weights are unchanged and the entry is foreign, with the reason', async () => {
    const O = 'other/Keep-GGUF';
    const blob = `blobs/sha256-${q4}`;
    const man = `manifests/hf.co/${R}/Q4_K_M`;
    const WEIGHTS = 'the weights ollama pulled itself';
    const s = await setup({ repos: [tiny.repos[0]!, { id: O, main: 'd1', snapshots: [{ commit: 'd1', mtime: 1, files: [
      { path: 'Keep-Q8_0.gguf', text: 'k8' }] }] }], views: ['ollama'],
    viewFiles: { ollama: { [blob]: WEIGHTS, [man]: manifestOf(q4) } } }, { fetch: fakeFetch({ status: 404 }) });
    await executeSync(await s.plan(true), s.deps);
    expect((await load(s.ol)).owned[K]).toEqual({ paths: [blob], sha256: q4 });
    // Upstream re-uploads the same filename: the cache gets a new blob and the snapshot link moves to it.
    const bytes = ggufBytes(g15);
    const sha = sha256Hex(bytes);
    writeFileSync(path.join(s.model.hubRoot, FOLDER, 'blobs', sha), bytes);
    const snap = path.join(s.model.hubRoot, FOLDER, 'snapshots', 'c1', 'Tiny-Q4_K_M.gguf');
    unlinkSync(snap);
    symlinkSync(`../../blobs/${sha}`, snap);
    const model = await scanHub(s.model.hubRoot);
    const plan = await planSync(s.config, model, { offline: false, now: NOW.getTime() });
    const item = plan.views[0]!.items.find((i) => i.key === K)!;
    expect([item.action, item.reason]).toEqual(['foreign', `${man}: model downloaded by Ollama; not replaced`]);
    const r = await executeSync(plan, s.deps);
    expect(r.views[0]!.status).toBe('applied');
    expect(r.views[0]!.applied.map((a) => a.key)).not.toContain(K);
    expect(read(path.join(s.ol, man))).toBe(manifestOf(q4));
    expect(read(path.join(s.ol, blob))).toBe(WEIGHTS);
    expect(existsSync(path.join(s.ol, `blobs/sha256-${sha}`))).toBe(false);
    expect((await load(s.ol)).owned[K]).toEqual({ paths: [blob], sha256: q4 });
  });
});
