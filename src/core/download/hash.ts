import { createHash } from 'node:crypto';

/** Incremental content hash of a download, computed the way the Hub names the file's etag. */
export interface ContentHasher {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

interface HashedFile {
  size: number;
  etag: string;
  lfs: boolean;
}

/** LFS files: SHA-256 of the content. Others: git blob id, SHA-1 over "blob <size>\0" + content. */
export function hasherFor(file: HashedFile): ContentHasher {
  const h = file.lfs ? createHash('sha256') : createHash('sha1').update(`blob ${file.size}\0`);
  return {
    update: (chunk) => void h.update(chunk),
    digestHex: () => h.copy().digest('hex'),
  };
}

export function matches(file: HashedFile, digest: string): boolean {
  return file.etag !== '' && file.etag.toLowerCase() === digest.toLowerCase();
}
