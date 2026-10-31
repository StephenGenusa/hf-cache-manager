import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyState, loadState, serializeState, StateError, type ViewState } from '../../../src/core/compat/state';
import { useCanaries } from '../../helpers/canary';
import { tempDir } from '../_temp';

useCanaries();
beforeEach(() => expect.hasAssertions());

let tmp = '';
beforeEach(async () => {
  tmp = await tempDir();
});
const S = (o: object): string => JSON.stringify(o);
const file = (): string => path.join(tmp, '.hfhub-state.json');

describe('state file', () => {
  it('missing file is an empty state', async () => {
    expect(await loadState(tmp)).toEqual({ path: file(), raw: null, state: { version: 1, owned: {}, tombstones: {} } });
    expect(emptyState()).toEqual({ version: 1, owned: {}, tombstones: {} });
  });
  it('serializes with sorted keys, paths/sha256 order, indent=1, no trailing newline', () => {
    const s: ViewState = { version: 1, tombstones: { 'z/z:a.gguf': '2026-10-25T14:03:07', 'a/a:b.gguf': '2026-10-24T01:02:03' },
      owned: { 'o/n:b.gguf': { sha256: 'bb', paths: ['o/n/b.gguf'] }, 'o/n:a.gguf': { sha256: 'aa', paths: ['o/n/a.gguf', 'o/n/mmproj-F16.gguf'] } } };
    expect(serializeState(s)).toBe('{\n "version": 1,\n "owned": {\n  "o/n:a.gguf": {\n   "paths": [\n    "o/n/a.gguf",\n    "o/n/mmproj-F16.gguf"\n   ],\n   "sha256": "aa"\n  },\n  "o/n:b.gguf": {\n   "paths": [\n    "o/n/b.gguf"\n   ],\n   "sha256": "bb"\n  }\n },\n "tombstones": {\n  "a/a:b.gguf": "2026-10-24T01:02:03",\n  "z/z:a.gguf": "2026-10-25T14:03:07"\n }\n}');
  });
  it('serializes an empty state like Python', () => {
    expect(serializeState(emptyState())).toBe('{\n "version": 1,\n "owned": {},\n "tombstones": {}\n}');
  });
  it('sorts keys by code point, not UTF-16 unit', () => {
    const s: ViewState = { version: 1, owned: {}, tombstones: { '\u{1F600}': 'a', '\uFF5E': 'b' } };
    expect(serializeState(s).indexOf('\\uff5e')).toBeLessThan(serializeState(s).indexOf('\\ud83d'));
  });
  it('round-trips byte-for-byte', async () => {
    const text = serializeState({ version: 1, owned: { 'é/x:y.gguf': { paths: ['é/x/y.gguf'], sha256: 'cc' } }, tombstones: {} });
    writeFileSync(file(), text);
    const l = await loadState(tmp);
    expect(l.raw).toBe(text);
    expect(serializeState(l.state)).toBe(text);
    expect(text).toContain('"\\u00e9/x:y.gguf"');
  });
  it('normalises backslashes in keys and paths', async () => {
    writeFileSync(file(), S({ version: 1, owned: { 'o\\n:a\\b.gguf': { paths: ['o\\n\\b.gguf'], sha256: 'aa' } }, tombstones: { 'x\\y:z': 't' } }));
    const { state } = await loadState(tmp);
    expect(state.owned).toEqual({ 'o/n:a/b.gguf': { paths: ['o/n/b.gguf'], sha256: 'aa' } });
    expect(state.tombstones).toEqual({ 'x/y:z': 't' });
  });
  it('later key wins when keys collide after normalisation', async () => {
    writeFileSync(file(), '{"version":1,"owned":{"a\\\\b":{"paths":["1"],"sha256":"x"},"a/b":{"paths":["2"],"sha256":"y"}},"tombstones":{"t\\\\1":"A","t/1":"B"}}');
    const { state } = await loadState(tmp);
    expect(state.owned).toEqual({ 'a/b': { paths: ['2'], sha256: 'y' } });
    expect(state.tombstones).toEqual({ 't/1': 'B' });
  });
  it('later duplicate JSON key wins, as in Python', async () => {
    writeFileSync(file(), '{"version":1,"owned":{"k":{"paths":["a"],"sha256":"x"},"k":{"paths":["b"],"sha256":"y"}},"tombstones":{"t":"1","t":"2"}}');
    const { state } = await loadState(tmp);
    expect(state.owned).toEqual({ k: { paths: ['b'], sha256: 'y' } });
    expect(state.tombstones).toEqual({ t: '2' });
  });
  it('missing owned/tombstones default to empty', async () => {
    writeFileSync(file(), '{"version": 1}');
    expect((await loadState(tmp)).state).toEqual({ version: 1, owned: {}, tombstones: {} });
  });
  it('ignores unknown fields, including NaN in them (Python json accepts it)', async () => {
    writeFileSync(file(), '{"version": 1, "extra": NaN, "owned": {"k": {"paths": ["a"], "sha256": "x", "more": 1}}}');
    expect((await loadState(tmp)).state.owned).toEqual({ k: { paths: ['a'], sha256: 'x' } });
  });
  it('keeps a __proto__ key as plain data without touching the prototype', async () => {
    writeFileSync(file(), '{"version":1,"owned":{"__proto__":{"paths":["a"],"sha256":"x"}},"tombstones":{"__proto__":"t"}}');
    const { state } = await loadState(tmp);
    expect(Object.getPrototypeOf(state.owned)).toBe(Object.prototype);
    expect(Object.keys(state.owned)).toEqual(['__proto__']);
    expect(Object.keys(state.tombstones)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).paths).toBeUndefined();
    expect(serializeState(state)).toContain('"__proto__"');
  });
  it('rejects invalid UTF-8 and a BOM', async () => {
    writeFileSync(file(), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    await expect(loadState(tmp)).rejects.toThrow(StateError);
    writeFileSync(file(), '\uFEFF{"version":1}');
    await expect(loadState(tmp)).rejects.toThrow(StateError);
  });
  it.each([
    ['not json', '{'], ['version 2', S({ version: 2 })], ['no version', S({ owned: {} })], ['top not object', '[]'],
    ['version true', '{"version": true}'], ['version 1.0', '{"version": 1.0}'], ['version "1"', S({ version: '1' })],
    ['owned not object', S({ version: 1, owned: [] })], ['owned null', S({ version: 1, owned: null })],
    ['entry not object', S({ version: 1, owned: { k: 1 } })],
    ['paths not list', S({ version: 1, owned: { k: { paths: 'a', sha256: 'x' } } })],
    ['paths not strings', S({ version: 1, owned: { k: { paths: [1], sha256: 'x' } } })],
    ['missing paths', S({ version: 1, owned: { k: { sha256: 'x' } } })],
    ['sha256 not string', S({ version: 1, owned: { k: { paths: [], sha256: 1 } } })],
    ['missing sha256', S({ version: 1, owned: { k: { paths: [] } } })],
    ['tombstones not object', S({ version: 1, tombstones: [] })],
    ['tombstones null', S({ version: 1, tombstones: null })],
    ['tombstones not str->str', S({ version: 1, tombstones: { k: 1 } })],
    ['empty path', S({ version: 1, owned: { k: { paths: [''], sha256: 'x' } } })],
    ['absolute path (test_owned_path_outside_the_view_is_rejected)', S({ version: 1, owned: { k: { paths: ['/etc/passwd'], sha256: 'x' } } })],
    ['backslash-absolute', S({ version: 1, owned: { k: { paths: ['\\etc\\x'], sha256: 'x' } } })],
    ['drive letter', S({ version: 1, owned: { k: { paths: ['C:/x'], sha256: 'x' } } })],
    ['drive letter, no slash', S({ version: 1, owned: { k: { paths: ['c:x'], sha256: 'x' } } })],
    ['digit drive', S({ version: 1, owned: { k: { paths: ['1:x'], sha256: 'x' } } })],
    ['non-ascii drive', S({ version: 1, owned: { k: { paths: ['é:x'], sha256: 'x' } } })],
    ['colon drive', S({ version: 1, owned: { k: { paths: ['::x'], sha256: 'x' } } })],
    ['astral drive', S({ version: 1, owned: { k: { paths: ['\u{1F600}:x'], sha256: 'x' } } })],
    ['UNC', S({ version: 1, owned: { k: { paths: ['\\\\server\\share\\x'], sha256: 'x' } } })],
    ['dotdot', S({ version: 1, owned: { k: { paths: ['a/../../x'], sha256: 'x' } } })],
    ['dotdot via backslash', S({ version: 1, owned: { k: { paths: ['a\\..\\..\\x'], sha256: 'x' } } })],
    ['bare dotdot', S({ version: 1, owned: { k: { paths: ['..'], sha256: 'x' } } })],
  ])('StateError: %s', async (_n, text) => {
    writeFileSync(file(), text);
    await expect(loadState(tmp)).rejects.toThrow(StateError);
  });
  it('accepts a colon that is not the second code point', async () => {
    writeFileSync(file(), S({ version: 1, owned: { k: { paths: ['ab:x', ':x', 'a/b:c'], sha256: 'x' } } }));
    expect((await loadState(tmp)).state.owned.k?.paths).toEqual(['ab:x', ':x', 'a/b:c']);
  });
  it('accepts names that merely contain dots', async () => {
    writeFileSync(file(), S({ version: 1, owned: { k: { paths: ['a/..b/c..d/.e'], sha256: 'x' } } }));
    expect((await loadState(tmp)).state.owned.k?.paths).toEqual(['a/..b/c..d/.e']);
  });
  it('loadState never writes', async () => {
    writeFileSync(file(), '{');
    await expect(loadState(tmp)).rejects.toThrow(StateError);
    expect(readFileSync(file(), 'utf8')).toBe('{');
  });
  it('refuses a symlinked state file and a directory (V19)', async () => {
    writeFileSync(path.join(tmp, 'real.json'), '{"version":1}');
    symlinkSync('real.json', file());
    await expect(loadState(tmp)).rejects.toThrow(/not a regular file/);
    const d2 = await tempDir();
    mkdirSync(path.join(d2, '.hfhub-state.json'));
    await expect(loadState(d2)).rejects.toThrow(/not a regular file/);
  });
  it('refuses a dangling symlink instead of treating it as missing', async () => {
    symlinkSync('nowhere.json', file());
    await expect(loadState(tmp)).rejects.toThrow(StateError);
  });
  it('refuses a state file over 16 MiB (V19)', async () => {
    writeFileSync(file(), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    await expect(loadState(tmp)).rejects.toThrow(/too large/);
  });
  it('wraps non-ENOENT lstat and read failures in StateError', async () => {
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    const base = { lstat: async () => { throw eacces; } } as never;
    await expect(loadState(tmp, base)).rejects.toThrow(StateError);
    const reg = { lstat: async () => ({ isFile: () => true, size: 3 }), readFile: async () => { throw eacces; } } as never;
    await expect(loadState(tmp, reg)).rejects.toThrow(StateError);
    const big = { lstat: async () => ({ isFile: () => true, size: 3 }), readFile: async () => Buffer.alloc(16 * 1024 * 1024 + 1) } as never;
    await expect(loadState(tmp, big)).rejects.toThrow(/too large/);
  });
});
