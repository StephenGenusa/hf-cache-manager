import { createHash } from 'node:crypto';
import type { DeletionPlan } from '../types';

function canon(v: unknown): string | undefined {
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(v);
  }
  if (typeof v === 'bigint') throw new Error('canonicalJson: bigint');
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canon(x) ?? 'null').join(',')}]`;
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort()) {
    const s = canon(o[k]);
    if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
  }
  return `{${parts.join(',')}}`;
}

/** Keys sorted, undefined props omitted, no whitespace; throws on non-finite numbers. */
export function canonicalJson(v: unknown): string {
  return canon(v) ?? 'null';
}

export function hashCanonical(v: unknown): string {
  return createHash('sha256').update(canonicalJson(v), 'utf8').digest('hex');
}

type PlanBody = Omit<DeletionPlan, 'id' | 'fingerprint'> & Partial<Pick<DeletionPlan, 'id' | 'fingerprint'>>;

/** Fingerprint of everything in the plan except id and fingerprint. */
export function fingerprintPlan(p: PlanBody): string {
  const rest: Record<string, unknown> = { ...p };
  delete rest.id;
  delete rest.fingerprint;
  return hashCanonical(rest);
}
