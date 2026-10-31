// checkClosure is the planner's last guard that no link outside the selection is doomed.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkClosure, closeSelection, type Closure } from '../../../src/core/plan/closure';
import type { CacheModel, Selection } from '../../../src/core/types';
import { useCanaries } from '../../helpers/canary';
import { buildTree, f, groupKeyFor } from '../support/scenarios';

useCanaries();

const one = (m: CacheModel, s: Selection): Closure => closeSelection(m, s)[0]!;
const partial = (groupKeys: string[]): Selection => ({ repos: [{ repoId: 'o/a', whole: false, groupKeys, unlockComponents: false }] });

describe('checkClosure', () => {
  it('passes every closure closeSelection builds, and refuses a doomed link outside the selection', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', main: 'c1', snapshots: {
      c1: { 'a-Q4_K_M.gguf': f('blob', 'A', 1000) },
      c2: { 'shared.gguf': f('blob', 'B', 200), 'own.gguf': f('blob', 'E', 50) },
      c3: { 'shared.gguf': f('blob', 'B', 200) } } }] });
    await mkdir(join(t.folder('o/a'), 'refs'), { recursive: true });
    await writeFile(join(t.folder('o/a'), 'refs', 'dev'), 'c2');
    await writeFile(join(t.folder('o/a'), 'refs', 'pr'), 'c3');
    const m = await t.scan();
    const c = one(m, partial(['other:Files only in dev']));
    expect(() => checkClosure(c)).not.toThrow();
    const pr = m.repos[0]!.files.find((x) => x.commit === 'c3')!;
    expect(() => checkClosure({ ...c, links: [...c.links, pr] })).toThrow(`closure: ${pr.linkPath} is not selected but would be deleted`);
    const b = { path: t.blob('o/a', 'shared.gguf', 'c2'), facts: pr.facts };
    expect(() => checkClosure({ ...c, blobs: [...c.blobs, b] })).toThrow(/^closure: blob .* would be deleted while .*shared\.gguf still links it$/);
  });

  it('an older-revision link in no group may go only with its blob', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: {
      c0: { 'old.gguf': f('blob', 'Q4', 4000) },
      c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000), 'm-Q8_0.gguf': f('blob', 'Q8', 8000) } } }] });
    const m = await t.scan();
    const q4 = one(m, partial([groupKeyFor(m, 'o/a', 'm-Q4_K_M.gguf')]));
    expect(q4.links).toHaveLength(2);
    expect(() => checkClosure(q4)).not.toThrow();
    const q8 = one(m, partial([groupKeyFor(m, 'o/a', 'm-Q8_0.gguf')]));
    const old = m.repos[0]!.files.find((x) => x.relpath === 'old.gguf')!;
    expect(() => checkClosure({ ...q8, links: [...q8.links, old] })).toThrow(`closure: ${old.linkPath} is not selected but would be deleted`);
  });

  it('a whole-repo closure is not checked against groups', async () => {
    const t = await buildTree({ repos: [{ id: 'o/a', snapshots: { c1: { 'm-Q4_K_M.gguf': f('blob', 'Q4', 4000) } } }] });
    const m = await t.scan();
    expect(() => checkClosure(one(m, { repos: [{ repoId: 'o/a', whole: true }] }))).not.toThrow();
  });
});
