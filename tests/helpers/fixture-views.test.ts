import { lstat, readFile, readlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { useCanaries } from './canary';
import { buildFixture, diffTrees, ggufFiles, ollamaBlobRel } from './fixture';

useCanaries();

it('builds LM Studio links with absolute repo-blob targets', async () => {
  const fx = await buildFixture({
    repos: [{ id: 'o/m', snapshots: [{ files: ggufFiles('M', ['Q4_K_M']) }] }],
    views: { lmstudio: {
      links: { 'o/m/M-Q4_K_M.gguf': { repo: 'o/m', file: 'M-Q4_K_M.gguf' }, 'o/m/wrong.gguf': { raw: '/nowhere' } },
      files: { 'mine/user.gguf': 'user bytes' },
      state: (r) => ({ version: 1, owned: { 'o/m:M-Q4_K_M.gguf': { paths: ['o/m/M-Q4_K_M.gguf'], sha256: r.etagOf('o/m', 'M-Q4_K_M.gguf') } }, tombstones: {} }),
    } },
  });
  const link = fx.viewPath('lmstudio', 'o/m/M-Q4_K_M.gguf');
  expect(await readlink(link)).toBe(join(fx.hubRoot, 'models--o--m', 'blobs', fx.repo('o/m').etagOf('M-Q4_K_M.gguf')));
  expect(await readlink(fx.viewPath('lmstudio', 'o/m/wrong.gguf'))).toBe('/nowhere');
  expect(await readFile(fx.viewPath('lmstudio', 'mine/user.gguf'), 'utf8')).toBe('user bytes');
  const state = await readFile(fx.viewPath('lmstudio', '.hfhub-state.json'), 'utf8');
  expect(state.startsWith('{\n "version": 1,')).toBe(true);
  expect(state.endsWith('}')).toBe(true);
  expect(fx.canaries).toContain(fx.viewPath('lmstudio', '.hfcm-canary'));
  expect(fx.roots.viewRoots).toEqual([fx.viewRoots.lmstudio]);
});

it('builds Ollama blob links and manifests', async () => {
  const fx = await buildFixture({
    repos: [{ id: 'o/m', snapshots: [{ files: ggufFiles('M', ['Q4_K_M']) }] }],
    views: { ollama: {
      links: { [ollamaBlobRel('E')]: { raw: 'x' } },
      files: { 'manifests/hf.co/o/m/Q4_K_M': (r) => JSON.stringify({ layers: [{ digest: 'sha256:' + r.etagOf('o/m', 'M-Q4_K_M.gguf') }] }) },
    } },
  });
  expect(ollamaBlobRel('E')).toBe('blobs/sha256-E');
  const m = JSON.parse(await readFile(fx.viewPath('ollama', 'manifests/hf.co/o/m/Q4_K_M'), 'utf8'));
  expect(m.layers[0].digest).toBe('sha256:' + fx.repo('o/m').etagOf('M-Q4_K_M.gguf'));
});

it('a view with exists:false is configured but not created', async () => {
  const fx = await buildFixture({ views: { ollama: { exists: false } }, config: { ollama: true } });
  await expect(lstat(fx.viewRoots.ollama!)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fx.roots.viewRoots).toEqual([]);
  expect(await readFile(fx.configPath!, 'utf8')).toBe(`[views.ollama]\nroot = "${fx.viewRoots.ollama}"\n`);
});

it('writes config.toml in the CLI layout and sets env', async () => {
  const fx = await buildFixture({ views: { lmstudio: {}, ollama: {} },
    config: { lmstudio: true, ollama: '~/ollama', aliases: { 'z:1': 'o/m:b.gguf', 'a"q': 'o/m:a.gguf' } }, token: 'hf_x' });
  expect(fx.configPath).toBe(join(fx.home, '.config', 'hfhub', 'config.toml'));
  expect(await readFile(fx.configPath!, 'utf8')).toBe(
    `[views.lmstudio]\nroot = "${fx.viewRoots.lmstudio}"\n\n[views.ollama]\nroot = "~/ollama"\n\n` +
    `[views.ollama.aliases]\n"a\\"q" = "o/m:a.gguf"\n"z:1" = "o/m:b.gguf"\n`);
  expect(fx.env).toEqual({ HOME: fx.home, USERPROFILE: fx.home, HF_HUB_CACHE: fx.hubRoot, HF_HOME: fx.hfHome, HFHUB_CONFIG: fx.configPath });
  expect(await readFile(join(fx.hfHome, 'token'), 'utf8')).toBe('hf_x');
});

it('holdRoot is created on request and placed in roots', async () => {
  const fx = await buildFixture({ holdRoot: true });
  expect(fx.holdRoot).toBe(join(fx.root, 'hf', '.hf-cache-manager', 'recently-deleted'));
  expect((await lstat(fx.holdRoot)).isDirectory()).toBe(true);
  expect(fx.roots).toEqual({ hubRoot: fx.hubRoot, viewRoots: [], holdRoot: fx.holdRoot });
});

it('snapshotTree/diffTrees/diskUsage see removals and count hardlinks once', async () => {
  const fx = await buildFixture({ blobs: { w: { bytes: 100, storage: 'hardlink' } }, repos: [
    { id: 'o/a', snapshots: [{ files: [{ path: 'w', blob: 'w' }] }] },
    { id: 'o/b', snapshots: [{ files: [{ path: 'w', blob: 'w' }, { path: 'p', plain: 10 }] }] }] });
  const before = await fx.snapshotTree();
  const usage = await fx.diskUsage();
  await unlink(fx.repo('o/b').file('p'));
  const after = await fx.snapshotTree();
  expect(diffTrees(before, after)).toEqual({ removed: [fx.repo('o/b').file('p')], added: [], changed: [] });
  expect(usage - (await fx.diskUsage())).toBe(10);
  expect(before.get(fx.repo('o/a').blobOf('w'))).toMatchObject({ type: 'file', size: 100, nlink: 2 });
});
