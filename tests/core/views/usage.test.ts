import { existsSync, mkdirSync, truncateSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppLock } from '../../../src/core/exec/lock';
import { executeSync, planSync } from '../../../src/core/sync/sync';
import { buildUsageIndex } from '../../../src/core/views/usage';
import { MT } from '../../../src/core/views/registry';
import { useCanaries } from '../../helpers/canary';
import { treeDigest } from '../../helpers/tree-digest';
import { fakeFetch, ggufBytes, loadCase, sha256Hex, type CaseSpec, type LoadedCase } from './_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const R = 'acme/Tiny-GGUF';
const K = `${R}:Tiny-Q4_K_M.gguf`;
const g15 = { arch: 'llama', fileType: 15, tensors: [[4, 4]] };
const q4 = sha256Hex(ggufBytes(g15));
const NOW = new Date(2026, 9, 25, 14, 3, 7);
const tiny = (views: Array<'lmstudio' | 'ollama'>, extra: Partial<CaseSpec> = {}): CaseSpec => ({
  repos: [{ id: R, main: 'c1', snapshots: [{ commit: 'c1', mtime: 1, files: [{ path: 'Tiny-Q4_K_M.gguf', gguf: g15 }] }] }],
  views, ...extra,
});

async function synced(spec: CaseSpec): Promise<LoadedCase> {
  const lc = await loadCase(spec);
  const plan = await planSync(lc.config, lc.model, { offline: false, now: NOW.getTime() });
  await executeSync(plan, { safeFs: lc.safeFs, fs: lc.fs, fetch: fakeFetch({ status: 404 }), allowMassRemoval: false,
    token: null, now: () => NOW, lock: new AppLock(path.join(lc.c.dir, 'app-lock')) });
  return lc;
}
const blob = (lc: LoadedCase): string => path.join(lc.model.hubRoot, 'models--acme--Tiny-GGUF', 'blobs', q4);

describe('buildUsageIndex', () => {
  it('maps etags to LM Studio paths and Ollama tags, including foreign links and manifests', async () => {
    const lc = await synced(tiny(['lmstudio', 'ollama'], { aliases: { tiny: K } }));
    const lm = lc.config.views.lmstudio.root!;
    const ol = lc.config.views.ollama.root!;
    mkdirSync(path.join(lm, 'user'), { recursive: true });
    symlinkSync(blob(lc), path.join(lm, 'user', 'copy.gguf'));
    const before = { lm: await treeDigest(lm), ol: await treeDigest(ol) };
    expect(await buildUsageIndex(lc.config, lc.model, lc.fs)).toEqual({
      [q4]: { lmstudio: [`${R}/Tiny-Q4_K_M.gguf`, 'user/copy.gguf'], ollama: ['hf.co/acme/Tiny-GGUF:Q4_K_M', 'tiny:latest'] } });
    expect({ lm: await treeDigest(lm), ol: await treeDigest(ol) }).toEqual(before);
  });

  it('names tags per registry shape and counts projector layers', async () => {
    const lc = await loadCase(tiny(['ollama']));
    const ol = lc.config.views.ollama.root!;
    const man = (rel: string, layers: Array<[string, string]>): void => {
      mkdirSync(path.dirname(path.join(ol, 'manifests', rel)), { recursive: true });
      writeFileSync(path.join(ol, 'manifests', rel), JSON.stringify({ layers: layers.map(([mediaType, digest]) => ({ mediaType, digest })) }));
    };
    man('registry.ollama.ai/library/foo/bar', [[MT.model, `sha256:${q4}`]]);
    man('registry.ollama.ai/me/foo/bar', [[MT.projector, `sha256:${q4}`]]);
    man('example.com/a/b/t', [[MT.model, `sha256:${q4}`]]);
    man('hf.co/x/y/z', [[MT.template, `sha256:${q4}`]]);
    expect(await buildUsageIndex(lc.config, lc.model, lc.fs)).toEqual({
      [q4]: { lmstudio: [], ollama: ['example.com/a/b:t', 'foo:bar', 'me/foo:bar'] } });
  });

  it('ignores links to non-repo-blob targets and unparseable manifests', async () => {
    const lc = await loadCase(tiny(['lmstudio', 'ollama']));
    const lm = lc.config.views.lmstudio.root!;
    const ol = lc.config.views.ollama.root!;
    symlinkSync(path.join(lc.c.dir, 'elsewhere.gguf'), path.join(lm, 'dangling.gguf'));
    symlinkSync(path.join(lc.model.hubRoot, 'models--acme--Tiny-GGUF', 'snapshots', 'c1', 'Tiny-Q4_K_M.gguf'), path.join(lm, 'hop2.gguf'));
    writeFileSync(path.join(lm, 'plain.gguf'), 'x');
    mkdirSync(path.join(ol, 'manifests', 'hf.co', 'a', 'b'), { recursive: true });
    writeFileSync(path.join(ol, 'manifests', 'hf.co', 'a', 'b', 'bad'), '{nope');
    writeFileSync(path.join(ol, 'manifests', 'hf.co', 'a', 'b', 'noLayers'), '{"x":1}');
    writeFileSync(path.join(ol, 'manifests', 'hf.co', 'a', 'b', 'other'),
      JSON.stringify({ layers: [{ mediaType: MT.model, digest: `sha256:${'f'.repeat(64)}` }, 7, { mediaType: MT.model }] }));
    expect(await buildUsageIndex(lc.config, lc.model, lc.fs)).toEqual({});
  });

  it('returns {} for disabled or missing views without throwing', async () => {
    const lc = await synced(tiny(['lmstudio']));
    const off = { ...lc.config, views: { lmstudio: { root: null, aliases: {} }, ollama: { root: null, aliases: {} } } };
    expect(await buildUsageIndex(off, lc.model, lc.fs)).toEqual({});
    const gone = { ...lc.config, views: { lmstudio: { root: path.join(lc.c.dir, 'nope'), aliases: {} },
      ollama: { root: path.join(lc.c.dir, 'nope2'), aliases: {} } } };
    expect(await buildUsageIndex(gone, lc.model, lc.fs)).toEqual({});
    const noHub = { ...lc.model, repos: [] };
    expect(await buildUsageIndex(lc.config, noHub, lc.fs)).toEqual({});
  });

  it('keeps going when the Ollama manifests folder is a file', async () => {
    const lc = await loadCase(tiny(['lmstudio', 'ollama']));
    const lm = lc.config.views.lmstudio.root!;
    const ol = lc.config.views.ollama.root!;
    mkdirSync(path.join(lm, R), { recursive: true });
    symlinkSync(blob(lc), path.join(lm, R, 'Tiny-Q4_K_M.gguf'));
    expect(existsSync(path.join(ol, 'manifests'))).toBe(false); // offline-404 sync left no manifest dir
    writeFileSync(path.join(ol, 'manifests'), 'x');
    expect(await buildUsageIndex(lc.config, lc.model, lc.fs)).toEqual({ [q4]: { lmstudio: [`${R}/Tiny-Q4_K_M.gguf`], ollama: [] } });
  });

  it('skips a manifest above 16 MiB but still counts the others', async () => {
    const lc = await loadCase(tiny(['ollama']));
    const ol = lc.config.views.ollama.root!;
    const dir = path.join(ol, 'manifests', 'hf.co', 'a', 'b');
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({ layers: [{ mediaType: MT.model, digest: `sha256:${q4}` }] });
    writeFileSync(path.join(dir, 'big'), body);
    truncateSync(path.join(dir, 'big'), 16 * 1024 * 1024 + 1);
    writeFileSync(path.join(dir, 'ok'), body);
    const reads: string[] = [];
    const spy = { ...lc.fs, readFile: ((p: string, enc?: 'utf8') => { reads.push(path.basename(p)); return enc === undefined ? lc.fs.readFile(p) : lc.fs.readFile(p, enc); }) as typeof lc.fs.readFile };
    expect(await buildUsageIndex(lc.config, lc.model, spy)).toEqual({ [q4]: { lmstudio: [], ollama: ['hf.co/a/b:ok'] } });
    expect(reads).toEqual(['ok']);
  });

  it('keys LM Studio and Ollama usage of an upper-case etag the same (lower-case)', async () => {
    const lc = await loadCase(tiny(['lmstudio', 'ollama']));
    const repo = lc.model.repos[0]!;
    const b = repo.blobs[q4]!;
    const upper = q4.toUpperCase();
    const model = { ...lc.model, repos: [{ ...repo, blobs: { [upper]: { ...b, etag: upper } } }] };
    const lm = lc.config.views.lmstudio.root!;
    const ol = lc.config.views.ollama.root!;
    symlinkSync(b.path, path.join(lm, 'u.gguf'));
    mkdirSync(path.join(ol, 'manifests', 'hf.co', 'a', 'b'), { recursive: true });
    writeFileSync(path.join(ol, 'manifests', 'hf.co', 'a', 'b', 't'), JSON.stringify({ layers: [{ mediaType: MT.model, digest: `sha256:${upper}` }] }));
    expect(await buildUsageIndex(lc.config, model, lc.fs)).toEqual({ [q4]: { lmstudio: ['u.gguf'], ollama: ['hf.co/a/b:t'] } });
  });
});
