import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, it } from 'vitest';
import { useCanaries } from './canary';
import { BASE_MTIME_MS, buildFixture, contentFor, diffTrees } from './fixture';

useCanaries();

it('lays out a repo with two snapshots in the hub layout', async () => {
  const fx = await buildFixture({ repos: [{ id: 'org/m', snapshots: [
    { files: [{ path: 'm-Q4.gguf', blob: 'q4' }, { path: 'sub/m-Q8.gguf', blob: 'q8' }] },
    { files: [{ path: 'm-Q4.gguf', blob: 'q4-old' }] },
  ] }] });
  const r = fx.repo('org/m');
  expect(r.folderName).toBe('models--org--m');
  expect(r.folder).toBe(join(fx.hubRoot, 'models--org--m'));
  expect(r.commits).toHaveLength(2);
  expect(r.commits[0]).toMatch(/^[0-9a-f]{40}$/);
  expect(r.mainCommit).toBe(r.commits[0]);
  expect(await readFile(join(r.folder, 'refs', 'main'), 'utf8')).toBe(r.commits[0]);
  expect(await readlink(r.file('m-Q4.gguf'))).toBe(join('..', '..', 'blobs', fx.etag('q4')));
  expect(await readlink(r.file('sub/m-Q8.gguf'))).toBe(join('..', '..', '..', 'blobs', fx.etag('q8')));
  expect(fx.etag('q4')).toBe(createHash('sha256').update(contentFor('q4', 64)).digest('hex'));
  expect(await readFile(r.blobPath(fx.etag('q4')))).toEqual(contentFor('q4', 64));
  expect(r.etagOf('m-Q4.gguf', r.commits[1])).toBe(fx.etag('q4-old'));
  const m0 = (await lstat(r.snapshotDir(r.commits[0]))).mtimeMs;
  const m1 = (await lstat(r.snapshotDir(r.commits[1]))).mtimeMs;
  expect(Math.floor(m0)).toBe(BASE_MTIME_MS);
  expect(Math.floor(m1)).toBe(BASE_MTIME_MS - 3_600_000);
});

it('same key in two snapshots is the same blob; omitted blob key is per repo+path', async () => {
  const fx = await buildFixture({ repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'x.gguf' }] }, { files: [{ path: 'x.gguf' }] }] }] });
  const r = fx.repo('o/a');
  expect(r.etagOf('x.gguf', r.commits[0])).toBe(r.etagOf('x.gguf', r.commits[1]));
  expect(r.etagOf('x.gguf')).toBe(fx.etag('o/a:x.gguf'));
});

it('hardlink storage shares one inode across repos; extraLinks raise nlink', async () => {
  const fx = await buildFixture({
    blobs: { w: { bytes: 100, storage: 'hardlink', extraLinks: 1 } },
    repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'w.gguf', blob: 'w' }] }] },
            { id: 'o/b', snapshots: [{ files: [{ path: 'w.gguf', blob: 'w' }] }] }],
  });
  const a = await lstat(fx.repo('o/a').blobOf('w.gguf'));
  const b = await lstat(fx.repo('o/b').blobOf('w.gguf'));
  expect([a.ino, a.nlink, b.ino]).toEqual([b.ino, 3, a.ino]);
  expect(fx.extraLinks('w')).toEqual([fx.outside('hardlinks/w-1')]);
  expect(fx.canaries).toContain(fx.outside('hardlinks/w-1'));
});

it('plain storage gives each repo an independent copy', async () => {
  const fx = await buildFixture({ repos: [
    { id: 'o/a', snapshots: [{ files: [{ path: 'w.gguf', blob: 'w' }] }] },
    { id: 'o/b', snapshots: [{ files: [{ path: 'w.gguf', blob: 'w' }] }] }] });
  const [a, b] = [await lstat(fx.repo('o/a').blobOf('w.gguf')), await lstat(fx.repo('o/b').blobOf('w.gguf'))];
  expect(a.ino).not.toBe(b.ino); expect([a.nlink, b.nlink]).toEqual([1, 1]);
});

it('git-sha1 etags, plain files, empty dirs, raw links, orphans, .incomplete, extras', async () => {
  const fx = await buildFixture({ repos: [{
    id: 'o/a', type: 'dataset', main: null,
    snapshots: [{ files: [
      { path: 'README.md', blob: { key: 'readme', content: '# a\n', etag: 'git-sha1' } },
      { path: 'notes.txt', plain: 'plain bytes' },
      { path: 'big.bin', plain: 10 },
      { path: 'empty', dir: true },
      { path: 'odd', rawLink: '/elsewhere/x' },
    ] }],
    orphans: ['orphan'],
    incomplete: [{ bytes: 7, mtimeMs: 1_700_000_000_000 }],
    blobsExtra: { 'deadbeef.lock': '' },
  }] });
  const r = fx.repo('o/a');
  expect(r.folderName).toBe('datasets--o--a');
  expect(r.mainCommit).toBeNull();
  await expect(lstat(join(r.folder, 'refs', 'main'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fx.etag('readme')).toMatch(/^[0-9a-f]{40}$/);
  expect(fx.etag('readme')).toBe(createHash('sha1').update(Buffer.concat([Buffer.from('blob 4\0'), Buffer.from('# a\n')])).digest('hex'));
  expect((await lstat(r.file('notes.txt'))).isFile()).toBe(true);
  expect((await lstat(r.file('big.bin'))).size).toBe(10);
  expect(await readdir(r.file('empty'))).toEqual([]);
  expect(await readlink(r.file('odd'))).toBe('/elsewhere/x');
  expect((await lstat(r.blobPath(fx.etag('orphan')))).isFile()).toBe(true);
  expect(r.incomplete).toHaveLength(1);
  expect(basename(r.incomplete[0]!)).toMatch(/^[0-9a-f]{64}\.incomplete$/);
  const st = await lstat(r.incomplete[0]!);
  expect([st.size, Math.floor(st.mtimeMs)]).toEqual([7, 1_700_000_000_000]);
  expect(await readFile(join(r.folder, 'blobs', 'deadbeef.lock'), 'utf8')).toBe('');
});

it('main can point at a later snapshot or carry raw bytes', async () => {
  const fx = await buildFixture({ repos: [
    { id: 'o/a', main: 1, snapshots: [{ files: [] }, { files: [] }] },
    { id: 'o/b', main: { raw: '  abc\n' }, snapshots: [{ files: [] }] }] });
  expect(fx.repo('o/a').mainCommit).toBe(fx.repo('o/a').commits[1]);
  expect(await readFile(join(fx.repo('o/b').folder, 'refs', 'main'), 'utf8')).toBe('  abc\n');
});

it('plants hub canaries, hubMissing skips the hub, dispose removes the root', async () => {
  const fx = await buildFixture({ repos: [] });
  expect(fx.canaries).toEqual(expect.arrayContaining([join(fx.root, 'hf', '.hfcm-canary'), join(fx.hubRoot, '.hfcm-canary'), fx.outside('canary.bin')]));
  const gone = await buildFixture({ hubMissing: true });
  await expect(lstat(gone.hubRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await gone.dispose(); await gone.dispose();                      // idempotent
  await expect(lstat(gone.root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects conflicting inline blob definitions', async () => {
  await expect(buildFixture({ repos: [{ id: 'o/a', snapshots: [{ files: [
    { path: 'a', blob: { key: 'k', bytes: 1 } }, { path: 'b', blob: { key: 'k', bytes: 2 } }] }] }] }))
    .rejects.toThrow('conflicting BlobSpec for key k');
});

it('snapshotTree and diffTrees see added, removed and changed entries', async () => {
  const fx = await buildFixture({ repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'x.gguf', blob: 'x' }] }] }] });
  const before = await fx.snapshotTree();
  expect(before.get(fx.repo('o/a').file('x.gguf'))?.type).toBe('symlink');
  expect(await fx.diskUsage()).toBeGreaterThan(0);
  const blob = fx.repo('o/a').blobOf('x.gguf');
  await fx.fs.writeFile(blob, 'changed!');
  await fx.fs.writeFile(fx.outside('new.txt'), 'n');
  const d = diffTrees(before, await fx.snapshotTree());
  expect(d.changed).toEqual([blob]);
  expect(d.added).toEqual([fx.outside('new.txt')]);
  expect(d.removed).toEqual([]);
});

it('dispose after tampering with a fixture canary reports it and keeps the fixture', async () => {
  const fx = await buildFixture({ repos: [] });
  const c = fx.outside('canary.bin');
  const orig = await readFile(c);
  await writeFile(c, 'tampered');
  await expect(fx.dispose()).rejects.toThrow(/canary violations before release/);
  await writeFile(c, orig);
  await fx.dispose();
  await expect(lstat(fx.root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('releaseUnder refuses a path outside the root', async () => {
  const fx = await buildFixture({ repos: [] });
  const ctx = useCanaries();
  await expect(ctx.releaseUnder(fx.root, [join(ctx.sandbox, 'outside.bin')])).rejects.toThrow(/not strictly under/);
});

it('rejects an out-of-range main index and hubMissing with repos', async () => {
  await expect(buildFixture({ repos: [{ id: 'o/a', main: 1, snapshots: [{ files: [] }] }] })).rejects.toThrow('out of range');
  await expect(buildFixture({ hubMissing: true, repos: [{ id: 'o/a', snapshots: [] }] })).rejects.toThrow('hubMissing');
});

it('an E2E fixture lives in its own hfcm-e2e-* run dir directly under the temp base and is removed on dispose', async () => {
  const { tmpBase } = await import('./tmp');
  const { buildAppFixture } = await import('./app-fixture');
  const fx = await buildAppFixture({ rootPrefix: 'hfcm-e2e-' });
  expect(basename(fx.root)).toMatch(/^hfcm-e2e-/);
  expect(join(fx.root, '..')).toBe(tmpBase());
  expect(fx.hubRoot.startsWith(fx.root + '/')).toBe(true);
  expect(fx.userDataDir.startsWith(fx.root + '/')).toBe(true);
  await fx.dispose();
  await expect(lstat(fx.root)).rejects.toMatchObject({ code: 'ENOENT' });
});
