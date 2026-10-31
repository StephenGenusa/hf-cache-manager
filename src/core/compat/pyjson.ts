/**
 * Python-exact JSON writer (json.dumps with ensure_ascii), plus the Python
 * ordering / quoting / timestamp helpers the CLI-compatible files depend on.
 */

/** A Python float: always written with a decimal point or exponent, even when integral. */
export class PyFloat {
  constructor(readonly value: number) {}
}

export type PyJson = null | boolean | number | bigint | string | PyFloat | PyJson[] | Map<string, PyJson> | { [k: string]: PyJson };

export class PyJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PyJsonError';
  }
}

export interface PyDumpsOptions {
  indent?: number;
  itemSep: string;
  keySep: string;
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

function escapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) {
      out += short;
      continue;
    }
    const c = s.charCodeAt(i);
    out += c >= 0x20 && c <= 0x7e ? ch : `\\u${c.toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
}

function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [m, e] = Math.abs(x).toExponential().split('e') as [string, string];
  const digits = m.replace('.', '');
  const exp = Number(e);
  const decpt = exp + 1;
  if (decpt > 16 || decpt <= -4) {
    const frac = digits.slice(1);
    return `${sign}${digits[0]}${frac ? '.' + frac : ''}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

const INTEGER_LIKE = /^(0|[1-9]\d*)$/;

function entriesOf(o: { [k: string]: PyJson }): [string, PyJson][] {
  const keys = Object.keys(o);
  for (const k of keys) {
    if (INTEGER_LIKE.test(k) && Number(k) < 2 ** 32) {
      throw new PyJsonError(`integer-like key ${JSON.stringify(k)} in a plain object would be reordered; use a Map`);
    }
  }
  return keys.map((k) => [k, o[k] as PyJson]);
}

function isPlainObject(o: object): boolean {
  const proto: unknown = Object.getPrototypeOf(o);
  return proto === Object.prototype || proto === null;
}

function dump(v: PyJson, opts: PyDumpsOptions, depth: number): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return escapeString(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new PyJsonError(`number ${v} is not a safe integer; use bigint or PyFloat`);
    return String(v);
  }
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  if (Array.isArray(v)) return wrap('[', ']', v.map((x) => dump(x, opts, depth + 1)), opts, depth);
  let entries: [string, PyJson][];
  if (v instanceof Map) entries = [...v.entries()];
  else if (typeof v === 'object' && isPlainObject(v)) entries = entriesOf(v);
  else throw new PyJsonError(`unsupported value of type ${typeof v}`);
  return wrap('{', '}', entries.map(([k, x]) => escapeString(k) + opts.keySep + dump(x, opts, depth + 1)), opts, depth);
}

function wrap(open: string, close: string, items: string[], opts: PyDumpsOptions, depth: number): string {
  if (items.length === 0) return open + close;
  if (opts.indent === undefined) return open + items.join(opts.itemSep) + close;
  const inner = ' '.repeat(opts.indent * (depth + 1));
  const outer = ' '.repeat(opts.indent * depth);
  return `${open}\n${inner}${items.join(`${opts.itemSep}\n${inner}`)}\n${outer}${close}`;
}

export function pyDumps(v: PyJson, opts: PyDumpsOptions): string {
  return dump(v, opts, 0);
}

export const pyDumpsIndent1 = (v: PyJson): string => pyDumps(v, { indent: 1, itemSep: ',', keySep: ': ' });
export const pyDumpsCompact = (v: PyJson): string => pyDumps(v, { itemSep: ',', keySep: ':' });
export const pyDumpsDefault = (v: PyJson): string => pyDumps(v, { itemSep: ', ', keySep: ': ' });

/** Unicode code point order, i.e. Python `str` comparison. */
export function pyCompare(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const d = (ca[i] as string).codePointAt(0)! - (cb[i] as string).codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return ca.length === cb.length ? 0 : ca.length < cb.length ? -1 : 1;
}

export function pySort(xs: Iterable<string>): string[] {
  return [...xs].sort(pyCompare);
}

/** `urllib.parse.quote(s, safe="")`. */
export function pyQuote(s: string): string {
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)) {
    throw new PyJsonError('cannot quote a string with a lone surrogate');
  }
  let out = '';
  for (const b of new TextEncoder().encode(s)) {
    const safe =
      (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x5f || b === 0x2e || b === 0x2d || b === 0x7e;
    out += safe ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** `datetime.now().isoformat(timespec="seconds")`: naive local time. */
export function localIsoSeconds(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const isPyMap = (v: unknown): v is Map<string, PyJson> => v instanceof Map;

const MAX_DEPTH = 500;
const NUMBER_RE = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class Reader {
  pos = 0;
  constructor(readonly s: string) {}

  fail(msg: string): never {
    throw new PyJsonError(`${msg} at position ${this.pos}`);
  }

  ws(): void {
    for (;;) {
      const c = this.s[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.pos++;
      else return;
    }
  }

  literal(word: string): boolean {
    if (!this.s.startsWith(word, this.pos)) return false;
    this.pos += word.length;
    return true;
  }

  value(depth: number): PyJson {
    if (depth > MAX_DEPTH) this.fail('nesting too deep');
    const c = this.s[this.pos];
    if (c === '"') return this.string();
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (this.literal('null')) return null;
    if (this.literal('true')) return true;
    if (this.literal('false')) return false;
    if (this.literal('NaN')) return new PyFloat(NaN);
    if (this.literal('Infinity')) return new PyFloat(Infinity);
    if (this.literal('-Infinity')) return new PyFloat(-Infinity);
    return this.number();
  }

  number(): PyJson {
    NUMBER_RE.lastIndex = this.pos;
    const m = NUMBER_RE.exec(this.s);
    if (!m) return this.fail('expecting value');
    this.pos += m[0].length;
    if (m[1] !== undefined || m[2] !== undefined) return new PyFloat(Number(m[0]));
    const n = Number(m[0]);
    if (Number.isSafeInteger(n)) return n === 0 ? 0 : n; // "-0" is the int 0
    return BigInt(m[0]);
  }

  string(): string {
    this.pos++; // opening quote
    let out = '';
    for (;;) {
      const start = this.pos;
      while (this.pos < this.s.length) {
        const c = this.s.charCodeAt(this.pos);
        if (c === 0x22 || c === 0x5c || c < 0x20) break;
        this.pos++;
      }
      out += this.s.slice(start, this.pos);
      if (this.pos >= this.s.length) this.fail('unterminated string');
      const ch = this.s[this.pos]!;
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch !== '\\') this.fail('invalid control character in string');
      const e = this.s[this.pos + 1];
      if (e === 'u') {
        const hex = this.s.slice(this.pos + 2, this.pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 6;
      } else if (e !== undefined && Object.hasOwn(ESCAPES, e)) {
        out += ESCAPES[e];
        this.pos += 2;
      } else {
        this.pos++;
        this.fail('invalid escape');
      }
    }
  }

  array(depth: number): PyJson[] {
    this.pos++;
    const out: PyJson[] = [];
    this.ws();
    if (this.s[this.pos] === ']') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value(depth + 1));
      this.ws();
      const c = this.s[this.pos++];
      if (c === ']') return out;
      if (c !== ',') {
        this.pos--;
        this.fail("expecting ',' or ']'");
      }
    }
  }

  object(depth: number): Map<string, PyJson> {
    this.pos++;
    const out = new Map<string, PyJson>();
    this.ws();
    if (this.s[this.pos] === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.pos] !== '"') this.fail('expecting property name');
      const key = this.string();
      this.ws();
      if (this.s[this.pos] !== ':') this.fail("expecting ':'");
      this.pos++;
      this.ws();
      out.set(key, this.value(depth + 1)); // Map.set keeps the first position on a duplicate
      this.ws();
      const c = this.s[this.pos++];
      if (c === '}') return out;
      if (c !== ',') {
        this.pos--;
        this.fail("expecting ',' or '}'");
      }
    }
  }
}

/** Python `json.loads`: objects become order-preserving Maps, ints stay exact, floats become PyFloat. */
export function pyLoads(text: string): PyJson {
  const r = new Reader(text);
  r.ws();
  const v = r.value(0);
  r.ws();
  if (r.pos !== text.length) r.fail('extra data');
  return v;
}

/** Python `bool(v)` for a value `pyLoads` can produce: None, False, 0, 0.0, -0.0, '', [] and {} are falsy (NaN is truthy). */
export function pyTruthy(v: PyJson): boolean {
  if (v === null || typeof v === 'boolean') return v === true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof PyFloat) return v.value !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return Object.keys(v).length > 0;
}
