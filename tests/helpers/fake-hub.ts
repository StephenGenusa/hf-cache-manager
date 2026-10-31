// Loopback fake Hub and fake CDN for tests and E2E. Two plain-HTTP servers on 127.0.0.1, port 0.
// Everything is served from memory: the fake never reads or writes the filesystem.
//
// Hub:  GET /api/{models|datasets|spaces}/<ns>/<name>/revision/<rev>?blobs=true   (rev: 'main' or the commit)
//       GET /[datasets/|spaces/]<ns>/<name>/resolve/<rev>/<file>                  → 302 to the CDN
// CDN:  GET /cdn/{models|datasets|spaces}/<ns>/<name>/<commit>/<file>               (honours Range)
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HubRepoType } from '../../src/shared/hub-input';

export interface FakeHubRepo {
  repoId: string;
  type?: HubRepoType;
  commit: string;
  files: Record<string, Uint8Array>;
  /** Resolves without an Authorization header get 401 with X-Error-Code: GatedRepo; the API still answers. */
  gated?: boolean;
  /** Paths listed as LFS files (`lfs.sha256`); the others are plain git blobs. */
  lfs?: string[];
  /**
   * Sizes the API lists instead of the bytes' own (the README screenshots: a header served, a 17 GB file listed).
   * Look-up and range reads only: a download of such a file fails verification.
   */
  listedSizes?: Record<string, number>;
}

export interface FakeHubOptions {
  /** File paths the CDN serves with 200 and the whole body whatever the Range header says. */
  ignoreRange?: string[];
  /** The first N requests answer 503: keyed by file path (resolve) or `revision:<repoId>` (the API). */
  failFirst?: Record<string, number>;
  /** File paths whose CDN bytes differ from the content the API's hashes describe (first byte flipped). */
  corrupt?: string[];
  /** CDN throttle for every file body. */
  slowBytesPerSec?: number;
}

export interface FakeHubRequest { url: string; headers: Record<string, string> }

export interface FakeHub {
  /** The Hub origin, for HF_ENDPOINT. */
  endpoint: string;
  cdnOrigin: string;
  /** Every request either server received, in order (header names lower-case). */
  requests: FakeHubRequest[];
  /** CDN file bodies being sent now, and the most at any one time (download concurrency checks). */
  streams: { open: number; max: number };
  close(): Promise<void>;
}

const API_KIND: Record<HubRepoType, string> = { model: 'models', dataset: 'datasets', space: 'spaces' };
const KIND_TYPE: Record<string, HubRepoType> = { models: 'model', datasets: 'dataset', spaces: 'space' };

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
/** git blob SHA-1: over "blob <size>\0" + content (the Hub's `blobId`). */
export const gitBlobId = (b: Uint8Array): string =>
  createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
export const lfsPointer = (b: Uint8Array): Uint8Array =>
  new TextEncoder().encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${sha256Hex(b)}\nsize ${b.length}\n`);

const typeOf = (r: FakeHubRepo): HubRepoType => r.type ?? 'model';
const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function headersOf(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

function fail(res: http.ServerResponse, status: number, errorCode?: string): void {
  const body = JSON.stringify({ error: errorCode ?? `HTTP ${status}` });
  res.writeHead(status, { 'Content-Type': 'application/json', ...(errorCode ? { 'X-Error-Code': errorCode } : {}) });
  res.end(body);
}

export async function startFakeHub(repos: FakeHubRepo[], opts: FakeHubOptions = {}): Promise<FakeHub> {
  const requests: FakeHubRequest[] = [];
  const streams = { open: 0, max: 0 };
  const failures = new Map(Object.entries(opts.failFirst ?? {}));
  const find = (type: HubRepoType, ns: string | undefined, name: string | undefined): FakeHubRepo | undefined =>
    repos.find((r) => typeOf(r) === type && r.repoId === `${ns}/${name}`);
  const failing = (key: string): boolean => {
    const left = failures.get(key) ?? 0;
    if (left <= 0) return false;
    failures.set(key, left - 1);
    return true;
  };
  let hubOrigin = '';
  let cdnOrigin = '';

  const segmentsOf = (req: http.IncomingMessage): string[] | null => {
    try {
      return new URL(req.url ?? '/', 'http://x').pathname.split('/').slice(1).map(decodeURIComponent);
    } catch {
      return null;
    }
  };

  const hub = http.createServer((req, res) => {
    requests.push({ url: hubOrigin + (req.url ?? ''), headers: headersOf(req) });
    const segs = segmentsOf(req);
    if (!segs || req.method !== 'GET') return fail(res, 400);

    if (segs[0] === 'api') {
      const type = KIND_TYPE[segs[1] ?? ''];
      if (!type || segs[4] !== 'revision') return fail(res, 404);
      const repo = find(type, segs[2], segs[3]);
      if (!repo) return fail(res, 404, 'RepositoryNotFound');
      if (failing(`revision:${repo.repoId}`)) return fail(res, 503);
      const rev = segs.slice(5).join('/');
      if (rev !== 'main' && rev !== repo.commit) return fail(res, 404, 'RevisionNotFound');
      const lfs = new Set(repo.lfs ?? []);
      const siblings = Object.entries(repo.files).map(([rfilename, content]) => {
        const size = repo.listedSizes?.[rfilename] ?? content.length;
        return lfs.has(rfilename)
          ? { rfilename, size, blobId: gitBlobId(lfsPointer(content)),
              lfs: { sha256: sha256Hex(content), size, pointerSize: lfsPointer(content).length } }
          : { rfilename, size, blobId: gitBlobId(content) };
      });
      const body = JSON.stringify({
        id: repo.repoId, sha: repo.commit, private: false, gated: repo.gated ? 'manual' : false,
        lastModified: '2026-10-01T00:00:00.000Z', siblings,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(body);
    }

    const type: HubRepoType = segs[0] === 'datasets' ? 'dataset' : segs[0] === 'spaces' ? 'space' : 'model';
    const at = type === 'model' ? 0 : 1;
    if (segs[at + 2] !== 'resolve') return fail(res, 404);
    const repo = find(type, segs[at], segs[at + 1]);
    if (!repo) return fail(res, 404, 'RepositoryNotFound');
    const rev = segs[at + 3] ?? '';
    const file = segs.slice(at + 4).join('/');
    if (rev !== 'main' && rev !== repo.commit) return fail(res, 404, 'RevisionNotFound');
    if (!Object.hasOwn(repo.files, file)) return fail(res, 404, 'EntryNotFound');
    if (failing(file)) return fail(res, 503);
    if (repo.gated && !req.headers.authorization) return fail(res, 401, 'GatedRepo');
    res.writeHead(302, {
      Location: `${cdnOrigin}/cdn/${API_KIND[type]}/${repo.repoId}/${repo.commit}/${encodePath(file)}`,
      'X-Repo-Commit': repo.commit,
    });
    res.end();
  });

  const cdn = http.createServer((req, res) => {
    requests.push({ url: cdnOrigin + (req.url ?? ''), headers: headersOf(req) });
    const segs = segmentsOf(req);
    if (!segs || req.method !== 'GET' || segs[0] !== 'cdn') return fail(res, 400);
    const type = KIND_TYPE[segs[1] ?? ''];
    const repo = type ? find(type, segs[2], segs[3]) : undefined;
    const file = segs.slice(5).join('/');
    if (!repo || segs[4] !== repo.commit || !Object.hasOwn(repo.files, file)) return fail(res, 404);
    let content = repo.files[file]!;
    if (opts.corrupt?.includes(file)) {
      content = content.length === 0 ? new Uint8Array([0]) : Uint8Array.from(content);
      content[0] = content[0]! ^ 0xff;
    }
    const total = content.length;
    streams.open += 1;
    streams.max = Math.max(streams.max, streams.open);
    res.once('close', () => { streams.open -= 1; });
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    let body = content;
    if (m && !opts.ignoreRange?.includes(file)) {
      const start = Number(m[1]);
      const end = Math.min(m[2] ? Number(m[2]) : total - 1, total - 1);
      if (start >= total || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return void res.end();
      }
      body = content.subarray(start, end + 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(body.length),
        'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' });
    } else {
      res.writeHead(200, { 'Content-Length': String(total), 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' });
    }
    const rate = opts.slowBytesPerSec;
    if (!rate) return void res.end(body);
    const step = Math.max(1, Math.floor(rate / 10));
    let pos = 0;
    const tick = (): void => {
      if (res.destroyed) return;
      const part = body.subarray(pos, pos + step);
      pos += step;
      if (pos >= body.length) return void res.end(part);   // the last bytes end the response (stream counts stay exact)
      res.write(part);
      setTimeout(tick, 100);
    };
    tick();
  });

  hubOrigin = await listen(hub);
  try {
    cdnOrigin = await listen(cdn);
  } catch (e) {
    await closeServer(hub);
    throw e;
  }
  return {
    endpoint: hubOrigin,
    cdnOrigin,
    requests,
    streams,
    close: async () => {
      await Promise.all([closeServer(hub), closeServer(cdn)]);
    },
  };
}
