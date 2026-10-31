import type { FsLike } from '../../src/core/fsx';

type FsMethod = keyof FsLike;

/**
 * Returns a copy of `fs` whose `method` rejects with a Node-style error carrying `code`.
 * With `when`, only calls whose first (path) argument satisfies it fail; others pass through.
 */
export function failingFs(fs: FsLike, method: FsMethod, code: string, when?: (p: string) => boolean): FsLike {
  const original = fs[method] as (...args: unknown[]) => Promise<unknown>;
  const failing = async (...args: unknown[]): Promise<unknown> => {
    if (when && !when(String(args[0]))) return original.apply(fs, args);
    throw Object.assign(new Error(`${code}: injected ${method} failure (${String(args[0])})`), { code });
  };
  return { ...fs, [method]: failing } as FsLike;
}

/** Returns a copy of `fs` that appends each method name to `calls` before delegating (no behaviour change). */
export function recordingFs(fs: FsLike, calls: string[]): FsLike {
  const out: Partial<Record<FsMethod, unknown>> = {};
  for (const method of Object.keys(fs) as FsMethod[]) {
    const original = fs[method] as (...args: unknown[]) => Promise<unknown>;
    out[method] = (...args: unknown[]): Promise<unknown> => {
      calls.push(method);
      return original.apply(fs, args);
    };
  }
  return out as FsLike;
}

export interface ScriptedRule { method: string; nth: number; code: string; pathIncludes?: string }
export interface FsCall { method: string; args: unknown[] }

/**
 * Wraps `base` so the `nth` (1-based) call of `method` whose string arguments include `pathIncludes` (when given)
 * rejects with a Node-style error carrying `code`. Only that one call fails; every call is recorded in `calls`.
 */
export function scriptedFs(base: FsLike, rules: ScriptedRule[]): FsLike & { calls: FsCall[] } {
  const calls: FsCall[] = [];
  const seen = rules.map(() => 0);
  const out: Record<string, unknown> = { calls };
  for (const method of Object.keys(base) as FsMethod[]) {
    const original = base[method] as (...args: unknown[]) => Promise<unknown>;
    out[method] = async (...args: unknown[]): Promise<unknown> => {
      calls.push({ method, args });
      for (const [i, rule] of rules.entries()) {
        if (rule.method !== method) continue;
        if (rule.pathIncludes !== undefined && !args.some((a) => typeof a === 'string' && a.includes(rule.pathIncludes!))) continue;
        seen[i]! += 1;
        if (seen[i] === rule.nth) {
          throw Object.assign(new Error(`${rule.code}: injected ${method} failure (${String(args[0])})`), { code: rule.code });
        }
      }
      return original.apply(base, args);
    };
  }
  return out as unknown as FsLike & { calls: FsCall[] };
}
