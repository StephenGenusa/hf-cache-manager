import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DownloadFs, DownloadFsError } from '../../../src/core/download/download-fs';
import { factsOf, type FsLike, type ReadFs } from '../../../src/core/fsx';
import { SafeFs } from '../../../src/core/safe-fs';
import { scanHub } from '../../../src/core/scan/scanner';
import { useCanaries } from '../../helpers/canary';
import { failingFs, recordingFs } from '../../helpers/failing-fs';
import { buildFixture, type Fixture } from '../../helpers/fixture';
import { treeDigest } from '../../helpers/tree-digest';

useCanaries();
const expectCode = (code: string) => expect.objectContaining({ name: 'SafeFsError', code });
const C = 'c'.repeat(40);
const C2 = 'd'.repeat(40);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const gitSha1 = (s: string): string => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0${s}`).digest('hex');
const W = 'weights of the model';
const J = '{"model_type":"llama"}';
const EW = sha256(W);
const EJ = gitSha1(J);

const existing = { repos: [{ id: 'o/a', snapshots: [{ files: [{ path: 'x.gguf', blob: 'x' }] }] }] };

async function fresh(spec: Parameters<typeof buildFixture>[0] = {}, fs?: FsLike): Promise<{ fx: Fixture; dfs: DownloadFs; folder: string }> {
  const fx = await buildFixture(spec);
  const use = fs ?? fx.fs;
  const dfs = new DownloadFs(new SafeFs(fx.roots, use), fx.hubRoot, { repoId: 'org/name', type: 'model' }, use);
  return { fx, dfs, folder: join(fx.hubRoot, 'models--org--name') };
}

/** Streams `text` into blobs/<etag>.incomplete and commits it, as the engine will. */
async function download(dfs: DownloadFs, etag: string, text: string): Promise<'committed' | 'already-present'> {
  const w = await dfs.openIncomplete(etag, null);
  await w.write(enc(text));
  return dfs.commitBlob(etag, await w.close());
}

describe('construction', () => {
  it('names the repo folder like the scanner and huggingface_hub', async () => {
    const fx = await buildFixture({});
    const safe = new SafeFs(fx.roots, fx.fs);
    expect(new DownloadFs(safe, fx.hubRoot, { repoId: 'org/name', type: 'model' }).folder).toBe(join(fx.hubRoot, 'models--org--name'));
    expect(new DownloadFs(safe, `${fx.hubRoot}/`, { repoId: 'o/d', type: 'dataset' }).folder).toBe(join(fx.hubRoot, 'datasets--o--d'));
    expect(new DownloadFs(safe, fx.hubRoot, { repoId: 'gpt2', type: 'space' }).folder).toBe(join(fx.hubRoot, 'spaces--gpt2'));
  });
  it.each([['a/../b'], ['a/b/c'], ['a--b/c'], [''], ['../x'], ['/abs']])('refuses repo id %j (CONTAINMENT)', async (id) => {
    const fx = await buildFixture({});
    expect(() => new DownloadFs(new SafeFs(fx.roots, fx.fs), fx.hubRoot, { repoId: id, type: 'model' })).toThrow(expectCode('CONTAINMENT'));
  });
  it('refuses a repo type the scanner would not read back, and a hub root other than the SafeFs hub root', async () => {
    const fx = await buildFixture({});
    const safe = new SafeFs(fx.roots, fx.fs);
    expect(() => new DownloadFs(safe, fx.hubRoot, { repoId: 'o/a', type: 'checkpoint' as 'model' })).toThrow(expectCode('CONTAINMENT'));
    expect(() => new DownloadFs(safe, fx.root, { repoId: 'o/a', type: 'model' })).toThrow(expectCode('CONTAINMENT'));
    expect(() => new DownloadFs(safe, 'relative/hub', { repoId: 'o/a', type: 'model' })).toThrow(expectCode('CONTAINMENT'));
  });
});

describe('a full download writes what huggingface_hub writes', () => {
  it('ensureDirs, stream, commit, link, ref: the tree and the scan', async () => {
    const { fx, dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    await dfs.ensureDirs(C, 'a');
    expect(dfs.incompletePath(EW)).toBe(join(folder, 'blobs', `${EW}.incomplete`));
    expect(await download(dfs, EJ, J)).toBe('committed');
    expect(await download(dfs, EW, W)).toBe('committed');
    expect(await dfs.linkSnapshot(C, 'config.json', EJ)).toBe('linked');
    expect(await dfs.linkSnapshot(C, 'a/b.gguf', EW)).toBe('linked');
    expect(await dfs.replaceRef('main', C, null)).toBe('replaced');

    const tree = await treeDigest(folder);
    expect(Object.keys(tree).sort()).toEqual([
      'blobs', `blobs/${EJ}`, `blobs/${EW}`, 'refs', 'refs/main',
      'snapshots', `snapshots/${C}`, `snapshots/${C}/a`, `snapshots/${C}/a/b.gguf`, `snapshots/${C}/config.json`,
    ].sort());
    expect(tree[`snapshots/${C}/config.json`]).toBe(`link:../../blobs/${EJ}`);
    expect(tree[`snapshots/${C}/a/b.gguf`]).toBe(`link:../../../blobs/${EW}`);
    expect(await readFile(join(folder, 'refs', 'main'), 'utf8')).toBe(C); // 40-hex, no newline (as huggingface_hub)
    expect(await readFile(join(folder, 'snapshots', C, 'a', 'b.gguf'), 'utf8')).toBe(W);

    const model = await scanHub(fx.hubRoot, fx.fs);
    const repo = model.repos.find((r) => r.id === 'org/name')!;
    expect(repo).toMatchObject({ type: 'model', folderName: 'models--org--name', mainCommit: C, snapshots: [C], incomplete: [], orphanEtags: [] });
    expect(repo.files.map((f) => [f.relpath, f.blobEtag, f.facts.linkTarget, f.isCurrent]).sort()).toEqual([
      ['a/b.gguf', EW, `../../../blobs/${EW}`, true],
      ['config.json', null, `../../blobs/${EJ}`, true], // a 40-hex (git) blob: the scanner keeps it in otherFiles
    ]);
    expect(Object.keys(repo.blobs)).toEqual([EW]);
  });
  it('a branch with a slash and refs/pr/N get their own ref files; the old ref is replaced atomically', async () => {
    const { dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    await dfs.replaceRef('main', C, null);
    const before = (await lstat(join(folder, 'refs', 'main'))).ino;
    expect(await dfs.replaceRef('main', C2, C)).toBe('replaced');
    expect(await readFile(join(folder, 'refs', 'main'), 'utf8')).toBe(C2);
    expect((await lstat(join(folder, 'refs', 'main'))).ino).not.toBe(before);
    await dfs.replaceRef('feature/x', C, null);
    await dfs.replaceRef('refs/pr/3', C2, null);
    expect(await readFile(join(folder, 'refs', 'feature', 'x'), 'utf8')).toBe(C);
    expect(await readFile(join(folder, 'refs', 'refs', 'pr', '3'), 'utf8')).toBe(C2);
    expect((await readdir(join(folder, 'refs'))).filter((n) => n.includes('hfcm-tmp'))).toEqual([]);
  });
  it('replaceRef moves the ref only from the commit it named at the start: never back to an older commit', async () => {
    const { dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    const ref = join(folder, 'refs', 'main');
    // absent and expected absent: written
    expect(await dfs.replaceRef('main', C, null)).toBe('replaced');
    const ino = (await lstat(ref)).ino;
    // already the commit: nothing written
    expect(await dfs.replaceRef('main', C, null)).toBe('same');
    expect(await dfs.replaceRef('main', C, C2)).toBe('same');
    expect((await lstat(ref)).ino).toBe(ino);
    // another download moved it on (or it named another commit): left as it is
    expect(await dfs.replaceRef('main', C2, null)).toBe('moved');
    expect(await dfs.replaceRef('main', C2, 'e'.repeat(40))).toBe('moved');
    expect(await readFile(ref, 'utf8')).toBe(C);
    expect((await lstat(ref)).ino).toBe(ino);
    // absent, but a commit was expected: someone removed it; not recreated
    expect(await dfs.replaceRef('feature', C, C2)).toBe('moved');
    await expect(lstat(join(folder, 'refs', 'feature'))).rejects.toMatchObject({ code: 'ENOENT' });
    // a ref written with a trailing newline (as some tools do) still names its commit
    await writeFile(join(folder, 'refs', 'nl'), `${C2}\n`);
    expect(await dfs.replaceRef('nl', C, C2)).toBe('replaced');
    expect(await readFile(join(folder, 'refs', 'nl'), 'utf8')).toBe(C);
    // text that is no commit is never "expected"
    await writeFile(join(folder, 'refs', 'junk'), 'not a commit');
    expect(await dfs.replaceRef('junk', C, null)).toBe('moved');
    expect(await readFile(join(folder, 'refs', 'junk'), 'utf8')).toBe('not a commit');
    expect((await readdir(join(folder, 'refs'))).filter((n) => n.includes('hfcm-tmp'))).toEqual([]);
  });
  it('resumes a partial file whose facts match, and refuses one whose facts changed (STALE)', async () => {
    const { fx, dfs } = await fresh();
    await dfs.ensureDirs(C, '');
    const w = await dfs.openIncomplete(EW, null);
    await w.write(enc(W.slice(0, 5)));
    const part = await w.close();
    await expect(dfs.openIncomplete(EW, { ...part, size: part.size - 1 })).rejects.toEqual(expectCode('STALE'));
    const w2 = await dfs.openIncomplete(EW, part);
    expect(w2.startSize).toBe(5);
    await w2.write(enc(W.slice(5)));
    expect(await dfs.commitBlob(EW, await w2.close())).toBe('committed');
    expect(await readFile(join(fx.hubRoot, 'models--org--name', 'blobs', EW), 'utf8')).toBe(W);
  });
});

describe('a blob that is a link into the shared store', () => {
  const store = (fx: Fixture, hash: string): string => join(fx.hubRoot, 'blobs', hash.slice(0, 2), hash);
  it('blobSource follows one hop into the store; dangling, two-hop, outside-store and non-file blobs are refused', async () => {
    const { fx, dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    expect(await dfs.blobSource(EW)).toBeNull();
    const h = sha256('payload');
    await mkdir(join(fx.hubRoot, 'blobs', h.slice(0, 2)), { recursive: true });
    await writeFile(store(fx, h), W);
    await symlink(`../../blobs/${h.slice(0, 2)}/${h}`, join(folder, 'blobs', EW));
    const src = await dfs.blobSource(EW);
    expect(src).toMatchObject({ ok: true, path: store(fx, h), facts: { size: W.length, isFile: true }, entry: { isSymlink: true } });
    // linked as huggingface_hub links it: the snapshot names the repo blob, the repo blob names the store
    expect(await dfs.linkSnapshot(C, 'a.gguf', EW)).toBe('linked');
    expect(await readlink(join(folder, 'snapshots', C, 'a.gguf'))).toBe(`../../blobs/${EW}`);
    expect(await readFile(join(folder, 'snapshots', C, 'a.gguf'), 'utf8')).toBe(W);
    // without symlinks the copy is of the payload's bytes, verified
    expect(await dfs.copySnapshot(C, 'b.gguf', EW)).toBe('copied');
    expect(await readFile(join(folder, 'snapshots', C, 'b.gguf'), 'utf8')).toBe(W);
    const missing = sha256('missing');
    await symlink(`../../blobs/${missing.slice(0, 2)}/${missing}`, join(folder, 'blobs', sha256('d')));
    expect(await dfs.blobSource(sha256('d'))).toEqual({ ok: false, reason: 'dangling' });
    await expect(dfs.linkSnapshot(C, 'd.gguf', sha256('d'))).rejects.toEqual(expectCode('STALE'));
    const two = sha256('two');
    await mkdir(join(fx.hubRoot, 'blobs', two.slice(0, 2)), { recursive: true });
    await symlink(store(fx, h), store(fx, two));
    await symlink(`../../blobs/${two.slice(0, 2)}/${two}`, join(folder, 'blobs', sha256('t')));
    expect(await dfs.blobSource(sha256('t'))).toEqual({ ok: false, reason: 'unusable' });
    await writeFile(join(fx.hubRoot, 'elsewhere'), W);
    await symlink('../../elsewhere', join(folder, 'blobs', sha256('o')));
    expect(await dfs.blobSource(sha256('o'))).toEqual({ ok: false, reason: 'unusable' });
    await mkdir(join(folder, 'blobs', sha256('dir')));
    expect(await dfs.blobSource(sha256('dir'))).toEqual({ ok: false, reason: 'unusable' });
    await expect(dfs.copySnapshot(C, 'e.gguf', sha256('dir'))).rejects.toEqual(expectCode('STALE'));
    expect(await readFile(store(fx, h), 'utf8')).toBe(W);   // the payload is only read
  });
});

describe('never overwrites', () => {
  it('an existing blob is already-present and the partial file is left in place', async () => {
    const { dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    expect(await download(dfs, EW, W)).toBe('committed');
    const blob = await factsOf(dfs['fs'], join(folder, 'blobs', EW));
    const w = await dfs.openIncomplete(EW, null);
    await w.write(enc('other bytes'));
    expect(await dfs.commitBlob(EW, await w.close())).toBe('already-present');
    expect(await readFile(join(folder, 'blobs', `${EW}.incomplete`), 'utf8')).toBe('other bytes');
    expect(await factsOf(dfs['fs'], join(folder, 'blobs', EW))).toEqual(blob);
  });
  it('a blob that appears between the check and the rename is already-present too (SafeFs EXISTS)', async () => {
    const fx = await buildFixture({});
    const folder = join(fx.hubRoot, 'models--org--name');
    const dest = join(folder, 'blobs', EW);
    let first = true;
    const racy: FsLike = { ...fx.fs, lstat: async (p) => {
      if (p === dest && first) {
        first = false;
        await writeFile(dest, 'raced in');
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return fx.fs.lstat(p);
    } };
    const dfs = new DownloadFs(new SafeFs(fx.roots, racy), fx.hubRoot, { repoId: 'org/name', type: 'model' }, racy);
    await dfs.ensureDirs(C, '');
    expect(await download(dfs, EW, W)).toBe('already-present');
    expect(await readFile(dest, 'utf8')).toBe('raced in');
    expect(await readFile(`${dest}.incomplete`, 'utf8')).toBe(W);
  });
  it('commitBlob: a changed partial file is STALE and nothing moves; non-file facts are refused', async () => {
    const { dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    const w = await dfs.openIncomplete(EW, null);
    await w.write(enc(W));
    const facts = await w.close();
    await expect(dfs.commitBlob(EW, { ...facts, size: 1 })).rejects.toEqual(expectCode('STALE'));
    await expect(dfs.commitBlob(EW, { ...facts, isFile: false, isSymlink: true })).rejects.toEqual(expectCode('IO'));
    await expect(dfs.commitBlob(EW, { ...facts, isFile: false, isDirectory: true })).rejects.toEqual(expectCode('IO'));
    await expect(dfs.commitBlob(EW, { ...facts, isSymlink: true })).rejects.toEqual(expectCode('IO'));
    await expect(dfs.commitBlob(EW, { ...facts, isDirectory: true })).rejects.toEqual(expectCode('IO'));
    await expect(lstat(join(folder, 'blobs', EW))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(folder, 'blobs', `${EW}.incomplete`), 'utf8')).toBe(W);
  });
  it('a rename failure other than EXISTS is reported, not swallowed', async () => {
    const fx = await buildFixture({});
    const fs = failingFs(fx.fs, 'rename', 'EIO');
    const dfs = new DownloadFs(new SafeFs(fx.roots, fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fs);
    await dfs.ensureDirs(C, '');
    await expect(download(dfs, EW, W)).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EIO' }));
  });
  it('linkSnapshot: the same link is same; a different entry (other link, file, dir) is EXISTS and unchanged', async () => {
    const { dfs, folder } = await fresh();
    await dfs.ensureDirs(C, 'a');
    await download(dfs, EW, W);
    await download(dfs, EJ, J);
    expect(await dfs.linkSnapshot(C, 'a/b.gguf', EW)).toBe('linked');
    expect(await dfs.linkSnapshot(C, 'a/b.gguf', EW)).toBe('same');
    await expect(dfs.linkSnapshot(C, 'a/b.gguf', EJ)).rejects.toEqual(expectCode('EXISTS'));
    expect(await readlink(join(folder, 'snapshots', C, 'a', 'b.gguf'))).toBe(`../../../blobs/${EW}`);
    await writeFile(join(folder, 'snapshots', C, 'f.bin'), W);
    await expect(dfs.linkSnapshot(C, 'f.bin', EW)).rejects.toEqual(expectCode('EXISTS'));
    expect((await lstat(join(folder, 'snapshots', C, 'f.bin'))).isFile()).toBe(true);
    await mkdir(join(folder, 'snapshots', C, 'd'));
    await expect(dfs.linkSnapshot(C, 'd', EW)).rejects.toEqual(expectCode('EXISTS'));
    // An absolute link to the right blob is still a different entry: huggingface_hub writes relative links.
    await symlink(join(folder, 'blobs', EW), join(folder, 'snapshots', C, 'abs.gguf'));
    await expect(dfs.linkSnapshot(C, 'abs.gguf', EW)).rejects.toEqual(expectCode('EXISTS'));
  });
  it('linkSnapshot and copySnapshot refuse a missing or non-file blob (STALE): no dangling links', async () => {
    const { dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    await expect(dfs.linkSnapshot(C, 'x.gguf', EW)).rejects.toEqual(expectCode('STALE'));
    await expect(dfs.copySnapshot(C, 'x.gguf', EW)).rejects.toEqual(expectCode('STALE'));
    await mkdir(join(folder, 'blobs', EJ));
    await expect(dfs.linkSnapshot(C, 'x.gguf', EJ)).rejects.toEqual(expectCode('STALE'));
    await symlink(join(folder, 'blobs', EJ), join(folder, 'blobs', EW));
    await expect(dfs.copySnapshot(C, 'x.gguf', EW)).rejects.toEqual(expectCode('STALE'));
    await expect(lstat(join(folder, 'snapshots', C, 'x.gguf'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('copySnapshot (no symlinks): copies; the same content is same; anything else is EXISTS', async () => {
    const { dfs, folder } = await fresh();
    await dfs.ensureDirs(C, 'a');
    await download(dfs, EW, W);
    await download(dfs, EJ, J);
    expect(await dfs.copySnapshot(C, 'a/b.gguf', EW)).toBe('copied');
    expect(await dfs.copySnapshot(C, 'config.json', EJ)).toBe('copied');
    const entry = join(folder, 'snapshots', C, 'a', 'b.gguf');
    expect((await lstat(entry)).isFile()).toBe(true);
    expect(await readFile(entry, 'utf8')).toBe(W);
    expect(await dfs.copySnapshot(C, 'a/b.gguf', EW)).toBe('same');
    expect(await dfs.copySnapshot(C, 'config.json', EJ)).toBe('same');
    const same = join(folder, 'snapshots', C, 'same-size.gguf');
    await writeFile(same, 'X'.repeat(W.length)); // same size, other content
    await expect(dfs.copySnapshot(C, 'same-size.gguf', EW)).rejects.toEqual(expectCode('EXISTS'));
    expect(await readFile(same, 'utf8')).toBe('X'.repeat(W.length));
    await writeFile(join(folder, 'snapshots', C, 'short.gguf'), 'short');
    await expect(dfs.copySnapshot(C, 'short.gguf', EW)).rejects.toEqual(expectCode('EXISTS'));
    await symlink(`../../blobs/${EW}`, join(folder, 'snapshots', C, 'link.gguf'));
    await expect(dfs.copySnapshot(C, 'link.gguf', EW)).rejects.toEqual(expectCode('EXISTS'));
  });
  it('copySnapshot creates the entry exclusively; a part-way failure leaves it, named in leftPath; resumeSnapshotCopy appends the rest', async () => {
    const { fx, folder } = await fresh();
    const snapDir = join(folder, 'snapshots', C);
    const entry = join(snapDir, 'w s.gguf');   // a space in the name: the path is carried, never parsed
    const mk = (fs: FsLike) => new DownloadFs(new SafeFs(fx.roots, fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fs);
    const ok = mk(fx.fs);
    await ok.ensureDirs(C, '');
    await download(ok, EW, W);
    const writeFails = (after: number, code = 'ENOSPC') => mk({ ...fx.fs, open: async (p, flags) => {
      const h = await fx.fs.open(p, flags);
      let n = 0;
      return flags !== 'r' && p.startsWith(snapDir) ? { ...h, write: async (c: Uint8Array) => {
        if (n + c.length > after) {
          await h.write(c.subarray(0, after - n));
          throw Object.assign(new Error(`${code}: injected`), { code });
        }
        n += c.length;
        await h.write(c);
      } } : h;
    } });
    // ENOSPC part-way: errno kept, the entry left and named, nothing else in the folder.
    const e1 = await writeFails(3).copySnapshot(C, 'w s.gguf', EW).catch((e: unknown) => e as DownloadFsError);
    expect(e1).toBeInstanceOf(DownloadFsError);
    expect(e1).toMatchObject({ name: 'SafeFsError', code: 'IO', errno: 'ENOSPC', leftPath: entry });
    expect((e1 as DownloadFsError).message).toContain(`left at ${entry}`);
    expect((e1 as DownloadFsError).message.match(/partial copy is left at/g)).toHaveLength(1);   // said once
    expect(await readFile(entry, 'utf8')).toBe(W.slice(0, 3));
    expect(await readdir(snapDir)).toEqual(['w s.gguf']);
    // copySnapshot again refuses the short entry (EXISTS) and leaves it; resumeSnapshotCopy appends instead.
    await expect(ok.copySnapshot(C, 'w s.gguf', EW)).rejects.toEqual(expectCode('EXISTS'));
    const short = (await factsOf(fx.fs, entry))!;
    const e2 = await writeFails(2).resumeSnapshotCopy(C, 'w s.gguf', EW, short).catch((e: unknown) => e as DownloadFsError);
    expect(e2).toMatchObject({ code: 'IO', errno: 'ENOSPC', leftPath: entry });
    expect(await readFile(entry, 'utf8')).toBe(W.slice(0, 5));
    const five = (await factsOf(fx.fs, entry))!;
    expect(await ok.resumeSnapshotCopy(C, 'w s.gguf', EW, five)).toBe('copied');
    const done = (await factsOf(fx.fs, entry))!;
    expect(await readFile(entry, 'utf8')).toBe(W);
    expect([done.ino, done.dev]).toEqual([short.ino, short.dev]);   // appended, never recopied or replaced
    expect(await ok.copySnapshot(C, 'w s.gguf', EW)).toBe('same');
  });
  it('resumeSnapshotCopy refuses anything that is not the start of the blob, and leaves it untouched', async () => {
    const { fx, dfs, folder } = await fresh();
    const snapDir = join(folder, 'snapshots', C);
    await dfs.ensureDirs(C, '');
    await download(dfs, EW, W);
    const facts = async (n: string) => (await factsOf(fx.fs, join(snapDir, n)))!;
    await writeFile(join(snapDir, 'other'), 'XYZ');   // shorter, other bytes
    await expect(dfs.resumeSnapshotCopy(C, 'other', EW, await facts('other'))).rejects.toMatchObject({ code: 'EXISTS', message: expect.stringContaining('a different file is already there') });
    expect(await readFile(join(snapDir, 'other'), 'utf8')).toBe('XYZ');
    await writeFile(join(snapDir, 'long'), `${W}!`);
    await expect(dfs.resumeSnapshotCopy(C, 'long', EW, await facts('long'))).rejects.toEqual(expectCode('EXISTS'));
    await writeFile(join(snapDir, 'full'), W);
    await expect(dfs.resumeSnapshotCopy(C, 'full', EW, await facts('full'))).rejects.toEqual(expectCode('EXISTS'));
    await symlink(`../../blobs/${EW}`, join(snapDir, 'lnk'));
    await expect(dfs.resumeSnapshotCopy(C, 'lnk', EW, await facts('lnk'))).rejects.toEqual(expectCode('EXISTS'));
    await writeFile(join(snapDir, 'stale'), W.slice(0, 4));
    const before = await facts('stale');
    await writeFile(join(snapDir, 'stale'), W.slice(0, 6));
    await expect(dfs.resumeSnapshotCopy(C, 'stale', EW, before)).rejects.toEqual(expectCode('STALE'));
    expect(await readFile(join(snapDir, 'stale'), 'utf8')).toBe(W.slice(0, 6));
    await expect(dfs.resumeSnapshotCopy(C, '../x', EW, before)).rejects.toEqual(expectCode('CONTAINMENT'));
  });
  it('an entry that appears between the check and the exclusive create is EXISTS and untouched; nothing is named', async () => {
    const { fx, folder } = await fresh();
    const entry = join(folder, 'snapshots', C, 'r.gguf');
    const racing = new DownloadFs(new SafeFs(fx.roots, { ...fx.fs, open: async (p, flags) => {
      if (flags === 'wx' && p === entry) await writeFile(entry, 'someone else');
      return fx.fs.open(p, flags);
    } }), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fx.fs);
    await racing.ensureDirs(C, '');
    await download(racing, EW, W);
    const err = await racing.copySnapshot(C, 'r.gguf', EW).catch((e: unknown) => e as DownloadFsError);
    expect(err).toMatchObject({ code: 'EXISTS', leftPath: null });
    expect(await readFile(entry, 'utf8')).toBe('someone else');
  });
  it('a copy that fails before its own exclusive create names nothing, even when a third party created the entry', async () => {
    const { fx, folder } = await fresh();
    const entry = join(folder, 'snapshots', C, 'x.gguf');
    const ok = new DownloadFs(new SafeFs(fx.roots, fx.fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fx.fs);
    await ok.ensureDirs(C, '');
    await download(ok, EW, W);
    const blobFails = new DownloadFs(new SafeFs(fx.roots, { ...fx.fs, open: async (p, flags) => {
      if (flags === 'r' && p.endsWith(EW)) {
        await writeFile(entry, 'theirs');   // someone else creates the entry while our blob read fails
        throw Object.assign(new Error('EIO: blob read'), { code: 'EIO' });
      }
      return fx.fs.open(p, flags);
    } }), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fx.fs);
    const err = await blobFails.copySnapshot(C, 'x.gguf', EW).catch((e: unknown) => e as DownloadFsError);
    expect(err).toMatchObject({ code: 'IO', errno: 'EIO', leftPath: null });
    expect((err as DownloadFsError).message).not.toMatch(/left at|partial copy/);
    expect(await readFile(entry, 'utf8')).toBe('theirs');
  });
  it('a copy whose bytes come out different is IO with leftPath; resume and close failures are reported', async () => {
    const { fx, folder } = await fresh();
    const snapDir = join(folder, 'snapshots', C);
    const mk = (fs: FsLike) => new DownloadFs(new SafeFs(fx.roots, fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fs);
    const ok = mk(fx.fs);
    await ok.ensureDirs(C, '');
    await download(ok, EW, W);
    const flip = mk({ ...fx.fs, open: async (p, flags) => {
      const h = await fx.fs.open(p, flags);
      return flags !== 'r' && p.startsWith(snapDir) ? { ...h, write: (c: Uint8Array) => h.write(Uint8Array.from(c, (b, i) => (i === 0 ? b ^ 1 : b))) } : h;
    } });
    await expect(flip.copySnapshot(C, 'f.gguf', EW)).rejects.toMatchObject({ code: 'IO', leftPath: join(snapDir, 'f.gguf'),
      message: expect.stringContaining('the snapshot copy does not match the blob') });
    await writeFile(join(snapDir, 'g.gguf'), W.slice(0, 2));
    await expect(flip.resumeSnapshotCopy(C, 'g.gguf', EW, (await factsOf(fx.fs, join(snapDir, 'g.gguf')))!)).rejects.toMatchObject({ code: 'IO', leftPath: join(snapDir, 'g.gguf') });
    // appendExisting refused at open: nothing was written, nothing is named.
    await writeFile(join(snapDir, 'h.gguf'), W.slice(0, 2));
    const noOpen = mk({ ...fx.fs, open: async (p, flags) => {
      if (flags === 'a') throw Object.assign(new Error('EIO: open'), { code: 'EIO' });
      return fx.fs.open(p, flags);
    } });
    await expect(noOpen.resumeSnapshotCopy(C, 'h.gguf', EW, (await factsOf(fx.fs, join(snapDir, 'h.gguf')))!)).rejects.toEqual(expectCode('IO'));
    // A close that fails, after a good append and after a failed one.
    for (const writeToo of [false, true]) {
      const n = `c${String(writeToo)}.gguf`;
      await writeFile(join(snapDir, n), W.slice(0, 2));
      const badClose = mk({ ...fx.fs, open: async (p, flags) => {
        const h = await fx.fs.open(p, flags);
        return flags === 'a' ? { ...h,
          write: async (c: Uint8Array) => { if (writeToo) throw Object.assign(new Error('EIO: w'), { code: 'EIO' }); await h.write(c); },
          close: async () => { await h.close(); throw Object.assign(new Error('EIO: close'), { code: 'EIO' }); } } : h;
      } });
      await expect(badClose.resumeSnapshotCopy(C, n, EW, (await factsOf(fx.fs, join(snapDir, n)))!)).rejects.toMatchObject({ code: 'IO', leftPath: join(snapDir, n) });
    }
  });
  it('resumeSnapshotCopy across 8 MiB read chunks', async () => {
    const { fx, dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    const big = Buffer.from(Array.from({ length: 9 * 1024 * 1024 + 7 }, (_, i) => (i * 7) & 0xff));
    const etag = createHash('sha256').update(big).digest('hex');
    const w = await dfs.openIncomplete(etag, null);
    await w.write(big);
    await dfs.commitBlob(etag, await w.close());
    const entry = join(folder, 'snapshots', C, 'big.bin');
    await writeFile(entry, big.subarray(0, 8.5 * 1024 * 1024));
    expect(await dfs.resumeSnapshotCopy(C, 'big.bin', etag, (await factsOf(fx.fs, entry))!)).toBe('copied');
    expect(Buffer.from(await readFile(entry)).equals(big)).toBe(true);
  });
  it('copySnapshot hashes a large file in chunks', async () => {
    const { dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    const big = 'z'.repeat(9 * 1024 * 1024 + 7);
    const e = sha256(big);
    await download(dfs, e, big);
    expect(await dfs.copySnapshot(C, 'big.bin', e)).toBe('copied');
    expect(await dfs.copySnapshot(C, 'big.bin', e)).toBe('same');
    expect((await lstat(join(folder, 'snapshots', C, 'big.bin'))).size).toBe(big.length);
  });
  it('replaceRef: a ref that changed since it was read is STALE; a non-file ref is EXISTS; the temp is left and never blocks', async () => {
    const fx = await buildFixture({});
    const folder = join(fx.hubRoot, 'models--org--name');
    const ref = join(folder, 'refs', 'main');
    let swapped = false;
    // Another writer replaces the ref after replaceRef read its facts.
    const fs: FsLike = { ...fx.fs, writeFile: async (p, data, opts) => {
      await fx.fs.writeFile(p, data, opts);
      if (!swapped && /\/\.main\.[0-9a-f]{8}\.hfcm-tmp$/.test(p)) {
        swapped = true;
        await writeFile(ref, `${C2}\n`);
      }
    } };
    const dfs = new DownloadFs(new SafeFs(fx.roots, fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fs);
    await dfs.ensureDirs(C, '');
    const temps = async (): Promise<string[]> => (await readdir(join(folder, 'refs'))).filter((n) => n.endsWith('.hfcm-tmp'));
    let err: unknown;
    await dfs.replaceRef('main', C, null).catch((e: unknown) => { err = e; });
    expect(err).toEqual(expect.objectContaining({ code: 'STALE', path: ref }));
    expect(await readFile(ref, 'utf8')).toBe(`${C2}\n`);
    const left = await temps();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^\.main\.[0-9a-f]{8}\.hfcm-tmp$/);
    expect(await readFile(join(folder, 'refs', left[0]!), 'utf8')).toBe(C); // left ...
    expect((err as Error).message).toContain(join(folder, 'refs', left[0]!)); // ... and reported
    await mkdir(join(folder, 'refs', 'dir'));
    await expect(dfs.replaceRef('dir', C, null)).rejects.toEqual(expectCode('EXISTS'));
    // The leftover never blocks a later update: the next attempt uses a new temp name and succeeds.
    await dfs.replaceRef('main', C, C2);
    expect(await readFile(ref, 'utf8')).toBe(C);
    expect(await temps()).toEqual(left);
    expect(await readFile(join(folder, 'refs', left[0]!), 'utf8')).toBe(C);
  });
});

describe('confinement: every write stays inside <hub>/<repo folder>/', () => {
  it.each([
    ['..'], ['../x'], ['/etc/passwd'], ['a/../../x'], ['a//b'], ['./a'], [''], ['a\\b'], ['a\0b'],
  ])('a snapshot path %j is CONTAINMENT', async (p) => {
    const { dfs } = await fresh();
    await dfs.ensureDirs(C, '');
    await download(dfs, EW, W);
    await expect(dfs.linkSnapshot(C, p, EW)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.copySnapshot(C, p, EW)).rejects.toEqual(expectCode('CONTAINMENT'));
    if (p !== '') await expect(dfs.ensureDirs(C, p)).rejects.toEqual(expectCode('CONTAINMENT'));
  });
  it.each([['../x'], ['E'.repeat(64)], ['a'.repeat(63)], ['a'.repeat(41)], [''], ['x.incomplete'], [`${'a'.repeat(64)}/x`]])(
    'an etag %j is CONTAINMENT for every method', async (e) => {
      const { dfs } = await fresh();
      await dfs.ensureDirs(C, '');
      expect(() => dfs.incompletePath(e)).toThrow(expectCode('CONTAINMENT'));
      await expect(dfs.openIncomplete(e, null)).rejects.toEqual(expectCode('CONTAINMENT'));
      await expect(dfs.commitBlob(e, (await factsOf(dfs['fs'], join(dfs.folder, 'blobs')))!)).rejects.toEqual(expectCode('CONTAINMENT'));
      await expect(dfs.linkSnapshot(C, 'x', e)).rejects.toEqual(expectCode('CONTAINMENT'));
      await expect(dfs.copySnapshot(C, 'x', e)).rejects.toEqual(expectCode('CONTAINMENT'));
    });
  it.each([['../x'], ['main'], ['C'.repeat(40)], ['c'.repeat(39)], ['']])('a snapshot commit %j is CONTAINMENT', async (c) => {
    const { dfs } = await fresh();
    await expect(dfs.ensureDirs(c, '')).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.linkSnapshot(c, 'x', EW)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.copySnapshot(c, 'x', EW)).rejects.toEqual(expectCode('CONTAINMENT'));
  });
  it('replaceRef refuses unsafe revisions, a commit revision, and non-40-hex content', async () => {
    const { dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    for (const rev of ['../x', '/main', 'a/../b', 'a//b', '.', 'a b', '', C, 'A'.repeat(40)]) {
      await expect(dfs.replaceRef(rev, C, null)).rejects.toEqual(expectCode('CONTAINMENT'));
    }
    for (const content of [`${C}\n`, 'C'.repeat(40), 'c'.repeat(39), 'c'.repeat(64), '../x', '']) {
      await expect(dfs.replaceRef('main', content, null)).rejects.toEqual(expectCode('CONTAINMENT'));
      await expect(dfs.replaceRef('main', C, content)).rejects.toEqual(expectCode('CONTAINMENT'));
    }
    expect(await readdir(join(folder, 'refs'))).toEqual([]);
  });
  it('a symlinked blobs/ (even one pointing into another repo) is CONTAINMENT for every method', async () => {
    const { fx, dfs, folder } = await fresh(existing);
    await mkdir(folder);
    const other = join(fx.repo('o/a').folder, 'blobs');
    await symlink(other, join(folder, 'blobs'));
    const before = await treeDigest(fx.repo('o/a').folder);
    await expect(dfs.ensureDirs(C, '')).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.openIncomplete(EW, null)).rejects.toEqual(expectCode('CONTAINMENT'));
    const facts = (await factsOf(fx.fs, fx.repo('o/a').blobOf('x.gguf')))!;
    await expect(dfs.commitBlob(EW, facts)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.linkSnapshot(C, 'x', EW)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.copySnapshot(C, 'x', EW)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await treeDigest(fx.repo('o/a').folder)).toEqual(before);
  });
  it('a symlinked snapshot dir, refs dir or repo folder is CONTAINMENT; the other repo is untouched', async () => {
    const { fx, dfs, folder } = await fresh(existing);
    const victim = fx.repo('o/a').folder;
    const before = await treeDigest(victim);
    await symlink(victim, folder); // the repo folder itself
    await expect(dfs.ensureDirs(C, '')).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.replaceRef('main', C, null)).rejects.toEqual(expectCode('CONTAINMENT'));
    await rename(folder, join(fx.hubRoot, 'moved-link'));
    await dfs.ensureDirs(C2, '');
    await symlink(join(victim, 'snapshots', fx.repo('o/a').commits[0]!), join(folder, 'snapshots', C));
    await expect(dfs.ensureDirs(C, 'a')).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.linkSnapshot(C, 'y.gguf', EW)).rejects.toEqual(expectCode('CONTAINMENT'));
    await rename(join(folder, 'refs'), join(folder, 'refs-old'));
    await symlink(join(victim, 'refs'), join(folder, 'refs'));
    await expect(dfs.replaceRef('main', C, null)).rejects.toEqual(expectCode('CONTAINMENT'));
    expect(await treeDigest(victim)).toEqual(before);
  });
  it('the lexical gate (defence in depth behind the validated path builders) refuses the folder itself and anything outside', async () => {
    const { fx, dfs, folder } = await fresh(existing);
    const confine = (p: string): Promise<void> => (dfs as unknown as { confine(p: string): Promise<void> }).confine(p);
    for (const p of [folder, fx.hubRoot, join(fx.repo('o/a').folder, 'blobs', EW), `${folder}-x/blobs/${EW}`, fx.outside('x'), join(folder, '..', 'x')]) {
      await expect(confine(p)).rejects.toEqual(expectCode('CONTAINMENT'));
    }
  });
  it('a repo folder that is a file is CONTAINMENT', async () => {
    const { dfs, folder } = await fresh();
    await writeFile(folder, 'not a folder');
    await expect(dfs.ensureDirs(C, '')).rejects.toEqual(expectCode('CONTAINMENT'));
  });
  it('a component that cannot be inspected or resolved fails closed (CONTAINMENT)', async () => {
    const { fx, dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    const blobs = join(folder, 'blobs');
    const lstatFails = failingFs(fx.fs, 'lstat', 'EACCES', (p) => p === blobs);
    const d1 = new DownloadFs(new SafeFs(fx.roots, fx.fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, lstatFails);
    await expect(d1.openIncomplete(EW, null)).rejects.toEqual(expect.objectContaining({ code: 'CONTAINMENT', errno: 'EACCES' }));
    const realFails = failingFs(fx.fs, 'realpath', 'EACCES', (p) => p === folder);
    const d2 = new DownloadFs(new SafeFs(fx.roots, fx.fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, realFails);
    await expect(d2.openIncomplete(EW, null)).rejects.toEqual(expect.objectContaining({ code: 'CONTAINMENT', errno: 'EACCES' }));
    // A component that resolves outside the repo folder (a race, or a filesystem that lies) is refused too.
    const lies: ReadFs = { ...fx.fs, realpath: async (p) => (p === blobs ? fx.outside('blobs') : fx.fs.realpath(p)) };
    const d3 = new DownloadFs(new SafeFs(fx.roots, fx.fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, lies);
    await expect(d3.openIncomplete(EW, null)).rejects.toEqual(expectCode('CONTAINMENT'));
    const hubFails = failingFs(fx.fs, 'realpath', 'ENOENT', (p) => p === fx.hubRoot);
    const d4 = new DownloadFs(new SafeFs(fx.roots, fx.fs), fx.hubRoot, { repoId: 'other/one', type: 'model' }, hubFails);
    await expect(d4.ensureDirs(C, '')).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(lstat(join(fx.hubRoot, 'models--other--one'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(blobs)).toEqual([]);
  });
});

describe('inputs that are not strings, and reads that fail', () => {
  it('non-string arguments are CONTAINMENT, never a TypeError', async () => {
    const { fx, dfs } = await fresh();
    const bad = 7 as unknown as string;
    expect(() => new DownloadFs(new SafeFs(fx.roots, fx.fs), bad, { repoId: 'o/a', type: 'model' })).toThrow(expectCode('CONTAINMENT'));
    expect(() => dfs.incompletePath(bad)).toThrow(expectCode('CONTAINMENT'));
    await expect(dfs.ensureDirs(bad, '')).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.linkSnapshot(C, bad, EW)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.replaceRef(bad, C, null)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.replaceRef('main', bad, null)).rejects.toEqual(expectCode('CONTAINMENT'));
    await expect(dfs.replaceRef('main', C, bad)).rejects.toEqual(expectCode('CONTAINMENT'));
  });
  it('a ref that cannot be read is IO and is not replaced', async () => {
    const { fx, folder } = await fresh();
    const ref = join(folder, 'refs', 'main');
    await mkdir(join(folder, 'refs'), { recursive: true });
    await writeFile(ref, C);
    const fs = failingFs(fx.fs, 'readFile', 'EACCES', (p) => p === ref);
    const d = new DownloadFs(new SafeFs(fx.roots, fx.fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fs);
    await expect(d.replaceRef('main', C2, C)).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EACCES', path: ref }));
    expect(await readFile(ref, 'utf8')).toBe(C);
  });
  it('an entry that cannot be inspected is IO and nothing is written', async () => {
    const { fx, dfs, folder } = await fresh();
    await dfs.ensureDirs(C, '');
    await download(dfs, EW, W);
    const entry = join(folder, 'snapshots', C, 'x.gguf');
    const fs = failingFs(fx.fs, 'lstat', 'EACCES', (p) => p === entry);
    const d = new DownloadFs(new SafeFs(fx.roots, fx.fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fs);
    await expect(d.linkSnapshot(C, 'x.gguf', EW)).rejects.toEqual(expect.objectContaining({ code: 'IO', errno: 'EACCES', path: entry }));
    await expect(lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('never deletes', () => {
  it('no unlink or rmdir is called on any path, success or failure', async () => {
    const fx = await buildFixture(existing);
    const calls: string[] = [];
    const rec = recordingFs(fx.fs, calls);
    const mk = (fs: FsLike) => new DownloadFs(new SafeFs(fx.roots, fs), fx.hubRoot, { repoId: 'org/name', type: 'model' }, fs);
    const dfs = mk(rec);
    const folder = dfs.folder;
    await dfs.ensureDirs(C, 'a');
    await download(dfs, EW, W);
    await download(dfs, EJ, J);
    await dfs.linkSnapshot(C, 'a/b.gguf', EW);
    await dfs.linkSnapshot(C, 'a/b.gguf', EW);
    await dfs.copySnapshot(C, 'config.json', EJ);
    await dfs.copySnapshot(C, 'config.json', EJ);
    await dfs.replaceRef('main', C, null);
    await dfs.replaceRef('main', C2, C);
    await dfs.replaceRef('main', C, null);   // moved meanwhile: nothing written
    const swallow = async (p: Promise<unknown>): Promise<void> => {
      await p.catch(() => undefined);
    };
    // Failure paths: already-present, EXISTS, STALE, CONTAINMENT, and every fs step failing in turn.
    await download(dfs, EW, 'again');
    await swallow(dfs.linkSnapshot(C, 'a/b.gguf', EJ));
    await swallow(dfs.copySnapshot(C, 'a/b.gguf', EW));
    await swallow(dfs.openIncomplete(EW, { ...(await factsOf(fx.fs, dfs.incompletePath(EW)))!, size: 0 }));
    await swallow(dfs.linkSnapshot(C, '../x', EW));
    await swallow(dfs.replaceRef('../x', C, null));
    for (const method of ['rename', 'writeFile', 'symlink', 'open', 'mkdir'] as const) {
      const failing = mk(recordingFs(failingFs(fx.fs, method, 'EIO'), calls));
      await swallow(failing.ensureDirs(C2, 'n'));
      await swallow(download(failing, sha256(method), method));
      await swallow(failing.linkSnapshot(C, `${method}.l`, EW));
      await swallow(failing.copySnapshot(C, `${method}.c`, EW));
      await swallow(failing.replaceRef(`r-${method}`, C, null));
    }
    // A copy that fails mid-way (the dest fd's write fails after some bytes): the partial copy stays.
    const midCopy = mk(recordingFs({ ...fx.fs, open: async (p, flags) => {
      const h = await fx.fs.open(p, flags);
      return flags === 'wx' && p.includes('mid.c') ? { ...h, write: async (c: Uint8Array) => {
        await h.write(c.subarray(0, 2));
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      } } : h;
    } }, calls));
    await swallow(midCopy.copySnapshot(C, 'mid.c', EW));
    expect(await readFile(join(folder, 'snapshots', C, 'mid.c'), 'utf8')).toBe(W.slice(0, 2));
    // ... and finishing it appends: still no removing call.
    await midCopy.resumeSnapshotCopy(C, 'mid.c', EW, (await factsOf(fx.fs, join(folder, 'snapshots', C, 'mid.c')))!);
    expect(await readFile(join(folder, 'snapshots', C, 'mid.c'), 'utf8')).toBe(W);
    expect(calls.length).toBeGreaterThan(50);
    // Allow-list, not deny-list: every fs method DownloadFs reached is a read or a non-deleting, non-replacing create.
    // (unlink and rmdir, the only removing methods of FsLike, are therefore never called.)
    const allowed = new Set(['lstat', 'stat', 'readlink', 'readdir', 'readFile', 'realpath', 'statfs',
      'mkdir', 'open', 'writeFile', 'rename', 'symlink']);
    expect([...new Set(calls)].filter((m) => !allowed.has(m))).toEqual([]);
    expect(calls).not.toContain('unlink');
    expect(await readFile(join(folder, 'blobs', `${EW}.incomplete`), 'utf8')).toBe('again');
  });
});
