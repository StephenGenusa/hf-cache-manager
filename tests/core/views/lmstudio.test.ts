import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OwnedEntry } from '../../../src/core/compat/state';
import { factsOf, nodeFs, type FsLike } from '../../../src/core/fsx';
import { SafeFs, SafeFsError } from '../../../src/core/safe-fs';
import { ggufEntries } from '../../../src/core/views/entries';
import { lmstudioDriver } from '../../../src/core/views/lmstudio';
import { CreateIncomplete, SkipEntry, type ApplyCtx, type Desired } from '../../../src/core/views/view-types';
import { ensureParent, insideRoot, linkIntoHub, removeEmptyParents, viewFs, walkTree } from '../../../src/core/views/walk';
import type { FileFacts } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { failingFs, scriptedFs } from '../../helpers/failing-fs';
import { tempDir } from '../_temp';
import { entry, loadCase, sha256Hex, type CaseSpec, type LoadedCase } from './_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const R = 'acme/Tiny-GGUF';
const spec: CaseSpec = { repos: [{ id: R, main: 'c2', snapshots: [{ commit: 'c2', mtime: 2, files: [
  { path: 'Tiny-Q4_K_M.gguf', text: 'q4' }, { path: 'sub/Tiny-Q4_K_M.gguf', text: 'q4b' },
  { path: 'mmproj-F16.gguf', text: 'pf' }, { path: 'Tiny-Q8_0-00001-of-00002.gguf', text: 's1' }] }] }], views: ['lmstudio'] };
const OWNED: OwnedEntry = { paths: [], sha256: 'x' };

interface Setup { lc: LoadedCase; root: string; drv: ReturnType<typeof lmstudioDriver>; ds: Desired[]; warnings: string[] }
async function setup(s: CaseSpec = spec): Promise<Setup> {
  const lc = await loadCase(s);
  const root = realpathSync(lc.c.lmstudio!);
  const drv = lmstudioDriver(root, lc.model.hubRoot, lc.fs);
  const warnings: string[] = [];
  return { lc, root, drv, ds: drv.desired(ggufEntries(lc.model), warnings), warnings };
}
/** An ApplyCtx whose `expect` answers from `planned` (view-relative path -> facts captured "at planning time"). */
function ctxOf(lc: LoadedCase, planned: Map<string, FileFacts | null> = new Map()): ApplyCtx {
  return { safeFs: lc.safeFs, fs: lc.fs, expect: (rel) => planned.get(rel), warnings: [] };
}
async function plan(lc: LoadedCase, root: string, rels: string[]): Promise<Map<string, FileFacts | null>> {
  const m = new Map<string, FileFacts | null>();
  for (const r of rels) m.set(r, await factsOf(lc.fs, path.join(root, r)));
  return m;
}
const q4 = (ds: Desired[]): Desired => ds.find((d) => d.key === `${R}:Tiny-Q4_K_M.gguf`)!;
const lstatOrNull = (p: string): ReturnType<typeof lstatSync> | null => { try { return lstatSync(p); } catch { return null; } };

describe('lmstudio desired', () => {
  it('one flattened link per weight + the repo mmproj; collisions first-wins', async () => {
    const { lc, drv } = await setup();
    const warnings: string[] = [];
    const ds = drv.desired(ggufEntries(lc.model), warnings);
    expect(ds.map((d) => [d.key, d.paths])).toEqual([
      [`${R}:Tiny-Q4_K_M.gguf`, [`${R}/Tiny-Q4_K_M.gguf`, `${R}/mmproj-F16.gguf`]],
      [`${R}:Tiny-Q8_0-00001-of-00002.gguf`, [`${R}/Tiny-Q8_0-00001-of-00002.gguf`, `${R}/mmproj-F16.gguf`]],
    ]);
    expect(ds[0]!.links[0]).toEqual({ path: `${R}/Tiny-Q4_K_M.gguf`, primary: true,
      target: path.join(lc.model.hubRoot, 'models--acme--Tiny-GGUF', 'blobs', sha256Hex('q4')) });
    expect(ds[0]!.links[1]).toEqual({ path: `${R}/mmproj-F16.gguf`, primary: false,
      target: path.join(lc.model.hubRoot, 'models--acme--Tiny-GGUF', 'blobs', sha256Hex('pf')) });
    expect(ds[0]).toMatchObject({ repoId: R, sha256: sha256Hex('q4') });
    expect(warnings).toEqual([`[lmstudio] ${R}:sub/Tiny-Q4_K_M.gguf: ${R}/Tiny-Q4_K_M.gguf already used by ${R}:Tiny-Q4_K_M.gguf; skipped`]);
  });

  it('a repo without an mmproj gets a single link; a current file beats an older one with fewer slashes', async () => {
    const { drv, lc } = await setup({ repos: [{ id: 'o/m', main: 'new', snapshots: [
      { commit: 'new', mtime: 9, files: [{ path: 'deep/m.gguf', text: 'new' }] },
      { commit: 'old', mtime: 1, files: [{ path: 'm.gguf', text: 'old' }] }] }], views: ['lmstudio'] });
    const warnings: string[] = [];
    const ds = drv.desired(ggufEntries(lc.model), warnings);
    expect(ds.map((d) => [d.key, d.paths])).toEqual([['o/m:deep/m.gguf', ['o/m/m.gguf']]]);
    expect(warnings).toEqual(['[lmstudio] o/m:m.gguf: o/m/m.gguf already used by o/m:deep/m.gguf; skipped']);
  });
});

describe('lmstudio desired: paths the state file would reject', () => {
  it('an entry whose view path has a `..` segment is skipped with a warning, never desired (so never in the state)', () => {
    const drv = lmstudioDriver('/v', '/hub', nodeFs);
    const warnings: string[] = [];
    const ok = entry({ repoId: 'acme/Fine-GGUF', relpath: 'f.gguf' });
    const bad = entry({ repoId: 'acme/..', relpath: 'x.gguf' });
    const ds = drv.desired([bad, ok], warnings);
    expect(ds.map((d) => d.key)).toEqual([ok.key]);
    expect(warnings).toEqual([`[lmstudio] ${bad.key}: view path acme/../x.gguf lies outside the view; skipped`]);
  });
});

describe('lmstudio presence and isStale', () => {
  it('presence: absent / partial / correct / wrong (test_real_file_at_path_is_wrong)', async () => {
    const { drv, ds, root } = await setup();
    const d = q4(ds);
    expect(await drv.presence(d)).toBe('absent');
    mkdirSync(path.join(root, R), { recursive: true });
    const [primary, mm] = d.links.map((l) => path.join(root, l.path)) as [string, string];
    symlinkSync(d.links[1]!.target, mm);
    expect(await drv.presence(d)).toBe('absent');           // only the secondary link: primary not ok
    symlinkSync(d.links[0]!.target, primary);
    expect(await drv.presence(d)).toBe('correct');
    const only = await setup();
    mkdirSync(path.join(only.root, R), { recursive: true });
    symlinkSync(q4(only.ds).links[0]!.target, path.join(only.root, q4(only.ds).links[0]!.path));
    expect(await only.drv.presence(q4(only.ds))).toBe('partial');
  });

  it('a regular file or a different symlink at a path is wrong', async () => {
    const a = await setup();
    mkdirSync(path.join(a.root, R), { recursive: true });
    writeFileSync(path.join(a.root, q4(a.ds).links[0]!.path), 'user bytes');
    expect(await a.drv.presence(q4(a.ds))).toBe('wrong');
    const b = await setup();
    mkdirSync(path.join(b.root, R), { recursive: true });
    symlinkSync('/elsewhere/x.gguf', path.join(b.root, q4(b.ds).links[0]!.path));
    expect(await b.drv.presence(q4(b.ds))).toBe('wrong');
  });

  it('isStale: wrong links that all point into the hub (dangling counts) -> true; one pointing outside -> false', async () => {
    const { lc, drv, ds, root } = await setup();
    const d = q4(ds);
    mkdirSync(path.join(root, R), { recursive: true });
    const [p0, p1] = d.links.map((l) => path.join(root, l.path)) as [string, string];
    expect(await drv.isStale(d, OWNED)).toBe(false);                 // nothing wrong
    symlinkSync(path.join(lc.model.hubRoot, 'models--acme--Tiny-GGUF', 'blobs', 'gone'), p0);   // dangling, into the hub
    expect(await drv.isStale(d, OWNED)).toBe(true);
    symlinkSync('/somewhere/else.gguf', p1);                          // wrong and outside the hub
    expect(await drv.isStale(d, OWNED)).toBe(false);
  });

  it('isStale: a regular file at a wrong path is not stale', async () => {
    const { drv, ds, root } = await setup();
    mkdirSync(path.join(root, R), { recursive: true });
    writeFileSync(path.join(root, q4(ds).links[0]!.path), 'mine');
    expect(await drv.isStale(q4(ds), OWNED)).toBe(false);
  });
});

describe('lmstudio create', () => {
  it('create makes parents and absolute symlinks and returns the sorted paths', async () => {
    const { lc, drv, ds, root } = await setup();
    const d = q4(ds);
    expect(await drv.create(d, ctxOf(lc))).toEqual(d.paths);
    for (const l of d.links) expect(readlinkSync(path.join(root, l.path))).toBe(l.target);
    expect(await drv.presence(d)).toBe('correct');
  });

  it('never overwrites a regular file: SkipEntry and NO link was written', async () => {
    const { lc, drv, ds, root } = await setup();
    const d = q4(ds);
    mkdirSync(path.join(root, R), { recursive: true });
    writeFileSync(path.join(root, d.links[1]!.path), 'user bytes');
    await expect(drv.create(d, ctxOf(lc))).rejects.toThrow(new SkipEntry(`a file exists at ${d.links[1]!.path}`));
    expect(lstatOrNull(path.join(root, d.links[0]!.path))).toBeNull();
    expect(readFileSync(path.join(root, d.links[1]!.path), 'utf8')).toBe('user bytes');
  });

  it('a correct link is left untouched (same inode); a partial create fills only the missing one', async () => {
    const { lc, drv, ds, root } = await setup();
    const d = q4(ds);
    mkdirSync(path.join(root, R), { recursive: true });
    const first = path.join(root, d.links[0]!.path);
    symlinkSync(d.links[0]!.target, first);
    const before = lstatSync(first);
    await drv.create(d, ctxOf(lc));                                   // expect() is undefined: nothing to replace
    expect(lstatSync(first).ino).toBe(before.ino);
    expect(readlinkSync(path.join(root, d.links[1]!.path))).toBe(d.links[1]!.target);
    await drv.create(d, ctxOf(lc));                                   // fully correct: a no-op
    expect(lstatSync(first).ino).toBe(before.ino);
  });

  it('two quants of one repo both own the shared mmproj path; the second create reuses the link', async () => {
    const { lc, drv, ds, root } = await setup();
    const [a, b] = ds as [Desired, Desired];
    await drv.create(a, ctxOf(lc));
    const mm = path.join(root, `${R}/mmproj-F16.gguf`);
    const ino = lstatSync(mm).ino;
    expect(await drv.create(b, ctxOf(lc))).toEqual(b.paths);
    expect(lstatSync(mm).ino).toBe(ino);
    expect(await drv.presence(a)).toBe('correct');
    expect(await drv.presence(b)).toBe('correct');
  });

  it('replaces a wrong symlink only when its facts match the plan', async () => {
    const { lc, drv, ds, root } = await setup();
    const d = q4(ds);
    mkdirSync(path.join(root, R), { recursive: true });
    const p0 = path.join(root, d.links[0]!.path);
    symlinkSync(path.join(lc.model.hubRoot, 'models--acme--Tiny-GGUF', 'blobs', 'old'), p0);
    // not planned (undefined) and explicitly null: SkipEntry, link untouched, nothing else written
    await expect(drv.create(d, ctxOf(lc))).rejects.toThrow(new SkipEntry('changed since preview'));
    await expect(drv.create(d, ctxOf(lc, new Map([[d.links[0]!.path, null]])))).rejects.toThrow(new SkipEntry('changed since preview'));
    expect(lstatOrNull(path.join(root, d.links[1]!.path))).toBeNull();
    // planned, then the link changes before apply
    const planned = await plan(lc, root, [d.links[0]!.path]);
    await drv.create(d, ctxOf(lc, planned));
    expect(readlinkSync(p0)).toBe(d.links[0]!.target);
    // stale facts: replace the link again with a different one after "planning"
    const planned2 = await plan(lc, root, [d.links[0]!.path]);
    await lc.fs.unlink(p0);
    symlinkSync('/other/place.gguf', p0);
    await expect(drv.create(d, ctxOf(lc, planned2))).rejects.toThrow(new SkipEntry('changed since preview'));
    expect(readlinkSync(p0)).toBe('/other/place.gguf');
  });

  it('V20: a symlinked org folder is not traversed: SkipEntry, nothing written through it', async () => {
    const { lc, drv, ds, root } = await setup();
    const outside = await tempDir();
    symlinkSync(outside, path.join(root, 'acme'));
    await expect(drv.create(q4(ds), ctxOf(lc))).rejects.toThrow(SkipEntry);
    await expect(drv.create(q4(ds), ctxOf(lc))).rejects.toThrow(
      new SkipEntry(`${R}/Tiny-Q4_K_M.gguf: path is not strictly inside a view root; skipped`));
    expect(existsSync(path.join(outside, 'Tiny-GGUF'))).toBe(false);
  });

  it('V20: a symlinked org folder that stays inside the root is refused by mkdirp, with the exact SafeFs reason', async () => {
    const { lc, drv, ds, root } = await setup();
    mkdirSync(path.join(root, 'real'));
    symlinkSync(path.join(root, 'real'), path.join(root, 'acme'));
    const d = q4(ds);
    await expect(drv.create(d, ctxOf(lc))).rejects.toThrow(new SkipEntry(
      `${d.links[0]!.path}: EXISTS: ${path.join(root, 'acme')} is a symlink; refusing to traverse it (${path.join(root, 'acme', 'Tiny-GGUF')}); skipped`));
    expect(existsSync(path.join(root, 'real', 'Tiny-GGUF'))).toBe(false);
  });

  it('a view root that contains the hub cannot link into the hub tree', async () => {
    const { lc } = await setup();
    const hub = lc.model.hubRoot;
    const wide = lmstudioDriver(path.dirname(hub), hub, lc.fs);   // root = parent of the hub
    const d: Desired = { key: 'k', repoId: 'r', sha256: 'x', paths: ['hub/evil.gguf'],
      links: [{ path: 'hub/evil.gguf', primary: true, target: '/t' }] };
    await expect(wide.create(d, ctxOf(lc))).rejects.toThrow(`hub/evil.gguf: path is inside ${hub}; skipped`);
    expect(lstatOrNull(path.join(hub, 'evil.gguf'))).toBeNull();
  });
});

describe('lmstudio remove', () => {
  async function created(): Promise<Setup & { d: Desired }> {
    const s = await setup();
    const d = q4(s.ds);
    await s.drv.create(d, ctxOf(s.lc));
    return { ...s, d };
  }

  it('remove unlinks symlinks and empty parents, never the root', async () => {
    const { lc, drv, d, root } = await created();
    const ctx = ctxOf(lc, await plan(lc, root, d.paths));
    expect(await drv.remove(d.paths, ctx, 'x')).toEqual(d.paths);
    expect(existsSync(path.join(root, 'acme'))).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect(ctx.warnings).toEqual([]);
  });

  it('keeps a parent that still holds other files', async () => {
    const { lc, drv, d, root } = await created();
    writeFileSync(path.join(root, R, 'notes.txt'), 'n');
    await drv.remove(d.paths, ctxOf(lc, await plan(lc, root, d.paths)), 'x');
    expect(existsSync(path.join(root, R, 'notes.txt'))).toBe(true);
    expect(existsSync(path.join(root, R, 'Tiny-Q4_K_M.gguf'))).toBe(false);
  });

  it('remove keeps a regular file at an owned path', async () => {
    const { lc, drv, root } = await setup();
    mkdirSync(path.join(root, R), { recursive: true });
    writeFileSync(path.join(root, R, 'Tiny-Q4_K_M.gguf'), 'user bytes');
    const ctx = ctxOf(lc, await plan(lc, root, [`${R}/Tiny-Q4_K_M.gguf`]));
    expect(await drv.remove([`${R}/Tiny-Q4_K_M.gguf`], ctx, 'x')).toEqual([]);
    expect(readFileSync(path.join(root, R, 'Tiny-Q4_K_M.gguf'), 'utf8')).toBe('user bytes');
    expect(ctx.warnings.join('\n')).toMatch(/not a symlink; left in place/);
  });

  it('a missing path is skipped silently', async () => {
    const { lc, drv } = await setup();
    const ctx = ctxOf(lc);
    expect(await drv.remove([`${R}/gone.gguf`], ctx, 'x')).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });

  it('test_remove_refuses_a_path_through_a_symlinked_folder_leading_outside', async () => {
    const { lc, drv, root } = await setup();
    const outside = await tempDir();
    symlinkSync('/target/x', path.join(outside, 'x.gguf'));
    symlinkSync(outside, path.join(root, 'evil'));
    const ctx = ctxOf(lc, new Map([['evil/x.gguf', await factsOf(lc.fs, path.join(outside, 'x.gguf'))]]));
    expect(await drv.remove(['evil/x.gguf'], ctx, 'x')).toEqual([]);
    expect(readlinkSync(path.join(outside, 'x.gguf'))).toBe('/target/x');
    expect(ctx.warnings).toEqual(['evil/x.gguf: path is not strictly inside a view root; not removed']);
  });

  it('refuses when facts changed since planning (STALE) and keeps the link', async () => {
    const { lc, drv, d, root } = await created();
    const planned = await plan(lc, root, d.paths);
    const p = path.join(root, d.links[0]!.path);
    await lc.fs.unlink(p);
    symlinkSync('/new/target', p);
    const ctx = ctxOf(lc, planned);
    expect(await drv.remove(d.paths, ctx, 'x')).toEqual([d.links[1]!.path]);
    expect(readlinkSync(p)).toBe('/new/target');
    expect(ctx.warnings).toEqual([`${d.links[0]!.path}: changed since preview; left in place`]);
  });

  it('refuses a symlink with no planned facts (fail closed)', async () => {
    const { lc, drv, d, root } = await created();
    const ctx = ctxOf(lc);
    expect(await drv.remove([d.links[0]!.path], ctx, 'x')).toEqual([]);
    expect(lstatSync(path.join(root, d.links[0]!.path)).isSymbolicLink()).toBe(true);
    expect(ctx.warnings).toEqual([`${d.links[0]!.path}: changed since preview; left in place`]);
    expect(lstatSync(path.join(root, d.links[1]!.path)).isSymbolicLink()).toBe(true);
  });

  it('a path that reaches the hub is never removed, even if a symlink is there', async () => {
    const { lc } = await setup();
    const hub = lc.model.hubRoot;
    const link = path.join(hub, 'evil-link.gguf');
    symlinkSync('/t', link);
    const wide = lmstudioDriver(path.dirname(hub), hub, lc.fs);
    const rel = `${path.basename(hub)}/evil-link.gguf`;
    const ctx = ctxOf(lc, new Map([[rel, await factsOf(lc.fs, link)]]));
    expect(await wide.remove([rel], ctx, 'x')).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(ctx.warnings).toEqual([`${rel}: path is inside ${hub}; not removed`]);
  });
});

describe('lmstudio races and I/O failures (SafeFs refusals after the checks)', () => {
  const withFs = (lc: LoadedCase, fs: FsLike, planned: Map<string, FileFacts | null> = new Map()): ApplyCtx =>
    ({ safeFs: new SafeFs(lc.safeFs.roots, fs), fs: lc.fs, expect: (rel) => planned.get(rel), warnings: [] });

  it('create: a link that appears between check and write (EXISTS) is a SkipEntry; a permission error is not', async () => {
    const { lc, drv, ds } = await setup();
    await expect(drv.create(q4(ds), withFs(lc, failingFs(lc.fs, 'symlink', 'EEXIST')))).rejects.toThrow(SkipEntry);
    await expect(drv.create(q4(ds), withFs(lc, failingFs(lc.fs, 'symlink', 'EACCES')))).rejects.toThrow(/IO/);
    await expect(drv.create(q4(ds), withFs(lc, failingFs(lc.fs, 'symlink', 'EACCES')))).rejects.not.toBeInstanceOf(SkipEntry);
  });

  it('remove: a link swapped after the check (STALE inside SafeFs) is kept with a warning; a permission error aborts', async () => {
    const { lc, drv, ds, root } = await setup();
    const d = q4(ds);
    await drv.create(d, ctxOf(lc));
    const rel = d.links[0]!.path;
    const planned = await plan(lc, root, [rel]);
    const target = path.join(root, rel);
    const swapped: FsLike = { ...lc.fs, lstat: async (p) => {
      const st = await lc.fs.lstat(p);
      return p === target ? new Proxy(st, { get: (t, k) => (k === 'ino' ? t.ino + 1 : Reflect.get(t, k) as unknown) }) : st;
    } };
    const ctx = withFs(lc, swapped, planned);
    expect(await drv.remove([rel], ctx, 'x')).toEqual([]);
    expect(ctx.warnings).toEqual([`${rel}: changed since preview; left in place`]);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    await expect(drv.remove([rel], withFs(lc, failingFs(lc.fs, 'unlink', 'EACCES'), planned), 'x')).rejects.toThrow(/IO/);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('walkTree rethrows a readdir failure that is not "missing"', async () => {
    const { lc, root } = await setup();
    const bad = failingFs(lc.fs, 'readdir', 'EACCES');
    await expect((async () => { const seen: string[] = []; for await (const e of walkTree(bad, root)) seen.push(e.rel); })()).rejects.toThrow(/EACCES/);
  });
});

describe('resolved paths never reach the hub, the app folder or the hold root', () => {
  // A view root that is the parent of the hub (like a root of `~`), with symlinked subfolders into protected places.
  // nodeFs: these dirs are plain temp dirs, and the guarded fs refuses to resolve a root directly under the temp dir.
  async function wideSetup(): Promise<{ lc: LoadedCase; root: string; drv: ReturnType<typeof lmstudioDriver>; kept: string; held: string }> {
    const lc = await loadCase(spec);
    const root = path.dirname(lc.model.hubRoot);
    const held = path.join(root, '.hf-cache-manager', 'recently-deleted', 'D1');
    mkdirSync(held, { recursive: true });
    const kept = path.join(held, 'x.gguf');
    symlinkSync('/some/target', kept);
    symlinkSync(held, path.join(root, 'sneak'));
    symlinkSync(path.join(root, '.hf-cache-manager'), path.join(root, 'sneak-app'));
    symlinkSync(lc.model.hubRoot, path.join(root, 'sneak-hub'));
    return { lc, root, drv: lmstudioDriver(root, lc.model.hubRoot, nodeFs), kept, held };
  }
  const nodeCtx = (lc: LoadedCase, planned: Map<string, FileFacts | null>): ApplyCtx =>
    ({ safeFs: lc.safeFs, fs: nodeFs, expect: (rel) => planned.get(rel), warnings: [] });

  it('remove refuses a symlinked folder into the hold area, the app folder, and the hub, and keeps the link', async () => {
    const { lc, drv, kept, root } = await wideSetup();
    const rels = ['sneak/x.gguf', 'sneak-app/recently-deleted/D1/x.gguf'];
    const planned = new Map(await Promise.all(rels.map(async (r) => [r, await factsOf(nodeFs, path.join(root, r))] as const)));
    const hubLink = path.join(lc.model.hubRoot, 'hublink.gguf');
    symlinkSync('/t', hubLink);
    planned.set('sneak-hub/hublink.gguf', await factsOf(nodeFs, hubLink));
    const ctx = nodeCtx(lc, planned);
    expect(await drv.remove([...rels, 'sneak-hub/hublink.gguf'], ctx, 'x')).toEqual([]);
    const app = path.join(root, '.hf-cache-manager');
    expect(ctx.warnings).toEqual([
      `sneak/x.gguf: path is inside ${app}; not removed`,
      `sneak-app/recently-deleted/D1/x.gguf: path is inside ${app}; not removed`,
      `sneak-hub/hublink.gguf: path is inside ${lc.model.hubRoot}; not removed`,
    ]);
    expect(readlinkSync(kept)).toBe('/some/target');
    expect(readlinkSync(hubLink)).toBe('/t');
  });

  it('create refuses to write a link through such a folder', async () => {
    const { lc, drv, held } = await wideSetup();
    const d: Desired = { key: 'k', repoId: 'r', sha256: 'x', paths: ['sneak/new.gguf'], links: [{ path: 'sneak/new.gguf', primary: true, target: '/t' }] };
    await expect(drv.create(d, nodeCtx(lc, new Map()))).rejects.toThrow(
      new SkipEntry(`sneak/new.gguf: path is inside ${path.join(path.dirname(lc.model.hubRoot), '.hf-cache-manager')}; skipped`));
    expect(existsSync(path.join(held, 'new.gguf'))).toBe(false);
  });

  it('viewFs mutators apply the same resolved check', async () => {
    const { lc, root, held } = await wideSetup();
    const v = viewFs(lc.safeFs, root, nodeFs);
    await expect(v.symlink('/t', path.join(root, 'sneak', 'y.gguf'))).rejects.toBeInstanceOf(SkipEntry);
    await expect(v.mkdirp(path.join(root, 'sneak', 'sub'))).rejects.toBeInstanceOf(SkipEntry);
    await expect(v.rmdirEmpty(path.join(root, 'sneak', 'sub'))).rejects.toBeInstanceOf(SkipEntry);
    expect(existsSync(path.join(held, 'y.gguf'))).toBe(false);
    expect(existsSync(path.join(held, 'sub'))).toBe(false);
  });

  it('an unresolvable path (no existing ancestor but the filesystem root) is refused', async () => {
    const { lc, root } = await wideSetup();
    const broken: FsLike = { ...nodeFs, realpath: async () => { throw Object.assign(new Error('nope'), { code: 'EIO' }); } };
    const v = viewFs(lc.safeFs, root, broken);
    await expect(v.symlink('/t', path.join(root, 'z.gguf'))).rejects.toThrow(new SkipEntry('z.gguf: path cannot be resolved; skipped'));
  });
});

describe('removeEmptyParents reports unexpected I/O errors', () => {
  it('EACCES on a parent becomes a warning and never throws; a non-empty parent stays silent', async () => {
    const { lc, root } = await setup();
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const ctx: ApplyCtx = { safeFs: new SafeFs(lc.safeFs.roots, failingFs(lc.fs, 'lstat', 'EACCES', (p) => p === path.join(root, 'a', 'b'))), fs: lc.fs, expect: () => undefined, warnings: [] };
    await expect(removeEmptyParents(ctx, root, path.join(root, 'a', 'b', 'leaf'))).resolves.toBeUndefined();
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]).toMatch(/^a\/b: could not remove empty folder \(IO: .*EACCES.*\); left in place$/);
    expect(existsSync(path.join(root, 'a', 'b'))).toBe(true);
    const quiet = ctxOf(lc);
    writeFileSync(path.join(root, 'a', 'b', 'f'), 'f');
    await removeEmptyParents(quiet, root, path.join(root, 'a', 'b', 'leaf'));
    expect(quiet.warnings).toEqual([]);
  });
});

describe('lmstudio foreign', () => {
  it('unowned *.gguf files/symlinks under root, keys lmstudio:<rel>; skips symlinked dirs and the state file', async () => {
    const outside = await tempDir();
    writeFileSync(path.join(outside, 'z.gguf'), 'z');
    const { lc, drv, ds, root } = await setup({ ...spec, viewFiles: { lmstudio: {
      '.hfhub-state.json': '{}', 'user/own.gguf': 'mine', 'user/l.gguf': { link: '/some/where' }, 'user/readme.txt': 'r', 'notes.GGUF.bak': 'x',
    } } });
    await drv.create(q4(ds), ctxOf(lc));
    symlinkSync(outside, path.join(root, 'linkdir'));
    mkdirSync(path.join(root, 'dir.gguf'));
    expect(await drv.foreign(new Set([`${R}/Tiny-Q4_K_M.gguf`]))).toEqual([
      { key: `lmstudio:${R}/mmproj-F16.gguf`, path: `${R}/mmproj-F16.gguf`, target: expect.any(String) },
      { key: 'lmstudio:user/l.gguf', path: 'user/l.gguf', target: '/some/where' },
      { key: 'lmstudio:user/own.gguf', path: 'user/own.gguf' },
    ]);
  });

  it('a missing root has no foreign entries', async () => {
    const lc = await loadCase(spec);
    const drv = lmstudioDriver(path.join(await tempDir(), 'nope'), lc.model.hubRoot, lc.fs);
    expect(await drv.foreign(new Set())).toEqual([]);
  });
});

describe('walk helpers', () => {
  it('walkTree: depth-first in code-point order, yields dirs/files/symlinks, never descends a symlink, honours skip', async () => {
    const root = path.join(await tempDir(), 'tree');
    mkdirSync(root);
    const outside = path.join(await tempDir(), 'out');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret'), 's');
    mkdirSync(path.join(root, 'b'));
    mkdirSync(path.join(root, 'B'));
    writeFileSync(path.join(root, 'b', 'f'), 'f');
    writeFileSync(path.join(root, 'a'), 'a');
    writeFileSync(path.join(root, 'skipme'), 'x');
    symlinkSync(outside, path.join(root, 'ln'));
    const lc = await loadCase(spec);
    const seen: Array<[string, boolean, boolean]> = [];
    for await (const e of walkTree(lc.fs, root, (r) => r === 'skipme')) seen.push([e.rel, e.facts.isSymlink, e.facts.isDirectory]);
    expect(seen).toEqual([['B', false, true], ['a', false, false], ['b', false, true], ['b/f', false, false], ['ln', true, false]]);
    const none: string[] = [];
    for await (const e of walkTree(lc.fs, path.join(root, 'absent'))) none.push(e.rel);
    expect(none).toEqual([]);
  });

  it('insideRoot: parent realpath equal to or inside the root; false when outside or unresolvable', async () => {
    const root = path.join(await tempDir(), 'tree');
    mkdirSync(root);
    const outside = path.join(await tempDir(), 'out');
    mkdirSync(outside);
    const lc = await loadCase(spec);
    mkdirSync(path.join(root, 'd'));
    symlinkSync(outside, path.join(root, 'out'));
    expect(await insideRoot(lc.fs, root, path.join(root, 'leaf'))).toBe(true);
    expect(await insideRoot(lc.fs, root, path.join(root, 'd', 'leaf'))).toBe(true);
    expect(await insideRoot(lc.fs, root, path.join(root, 'out', 'leaf'))).toBe(false);
    expect(await insideRoot(lc.fs, root, path.join(root, 'missing', 'leaf'))).toBe(false);
    expect(await insideRoot(lc.fs, path.join(root, 'nope'), path.join(root, 'leaf'))).toBe(false);
  });

  it('linkIntoHub: absolute and relative targets resolve against the link folder; the hub itself and prefixes do not count', () => {
    expect(linkIntoHub('/v/a', '/hub/models--x/blobs/e', '/hub')).toBe(true);
    expect(linkIntoHub('/hub/models--x/snapshots/c', '../../blobs/e', '/hub')).toBe(true);
    expect(linkIntoHub('/v/a', '/hub', '/hub')).toBe(false);
    expect(linkIntoHub('/v/a', '/hub2/x', '/hub')).toBe(false);
    expect(linkIntoHub('/v/a', '../b', '/hub')).toBe(false);
    expect(linkIntoHub('/v/a', '/hub/x', '/hub/')).toBe(true);
  });

  it('ensureParent: no-op for a direct child of the root; creates nested parents; refuses a root-leading symlink', async () => {
    const { lc, root } = await setup();
    const ctx = ctxOf(lc);
    await ensureParent(ctx, root, path.join(root, 'file'));
    await ensureParent(ctx, root, path.join(root, 'x', 'y', 'file'));
    expect(lstatSync(path.join(root, 'x', 'y')).isDirectory()).toBe(true);
    writeFileSync(path.join(root, 'plain'), 'p');
    await expect(ensureParent(ctx, root, path.join(root, 'plain', 'file'))).rejects.toThrow(/plain\/file: .*skipped/);
    await expect(ensureParent(ctx, root, '/')).rejects.toBeInstanceOf(SkipEntry);
  });

  it('removeEmptyParents: stops at the first non-empty folder and never removes the root or a symlinked folder', async () => {
    const { lc, root } = await setup();
    const ctx = ctxOf(lc);
    mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(path.join(root, 'a', 'keep'), 'k');
    await removeEmptyParents(ctx, root, path.join(root, 'a', 'b', 'c', 'leaf'));
    expect(existsSync(path.join(root, 'a', 'b'))).toBe(false);
    expect(existsSync(path.join(root, 'a'))).toBe(true);
    await removeEmptyParents(ctx, root, path.join(root, 'leaf'));          // parent is the root
    await removeEmptyParents(ctx, root, path.join(path.dirname(root), 'elsewhere', 'leaf'));   // outside the root
    expect(existsSync(root)).toBe(true);
    const outside = await tempDir();
    symlinkSync(outside, path.join(root, 'ln'));
    await removeEmptyParents(ctx, root, path.join(root, 'ln', 'leaf'));
    expect(lstatSync(path.join(root, 'ln')).isSymbolicLink()).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it('viewFs: every mutator refuses a path outside the view root, with a SkipEntry, before touching SafeFs', async () => {
    const { lc, root } = await setup();
    const v = viewFs(lc.safeFs, root);
    const bad = path.join(lc.model.hubRoot, 'x');
    const facts = { dev: 1, ino: 1, size: 0, mtimeMs: 0, nlink: 1, isSymlink: true, isDirectory: false, isFile: false } satisfies FileFacts;
    await expect(v.unlink(bad, facts)).rejects.toBeInstanceOf(SkipEntry);
    await expect(v.rmdirEmpty(bad)).rejects.toBeInstanceOf(SkipEntry);
    await expect(v.symlink('/t', bad)).rejects.toBeInstanceOf(SkipEntry);
    await expect(v.mkdirp(bad)).rejects.toBeInstanceOf(SkipEntry);
    expect(lstatOrNull(bad)).toBeNull();
  });
});

describe('lmstudio create: failure after the first write', () => {
  it('throws CreateIncomplete listing the links already written (never a SkipEntry)', async () => {
    const s = await setup();
    const d = q4(s.ds);
    const second = path.join(s.root, d.links[1]!.path);
    const failing = await SafeFs.create({ hubRoot: s.lc.model.hubRoot, viewRoots: [s.root], holdRoot: null }, scriptedFs(s.lc.fs, [{ method: 'symlink', nth: 1, code: 'EACCES', pathIncludes: 'mmproj-F16.gguf' }]));
    const err = await s.drv.create(d, { ...ctxOf(s.lc), safeFs: failing }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreateIncomplete);
    expect(err).not.toBeInstanceOf(SkipEntry);
    expect((err as CreateIncomplete).written).toEqual([d.links[0]!.path]);
    expect((err as CreateIncomplete).cause).toMatchObject({ code: 'IO' });
    expect(lstatOrNull(path.join(s.root, d.links[0]!.path))?.isSymbolicLink()).toBe(true);
    expect(lstatOrNull(second)).toBeNull();
  });

  it('a failure on the very first write stays an error that wrote nothing (rethrown as is)', async () => {
    const s = await setup();
    const d = q4(s.ds);
    const failing = await SafeFs.create({ hubRoot: s.lc.model.hubRoot, viewRoots: [s.root], holdRoot: null }, failingFs(s.lc.fs, 'symlink', 'EACCES'));
    const err = await s.drv.create(d, { ...ctxOf(s.lc), safeFs: failing }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CreateIncomplete);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('lmstudio coverage closers', () => {
  it('desired: among older files the sort compares non-current weights too', async () => {
    const { drv, lc } = await setup({ repos: [{ id: 'o/m', main: 'new', snapshots: [
      { commit: 'new', mtime: 9, files: [{ path: 'a.gguf', text: 'a' }] },
      { commit: 'old', mtime: 1, files: [{ path: 'y.gguf', text: 'y' }, { path: 'z.gguf', text: 'z' }, { path: 'x/y.gguf', text: 'xy' }] }] }], views: ['lmstudio'] });
    const ds = drv.desired(ggufEntries(lc.model), []);
    expect(ds.map((d) => d.key)).toEqual(['o/m:a.gguf', 'o/m:y.gguf', 'o/m:z.gguf']);
  });

  it('foreign on win32 matches the .gguf suffix case-insensitively; elsewhere it is case-sensitive', async () => {
    const { drv, root } = await setup({ ...spec, viewFiles: { lmstudio: { 'u/Big.GGUF': 'b' } } });
    expect(root).toContain('views');
    expect(await drv.foreign(new Set())).toEqual([]);
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await drv.foreign(new Set())).toEqual([{ key: 'lmstudio:u/Big.GGUF', path: 'u/Big.GGUF' }]);
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
  });

  it('remove: a SafeFs refusal that is neither STALE nor an I/O failure is reported with its own message and the link stays', async () => {
    const { lc, drv, ds, root } = await setup();
    const d = q4(ds);
    await drv.create(d, ctxOf(lc));
    const rel = d.links[0]!.path;
    const planned = await plan(lc, root, [rel]);
    class Refusing extends SafeFs {
      override async unlink(p: string): Promise<void> { throw new SafeFsError('CONTAINMENT', p, 'moved outside the view'); }
    }
    const ctx: ApplyCtx = { safeFs: new Refusing(lc.safeFs.roots, lc.fs), fs: lc.fs, expect: (r) => planned.get(r), warnings: [] };
    expect(await drv.remove([rel], ctx, 'x')).toEqual([]);
    expect(ctx.warnings).toEqual([expect.stringMatching(new RegExp(`^${rel.replaceAll('.', '\\.')}: CONTAINMENT: moved outside the view .*; left in place$`))]);
    expect(lstatSync(path.join(root, rel)).isSymbolicLink()).toBe(true);
  });

  it('walkTree ignores an entry that vanishes between readdir and lstat', async () => {
    const { lc, root } = await setup({ ...spec, viewFiles: { lmstudio: { 'a.gguf': 'a', 'b.gguf': 'b' } } });
    const racy = failingFs(lc.fs, 'lstat', 'ENOENT', (p) => p === path.join(root, 'a.gguf'));
    const seen: string[] = [];
    for await (const e of walkTree(racy, root)) seen.push(e.rel);
    expect(seen).toEqual(['b.gguf']);
  });

  it('removeEmptyParents: an I/O refusal that carries no errno is still reported', async () => {
    const { lc, root } = await setup();
    mkdirSync(path.join(root, 'a'), { recursive: true });
    class NoErrno extends SafeFs {
      override async rmdirEmpty(p: string): Promise<void> { throw new SafeFsError('IO', p, 'odd failure'); }
    }
    const ctx: ApplyCtx = { safeFs: new NoErrno(lc.safeFs.roots, lc.fs), fs: lc.fs, expect: () => undefined, warnings: [] };
    await removeEmptyParents(ctx, root, path.join(root, 'a', 'leaf'));
    expect(ctx.warnings).toEqual([expect.stringMatching(/^a: could not remove empty folder \(IO: odd failure.*\); left in place$/)]);
  });

  it('linkIntoHub: a hub that is the filesystem root contains every absolute path', () => {
    expect(linkIntoHub('/v', '/anything/at/all', '/')).toBe(true);
  });
});
