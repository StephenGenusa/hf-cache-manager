import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { hasherFor, matches } from '../../../src/core/download/hash';

const enc = new TextEncoder();
const HELLO_BLOB = 'ce013625030ba8dba906f756967f9e9ca394464a';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('hasherFor', () => {
  test('non-LFS files hash as a git blob (SHA-1 over "blob <size>\\0" + content)', () => {
    const h = hasherFor({ size: 6, etag: HELLO_BLOB, lfs: false });
    h.update(enc.encode('hello\n'));
    expect(h.digestHex()).toBe(HELLO_BLOB);
  });
  test('the git header uses the declared size', () => {
    const h = hasherFor({ size: 7, etag: '', lfs: false });
    h.update(enc.encode('hello\n'));
    expect(h.digestHex()).toBe(createHash('sha1').update('blob 7\0hello\n').digest('hex'));
    expect(h.digestHex()).not.toBe(HELLO_BLOB);
  });
  test('LFS files hash as SHA-256 of the content', () => {
    const h = hasherFor({ size: 3, etag: ABC_SHA256, lfs: true });
    h.update(enc.encode('abc'));
    expect(h.digestHex()).toBe(ABC_SHA256);
  });
  test('empty files: git empty blob and empty SHA-256', () => {
    expect(hasherFor({ size: 0, etag: '', lfs: false }).digestHex()).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(hasherFor({ size: 0, etag: '', lfs: true }).digestHex()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  test('chunked input equals one call, including a resumed hash', () => {
    const data = new Uint8Array(100_000).map((_, i) => (i * 31) % 251);
    for (const lfs of [true, false]) {
      const file = { size: data.length, etag: '', lfs };
      const whole = hasherFor(file);
      whole.update(data);
      const parts = hasherFor(file);
      for (let i = 0; i < data.length; i += 4097) parts.update(data.subarray(i, i + 4097));
      const resumed = hasherFor(file);
      resumed.update(data.subarray(0, 12345)); // the kept .incomplete prefix
      resumed.update(data.subarray(12345)); // the rest, after Range
      expect(parts.digestHex()).toBe(whole.digestHex());
      expect(resumed.digestHex()).toBe(whole.digestHex());
    }
  });
});

describe('matches', () => {
  test('compares the digest with the etag, ignoring case', () => {
    const f = { size: 6, etag: HELLO_BLOB, lfs: false };
    expect(matches(f, HELLO_BLOB)).toBe(true);
    expect(matches(f, HELLO_BLOB.toUpperCase())).toBe(true);
    expect(matches({ ...f, etag: HELLO_BLOB.toUpperCase() }, HELLO_BLOB)).toBe(true);
    expect(matches(f, 'a'.repeat(40))).toBe(false);
    expect(matches({ ...f, etag: '' }, '')).toBe(false);
  });
});
