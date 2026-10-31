import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFs } from '../../../src/core/fsx';
import { parseRepoFolder, scanHub } from '../../../src/core/scan/scanner';
import { sweepDecision } from '../../../src/core/scan/store';
import type { CacheModel } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { failingFs } from '../../helpers/failing-fs';
import { buildFixture } from '../../helpers/fixture';
import { folderName, hex, hubBuilder } from '../../helpers/hub-builder';

useCanaries();

const byId = (m: CacheModel, id: string) => {
  const r = m.repos.find((x) => x.id === id);
  if (!r) throw new Error(`no repo ${id}`);
  return r;
};

describe('parseRepoFolder', () => {
  it.each([
    ['models--unsloth--Qwen3.6-27B-GGUF', { id: 'unsloth/Qwen3.6-27B-GGUF', type: 'model' }],
    ['datasets--HuggingFaceFW--fineweb', { id: 'HuggingFaceFW/fineweb', type: 'dataset' }],
    ['spaces--black-forest-labs--FLUX.1-dev', { id: 'black-forest-labs/FLUX.1-dev', type: 'space' }],
    ['models--gpt2', { id: 'gpt2', type: 'model' }],
  ])('%s', (n, want) => expect(parseRepoFolder(n)).toEqual(want));
  it.each(['kernels--a--b', 'models--', 'blobs', '.locks', 'models-a-b', 'version.txt'])('ignores %s', (n) =>
    expect(parseRepoFolder(n)).toBeNull());
});

describe('scanHub repos', () => {
  it('finds models, datasets and spaces sorted by folder name; ignores blobs/ and .locks/', async () => {
    const hb = await hubBuilder();
    await hb.repo('unsloth/Qwen3.6-27B-GGUF').main('c1');
    await hb.repo('Qwen/Qwen3-32B').main('c1');
    await hb.repo('HuggingFaceFW/fineweb', 'dataset').main('c1');
    await mkdir(join(hb.hub, '.locks', 'x'), { recursive: true });
    await hb.store('a'.repeat(64), 3, ['x']);
    const m = await scanHub(hb.hub);
    expect(m.repos.map((r) => r.folderName)).toEqual([
      'datasets--HuggingFaceFW--fineweb',
      'models--Qwen--Qwen3-32B',
      'models--unsloth--Qwen3.6-27B-GGUF',
    ]);
    expect(m.hubRoot).toBe(hb.hub);
    expect(m.repos[1]!.folder).toBe(join(hb.hub, 'models--Qwen--Qwen3-32B'));
  });
  it('skips a symlinked repo folder', async () => {
    const hb = await hubBuilder();
    await mkdir(join(hb.root, 'elsewhere', 'snapshots'), { recursive: true });
    await hb.symlink(join(hb.root, 'elsewhere'), join(hb.hub, 'models--x--link'));
    expect((await scanHub(hb.hub)).repos.map((r) => r.id)).not.toContain('x/link');
  });
  it('realpaths the hub root it is given', async () => {
    const hb = await hubBuilder();
    await hb.repo('o/r').main('c1');
    await symlink(hb.hub, join(hb.root, 'hublink'));
    const m = await scanHub(join(hb.root, 'hublink'));
    expect(m.hubRoot).toBe(hb.hub);
    expect(m.repos[0]!.folder).toBe(join(hb.hub, 'models--o--r'));
  });
  it('throws ENOENT for a missing hub', async () => {
    const hb = await hubBuilder();
    await expect(scanHub(join(hb.root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('ignores .hfcm-canary entries (fixture canary appears nowhere in the model)', async () => {
    const fx = await buildFixture({ repos: [{ id: 'o/r', snapshots: [{ commit: 'c1', files: [{ path: 'a.txt', plain: 1 }] }], main: 0 }] });
    const m = await scanHub(fx.hubRoot);
    expect(m.repos.map((r) => r.id)).toEqual(['o/r']);
    expect(JSON.stringify(m)).not.toContain('.hfcm-canary');
  });
});

describe('refs/main and snapshot order', () => {
  it('mainCommit is refs/main stripped; null when absent or blank', async () => {
    const hb = await hubBuilder();
    await hb.repo('o/r1').main('c1');
    await mkdir(join(hb.hub, 'models--o--r2', 'refs'), { recursive: true });
    await writeFile(join(hb.hub, 'models--o--r2', 'refs', 'main'), '  \n');
    await mkdir(join(hb.hub, 'models--o--r3'), { recursive: true });
    const m = await scanHub(hb.hub);
    expect(byId(m, 'o/r1').mainCommit).toBe('c1');
    expect(byId(m, 'o/r2').mainCommit).toBeNull();
    expect(byId(m, 'o/r3').mainCommit).toBeNull();
  });
  it('orders snapshots main first, then by mtime newest first, ties by name', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const mt: Record<string, number> = { a: 1000, b: 3000, c: 2000, d: 3000 };
    for (const c of Object.keys(mt)) await r.plain(c, 'f.txt', 1);
    for (const [c, t] of Object.entries(mt)) await hb.touch(join(r.folder, 'snapshots', c), t);
    await r.main('c');
    expect(byId(await scanHub(hb.hub), 'o/r').snapshots).toEqual(['c', 'b', 'd', 'a']);
  });
  it('ignores non-directory and symlinked entries in snapshots/', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await r.plain('a', 'f.txt', 1);
    await writeFile(join(r.folder, 'snapshots', 'README'), 'x');
    await hb.symlink(join(r.folder, 'snapshots', 'a'), join(r.folder, 'snapshots', 'alias'));
    expect(byId(await scanHub(hb.hub), 'o/r').snapshots).toEqual(['a']);
  });
  it('never follows a symlinked snapshots/: no files or snapshot dirs, the link is an otherFile', async () => {
    const hb = await hubBuilder();
    const b = hb.repo('o/b');
    await b.plain('c1', 'f.txt', 1);
    await b.main('c1');
    const a = hb.repo('o/a');
    await a.main('c1');
    await hb.symlink('../models--o--b/snapshots', join(a.folder, 'snapshots'));
    const r = byId(await scanHub(hb.hub), 'o/a');
    expect(r.snapshots).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.snapshotDirs).toEqual([]);
    expect(r.otherFiles.map((o) => o.path)).toContain(join(a.folder, 'snapshots'));
    expect(r.otherFiles.find((o) => o.path === join(a.folder, 'snapshots'))!.facts.isSymlink).toBe(true);
  });
  it('never reads refs/main through a symlinked refs/: mainCommit is null', async () => {
    const hb = await hubBuilder();
    const b = hb.repo('o/b');
    await b.plain('cb', 'f.txt', 1);
    await b.main('cb');
    const a = hb.repo('o/a');
    await a.plain('c1', 'g.txt', 1);
    await hb.symlink('../models--o--b/refs', join(a.folder, 'refs'));
    const r = byId(await scanHub(hb.hub), 'o/a');
    expect(r.mainCommit).toBeNull();
    expect(r.snapshots).toEqual(['c1']);
  });
});

describe('refs, the commit every ref under refs/ names', () => {
  it('reads refs/main, branches with a slash and refs/pr/N, stripped; skips temp and dot files, links and huge files', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await r.plain('c1', 'f.txt', 1);
    await r.main('c1');
    const refs = join(r.folder, 'refs');
    await mkdir(join(refs, 'feature'), { recursive: true });
    await mkdir(join(refs, 'refs', 'pr'), { recursive: true });
    await writeFile(join(refs, 'dev'), 'c2');
    await writeFile(join(refs, 'feature', 'x'), 'c3\n');
    await writeFile(join(refs, 'refs', 'pr', '1'), 'c4');
    await writeFile(join(refs, '.main.0a1b2c3d.hfcm-tmp'), 'c5');   // a ref temp file a failed write left
    await writeFile(join(refs, 'blank'), '  \n');
    await writeFile(join(refs, 'big'), 'c6'.repeat(5000));
    await hb.symlink(join(refs, 'dev'), join(refs, 'alias'));
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.refs).toEqual([
      { name: 'dev', commit: 'c2' }, { name: 'feature/x', commit: 'c3' }, { name: 'main', commit: 'c1' }, { name: 'refs/pr/1', commit: 'c4' }]);
    expect(repo.mainCommit).toBe('c1');
  });
  it('is empty without refs/, and never read through a symlinked refs/', async () => {
    const hb = await hubBuilder();
    const b = hb.repo('o/b');
    await b.plain('cb', 'f.txt', 1);
    await b.main('cb');
    const a = hb.repo('o/a');
    await a.plain('c1', 'g.txt', 1);
    const m1 = await scanHub(hb.hub);
    expect(byId(m1, 'o/a').refs).toEqual([]);
    await hb.symlink('../models--o--b/refs', join(a.folder, 'refs'));
    expect(byId(await scanHub(hb.hub), 'o/a').refs).toEqual([]);
  });
  it('an unreadable refs/ entry does not fail the scan; that repo\'s refs are unknown (null), others are read', async () => {
    const hb = await hubBuilder();
    const a = hb.repo('o/a');
    await a.plain('c1', 'f.txt', 1);
    await a.main('c1');
    await mkdir(join(a.folder, 'refs', 'feature'), { recursive: true });
    await writeFile(join(a.folder, 'refs', 'feature', 'x'), 'c2');
    const b = hb.repo('o/b');
    await b.plain('cb', 'g.txt', 1);
    await b.main('cb');
    // (an unreadable refs/ subfolder already failed the scan before : the full folder walk lists it)
    for (const code of ['EACCES', 'EIO']) {
      const at = join(a.folder, 'refs', 'feature', 'x');
      const m = await scanHub(hb.hub, failingFs(nodeFs, 'readFile', code, (p) => p === at));
      expect(byId(m, 'o/a').refs).toBeNull();
      expect(byId(m, 'o/a').mainCommit).toBe('c1');
      expect(byId(m, 'o/a').files.map((f) => f.relpath)).toEqual(['f.txt']);
      expect(byId(m, 'o/b').refs).toEqual([{ name: 'main', commit: 'cb' }]);
    }
  });
});

describe('snapshot entries', () => {
  it('records every snapshot entry with POSIX relpath, facts, first-hop etag and isCurrent', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('unsloth/Qwen3.6-27B-GGUF');
    const e8 = await r.file('c2', 'Qwen3.6-27B-Q8_0.gguf', 800);
    const eB = await r.file('c2', 'BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', 1000);
    await r.file('c1', 'Qwen3.6-27B-Q8_0.gguf', 790);
    await r.main('c2');
    const repo = byId(await scanHub(hb.hub), 'unsloth/Qwen3.6-27B-GGUF');
    expect(repo.files.map((f) => [f.commit, f.relpath, f.blobEtag, f.isCurrent])).toEqual([
      ['c2', 'BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', eB, true],
      ['c2', 'Qwen3.6-27B-Q8_0.gguf', e8, true],
      ['c1', 'Qwen3.6-27B-Q8_0.gguf', hex(`${r.folder}:Qwen3.6-27B-Q8_0.gguf:790`), false],
    ]);
    expect(repo.files[0]!.linkPath).toBe(join(r.folder, 'snapshots', 'c2', 'BF16', 'Qwen3.6-27B-BF16-00001-of-00002.gguf'));
    expect(repo.files[0]!.facts).toMatchObject({ isSymlink: true, linkTarget: '../../../blobs/' + eB });
  });
  describe('isCurrent marks the effective current snapshot', () => {
    const current = (m: CacheModel, id: string) => byId(m, id).files.filter((f) => f.isCurrent).map((f) => [f.commit, f.relpath]);
    const twoSnapshots = async (id: string) => {
      const hb = await hubBuilder();
      const r = hb.repo(id);
      await r.plain('c1', 'old.txt', 'o');
      await r.plain('c2', 'new.txt', 'n');
      await hb.touch(join(r.folder, 'snapshots', 'c1'), 1000);
      await hb.touch(join(r.folder, 'snapshots', 'c2'), 2000);
      return { hb, r };
    };
    it('refs/main present: only its snapshot, even when older', async () => {
      const { hb, r } = await twoSnapshots('o/r');
      await r.main('c1');
      expect(current(await scanHub(hb.hub), 'o/r')).toEqual([['c1', 'old.txt']]);
    });
    it('refs/main names a missing snapshot: the newest non-empty snapshot', async () => {
      const { hb, r } = await twoSnapshots('o/r');
      await r.main('c9');
      expect(current(await scanHub(hb.hub), 'o/r')).toEqual([['c2', 'new.txt']]);
    });
    it('refs/main names an empty snapshot: the newest non-empty snapshot', async () => {
      const { hb, r } = await twoSnapshots('o/r');
      await mkdir(join(r.folder, 'snapshots', 'c3'));
      await r.main('c3');
      const m = await scanHub(hb.hub);
      expect(byId(m, 'o/r').snapshots[0]).toBe('c3');
      expect(current(m, 'o/r')).toEqual([['c2', 'new.txt']]);
    });
    it('no refs/main at all (downloaded by commit hash): the newest non-empty snapshot', async () => {
      const { hb, r } = await twoSnapshots('o/r');
      await mkdir(join(r.folder, 'snapshots', 'c0'));
      await hb.touch(join(r.folder, 'snapshots', 'c0'), 3000);
      const m = await scanHub(hb.hub);
      expect(byId(m, 'o/r').mainCommit).toBeNull();
      expect(current(m, 'o/r')).toEqual([['c2', 'new.txt']]);
    });
    it('no snapshot has files: nothing is current', async () => {
      const hb = await hubBuilder();
      const r = hb.repo('o/r');
      await mkdir(join(r.folder, 'snapshots', 'c1'), { recursive: true });
      await r.main('c1');
      expect(current(await scanHub(hb.hub), 'o/r')).toEqual([]);
    });
  });
  it('plain files in a snapshot are entries with blobEtag null', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await r.plain('c1', 'README.md', '# hi');
    const f = byId(await scanHub(hb.hub), 'o/r').files[0]!;
    expect(f).toMatchObject({ relpath: 'README.md', blobEtag: null, facts: { isFile: true, isSymlink: false, size: 4 } });
  });
  it('a plain-only repo with no blobs/ does not throw', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await r.plain('c1', 'README.md', '# hi');
    await r.plain('c1', 'sub/notes.txt', 'n');
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.files.map((f) => [f.relpath, f.blobEtag])).toEqual([['README.md', null], ['sub/notes.txt', null]]);
  });
  it('resolves a link to a missing blobs/ dir against the lexical path', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await r.link('c1', 'x.gguf', hex(5));
    expect(byId(await scanHub(hb.hub), 'o/r').files[0]!.blobEtag).toBe(hex(5));
  });
  it('blobEtag is null for links into another repo', async () => {
    const hb = await hubBuilder();
    const other = hb.repo('o/other');
    const e = await other.file('c1', 'y.gguf', 3);
    const r = hb.repo('o/r');
    await hb.symlink(`../../../models--o--other/blobs/${e}`, join(r.folder, 'snapshots', 'c1', 'x.gguf'));
    expect(byId(await scanHub(hb.hub), 'o/r').files[0]!.blobEtag).toBeNull();
  });
  it('blobEtag is null for a link to a non-64-hex name or a 40-char git sha', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await r.blob('a'.repeat(40), 1);
    await r.incomplete(hex(1), 1);
    await hb.symlink('../../blobs/' + 'a'.repeat(40), join(r.folder, 'snapshots', 'c1', 'a'));
    await hb.symlink(`../../blobs/${hex(1)}.incomplete`, join(r.folder, 'snapshots', 'c1', 'b'));
    const files = byId(await scanHub(hb.hub), 'o/r').files;
    expect(files.map((f) => [f.relpath, f.blobEtag])).toEqual([['a', null], ['b', null]]);
  });
  it('blobEtag is set for a link to a missing 64-hex blob (broken link still attributed)', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await r.blob(hex(1), 1);
    await r.link('c1', 'x.gguf', hex(77));
    expect(byId(await scanHub(hb.hub), 'o/r').files[0]!.blobEtag).toBe(hex(77));
  });
  it('resolves an absolute link text with the \\\\?\\ prefix', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const e = hex(9);
    await r.blob(e, 2);
    await hb.symlink('\\\\?\\' + join(r.folder, 'blobs', e), join(r.folder, 'snapshots', 'c1', 'w.gguf'));
    const f = byId(await scanHub(hb.hub), 'o/r').files[0]!;
    expect(f.blobEtag).toBe(e);
    expect(f.facts.linkTarget).toBe(join(r.folder, 'blobs', e));
  });
  it('does not descend into a symlinked snapshot subdirectory; it is a file entry', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await mkdir(join(hb.root, 'outside'), { recursive: true });
    await writeFile(join(hb.root, 'outside', 'f.txt'), 'x');
    await mkdir(join(r.folder, 'snapshots', 'c1'), { recursive: true });
    await hb.symlink(join(hb.root, 'outside'), join(r.folder, 'snapshots', 'c1', 'sub'));
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.files.map((f) => f.relpath)).toEqual(['sub']);
    expect(repo.files[0]).toMatchObject({ blobEtag: null, facts: { isSymlink: true } });
  });
  it('snapshotDirs lists every directory under snapshots/, deepest first', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await r.plain('c1', 'a/b/x.gguf', 1);
    await r.plain('c1', 'a/y.gguf', 1);
    await r.plain('c1', 'z.gguf', 1);
    await r.plain('c2', 'q.gguf', 1);
    await mkdir(join(r.folder, 'snapshots', 'c2', 'empty'), { recursive: true });
    const s = join(r.folder, 'snapshots');
    expect(byId(await scanHub(hb.hub), 'o/r').snapshotDirs).toEqual([
      join(s, 'c1', 'a', 'b'), join(s, 'c1', 'a'), join(s, 'c2', 'empty'), join(s, 'c1'), join(s, 'c2'),
    ]);
  });
  it('a self-referencing link (ELOOP) does not break the scan; that entry has blobEtag null', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const e = await r.file('c1', 'ok.gguf', 5);
    await hb.symlink('loop', join(r.folder, 'snapshots', 'c1', 'loop'));
    await hb.symlink(`loop/${hex(4)}`, join(r.folder, 'snapshots', 'c1', 'x'));
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.files.map((f) => [f.relpath, f.blobEtag])).toEqual([['loop', null], ['ok.gguf', e], ['x', null]]);
  });
  it('a link whose target parent passes through a regular file (ENOTDIR) has blobEtag null', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const e = await r.file('c1', 'ok.gguf', 5);
    await r.plain('c1', 'plain.txt', 'p');
    await hb.symlink(`plain.txt/${hex(3)}`, join(r.folder, 'snapshots', 'c1', 'y'));
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.files.map((f) => [f.relpath, f.blobEtag])).toEqual([['ok.gguf', e], ['plain.txt', null], ['y', null]]);
  });
});

describe('repo blobs', () => {
  it('records plain repo blobs with lstat facts and size', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const e = hex('w');
    await r.blob(e, 4096);
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.blobs[e]).toEqual({
      path: join(r.folder, 'blobs', e), etag: e, facts: expect.objectContaining({ isFile: true, isSymlink: false, size: 4096, nlink: 1 }),
      storePath: null, size: 4096, dangling: false,
    });
    expect(Object.keys(repo.blobs)).toEqual([e]);
  });
  it('sees hardlinks: nlink 2 on both repos, same dev/ino', async () => {
    const hb = await hubBuilder();
    const a = hb.repo('a/one');
    const b = hb.repo('b/two');
    const e = hex('hl');
    const p = await a.blob(e, 10);
    await hb.hardlink(p, join(b.folder, 'blobs', e));
    const m = await scanHub(hb.hub);
    const ab = byId(m, 'a/one').blobs[e]!;
    const bb = byId(m, 'b/two').blobs[e]!;
    expect(ab.facts.nlink).toBe(2);
    expect(bb.facts.nlink).toBe(2);
    expect(ab.facts.ino).toBe(bb.facts.ino);
    expect(ab.facts.dev).toBe(bb.facts.dev);
  });
  it('records a store link: storePath is the abspath of one hop, size follows the link', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('a/one');
    const e = hex('s1');
    const H = hex('payload');
    await hb.marker();
    const S = await hb.store(H, 777, [`${folderName('a/one')}/blobs/${e}`]);
    await r.storeLink(e, H);
    const repo = byId(await scanHub(hb.hub), 'a/one');
    expect(repo.blobs[e]).toMatchObject({
      path: join(r.folder, 'blobs', e), storePath: S, size: 777, dangling: false,
      facts: { isSymlink: true, linkTarget: `../../blobs/${H.slice(0, 2)}/${H}` },
    });
  });
  it('a store link with \\\\?\\ absolute text resolves to the same storePath', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/b');
    const e = hex('abs');
    const H = hex('payload');
    const S = await hb.store(H, 5, []);
    await hb.symlink('\\\\?\\' + S, join(r.folder, 'blobs', e));
    const b = byId(await scanHub(hb.hub), 'o/b').blobs[e]!;
    expect(b.storePath).toBe(S);
    // size/dangling follow the OS: POSIX does not strip the prefix when following, so the link dangles here.
  });
  it('a dangling store link has size 0 and dangling true', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/b');
    const e = hex('dang');
    const H = hex('missing');
    await r.storeLink(e, H);
    const b = byId(await scanHub(hb.hub), 'o/b').blobs[e]!;
    expect(b).toMatchObject({ storePath: join(hb.hub, 'blobs', H.slice(0, 2), H), size: 0, dangling: true });
  });
  it('ignores non-64-hex names, .incomplete, .lock and directories in blobs/', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const e = hex('x');
    await r.blob('a'.repeat(40), 1);
    await r.blob(e.toUpperCase(), 1);
    await r.incomplete(e, 1);
    await r.blob(`${e}.lock`, '');
    await mkdir(join(r.folder, 'blobs', hex('dir')), { recursive: true });
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(Object.keys(repo.blobs)).toEqual([]);
  });
  it('a symlinked blobs/ directory is not followed: no blobs, and the link is an otherFiles entry', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const e = hex('elsewhere');
    await mkdir(join(hb.root, 'elsewhere'), { recursive: true });
    await writeFile(join(hb.root, 'elsewhere', e), 'x');
    await writeFile(join(hb.root, 'elsewhere', `${e}.incomplete`), 'x');
    await mkdir(r.folder, { recursive: true });
    await symlink(join(hb.root, 'elsewhere'), join(r.folder, 'blobs'));
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.blobs).toEqual({});
    expect(repo.incomplete).toEqual([]);
    expect(repo.otherFiles.map((f) => f.path)).toEqual([join(r.folder, 'blobs')]);
    expect(repo.otherDirs).toEqual([]);
  });
  it('orphanEtags are blobs no snapshot link names (any snapshot)', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const e1 = await r.file('c1', 'old.gguf', 1);
    const e2 = await r.file('c2', 'new.gguf', 2);
    const e3 = hex('orphan');
    await r.blob(e3, 3);
    await r.main('c2');
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(Object.keys(repo.blobs).sort()).toEqual([e1, e2, e3].sort());
    expect(repo.orphanEtags).toEqual([e3]);
  });
  it('orphanEtags are sorted', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const es = [hex('o1'), hex('o2'), hex('o3'), hex('o4')];
    for (const e of es) await r.blob(e, 1);
    expect(byId(await scanHub(hb.hub), 'o/r').orphanEtags).toEqual([...es].sort());
  });
  it('records .incomplete partials with size and floored mtime, sorted by path', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const p = await r.incomplete(hex('dl'), 50);
    await hb.touch(p, 1_700_000_000_123.9);
    const q = await r.incomplete('a'.repeat(40), 7);
    await hb.touch(q, 1_600_000_000_000);
    const repo = byId(await scanHub(hb.hub), 'o/r');
    const want = [{ path: p, size: 50, mtimeMs: 1_700_000_000_123 }, { path: q, size: 7, mtimeMs: 1_600_000_000_000 }];
    expect(repo.incomplete).toEqual(want.sort((x, y) => (x.path < y.path ? -1 : 1)));
  });
});

describe('the shared store', () => {
  const setup = async () => {
    const hb = await hubBuilder();
    const r = hb.repo('a/one');
    const e = hex('s1');
    const H = hex('payload');
    const ref = `${folderName('a/one')}/blobs/${e}`;
    const S = await hb.store(H, 777, [ref]);
    await r.storeLink(e, H);
    return { hb, r, e, H, S, ref };
  };
  it('reads the shared store: marker, every payload, refs and validRefs', async () => {
    const { hb, H, S, ref } = await setup();
    await hb.marker();
    const m = await scanHub(hb.hub);
    expect(m.storeMarked).toBe(true);
    expect(Object.keys(m.store)).toEqual([S]);
    expect(m.store[S]).toMatchObject({
      path: S, hash: H, refsPath: S + '.refs', refsRaw: [ref], validRefs: [ref], lockPresent: false,
      facts: { isFile: true, isSymlink: false, size: 777 },
    });
  });
  it('lists every payload, sorted by path', async () => {
    const hb = await hubBuilder();
    const hs = [hex('p1'), hex('p2'), hex('p3')];
    const ps: string[] = [];
    for (const h of hs) ps.push(await hb.store(h, 1, null));
    const m = await scanHub(hb.hub);
    expect(Object.keys(m.store)).toEqual([...ps].sort());
    expect(m.store[ps[0]!]).toMatchObject({ refsRaw: null, validRefs: null });
  });
  it('ignores store entries that are not store-shaped (wrong prefix dir, .refs, .lock, symlinks)', async () => {
    const { hb, H, S } = await setup();
    const X = hex('other');
    const blobs = join(hb.hub, 'blobs');
    const wrong = H.slice(0, 2) === 'cd' ? 'ce' : 'cd';
    await mkdir(join(blobs, wrong), { recursive: true });
    await writeFile(join(blobs, wrong, X), 'x'); // wrong prefix dir
    await mkdir(join(blobs, 'zz'), { recursive: true });
    await writeFile(join(blobs, 'zz', 'zz' + X.slice(2)), 'x'); // non-hex prefix dir
    await writeFile(join(blobs, H.slice(0, 2), H + '.lock'), '');
    await writeFile(join(blobs, H.slice(0, 2), H.toUpperCase()), 'x');
    await hb.symlink(S, join(blobs, X.slice(0, 2), X)); // symlinked payload
    await mkdir(join(blobs, hex('d').slice(0, 2), hex('d')), { recursive: true }); // directory payload
    await mkdir(join(hb.root, 'aliasdir'), { recursive: true });
    const Y = hex('aliased');
    await writeFile(join(hb.root, 'aliasdir', Y), 'y');
    if (Y.slice(0, 2) !== H.slice(0, 2) && Y.slice(0, 2) !== X.slice(0, 2)) {
      await symlink(join(hb.root, 'aliasdir'), join(blobs, Y.slice(0, 2))); // symlinked prefix dir
    }
    await writeFile(join(blobs, 'ab'), 'not a dir');
    const m = await scanHub(hb.hub);
    expect(Object.keys(m.store)).toEqual([S]);
    expect(m.store[S]!.lockPresent).toBe(true);
  });
  it('storeMarked false still lists payloads', async () => {
    const { hb, S } = await setup();
    const m = await scanHub(hb.hub);
    expect(m.storeMarked).toBe(false);
    expect(Object.keys(m.store)).toEqual([S]);
  });
  it('a hub without blobs/ has an empty store', async () => {
    const hb = await hubBuilder();
    await hb.repo('o/r').main('c1');
    const m = await scanHub(hb.hub);
    expect(m.store).toEqual({});
    expect(m.storeMarked).toBe(false);
  });
  it('skips .hfcm-canary names in the store walk', async () => {
    const { hb, H, S } = await setup();
    const blobs = join(hb.hub, 'blobs');
    await writeFile(join(blobs, '.hfcm-canary'), 'c');
    await writeFile(join(blobs, H.slice(0, 2), '.hfcm-canary'), 'c');
    const m = await scanHub(hb.hub);
    expect(Object.keys(m.store)).toEqual([S]);
    expect(JSON.stringify(m)).not.toContain('.hfcm-canary');
  });
  it('RepoBlob.path and StoreFile.path share the realpath hub string, so sweepDecision matches end to end', async () => {
    const { hb, e, S } = await setup();
    await hb.marker();
    await symlink(hb.hub, join(hb.root, 'hublink'));
    const m = await scanHub(join(hb.root, 'hublink'));
    const blob = byId(m, 'a/one').blobs[e]!;
    expect(blob.path).toBe(join(m.hubRoot, folderName('a/one'), 'blobs', e));
    expect(blob.storePath).toBe(S);
    expect(Object.keys(m.store)).toEqual([S]);
    expect(sweepDecision(m.store[blob.storePath!]!, [blob.path], m.storeMarked)).toEqual({ deletable: true, reason: 'store-unreferenced' });
    expect(sweepDecision(m.store[S]!, [], m.storeMarked)).toEqual({ deletable: false, reason: 'store-shared' });
  });
});

describe('folderFacts, otherFiles, otherDirs (reconciliation)', () => {
  it('folderFacts is the lstat of the repo folder', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    await r.main('c1');
    await hb.touch(r.folder, 1_650_000_000_500.7);
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.folderFacts).toMatchObject({ isDirectory: true, isSymlink: false, mtimeMs: 1_650_000_000_500 });
  });
  it('whole repo: refs/main, a 40-hex blob, .no_exist/<c>/x and .incomplete are otherFiles; .no_exist dirs are otherDirs', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const f = r.folder;
    const e = await r.file('c1', 'sub/w.gguf', 5);
    await r.plain('c1', 'README.md', 'hi');
    await r.main('c1');
    await r.blob('a'.repeat(40), 1);
    const inc = await r.incomplete(hex('dl'), 3);
    await mkdir(join(f, '.no_exist', 'c1', 'deep'), { recursive: true });
    await writeFile(join(f, '.no_exist', 'c1', 'x'), '');
    await writeFile(join(f, '.no_exist', 'c1', 'deep', 'y'), '');
    await writeFile(join(f, 'blobs', `${e}.lock`), '');
    await writeFile(join(f, 'snapshots', 'README'), 'stray'); // top-level non-dir in snapshots/
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.otherFiles.map((o) => o.path).sort()).toEqual([
      join(f, '.no_exist', 'c1', 'deep', 'y'),
      join(f, '.no_exist', 'c1', 'x'),
      join(f, 'blobs', 'a'.repeat(40)),
      join(f, 'blobs', `${e}.lock`),
      inc,
      join(f, 'refs', 'main'),
      join(f, 'snapshots', 'README'),
    ].sort());
    expect(repo.otherFiles.find((o) => o.path === inc)!.facts).toMatchObject({ isFile: true, size: 3 });
    expect(repo.otherDirs).toEqual([
      join(f, '.no_exist', 'c1', 'deep'),
      join(f, '.no_exist', 'c1'),
      join(f, '.no_exist'),
      join(f, 'blobs'),
      join(f, 'refs'),
      join(f, 'snapshots'),
    ]);
    // completeness: every lstat entry under the folder is in exactly one list
    const all = [
      ...repo.files.map((x) => x.linkPath), ...Object.values(repo.blobs).map((b) => b.path),
      ...repo.otherFiles.map((o) => o.path), ...repo.snapshotDirs, ...repo.otherDirs,
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(2 + 1 + 7 + 2 + 6);
  });
  it('never follows symlinks; a 64-hex directory in blobs/ is descended but is not a blob', async () => {
    const hb = await hubBuilder();
    const r = hb.repo('o/r');
    const f = r.folder;
    await r.plain('c1', 'a.txt', 1);
    const d = hex('dir');
    await mkdir(join(f, 'blobs', d, 'inner'), { recursive: true });
    await writeFile(join(f, 'blobs', d, 'inner', 'z'), 'z');
    await mkdir(join(hb.root, 'outside'), { recursive: true });
    await writeFile(join(hb.root, 'outside', 'secret'), 's');
    await symlink(join(hb.root, 'outside'), join(f, 'linkdir'));
    await symlink(join(hb.root, 'outside'), join(f, 'snapshots', 'alias'));
    const repo = byId(await scanHub(hb.hub), 'o/r');
    expect(repo.blobs).toEqual({});
    expect(repo.otherFiles.map((o) => o.path).sort()).toEqual([
      join(f, 'blobs', d, 'inner', 'z'), join(f, 'linkdir'), join(f, 'snapshots', 'alias'),
    ].sort());
    expect(repo.otherFiles.find((o) => o.path === join(f, 'linkdir'))!.facts.isSymlink).toBe(true);
    expect(repo.otherDirs).toEqual([join(f, 'blobs', d, 'inner'), join(f, 'blobs', d), join(f, 'blobs'), join(f, 'snapshots')]);
    expect(JSON.stringify(repo)).not.toContain('secret');
  });
});

describe('scannedAt', () => {
  it('scannedAt is a timestamp within the scan', async () => {
    const hb = await hubBuilder();
    const t0 = Date.now();
    const m = await scanHub(hb.hub);
    expect(m.scannedAt).toBeGreaterThanOrEqual(t0);
    expect(m.scannedAt).toBeLessThanOrEqual(Date.now());
  });
});
