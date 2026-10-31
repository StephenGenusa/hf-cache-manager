import { beforeEach, describe, it, expect } from 'vitest';
import { useCanaries } from '../../helpers/canary';
import {
  pyDumpsIndent1,
  pyDumpsCompact,
  pyDumpsDefault,
  PyFloat,
  PyJsonError,
  pySort,
  pyQuote,
  pyTruthy,
  pyLoads,
  localIsoSeconds,
  type PyJson,
} from '../../../src/core/compat/pyjson';
useCanaries();
beforeEach(() => expect.hasAssertions());

describe('pyDumpsIndent1', () => {
  it('formats a state payload exactly like json.dumps(indent=1)', () => {
    const v = new Map<string, PyJson>([
      ['version', 1],
      ['owned', new Map<string, PyJson>([['a/b:x.gguf', new Map<string, PyJson>([['paths', ['a/b/x.gguf', 'a/b/y.gguf']], ['sha256', 'ab']])]])],
      ['tombstones', new Map<string, PyJson>([['k', '2026-10-25T14:03:07']])],
    ]);
    expect(pyDumpsIndent1(v)).toBe(
      '{\n "version": 1,\n "owned": {\n  "a/b:x.gguf": {\n   "paths": [\n    "a/b/x.gguf",\n    "a/b/y.gguf"\n   ],\n   "sha256": "ab"\n  }\n },\n "tombstones": {\n  "k": "2026-10-25T14:03:07"\n }\n}');
  });
  it('writes empty containers inline and no trailing newline', () => {
    expect(pyDumpsIndent1({})).toBe('{}');
    expect(pyDumpsIndent1([])).toBe('[]');
    expect(pyDumpsIndent1({ version: 1, owned: {}, tombstones: {} })).toBe('{\n "version": 1,\n "owned": {},\n "tombstones": {}\n}');
    expect(pyDumpsIndent1([[1, 2], []])).toBe('[\n [\n  1,\n  2\n ],\n []\n]');
  });
});

describe('ensure_ascii escaping (all modes)', () => {
  it.each([
    ['é', '"\\u00e9"'], ['😀', '"\\ud83d\\ude00"'], ['\u007f', '"\\u007f"'], ['\u0001', '"\\u0001"'],
    ['a"b\\c', '"a\\"b\\\\c"'], ['\n\r\t\b\f', '"\\n\\r\\t\\b\\f"'], ['/', '"/"'], ['\ud800', '"\\ud800"'], ['~', '"~"'],
  ])('%j -> %s', (s, out) => {
    expect(pyDumpsCompact(s)).toBe(out);
    expect(pyDumpsIndent1(s)).toBe(out);
  });
  it('escapes keys too', () => expect(pyDumpsCompact({ 'ü': 1 })).toBe('{"\\u00fc":1}'));
});

describe('separators', () => {
  it('compact', () => expect(pyDumpsCompact({ a: [1, { b: null }], c: true, d: false })).toBe('{"a":[1,{"b":null}],"c":true,"d":false}'));
  it('default', () => expect(pyDumpsDefault({ missing: true })).toBe('{"missing": true}'));
  it('default nested', () => expect(pyDumpsDefault({ a: [1, 2], b: { c: null } })).toBe('{"a": [1, 2], "b": {"c": null}}'));
});

describe('numbers', () => {
  it('ints and bigints', () => expect(pyDumpsCompact([0, -0, 42, 2n ** 64n])).toBe('[0,0,42,18446744073709551616]'));
  it.each([
    [1, '1.0'], [0.5, '0.5'], [1e16, '1e+16'], [1e15, '1000000000000000.0'], [1e-5, '1e-05'], [0.0001, '0.0001'],
    [1.5e300, '1.5e+300'], [-0, '-0.0'], [0.1 + 0.2, '0.30000000000000004'], [123456789012345680, '1.2345678901234568e+17'],
    [NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity'],
  ])('PyFloat(%s) -> %s', (n, out) => expect(pyDumpsCompact(new PyFloat(n))).toBe(out));
  it('rejects a non-integer plain number', () => expect(() => pyDumpsCompact(1.5)).toThrow(PyJsonError));
  it('rejects undefined', () => expect(() => pyDumpsCompact({ a: undefined } as unknown as PyJson)).toThrow(PyJsonError));
});

it('pyDumps rejects integer-like keys in plain objects', () => {
  expect(() => pyDumpsCompact({ b: 1, '0': 2 })).toThrow(PyJsonError);
  expect(pyDumpsCompact(new Map<string, PyJson>([['b', 1], ['0', 2]]))).toBe('{"b":1,"0":2}');
});

it('pySort orders by code point', () => {
  expect(pySort(['😀', '｡', 'B', 'a', 'a-c', 'a/b'])).toEqual(['B', 'a', 'a-c', 'a/b', '｡', '😀']);
});

it.each([
  ['a/b c!.gguf', 'a%2Fb%20c%21.gguf'], ["x'()*~_.-", 'x%27%28%29%2A~_.-'], ['é', '%C3%A9'], ['Q4_K_M.gguf', 'Q4_K_M.gguf'],
])('pyQuote(%j) = %s', (s, out) => expect(pyQuote(s)).toBe(out));

it('localIsoSeconds is naive local time to the second', () => {
  expect(localIsoSeconds(new Date(2026, 9, 25, 14, 3, 7, 999))).toBe('2026-10-25T14:03:07');
});

describe('edge cases', () => {
  it('rejects unsafe-integer plain numbers', () => {
    expect(() => pyDumpsCompact(1e21)).toThrow(PyJsonError);
    expect(() => pyDumpsCompact(2 ** 60)).toThrow(PyJsonError);
    expect(pyDumpsCompact(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(pyDumpsCompact(2n ** 60n)).toBe('1152921504606846976');
  });
  it('rejects non-plain objects', () => {
    class Foo {}
    for (const v of [new Date(0), new Set<string>(), new Foo()]) {
      expect(() => pyDumpsCompact(v as unknown as PyJson)).toThrow(PyJsonError);
    }
    expect(pyDumpsCompact(Object.assign(Object.create(null) as { [k: string]: PyJson }, { a: 1 }))).toBe('{"a":1}');
  });
  it('pyQuote rejects lone surrogates', () => {
    expect(() => pyQuote('a\ud800')).toThrow(PyJsonError);
    expect(() => pyQuote('\udc00a')).toThrow(PyJsonError);
    expect(pyQuote('😀')).toBe('%F0%9F%98%80');
  });
});

describe('pyTruthy (Python bool())', () => {
  it('matches Python for every pyLoads value kind', () => {
    for (const falsy of ['null', 'false', '0', '0.0', '-0.0', '0e5', '""', '[]', '{}']) expect(pyTruthy(pyLoads(falsy)), falsy).toBe(false);
    for (const truthy of ['true', '1', '-1', '0.5', 'NaN', 'Infinity', '"0"', '" "', '[0]', '{"a": 0}', '12345678901234567890']) expect(pyTruthy(pyLoads(truthy)), truthy).toBe(true);
    expect(pyTruthy(0n)).toBe(false);
    expect(pyTruthy({})).toBe(false);
    expect(pyTruthy({ a: 1 })).toBe(true);
  });
});
