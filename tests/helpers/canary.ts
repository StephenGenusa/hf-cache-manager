import { afterEach, beforeEach, expect } from 'vitest';
import { createCanaryContext, plantStandardCanaries, type CanaryContext, type Context } from './canary-core';
import { makeTempRoot, removeTempRoot } from './tmp';

export type { CanaryContext, CanaryRecord } from './canary-core';

let current: Context | null = null;
let proxy: CanaryContext | null = null;

export function currentCanaries(): CanaryContext | null {
  return current;
}

function need(): Context {
  if (!current) throw new Error('canaries used outside a test');
  return current;
}

// Idempotent per test file (module state is per file): hooks are registered once and every call returns the same proxy.
export function useCanaries(): CanaryContext {
  if (proxy) return proxy;
  proxy = {
    get sandbox() {
      return need().sandbox;
    },
    plant: (p, c) => need().plant(p, c),
    protect: (ps) => need().protect(ps),
    releaseUnder: (r, ps) => need().releaseUnder(r, ps),
    verify: () => need().verify(),
    onCleanup: (fn) => need().onCleanup(fn),
    records: () => need().records(),
  };
  beforeEach(async () => {
    const ctx = createCanaryContext(await makeTempRoot('hfcm-canary-'));
    try {
      current = ctx;
      await plantStandardCanaries(ctx);
    } catch (e) {
      current = null;
      await removeTempRoot(ctx.sandbox);
      throw e;
    }
  });
  afterEach(async () => {
    const ctx = current;
    if (!ctx) return;
    let violations: string[] = [];
    const errors: unknown[] = [];
    try {
      try {
        violations = await ctx.verify();
      } catch (e) {
        errors.push(e);
      }
      for (const fn of ctx.takeCleanups()) {
        try {
          await fn();
        } catch (e) {
          errors.push(e);
        }
      }
    } finally {
      current = null;
      await removeTempRoot(ctx.sandbox);
    }
    expect(violations).toEqual([]);
    if (errors.length) throw errors[0];
  });
  return proxy;
}
