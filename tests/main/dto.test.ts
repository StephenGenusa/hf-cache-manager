import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import type { HfhubConfig } from '../../src/core/compat/config';
import type { PlanDTO } from '../../src/shared/api';
import { RESTORE_SYNC_HINT } from '../../src/core/hold/held';
import { SafeFs } from '../../src/core/safe-fs';
import type { CacheModel, DeletionPlan, Repo, RepoView, UsageIndex } from '../../src/core/types';
import { createCorePort, type CorePort, type PortRoots } from '../../src/main/core-port';
import {
  actionText, badgeFor, displayPath, reasonText, shortHash, SUPERSEDED_WARNING, toEmptyPlanDTO, toPlanDTO, toRepoDetail, toRepoSummary,
  type DtoContext,
} from '../../src/main/dto';
import { inProcessScanRunner } from '../../src/main/scan-client';
import { buildAppFixture, COMMIT, type AppFixture } from '../helpers/app-fixture';
import { useCanaries } from '../helpers/canary';
import { buildFixture } from '../helpers/fixture';
import { guardedFs } from '../helpers/guarded-fs';
import { fakeFetch, ggufBytes, loadCase, sha256Hex } from '../core/views/_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const Q = 'unsloth/Qwen3.6-27B-GGUF';
const FLUX = 'black-forest-labs/FLUX.1-dev';

interface Scanned {
  fx: AppFixture; port: CorePort; model: CacheModel; views: RepoView[]; usage: UsageIndex; config: HfhubConfig;
  r: PortRoots; ctx: DtoContext;
}

function portFor(fx: { userDataDir: string; env: NodeJS.ProcessEnv; home: string }): CorePort {
  return createCorePort({
    userDataDir: fx.userDataDir, env: fx.env, home: fx.home, offline: true,
    makeSafeFs: (roots) => SafeFs.create(roots, guardedFs()),
  });
}

async function scanFixture(fx: AppFixture): Promise<Scanned> {
  const port = portFor(fx);
  const hub = await port.resolveHub();
  const { model, views } = await inProcessScanRunner(hub.hubRoot, () => undefined, new AbortController().signal);
  const loaded = await port.loadConfig();
  if (!loaded.ok) throw new Error(loaded.error);
  const config = loaded.config;
  const usage = await port.usage(model, config);
  const r = await port.roots(hub.hubRoot, config);
  return { fx, port, model, views, usage, config, r, ctx: port.dtoContext(model, r, config) };
}

/** The DTO's short labels: every `fullPath` (shown as the exact secondary line) blanked. */
const primary = (p: PlanDTO): string =>
  JSON.stringify({ ...p, files: p.files.map((f) => ({ ...f, fullPath: '' })), ops: p.ops.map((o) => ({ ...o, fullPath: '' })),
    viewLines: p.viewLines.map((l) => ({ ...l, fullPath: '' })), keptFiles: p.keptFiles.map((k) => ({ ...k, fullPath: '' })) });

const repoOf = (model: CacheModel, id: string): Repo => model.repos.find((x) => x.id === id)!;
const viewOf = (views: RepoView[], id: string): RepoView => views.find((x) => x.repoId === id)!;

test('badges and usage counts for the fixture library', async () => {
  const { model, views, usage } = await scanFixture(await buildAppFixture());
  const sum = (id: string) => toRepoSummary(repoOf(model, id), viewOf(views, id), usage);
  expect(sum(Q)).toMatchObject({ repoId: Q, type: 'model', badge: 'GGUF · 4 quants', usage: { lmstudio: 3, ollama: 0 },
    apparentBytes: 12_360, partialDownloads: 0, ambiguous: false });
  expect(sum(FLUX).badge).toBe('Diffusers pipeline');
  expect(sum('org/dupe').badge).toBe('Transformers');
  expect(sum('org/partial').partialDownloads).toBe(1);
  expect(sum('bartowski/tiny-GGUF')).toMatchObject({ badge: 'GGUF · 1 quant', usage: { lmstudio: 0, ollama: 0 } });
  expect(toRepoSummary(repoOf(model, Q), viewOf(views, Q), usage, true).ambiguous).toBe(true);
  const q = repoOf(model, Q);
  const newest = Math.max(...q.files.map((f) => f.facts.mtimeMs), ...Object.values(q.blobs).map((b) => b.facts.mtimeMs));
  expect(sum(Q).lastModifiedMs).toBe(newest);
});

test('badgeFor covers every repo kind', () => {
  const v = (kinds: RepoView['kinds'], groups: Array<Partial<RepoView['groups'][number]>> = []): RepoView => ({
    repoId: 'o/n', type: 'model', kinds, apparentBytes: 0, partialDownloads: 0,
    groups: groups.map((g) => ({ key: 'k', kind: 'other', label: 'l', files: [], apparentBytes: 0, locked: false, ...g })),
  });
  expect(badgeFor(v(['gguf'], [{ kind: 'quant' }, { kind: 'mmproj' }]))).toBe('GGUF · 1 quant');
  expect(badgeFor(v(['gguf'], []))).toBe('GGUF · 0 quants');
  expect(badgeFor(v(['diffusers']))).toBe('Diffusers pipeline');
  expect(badgeFor(v(['transformers'], [{ kind: 'weights', shards: { present: 3, expected: 3 } }]))).toBe('Safetensors · 3 shards');
  expect(badgeFor(v(['transformers'], [{ kind: 'weights', shards: { present: 1, expected: 1 } }]))).toBe('Transformers');
  expect(badgeFor(v(['transformers'], [{ kind: 'weights' }]))).toBe('Transformers');
  expect(badgeFor(v(['transformers']))).toBe('Transformers');
  expect(badgeFor(v(['adapter']))).toBe('LoRA adapter');
  expect(badgeFor(v(['single-file']))).toBe('Single-file checkpoint');
  expect(badgeFor(v(['component']))).toBe('VAE / component');
  expect(badgeFor(v(['dataset']))).toBe('Dataset');
  expect(badgeFor(v(['space']))).toBe('Space');
  expect(badgeFor(v(['unknown']))).toBe('Unknown');
  expect(badgeFor(v([]))).toBe('Unknown');
});

test('detail: groups, reclaimable bytes, usage, shards, locks', async () => {
  const { model, views, usage } = await scanFixture(await buildAppFixture());
  const detail = (id: string) => toRepoDetail(model, repoOf(model, id), viewOf(views, id), usage);
  const d = detail(Q);
  const g = (k: string) => d.groups.find((x) => x.key === k)!;
  expect(d).toMatchObject({ repoId: Q, type: 'model', kindLabel: 'GGUF · 4 quants', revisionShort: 'a3f9c1e', apparentBytes: 12_360,
    hasLockedGroups: false });
  expect(d.downloadedAtMs).toBeGreaterThan(0);
  expect(g('quant:Q8_0')).toMatchObject({ reclaimableBytes: 2870, usedBy: { lmstudio: [`${Q}/Qwen3.6-27B-Q8_0.gguf`], ollama: [] },
    warning: null, locked: false, shards: null });
  expect(g('quant:Q8_0').files).toEqual([
    { relpath: 'Qwen3.6-27B-Q8_0.gguf', commitShort: 'a3f9c1e', current: true, bytes: 2870, plainFile: false }]);
  expect(g('quant:BF16')).toMatchObject({ fileCount: 2, apparentBytes: 5380, reclaimableBytes: 5380, shards: { present: 2, expected: 2 } });
  expect(g('quant:Q6_K').reclaimableBytes).toBe(0); // hardlink
  expect(g('quant:Q6_K').apparentBytes).toBe(2210);
  const flux = detail(FLUX);
  expect(flux.hasLockedGroups).toBe(true);
  expect(flux.groups.filter((x) => x.kind === 'component').length).toBeGreaterThan(0);
  expect(flux.groups.filter((x) => x.kind === 'component').every((x) => x.locked)).toBe(true);
  expect(flux.groups.find((x) => x.label === 'flux1-dev.safetensors')?.locked).toBe(false);
  // a locked group still reports what it would free (the planner unlocks it only for this figure)
  expect(flux.groups.find((x) => x.label === 'vae/')!.reclaimableBytes).toBe(55);
  expect(detail('org/shared-a').groups.find((x) => x.kind === 'weights')!.reclaimableBytes).toBe(0);
  expect(detail('org/partial')).toMatchObject({ revisionShort: 'a3f9c1e', downloadedAtMs: null, groups: [] });
});

test('reclaimable bytes come from the planner closure: a blob a kept current file shares frees nothing', async () => {
  const fx = await buildFixture({ repos: [{ id: 'o/twins', snapshots: [{ files: [
    { path: 'a.gguf', blob: { key: 'same', bytes: 700 } }, { path: 'sub/b-Q4_K_M.gguf', blob: { key: 'same', bytes: 700 } },
  ] }] }] });
  const port = createCorePort({ userDataDir: fx.root, env: fx.env, home: fx.home, offline: true });
  const { model, views } = await inProcessScanRunner((await port.resolveHub()).hubRoot, () => undefined, new AbortController().signal);
  const d = toRepoDetail(model, model.repos[0]!, views[0]!, {});
  expect(d.groups.length).toBeGreaterThan(1);
  for (const grp of d.groups) {
    expect(grp.apparentBytes).toBe(700);
    expect(grp.reclaimableBytes).toBe(0);
  }
});

test('superseded group warning: incomplete download, or old files missing from the current revision (carries 4, 5)', async () => {
  const OLD = '1'.repeat(40);
  const NEW = '2'.repeat(40);
  const repo = (id: string, oldFiles: string[], incomplete: boolean) => ({
    id, main: 0, ...(incomplete ? { incomplete: [{ bytes: 5, mtimeMs: Date.now() - 86_400_000 }] } : {}),
    snapshots: [
      { commit: NEW, files: [{ path: 'model.safetensors', blob: { key: `${id}:new`, bytes: 10 } }, { path: 'config.json', blob: { key: `${id}:c`, bytes: 3 } }] },
      { commit: OLD, files: oldFiles.map((p) => ({ path: p, blob: { key: `${id}:old:${p}`, bytes: 7 } })) },
    ],
  });
  const fx = await buildFixture({ repos: [
    repo('o/missing', ['model.safetensors', 'only-old.bin'], false),
    repo('o/incomplete', ['model.safetensors'], true),
    repo('o/clean', ['model.safetensors'], false),
  ] });
  const port = createCorePort({ userDataDir: fx.root, env: fx.env, home: fx.home, offline: true });
  const { model, views } = await inProcessScanRunner((await port.resolveHub()).hubRoot, () => undefined, new AbortController().signal);
  const sup = (id: string) => toRepoDetail(model, repoOf(model, id), viewOf(views, id), {}).groups.find((x) => x.kind === 'superseded')!;
  expect(sup('o/missing').warning).toBe(SUPERSEDED_WARNING);
  expect(sup('o/incomplete').warning).toBe(SUPERSEDED_WARNING);
  expect(sup('o/clean').warning).toBeNull();
  expect(SUPERSEDED_WARNING).toBe('An update may be in progress or incomplete: some of these files are the only copy of files missing from the current revision.');
  expect(sup('o/clean').files.every((f) => !f.current && f.commitShort === '1111111')).toBe(true);
  // other groups never warn
  expect(toRepoDetail(model, repoOf(model, 'o/missing'), viewOf(views, 'o/missing'), {}).groups
    .filter((x) => x.kind !== 'superseded').every((x) => x.warning === null)).toBe(true);
});

test('reason and action copy', () => {
  const r = (reason: Parameters<typeof reasonText>[0]['reason'], sharedWith?: string[]) =>
    reasonText({ path: 'p', bytes: 0, reason, ...(sharedWith ? { sharedWith } : {}) });
  expect(r('only-link')).toBe('only link');
  expect(r('hardlink-others-remain', ['x'])).toBe('hardlink, 1 other link — not freed');
  expect(r('hardlink-others-remain', ['x', 'y'])).toBe('hardlink, 2 other links — not freed');
  expect(r('hardlink-others-remain')).toBe('hardlink, other links remain — not freed');
  expect(r('hardlink-others-remain', [])).toBe('hardlink, other links remain — not freed');
  expect(r('hardlink-all-planned')).toBe('hardlink, every link removed');
  expect(r('store-shared', ['org/shared-b'])).toBe('shared with org/shared-b — not freed');
  expect(r('store-shared', ['a', 'b'])).toBe('shared with a, b — not freed');
  expect(r('store-shared')).toBe('shared with other repos — not freed');
  expect(r('store-unreferenced')).toBe('shared store, no other references');
  expect(r('store-uncertain', ['x'])).toBe('shared store state uncertain — kept, counted as 0');
  expect(r('link-only')).toBe('link only — no data freed');
  expect(r('plain-file')).toBe('plain file');
  expect(r('special-file')).toBe('special file (fifo/socket/device) — no data freed');
  const a = (action: Parameters<typeof actionText>[0]['action'], note?: string) =>
    actionText({ view: 'lmstudio', path: 'a', action, ...(note !== undefined ? { note } : {}) });
  expect(a('remove')).toBe('will be removed');
  expect(a('keep-shared', 'also owned by x')).toBe('kept — another entry still uses it');
  expect(a('state-update')).toBe('sync state updated');
  expect(a('blocked', 'hub has no repos')).toBe('blocked — hub has no repos');
  expect(a('blocked')).toBe('blocked — not updated');
  expect(a('foreign', 'regular file at an owned path; left in place')).toBe('left in place — regular file at an owned path; left in place');
  expect(a('foreign')).toBe('left in place — not ours');
});

test('shortHash keeps four leading and two trailing characters', () => {
  expect(shortHash('a'.repeat(30) + 'bcdef0123456789')).toBe('aaaa…89');
  expect(shortHash(COMMIT)).toBe('a3f9…d1');
});

test('displayPath: repo folders, shared store, views, Recently Deleted, home and anything else', async () => {
  const { model, ctx, fx } = await scanFixture(await buildAppFixture());
  const q = repoOf(model, Q);
  const hub = model.hubRoot;
  const etag = q.files.find((f) => f.relpath === 'Qwen3.6-27B-Q8_0.gguf')!.blobEtag!;
  expect(displayPath(join(q.folder, 'snapshots', COMMIT, 'BF16', 'x.gguf'), ctx)).toEqual({ repoId: Q, text: 'snapshots/a3f9c1e/BF16/x.gguf' });
  expect(displayPath(join(q.folder, 'blobs', etag), ctx)).toEqual({ repoId: Q, text: `blobs/${shortHash(etag)}` });
  expect(displayPath(join(q.folder, 'refs', 'main'), ctx)).toEqual({ repoId: Q, text: 'refs/main' });
  expect(displayPath(q.folder, ctx)).toEqual({ repoId: Q, text: '(repo folder)' });
  // a repo folder the model no longer has (a restore puts it back) is still named by its folder
  expect(displayPath(join(hub, 'datasets--o--gone', 'snapshots', 'x'), ctx)).toEqual({ repoId: 'o/gone', text: 'snapshots/x' });
  // a snapshot name that is not a 40-hex commit is left alone
  expect(displayPath(join(q.folder, 'snapshots', 'abc', 'f'), ctx).text).toBe('snapshots/abc/f');
  const h = 'ab' + 'c'.repeat(62);
  expect(displayPath(join(hub, 'blobs', 'ab', h), ctx)).toEqual({ repoId: null, text: `shared store/ab/${shortHash(h)}` });
  expect(displayPath(join(hub, 'blobs', 'ab', `${h}.refs`), ctx)).toEqual({ repoId: null, text: `shared store/ab/${shortHash(h)}.refs` });
  const lm = ctx.viewRoots.lmstudio!;
  expect(displayPath(join(lm, 'o', 'n', 'f.gguf'), ctx)).toEqual({ repoId: null, text: `${lm}/o/n/f.gguf` });
  const hold = ctx.holdRoot!;
  const id = '2026-10-25T14-03-07-123Z-1a2b3c4d';
  expect(displayPath(join(hold, id, q.folderName, 'snapshots', COMMIT, 'a.gguf'), ctx))
    .toEqual({ repoId: Q, text: `Recently Deleted/${id}/${q.folderName}/snapshots/a3f9c1e/a.gguf` });
  expect(displayPath(join(hold, id, 'store', 'ab', h), ctx)).toEqual({ repoId: null, text: `Recently Deleted/${id}/store/ab/${shortHash(h)}` });
  expect(displayPath(join(hold, id, 'manifest.json'), ctx)).toEqual({ repoId: null, text: `Recently Deleted/${id}/manifest.json` });
  expect(displayPath(hold, ctx)).toEqual({ repoId: null, text: 'Recently Deleted' });
  expect(displayPath(join(fx.home, 'x', 'y'), ctx)).toEqual({ repoId: null, text: '~/x/y' });
  expect(displayPath(fx.home, ctx)).toEqual({ repoId: null, text: '~' });
  expect(displayPath(join(fx.root, 'elsewhere'), ctx)).toEqual({ repoId: null, text: join(fx.root, 'elsewhere') });
  // the view root itself is shown with ~ when it lies under home
  const homeCtx: DtoContext = { ...ctx, home: fx.root };
  expect(displayPath(join(lm, 'a'), homeCtx).text).toBe(`~/${lm.slice(fx.root.length + 1)}/a`);
});

async function q8bf16(s: Scanned) {
  return s.port.planDeletion(s.model, { repos: [{ repoId: Q, whole: false, groupKeys: ['quant:Q8_0', 'quant:BF16'], unlockComponents: false }] },
    s.r, s.config, Date.now());
}

test('toPlanDTO for Q8_0 + BF16 (permanent) matches the mockup content', async () => {
  const s = await scanFixture(await buildAppFixture());
  const pair = await q8bf16(s);
  const p = toPlanDTO(pair.permanent, s.ctx);
  expect(p).toMatchObject({ planId: pair.permanent.id, fingerprint: pair.permanent.fingerprint, mode: 'permanent', purpose: 'delete',
    title: `Review deletion — ${Q}`, repoIds: [Q], groupCount: 2, filesRemoved: 3,
    freedBytes: 8250, apparentBytes: 8250, sharedBytes: 0, confirmPhrase: Q, holdRootDisplay: null,
    createdAt: pair.permanent.createdAt, expiresAt: pair.permanent.expiresAt, viewsUnaffected: [] });
  expect(p.files.map((f) => [f.displayPath, f.reasonText, f.bytes]).sort()).toEqual([
    ['snapshots/a3f9c1e/BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', 'only link', 4990],
    ['snapshots/a3f9c1e/BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf', 'only link', 390],
    ['snapshots/a3f9c1e/Qwen3.6-27B-Q8_0.gguf', 'only link', 2870]]);
  for (const f of p.files) {
    expect(f).toMatchObject({ repoId: Q, otherLinks: 0, reason: 'only-link' });
    expect(f.blobShort).toMatch(/^[0-9a-f]{4}…[0-9a-f]{2}$/);
    // The exact file, full hash and all, is shown too
    expect(f.fullPath.startsWith(`${s.model.hubRoot}/models--unsloth--Qwen3.6-27B-GGUF/blobs/`)).toBe(true);
    expect(f.fullPath).toMatch(/\/blobs\/[0-9a-f]{40,64}$/);
  }
  const lmDisplay = s.ctx.viewRoots.lmstudio!;
  expect(p.viewLines.filter((l) => l.action === 'remove').map((l) => l.displayPath))
    .toEqual([`${lmDisplay}/${Q}/Qwen3.6-27B-Q8_0.gguf`]);
  expect(p.viewLines.find((l) => l.action === 'remove')).toMatchObject({ view: 'lmstudio', actionText: 'will be removed',
    key: `${Q}:Qwen3.6-27B-Q8_0.gguf`, entryKind: 'symlink', note: null });
  expect(p.viewLines.find((l) => l.action === 'keep-shared')).toMatchObject({ displayPath: `${lmDisplay}/${Q}/mmproj-F16.gguf`,
    actionText: 'kept — another entry still uses it', entryKind: null, note: expect.stringContaining('also owned by') });
  expect(p.viewLines.find((l) => l.action === 'state-update')).toMatchObject({ entryKind: 'state', actionText: 'sync state updated' });
  expect(p.kept.reduce((a, k) => a + k.bytes, 0)).toBe(4110);
  // The kept section names the exact files that stay, every one with its absolute path
  const qFolder = s.model.repos.find((r) => r.id === Q)!.folder;
  expect(p.keptFiles.map((k) => k.displayPath)).toEqual([
    'snapshots/a3f9c1e/Qwen3.6-27B-Q6_K.gguf', 'snapshots/a3f9c1e/Qwen3.6-27B-UD-Q4_K_XL.gguf', 'snapshots/a3f9c1e/README.md',
    'snapshots/a3f9c1e/images/a.png', 'snapshots/a3f9c1e/mmproj-F16.gguf',
  ]);
  for (const k of p.keptFiles) {
    expect(k.repoId).toBe(Q);
    expect(k.fullPath).toBe(join(qFolder, 'snapshots', COMMIT, ...k.displayPath.split('/').slice(2)));
    expect(pair.permanent.ops.some((o) => 'path' in o && o.path === k.fullPath)).toBe(false);
  }
  expect(toPlanDTO(pair.hold!, s.ctx).keptFiles).toEqual(p.keptFiles);   // the hold review keeps the same files
  expect(p.ops.length).toBe(pair.permanent.ops.length);
  expect(p.ops.map((o) => o.kind)).toEqual(pair.permanent.ops.map((o) => o.kind));
  expect(p.ops.find((o) => o.kind === 'write-file')).toMatchObject({ role: 'view-state', displayPath: `${lmDisplay}/.hfhub-state.json` });
  // the BF16 subfolder is left empty and removed; no view folder is
  expect(p.ops.filter((o) => o.kind === 'rmdir-empty').map((o) => o.displayPath)).toEqual(['snapshots/a3f9c1e/BF16']);
  expect(p.viewLines.some((l) => l.entryKind === 'folder')).toBe(false);
  expect(p.warnings).toEqual(pair.permanent.warnings);
  expect(primary(p)).not.toContain(COMMIT); // no full hashes in the primary UI
  for (const e of Object.keys(repoOf(s.model, Q).blobs)) expect(primary(p)).not.toContain(e);
});

test('toPlanDTO of the hold plan: same rows, no phrase, the Recently Deleted folder shown', async () => {
  const s = await scanFixture(await buildAppFixture());
  const pair = await q8bf16(s);
  expect(pair.hold).not.toBeNull();
  const h = toPlanDTO(pair.hold!, s.ctx);
  const p = toPlanDTO(pair.permanent, s.ctx);
  expect(h).toMatchObject({ mode: 'hold', confirmPhrase: null, holdRootDisplay: s.ctx.holdRoot, freedBytes: 8250, filesRemoved: 3 });
  expect(h.files).toEqual(p.files);
  expect(h.ops.filter((o) => o.kind === 'hold-rename').every((o) => o.displayPath.startsWith('snapshots/') || o.displayPath.startsWith('blobs/'))).toBe(true);
});

test('whole repo: one group, every view link, owner keys and emptied folders listed', async () => {
  const s = await scanFixture(await buildAppFixture());
  const pair = await s.port.planDeletion(s.model, { repos: [{ repoId: Q, whole: true }] }, s.r, s.config, Date.now());
  const p = toPlanDTO(pair.permanent, s.ctx);
  expect(p.keptFiles).toEqual([]);   // A whole repo keeps no file (its hold plan is one folder rename)
  expect(toPlanDTO(pair.hold!, s.ctx).keptFiles).toEqual([]);
  const lm = s.ctx.viewRoots.lmstudio!;
  // everything but the Q6_K hardlink is freed (refs/main and the other plain files of the folder too)
  expect(p).toMatchObject({ groupCount: 1, title: `Review deletion — ${Q}`, freedBytes: pair.permanent.freed.bytes, sharedBytes: 2210 });
  expect(p.freedBytes).toBeGreaterThanOrEqual(12_360 - 2210);
  expect(p.files.find((f) => f.reason === 'hardlink-others-remain')).toMatchObject({
    displayPath: 'snapshots/a3f9c1e/Qwen3.6-27B-Q6_K.gguf', reasonText: 'hardlink, 1 other link — not freed', bytes: 0 });
  const removes = p.viewLines.filter((l) => l.action === 'remove');
  expect(removes.filter((l) => l.entryKind === 'symlink').map((l) => l.displayPath).sort()).toEqual(
    [`${lm}/${Q}/Qwen3.6-27B-Q8_0.gguf`, `${lm}/${Q}/Qwen3.6-27B-UD-Q4_K_XL.gguf`, `${lm}/${Q}/mmproj-F16.gguf`]);
  // The shared mmproj link lists every key that owned it
  expect(removes.find((l) => l.displayPath.endsWith('mmproj-F16.gguf'))!.key)
    .toBe(`${Q}:Qwen3.6-27B-Q8_0.gguf, ${Q}:Qwen3.6-27B-UD-Q4_K_XL.gguf`);
  // View rmdir-empty ops are review lines too
  const folders = removes.filter((l) => l.entryKind === 'folder');
  expect(folders.map((l) => l.displayPath)).toContain(`${lm}/${Q}`);
  expect(folders.every((l) => l.actionText === 'empty folder removed' && l.view === 'lmstudio' && l.key === null)).toBe(true);
  expect(p.ops.filter((o) => o.kind === 'rmdir-empty').map((o) => o.displayPath)).toContain('(repo folder)');
  expect(primary(p)).not.toContain(COMMIT);
});

test('several repos, a shared-store repo and views left alone', async () => {
  const s = await scanFixture(await buildAppFixture());
  const pair = await s.port.planDeletion(s.model, { repos: [
    { repoId: 'org/shared-a', whole: true },
    { repoId: Q, whole: false, groupKeys: ['quant:Q6_K'], unlockComponents: false },
  ] }, s.r, s.config, Date.now());
  const p = toPlanDTO(pair.permanent, s.ctx);
  expect(p).toMatchObject({ title: 'Review deletion — 2 repos', repoIds: ['org/shared-a', Q], groupCount: 2,
    confirmPhrase: 'delete 2 repos', viewsUnaffected: ['lmstudio'] });
  const store = p.files.find((f) => f.reason === 'store-shared')!;
  expect(store).toMatchObject({ repoId: null, reasonText: 'shared with org/shared-b — not freed', bytes: 0, blobShort: null, otherLinks: 0 });
  expect(store.displayPath).toMatch(/^shared store\/[0-9a-f]{2}\/[0-9a-f]{4}…[0-9a-f]{2}$/);
  expect(p.sharedBytes).toBe(p.apparentBytes - p.freedBytes);
  expect(p.ops.find((o) => o.kind === 'store-sweep')!.displayPath).toBe(store.displayPath);
});

test('viewsUnaffected leaves out a view with a blocked line; folder lines need a view root', async () => {
  const s = await scanFixture(await buildAppFixture());
  const pair = await q8bf16(s);
  const blocked: DeletionPlan = { ...pair.permanent, ops: [], viewImpact: [{ view: 'lmstudio', path: '', action: 'blocked', note: 'x' }] };
  const p = toPlanDTO(blocked, { ...s.ctx, configuredViews: ['lmstudio', 'ollama'] });
  expect(p.viewsUnaffected).toEqual(['ollama']);
  expect(p.viewLines).toEqual([{ view: 'lmstudio', displayPath: s.ctx.viewRoots.lmstudio, action: 'blocked', actionText: 'blocked — x',
    key: null, note: 'x', entryKind: null, fullPath: s.ctx.viewRoots.lmstudio }]);
  // a view line whose view has no known root shows its relative path
  const noRoot = toPlanDTO({ ...blocked, viewImpact: [{ view: 'ollama', path: 'm/x', action: 'foreign', note: 'n' }] },
    { ...s.ctx, viewRoots: { lmstudio: null, ollama: null } });
  expect(noRoot.viewLines[0]!.displayPath).toBe('m/x');
  // an unreadable state text falls back to the line's own key
  const stateOp = pair.permanent.ops.find((o) => o.kind === 'write-file')!;
  const broken: DeletionPlan = { ...pair.permanent, ops: pair.permanent.ops.map((o) => (o === stateOp ? { ...stateOp, before: '{' } : o)) };
  expect(toPlanDTO(broken, s.ctx).viewLines.find((l) => l.action === 'remove')!.key).toBe(`${Q}:Qwen3.6-27B-Q8_0.gguf`);
});

test('superseded selection carries the warning into the plan DTO', async () => {
  const OLD = '1'.repeat(40);
  const fx = await buildFixture({ repos: [{ id: 'o/upd', main: 0, snapshots: [
    { commit: '2'.repeat(40), files: [{ path: 'model.safetensors', blob: { key: 'new', bytes: 10 } }] },
    { commit: OLD, files: [{ path: 'gone.bin', blob: { key: 'old', bytes: 7 } }] },
  ] }] });
  const port = createCorePort({ userDataDir: fx.root, env: fx.env, home: fx.home, offline: true });
  const hub = await port.resolveHub();
  const { model, views } = await inProcessScanRunner(hub.hubRoot, () => undefined, new AbortController().signal);
  const loaded = await port.loadConfig();
  if (!loaded.ok) throw new Error(loaded.error);
  const r = await port.roots(hub.hubRoot, loaded.config);
  const key = views[0]!.groups.find((g) => g.kind === 'superseded')!.key;
  const pair = await port.planDeletion(model, { repos: [{ repoId: 'o/upd', whole: false, groupKeys: [key], unlockComponents: false }] },
    r, loaded.config, Date.now());
  expect(toPlanDTO(pair.permanent, port.dtoContext(model, r, loaded.config)).warnings).toContain(SUPERSEDED_WARNING);
  const whole = await port.planDeletion(model, { repos: [{ repoId: 'o/upd', whole: true }] }, r, loaded.config, Date.now());
  expect(toPlanDTO(whole.permanent, port.dtoContext(model, r, loaded.config)).warnings).not.toContain(SUPERSEDED_WARNING);
});

test('restore and empty plans: titles, the files they move back or remove, Recently Deleted paths', async () => {
  const s = await scanFixture(await buildAppFixture());
  const pair = await q8bf16(s);
  const res = await s.port.executePlan(pair.hold!, s.model, s.r);
  expect(res.ok).toBe(true);
  const { model } = await inProcessScanRunner(s.model.hubRoot, () => undefined, new AbortController().signal);
  const ctx = s.port.dtoContext(model, s.r, s.config);
  const restore = await s.port.planRestore(model, s.r, pair.hold!.deletionId!, Date.now());
  const rd = toPlanDTO(restore, ctx);
  expect(rd).toMatchObject({ title: 'Restore from Recently Deleted', purpose: 'restore', mode: 'hold', groupCount: 0, repoIds: [Q],
    confirmPhrase: null, freedBytes: 0 });
  expect(rd.warnings).toContain(RESTORE_SYNC_HINT);
  const moves = rd.files.filter((f) => f.reason === 'restore-move');
  expect(moves.map((f) => f.displayPath).sort()).toEqual(expect.arrayContaining(['snapshots/a3f9c1e/Qwen3.6-27B-Q8_0.gguf']));
  expect(moves.every((f) => f.reasonText === 'moves back' && f.repoId === Q)).toBe(true);
  expect(moves.every((f) => f.fullPath.startsWith(`${model.hubRoot}/`))).toBe(true); // the destination, in full
  expect(moves.reduce((a, f) => a + f.bytes, 0)).toBe(8250); // the blobs (regular files) moving back
  expect(rd.filesRemoved).toBe(rd.files.length);
  expect(primary(rd)).not.toContain(COMMIT);

  const empty = await s.port.planEmpty(s.r, [pair.hold!.deletionId!], Date.now());
  const ed = toPlanDTO(empty.plans[0]!, ctx);
  expect(ed).toMatchObject({ title: 'Empty Recently Deleted', purpose: 'empty', mode: 'permanent', groupCount: 0, repoIds: [Q], confirmPhrase: null });
  expect(ed.files.every((f) => f.displayPath.startsWith(`Recently Deleted/${pair.hold!.deletionId}/`))).toBe(true);
  expect(ed.files.some((f) => f.displayPath.endsWith('/manifest.json') && f.reason === 'plain-file')).toBe(true);
  expect(ed.freedBytes).toBeGreaterThan(8250);
  // The batch figures, sharedBytes included, are computed here in main, never in the UI
  const batch = toEmptyPlanDTO([ed, { ...ed, freedBytes: 10, apparentBytes: 30, sharedBytes: 20 }], ['x: unreadable']);
  expect(batch).toEqual({ plans: [ed, expect.objectContaining({ sharedBytes: 20 })], skipped: ['x: unreadable'],
    freedBytes: ed.freedBytes + 10, apparentBytes: ed.apparentBytes + 30, sharedBytes: ed.sharedBytes + 20 });
});

test('a restore that re-adds a shared-store reference shows a .refs row', async () => {
  const s = await scanFixture(await buildAppFixture());
  const pair = await s.port.planDeletion(s.model, { repos: [{ repoId: 'org/shared-a', whole: true }] }, s.r, s.config, Date.now());
  expect((await s.port.executePlan(pair.hold!, s.model, s.r)).ok).toBe(true);
  const { model } = await inProcessScanRunner(s.model.hubRoot, () => undefined, new AbortController().signal);
  const ctx = s.port.dtoContext(model, s.r, s.config);
  const rd = toPlanDTO(await s.port.planRestore(model, s.r, pair.hold!.deletionId!, Date.now()), ctx);
  const refs = rd.files.find((f) => f.reason === 'restore-refs')!;
  expect(refs).toMatchObject({ reasonText: '.refs re-added', bytes: 0, repoId: null });
  expect(refs.displayPath).toMatch(/^shared store\/.*\.refs$/);
  expect(rd.files.find((f) => f.reason === 'restore-move')).toMatchObject({ displayPath: '(repo folder)', repoId: 'org/shared-a', bytes: 0 });
});

test('a view is unaffected only when it has no lines at all (foreign and keep-shared lines count)', async () => {
  const s = await scanFixture(await buildAppFixture());
  const pair = await q8bf16(s);
  const ctx: DtoContext = { ...s.ctx, configuredViews: ['lmstudio', 'ollama'] };
  const only = (l: DeletionPlan['viewImpact'][number]) => toPlanDTO({ ...pair.permanent, ops: [], viewImpact: [l] }, ctx).viewsUnaffected;
  expect(only({ view: 'ollama', path: 'blobs/x', action: 'foreign', note: 'not created by sync; left in place and will dangle' }))
    .toEqual(['lmstudio']);
  expect(only({ view: 'ollama', path: '', action: 'foreign', note: 'other links to deleted files not checked: EACCES' })).toEqual(['lmstudio']);
  expect(only({ view: 'lmstudio', path: 'a/b', action: 'keep-shared', key: 'k', note: 'also owned by j' })).toEqual(['ollama']);
  expect(only({ view: 'lmstudio', path: '.hfhub-state.json', action: 'state-update', note: 'n' })).toEqual(['ollama']);
  expect(toPlanDTO({ ...pair.permanent, ops: [], viewImpact: [] }, ctx).viewsUnaffected).toEqual(['lmstudio', 'ollama']);
});

test('reclaimable is null (unknown) when the planner cannot tell, never 0', async () => {
  const { model, views, usage } = await scanFixture(await buildAppFixture());
  const repo = repoOf(model, Q);
  const view = viewOf(views, Q);
  const bogus: RepoView = { ...view, groups: [...view.groups, { ...view.groups[0]!, key: 'quant:NOPE', label: 'NOPE' }] };
  const d = toRepoDetail(model, repo, bogus, usage);
  expect(d.groups.find((g) => g.key === 'quant:NOPE')!.reclaimableBytes).toBeNull();
  expect(d.groups.find((g) => g.key === 'quant:Q8_0')!.reclaimableBytes).toBe(2870);
  expect(d.groups.find((g) => g.key === 'quant:Q6_K')!.reclaimableBytes).toBe(0); // a real 0 stays 0
  // a repo object the model does not hold (an ambiguous id would plan another repo): unknown too
  expect(toRepoDetail(model, { ...repo }, view, usage).groups.every((g) => g.reclaimableBytes === null)).toBe(true);
});

test('Ollama view lines and ops show blob paths in short form and keep the full path', async () => {
  const R = 'acme/Tiny-GGUF';
  const G15 = { arch: 'llama', fileType: 15, tensors: [[4, 4]] };
  const q4 = sha256Hex(ggufBytes(G15));
  const lc = await loadCase({ repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [{ path: 'Tiny-Q4_K_M.gguf', gguf: G15 }] }] }],
    views: ['ollama'] });
  const fetch = fakeFetch({ status: 404 });
  const port = createCorePort({ userDataDir: lc.c.dir, env: lc.c.env, home: lc.c.home, offline: false, fetch,
    // a case hub sits directly in its temp dir, whose parent the guard refuses to inspect: no hold root needed here
    makeSafeFs: (roots) => SafeFs.create({ ...roots, holdRoot: null }, guardedFs()) });
  const hub = await port.resolveHub();
  if (!hub.present) throw new Error('hub missing');
  const loaded = await port.loadConfig();
  if (!loaded.ok) throw new Error(loaded.error);
  const r = await port.roots(hub.hubRoot, loaded.config);
  const synced = await port.executeSync(await port.planSync(lc.model, loaded.config, Date.now()), { allowMassRemoval: false }, r);
  expect(synced.views.every((v) => v.status === 'applied')).toBe(true);
  const model = (await inProcessScanRunner(hub.hubRoot, () => undefined, new AbortController().signal)).model;
  const ctx = port.dtoContext(model, r, loaded.config);
  const pair = await port.planDeletion(model, { repos: [{ repoId: R, whole: true }] }, r, loaded.config, Date.now());
  const p = toPlanDTO(pair.permanent, ctx);
  const ol = ctx.viewRoots.ollama!;
  const blobLines = p.viewLines.filter((l) => l.action === 'remove' && l.fullPath.startsWith(join(ol, 'blobs') + '/'));
  expect(blobLines.length).toBeGreaterThan(1); // the model layer and the synthesised config blob
  for (const l of blobLines) expect(l.displayPath).toMatch(new RegExp(`^${ol}/blobs/sha256-[0-9a-f]{12}…$`));
  const blobLine = blobLines.find((l) => l.fullPath.endsWith(q4))!;
  // the model layer is a link into the hub; the synthesised config blob is a regular file in the view
  expect(blobLines.map((l) => l.entryKind).sort()).toEqual(['blob', 'symlink']);
  expect(blobLine).toMatchObject({ view: 'ollama', action: 'remove', entryKind: 'symlink', displayPath: `${ol}/blobs/sha256-${q4.slice(0, 12)}…`,
    fullPath: join(ol, 'blobs', `sha256-${q4}`) });
  const manifest = p.viewLines.find((l) => l.entryKind === 'manifest')!;
  expect(manifest).toMatchObject({ action: 'remove', key: `${R}:Tiny-Q4_K_M.gguf`, displayPath: `${ol}/manifests/hf.co/${R}/Q4_K_M` });
  expect(manifest.fullPath).toBe(join(ol, 'manifests', 'hf.co', ...R.split('/'), 'Q4_K_M'));
  const blobOp = p.ops.find((o) => o.fullPath === blobLine.fullPath)!;
  expect(blobOp).toMatchObject({ displayPath: blobLine.displayPath, fullPath: blobLine.fullPath });
  expect(p.viewsUnaffected).not.toContain('ollama');
  expect(primary(p)).not.toContain(q4);
});
