import { createHash } from 'node:crypto';
import { lutimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { currentCanaries, useCanaries } from './canary';
import { guardedFs } from './guarded-fs';
import { isUnderTmp, makeTempRoot, removeTempRoot } from './tmp';

useCanaries();

export type RepoType = 'model' | 'dataset' | 'space';
type Content = number | string;

export function hex(seed: string | number): string {
  return createHash('sha256').update(String(seed)).digest('hex');
}

export function folderName(id: string, type: RepoType = 'model'): string {
  return `${type}s--${id.split('/').join('--')}`;
}

export interface RepoBuilder {
  folder: string;
  blob(etag: string, content: Content): Promise<string>;
  link(commit: string, relpath: string, etag: string): Promise<string>;
  file(commit: string, relpath: string, content: Content): Promise<string>;
  files(commit: string, entries: Record<string, Content>): Promise<Record<string, string>>;
  plain(commit: string, relpath: string, content: Content): Promise<string>;
  main(commit: string): Promise<void>;
  storeLink(etag: string, hash: string): Promise<string>;
  incomplete(etag: string, content: Content): Promise<string>;
}

export interface HubBuilder {
  root: string;
  hub: string;
  repo(id: string, type?: RepoType): RepoBuilder;
  marker(text?: string): Promise<void>;
  store(hash: string, content: Content, refs: string[] | null): Promise<string>;
  symlink(target: string, at: string): Promise<void>;
  hardlink(existing: string, at: string): Promise<void>;
  touch(p: string, mtimeMs: number): Promise<void>;
}

const body = (c: Content): string => (typeof c === 'number' ? 'x'.repeat(c) : c);

export async function hubBuilder(): Promise<HubBuilder> {
  const canaries = currentCanaries();
  if (!canaries) throw new Error('hubBuilder requires a running test (useCanaries hooks)');
  const root = await makeTempRoot('hfcm-fx-');
  canaries.onCleanup(() => removeTempRoot(root));
  const fs = guardedFs();
  const hub = join(root, 'hub');
  await fs.mkdir(hub, { recursive: true });

  const put = async (p: string, data: string): Promise<string> => {
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return p;
  };
  const sym = async (target: string, at: string): Promise<void> => {
    await fs.mkdir(dirname(at), { recursive: true });
    await fs.symlink(target, at);
  };

  return {
    root,
    hub,
    repo(id, type = 'model') {
      const folder = join(hub, folderName(id, type));
      const snap = (commit: string, rel: string): string => join(folder, 'snapshots', commit, ...rel.split('/'));
      const rb: RepoBuilder = {
        folder,
        blob: (etag, content) => put(join(folder, 'blobs', etag), body(content)),
        async link(commit, relpath, etag) {
          const at = snap(commit, relpath);
          await sym('../'.repeat(1 + relpath.split('/').length) + 'blobs/' + etag, at);
          return at;
        },
        async file(commit, relpath, content) {
          const etag = hex(`${folder}:${relpath}:${content}`);
          await rb.blob(etag, content);
          await rb.link(commit, relpath, etag);
          return etag;
        },
        async files(commit, entries) {
          const out: Record<string, string> = {};
          for (const [rel, c] of Object.entries(entries)) out[rel] = await rb.file(commit, rel, c);
          return out;
        },
        plain: (commit, relpath, content) => put(snap(commit, relpath), body(content)),
        async main(commit) {
          await put(join(folder, 'refs', 'main'), `${commit}\n`);
        },
        async storeLink(etag, hash) {
          const at = join(folder, 'blobs', etag);
          await sym(`../../blobs/${hash.slice(0, 2)}/${hash}`, at);
          return at;
        },
        incomplete: (etag, content) => put(join(folder, 'blobs', `${etag}.incomplete`), body(content)),
      };
      return rb;
    },
    async marker(text = '1\n') {
      await put(join(hub, 'blobs', '.huggingface-shared-blobs'), text);
    },
    async store(hash, content, refs) {
      const payload = join(hub, 'blobs', hash.slice(0, 2), hash);
      await put(payload, body(content));
      if (refs !== null) await put(payload + '.refs', refs.map((r) => r + '\n').join(''));
      return payload;
    },
    symlink: sym,
    async hardlink(existing, at) {
      await fs.mkdir(dirname(at), { recursive: true });
      await fs.link(existing, at);
    },
    async touch(p, mtimeMs) {
      if (!isUnderTmp(p)) throw new Error(`touch refuses ${p}: outside tmp`);
      await lutimes(p, mtimeMs / 1000, mtimeMs / 1000);
    },
  };
}
