import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readFs } from '../../../src/core/fsx';
import { overlappingRoots, viewPathProblem, viewRootsOverlap } from '../../../src/core/views/view-path';
import { tempDir } from '../_temp';
import type { SafeRoots } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';

useCanaries();
beforeEach(() => expect.hasAssertions());

const roots: SafeRoots = { hubRoot: '/data/hf/hub', viewRoots: ['/data/lm', '/data/ol'], holdRoot: '/data/hf/.hf-cache-manager/rd' };

describe('viewPathProblem', () => {
  it('accepts a path strictly inside the single view root or inside any of several', () => {
    expect(viewPathProblem('/data/lm/a/b.gguf', '/data/lm', roots)).toBeNull();
    expect(viewPathProblem('/data/ol/m', roots.viewRoots, roots)).toBeNull();
  });
  it('refuses a relative or non-normalized path', () => {
    expect(viewPathProblem('lm/a', '/data/lm', roots)).toBe('path is not a normalized absolute path');
    expect(viewPathProblem('/data/lm/a/../b', '/data/lm', roots)).toBe('path is not a normalized absolute path');
  });
  it('refuses the root itself, a sibling and another view root when one root is named', () => {
    const msg = 'path is not strictly inside a view root';
    expect(viewPathProblem('/data/lm', '/data/lm', roots)).toBe(msg);
    expect(viewPathProblem('/data/lmx/a', '/data/lm', roots)).toBe(msg);
    expect(viewPathProblem('/data/ol/a', '/data/lm', roots)).toBe(msg);
  });
  it('refuses paths at or inside the hub, the app folder and the hold root, even inside a view root', () => {
    const wide = ['/data'];
    expect(viewPathProblem('/data/hf/hub', wide, roots)).toBe('path is inside /data/hf/hub');
    expect(viewPathProblem('/data/hf/hub/models--x/snapshots/c/f.gguf', wide, roots)).toBe('path is inside /data/hf/hub');
    expect(viewPathProblem('/data/hf/.hf-cache-manager/x', wide, roots)).toBe('path is inside /data/hf/.hf-cache-manager');
    const elsewhere = { ...roots, holdRoot: '/data/other-hold' };
    expect(viewPathProblem('/data/other-hold/d', wide, elsewhere)).toBe('path is inside /data/other-hold');
    expect(viewPathProblem('/data/other-hold', wide, elsewhere)).toBe('path is inside /data/other-hold');
    expect(viewPathProblem('/data/lm/a', wide, { ...roots, holdRoot: null })).toBeNull();
  });
});

describe('viewRootsOverlap', () => {
  it('equal or nested realpaths overlap; disjoint, missing or null roots do not', async () => {
    const d = await tempDir();
    const a = join(d, 'a');
    const b = join(d, 'b');
    mkdirSync(join(a, 'in'), { recursive: true });
    mkdirSync(b);
    symlinkSync(a, join(d, 'a-link'));
    expect(await viewRootsOverlap(readFs, [a, a])).toBe(true);
    expect(await viewRootsOverlap(readFs, [a, join(a, 'in')])).toBe(true);
    expect(await viewRootsOverlap(readFs, [join(a, 'in'), join(d, 'a-link')])).toBe(true);
    expect(await viewRootsOverlap(readFs, [a, b])).toBe(false);
    expect(await viewRootsOverlap(readFs, [a, null])).toBe(false);
    expect(await viewRootsOverlap(readFs, [a, join(a, 'missing')])).toBe(false);
    expect(await viewRootsOverlap(readFs, [`${a}x`, a])).toBe(false);
  });
});

describe('overlappingRoots', () => {
  it('flags, per input position, every root that overlaps another; works for any number of roots', async () => {
    const d = await tempDir();
    const [a, b, c] = ['a', 'b', 'c'].map((n) => join(d, n)) as [string, string, string];
    mkdirSync(join(a, 'in'), { recursive: true });
    mkdirSync(b);
    mkdirSync(c);
    expect(await overlappingRoots(readFs, [a, b, c])).toEqual([false, false, false]);
    expect(await overlappingRoots(readFs, [a, b, join(a, 'in')])).toEqual([true, false, true]);
    expect(await overlappingRoots(readFs, [null, b, b, join(d, 'missing')])).toEqual([false, true, true, false]);
    expect(await overlappingRoots(readFs, [])).toEqual([]);
  });
});
