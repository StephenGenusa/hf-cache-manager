import { beforeEach, expect, test } from 'vitest';
import { filterSortRepos, type FilterOptions } from '../../src/renderer/lib/repo-filter';
import { LIBRARY } from './fake-api';

beforeEach(() => expect.hasAssertions());

const base: FilterOptions = { query: '', sort: 'size', kinds: [], lmstudio: false, ollama: false, partial: false };
const ids = (o: Partial<FilterOptions>) => filterSortRepos(LIBRARY.repos, { ...base, ...o }).map((r) => r.repoId);

test('query is a case-insensitive substring match on the repo id', () => {
  expect(ids({ query: 'qwen' })).toEqual(['unsloth/Qwen3.6-27B-GGUF', 'Qwen/Qwen3-32B']);
  expect(ids({ query: '  QWEN3-32 ' })).toEqual(['Qwen/Qwen3-32B']);
  expect(ids({ query: 'nomatch' })).toEqual([]);
});

test('sorts: size desc, name asc, modified desc, kind then size desc', () => {
  expect(ids({ sort: 'size' })).toEqual([
    'unsloth/Qwen3.6-27B-GGUF', 'Qwen/Qwen3-32B', 'black-forest-labs/FLUX.1-dev', 'bartowski/gemma-4-31b-it-GGUF', 'org/partial']);
  expect(ids({ sort: 'name' })).toEqual([
    'bartowski/gemma-4-31b-it-GGUF', 'black-forest-labs/FLUX.1-dev', 'org/partial', 'Qwen/Qwen3-32B', 'unsloth/Qwen3.6-27B-GGUF']);
  expect(ids({ sort: 'modified' })).toEqual([
    'bartowski/gemma-4-31b-it-GGUF', 'unsloth/Qwen3.6-27B-GGUF', 'black-forest-labs/FLUX.1-dev', 'Qwen/Qwen3-32B', 'org/partial']);
  expect(ids({ sort: 'kind' })).toEqual([
    'unsloth/Qwen3.6-27B-GGUF', 'bartowski/gemma-4-31b-it-GGUF', 'org/partial', 'black-forest-labs/FLUX.1-dev', 'Qwen/Qwen3-32B']);
});

test('filters combine with AND', () => {
  expect(ids({ kinds: ['gguf'] })).toEqual(['unsloth/Qwen3.6-27B-GGUF', 'bartowski/gemma-4-31b-it-GGUF', 'org/partial']);
  expect(ids({ kinds: ['gguf', 'diffusers'], lmstudio: true })).toEqual(['unsloth/Qwen3.6-27B-GGUF', 'bartowski/gemma-4-31b-it-GGUF']);
  expect(ids({ ollama: true })).toEqual(['unsloth/Qwen3.6-27B-GGUF']);
  expect(ids({ lmstudio: true, ollama: true, kinds: ['diffusers'] })).toEqual([]);
  expect(ids({ partial: true })).toEqual(['org/partial']);
  expect(ids({ partial: true, query: 'qwen' })).toEqual([]);
});

test('does not mutate its input and ties break by repo id', () => {
  const copy = [...LIBRARY.repos];
  const same = [{ ...LIBRARY.repos[0]!, repoId: 'b/x' }, { ...LIBRARY.repos[0]!, repoId: 'a/x' }];
  expect(filterSortRepos(same, base).map((r) => r.repoId)).toEqual(['a/x', 'b/x']);
  filterSortRepos(LIBRARY.repos, { ...base, sort: 'name' });
  expect(LIBRARY.repos).toEqual(copy);
});
