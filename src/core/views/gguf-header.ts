// GGUF header reader (hfhub/gguf_header.py). Reads the KV metadata and tensor infos only, never tensor data.
// Reads are buffered in chunks (a 150k-token vocabulary is not 150k awaits), and the bytes read are bounded
// (MAX_HEADER_BYTES), so a corrupt count cannot make the reader allocate or scan without limit.
export { fileReadAt } from '../fsx';

export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

export interface GgufHeader { version: number; nTensors: bigint; kv: Map<string, unknown>; paramCount: number }

const CHUNK = 1 << 20;
/** No real header is anywhere near this; beyond it the file is treated as truncated. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
/** Items kept per array, whatever the caller asks for (real vocabularies are a few hundred thousand). */
const MAX_KEPT_ITEMS = 4_000_000;
/** GGML_MAX_DIMS is 4; 8 is generous. */
const MAX_NDIM = 8;
const BAD = 'bad GGUF header';
const MAX_DEPTH = 32;
const STRING = 8;
const ARRAY = 9;

const TRUNCATED = 'truncated GGUF header';

/** Scalar value types: byte size and reader (hfhub/gguf_header.py `_SCALAR`). */
const SCALAR: Readonly<Record<number, { size: number; read: (v: DataView) => unknown }>> = {
  0: { size: 1, read: (v) => v.getUint8(0) },
  1: { size: 1, read: (v) => v.getInt8(0) },
  2: { size: 2, read: (v) => v.getUint16(0, true) },
  3: { size: 2, read: (v) => v.getInt16(0, true) },
  4: { size: 4, read: (v) => v.getUint32(0, true) },
  5: { size: 4, read: (v) => v.getInt32(0, true) },
  6: { size: 4, read: (v) => v.getFloat32(0, true) },
  7: { size: 1, read: (v) => v.getUint8(0) !== 0 },
  10: { size: 8, read: (v) => safe(v.getBigUint64(0, true)) },
  11: { size: 8, read: (v) => safe(v.getBigInt64(0, true)) },
  12: { size: 8, read: (v) => v.getFloat64(0, true) },
};

/** A scalar 64-bit integer as a number when that is exact, else the bigint. */
const safe = (n: bigint): number | bigint => (n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n);

const LIMIT = BigInt(Number.MAX_SAFE_INTEGER);

const utf8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });   // Python decode('utf-8', 'replace') keeps a BOM

class Reader {
  private pos = 0;
  private buf: Uint8Array = new Uint8Array(0);
  private bufStart = 0;

  readonly maxArrayItems: number;

  constructor(private readonly readAt: ReadAt, maxArrayItems: number) {
    this.maxArrayItems = Math.min(maxArrayItems, MAX_KEPT_ITEMS);
  }

  /** The next n bytes (n is bounded and checked against the end of file). */
  async take(n: number): Promise<Uint8Array> {
    if (n === 0) return new Uint8Array(0);
    if (this.pos + n > MAX_HEADER_BYTES) throw new Error(TRUNCATED);
    const off = this.pos - this.bufStart;
    if (off >= 0 && off + n <= this.buf.length) {
      this.pos += n;
      return this.buf.subarray(off, off + n);
    }
    const want = Math.min(Math.max(n, CHUNK), MAX_HEADER_BYTES - this.pos);
    const got = await this.readAt(this.pos, want);
    if (got.length < n) throw new Error(TRUNCATED);
    this.buf = got;
    this.bufStart = this.pos;
    this.pos += n;
    return got.subarray(0, n);
  }

  /** Advances over n bytes without keeping them; the last byte must exist. */
  async skip(n: bigint): Promise<void> {
    if (n === 0n) return;
    if (n > BigInt(MAX_HEADER_BYTES - this.pos)) throw new Error(TRUNCATED);
    const count = Number(n);
    const off = this.pos - this.bufStart;
    if (!(off >= 0 && off + count <= this.buf.length)) {
      if ((await this.readAt(this.pos + count - 1, 1)).length < 1) throw new Error(TRUNCATED);
      this.buf = new Uint8Array(0);
    }
    this.pos += count;
  }

  async view(n: number): Promise<DataView> {
    const b = await this.take(n);
    return new DataView(b.buffer, b.byteOffset, n);
  }

  async u32(): Promise<number> { return (await this.view(4)).getUint32(0, true); }
  async u64(): Promise<bigint> { return (await this.view(8)).getBigUint64(0, true); }

  private async stringLength(): Promise<number> {
    const n = await this.u64();
    if (n > BigInt(MAX_HEADER_BYTES)) throw new Error(TRUNCATED);
    return Number(n);
  }

  async string(): Promise<string> {
    return utf8.decode(await this.take(await this.stringLength()));
  }

  async skipString(): Promise<void> {
    await this.skip(await this.u64());
  }

  async value(type: number, depth: number): Promise<unknown> {
    if (type === STRING) return this.string();
    if (type === ARRAY) {
      if (depth >= MAX_DEPTH) throw new Error('GGUF array nesting too deep');
      const et = await this.u32();
      const n = await this.u64();
      const keep = n < BigInt(this.maxArrayItems) ? Number(n) : this.maxArrayItems;
      const items: unknown[] = [];
      for (let i = 0; i < keep; i++) items.push(await this.value(et, depth + 1));
      await this.discard(et, n - BigInt(keep), depth + 1);
      return items;
    }
    const sc = SCALAR[type];
    if (sc === undefined) throw new Error(`unknown GGUF value type ${type}`);
    return sc.read(await this.view(sc.size));
  }

  /** Reads and drops `count` values of `type`. Fixed-size scalars are skipped arithmetically. */
  private async discard(type: number, count: bigint, depth: number): Promise<void> {
    if (count === 0n) return;
    const sc = SCALAR[type];
    if (sc !== undefined) return this.skip(count * BigInt(sc.size));
    if (type === STRING) {
      for (let i = 0n; i < count; i++) await this.skipString();
      return;
    }
    if (type !== ARRAY) throw new Error(`unknown GGUF value type ${type}`);
    if (depth >= MAX_DEPTH) throw new Error('GGUF array nesting too deep');
    for (let i = 0n; i < count; i++) {
      const et = await this.u32();
      await this.discard(et, await this.u64(), depth + 1);
    }
  }
}

/** Reads the header through `readAt`. Throws `Error('not a GGUF file')` or `Error('truncated GGUF header')`. */
export async function readGgufHeader(readAt: ReadAt, maxArrayItems = 64): Promise<GgufHeader> {
  const r = new Reader(readAt, maxArrayItems);
  const magic = await r.take(4);
  if (utf8.decode(magic) !== 'GGUF') throw new Error('not a GGUF file');
  const version = await r.u32();
  const nTensors = await r.u64();
  const nKv = await r.u64();
  const kv = new Map<string, unknown>();
  for (let i = 0n; i < nKv; i++) {
    const key = await r.string();
    kv.set(key, await r.value(await r.u32(), 0));
  }
  let params = 0n;
  for (let i = 0n; i < nTensors; i++) {
    await r.skipString();
    const ndim = await r.u32();
    if (ndim > MAX_NDIM) throw new Error(BAD);
    let count = 1n;
    for (let d = 0; d < ndim; d++) {
      count *= await r.u64();
      if (count > LIMIT) throw new Error(BAD);   // saturate: never Infinity, never unbounded BigInt work
    }
    await r.u32();
    await r.u64();
    params += count;
    if (params > LIMIT) throw new Error(BAD);
  }
  return { version, nTensors, kv, paramCount: Number(params) };
}

/** hfhub/gguf_header.py `_FILE_TYPES` (verbatim). */
const FILE_TYPES: ReadonlyMap<number, string> = new Map([
  [0, 'F32'], [1, 'F16'], [2, 'Q4_0'], [3, 'Q4_1'], [7, 'Q8_0'], [8, 'Q5_0'], [9, 'Q5_1'], [10, 'Q2_K'],
  [11, 'Q3_K_S'], [12, 'Q3_K_M'], [13, 'Q3_K_L'], [14, 'Q4_K_S'], [15, 'Q4_K_M'], [16, 'Q5_K_S'],
  [17, 'Q5_K_M'], [18, 'Q6_K'], [19, 'IQ2_XXS'], [20, 'IQ2_XS'], [21, 'Q2_K_S'], [22, 'IQ3_XS'],
  [23, 'IQ3_XXS'], [24, 'IQ1_S'], [25, 'IQ4_NL'], [26, 'IQ3_S'], [27, 'IQ3_M'], [28, 'IQ2_S'],
  [29, 'IQ2_M'], [30, 'IQ4_XS'], [31, 'IQ1_M'], [32, 'BF16'], [36, 'TQ1_0'], [37, 'TQ2_0'],
  [38, 'MXFP4_MOE'],
]);

/** The quantisation name of a `general.file_type` value, "unknown" for anything not in the map. */
export function fileTypeName(n: unknown): string {
  if (typeof n === 'boolean') return n ? 'F16' : 'F32';   // Python: True == 1, False == 0
  const key = typeof n === 'bigint' ? safe(n) : n;
  return typeof key === 'number' ? (FILE_TYPES.get(key) ?? 'unknown') : 'unknown';
}

/** Python `f"{x:.1f}"`: exact decimal expansion, ties (only x.25 / x.75 are exact ties) to even. */
function fixed1(x: number): string {
  const q = x * 4;
  if (Number.isInteger(q) && q % 2 !== 0) {
    const lo = Math.floor(x * 10);
    return ((lo % 2 === 0 ? lo : lo + 1) / 10).toFixed(1);
  }
  return x.toFixed(1);
}

/** "27.0B" from 1e9 parameters up, else "1.0M" (hfhub/gguf_header.py `size_label`). */
export function sizeLabel(params: number): string {
  return params >= 1_000_000_000 ? `${fixed1(params / 1e9)}B` : `${fixed1(params / 1e6)}M`;
}
