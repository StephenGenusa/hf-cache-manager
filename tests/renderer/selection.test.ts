import { beforeEach, expect, test } from 'vitest';
import { useSelection } from '../../src/renderer/state/selection';

beforeEach(() => {
  expect.hasAssertions();
  useSelection.getState().clear();
});

test('locked groups need unlock; turning unlock off drops them', () => {
  const s = useSelection.getState();
  s.toggleGroup('bfl/FLUX', 'component:vae/', true);
  expect(s.toSelection()).toBeNull();
  s.setUnlock('bfl/FLUX', true, ['component:vae/']);
  useSelection.getState().toggleGroup('bfl/FLUX', 'component:vae/', true);
  expect(useSelection.getState().toSelection()).toEqual({
    repos: [{ repoId: 'bfl/FLUX', whole: false, groupKeys: ['component:vae/'], unlockComponents: true }],
  });
  useSelection.getState().setUnlock('bfl/FLUX', false, ['component:vae/']);
  expect(useSelection.getState().toSelection()).toBeNull();
});

test('toggling a group twice deselects it and drops the empty repo entry', () => {
  useSelection.getState().toggleGroup('a/b', 'quant:Q8_0', false);
  expect(useSelection.getState().groupCount()).toBe(1);
  useSelection.getState().toggleGroup('a/b', 'quant:Q8_0', false);
  expect(useSelection.getState().groupCount()).toBe(0);
  expect(useSelection.getState().byRepo).toEqual({});
});

test('multi-repo selection is sorted by repoId and key; groupCount counts all', () => {
  const g = useSelection.getState();
  g.toggleGroup('z/last', 'quant:B', false);
  useSelection.getState().toggleGroup('a/first', 'quant:Z', false);
  useSelection.getState().toggleGroup('a/first', 'quant:A', false);
  const s = useSelection.getState();
  expect(s.groupCount()).toBe(3);
  expect(s.toSelection()).toEqual({
    repos: [
      { repoId: 'a/first', whole: false, groupKeys: ['quant:A', 'quant:Z'], unlockComponents: false },
      { repoId: 'z/last', whole: false, groupKeys: ['quant:B'], unlockComponents: false },
    ],
  });
});

test('unlock only removes locked keys; unlocked selections stay', () => {
  const g = useSelection.getState();
  g.setUnlock('r/x', true, ['component:vae/']);
  useSelection.getState().toggleGroup('r/x', 'component:vae/', true);
  useSelection.getState().toggleGroup('r/x', 'root-file:a.safetensors', false);
  useSelection.getState().setUnlock('r/x', false, ['component:vae/']);
  expect(useSelection.getState().toSelection()).toEqual({
    repos: [{ repoId: 'r/x', whole: false, groupKeys: ['root-file:a.safetensors'], unlockComponents: false }],
  });
});

test('reconcile drops vanished repos and keys', () => {
  useSelection.getState().toggleGroup('a/b', 'quant:Q8_0', false);
  useSelection.getState().toggleGroup('c/d', 'quant:Q4_0', false);
  useSelection.getState().reconcile([{ repoId: 'a/b', groupKeys: ['quant:Q6_K'] }]);
  expect(useSelection.getState().toSelection()).toBeNull();
});

test('reconcile keeps surviving keys and the unlock flag', () => {
  useSelection.getState().setUnlock('a/b', true, []);
  useSelection.getState().toggleGroup('a/b', 'quant:Q8_0', false);
  useSelection.getState().toggleGroup('a/b', 'quant:Q4_0', false);
  useSelection.getState().reconcile([{ repoId: 'a/b', groupKeys: ['quant:Q8_0'] }]);
  expect(useSelection.getState().toSelection()).toEqual({
    repos: [{ repoId: 'a/b', whole: false, groupKeys: ['quant:Q8_0'], unlockComponents: true }],
  });
});

test('reconcile returns the same state object when nothing changes', () => {
  useSelection.getState().toggleGroup('a/b', 'quant:Q8_0', false);
  const before = useSelection.getState().byRepo;
  useSelection.getState().reconcile([{ repoId: 'a/b', groupKeys: ['quant:Q8_0'] }]);
  expect(useSelection.getState().byRepo).toBe(before);
});

test('an unlock flag with no groups does not make a selection', () => {
  useSelection.getState().setUnlock('a/b', true, []);
  expect(useSelection.getState().toSelection()).toBeNull();
  useSelection.getState().setUnlock('a/b', false, []);
  expect(useSelection.getState().byRepo).toEqual({});
});
