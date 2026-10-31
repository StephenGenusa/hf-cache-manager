import { describe, expect, it } from 'vitest';
import { fingerprintPlan } from '../../../src/core/plan/fingerprint';
import { PlanRegistry } from '../../../src/core/plan/registry';
import type { DeletionPlan, Op, PlanPair } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { samplePlan } from './sample';

useCanaries();

function mk(confirmPhrase: string | null = 'o/a', id = 'p1'): DeletionPlan {
  const p = { ...samplePlan(), id, confirmPhrase };
  return { ...p, fingerprint: fingerprintPlan(p) };
}
const code = (c: string) => expect.objectContaining({ name: 'ExecError', code: c });

describe('PlanRegistry', () => {
  it('inv4: take returns the plan once, then USED', () => {
    const r = new PlanRegistry(); const p = mk(); r.put(p);
    expect(r.take(p.id, p.fingerprint, 2000, 'o/a')).toBe(p);
    expect(() => r.take(p.id, p.fingerprint, 2000, 'o/a')).toThrow(code('USED'));
  });
  it('inv4: unknown id -> UNKNOWN_PLAN', () => {
    expect(() => new PlanRegistry().take('nope', 'x', 2000)).toThrow(code('UNKNOWN_PLAN'));
  });
  it('inv4: now >= expiresAt -> EXPIRED', () => {
    const r = new PlanRegistry(); const p = mk(null); r.put(p);
    expect(() => r.take(p.id, p.fingerprint, 601_000)).toThrow(code('EXPIRED'));
    const r2 = new PlanRegistry(); r2.put(p);
    expect(r2.take(p.id, p.fingerprint, 600_999)).toBe(p);
  });
  it('inv4: fingerprint argument mismatch -> FINGERPRINT and plan not consumed', () => {
    const r = new PlanRegistry(); const p = mk(null); r.put(p);
    expect(() => r.take(p.id, 'bad', 2000)).toThrow(code('FINGERPRINT'));
    expect(r.take(p.id, p.fingerprint, 2000)).toBe(p);
  });
  it('inv4: plan content tampered after put -> FINGERPRINT', () => {
    const r = new PlanRegistry(); const p = mk(null); r.put(p);
    (p.ops[0] as Extract<Op, { kind: 'unlink' }>).path += 'x';
    expect(() => r.take(p.id, p.fingerprint, 2000)).toThrow(code('FINGERPRINT'));
  });
  it('inv4: permanent plan needs the exact trimmed phrase; wrong phrase -> CONFIRM and not consumed', () => {
    const r = new PlanRegistry(); const p = mk('o/a'); r.put(p);
    expect(() => r.take(p.id, p.fingerprint, 2000, 'o/b')).toThrow(code('CONFIRM'));
    expect(() => r.take(p.id, p.fingerprint, 2000)).toThrow(code('CONFIRM'));
    expect(r.take(p.id, p.fingerprint, 2000, 'o/a ')).toBe(p);
  });
  it('inv4: hold plan (confirmPhrase null) ignores the phrase', () => {
    const r = new PlanRegistry(); const p = mk(null); r.put(p);
    expect(r.take(p.id, p.fingerprint, 2000, 'whatever')).toBe(p);
  });
  it('put drops entries expired relative to the new plan createdAt', () => {
    const r = new PlanRegistry(); const old = mk(null, 'old'); r.put(old);
    const fresh = { ...mk(null, 'new'), createdAt: 700_000, expiresAt: 1_300_000 };
    r.put(fresh);
    expect(() => r.take('old', old.fingerprint, 2000)).toThrow(code('UNKNOWN_PLAN'));
  });
});

describe('PlanRegistry pairs (a PlanPair is one review: taking either plan uses up both)', () => {
  const pairOf = (): PlanPair => {
    const hold = mk(null, 'h1');
    return { hold: { ...hold, mode: 'hold' as const, fingerprint: fingerprintPlan({ ...hold, mode: 'hold' }) }, holdUnavailableReason: null, permanent: mk('o/a', 'p1') };
  };
  it('take hold, then take permanent of the same pair -> USED', () => {
    const r = new PlanRegistry(); const pair = pairOf(); r.putPair(pair);
    expect(r.take(pair.hold!.id, pair.hold!.fingerprint, 2000)).toBe(pair.hold);
    expect(() => r.take(pair.permanent.id, pair.permanent.fingerprint, 2000, 'o/a')).toThrow(code('USED'));
  });
  it('take permanent, then take hold of the same pair -> USED', () => {
    const r = new PlanRegistry(); const pair = pairOf(); r.putPair(pair);
    expect(r.take(pair.permanent.id, pair.permanent.fingerprint, 2000, 'o/a')).toBe(pair.permanent);
    expect(() => r.take(pair.hold!.id, pair.hold!.fingerprint, 2000)).toThrow(code('USED'));
  });
  it('a failed take (CONFIRM, FINGERPRINT) consumes neither plan', () => {
    const r = new PlanRegistry(); const pair = pairOf(); r.putPair(pair);
    expect(() => r.take(pair.permanent.id, pair.permanent.fingerprint, 2000, 'nope')).toThrow(code('CONFIRM'));
    expect(() => r.take(pair.hold!.id, 'bad', 2000)).toThrow(code('FINGERPRINT'));
    expect(r.take(pair.hold!.id, pair.hold!.fingerprint, 2000)).toBe(pair.hold);
    expect(() => r.take(pair.permanent.id, pair.permanent.fingerprint, 2000, 'o/a')).toThrow(code('USED'));
  });
  it('a pair without a hold plan registers the permanent plan alone', () => {
    const r = new PlanRegistry(); const pair = { ...pairOf(), hold: null, holdUnavailableReason: 'x' }; r.putPair(pair);
    expect(r.take(pair.permanent.id, pair.permanent.fingerprint, 2000, 'o/a')).toBe(pair.permanent);
  });
  it('pairs are independent of each other', () => {
    const r = new PlanRegistry(); const a = pairOf();
    const bp = mk('o/a', 'p2'); const b: PlanPair = { hold: null, holdUnavailableReason: 'x', permanent: bp };
    r.putPair(a); r.putPair(b);
    r.take(a.hold!.id, a.hold!.fingerprint, 2000);
    expect(r.take(bp.id, bp.fingerprint, 2000, 'o/a')).toBe(bp);
  });
  it('putPair refuses a pair whose two plans share an id', () => {
    const r = new PlanRegistry(); const pair = pairOf();
    expect(() => r.putPair({ ...pair, hold: { ...pair.hold!, id: pair.permanent.id } })).toThrow(/same id/);
  });
});
