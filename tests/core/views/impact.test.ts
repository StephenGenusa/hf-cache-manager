import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HfhubConfig } from '../../../src/core/compat/config';
import { pySort } from '../../../src/core/compat/pyjson';
import { loadState, serializeState, STATE_FILE, type ViewState } from '../../../src/core/compat/state';
import { executePlan } from '../../../src/core/exec/executor';
import { Journal } from '../../../src/core/exec/journal';
import { AppLock } from '../../../src/core/exec/lock';
import { factsOf, type FsLike } from '../../../src/core/fsx';
import { planDeletion } from '../../../src/core/plan/planner';
import { scanHub } from '../../../src/core/scan/scanner';
import { executeSync, planSync } from '../../../src/core/sync/sync';
import type { CacheModel, Op, ViewImpactLine } from '../../../src/core/types';
import { createViewImpactProvider } from '../../../src/core/views/impact';
import { MT } from '../../../src/core/views/registry';
import { useCanaries } from '../../helpers/canary';
import { failingFs } from '../../helpers/failing-fs';
import { treeDigest } from '../../helpers/tree-digest';
import { groupKeyFor } from '../support/scenarios';
import { doomRepo, fakeFetch, ggufBytes, loadCase, sha256Hex, type CaseSpec, type LoadedCase } from './_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const R = 'acme/Tiny-GGUF';
const O = 'other/Keep-GGUF';
const K = `${R}:Tiny-Q4_K_M.gguf`;
const K8 = `${R}:Tiny-Q8_0.gguf`;
const KO = `${O}:Keep-Q8_0.gguf`;
const G15 = { arch: 'llama', fileType: 15, tensors: [[4, 4]] };
const G7 = { arch: 'llama', fileType: 7, tensors: [[4, 4]] };
const G2 = { arch: 'llama', fileType: 2, tensors: [[4, 4]] };
const q4 = sha256Hex(ggufBytes(G15));
const NOW = new Date(2026, 9, 25, 14, 3, 7);
const LM_LINK = `${R}/Tiny-Q4_K_M.gguf`;
const M_HF = `manifests/hf.co/${R}/Q4_K_M`;
const M_ALIAS = 'manifests/registry.ollama.ai/library/tiny/latest';
const DANGLE = 'not created by sync; left in place and will dangle';

const otherRepo = { id: O, main: 'd1', snapshots: [{ commit: 'd1', mtime: 1, files: [{ path: 'Keep-Q8_0.gguf', gguf: G7 }] }] };
const base: CaseSpec = {
  repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [{ path: 'Tiny-Q4_K_M.gguf', gguf: G15 }] }] }, otherRepo],
  views: ['lmstudio', 'ollama'], aliases: { tiny: K },
};
const withMmproj = (views: CaseSpec['views']): CaseSpec => ({
  repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [
    { path: 'Tiny-Q4_K_M.gguf', gguf: G15 }, { path: 'Tiny-Q8_0.gguf', gguf: G2 }, { path: 'mmproj-F16.gguf', text: 'pf' }] }] }, otherRepo],
  views,
});

interface S extends LoadedCase { lm: string; ol: string; provider: ReturnType<typeof createViewImpactProvider> }

/** Builds the case and syncs both views (online, registry 404 -> synthesised Ollama manifests). */
async function synced(spec: CaseSpec = base): Promise<S> {
  const lc = await loadCase(spec);
  const plan = await planSync(lc.config, lc.model, { offline: false, now: NOW.getTime() });
  const r = await executeSync(plan, {
    safeFs: lc.safeFs, fs: lc.fs, fetch: fakeFetch({ status: 404 }), allowMassRemoval: false, token: null,
    now: () => NOW, lock: new AppLock(path.join(lc.c.dir, 'sync-lock')),
  });
  expect(r.views.every((v) => v.status === 'applied')).toBe(true);
  const real = (p: string | null): string => (p !== null && existsSync(p) ? realpathSync(p) : '');
  return { ...lc, lm: real(lc.c.lmstudio), ol: real(lc.c.ollama), provider: createViewImpactProvider(lc.config, lc.fs) };
}

const relOf = (s: S, p: string): string =>
  s.lm !== '' && p.startsWith(s.lm + path.sep) ? `lm:${path.relative(s.lm, p).split(path.sep).join('/')}` : `ol:${path.relative(s.ol, p).split(path.sep).join('/')}`;
const shape = (s: S, ops: Op[]): Array<[string, string | undefined, string]> =>
  ops.map((o) => [o.kind, 'role' in o ? o.role : undefined, relOf(s, (o as { path: string }).path)]);
const writeOf = (ops: Op[], root: string): Extract<Op, { kind: 'write-file' }> => {
  const w = ops.find((o): o is Extract<Op, { kind: 'write-file' }> => o.kind === 'write-file' && o.path === path.join(root, STATE_FILE));
  if (!w) throw new Error(`no write-file for ${root}`);
  return w;
};
const stateOf = (text: string): ViewState => JSON.parse(text) as ViewState;
const inRoot = (ops: Op[], root: string): Op[] => ops.filter((o) => (o as { path: string }).path.startsWith(root + path.sep));
const blobPathOf = (model: CacheModel, repoId: string, relpath: string): string => {
  const repo = model.repos.find((r) => r.id === repoId)!;
  const f = repo.files.find((x) => x.relpath === relpath)!;
  return repo.blobs[f.blobEtag!]!.path;
};
const putState = (root: string, st: ViewState): void => writeFileSync(path.join(root, STATE_FILE), serializeState(st));
const load = async (root: string): Promise<ViewState> => (await loadState(root)).state;
const pick = (lines: ViewImpactLine[], action: ViewImpactLine['action']): ViewImpactLine[] => lines.filter((l) => l.action === action);

describe('createViewImpactProvider', () => {
  it('whole-repo delete: removes owned links/manifests/blobs and writes pruned state', async () => {
    const s = await synced();
    const olPaths = (await load(s.ol)).owned[K]!.paths;
    const blobs = olPaths.filter((p) => p.startsWith('blobs/'));
    const cfg = blobs.find((p) => p !== `blobs/sha256-${q4}`)!;
    expect(blobs).toHaveLength(2);
    const lmBefore = await load(s.lm);
    const olBefore = await load(s.ol);
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(shape(s, ops)).toEqual([
      ['unlink', 'view-link', `lm:${LM_LINK}`], ['rmdir-empty', undefined, `lm:${R}`], ['rmdir-empty', undefined, 'lm:acme'],
      ['write-file', 'view-state', `lm:${STATE_FILE}`],
      ['unlink', 'view-manifest', `ol:${M_HF}`], ['unlink', 'view-manifest', `ol:${M_ALIAS}`],
      ...pySort(blobs).map((b): [string, string, string] => ['unlink', b === cfg ? 'view-blob' : 'view-link', `ol:${b}`]),
      ['rmdir-empty', undefined, `ol:manifests/hf.co/${R}`], ['rmdir-empty', undefined, 'ol:manifests/registry.ollama.ai/library/tiny'],
      ['rmdir-empty', undefined, 'ol:manifests/hf.co/acme'], ['rmdir-empty', undefined, 'ol:manifests/registry.ollama.ai/library'],
      ['rmdir-empty', undefined, 'ol:manifests/registry.ollama.ai'],
      ['write-file', 'view-state', `ol:${STATE_FILE}`]]);
    const without = (o: ViewState['owned']): ViewState['owned'] => Object.fromEntries(Object.entries(o).filter(([k]) => k !== K));
    const lmRest = without(lmBefore.owned);
    const olRest = without(olBefore.owned);
    expect(writeOf(ops, s.lm).after).toBe(serializeState({ version: 1, owned: lmRest, tombstones: {} }));
    expect(writeOf(ops, s.ol).after).toBe(serializeState({ version: 1, owned: olRest, tombstones: {} }));
    expect(writeOf(ops, s.lm).before).toBe(readFileSync(path.join(s.lm, STATE_FILE), 'utf8'));
    expect(Object.keys(lmRest)).toEqual([KO]);
    const removes = pick(lines, 'remove');
    expect(removes.map((l) => [l.view, l.path])).toEqual([
      ['lmstudio', LM_LINK], ['ollama', M_HF], ['ollama', M_ALIAS], ...pySort(blobs).map((b) => ['ollama', b])]);
    expect(removes.every((l) => l.key === K && l.note === undefined)).toBe(true);
    expect(pick(lines, 'state-update').map((l) => [l.view, l.path, l.note])).toEqual([
      ['lmstudio', STATE_FILE, 'drop 1 keys, update 0'], ['ollama', STATE_FILE, 'drop 1 keys, update 0']]);
    expect(lines.filter((l) => !['remove', 'state-update'].includes(l.action))).toEqual([]);
  });

  it('after applying impact ops and deleting the repo, planSync shows no prune/tombstone/update/foreign for that repo', async () => {
    const s = await synced();
    const roots = { hubRoot: s.model.hubRoot, viewRoots: [s.lm, s.ol], holdRoot: null };
    const now = Date.now();
    const pair = await planDeletion({ model: s.model, selection: { repos: [{ repoId: R, whole: true }] }, roots, views: s.provider, now });
    const viewOps = pair.permanent.ops.filter((o) => (o as { path?: string }).path?.startsWith(s.lm + path.sep) || (o as { path?: string }).path?.startsWith(s.ol + path.sep));
    expect(viewOps.length).toBeGreaterThan(0);
    const before = { lm: await treeDigest(s.lm), ol: await treeDigest(s.ol) };
    mkdirSync(path.join(s.c.dir, 'journal'));
    const res = await executePlan(pair.permanent, {
      safeFs: s.safeFs, fs: s.fs, journal: new Journal(path.join(s.c.dir, 'journal'), () => now),
      lock: new AppLock(path.join(s.c.dir, 'exec-lock')), rescan: () => scanHub(s.model.hubRoot), now: () => now,
      diskFree: async () => 1e12,
    });
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ ok: true });
    // The view trees lost exactly the planned paths, and each state file holds exactly the planned text.
    const gone = new Set(viewOps.filter((o) => o.kind !== 'write-file').map((o) => relOf(s, (o as { path: string }).path)));
    for (const v of ['lm', 'ol'] as const) {
      const root = v === 'lm' ? s.lm : s.ol;
      const after = await treeDigest(root);
      const expected = Object.keys(before[v]).filter((k) => !gone.has(`${v}:${k}`));
      expect(Object.keys(after).sort()).toEqual(expected.sort());
      for (const k of expected) if (k !== STATE_FILE) expect(after[k]).toBe(before[v][k]);
      expect(readFileSync(path.join(root, STATE_FILE), 'utf8')).toBe(writeOf(viewOps, root).after);
    }
    const sp = await planSync(s.config, await scanHub(s.model.hubRoot), { offline: true, now });
    expect(sp.skipped).toEqual([]);
    expect(sp.views.map((v) => v.view)).toEqual(['lmstudio', 'ollama']);
    for (const v of sp.views) {
      expect(v.items.map((i) => [i.key, i.action])).toEqual([[KO, 'noop']]);
      expect(v.foreign).toEqual([]);
    }
  });

  it('impact returns only blocked lines when the hub is missing', async () => {
    const s = await synced();
    const note = 'hub not found or has no repos; view links are not cleaned';
    for (const model of [{ ...s.model, repos: [] }, { ...s.model, hubRoot: path.join(s.c.dir, 'no-hub') }]) {
      const r = await s.provider.impactFor(model, doomRepo(s.model, R));
      expect(r.ops).toEqual([]);
      expect(r.lines).toEqual([
        { view: 'lmstudio', path: '', action: 'blocked', note }, { view: 'ollama', path: '', action: 'blocked', note }]);
    }
  });

  it('corrupt state -> blocked line for that view only; never throws', async () => {
    const s = await synced();
    writeFileSync(path.join(s.lm, STATE_FILE), '{not json');
    const r = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(inRoot(r.ops, s.lm)).toEqual([]);
    expect(inRoot(r.ops, s.ol).length).toBeGreaterThan(0);
    expect(r.ops).toEqual(inRoot(r.ops, s.ol));
    const lm = r.lines.filter((l) => l.view === 'lmstudio');
    expect(lm).toHaveLength(1);
    expect(lm[0]).toMatchObject({ view: 'lmstudio', path: STATE_FILE, action: 'blocked' });
    expect(lm[0]!.note).toMatch(/^state file unreadable: .*unreadable state file.*; view links not cleaned$/);
  });

  it('V19: a state file that is a symlink blocks that view', async () => {
    const s = await synced();
    const st = path.join(s.ol, STATE_FILE);
    const copy = path.join(s.ol, 'state-copy');
    writeFileSync(copy, readFileSync(st));
    unlinkSync(st);
    symlinkSync(copy, st);
    const r = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(inRoot(r.ops, s.ol)).toEqual([]);
    expect(r.lines.filter((l) => l.view === 'ollama')).toEqual([{ view: 'ollama', path: STATE_FILE, action: 'blocked',
      note: expect.stringMatching(/^state file unreadable: .*state file is not a regular file; view links not cleaned$/) as string }]);
    expect(inRoot(r.ops, s.lm).length).toBeGreaterThan(0);
  });

  it('V18: an error after the first op of a view drops all of that view\'s ops; the other view is intact', async () => {
    const s = await synced();
    const full = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    const dir = path.join(s.lm, R);
    const fs = failingFs(s.fs, 'readdir', 'EIO', (p) => p === dir);
    const r = await createViewImpactProvider(s.config, fs).impactFor(s.model, doomRepo(s.model, R));
    expect(inRoot(r.ops, s.lm)).toEqual([]);
    expect(r.ops).toEqual(inRoot(full.ops, s.ol));
    expect(r.lines.filter((l) => l.view === 'lmstudio')).toEqual([{ view: 'lmstudio', path: '', action: 'blocked',
      note: expect.stringMatching(/^unexpected error: EIO: injected readdir failure.*; view links not cleaned$/) as string }]);
  });

  it('never throws, even when every read fails', async () => {
    const s = await synced();
    const all: FsLike = failingFs(failingFs(s.fs, 'lstat', 'EACCES'), 'stat', 'EACCES');
    const r = await createViewImpactProvider(s.config, all).impactFor(s.model, doomRepo(s.model, R));
    expect(r).toEqual({ ops: [], lines: [
      { view: 'lmstudio', path: '', action: 'blocked', note: 'hub not found or has no repos; view links are not cleaned' },
      { view: 'ollama', path: '', action: 'blocked', note: 'hub not found or has no repos; view links are not cleaned' }] });
    // A view root that cannot be checked is blocked, never treated as missing.
    const roots: FsLike = failingFs(s.fs, 'stat', 'EACCES', (p) => p === s.config.views.lmstudio.root || p === s.config.views.ollama.root);
    const r2 = await createViewImpactProvider(s.config, roots).impactFor(s.model, doomRepo(s.model, R));
    expect(r2.ops).toEqual([]);
    expect(r2.lines.map((l) => [l.view, l.path, l.action, l.note])).toEqual([
      ['lmstudio', '', 'blocked', expect.stringMatching(/^unexpected error: EACCES: injected stat failure .*; view links not cleaned$/)],
      ['ollama', '', 'blocked', expect.stringMatching(/^unexpected error: EACCES: injected stat failure .*; view links not cleaned$/)]]);
  });

  it('Ollama: a symlinked owned manifest and a non-symlink at another owned path are left in place', async () => {
    const s = await synced();
    const real = path.join(s.ol, 'elsewhere');
    writeFileSync(real, readFileSync(path.join(s.ol, M_ALIAS)));
    unlinkSync(path.join(s.ol, M_ALIAS));
    symlinkSync(real, path.join(s.ol, M_ALIAS));
    writeFileSync(path.join(s.ol, 'odd'), 'x');
    const st = await load(s.ol);
    putState(s.ol, { ...st, owned: { ...st.owned, [K]: { ...st.owned[K]!, paths: pySort([...st.owned[K]!.paths, 'odd']) } } });
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(ops.some((o) => o.kind === 'unlink' && (o.path === path.join(s.ol, M_ALIAS) || o.path === path.join(s.ol, 'odd')))).toBe(false);
    expect(lines.filter((l) => l.action === 'foreign')).toEqual([
      { view: 'ollama', path: M_ALIAS, action: 'foreign', key: K, note: 'not a regular file; left in place' },
      { view: 'ollama', path: 'odd', action: 'foreign', key: K, note: 'not a symlink; left in place' }]);
  });

  it('a symlinked folder on the way: the link is unlinked, but no rmdir-empty at or under the symlinked folder', async () => {
    const s = await synced();
    renameSync(path.join(s.lm, 'acme'), path.join(s.lm, 'acme-real'));
    symlinkSync(path.join(s.lm, 'acme-real'), path.join(s.lm, 'acme'));
    const { ops } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(shape(s, inRoot(ops, s.lm))).toEqual([['unlink', 'view-link', `lm:${LM_LINK}`], ['write-file', 'view-state', `lm:${STATE_FILE}`]]);
  });

  it('disabled or missing view roots contribute nothing', async () => {
    const s = await synced();
    const config: HfhubConfig = { ...s.config, views: {
      lmstudio: { ...s.config.views.lmstudio, root: null, problem: 'not configured' },
      ollama: { ...s.config.views.ollama, root: path.join(s.c.dir, 'no-such-ollama') } } };
    expect(await createViewImpactProvider(config, s.fs).impactFor(s.model, doomRepo(s.model, R))).toEqual({ ops: [], lines: [] });
    expect(existsSync(path.join(s.c.dir, 'no-such-ollama'))).toBe(false);
  });

  it('nothing doomed (or another repo with no view entries) -> no ops, no lines, no state rewrite', async () => {
    const s = await synced({ ...base, views: ['lmstudio'] });
    expect(await s.provider.impactFor(s.model, [])).toEqual({ ops: [], lines: [] });
  });

  it('a path shared with a surviving key is kept-shared (shared-path protection)', async () => {
    const s = await synced();
    // LM Studio: the doomed key also lists a link to the OTHER repo's blob, which KO lists too.
    const shared = 'shared/Keep.gguf';
    mkdirSync(path.join(s.lm, 'shared'));
    symlinkSync(blobPathOf(s.model, O, 'Keep-Q8_0.gguf'), path.join(s.lm, shared));
    const lmSt = await load(s.lm);
    putState(s.lm, { ...lmSt, owned: { ...lmSt.owned, [K]: { ...lmSt.owned[K]!, paths: [LM_LINK, shared] },
      [KO]: { ...lmSt.owned[KO]!, paths: [...lmSt.owned[KO]!.paths, shared] } } });
    // Ollama: KO also lists K's config blob.
    const olSt = await load(s.ol);
    const cfg = olSt.owned[K]!.paths.find((p) => p.startsWith('blobs/') && p !== `blobs/sha256-${q4}`)!;
    putState(s.ol, { ...olSt, owned: { ...olSt.owned, [KO]: { ...olSt.owned[KO]!, paths: pySort([...olSt.owned[KO]!.paths, cfg]) } } });
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(shape(s, inRoot(ops, s.lm))).toEqual([['unlink', 'view-link', `lm:${LM_LINK}`], ['rmdir-empty', undefined, `lm:${R}`],
      ['rmdir-empty', undefined, 'lm:acme'], ['write-file', 'view-state', `lm:${STATE_FILE}`]]);
    expect(stateOf(writeOf(ops, s.lm).after).owned).toEqual({ [KO]: { ...lmSt.owned[KO]!, paths: [...lmSt.owned[KO]!.paths, shared] } });
    expect(ops.some((o) => o.kind === 'unlink' && o.path === path.join(s.ol, cfg))).toBe(false);
    expect(stateOf(writeOf(ops, s.ol).after).owned[KO]!.paths).toContain(cfg);
    expect(lines.filter((l) => l.action === 'keep-shared')).toEqual([
      { view: 'lmstudio', path: shared, action: 'keep-shared', key: K, note: `also owned by ${KO}` },
      { view: 'ollama', path: cfg, action: 'keep-shared', key: K, note: `also owned by ${KO}` }]);
  });

  it('LM Studio: a surviving key that also lists a link to the doomed blob loses only that link', async () => {
    const s = await synced();
    const st = await load(s.lm);
    putState(s.lm, { ...st, owned: { ...st.owned, [KO]: { ...st.owned[KO]!, paths: [...st.owned[KO]!.paths, LM_LINK] } } });
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(shape(s, inRoot(ops, s.lm))[0]).toEqual(['unlink', 'view-link', `lm:${LM_LINK}`]);
    expect(stateOf(writeOf(ops, s.lm).after).owned).toEqual({ [KO]: st.owned[KO] });
    expect(lines.filter((l) => l.view === 'lmstudio' && l.action === 'state-update')[0]!.note).toBe('drop 1 keys, update 1');
  });

  it('mmproj-only delete in LM Studio: removes the mmproj link from every key, updates paths, keeps keys', async () => {
    const s = await synced(withMmproj(['lmstudio']));
    const mm = `${R}/mmproj-F16.gguf`;
    expect((await load(s.lm)).owned[K]!.paths).toEqual([LM_LINK, mm]);
    const { ops, lines } = await s.provider.impactFor(s.model, [blobPathOf(s.model, R, 'mmproj-F16.gguf')]);
    expect(shape(s, ops)).toEqual([['unlink', 'view-link', `lm:${mm}`], ['write-file', 'view-state', `lm:${STATE_FILE}`]]);
    const st = stateOf(writeOf(ops, s.lm).after);
    expect(st.owned[K]!.paths).toEqual([LM_LINK]);
    expect(st.owned[K8]!.paths).toEqual([`${R}/Tiny-Q8_0.gguf`]);
    expect(Object.keys(st.owned)).toEqual([K, K8, KO]);
    expect(lines).toEqual([
      { view: 'lmstudio', path: mm, action: 'remove', key: K },
      { view: 'lmstudio', path: STATE_FILE, action: 'state-update', note: 'drop 0 keys, update 2' }]);
  });

  it('V21: mmproj-only delete in Ollama drops every key that uses the projector, noting why', async () => {
    const s = await synced(withMmproj(['ollama']));
    const owned = (await load(s.ol)).owned;
    const pf = sha256Hex('pf');
    expect(owned[K]!.paths).toContain(`blobs/sha256-${pf}`);
    const { ops, lines } = await s.provider.impactFor(s.model, [blobPathOf(s.model, R, 'mmproj-F16.gguf')]);
    expect(Object.keys(stateOf(writeOf(ops, s.ol).after).owned)).toEqual([KO]);
    const removed = pick(lines, 'remove');
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((l) => (l.key === K || l.key === K8) && l.note === 'a blob link of this entry points at a deleted file')).toBe(true);
    expect(ops.filter((o) => o.kind === 'unlink' && o.path === path.join(s.ol, 'blobs', `sha256-${pf}`))).toHaveLength(1);
    expect(shape(s, ops).filter((o) => o[1] === 'view-manifest').map((o) => o[2])).toEqual([
      `ol:manifests/hf.co/${R}/Q4_K_M`, `ol:manifests/hf.co/${R}/Q8_0`]);
    expect(pick(lines, 'state-update')[0]!.note).toBe('drop 2 keys, update 0');
  });

  it('Ollama: a blob referenced by a foreign manifest is kept-shared; manifest ops come before blob ops', async () => {
    const s = await synced();
    const foreign = 'manifests/registry.ollama.ai/library/x/latest';
    mkdirSync(path.join(s.ol, path.dirname(foreign)), { recursive: true });
    writeFileSync(path.join(s.ol, foreign), JSON.stringify({ layers: [{ mediaType: MT.model, digest: `sha256:${q4}` }] }));
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    const ol = shape(s, inRoot(ops, s.ol));
    const lastManifest = ol.map((o) => o[1]).lastIndexOf('view-manifest');
    const firstBlob = ol.findIndex((o) => o[1] === 'view-link' || o[1] === 'view-blob');
    expect(lastManifest).toBe(1);
    expect(firstBlob).toBe(2);
    expect(ol.some((o) => o[2] === `ol:blobs/sha256-${q4}`)).toBe(false);
    expect(lines.filter((l) => l.action === 'keep-shared')).toEqual([
      { view: 'ollama', path: `blobs/sha256-${q4}`, action: 'keep-shared', key: K, note: `referenced by manifest ${foreign}` }]);
    // library/ still holds x/, so only tiny/ goes
    expect(ol.filter((o) => o[0] === 'rmdir-empty').map((o) => o[2])).toEqual([
      `ol:manifests/hf.co/${R}`, 'ol:manifests/registry.ollama.ai/library/tiny', 'ol:manifests/hf.co/acme']);
  });

  it('Ollama: unparseable manifest on disk keeps every blob', async () => {
    const s = await synced();
    mkdirSync(path.join(s.ol, 'manifests/r/n'), { recursive: true });
    writeFileSync(path.join(s.ol, 'manifests/r/n/t'), 'not json');
    const blobs = (await load(s.ol)).owned[K]!.paths.filter((p) => p.startsWith('blobs/'));
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(shape(s, inRoot(ops, s.ol)).filter((o) => o[0] === 'unlink').map((o) => o[1])).toEqual(['view-manifest', 'view-manifest']);
    expect(lines.filter((l) => l.action === 'keep-shared')).toEqual(pySort(blobs).map((b) => (
      { view: 'ollama', path: b, action: 'keep-shared', key: K, note: 'a manifest is unreadable; blobs kept' })));
    expect(Object.keys(stateOf(writeOf(ops, s.ol).after).owned)).toEqual([KO]);
  });

  it('foreign LM Studio symlink to a doomed blob -> foreign line, no op', async () => {
    const s = await synced();
    const target = blobPathOf(s.model, R, 'Tiny-Q4_K_M.gguf');
    mkdirSync(path.join(s.lm, 'mine'));
    symlinkSync(target, path.join(s.lm, 'mine', 'copy.gguf'));
    symlinkSync(target, path.join(s.ol, 'blobs', `sha256-${'e'.repeat(64)}`));
    symlinkSync(target, path.join(s.lm, 'mine', 'not-a-model.txt'));
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(lines.filter((l) => l.action === 'foreign')).toEqual([
      { view: 'lmstudio', path: 'mine/copy.gguf', action: 'foreign', note: DANGLE },
      { view: 'ollama', path: `blobs/sha256-${'e'.repeat(64)}`, action: 'foreign', note: DANGLE }]);
    expect(ops.some((o) => (o as { path: string }).path.includes('mine') || (o as { path: string }).path.endsWith('e'.repeat(64)))).toBe(false);
  });

  it('does not tombstone (and keeps tombstones already there)', async () => {
    const s = await synced();
    const st = await load(s.lm);
    putState(s.lm, { ...st, tombstones: { 'x/y:z.gguf': '2026-01-01T00:00:00' } });
    const { ops } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(stateOf(writeOf(ops, s.lm).after).tombstones).toEqual({ 'x/y:z.gguf': '2026-01-01T00:00:00' });
    expect(stateOf(writeOf(ops, s.ol).after).tombstones).toEqual({});
  });

  it('expect facts on unlink ops equal a fresh factsOf', async () => {
    const s = await synced();
    const { ops } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    const unlinks = ops.filter((o): o is Extract<Op, { kind: 'unlink' }> => o.kind === 'unlink');
    expect(unlinks.length).toBe(5);
    for (const o of unlinks) expect(o.expect).toEqual(await factsOf(s.fs, o.path));
  });

  it('never unlinks a regular-file copy of the model, or any regular blob above 1 MiB', async () => {
    const s = await synced();
    const blobs = (await load(s.ol)).owned[K]!.paths.filter((p) => p.startsWith('blobs/'));
    const cfg = blobs.find((p) => p !== `blobs/sha256-${q4}`)!;
    const q4Abs = path.join(s.ol, 'blobs', `sha256-${q4}`);
    unlinkSync(q4Abs);
    writeFileSync(q4Abs, 'ollama downloaded this itself');
    writeFileSync(path.join(s.ol, cfg), Buffer.alloc(1048577));
    // The manifests name a model blob that is a regular file: Ollama's own download, so they stay too. Then the
    // blobs are checked with both manifests moved out of the view.
    let { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(shape(s, inRoot(ops, s.ol)).filter((o) => o[0] === 'unlink')).toEqual([]);
    expect(lines.filter((l) => l.view === 'ollama' && l.action === 'foreign')).toEqual([M_HF, M_ALIAS].map((m) => (
      { view: 'ollama', path: m, action: 'foreign', key: K, note: 'model downloaded by Ollama; left in place' })));
    renameSync(path.join(s.ol, M_HF), path.join(s.c.dir, 'hf-manifest-aside'));
    renameSync(path.join(s.ol, M_ALIAS), path.join(s.c.dir, 'alias-manifest-aside'));
    ({ ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R)));
    expect(shape(s, inRoot(ops, s.ol)).filter((o) => o[0] === 'unlink')).toEqual([]);
    expect(lines.filter((l) => l.action === 'foreign')).toEqual(pySort(blobs).map((b) => (
      { view: 'ollama', path: b, action: 'foreign', key: K, note: 'regular file copy of the model in Ollama; left in place' })));
    expect(Object.keys(stateOf(writeOf(ops, s.ol).after).owned)).toEqual([KO]);
    // blobs/ keeps the files, so no rmdir for it
    expect(ops.some((o) => o.kind === 'rmdir-empty' && o.path === path.join(s.ol, 'blobs'))).toBe(false);
  });

  it('Ollama: an owned manifest no longer naming the owned sha is left in place (and keeps what it references)', async () => {
    const s = await synced();
    const other = 'd'.repeat(64);
    writeFileSync(path.join(s.ol, M_HF), JSON.stringify({ layers: [{ mediaType: MT.model, digest: `sha256:${other}` }] }));
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(ops.some((o) => o.kind === 'unlink' && o.path === path.join(s.ol, M_HF))).toBe(false);
    expect(lines.filter((l) => l.path === M_HF)).toEqual([
      { view: 'ollama', path: M_HF, action: 'foreign', key: K, note: 'manifest changed by Ollama; left in place' }]);
    expect(ops.some((o) => o.kind === 'rmdir-empty' && o.path === path.join(s.ol, 'manifests/hf.co', R))).toBe(false);
  });

  it('Ollama: an unreadable owned manifest is left in place and keeps every blob', async () => {
    const s = await synced();
    writeFileSync(path.join(s.ol, M_HF), '{');
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(shape(s, inRoot(ops, s.ol)).filter((o) => o[0] === 'unlink').map((o) => o[2])).toEqual([`ol:${M_ALIAS}`]);
    expect(lines.filter((l) => l.path === M_HF)).toEqual([
      { view: 'ollama', path: M_HF, action: 'foreign', key: K, note: 'manifest unreadable; left in place' }]);
    expect(lines.filter((l) => l.action === 'keep-shared').map((l) => l.note)).toEqual(['a manifest is unreadable; blobs kept', 'a manifest is unreadable; blobs kept']);
  });

  it('LM Studio: a regular file at an owned path is never removed', async () => {
    const s = await synced();
    const link = path.join(s.lm, LM_LINK);
    unlinkSync(link);
    writeFileSync(link, 'my own copy');
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(shape(s, inRoot(ops, s.lm))).toEqual([['write-file', 'view-state', `lm:${STATE_FILE}`]]);
    expect(lines.filter((l) => l.view === 'lmstudio' && l.action !== 'state-update')).toEqual([
      { view: 'lmstudio', path: LM_LINK, action: 'foreign', key: K, note: 'regular file at an owned path; left in place' }]);
  });

  it('rmdir-empty is not emitted for a folder that keeps a file of the user', async () => {
    const s = await synced();
    writeFileSync(path.join(s.lm, R, 'notes.txt'), 'mine');
    const { ops } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(shape(s, inRoot(ops, s.lm))).toEqual([['unlink', 'view-link', `lm:${LM_LINK}`], ['write-file', 'view-state', `lm:${STATE_FILE}`]]);
  });

  it('an owned path that resolves into the hub blocks the view (no ops) and planDeletion still succeeds', async () => {
    const s = await synced();
    const snap = path.join(s.model.hubRoot, 'models--acme--Tiny-GGUF', 'snapshots', 'c1');
    symlinkSync(snap, path.join(s.lm, 'evil'));
    const st = await load(s.lm);
    putState(s.lm, { ...st, owned: { ...st.owned, [K]: { ...st.owned[K]!, paths: [LM_LINK, 'evil/Tiny-Q4_K_M.gguf'] } } });
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(inRoot(ops, s.lm)).toEqual([]);
    expect(inRoot(ops, s.ol).length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.view === 'lmstudio')).toEqual([{ view: 'lmstudio', path: 'evil/Tiny-Q4_K_M.gguf', action: 'blocked',
      note: 'path is not strictly inside a view root; view links not cleaned' }]);
    const pair = await planDeletion({ model: s.model, selection: { repos: [{ repoId: R, whole: true }] },
      roots: { hubRoot: s.model.hubRoot, viewRoots: [s.lm, s.ol], holdRoot: null }, views: s.provider, now: Date.now() });
    expect(pair.permanent.warnings.some((w) => w.startsWith('LM Studio view not updated (evil/Tiny-Q4_K_M.gguf)'))).toBe(true);
    expect(existsSync(path.join(snap, 'Tiny-Q4_K_M.gguf'))).toBe(true);
  });
});

describe('createViewImpactProvider, edge cases', () => {
  it('overlapping view roots (equal or nested) block both views with no ops', async () => {
    const s = await synced();
    const note = 'LM Studio and Ollama folders overlap; fix config.toml';
    const nested = path.join(s.lm, 'inner');
    mkdirSync(nested);
    for (const [lmRoot, olRoot] of [[s.lm, s.lm], [s.lm, nested], [nested, s.lm]] as const) {
      const config: HfhubConfig = { ...s.config, views: {
        lmstudio: { ...s.config.views.lmstudio, root: lmRoot }, ollama: { ...s.config.views.ollama, root: olRoot } } };
      expect(await createViewImpactProvider(config, s.fs).impactFor(s.model, doomRepo(s.model, R))).toEqual({ ops: [], lines: [
        { view: 'lmstudio', path: '', action: 'blocked', note }, { view: 'ollama', path: '', action: 'blocked', note }] });
    }
  });

  it('a small regular blob named by ANY cached etag (e.g. a projector whose manifest is gone) is never unlinked', async () => {
    const third = { id: 'third/Data', main: 'e1', snapshots: [{ commit: 'e1', mtime: 1, files: [{ path: 'weights.safetensors', text: 'ww' }] }] };
    const s = await synced({ ...base, repos: [...base.repos, third] });
    const rel = `blobs/sha256-${sha256Hex('ww')}`;
    writeFileSync(path.join(s.ol, rel), 'ww');
    const st = await load(s.ol);
    putState(s.ol, { ...st, owned: { ...st.owned, [K]: { ...st.owned[K]!, paths: pySort([...st.owned[K]!.paths, rel]) } } });
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(ops.some((o) => o.kind === 'unlink' && o.path === path.join(s.ol, rel))).toBe(false);
    expect(lines.filter((l) => l.path === rel)).toEqual([
      { view: 'ollama', path: rel, action: 'foreign', key: K, note: 'regular file copy of the model in Ollama; left in place' }]);
  });

  it('an unreadable folder in the foreign-link scan adds a note line and keeps the view\'s cleanup', async () => {
    const s = await synced();
    const full = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    const mine = path.join(s.lm, 'mine');
    mkdirSync(mine);
    const fs = failingFs(s.fs, 'readdir', 'EACCES', (p) => p === mine);
    const r = await createViewImpactProvider(s.config, fs).impactFor(s.model, doomRepo(s.model, R));
    expect(r.ops).toEqual(full.ops);
    const extra = r.lines.filter((l) => !full.lines.some((x) => JSON.stringify(x) === JSON.stringify(l)));
    expect(extra).toEqual([{ view: 'lmstudio', path: '', action: 'foreign',
      note: expect.stringMatching(/^other links to deleted files not checked: EACCES: injected readdir failure/) as string }]);
  });

  it('an owned manifest is unlinked when ANY dropped owner key has its model sha (not only the first)', async () => {
    const s = await synced(withMmproj(['ollama']));
    const q8 = sha256Hex(ggufBytes(G2));
    const first = `${R}:Aaa-Q8.gguf`;   // sorts before K, a different (also doomed) model
    const st = await load(s.ol);
    putState(s.ol, { ...st, owned: { ...st.owned, [first]: { paths: [M_HF], sha256: q8 } } });
    const { ops, lines } = await s.provider.impactFor(s.model, doomRepo(s.model, R));
    expect(ops.filter((o) => o.kind === 'unlink' && o.path === path.join(s.ol, M_HF))).toHaveLength(1);
    expect(lines.filter((l) => l.path === M_HF).map((l) => l.action)).toEqual(['remove']);
  });

  it('end to end, mmproj-only delete: LM Studio keeps both quants (sync noop); Ollama drops them for the next sync to re-create (V21)', async () => {
    const s = await synced(withMmproj(['lmstudio', 'ollama']));
    const now = Date.now();
    const selection = { repos: [{ repoId: R, whole: false as const, groupKeys: [groupKeyFor(s.model, R, 'mmproj-F16.gguf')], unlockComponents: true }] };
    const pair = await planDeletion({ model: s.model, selection, roots: { hubRoot: s.model.hubRoot, viewRoots: [s.lm, s.ol], holdRoot: null }, views: s.provider, now });
    mkdirSync(path.join(s.c.dir, 'journal'));
    const res = await executePlan(pair.permanent, {
      safeFs: s.safeFs, fs: s.fs, journal: new Journal(path.join(s.c.dir, 'journal'), () => now),
      lock: new AppLock(path.join(s.c.dir, 'exec-lock')), rescan: () => scanHub(s.model.hubRoot), now: () => now,
      diskFree: async () => 1e12,
    });
    expect(res.error).toBeUndefined();
    expect(existsSync(path.join(s.lm, R, 'mmproj-F16.gguf'))).toBe(false);
    expect(existsSync(path.join(s.lm, LM_LINK))).toBe(true);
    const sp = await planSync(s.config, await scanHub(s.model.hubRoot), { offline: true, now });
    expect(sp.skipped).toEqual([]);
    expect(sp.views.map((v) => [v.view, v.items.map((i) => [i.key, i.action]), v.foreign])).toEqual([
      ['lmstudio', [[K, 'noop'], [K8, 'noop'], [KO, 'noop']], []],
      ['ollama', [[K, 'create'], [K8, 'create'], [KO, 'noop']], []]]);
  });
});

describe('createViewImpactProvider, coverage closers', () => {
  const DOOM = (s: S): string[] => doomRepo(s.model, R);
  const unlinked = (s: S, ops: Op[]): string[] => shape(s, ops).filter((o) => o[0] === 'unlink').map((o) => o[2]);

  it('owned paths that are already gone from disk produce no op and no error; the rest is still cleaned', async () => {
    const s = await synced();
    const blob = (await load(s.ol)).owned[K]!.paths.find((p) => p.startsWith('blobs/') && p !== `blobs/sha256-${q4}`)!;
    unlinkSync(path.join(s.lm, LM_LINK));
    unlinkSync(path.join(s.ol, M_HF));
    unlinkSync(path.join(s.ol, blob));
    const { ops, lines } = await s.provider.impactFor(s.model, DOOM(s));
    expect(pick(lines, 'blocked')).toEqual([]);
    expect(unlinked(s, ops)).toEqual([`ol:${M_ALIAS}`, `ol:blobs/sha256-${q4}`]);
    expect(Object.keys(stateOf(writeOf(ops, s.lm).after).owned)).toEqual([KO]);
  });

  it('an owned manifest above 16 MiB is left in place as unreadable', async () => {
    const s = await synced();
    truncateSync(path.join(s.ol, M_HF), 16 * 1024 * 1024 + 1);
    const { ops, lines } = await s.provider.impactFor(s.model, DOOM(s));
    expect(unlinked(s, inRoot(ops, s.ol))).toEqual([`ol:${M_ALIAS}`]);
    expect(lines.filter((l) => l.path === M_HF)).toEqual([
      { view: 'ollama', path: M_HF, action: 'foreign', key: K, note: 'manifest unreadable; left in place' }]);
  });

  it('an Ollama key whose paths are manifests only needs no blob lookup', async () => {
    const s = await synced();
    putState(s.ol, { version: 1, owned: { [K]: { paths: [M_HF], sha256: q4 } }, tombstones: {} });
    const { ops, lines } = await s.provider.impactFor(s.model, DOOM(s));
    expect(unlinked(s, inRoot(ops, s.ol))).toEqual([`ol:${M_HF}`]);
    expect(pick(lines, 'blocked')).toEqual([]);
  });

  it('owned keys that name no known blob (unknown sha, or no repo part) are never doomed', async () => {
    const s = await synced();
    const st = await load(s.lm);
    putState(s.lm, { ...st, owned: { ...st.owned, [`${R}:ghost.gguf`]: { paths: [`${R}/ghost.gguf`], sha256: 'f'.repeat(64) },
      nocolon: { paths: ['nocolon.gguf'], sha256: q4 } } });
    const { ops } = await s.provider.impactFor(s.model, DOOM(s));
    const w = stateOf(writeOf(ops, s.lm).after);
    expect(Object.keys(w.owned).sort()).toEqual([`${R}:ghost.gguf`, 'nocolon', KO]);
  });

  it('a foreign symlink that points elsewhere is not reported; a non-Error scan failure is reported by its text', async () => {
    const s = await synced();
    mkdirSync(path.join(s.lm, 'mine'));
    symlinkSync('/somewhere/else', path.join(s.lm, 'mine', 'other.gguf'));
    const clean = await s.provider.impactFor(s.model, DOOM(s));
    expect(clean.lines.filter((l) => l.path.startsWith('mine'))).toEqual([]);
    const fs: FsLike = { ...s.fs, readdir: (async (p: string) => {
      if (p === path.join(s.lm, 'mine')) throw 'plain failure';
      return s.fs.readdir(p);
    }) as FsLike['readdir'] };
    const r = await createViewImpactProvider(s.config, fs).impactFor(s.model, DOOM(s));
    expect(pick(r.lines, 'foreign')).toContainEqual({ view: 'lmstudio', path: '', action: 'foreign',
      note: 'other links to deleted files not checked: plain failure' });
  });

  it('win32: the foreign LM Studio scan matches the .gguf suffix case-insensitively', async () => {
    const s = await synced();
    mkdirSync(path.join(s.lm, 'mine'));
    symlinkSync(blobPathOf(s.model, R, 'Tiny-Q4_K_M.gguf'), path.join(s.lm, 'mine', 'COPY.GGUF'));
    expect(pick((await s.provider.impactFor(s.model, DOOM(s))).lines, 'foreign').map((l) => l.path)).toEqual([]);
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(pick((await s.provider.impactFor(s.model, DOOM(s))).lines, 'foreign').map((l) => l.path)).toEqual(['mine/COPY.GGUF']);
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
  });
});
