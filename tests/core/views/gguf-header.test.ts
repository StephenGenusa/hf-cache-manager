import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fileTypeName, fileReadAt, readGgufHeader, sizeLabel, type ReadAt } from '../../../src/core/views/gguf-header';
import { useCanaries } from '../../helpers/canary';
import { tempDir } from '../_temp';
import { ggufBytes } from './_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint | number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string | Buffer): Buffer => { const t = typeof s === 'string' ? Buffer.from(s) : s; return Buffer.concat([u64(t.length), t]); };
const kv = (key: string, type: number, ...payload: Buffer[]): Buffer => Buffer.concat([str(key), u32(type), ...payload]);
/** A GGUF v3 file with the given KV records and tensor infos (name, dims). */
function file(kvs: Buffer[], tensors: Array<number[]> = []): Uint8Array {
  const infos = tensors.map((dims, i) => Buffer.concat([str(`t${i}`), u32(dims.length), ...dims.map((d) => u64(d)), u32(0), u64(0)]));
  return new Uint8Array(Buffer.concat([Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(kvs.length), ...kvs, ...infos]));
}
const over = (bytes: Uint8Array): ReadAt => async (o, n) => bytes.subarray(o, o + n);

describe('readGgufHeader', () => {
  it('reads arch, file type and param count; keeps 64 array items', async () => {
    const bytes = ggufBytes({ arch: 'llama', fileType: 15, tensors: [[1000, 1000], [500]], tokens: 70 });
    const h = await readGgufHeader(over(bytes));
    expect(h.version).toBe(3);
    expect(h.nTensors).toBe(2n);
    expect(h.kv.get('general.architecture')).toBe('llama');
    expect(h.kv.get('general.file_type')).toBe(15);
    const tokens = h.kv.get('tokenizer.ggml.tokens') as unknown[];
    expect(tokens.length).toBe(64);
    expect(tokens[63]).toBe('t63');
    expect(h.paramCount).toBe(1_000_500);
    expect(sizeLabel(h.paramCount)).toBe('1.0M');
    expect(sizeLabel(27_000_000_000)).toBe('27.0B');
  });

  it('honours maxArrayItems and keeps shorter arrays whole', async () => {
    const bytes = ggufBytes({ arch: 'x', fileType: 1, tensors: [], tokens: 5 });
    expect(((await readGgufHeader(over(bytes), 2)).kv.get('tokenizer.ggml.tokens') as unknown[])).toEqual(['t0', 't1']);
    expect(((await readGgufHeader(over(bytes))).kv.get('tokenizer.ggml.tokens') as unknown[])).toHaveLength(5);
  });

  it('decodes every scalar type; 64-bit integers are numbers when safe, bigint otherwise', async () => {
    const i8 = Buffer.from([0xff]);
    const i16 = Buffer.alloc(2); i16.writeInt16LE(-2);
    const i32 = Buffer.alloc(4); i32.writeInt32LE(-3);
    const f32 = Buffer.alloc(4); f32.writeFloatLE(1.5);
    const f64 = Buffer.alloc(8); f64.writeDoubleLE(2.25);
    const i64 = Buffer.alloc(8); i64.writeBigInt64LE(-5n);
    const hugeI = Buffer.alloc(8); hugeI.writeBigInt64LE(-(2n ** 62n));
    const u16 = Buffer.alloc(2); u16.writeUInt16LE(65535);
    const h = await readGgufHeader(over(file([
      kv('u8', 0, Buffer.from([200])), kv('i8', 1, i8), kv('u16', 2, u16), kv('i16', 3, i16), kv('u32', 4, u32(4_000_000_000)),
      kv('i32', 5, i32), kv('f32', 6, f32), kv('t', 7, Buffer.from([1])), kv('f', 7, Buffer.from([0])), kv('u64', 10, u64(7)),
      kv('bigU', 10, u64(2n ** 63n)), kv('i64', 11, i64), kv('bigI', 11, hugeI), kv('f64', 12, f64),
    ])));
    expect(Object.fromEntries(h.kv)).toEqual({
      u8: 200, i8: -1, u16: 65535, i16: -2, u32: 4_000_000_000, i32: -3, f32: 1.5, t: true, f: false, u64: 7,
      bigU: 2n ** 63n, i64: -5, bigI: -(2n ** 62n), f64: 2.25,
    });
  });

  it('skips the discarded tail of scalar, string and nested arrays and keeps reading', async () => {
    const strs = Buffer.concat([str('a'), str('bb'), str('ccc'), str('dddd')]);
    const nums = Buffer.concat([u32(1), u32(2), u32(3), u32(4)]);
    const inner = (n: number): Buffer => Buffer.concat([u32(4), u64(n), ...Array.from({ length: n }, (_, i) => u32(i))]);
    const bytes = file([
      kv('s', 9, u32(8), u64(4), strs), kv('n', 9, u32(4), u64(4), nums), kv('nested', 9, u32(9), u64(3), inner(2), inner(0), inner(3)),
      kv('after', 8, str('ok')),
    ], [[2, 3]]);
    const h = await readGgufHeader(over(bytes), 1);
    expect(h.kv.get('s')).toEqual(['a']);
    expect(h.kv.get('n')).toEqual([1]);
    expect(h.kv.get('nested')).toEqual([[0]]);
    expect(h.kv.get('after')).toBe('ok');
    expect(h.paramCount).toBe(6);
  });

  it('decodes invalid UTF-8 with replacement characters and keeps a leading BOM', async () => {
    const h = await readGgufHeader(over(file([kv('bad', 8, str(Buffer.from([0x61, 0xff, 0x62]))), kv('bom', 8, str(Buffer.from([0xef, 0xbb, 0xbf, 0x41])))])));
    expect(h.kv.get('bad')).toBe('a�b');
    expect(h.kv.get('bom')).toBe('﻿A');
  });

  it('rejects bad magic and a file shorter than the magic', async () => {
    await expect(readGgufHeader(over(new Uint8Array(Buffer.from('GGML....'))))).rejects.toThrow('not a GGUF file');
    await expect(readGgufHeader(over(new Uint8Array(Buffer.from('GG'))))).rejects.toThrow('truncated GGUF header');
  });

  it('every proper prefix of a valid file is a truncated header', async () => {
    const bytes = ggufBytes({ arch: 'llama', fileType: 15, tensors: [[4, 4]], tokens: 3 });
    for (let n = 4; n < bytes.length; n++) {
      await expect(readGgufHeader(over(bytes.subarray(0, n)))).rejects.toThrow('truncated GGUF header');
    }
    await expect(readGgufHeader(over(bytes))).resolves.toMatchObject({ paramCount: 16 });
  });

  it('bounds what it reads: absurd counts and lengths are truncation, not allocation', async () => {
    const calls: number[] = [];
    const spy: ReadAt = async (o, n) => { calls.push(n); return new Uint8Array(0); };
    await expect(readGgufHeader(spy)).rejects.toThrow('truncated');
    const hugeString = file([kv('k', 8, u64(2n ** 62n))]);
    await expect(readGgufHeader(over(hugeString))).rejects.toThrow('truncated GGUF header');
    const hugeSkip = file([kv('k', 9, u32(4), u64(2n ** 40n))]);
    await expect(readGgufHeader(over(hugeSkip))).rejects.toThrow('truncated GGUF header');
    const justPast = file([kv('k', 9, u32(4), u64(1000))]);
    await expect(readGgufHeader(over(justPast), 4)).rejects.toThrow('truncated GGUF header');
    const neverEnding = file([kv('k', 9, u32(8), u64(2n ** 62n)), kv('z', 8, str('x'))]);
    await expect(readGgufHeader(over(neverEnding))).rejects.toThrow('truncated GGUF header');
    expect(calls).toEqual([1024 * 1024]);   // one bounded first read, nothing sized by the file
  });

  it('reads empty strings and skips an empty discarded string', async () => {
    const h = await readGgufHeader(over(file([kv('', 8, str('')), kv('arr', 9, u32(8), u64(2), str(''), str(''))], [[1]])), 0);
    expect(h.kv.get('')).toBe('');
    expect(h.kv.get('arr')).toEqual([]);
    expect(h.paramCount).toBe(1);
  });

  it('refuses a kept string, a discarded string and a tensor name that run past the byte bound', async () => {
    const big = u64(64 * 1024 * 1024);
    await expect(readGgufHeader(over(file([kv('k', 8, big)])))).rejects.toThrow('truncated GGUF header');
    await expect(readGgufHeader(over(file([kv('k', 9, u32(8), u64(1), u64(2n ** 62n)), kv('z', 8, str('x'))])), 0)).rejects.toThrow('truncated GGUF header');
    const tensor = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(0), u64(2n ** 62n)]);
    await expect(readGgufHeader(over(new Uint8Array(tensor)))).rejects.toThrow('truncated GGUF header');
  });

  it('rejects a hostile tensor ndim and dims that overflow, quickly, never producing Infinity', async () => {
    const t0 = Date.now();
    const manyDims = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(0), str('t'), u32(100_000), Buffer.alloc(100_000 * 8, 0xff), u32(0), u64(0)]);
    await expect(readGgufHeader(over(new Uint8Array(manyDims)))).rejects.toThrow('bad GGUF header');
    const nine = file([], [Array(9).fill(1)]);
    await expect(readGgufHeader(over(nine))).rejects.toThrow('bad GGUF header');
    await expect(readGgufHeader(over(file([], [Array(8).fill(1)])))).resolves.toMatchObject({ paramCount: 1 });
    await expect(readGgufHeader(over(file([], [[2 ** 40, 2 ** 40]])))).rejects.toThrow('bad GGUF header');           // one tensor over 2^53
    await expect(readGgufHeader(over(file([], [[2 ** 52], [2 ** 52]])))).rejects.toThrow('bad GGUF header');         // the total over 2^53
    await expect(readGgufHeader(over(file([], [[Number.MAX_SAFE_INTEGER], [1]])))).rejects.toThrow('bad GGUF header');
    await expect(readGgufHeader(over(file([], [[Number.MAX_SAFE_INTEGER]])))).resolves.toMatchObject({ paramCount: Number.MAX_SAFE_INTEGER });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('caps the items kept per array', async () => {
    const bytes = ggufBytes({ arch: 'x', fileType: 1, tensors: [], tokens: 5 });
    const h = await readGgufHeader(over(bytes), Number.MAX_SAFE_INTEGER);
    expect(h.kv.get('tokenizer.ggml.tokens')).toHaveLength(5);
    const big = file([kv('a', 9, u32(0), u64(5_000_000), Buffer.alloc(5_000_000))]);
    expect((await readGgufHeader(over(big), Number.MAX_SAFE_INTEGER)).kv.get('a')).toHaveLength(4_000_000);
  });

  it('refuses an unknown value type and absurd array nesting', async () => {
    await expect(readGgufHeader(over(file([kv('k', 99)])))).rejects.toThrow('unknown GGUF value type 99');
    await expect(readGgufHeader(over(file([kv('k', 9, u32(99), u64(5))])), 0)).rejects.toThrow('unknown GGUF value type 99');
    // an array of arrays of ... (40 deep): the kept path, then the discard path
    const deep = Buffer.concat([u32(9), ...Array.from({ length: 40 }, () => Buffer.concat([u32(9), u64(1)])), u32(4), u64(0)]);
    await expect(readGgufHeader(over(file([Buffer.concat([str('k'), deep])])))).rejects.toThrow('nesting too deep');
    const deepSkip = Buffer.concat([u32(9), ...Array.from({ length: 40 }, () => Buffer.concat([u32(9), u64(2)]))]);
    await expect(readGgufHeader(over(file([Buffer.concat([str('k'), deepSkip])])), 0)).rejects.toThrow('nesting too deep');
  });

  it('reads a 200k-token vocabulary in a handful of chunked reads, not one read per item', async () => {
    const items = Array.from({ length: 200_000 }, (_, i) => str(`tok${i}`));
    const bytes = file([Buffer.concat([str('tokenizer.ggml.tokens'), u32(9), u32(8), u64(items.length), Buffer.concat(items)]), kv('general.architecture', 8, str('llama'))]);
    let reads = 0;
    const h = await readGgufHeader(async (o, n) => { reads++; return bytes.subarray(o, o + n); });
    expect((h.kv.get('tokenizer.ggml.tokens') as unknown[]).length).toBe(64);
    expect(h.kv.get('general.architecture')).toBe('llama');
    expect(reads).toBeLessThan(10);
  });
});

describe('fileReadAt', () => {
  it('reads positions of a real file read-only, short at EOF, and closes (twice is fine)', async () => {
    const p = path.join(await tempDir(), 'f.bin');
    writeFileSync(p, Buffer.from('0123456789'));
    const r = fileReadAt(p);
    expect(Buffer.from(await r.readAt(2, 3)).toString()).toBe('234');
    expect(Buffer.from(await r.readAt(8, 10)).toString()).toBe('89');
    expect((await r.readAt(20, 4)).length).toBe(0);
    await r.close();
    await r.close();
    await fileReadAt(p).close();
  });

  it('feeds readGgufHeader', async () => {
    const p = path.join(await tempDir(), 'm.gguf');
    writeFileSync(p, ggufBytes({ arch: 'qwen', fileType: 7, tensors: [[3, 3]] }));
    const r = fileReadAt(p);
    expect((await readGgufHeader(r.readAt)).kv.get('general.architecture')).toBe('qwen');
    await r.close();
  });

  it('rejects for a missing file', async () => {
    await expect(fileReadAt(path.join(await tempDir(), 'none')).readAt(0, 1)).rejects.toThrow(/ENOENT/);
  });
});

describe('fileTypeName and sizeLabel', () => {
  it.each([[0, 'F32'], [15, 'Q4_K_M'], [32, 'BF16'], [38, 'MXFP4_MOE'], [4, 'unknown'], [99, 'unknown'], [-1, 'unknown'], [1.5, 'unknown']])(
    'fileTypeName(%j) = %s', (n, name) => { expect(fileTypeName(n)).toBe(name); });
  it('accepts bigint and bool like Python ints, and refuses everything else', () => {
    expect(fileTypeName(15n)).toBe('Q4_K_M');
    expect(fileTypeName(2n ** 70n)).toBe('unknown');
    expect(fileTypeName(true)).toBe('F16');
    expect(fileTypeName(false)).toBe('F32');
    expect([fileTypeName('15'), fileTypeName(null), fileTypeName(undefined)]).toEqual(['unknown', 'unknown', 'unknown']);
  });
  it.each([
    [0, '0.0M'], [1_000_500, '1.0M'], [999_999_999, '1000.0M'], [1_000_000_000, '1.0B'], [27_000_000_000, '27.0B'],
    [250_000, '0.2M'], [750_000, '0.8M'], [2_250_000, '2.2M'], [1_250_000, '1.2M'], [1_350_000, '1.4M'], [7_250_000_000, '7.2B'],
  ])('sizeLabel(%d) = %s (Python .1f rounding)', (n, label) => { expect(sizeLabel(n)).toBe(label); });
});
