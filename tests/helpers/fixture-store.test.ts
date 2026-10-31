import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { useCanaries } from './canary';
import type { Fixture } from './fixture';
import { buildFixture, contentFor } from './fixture';

useCanaries();

it('store link: relative one-hop link, payload under <xx>/<xethash>, marker, auto refs', async () => {
  const fx = await buildFixture({ blobs: { s: { bytes: 50, storage: 'store' } }, repos: [
    { id: 'o/a', snapshots: [{ files: [{ path: 'x.gguf', blob: 's' }] }] },
    { id: 'o/b', snapshots: [{ files: [{ path: 'y.gguf', blob: 's' }] }] }] });
  const h = fx.xetHash('s');
  expect(h).not.toBe(fx.etag('s'));
  expect(fx.storePath('s')).toBe(join(fx.hubRoot, 'blobs', h.slice(0, 2), h));
  expect(await readlink(fx.repo('o/a').blobOf('x.gguf'))).toBe(join('..', '..', 'blobs', h.slice(0, 2), h));
  expect(await readFile(fx.storePath('s'))).toEqual(contentFor('s', 50));
  expect(await readFile(join(fx.hubRoot, 'blobs', '.huggingface-shared-blobs'), 'utf8')).toBe('1\n');
  expect(await readFile(fx.refsPath('s'), 'utf8')).toBe(
    `models--o--a/blobs/${fx.etag('s')}\nmodels--o--b/blobs/${fx.etag('s')}\n`);
});

it.each([
  [{ refs: 'missing' as const }, async (fx: Fixture) => expect(lstat(fx.refsPath('s'))).rejects.toMatchObject({ code: 'ENOENT' })],
  [{ refs: 'not-a-file' as const }, async (fx: Fixture) => expect((await lstat(fx.refsPath('s'))).isDirectory()).toBe(true)],
  [{ refs: [] as string[] }, async (fx: Fixture) => expect(await readFile(fx.refsPath('s'), 'utf8')).toBe('')],
  [{ refsExtra: ['models--gone--x/blobs/' + 'a'.repeat(64)] }, async (fx: Fixture) =>
    expect((await readFile(fx.refsPath('s'), 'utf8')).split('\n')).toHaveLength(3)],
  [{ lock: 'lock' as const }, async (fx: Fixture) => expect((await lstat(fx.storePath('s') + '.lock')).size).toBe(0)],
  [{ lock: 'soft' as const }, async (fx: Fixture) => expect((await lstat(fx.storePath('s') + '.lock.soft')).size).toBe(0)],
  [{ danglingStore: true }, async (fx: Fixture) => expect(lstat(fx.storePath('s'))).rejects.toMatchObject({ code: 'ENOENT' })],
])('store variant %o', async (extra, check) => {
  const fx = await buildFixture({ blobs: { s: { storage: 'store', ...extra } },
    repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'x.gguf', blob: 's' }] }] }] });
  await check(fx);
});

it('marker can be wrong or absent', async () => {
  const bad = await buildFixture({ store: { marker: '1' }, repos: [] });
  expect(await readFile(join(bad.hubRoot, 'blobs', '.huggingface-shared-blobs'), 'utf8')).toBe('1');
  const none = await buildFixture({ store: { marker: null }, blobs: { s: { storage: 'store' } },
    repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'x', blob: 's' }] }] }] });
  await expect(lstat(join(none.hubRoot, 'blobs', '.huggingface-shared-blobs'))).rejects.toMatchObject({ code: 'ENOENT' });
});
