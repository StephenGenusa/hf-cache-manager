import { createServer } from 'node:net';
import { existsSync, lstatSync, truncateSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pySort } from '../../../src/core/compat/pyjson';
import { factsOf, nodeFs } from '../../../src/core/fsx';
import { SafeFsError } from '../../../src/core/safe-fs';
import { ggufEntries } from '../../../src/core/views/entries';
import { aliasManifestPath, blobRel, deriveTags, manifestLayerHex, ollamaDriver, referencedDigests, referencingManifests, safeTag } from '../../../src/core/views/ollama';
import { MT } from '../../../src/core/views/registry';
import type { ApplyCtx, Desired } from '../../../src/core/views/view-types';
import type { FileFacts } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { failingFs, scriptedFs } from '../../helpers/failing-fs';
import { entry, loadCase, sha256Hex, type CaseSpec, type LoadedCase } from './_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const R = 'acme/Tiny-GGUF';
const spec: CaseSpec = { repos: [{ id: R, main: 'c2', snapshots: [{ commit: 'c2', mtime: 2, files: [
  { path: 'Tiny-Q4_K_M.gguf', text: 'q4' }, { path: 'mmproj-F16.gguf', text: 'pf' },
  { path: 'Big-Q8_0-00001-of-00002.gguf', text: 's1' }] }] }], views: ['ollama'] };
const ALIASES = { tiny: `${R}:Tiny-Q4_K_M.gguf` };
const q4 = sha256Hex('q4');
const pf = sha256Hex('pf');
const M1 = `manifests/hf.co/${R}/Q4_K_M`;
const ALIAS = 'manifests/registry.ollama.ai/library/tiny/latest';

const stub = async (): Promise<string[]> => [];
/**
 * Listens on a Unix socket at `dir/name`. sun_path is limited to ~107 bytes and Stryker's TMPDIR (inside the project)
 * lengthens the absolute path, so bind through a short symlink to `dir` beside the case root (as empty.test.ts does).
 */
async function listenAt(lc: LoadedCase, dir: string, name: string): Promise<ReturnType<typeof createServer>> {
  const server = createServer();
  const short = path.join(lc.c.dir, 'k');
  symlinkSync(dir, short);
  try { await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(path.join(short, name), res); }); }
  finally { unlinkSync(short); }
  return server;
}
interface Setup { lc: LoadedCase; root: string; drv: ReturnType<typeof ollamaDriver>; d: Desired; ds: Desired[]; warnings: string[] }
async function setup(s: CaseSpec = spec, aliases: Record<string, string> = ALIASES): Promise<Setup> {
  const lc = await loadCase(s);
  const root = realpathSync(lc.c.ollama!);
  const drv = ollamaDriver(root, lc.model.hubRoot, aliases, stub, lc.fs);
  const warnings: string[] = [];
  const ds = drv.desired(ggufEntries(lc.model), warnings);
  return { lc, root, drv, ds, d: ds.find((x) => x.key === `${R}:Tiny-Q4_K_M.gguf`)!, warnings };
}
function ctxOf(lc: LoadedCase, planned: Map<string, FileFacts | null> = new Map()): ApplyCtx {
  return { safeFs: lc.safeFs, fs: lc.fs, expect: (rel) => planned.get(rel), warnings: [] };
}
async function plan(lc: LoadedCase, root: string, rels: string[]): Promise<Map<string, FileFacts | null>> {
  const m = new Map<string, FileFacts | null>();
  for (const r of rels) m.set(r, await factsOf(lc.fs, path.join(root, r)));
  return m;
}
const man = (layers: Array<[string, string]>, cfg?: string): string => JSON.stringify({
  schemaVersion: 2, mediaType: MT.manifest, layers: layers.map(([mediaType, d]) => ({ mediaType, digest: `sha256:${d}`, size: 1 })),
  ...(cfg === undefined ? {} : { config: { digest: `sha256:${cfg}`, mediaType: MT.config, size: 1 } }),
});
function put(root: string, rel: string, text: string): void {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function link(root: string, rel: string, target: string): void {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  symlinkSync(target, p);
}
const blobTarget = (lc: LoadedCase, sha: string): string => path.join(lc.model.hubRoot, 'models--acme--Tiny-GGUF', 'blobs', sha);
/** A fully created view for q4: both blob links, our manifest (+ config c1), and the alias. */
function fullView(s: Setup): void {
  link(s.root, blobRel(q4), blobTarget(s.lc, q4));
  link(s.root, blobRel(pf), blobTarget(s.lc, pf));
  put(s.root, M1, man([[MT.model, q4], [MT.projector, pf]], 'c1'));
  put(s.root, 'blobs/sha256-c1', '{}');
  put(s.root, ALIAS, man([[MT.model, q4], [MT.projector, pf]], 'c1'));
}

describe('ollama tags and alias paths', () => {
  it.each([
    [['Qwen3.6-27B-UD-Q4_K_XL.gguf'], ['UD-Q4_K_XL']], [['model-Q8_0.gguf'], ['Q8_0']], [['gpt-oss-20b-MXFP4.gguf'], ['MXFP4']],
    [['m-MXFP4_MOE.gguf'], ['MXFP4_MOE']], [['foo-bf16.gguf'], ['bf16']], [['Model-IQ2_XXS.gguf'], ['IQ2_XXS']],
    [['x.Q4_K_M.GGUF'], ['Q4_K_M']], [['weird name.gguf'], ['weird_name.gguf']],
    [['a/m-Q4_K_M.gguf', 'b/m-q4_k_m.gguf'], ['a_m-Q4_K_M.gguf', 'b_m-q4_k_m.gguf']],
  ])('deriveTags %j -> %j', (rels, tags) => {
    const es = rels.map((r) => entry({ relpath: r }));
    expect(es.map((e) => deriveTags(es).get(e.key))).toEqual(tags);
  });

  it('deriveTags ignores shards and projectors, and groups per repo', () => {
    const es = [entry({ relpath: 'a-Q4_K_M.gguf' }), entry({ relpath: 'mmproj-F16.gguf' }),
      entry({ relpath: 'b-Q8_0-00001-of-00002.gguf', isShard: true }), entry({ repoId: 'o/other', relpath: 'z-Q4_K_M.gguf' })];
    expect([...deriveTags(es).entries()]).toEqual([[`${R}:a-Q4_K_M.gguf`, 'Q4_K_M'], ['o/other:z-Q4_K_M.gguf', 'Q4_K_M']]);
  });

  it('safeTag replaces per code point and a non-ASCII quant falls back to the safe basename', () => {
    expect(safeTag('a b\u{1F600}c')).toBe('a_b_c');
    expect(deriveTags([entry({ relpath: 'm-Q4_é.gguf' })]).get(`${R}:m-Q4_é.gguf`)).toBe('m-Q4__.gguf');
  });

  it.each([
    ['qwen3.6:27b', 'manifests/registry.ollama.ai/library/qwen3.6/27b'], ['me/qwen', 'manifests/registry.ollama.ai/me/qwen/latest'],
    ['a/b/c:t', 'manifests/registry.ollama.ai/a/b/c/t'], ['x:', 'manifests/registry.ollama.ai/library/x/latest'],
  ])('aliasManifestPath(%s)', (a, p) => expect(aliasManifestPath(a)).toBe(p));

  it('blobRel names the blob by digest', () => expect(blobRel('ab')).toBe('blobs/sha256-ab'));
});

describe('ollama desired: paths the state file would reject', () => {
  it('an entry whose manifest or alias path has a `..` segment is skipped with a warning, never desired', () => {
    const ok = entry({ repoId: 'acme/Fine-GGUF', relpath: 'f-Q4_K_M.gguf' });
    const bad = entry({ repoId: 'acme/..', relpath: 'x-Q4_K_M.gguf' });
    const aliased = entry({ repoId: 'acme/Other-GGUF', relpath: 'o-Q8_0.gguf' });
    const drv = ollamaDriver('/v', '/hub', { '../../up:t': aliased.key }, stub, nodeFs);
    const warnings: string[] = [];
    const ds = drv.desired([bad, ok, aliased], warnings);
    expect(ds.map((d) => d.key)).toEqual([ok.key]);
    expect(warnings).toEqual([
      `[ollama] ${bad.key}: view path manifests/hf.co/acme/../Q4_K_M lies outside the view; skipped`,
      `[ollama] ${aliased.key}: view path manifests/registry.ollama.ai/../../up/t lies outside the view; skipped`]);
  });
});

describe('ollama desired', () => {
  it('desired: model/projector links, hf.co manifest, aliases; shards skipped with warning', async () => {
    const { d, ds, warnings, lc } = await setup();
    expect(ds.map((x) => x.key)).toEqual([`${R}:Tiny-Q4_K_M.gguf`]);
    expect(d.paths).toEqual(pySort([`blobs/sha256-${q4}`, `blobs/sha256-${pf}`, M1, ALIAS]));
    expect(d.links.map((l) => l.target)).toEqual([blobTarget(lc, q4), blobTarget(lc, pf)]);
    expect(d.links.map((l) => l.primary)).toEqual([true, false]);
    expect(d.ollama).toMatchObject({ tag: 'Q4_K_M', manifestPath: M1, aliasPaths: [ALIAS] });
    expect(d).toMatchObject({ repoId: R, sha256: q4 });
    expect(warnings.join()).toMatch(/Big-Q8_0-00001-of-00002\.gguf.*shard/);
  });

  it('a repo without a projector has a single link, and a projector that is the model blob is not linked twice', async () => {
    const { ds } = await setup({ repos: [{ id: R, main: 'c', snapshots: [{ commit: 'c', mtime: 1, files: [
      { path: 'm-Q4_K_M.gguf', text: 'same' }, { path: 'mmproj-F16.gguf', text: 'same' }] }] }], views: ['ollama'] }, {});
    expect(ds[0]!.links.map((l) => l.path)).toEqual([blobRel(sha256Hex('same'))]);
    const one = await setup({ repos: [{ id: R, main: 'c', snapshots: [{ commit: 'c', mtime: 1, files: [{ path: 'm-Q4_K_M.gguf', text: 'a' }] }] }], views: ['ollama'] }, {});
    expect(one.ds[0]!.paths).toEqual([blobRel(sha256Hex('a')), `manifests/hf.co/${R}/Q4_K_M`]);
    expect(one.ds[0]!.ollama!.mmproj).toBeNull();
  });
});

describe('ollama presence and isStale', () => {
  it('presence: symlink with matching basename from another repo counts; regular file is adopted (test_existing_real_blob_is_adopted_not_replaced)', async () => {
    const s = await setup();
    fullView(s);
    expect(await s.drv.presence(s.d)).toBe('correct');
    // another repo's copy of the same bytes: different directory, same basename
    const other = path.join(s.lc.c.dir, 'otherhub', 'models--o--x', 'blobs', q4);
    await s.lc.fs.unlink(path.join(s.root, blobRel(q4)));
    link(s.root, blobRel(q4), other);
    expect(await s.drv.presence(s.d)).toBe('correct');
    // a regular file where the model blob should be: adopted
    await s.lc.fs.unlink(path.join(s.root, blobRel(q4)));
    put(s.root, blobRel(q4), 'ollama downloaded');
    expect(await s.drv.presence(s.d)).toBe('correct');
    expect(lstatSync(path.join(s.root, blobRel(q4))).isFile()).toBe(true);
  });

  it('presence: manifest missing -> absent; unparseable or no layers -> wrong; projector digest mismatch -> wrong; all ok -> correct; alias missing -> partial', async () => {
    const s = await setup();
    link(s.root, blobRel(q4), blobTarget(s.lc, q4));
    link(s.root, blobRel(pf), blobTarget(s.lc, pf));
    expect(await s.drv.presence(s.d)).toBe('absent');
    put(s.root, M1, '{not json');
    expect(await s.drv.presence(s.d)).toBe('wrong');
    put(s.root, M1, '{"schemaVersion":2}');
    expect(await s.drv.presence(s.d)).toBe('wrong');
    put(s.root, M1, man([[MT.model, q4], [MT.projector, 'ffff']]));
    expect(await s.drv.presence(s.d)).toBe('wrong');
    put(s.root, M1, man([[MT.model, q4]]));
    expect(await s.drv.presence(s.d)).toBe('wrong');       // projector expected but absent
    put(s.root, M1, man([[MT.model, q4], [MT.projector, pf]], 'c1'));
    expect(await s.drv.presence(s.d)).toBe('partial');     // alias manifest missing
    put(s.root, ALIAS, 'anything');
    expect(await s.drv.presence(s.d)).toBe('correct');     // alias content is not checked
  });

  it('presence: absent when the model link is missing, partial when only the projector link is, wrong for another symlink', async () => {
    const s = await setup();
    put(s.root, M1, man([[MT.model, q4], [MT.projector, pf]]));
    put(s.root, ALIAS, 'x');
    link(s.root, blobRel(pf), blobTarget(s.lc, pf));
    expect(await s.drv.presence(s.d)).toBe('absent');
    link(s.root, blobRel(q4), blobTarget(s.lc, q4));
    await s.lc.fs.unlink(path.join(s.root, blobRel(pf)));
    expect(await s.drv.presence(s.d)).toBe('partial');
    link(s.root, blobRel(pf), '/elsewhere/other-blob');
    expect(await s.drv.presence(s.d)).toBe('wrong');
  });

  it('presence: a directory at a manifest or alias path counts as missing', async () => {
    const s = await setup();
    mkdirSync(path.join(s.root, M1), { recursive: true });
    mkdirSync(path.join(s.root, ALIAS), { recursive: true });
    expect(await s.drv.presence(s.d)).toBe('absent');
  });

  it('presence: a symlinked manifest is never opened (wrong)', async () => {
    const s = await setup();
    link(s.root, M1, path.join(s.root, 'no-such-target'));
    // guardedFs refuses to follow a dangling link, so this one test reads through the real fs (still inside the temp dir)
    const real = ollamaDriver(s.root, s.lc.model.hubRoot, ALIASES, stub, nodeFs);
    expect(await real.presence(s.d)).toBe('wrong');   // a symlink is never opened as a manifest
  });

  it('isStale: manifest model digest is owned or current sha and wrong links point into the hub (test_an_ollama_manifest_rewritten_by_someone_else_is_still_foreign)', async () => {
    const s = await setup();
    expect(await s.drv.isStale(s.d, { paths: [], sha256: 'old' })).toBe(false);   // no manifest
    put(s.root, M1, man([[MT.model, 'old']]));
    link(s.root, blobRel(q4), blobTarget(s.lc, 'old'));                           // dangling, into the hub
    expect(await s.drv.isStale(s.d, { paths: [], sha256: 'old' })).toBe(true);
    expect(await s.drv.isStale(s.d, { paths: [], sha256: 'other' })).toBe(false);  // manifest digest not owned: foreign
    put(s.root, M1, man([[MT.model, 'other']]));
    expect(await s.drv.isStale(s.d, { paths: [], sha256: 'old' })).toBe(false);
    put(s.root, M1, man([[MT.model, 'old']]));
    link(s.root, blobRel(pf), '/outside/the/hub');
    expect(await s.drv.isStale(s.d, { paths: [], sha256: 'old' })).toBe(false);   // a wrong link outside the hub
  });

  it('isStale: unparseable manifest, no model layer, or a regular file at a wrong link are not stale', async () => {
    const s = await setup();
    put(s.root, M1, '{bad');
    expect(await s.drv.isStale(s.d, { paths: [], sha256: q4 })).toBe(false);
    put(s.root, M1, man([[MT.projector, pf]]));
    expect(await s.drv.isStale(s.d, { paths: [], sha256: q4 })).toBe(false);
    put(s.root, M1, man([[MT.model, q4]]));
    expect(await s.drv.isStale(s.d, { paths: [], sha256: q4 })).toBe(true);        // nothing wrong at all (CLI all([]))
    link(s.root, blobRel(q4), '/outside/x');
    expect(await s.drv.isStale(s.d, { paths: [], sha256: q4 })).toBe(false);
  });
});

describe('ollama: a manifest whose model blob is a regular file is not ours to update', () => {
  it('isStale is false and foreignReason says why; a symlinked blob or no manifest gives no reason', async () => {
    const s = await setup();
    expect(await s.drv.foreignReason(s.d)).toBeUndefined();                          // no manifest
    put(s.root, M1, man([[MT.model, 'old']]));
    link(s.root, 'blobs/sha256-old', blobTarget(s.lc, 'old'));
    expect(await s.drv.isStale(s.d, { paths: [], sha256: 'old' })).toBe(true);
    expect(await s.drv.foreignReason(s.d)).toBeUndefined();                          // our link, not a download
    unlinkSync(path.join(s.root, 'blobs/sha256-old'));
    put(s.root, 'blobs/sha256-old', 'weights the user pulled');
    expect(await s.drv.isStale(s.d, { paths: [], sha256: 'old' })).toBe(false);
    expect(await s.drv.foreignReason(s.d)).toBe(`${M1}: model downloaded by Ollama; not replaced`);
    put(s.root, M1, man([[MT.projector, 'old']]));
    expect(await s.drv.foreignReason(s.d)).toBeUndefined();                          // no model layer
  });
});

describe('ollama remove', () => {
  it('remove: manifests first, then blobs only if unreferenced (test_remove_keeps_blob_referenced_by_foreign_manifest)', async () => {
    const s = await setup();
    fullView(s);
    put(s.root, 'manifests/registry.ollama.ai/library/x/latest', man([[MT.model, q4]]));
    const owned = [`blobs/sha256-${q4}`, 'blobs/sha256-c1', M1, ALIAS];   // blobs listed before the manifests on purpose
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([M1, ALIAS, 'blobs/sha256-c1']);
    expect(existsSync(path.join(s.root, M1))).toBe(false);
    expect(existsSync(path.join(s.root, 'blobs/sha256-c1'))).toBe(false);
    expect(readlinkSync(path.join(s.root, blobRel(q4)))).toBe(blobTarget(s.lc, q4));
    expect(existsSync(path.join(s.root, 'manifests/hf.co'))).toBe(false);   // empty parents pruned
    expect(ctx.warnings).toEqual([]);
  });

  it('test_remove_keeps_small_blob_shared_with_our_other_manifest', async () => {
    const s = await setup();
    put(s.root, M1, man([[MT.model, q4], [MT.template, 't1']], 'c1'));
    put(s.root, `manifests/hf.co/${R}/Q8_0`, man([[MT.model, sha256Hex('q8')], [MT.template, 't1']], 'c1'));
    put(s.root, 'blobs/sha256-t1', 'tpl');
    put(s.root, 'blobs/sha256-c1', '{}');
    const owned = [M1, `blobs/sha256-${q4}`, 'blobs/sha256-t1', 'blobs/sha256-c1'];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([M1]);
    expect(existsSync(path.join(s.root, 'blobs/sha256-t1'))).toBe(true);
    expect(existsSync(path.join(s.root, 'blobs/sha256-c1'))).toBe(true);
  });

  it('remove keeps every blob when any manifest on disk is unparseable', async () => {
    const s = await setup();
    fullView(s);
    writeFileSync(path.join(s.root, 'manifests/registry.ollama.ai/library/junk-latest'), '{not json');
    mkdirSync(path.join(s.root, 'manifests/registry.ollama.ai/library/junk'), { recursive: true });
    writeFileSync(path.join(s.root, 'manifests/registry.ollama.ai/library/junk/latest'), '{not json');
    const owned = [M1, `blobs/sha256-${q4}`, `blobs/sha256-${pf}`, 'blobs/sha256-c1'];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([M1]);
    expect(ctx.warnings.join()).toMatch(/unreadable manifest.*blobs kept/);
    expect(ctx.warnings).toHaveLength(1);
    expect(existsSync(path.join(s.root, 'blobs/sha256-c1'))).toBe(true);
    expect(existsSync(path.join(s.root, blobRel(q4)))).toBe(true);
  });

  it('remove: a failed manifest removal leaves the manifest, so its blobs stay', async () => {
    const s = await setup();
    fullView(s);
    const owned = [M1, `blobs/sha256-${q4}`, 'blobs/sha256-c1'];          // no plan facts: the manifest is not removed
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, ['blobs/sha256-c1']));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([]);
    expect(existsSync(path.join(s.root, M1))).toBe(true);
    expect(existsSync(path.join(s.root, 'blobs/sha256-c1'))).toBe(true);
    expect(ctx.warnings.join()).toMatch(/changed since preview/);
  });

  it('remove compares digests case-insensitively', async () => {
    const s = await setup();
    put(s.root, 'manifests/registry.ollama.ai/library/x/latest', man([[MT.model, 'ABCDEF']]));
    put(s.root, 'blobs/sha256-abcdef', 'b');
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, ['blobs/sha256-abcdef']));
    expect(await s.drv.remove(['blobs/sha256-abcdef'], ctx, q4)).toEqual([]);
    expect(existsSync(path.join(s.root, 'blobs/sha256-abcdef'))).toBe(true);
  });

  it('remove: other owned paths go only when they are symlinks; directories and regular files stay', async () => {
    const s = await setup();
    link(s.root, 'extra/link', '/somewhere');
    put(s.root, 'extra/file', 'user');
    mkdirSync(path.join(s.root, 'extra/dir'));
    const owned = ['extra/link', 'extra/file', 'extra/dir', 'blobs/gone', 'extra/missing'];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual(['extra/link']);
    expect(existsSync(path.join(s.root, 'extra/file'))).toBe(true);
    expect(existsSync(path.join(s.root, 'extra/dir'))).toBe(true);
    expect(ctx.warnings.join()).toMatch(/extra\/file: not a symlink.*extra\/dir: not a symlink/);
  });

  it('remove refuses paths that resolve into the hub or outside the view, and a manifest that is a directory', async () => {
    const s = await setup();
    // a symlinked folder inside the view that leads into the hub
    symlinkSync(s.lc.model.hubRoot, path.join(s.root, 'blobs'));
    const victim = path.join(s.lc.model.hubRoot, 'models--acme--Tiny-GGUF', 'blobs', q4);
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, [`blobs/models--acme--Tiny-GGUF/blobs/${q4}`]));
    expect(await s.drv.remove([`blobs/models--acme--Tiny-GGUF/blobs/${q4}`], ctx, q4)).toEqual([]);
    expect(existsSync(victim)).toBe(true);
    expect(ctx.warnings.join()).toMatch(/not removed/);
    // a manifest path that is a directory
    mkdirSync(path.join(s.root, 'manifests/dir'), { recursive: true });
    const ctx2 = ctxOf(s.lc, await plan(s.lc, s.root, ['manifests/dir']));
    expect(await s.drv.remove(['manifests/dir'], ctx2, q4)).toEqual([]);
    expect(existsSync(path.join(s.root, 'manifests/dir'))).toBe(true);
    expect(ctx2.warnings.join()).toMatch(/not a regular file/);
  });

  it('remove refuses a lexically unsafe path (hub inside the view root)', async () => {
    const s = await setup();
    const ctx = ctxOf(s.lc);
    expect(await s.drv.remove(['../escape'], ctx, q4)).toEqual([]);
    expect(ctx.warnings).toHaveLength(1);
  });
});

describe('ollama remove: edge cases', () => {
  it('a manifest rewritten by Ollama with a different model digest survives with a warning', async () => {
    const s = await setup();
    fullView(s);
    put(s.root, M1, man([[MT.model, 'theirs']], 'c9'));
    put(s.root, 'blobs/sha256-c9', 'cfg');
    const owned = [M1, `blobs/sha256-${q4}`, 'blobs/sha256-c9'];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([]);   // the alias still references q4, so its blob stays too
    expect(existsSync(path.join(s.root, M1))).toBe(true);
    expect(ctx.warnings).toContain(`${M1}: manifest changed by Ollama; left in place`);
    expect(existsSync(path.join(s.root, 'blobs/sha256-c9'))).toBe(true);       // referenced by the surviving manifest
  });

  it('an unreadable or unparseable owned manifest survives with the same warning', async () => {
    const s = await setup();
    put(s.root, M1, '{bad');
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, [M1]));
    expect(await s.drv.remove([M1, `blobs/sha256-${q4}`], ctx, q4)).toEqual([]);
    expect(existsSync(path.join(s.root, M1))).toBe(true);
    expect(ctx.warnings).toContain(`${M1}: manifest unreadable; left in place`);
  });

  it('a manifest whose model blob is a regular file (Ollama\'s own download) survives, and so does all it references', async () => {
    const s = await setup();
    put(s.root, blobRel(q4), 'a full weights copy downloaded by ollama');
    link(s.root, blobRel(pf), blobTarget(s.lc, pf));
    put(s.root, M1, man([[MT.model, q4], [MT.projector, pf]], 'c1'));
    put(s.root, 'blobs/sha256-c1', '{}');
    const owned = [M1, `blobs/sha256-${q4}`, `blobs/sha256-${pf}`, 'blobs/sha256-c1'];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([]);
    expect(existsSync(path.join(s.root, M1))).toBe(true);
    expect(lstatSync(path.join(s.root, blobRel(q4))).isFile()).toBe(true);
    expect(ctx.warnings).toEqual([`${M1}: model downloaded by Ollama; left in place`]);
  });

  it('an unreferenced regular-file model blob survives a prune; symlinked and small regular blobs go', async () => {
    const s = await setup();
    put(s.root, blobRel(q4), 'a full weights copy downloaded by ollama');
    link(s.root, blobRel(pf), blobTarget(s.lc, pf));
    put(s.root, 'blobs/sha256-c1', '{}');
    const owned = [`blobs/sha256-${q4}`, `blobs/sha256-${pf}`, 'blobs/sha256-c1'];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([`blobs/sha256-${pf}`, 'blobs/sha256-c1']);
    expect(lstatSync(path.join(s.root, blobRel(q4))).isFile()).toBe(true);
    expect(ctx.warnings).toEqual([`blobs/sha256-${q4}: regular file copy of the model; left in place`]);
  });

  it('a regular-file projector blob is kept too', async () => {
    const s = await setup();
    put(s.root, blobRel(pf), 'projector copy');
    link(s.root, blobRel(q4), blobTarget(s.lc, q4));
    put(s.root, M1, man([[MT.model, q4], [MT.projector, pf]]));
    const owned = [M1, `blobs/sha256-${q4}`, `blobs/sha256-${pf}`];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([M1, `blobs/sha256-${q4}`]);
    expect(existsSync(path.join(s.root, blobRel(pf)))).toBe(true);
  });

  it('a non-regular file (a socket here; a FIFO is the same case) under manifests/ is never opened and counts as unknown', async () => {
    const s = await setup();
    mkdirSync(path.join(s.root, 'manifests/r/n'), { recursive: true });
    const server = await listenAt(s.lc, path.join(s.root, 'manifests/r/n'), 'sock');
    try {
      expect(await referencedDigests(s.lc.fs, s.root)).toBe('unknown');
    } finally {
      await new Promise((res) => server.close(res));
    }
  });

  it('a digest without the sha256: prefix makes everything unknown', async () => {
    const s = await setup();
    put(s.root, 'manifests/r/n/t', JSON.stringify({ layers: [{ mediaType: MT.model, digest: 'aa' }] }));
    expect(await referencedDigests(s.lc.fs, s.root)).toBe('unknown');
    put(s.root, 'manifests/r/n/t', JSON.stringify({ layers: [], config: { digest: 'md5:aa' } }));
    expect(await referencedDigests(s.lc.fs, s.root)).toBe('unknown');
  });

  it('a dangling alias symlink counts as missing, and an alias symlink to a directory too', async () => {
    const s = await setup();
    fullView(s);
    await nodeFs.unlink(path.join(s.root, ALIAS));
    symlinkSync(path.join(s.root, 'no-such-target'), path.join(s.root, ALIAS));
    const real = ollamaDriver(s.root, s.lc.model.hubRoot, ALIASES, stub, nodeFs);
    expect(await real.presence(s.d)).toBe('partial');
    await nodeFs.unlink(path.join(s.root, ALIAS));
    symlinkSync(path.join(s.root, 'blobs'), path.join(s.root, ALIAS));
    expect(await real.presence(s.d)).toBe('partial');
  });

  it('foreign reports the model blob as target', async () => {
    const s = await setup();
    put(s.root, 'manifests/r/n/t', man([[MT.model, 'aa']]));
    put(s.root, 'blobs/sha256-aa', 'x');
    expect(await s.drv.foreign(new Set())).toEqual([{ key: 'ollama:r/n:t', path: 'manifests/r/n/t', target: 'blobs/sha256-aa' }]);
  });
});

describe('ollama remove: an explicit owned sha', () => {
  const regularModel = (s: Setup): void => put(s.root, blobRel(q4), 'a full weights copy downloaded by ollama');

  it('a retry after a partial prune (manifest already gone) keeps the regular model blob', async () => {
    const s = await setup();
    regularModel(s);
    const owned = [M1, `blobs/sha256-${q4}`];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([]);
    expect(lstatSync(path.join(s.root, blobRel(q4))).isFile()).toBe(true);
    expect(ctx.warnings).toEqual([`blobs/sha256-${q4}: regular file copy of the model; left in place`]);
  });

  it('a tag moved by Ollama keeps the manifest and the old regular model blob', async () => {
    const s = await setup();
    regularModel(s);
    put(s.root, M1, man([[MT.model, 'theirs']]));
    const owned = [M1, `blobs/sha256-${q4}`];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([]);
    expect(existsSync(path.join(s.root, M1))).toBe(true);
    expect(lstatSync(path.join(s.root, blobRel(q4))).isFile()).toBe(true);
    expect(ctx.warnings).toContain(`${M1}: manifest changed by Ollama; left in place`);
  });

  it('key A pruned while key B shares the model blob: A manifest goes, the blob stays', async () => {
    const s = await setup();
    link(s.root, blobRel(q4), blobTarget(s.lc, q4));
    put(s.root, M1, man([[MT.model, q4]]));
    put(s.root, `manifests/hf.co/other/Repo/Q4_K_M`, man([[MT.model, q4]]));   // key B
    const owned = [M1];                                                       // the shared blob path was stripped from A's list
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([M1]);
    expect(existsSync(path.join(s.root, M1))).toBe(false);
    expect(existsSync(path.join(s.root, 'manifests/hf.co/other/Repo/Q4_K_M'))).toBe(true);
    expect(readlinkSync(path.join(s.root, blobRel(q4)))).toBe(blobTarget(s.lc, q4));
    expect(ctx.warnings).toEqual([]);
  });

  it('the sha comparison is case-insensitive and a regular blob named by an upper-case sha is kept', async () => {
    const s = await setup();
    regularModel(s);
    put(s.root, M1, man([[MT.model, q4.toUpperCase()]]));
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, [M1, `blobs/sha256-${q4}`]));
    // The upper-case digest matches the owned sha (so it is not "changed by Ollama"); its model blob is a regular file,
    // so the manifest is Ollama's own download and stays.
    expect(await s.drv.remove([M1, `blobs/sha256-${q4}`], ctx, q4.toUpperCase())).toEqual([]);
    expect(ctx.warnings).toEqual([`${M1}: model downloaded by Ollama; left in place`]);
    expect(lstatSync(path.join(s.root, blobRel(q4))).isFile()).toBe(true);
  });

  it('warning texts: changed by Ollama, unreadable, not a regular file', async () => {
    const s = await setup();
    put(s.root, M1, man([[MT.model, 'theirs']]));
    put(s.root, `manifests/hf.co/${R}/bad`, '{bad');
    mkdirSync(path.join(s.root, `manifests/hf.co/${R}/dir`));
    const owned = [M1, `manifests/hf.co/${R}/bad`, `manifests/hf.co/${R}/dir`];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([]);
    expect(ctx.warnings).toEqual([
      `${M1}: manifest changed by Ollama; left in place`,
      `manifests/hf.co/${R}/bad: manifest unreadable; left in place`,
      `manifests/hf.co/${R}/dir: not a regular file; left in place`,
    ]);
  });
});

describe('ollama remove: more edge cases', () => {
  it('a regular blob over 1 MiB is kept whatever its digest; exactly 1 MiB goes when unreferenced', async () => {
    const s = await setup();
    mkdirSync(path.join(s.root, 'blobs'), { recursive: true });
    writeFileSync(path.join(s.root, 'blobs/sha256-big'), Buffer.alloc(1048577));
    writeFileSync(path.join(s.root, 'blobs/sha256-edge'), Buffer.alloc(1048576));
    const owned = ['blobs/sha256-big', 'blobs/sha256-edge'];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual(['blobs/sha256-edge']);
    expect(existsSync(path.join(s.root, 'blobs/sha256-big'))).toBe(true);
    expect(ctx.warnings).toEqual(['blobs/sha256-big: regular file copy of the model; left in place']);
  });

  it('a projector blob over 1 MiB survives after its manifest is gone', async () => {
    const s = await setup();
    mkdirSync(path.join(s.root, 'blobs'), { recursive: true });
    writeFileSync(path.join(s.root, blobRel(pf)), Buffer.alloc(2 * 1048576));
    const owned = [M1, blobRel(pf)];
    const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
    expect(await s.drv.remove(owned, ctx, q4)).toEqual([]);
    expect(existsSync(path.join(s.root, blobRel(pf)))).toBe(true);
  });

  it('a symlinked or non-regular manifest is never opened and is kept', async () => {
    const s = await setup();
    fullView(s);
    await nodeFs.unlink(path.join(s.root, M1));
    link(s.root, M1, path.join(s.root, ALIAS));               // a symlink to a valid manifest
    const sock = 'manifests/hf.co/acme/sock';
    const server = await listenAt(s.lc, path.join(s.root, 'manifests/hf.co/acme'), 'sock');
    try {
      const owned = [M1, sock];
      const ctx = ctxOf(s.lc, await plan(s.lc, s.root, owned));
      expect(await s.drv.remove(owned, ctx, q4)).toEqual([]);
      expect(ctx.warnings).toEqual([`${M1}: not a regular file; left in place`, `${sock}: not a regular file; left in place`]);
      const real = ollamaDriver(s.root, s.lc.model.hubRoot, ALIASES, stub, nodeFs);
      expect(await real.isStale(s.d, { paths: [], sha256: q4 })).toBe(false);
    } finally {
      await new Promise((res) => server.close(res));
    }
  });
});

describe('ollama remove under failure', () => {
  const withUnlink = (lc: LoadedCase, err: Error): ApplyCtx => {
    const safeFs = Object.assign(Object.create(lc.safeFs) as typeof lc.safeFs, { unlink: async (): Promise<void> => { throw err; } });
    return { ...ctxOf(lc), safeFs };
  };

  it('a SafeFs refusal on unlink leaves the file with a warning; a real I/O error propagates', async () => {
    const s = await setup();
    fullView(s);
    const both = [M1, `blobs/sha256-${q4}`];
    const planned = await plan(s.lc, s.root, both);
    for (const code of ['STALE', 'CONTAINMENT'] as const) {
      const ctx = { ...withUnlink(s.lc, new SafeFsError(code, M1, 'nope')), expect: (r: string) => planned.get(r) };
      expect(await s.drv.remove(both, ctx, q4)).toEqual([]);
      expect(ctx.warnings.join()).toMatch(code === 'STALE' ? /changed since preview/ : /CONTAINMENT/);
    }
    const io = { ...withUnlink(s.lc, new SafeFsError('IO', M1, 'disk')), expect: (r: string) => planned.get(r) };
    await expect(s.drv.remove(both, io, q4)).rejects.toThrow(/disk/);
    expect(existsSync(path.join(s.root, M1))).toBe(true);
  });

  it('a containment change between the check and the unlink (SkipEntry from viewFs) leaves the file', async () => {
    const s = await setup();
    fullView(s);
    const planned = await plan(s.lc, s.root, [M1]);
    let calls = 0;
    const fs = { ...s.lc.fs, realpath: async (p: string): Promise<string> => {
      if (++calls > 2) throw Object.assign(new Error('gone'), { code: 'EIO' });   // the guard's two calls pass, viewFs's fail
      return s.lc.fs.realpath(p);
    } };
    const ctx: ApplyCtx = { safeFs: s.lc.safeFs, fs, expect: (r) => planned.get(r), warnings: [] };
    expect(await s.drv.remove([M1], ctx, q4)).toEqual([]);
    expect(existsSync(path.join(s.root, M1))).toBe(true);
    expect(ctx.warnings.join()).toMatch(/left in place/);
  });

  it('foreign skips a manifest that cannot be read', async () => {
    const s = await setup();
    put(s.root, 'manifests/r/n/t', man([[MT.model, 'aa']]));
    put(s.root, 'blobs/sha256-aa', 'x');
    const drv = ollamaDriver(s.root, s.lc.model.hubRoot, {}, stub, failingFs(s.lc.fs, 'readFile', 'EACCES'));
    expect(await drv.foreign(new Set())).toEqual([]);
    expect(await s.drv.foreign(new Set())).toHaveLength(1);
  });
});

describe('ollama referencedDigests', () => {
  it('collects config and layer digests of every manifest in any registry, lower-cased', async () => {
    const s = await setup();
    put(s.root, M1, man([[MT.model, 'AA'], [MT.template, 'bb']], 'cc'));
    put(s.root, 'manifests/registry.ollama.ai/library/x/latest', man([[MT.model, 'dd']]));
    expect([...(await referencedDigests(s.lc.fs, s.root) as Set<string>)].sort()).toEqual(['aa', 'bb', 'cc', 'dd']);
  });

  it('treats a manifest above 16 MiB as unknown without reading it', async () => {
    const s = await setup();
    put(s.root, 'manifests/r/n/big', man([[MT.model, 'aa']]));
    truncateSync(path.join(s.root, 'manifests/r/n/big'), 16 * 1024 * 1024 + 1);
    const reads: string[] = [];
    const spy = { ...s.lc.fs, readFile: ((p: string, enc?: 'utf8') => { reads.push(p); return enc === undefined ? s.lc.fs.readFile(p) : s.lc.fs.readFile(p, enc); }) as typeof s.lc.fs.readFile };
    expect(await referencedDigests(spy, s.root)).toBe('unknown');
    expect(reads).toEqual([]);
  });

  it('treats a symlinked manifest whose target is above 16 MiB as unknown without reading it', async () => {
    const s = await setup();
    put(s.root, 'big-target', '{}');
    truncateSync(path.join(s.root, 'big-target'), 16 * 1024 * 1024 + 1);
    mkdirSync(path.join(s.root, 'manifests/r/n'), { recursive: true });
    symlinkSync(path.join(s.root, 'big-target'), path.join(s.root, 'manifests/r/n/lnk'));
    const reads: string[] = [];
    const spy = { ...s.lc.fs, readFile: ((p: string, enc?: 'utf8') => { reads.push(p); return enc === undefined ? s.lc.fs.readFile(p) : s.lc.fs.readFile(p, enc); }) as typeof s.lc.fs.readFile };
    expect(await referencedDigests(spy, s.root)).toBe('unknown');
    expect(reads).toEqual([]);
  });

  it('is empty without a manifests folder, and unknown for unreadable shapes', async () => {
    const s = await setup();
    expect(await referencedDigests(s.lc.fs, s.root)).toEqual(new Set());
    for (const bad of ['[]', '{"layers":[1]}', '{"layers":[{"mediaType":"a","digest":3}]}', '{"layers":[],"config":5}', '{"layers":[],"config":{"digest":1}}']) {
      put(s.root, 'manifests/r/n/t', bad);
      expect(await referencedDigests(s.lc.fs, s.root), bad).toBe('unknown');
    }
  });

  it('is unknown for a dangling manifest symlink, and tolerates a config-less manifest', async () => {
    const s = await setup();
    put(s.root, 'manifests/r/n/ok', man([[MT.model, 'aa']]));
    expect(await referencedDigests(s.lc.fs, s.root)).toEqual(new Set(['aa']));
    link(s.root, 'manifests/r/n/dangling', path.join(s.root, 'no-such-target'));
    expect(await referencedDigests(nodeFs, s.root)).toBe('unknown');
  });

  it('exclude: skips the given manifest paths (those a plan removes), even an unreadable one', async () => {
    const s = await setup();
    put(s.root, 'manifests/r/n/a', man([[MT.model, 'aa']], 'cc'));
    put(s.root, 'manifests/r/n/b', man([[MT.model, 'bb']]));
    const a = path.join(s.root, 'manifests/r/n/a');
    expect(await referencedDigests(s.lc.fs, s.root, new Set([a]))).toEqual(new Set(['bb']));
    put(s.root, 'manifests/r/n/a', 'not json');
    expect(await referencedDigests(s.lc.fs, s.root)).toBe('unknown');
    expect(await referencedDigests(s.lc.fs, s.root, new Set([a]))).toEqual(new Set(['bb']));
  });

  it('referencingManifests names the first manifest (code-point order) using each digest', async () => {
    const s = await setup();
    put(s.root, 'manifests/r/n/b', man([[MT.model, 'AA'], [MT.template, 'tt']]));
    put(s.root, 'manifests/r/n/a', man([[MT.model, 'aa']], 'cc'));
    expect(await referencingManifests(s.lc.fs, s.root)).toEqual(new Map([
      ['aa', 'manifests/r/n/a'], ['cc', 'manifests/r/n/a'], ['tt', 'manifests/r/n/b']]));
    expect(await referencingManifests(s.lc.fs, s.root, new Set([path.join(s.root, 'manifests/r/n/a')]))).toEqual(new Map([
      ['aa', 'manifests/r/n/b'], ['tt', 'manifests/r/n/b']]));
    put(s.root, 'manifests/r/n/c', '{');
    expect(await referencingManifests(s.lc.fs, s.root)).toBe('unknown');
  });
});

describe('ollama foreign', () => {
  it('foreign: unowned manifests whose model layer blob is a regular file', async () => {
    const s = await setup();
    const llama = 'manifests/registry.ollama.ai/library/llama3/latest';
    put(s.root, llama, man([[MT.model, 'aa']]));
    put(s.root, 'blobs/sha256-aa', 'ollama bytes');
    put(s.root, 'manifests/registry.ollama.ai/library/linked/latest', man([[MT.model, 'bb']]));
    link(s.root, 'blobs/sha256-bb', blobTarget(s.lc, q4));                       // symlink blob: ours, not foreign
    put(s.root, 'manifests/registry.ollama.ai/library/owned/latest', man([[MT.model, 'aa']]));
    put(s.root, 'manifests/short', man([[MT.model, 'aa']]));                     // fewer than 2 parts
    put(s.root, 'manifests/r/n/bad', '{bad');
    put(s.root, 'manifests/r/n/nolayer', man([[MT.template, 'aa']]));
    put(s.root, 'manifests/r/n/noblob', man([[MT.model, 'zz']]));
    put(s.root, 'manifests/r/n/odd', JSON.stringify({ layers: [{ mediaType: MT.model, digest: 'sha256:../../x' }] }));
    link(s.root, 'manifests/r/n/symlinked', path.join(s.root, 'no-such-target'));
    const got = await s.drv.foreign(new Set(['manifests/registry.ollama.ai/library/owned/latest']));
    expect(got).toEqual([{ key: 'ollama:registry.ollama.ai/library/llama3:latest', path: llama, target: 'blobs/sha256-aa' }]);
  });
});

describe('ollama driver surface', () => {
  it('names itself, exposes the injected create, and a missing view has no foreign entries', async () => {
    const s = await setup();
    expect(s.drv.name).toBe('ollama');
    expect(s.drv.root).toBe(s.root);
    expect(await s.drv.create(s.d, ctxOf(s.lc))).toEqual([]);
    expect(await s.drv.foreign(new Set())).toEqual([]);
  });
});

describe('ollama coverage closers', () => {
  const BIG = 16 * 1024 * 1024 + 1;

  it('deriveTags: a basename without the .gguf suffix is kept whole (made safe) as the tag source', () => {
    const e = entry({ relpath: 'odd name.bin' });
    expect(deriveTags([e]).get(e.key)).toBe('odd_name.bin');
  });

  it('manifestLayerHex lower-cases the hex and rejects a digest without the sha256: prefix', () => {
    const mk = (digest: string): string => JSON.stringify({ schemaVersion: 2, layers: [{ mediaType: MT.model, digest, size: 1 }] });
    expect(manifestLayerHex(mk('sha256:ABCDEF'))).toEqual({ model: 'abcdef', projector: null });
    expect(manifestLayerHex(mk('ABCDEF'))).toBeNull();
  });

  it('presence: a manifest above 16 MiB is wrong and never read', async () => {
    const s = await setup();
    fullView(s);
    truncateSync(path.join(s.root, M1), BIG);
    expect(await s.drv.presence(s.d)).toBe('wrong');
  });

  it('presence: a manifest whose stat fails is wrong for a permission error and missing when it vanished', async () => {
    const s = await setup();
    fullView(s);
    const at = (code: string): ReturnType<typeof ollamaDriver> =>
      ollamaDriver(s.root, s.lc.model.hubRoot, ALIASES, stub, failingFs(s.lc.fs, 'stat', code, (p) => p.endsWith(M1)));
    expect(await at('EACCES').presence(s.d)).toBe('wrong');
    expect(await at('ENOENT').presence(s.d)).toBe('absent');
  });

  it('presence: a folder where the projector link belongs counts as missing, so the entry is only partial', async () => {
    const s = await setup();
    fullView(s);
    expect(await s.drv.presence(s.d)).toBe('correct');
    unlinkSync(path.join(s.root, blobRel(pf)));
    mkdirSync(path.join(s.root, blobRel(pf)));
    expect(await s.drv.presence(s.d)).toBe('partial');
  });

  it('foreign skips a manifest above 16 MiB without reading it', async () => {
    const s = await setup();
    put(s.root, 'manifests/r/n/big', man([[MT.model, 'aa']]));
    truncateSync(path.join(s.root, 'manifests/r/n/big'), BIG);
    put(s.root, 'manifests/r/n/ok', man([[MT.model, 'aa']]));
    put(s.root, 'blobs/sha256-aa', 'x');
    expect((await s.drv.foreign(new Set())).map((f) => f.path)).toEqual(['manifests/r/n/ok']);
  });

  it('remove: a manifest that cannot be examined at removal time is kept with the unreadable warning', async () => {
    const s = await setup();
    fullView(s);
    const planned = await plan(s.lc, s.root, [M1]);
    const fs = scriptedFs(s.lc.fs, [{ method: 'lstat', nth: 2, code: 'EACCES', pathIncludes: M1 }]);
    const ctx: ApplyCtx = { safeFs: s.lc.safeFs, fs, expect: (r) => planned.get(r), warnings: [] };
    expect(await s.drv.remove([M1], ctx, q4)).toEqual([]);
    expect(existsSync(path.join(s.root, M1))).toBe(true);
    expect(ctx.warnings).toEqual([`${M1}: manifest unreadable; left in place`]);
  });

  it('remove: a blob whose unlink is refused stays, with the reason, after its manifest went', async () => {
    const s = await setup();
    fullView(s);
    const blobRelPath = `blobs/sha256-${q4}`;
    const planned = await plan(s.lc, s.root, [M1, ALIAS, blobRelPath]);
    const real = s.lc.safeFs;
    const safeFs = Object.assign(Object.create(real) as typeof real, {
      unlink: async (p: string, expect: FileFacts): Promise<void> => {
        if (p.endsWith(blobRelPath)) throw new SafeFsError('STALE', p, 'changed');
        await real.unlink(p, expect);
      },
    });
    const ctx: ApplyCtx = { safeFs, fs: s.lc.fs, expect: (r) => planned.get(r), warnings: [] };
    expect(await s.drv.remove([M1, ALIAS, blobRelPath], ctx, q4)).toEqual([M1, ALIAS]);
    expect(lstatSync(path.join(s.root, blobRelPath)).isSymbolicLink()).toBe(true);
    expect(ctx.warnings).toEqual([`${blobRelPath}: changed since preview; left in place`]);
  });
});
