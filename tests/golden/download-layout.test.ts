// Cache-layout interop: a repo downloaded through the real engine (against the loopback fake Hub) must leave exactly the
// tree huggingface_hub writes (hfhub/xfer.py): blobs/<etag> (sha256 for LFS files, the git blob SHA-1 for small
// ones), snapshots/<commit>/<relpath> as RELATIVE symlinks `../` x (depth + 1) + `blobs/<etag>`, refs/<revision> holding
// the commit hash with no trailing newline, and nothing else (no .incomplete, no temp files). The app's own scanner must
// read it back with the right groups.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, readlink, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { toRemoteListing } from '../../src/core/download/remote-repo';
import { AppLock } from '../../src/core/exec/lock';
import { SafeFs } from '../../src/core/safe-fs';
import { scanHub } from '../../src/core/scan/scanner';
import { AppSettingsStore } from '../../src/main/app-settings';
import { DownloadEngine } from '../../src/main/download/engine';
import { createHubClient } from '../../src/main/hub/client';
import { useCanaries } from '../helpers/canary';
import { ggufRepo, GGUF_COMMIT, GGUF_REPO_ID } from '../helpers/fake-gguf-repo';
import { gitBlobId, sha256Hex, startFakeHub, type FakeHub } from '../helpers/fake-hub';
import { buildFixture } from '../helpers/fixture';

useCanaries();

const hubs: FakeHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
});

/** Every entry under `dir` as `path -> 'dir' | 'file' | 'link:<target>'`, sorted. */
async function tree(dir: string, rel = ''): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const name of (await readdir(join(dir, rel))).sort()) {
    const p = rel === '' ? name : `${rel}/${name}`;
    const st = await lstat(join(dir, p));
    if (st.isSymbolicLink()) out.push([p, `link:${await readlink(join(dir, p))}`]);
    else if (st.isDirectory()) { out.push([p, 'dir'], ...(await tree(dir, p))); }
    else out.push([p, 'file']);
  }
  return out;
}

describe('download layout interop', () => {
  test('a downloaded repo has exactly the huggingface_hub tree and the scanner reads it back', async () => {
    const repo = ggufRepo(true);
    const fx = await buildFixture({ repos: [] });
    const hub = await startFakeHub([repo]);
    hubs.push(hub);
    const fetchLoopback = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (![hub.endpoint, hub.cdnOrigin].some((o) => url.startsWith(`${o}/`))) throw new Error(`test tried to reach ${url}`);
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    const client = createHubClient({ endpoint: { origin: hub.endpoint, base: hub.endpoint, loopbackHttp: true }, token: null, fetch: fetchLoopback });
    const userData = join(fx.root, 'userdata');
    await mkdir(userData, { recursive: true });
    const settings = new AppSettingsStore(userData, { fs: fx.fs, makeSafeFs: (d) => SafeFs.create({ hubRoot: d, viewRoots: [], holdRoot: null }, fx.fs) });
    const engine = new DownloadEngine({
      client, hubRoot: fx.hubRoot, safeFs: async () => new SafeFs(fx.roots, fx.fs), lock: new AppLock(join(dirname(fx.hubRoot), '.hf-cache-manager')),
      settings, statfs: async () => ({ bavail: 1e13, bsize: 1 }), now: () => Date.now(), emit: () => undefined, symlinksSupported: true, fs: fx.fs,
    });

    const rev = await client.revision(GGUF_REPO_ID, 'model', 'main');
    const listing = toRemoteListing({ repoId: GGUF_REPO_ID, type: 'model', commit: rev.commit, files: rev.siblings });
    const files = listing.files.map((f) => ({ path: f.path, etag: f.etag, size: f.size, lfs: f.lfs, state: 'queued' as const, bytes: 0, error: null }));
    await engine.start({ id: randomUUID(), repoId: GGUF_REPO_ID, type: 'model', revision: 'main', commit: rev.commit, refAtStart: null, files, links: [] });
    await engine.whenIdle();
    expect(engine.list()[0]!.files.map((f) => f.state)).toEqual(files.map(() => 'done'));

    // what huggingface_hub names things: sha256 of the content for an LFS file, the git blob id for a plain git file
    const etagOf = (rel: string): string => (repo.lfs!.includes(rel) ? sha256Hex(repo.files[rel]!) : gitBlobId(repo.files[rel]!));
    const rels = Object.keys(repo.files).sort();
    const blobNames = [...new Set(rels.map(etagOf))].sort();
    const expected: Array<[string, string]> = [
      ['blobs', 'dir'], ...blobNames.map((e): [string, string] => [`blobs/${e}`, 'file']),
      ['refs', 'dir'], ['refs/main', 'file'],
      ['snapshots', 'dir'], [`snapshots/${GGUF_COMMIT}`, 'dir'],
    ];
    const dirs = new Set<string>();
    for (const r of rels) {
      const parts = r.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const d of dirs) expected.push([`snapshots/${GGUF_COMMIT}/${d}`, 'dir']);
    for (const r of rels) expected.push([`snapshots/${GGUF_COMMIT}/${r}`, `link:${'../'.repeat(r.split('/').length + 1)}blobs/${etagOf(r)}`]);

    const folder = join(fx.hubRoot, 'models--acme--tiny-GGUF');
    const sortPairs = (a: Array<[string, string]>): Array<[string, string]> => [...a].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    expect(sortPairs(await tree(folder))).toEqual(sortPairs(expected));
    expect(await readlink(join(folder, 'snapshots', GGUF_COMMIT, 'onnx/deep/model.onnx'))).toBe(`../../../../blobs/${etagOf('onnx/deep/model.onnx')}`);
    expect(await readlink(join(folder, 'snapshots', GGUF_COMMIT, 'config.json'))).toBe(`../../blobs/${gitBlobId(repo.files['config.json']!)}`);
    expect(await readFile(join(folder, 'refs/main'), 'utf8')).toBe(GGUF_COMMIT);   // exact: no newline
    for (const r of rels) expect(Buffer.from(await readFile(join(folder, 'snapshots', GGUF_COMMIT, r))).equals(Buffer.from(repo.files[r]!))).toBe(true);
    expect((await readdir(fx.hubRoot)).filter((n) => n !== '.hfcm-canary')).toEqual(['models--acme--tiny-GGUF']);   // nothing else was created in the hub

    const scanned = (await scanHub(fx.hubRoot)).repos.find((r) => r.id === GGUF_REPO_ID)!;
    expect(scanned.mainCommit).toBe(GGUF_COMMIT);
    expect(scanned.incomplete).toEqual([]);
    expect(scanned.files.map((f) => f.relpath).sort()).toEqual(rels);
    expect(scanned.files.every((f) => f.isCurrent)).toBe(true);
  });
});
