import { describe, expect, it } from 'vitest';
import { canonicalJson, fingerprintPlan, hashCanonical } from '../../../src/core/plan/fingerprint';
import type { Op } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { samplePlan } from './sample';

useCanaries();

describe('canonical json', () => {
  it('sorts keys and drops undefined', () =>
    expect(canonicalJson({ b: 1, x: undefined, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}'));
  it('hashCanonical vectors', () => {
    expect(hashCanonical({ b: 1, a: [{ d: 2, c: null }] })).toBe('431902ba5227bb2011b8449c648f4c0be84f30211b59bc2da7acb8491f9999e4');
    expect(hashCanonical({ a: [{ c: null, d: 2 }], b: 'é' })).toBe('ba3d8e5d5e5e651cd24c11623f9d3ddeb4e09fa9e3b768e57c45038b99cb4015');
  });
  it('throws on NaN and Infinity', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson([Infinity])).toThrow();
  });
  it('fingerprint ignores id and fingerprint but changes with any op field', () => {
    const p = samplePlan();
    expect(fingerprintPlan({ ...p, id: 'other', fingerprint: 'zz' })).toBe(fingerprintPlan(p));
    expect(fingerprintPlan({ ...p, ops: [{ ...p.ops[0], path: (p.ops[0] as { path: string }).path + 'x' } as Op] })).not.toBe(fingerprintPlan(p));
  });
});
