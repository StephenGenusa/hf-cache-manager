import { join, relative, sep } from 'node:path';
import { factsOf, readFs, type ReadFs } from '../../../src/core/fsx';
import { normalizeLinkText } from '../../../src/core/paths';
import type { CacheModel, Op, ViewImpactLine, ViewImpactProvider, ViewName } from '../../../src/core/types';

/** Fixed-answer provider; `calls` records the doomed repo-blob paths of every impactFor call. */
export function stubViews(r?: { ops?: Op[]; lines?: ViewImpactLine[] }): ViewImpactProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    impactFor: async (_model: CacheModel, doomed: string[]) => {
      calls.push([...doomed]);
      return { ops: [...(r?.ops ?? [])], lines: [...(r?.lines ?? [])] };
    },
  };
}

/** Unlinks every symlink under `viewRoot` whose target text equals a doomed path (role 'view-link', action 'remove'). */
export function lmstudioViews(viewRoot: string, fs: ReadFs = readFs): ViewImpactProvider {
  return {
    impactFor: async (_model, doomed) => {
      const want = new Set(doomed);
      const ops: Op[] = [];
      const lines: ViewImpactLine[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const name of (await fs.readdir(dir)).sort()) {
          const p = join(dir, name);
          const facts = await factsOf(fs, p);
          if (!facts) continue;
          if (facts.isDirectory && !facts.isSymlink) await walk(p);
          else if (facts.isSymlink && want.has(normalizeLinkText(await fs.readlink(p)))) {
            ops.push({ kind: 'unlink', path: p, expect: facts, role: 'view-link' });
            lines.push({ view: 'lmstudio', path: relative(viewRoot, p).split(sep).join('/'), action: 'remove' });
          }
        }
      };
      await walk(viewRoot);
      return { ops, lines };
    },
  };
}

export interface TriggeredEntry { view: ViewName; viewRoot: string; rel: string; role: 'view-link' | 'view-manifest' | 'view-blob' }

/**
 * When `trigger` is among the doomed repo blobs, one `unlink` op (lstat facts taken at plan time) and one `remove`
 * line per entry, in the given order; otherwise nothing.
 */
export function triggeredViews(trigger: string, entries: TriggeredEntry[], fs: ReadFs = readFs): ViewImpactProvider {
  return {
    impactFor: async (_model, doomed) => {
      const ops: Op[] = [];
      const lines: ViewImpactLine[] = [];
      if (!doomed.includes(trigger)) return { ops, lines };
      for (const e of entries) {
        const path = join(e.viewRoot, ...e.rel.split('/'));
        const expect = await factsOf(fs, path);
        if (!expect) throw new Error(`triggeredViews: ${path} does not exist`);
        ops.push({ kind: 'unlink', path, expect, role: e.role });
        lines.push({ view: e.view, path: e.rel, action: 'remove' });
      }
      return { ops, lines };
    },
  };
}
