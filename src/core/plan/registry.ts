import { ExecError } from '../exec/errors';
import type { DeletionPlan, PlanPair } from '../types';
import { fingerprintPlan } from './fingerprint';

/**
 * Holds reviewed plans; a plan can be taken once, before expiry, with a matching fingerprint.
 * The two plans of a PlanPair are one review: a successful take of either uses up both (the other then gives USED).
 */
export class PlanRegistry {
  private readonly plans = new Map<string, DeletionPlan>();
  private readonly used = new Set<string>();
  private readonly sibling = new Map<string, string>();

  put(plan: DeletionPlan): void {
    for (const [id, p] of this.plans) {
      if (p.expiresAt <= plan.createdAt) {
        this.plans.delete(id);
        this.sibling.delete(id);
      }
    }
    this.plans.set(plan.id, plan);
  }

  /** Registers the permanent plan and, when offered, the hold plan, linked so that taking one uses up the other. */
  putPair(pair: PlanPair): void {
    const { hold, permanent } = pair;
    if (hold !== null && hold.id === permanent.id) throw new Error('PlanRegistry.putPair: both plans have the same id');
    this.put(permanent);
    if (hold === null) return;
    this.put(hold);
    this.sibling.set(hold.id, permanent.id);
    this.sibling.set(permanent.id, hold.id);
  }

  take(id: string, fingerprint: string, now: number, confirmPhrase?: string): DeletionPlan {
    if (this.used.has(id)) throw new ExecError('USED', 'This plan was already used.');
    const plan = this.plans.get(id);
    if (!plan) throw new ExecError('UNKNOWN_PLAN', 'Unknown plan.');
    if (now >= plan.expiresAt) throw new ExecError('EXPIRED', 'This plan expired — please review again.');
    if (fingerprint !== plan.fingerprint || fingerprintPlan(plan) !== plan.fingerprint) {
      throw new ExecError('FINGERPRINT', 'The plan does not match what was reviewed.');
    }
    if (plan.confirmPhrase !== null && (confirmPhrase ?? '').trim() !== plan.confirmPhrase) {
      throw new ExecError('CONFIRM', 'The confirmation phrase does not match.');
    }
    for (const x of [id, this.sibling.get(id)]) {
      if (x === undefined) continue;
      this.used.add(x);
      this.plans.delete(x);
      this.sibling.delete(x);
    }
    return plan;
  }
}
