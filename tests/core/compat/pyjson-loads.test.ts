import { beforeEach, describe, it, expect } from 'vitest';
import { useCanaries } from '../../helpers/canary';
import { pyLoads, pyDumpsCompact, PyFloat, PyJsonError, isPyMap } from '../../../src/core/compat/pyjson';
useCanaries();
beforeEach(() => expect.hasAssertions());

describe('pyLoads', () => {
  it('keeps integer-like key order', () => {
    const v = pyLoads('{"b":1,"0":2,"a":{"10":3,"2":4}}');
    expect(pyDumpsCompact(v)).toBe('{"b":1,"0":2,"a":{"10":3,"2":4}}');
  });
  it('round-trips floats with Python repr', () => {
    expect(pyDumpsCompact(pyLoads('[1.0, 2.50, 1e16, 3, -0.0, NaN]'))).toBe('[1.0,2.5,1e+16,3,-0.0,NaN]');
  });
  it('keeps big ints exact', () => {
    expect(pyDumpsCompact(pyLoads('18446744073709551617'))).toBe('18446744073709551617');
    expect(pyLoads('-9007199254740993')).toBe(-9007199254740993n);
    expect(pyLoads('9007199254740991')).toBe(9007199254740991);
  });
  it('reads -0 as the integer 0', () => expect(Object.is(pyLoads('-0'), 0)).toBe(true));
  it('duplicate key: first position, last value', () =>
    expect(pyDumpsCompact(pyLoads('{"a":1,"b":2,"a":3}'))).toBe('{"a":3,"b":2}'));
  it('decodes escapes and surrogate pairs', () => {
    expect(pyLoads('"\\u00e9\\ud83d\\ude00\\n"')).toBe('é😀\n');
    expect(pyLoads('"\\"\\\\\\/\\b\\f\\r\\t"')).toBe('"\\/\b\f\r\t');
  });
  it('accepts a lone surrogate escape like Python', () => expect(pyLoads('"\\ud800"')).toBe('\ud800'));
  it('reads NaN, Infinity and -Infinity as PyFloat', () => {
    expect(pyLoads('Infinity')).toEqual(new PyFloat(Infinity));
    expect(pyLoads('-Infinity')).toEqual(new PyFloat(-Infinity));
    expect(pyLoads('1e999')).toEqual(new PyFloat(Infinity));
    expect(pyLoads('NaN')).toBeInstanceOf(PyFloat);
  });
  it('reads literals, whitespace and empty containers', () => {
    expect(pyLoads(' \t\r\n[null, true, false, {}, []]\n')).toEqual([null, true, false, new Map(), []]);
  });
  it('is safe with __proto__ keys and exposes isPyMap', () => {
    const v = pyLoads('{"__proto__":1}');
    expect(isPyMap(v)).toBe(true);
    expect(isPyMap({})).toBe(false);
    expect((v as Map<string, unknown>).get('__proto__')).toBe(1);
  });
  it('rejects excessive nesting', () => expect(() => pyLoads('['.repeat(1000))).toThrow(PyJsonError));
  it.each([
    '', '{', '{"a":}', '[1,]', "{'a':1}", '01', '"\u0001"', '1 2', '[', '{"a" 1}', '{"a":1,}', '{1:2}', '[1 2]', '{"a":1 "b":2}',
    '"abc', '"\\x"', '"\\u12"', '"\\u12G4"', '"\\', '-', '1.', '.5', '1e', '+1', '-NaN', 'nul', 'True', '\ufeff1', '\u00a01',
  ])('rejects %j', (t) => expect(() => pyLoads(t)).toThrow(PyJsonError));
});
