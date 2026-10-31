import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyRepo } from '../../../src/core/classify/classify';
import { closeSelection, PlanError, targetOf, type Closure } from '../../../src/core/plan/closure';
import type { CacheModel, Repo, Selection, SnapshotFile } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { buildTree, f, groupKeyFor, scanTolerant, type RepoSpec, type Tree } from '../support/scenarios';

useCanaries();

const HEX40 = /^[0-9a-f]{40}$/;
const repoOf = (m: CacheModel, id: string): Repo => {
  const r = m.repos.find((x) => x.id === id);
  if (!r) throw new Error(`no repo ${id}`);
  return r;
};
const fileOf = (m: CacheModel, id: string, commit: string, rel: string): SnapshotFile => {
  const x = repoOf(m, id).files.find((y) => y.commit === commit && y.relpath === rel);
  if (!x) throw new Error(`no file ${commit}/${rel}`);
  return x;
};
const partial = (repoId: string, groupKeys: string[], unlockComponents = false): Selection =>
  ({ repos: [{ repoId, whole: false, groupKeys, unlockComponents }] });
const one = (m: CacheModel, s: Selection): Closure => {
  const cs = closeSelection(m, s);
  expect(cs).toHaveLength(1);
  return cs[0]!;
};
const planErr = (fn: () => unknown): PlanError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PlanError);
    return e as PlanError;
  }
  throw new Error('expected a PlanError');
};

const gguf: RepoSpec = { id: 'o/a', snapshots: { c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } };

describe('closeSelection: partial selections', () => {
  it('a quant group dooms its link and blob only', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf')]));
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c1', 'm-Q4_K_M.gguf')]);
    expect(c.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'm-Q4_K_M.gguf')]);
    expect(c.blobs[0]!.facts).toEqual(repoOf(m, 'o/a').blobs[t.etag('Q4', 4000)]!.facts);
    expect(c.refused).toEqual([]);
    expect(c.others).toEqual([]);
    expect(c.whole).toBe(false);
    expect(c.repo).toBe(repoOf(m, 'o/a'));
    expect(c.selectedGroupKeys).toEqual([groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf')]);
  });

  it('pulls older-snapshot links to a doomed blob into the closure', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } }] });
    const m = await t.scan();
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf')]));
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c0', 'm-Q4_K_M.gguf'), t.link('o/a', 'c1', 'm-Q4_K_M.gguf')].sort());
    expect(c.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'm-Q4_K_M.gguf')]);
    expect(c.refused).toEqual([]);
  });

  it('an older link under another name to the doomed blob also goes', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'renamed.gguf': f('blob', 'Q4', 4000) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } }] });
    const m = await t.scan();
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf')]));
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c0', 'renamed.gguf'), t.link('o/a', 'c1', 'm-Q4_K_M.gguf')].sort());
    expect(c.blobs).toHaveLength(1);
  });

  it('a blob also linked by an unselected current file is kept and the selected link refused', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: {
      'm-Q4_K_M.gguf': f('blob', 'SAME', 5000), 'm-Q8_0.gguf': f('blob', 'SAME', 5000) } } }] });
    const m = await t.scan();
    const q4 = groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf');
    const q8 = groupKeyFor(m, 'o/a', 'm-Q8_0.gguf');
    expect(q4).not.toBe(q8);
    const c = one(m, partial('o/a', [q4]));
    expect(c.links).toEqual([]);
    expect(c.blobs).toEqual([]);
    const label = classifyRepo(repoOf(m, 'o/a')).groups.find((g) => g.key === q8)!.label;
    expect(c.refused).toEqual([{ file: fileOf(m, 'o/a', 'c1', 'm-Q4_K_M.gguf'), sameAs: 'm-Q8_0.gguf', groupLabel: label }]);
  });

  it('selecting every current link to a shared blob dooms it once with all links', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: {
      'm-Q4_K_M.gguf': f('blob', 'SAME', 5000), 'm-Q8_0.gguf': f('blob', 'SAME', 5000) } } }] });
    const m = await t.scan();
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf'), groupKeyFor(m, 'o/a', 'm-Q8_0.gguf')]));
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c1', 'm-Q4_K_M.gguf'), t.link('o/a', 'c1', 'm-Q8_0.gguf')]);
    expect(c.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'm-Q4_K_M.gguf')]);
    expect(c.refused).toEqual([]);
  });

  it('superseded group: link only in c0 and its blob are doomed', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'old.gguf': f('blob', 'O', 100) }, c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000) } } }] });
    const m = await t.scan();
    const key = groupKeyFor(m, 'o/a', 'old.gguf');
    expect(key.startsWith('superseded:')).toBe(true);
    const c = one(m, partial('o/a', [key]));
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c0', 'old.gguf')]);
    expect(c.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'old.gguf', 'c0')]);
    expect(c.refused).toEqual([]);
  });

  it('the "Files only in dev" group is deleted like any other group; main is untouched', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000) }, c2: { 'dev.gguf': f('blob', 'D', 100) } } }] });
    await mkdir(join(t.folder('o/a'), 'refs'), { recursive: true });
    await writeFile(join(t.folder('o/a'), 'refs', 'main'), 'c1');
    await writeFile(join(t.folder('o/a'), 'refs', 'dev'), 'c2');
    const m = await t.scan();
    const key = groupKeyFor(m, 'o/a', 'dev.gguf');
    expect(key).toBe('other:Files only in dev');
    const c = one(m, partial('o/a', [key]));
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c2', 'dev.gguf')]);
    expect(c.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'dev.gguf', 'c2')]);
    expect(c.refused).toEqual([]);
  });

  it('a plain snapshot file is doomed as a link with no blob', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'notes.txt': f('plain', 'N', 30) } } }] });
    const m = await t.scan();
    const file = fileOf(m, 'o/a', 'c1', 'notes.txt');
    expect(targetOf(repoOf(m, 'o/a'), file)).toEqual({ kind: 'plain' });
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'notes.txt')]));
    expect(c.links).toEqual([file]);
    expect(c.blobs).toEqual([]);
  });

  it('a non-LFS file goes with its 40-hex blob', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'config.json': f('small', 'CFG', 300) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'config.json': f('small', 'CFG', 300) } } }] });
    const m = await t.scan();
    const repo = repoOf(m, 'o/a');
    const blobPath = t.blob('o/a', 'config.json');
    expect(HEX40.test(basename(blobPath))).toBe(true);
    const other = repo.otherFiles.find((o) => o.path === blobPath)!;
    expect(targetOf(repo, fileOf(m, 'o/a', 'c1', 'config.json'))).toEqual({ kind: 'blob', path: blobPath, facts: other.facts });
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'config.json')]));
    expect(c.blobs).toEqual([{ path: blobPath, facts: other.facts }]);
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c0', 'config.json'), t.link('o/a', 'c1', 'config.json')].sort());
  });

  it('an older non-LFS link to a current 40-hex blob is in no group, and goes when that blob is doomed', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'config.json': f('small', 'CFG', 300), 'old.gguf': f('blob', 'O', 100) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'config.json': f('small', 'CFG', 300) } } }] });
    const m = await t.scan();
    const sup = one(m, partial('o/a', ['superseded:superseded (older revision)']));
    expect(sup.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c0', 'old.gguf')]);
    expect(sup.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'old.gguf', 'c0')]);
    expect(sup.refused).toEqual([]);
    const oldCfg = t.link('o/a', 'c0', 'config.json');
    const cur = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'config.json')]));
    expect(cur.links.map((l) => l.linkPath)).toEqual([oldCfg, t.link('o/a', 'c1', 'config.json')].sort());
    expect(cur.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'config.json')]);
    const whole = one(m, { repos: [{ repoId: 'o/a', whole: true }] });
    expect(whole.links.map((l) => l.linkPath)).toContain(oldCfg);
    expect(whole.blobs.map((b) => b.path)).toContain(t.blob('o/a', 'config.json'));
  });

  it('a link whose target is not a repo blob is doomed alone', async () => {
    const t = await buildTree({ repos: [gguf] });
    const p = t.link('o/a', 'c1', 'notes.txt');
    await t.fs.symlink(relative(dirname(p), join(t.folder('o/a'), 'blobs', 'f'.repeat(64))), p);
    const m = await scanTolerant(t);
    const file = fileOf(m, 'o/a', 'c1', 'notes.txt');
    expect(targetOf(repoOf(m, 'o/a'), file)).toEqual({ kind: 'other' });
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'notes.txt')]));
    expect(c.links).toEqual([file]);
    expect(c.blobs).toEqual([]);
    expect(c.refused).toEqual([]);
  });

  it('a link to a non-hex file under blobs/ is other, never a blob', async () => {
    const t = await buildTree({ repos: [{ ...gguf, incomplete: [{ etag: 'e'.repeat(64), ageMs: 3_600_000 }] }] });
    const inc = join(t.folder('o/a'), 'blobs', 'e'.repeat(64) + '.incomplete');
    const p = t.link('o/a', 'c1', 'notes.txt');
    await t.fs.symlink(relative(dirname(p), inc), p);
    const m = await scanTolerant(t);
    expect(repoOf(m, 'o/a').otherFiles.some((o) => o.path === inc)).toBe(true);
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'notes.txt')]));
    expect(targetOf(repoOf(m, 'o/a'), fileOf(m, 'o/a', 'c1', 'notes.txt'))).toEqual({ kind: 'other' });
    expect(c.links.map((l) => l.linkPath)).toEqual([p]);
    expect(c.blobs).toEqual([]);
  });

  it('closures follow selection order across repos', async () => {
    const t = await buildTree({ repos: [gguf, { id: 'o/b', snapshots: { c1: { 'x-Q4_K_M.gguf': f('blob', 'X', 10) } } }] });
    const m = await t.scan();
    const cs = closeSelection(m, { repos: [
      { repoId: 'o/b', whole: false, groupKeys: [groupKeyFor(m, 'o/b', 'x-Q4_K_M.gguf')], unlockComponents: false },
      { repoId: 'o/a', whole: true }] });
    expect(cs.map((c) => [c.repo.id, c.whole])).toEqual([['o/b', false], ['o/a', true]]);
  });
});

describe('closeSelection: locked groups', () => {
  const pipeline: RepoSpec = { id: 'o/p', snapshots: { c1: {
    'model_index.json': f('plain', 'MI', 10), 'vae/diffusion_pytorch_model.safetensors': f('blob', 'V', 100),
    'flux.safetensors': f('blob', 'F', 200) } } };
  const readable = async (): Promise<{ t: Tree; m: CacheModel }> => {
    const t = await buildTree({ repos: [pipeline] });
    await t.fs.writeFile(t.link('o/p', 'c1', 'model_index.json'), JSON.stringify({ _class_name: 'P', vae: ['diffusers', 'AutoencoderKL'] }));
    return { t, m: await t.scan() };
  };

  it('locked component group → PlanError LOCKED_GROUP; unlockComponents: true succeeds', async () => {
    const { t, m } = await readable();
    expect(planErr(() => closeSelection(m, partial('o/p', ['component:vae/']))).code).toBe('LOCKED_GROUP');
    expect(planErr(() => closeSelection(m, partial('o/p', ['component:model_index.json']))).code).toBe('LOCKED_GROUP');
    const c = one(m, partial('o/p', ['component:vae/'], true));
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/p', 'c1', 'vae/diffusion_pytorch_model.safetensors')]);
    expect(c.blobs.map((b) => b.path)).toEqual([t.blob('o/p', 'vae/diffusion_pytorch_model.safetensors')]);
  });

  it('an unlocked group of a pipeline needs no unlock', async () => {
    const { t, m } = await readable();
    const c = one(m, partial('o/p', [groupKeyFor(m, 'o/p', 'flux.safetensors')]));
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/p', 'c1', 'flux.safetensors')]);
  });

  it('fail-closed other:* group of an unreadable model_index.json is locked too', async () => {
    const t = await buildTree({ repos: [pipeline] });
    const m = await t.scan();
    const g = classifyRepo(repoOf(m, 'o/p')).groups.find((x) => x.key === 'other:vae/')!;
    expect(g.locked).toBe(true);
    expect(planErr(() => closeSelection(m, partial('o/p', ['other:vae/']))).code).toBe('LOCKED_GROUP');
    expect(one(m, partial('o/p', ['other:vae/'], true)).links).toHaveLength(1);
  });

  it('unlockComponents must be exactly true', async () => {
    const { m } = await readable();
    const s = { repos: [{ repoId: 'o/p', whole: false, groupKeys: ['component:vae/'], unlockComponents: 'yes' }] } as unknown as Selection;
    expect(planErr(() => closeSelection(m, s)).code).toBe('LOCKED_GROUP');
  });

  it('whole repo needs no unlock for a pipeline', async () => {
    const { m } = await readable();
    expect(one(m, { repos: [{ repoId: 'o/p', whole: true }] }).links).toHaveLength(3);
  });
});

describe('closeSelection: PlanError codes', () => {
  it('PlanError carries its code and name', () => {
    const e = new PlanError('UNKNOWN_REPO', 'x');
    expect(e).toBeInstanceOf(Error);
    expect([e.code, e.name, e.message]).toEqual(['UNKNOWN_REPO', 'PlanError', 'x']);
  });

  it('unknown repo UNKNOWN_REPO, unknown key UNKNOWN_GROUP, duplicate repoId / empty groupKeys / empty repos INVALID_SELECTION', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    expect(planErr(() => closeSelection(m, { repos: [{ repoId: 'o/zz', whole: true }] })).code).toBe('UNKNOWN_REPO');
    expect(planErr(() => closeSelection(m, partial('o/a', ['quant:nope']))).code).toBe('UNKNOWN_GROUP');
    expect(planErr(() => closeSelection(m, { repos: [{ repoId: 'o/a', whole: true }, { repoId: 'o/a', whole: true }] })).code)
      .toBe('INVALID_SELECTION');
    expect(planErr(() => closeSelection(m, partial('o/a', []))).code).toBe('INVALID_SELECTION');
    expect(planErr(() => closeSelection(m, { repos: [] })).code).toBe('INVALID_SELECTION');
  });

  it('malformed selections are INVALID_SELECTION', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const key = groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf');
    const bad = (s: unknown): string => planErr(() => closeSelection(m, s as Selection)).code;
    expect(bad(partial('o/a', [key, key]))).toBe('INVALID_SELECTION');
    expect(bad({ repos: [{ repoId: 'o/a', whole: 'yes', groupKeys: [key], unlockComponents: false }] })).toBe('INVALID_SELECTION');
    expect(bad({ repos: [{ repoId: 'o/a', whole: false, unlockComponents: false }] })).toBe('INVALID_SELECTION');
    expect(bad({ repos: [{ repoId: 'o/a', whole: false, groupKeys: [7], unlockComponents: false }] })).toBe('INVALID_SELECTION');
    expect(bad({})).toBe('INVALID_SELECTION');
    expect(bad(null)).toBe('INVALID_SELECTION');
    expect(bad({ repos: [null] })).toBe('INVALID_SELECTION');
  });

  it('validates every repo before closing any (no partial result)', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    expect(planErr(() => closeSelection(m, { repos: [{ repoId: 'o/a', whole: true }, { repoId: 'o/zz', whole: true }] })).code)
      .toBe('UNKNOWN_REPO');
  });
});

describe('closeSelection: whole repo', () => {
  it('whole repo: every file, every blob, others = every non-hex otherFile', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'old.gguf': f('blob', 'O', 100) },
      c1: { 'sub/m.gguf': f('store', 'S', 2000), 'config.json': f('small', 'C', 50), 'README.md': f('plain', 'R', 30) } },
    incomplete: [{ etag: 'e'.repeat(64), ageMs: 3_600_000 }], extra: { '.no_exist/c1/tokenizer.json': '' } }] });
    const m = await t.scan();
    const repo = repoOf(m, 'o/a');
    const c = one(m, { repos: [{ repoId: 'o/a', whole: true }] });
    const folder = t.folder('o/a');
    expect(c.whole).toBe(true);
    expect(c.refused).toEqual([]);
    expect(c.selectedGroupKeys).toEqual(classifyRepo(repo).groups.map((g) => g.key));
    expect(c.links.map((l) => l.linkPath)).toEqual(repo.files.map((x) => x.linkPath).sort());
    expect(c.blobs.map((b) => b.path)).toEqual(
      [t.blob('o/a', 'old.gguf', 'c0'), t.blob('o/a', 'sub/m.gguf'), t.blob('o/a', 'config.json')].sort());
    const others = c.others.map((o) => o.path);
    expect(others).toEqual(expect.arrayContaining([
      join(folder, 'refs', 'main'), join(folder, '.no_exist', 'c1', 'tokenizer.json'),
      join(folder, 'blobs', 'e'.repeat(64) + '.incomplete')]));
    expect(others).toEqual([...others].sort());
    expect(others.some((p) => HEX40.test(basename(p)) && dirname(p) === join(folder, 'blobs'))).toBe(false);
    // every non-directory entry of the repo is in exactly one list, with its scanned facts
    const all = [...repo.files.map((x) => x.linkPath), ...Object.values(repo.blobs).map((b) => b.path), ...repo.otherFiles.map((o) => o.path)];
    const got = [...c.links.map((l) => l.linkPath), ...c.blobs.map((b) => b.path), ...others];
    expect(got.sort()).toEqual(all.sort());
    for (const o of c.others) expect(o.facts).toEqual(repo.otherFiles.find((x) => x.path === o.path)!.facts);
  });
});

describe('closeSelection: exact refusals and ordering (mutation gate)', () => {
  it('every refusal carries its exact message', async () => {
    const t = await buildTree({ repos: [gguf] });
    const m = await t.scan();
    const q4 = groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf');
    const msg = (s: unknown): string => planErr(() => closeSelection(m, s as Selection)).message;
    expect(msg({ repos: [] })).toBe('Selection names no repos');
    expect(msg({ repos: [{ whole: true }] })).toBe('Selection entry has no repo id');
    expect(msg({ repos: [{ repoId: 'o/a', whole: true }, { repoId: 'o/a', whole: true }] })).toBe('o/a is selected twice');
    expect(msg({ repos: [{ repoId: 'o/a', whole: 1 }] })).toBe('o/a: whole must be true or false');
    expect(msg({ repos: [{ repoId: 'o/a', whole: false, groupKeys: [] }] })).toBe('o/a: no groups selected');
    expect(msg({ repos: [{ repoId: 'o/a', whole: false, groupKeys: [1] }] })).toBe('o/a: group keys must be strings');
    expect(msg({ repos: [{ repoId: 'o/a', whole: false, groupKeys: [q4, q4] }] })).toBe('o/a: a group is selected twice');
    expect(msg({ repos: [{ repoId: 'o/x', whole: true }] })).toBe('o/x is not in the cache');
    expect(msg({ repos: [{ repoId: 'o/a', whole: false, groupKeys: ['nope'] }] })).toBe('o/a has no group nope');
  });

  it('blobs and refused links come out sorted by path whatever the group order', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: {
      'm-Q4_K_M.gguf': f('blob', 'X', 400), 'm-Q8_0.gguf': f('blob', 'Y', 800), 'm-Q2_K.gguf': f('blob', 'Z', 200), 'm-Q6_K.gguf': f('blob', 'W', 600),
      'keep-x.bin': f('blob', 'X', 400), 'keep-y.bin': f('blob', 'Y', 800) } } }] });
    const m = await t.scan();
    const keys = ['m-Q4_K_M.gguf', 'm-Q8_0.gguf', 'm-Q2_K.gguf', 'm-Q6_K.gguf'].map((r) => groupKeyFor(m, 'o/a', r));
    for (const order of [keys, [...keys].reverse()]) {
      const c = one(m, partial('o/a', order));
      expect(c.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'm-Q2_K.gguf'), t.blob('o/a', 'm-Q6_K.gguf')].sort());
      expect(c.refused.map((r) => r.file.linkPath)).toEqual([t.link('o/a', 'c1', 'm-Q4_K_M.gguf'), t.link('o/a', 'c1', 'm-Q8_0.gguf')]);
    }
  });
});

/**
 * A blob (and so each of its links) is doomed only when every link to it is selected. A link
 * in another ref-named snapshot, an unselected superseded file, or a link in no group of a ref-named snapshot keeps it.
 * Only a link in no group of a snapshot no ref names (an older revision of a current file) goes with its blob.
 */
describe('closeSelection: blobs shared across ref-named and older snapshots', () => {
  /** main=c1; refs/dev=c2; refs/refs/pr/1=c3; c2 and c3 share blob B; c2 and c0 (no ref) share blob D; E only in c2. */
  const refsHub = (): Promise<Tree> => buildTree({ repos: [{ id: 'o/a', main: 'c1', snapshots: {
    c0: { 'old.gguf': f('blob', 'D', 300) },
    c1: { 'a-Q4_K_M.gguf': f('blob', 'A', 1000) },
    c2: { 'shared.gguf': f('blob', 'B', 200), 'olddev.gguf': f('blob', 'D', 300), 'own.gguf': f('blob', 'E', 50) },
    c3: { 'shared.gguf': f('blob', 'B', 200) } },
    extra: { 'refs/dev': 'c2', 'refs/refs/pr/1': 'c3' } }] });
  const DEV = 'other:Files only in dev';
  const PR = 'other:Files only in refs/pr/1';
  const SUP = 'superseded:superseded (older revision)';

  it('the groups are as the reviewer saw them', async () => {
    const t = await refsHub();
    const m = await t.scan();
    const groups = classifyRepo(repoOf(m, 'o/a')).groups.map((g) => [g.key, g.files.map((x) => `${x.commit}/${x.relpath}`).sort()]);
    expect(groups).toEqual([
      [expect.stringMatching(/^quant:/), ['c1/a-Q4_K_M.gguf']],
      [DEV, ['c2/olddev.gguf', 'c2/own.gguf', 'c2/shared.gguf']],
      [PR, ['c3/shared.gguf']],
      [SUP, ['c0/old.gguf']],
    ]);
  });

  it('selecting "Files only in dev" dooms only own.gguf; shared (pr/1) and olddev (superseded) are kept and named', async () => {
    const t = await refsHub();
    const m = await t.scan();
    const c = one(m, partial('o/a', [DEV]));
    expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c2', 'own.gguf')]);
    expect(c.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'own.gguf', 'c2')]);
    expect(c.refused).toEqual([
      { file: fileOf(m, 'o/a', 'c2', 'olddev.gguf'), sameAs: 'old.gguf', groupLabel: 'superseded (older revision)' },
      { file: fileOf(m, 'o/a', 'c2', 'shared.gguf'), sameAs: 'shared.gguf', groupLabel: 'Files only in refs/pr/1' },
    ].sort((a, b) => (a.file.linkPath < b.file.linkPath ? -1 : 1)));
  });

  it('selecting superseded never unlinks a file of a ref-named snapshot', async () => {
    const t = await refsHub();
    const m = await t.scan();
    const c = one(m, partial('o/a', [SUP]));
    expect(c.links).toEqual([]);
    expect(c.blobs).toEqual([]);
    expect(c.refused).toEqual([{ file: fileOf(m, 'o/a', 'c0', 'old.gguf'), sameAs: 'olddev.gguf', groupLabel: 'Files only in dev' }]);
  });

  it('selecting "Files only in refs/pr/1" never unlinks c2/shared.gguf', async () => {
    const t = await refsHub();
    const m = await t.scan();
    const c = one(m, partial('o/a', [PR]));
    expect(c.links).toEqual([]);
    expect(c.blobs).toEqual([]);
    expect(c.refused).toEqual([{ file: fileOf(m, 'o/a', 'c3', 'shared.gguf'), sameAs: 'shared.gguf', groupLabel: 'Files only in dev' }]);
  });

  it('selecting both groups that share a blob dooms it with every link; all three groups free everything', async () => {
    const t = await refsHub();
    const m = await t.scan();
    const two = one(m, partial('o/a', [DEV, PR]));
    expect(two.blobs.map((b) => b.path)).toEqual([t.blob('o/a', 'own.gguf', 'c2'), t.blob('o/a', 'shared.gguf', 'c2')].sort());
    expect(two.links.map((l) => l.linkPath)).toEqual(
      [t.link('o/a', 'c2', 'own.gguf'), t.link('o/a', 'c2', 'shared.gguf'), t.link('o/a', 'c3', 'shared.gguf')].sort());
    expect(two.refused.map((r) => r.file.relpath)).toEqual(['olddev.gguf']);
    const three = one(m, partial('o/a', [DEV, PR, SUP]));
    expect(three.links).toHaveLength(5);
    expect(three.blobs).toHaveLength(3);
    expect(three.refused).toEqual([]);
  });

  it('a current file whose blob a ref-named snapshot also links (no group there) is kept, naming that snapshot', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', main: 'c1', snapshots: {
      c1: { 'a-Q4_K_M.gguf': f('blob', 'A', 1000), 'a-Q8_0.gguf': f('blob', 'Q8', 2000) },
      c2: { 'a-Q4_K_M.gguf': f('blob', 'A', 1000) } }, extra: { 'refs/dev': 'c2', 'refs/v1': 'c2' } }] });
    const m = await t.scan();
    expect(() => groupKeyFor(m, 'o/a', 'nothing')).toThrow();
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'a-Q4_K_M.gguf')]));
    expect(c.links).toEqual([]);
    expect(c.blobs).toEqual([]);
    expect(c.refused).toEqual([{ file: fileOf(m, 'o/a', 'c1', 'a-Q4_K_M.gguf'), sameAs: 'a-Q4_K_M.gguf', groupLabel: null, snapshot: 'snapshot c2 (dev, v1)' }]);
  });

  it('refs unreadable (null): a non-current link in no group keeps the blob (every snapshot may be ref-named)', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'old.gguf': f('blob', 'Q4', 4000) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } }] });
    const m = structuredClone(await t.scan());
    repoOf(m, 'o/a').refs = null;
    const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf')]));
    expect(c.links).toEqual([]);
    expect(c.refused).toEqual([{ file: fileOf(m, 'o/a', 'c1', 'm-Q4_K_M.gguf'), sameAs: 'old.gguf', groupLabel: null, snapshot: 'snapshot c0' }]);
  });

  it('a model without refs (none known, as classify reads it): the older link goes with its blob, main or no main', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'old.gguf': f('blob', 'Q4', 4000) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } }] });
    const m = structuredClone(await t.scan());
    const repo = repoOf(m, 'o/a');
    delete repo.refs;
    for (const main of ['c1', null]) {
      repo.mainCommit = main;
      const c = one(m, partial('o/a', [groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf')]));
      expect(c.links.map((l) => l.linkPath)).toEqual([t.link('o/a', 'c0', 'old.gguf'), t.link('o/a', 'c1', 'm-Q4_K_M.gguf')]);
      expect(c.refused).toEqual([]);
    }
  });

  it('several blockers: the first is named, the other places are listed once each', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', main: 'c1', snapshots: {
      c0: { 'x.gguf': f('blob', 'X', 10) },
      c1: { 'a-Q4_K_M.gguf': f('blob', 'A', 1000) },
      c2: { 'x.gguf': f('blob', 'X', 10), 'y.gguf': f('blob', 'X', 10) },
      c3: { 'x.gguf': f('blob', 'X', 10) } }, extra: { 'refs/dev': 'c2', 'refs/pr': 'c3' } }] });
    const m = await t.scan();
    const c = one(m, partial('o/a', ['other:Files only in pr']));
    expect(c.links).toEqual([]);
    expect(c.refused).toEqual([{ file: fileOf(m, 'o/a', 'c3', 'x.gguf'), sameAs: 'x.gguf', groupLabel: 'superseded (older revision)',
      alsoIn: ['unselected group Files only in dev'] }]);
  });
});
