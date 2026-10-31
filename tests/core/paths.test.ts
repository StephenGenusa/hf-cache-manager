import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareStrings,
  expandUser,
  expandVars,
  isStrictlyInside,
  normalizeLinkText,
  resolveHfHome,
  resolveHubRoot,
  resolveTokenPath,
} from '../../src/core/paths';
import { useCanaries } from '../helpers/canary';

useCanaries();
const H = '/home/u';

describe('resolveHubRoot', () => {
  it.each<[string, NodeJS.ProcessEnv, string]>([
    ['default', {}, '/home/u/.cache/huggingface/hub'],
    ['XDG_CACHE_HOME', { XDG_CACHE_HOME: '/x' }, '/x/huggingface/hub'],
    ['HF_HOME beats XDG', { HF_HOME: '/h', XDG_CACHE_HOME: '/x' }, '/h/hub'],
    ['legacy HUGGINGFACE_HUB_CACHE beats HF_HOME', { HUGGINGFACE_HUB_CACHE: '/l', HF_HOME: '/h' }, '/l'],
    ['HF_HUB_CACHE beats all', { HF_HUB_CACHE: '/c', HUGGINGFACE_HUB_CACHE: '/l', HF_HOME: '/h' }, '/c'],
    ['expanduser', { HF_HUB_CACHE: '~/models/hub' }, '/home/u/models/hub'],
    ['expandvars $V and ${V}', { D: '/data', HF_HUB_CACHE: '$D/${D}x' }, '/data/datax'],
    ['undefined var left verbatim', { HF_HUB_CACHE: '/a/$NOPE' }, '/a/$NOPE'],
    ['HF_HOME expanded', { HF_HOME: '~/hf' }, '/home/u/hf/hub'],
    ['empty HF_HUB_CACHE is unset (deviation)', { HF_HUB_CACHE: '' }, '/home/u/.cache/huggingface/hub'],
    ['empty HF_HOME and XDG are unset', { HF_HOME: '', XDG_CACHE_HOME: '' }, '/home/u/.cache/huggingface/hub'],
    ['staging overrides everything', { HUGGINGFACE_CO_STAGING: 'yes', HF_HUB_CACHE: '/c' }, '/home/u/.cache/huggingface_staging/hub'],
    ['staging false-y ignored', { HUGGINGFACE_CO_STAGING: '0', HF_HUB_CACHE: '/c' }, '/c'],
    ['trailing slash normalised', { HF_HUB_CACHE: '/c/' }, '/c'],
  ])('%s', (_n, env, want) => expect(resolveHubRoot(env, H)).toBe(want));

  it('a ~ produced by a variable is not expanded (Python order)', () => {
    expect(resolveHubRoot({ V: '~/y', HF_HUB_CACHE: '$V' }, H)).toBe(resolve('~/y'));
  });
});

describe('resolveHfHome / resolveTokenPath', () => {
  it('hf home', () => {
    expect(resolveHfHome({}, H)).toBe('/home/u/.cache/huggingface');
    expect(resolveHfHome({ XDG_CACHE_HOME: '/x' }, H)).toBe('/x/huggingface');
    expect(resolveHfHome({ HF_HOME: '~/hf' }, H)).toBe('/home/u/hf');
  });
  it('token path ignores XDG_CACHE_HOME and HF_TOKEN_PATH', () => {
    expect(resolveTokenPath({}, H)).toBe('/home/u/.cache/huggingface/token');
    expect(resolveTokenPath({ XDG_CACHE_HOME: '/x', HF_TOKEN_PATH: '/t' }, H)).toBe('/home/u/.cache/huggingface/token');
    expect(resolveTokenPath({ HF_HOME: '/h' }, H)).toBe('/h/token');
  });
});

describe('expandUser / expandVars platform rules', () => {
  it('~user is not expanded', () => expect(expandUser('~bob/x', H)).toBe('~bob/x'));
  it('win32: ~\\ and %VAR%', () => {
    expect(expandUser('~\\m', 'C:\\Users\\u', 'win32')).toBe('C:\\Users\\u\\m');
    expect(expandVars('%D%\\hub', { D: 'E:\\hf' }, 'win32')).toBe('E:\\hf\\hub');
    expect(expandVars('%D%', { D: 'x' }, 'linux')).toBe('%D%');
  });
});

describe('normalizeLinkText', () => {
  it.each([
    [String.raw`\\?\C:\hub\models--a--b\blobs\x`, String.raw`C:\hub\models--a--b\blobs\x`],
    [String.raw`\\?\UNC\srv\share\hub\x`, String.raw`\\srv\share\hub\x`],
    ['../../blobs/abc', '../../blobs/abc'],
    ['/abs/hub/models--a--b/blobs/x', '/abs/hub/models--a--b/blobs/x'],
  ])('%s', (raw, want) => expect(normalizeLinkText(raw)).toBe(want));
});

describe('compareStrings', () => {
  it('orders by UTF-16 code unit, 0 only for equal strings', () => {
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    expect(compareStrings('a', 'a')).toBe(0);
    expect(compareStrings('Z', 'a')).toBe(-1);
    expect(['b', 'a', 'B', 'a'].sort(compareStrings)).toEqual(['B', 'a', 'a', 'b']);
  });
});

describe('isStrictlyInside', () => {
  it.each<[string, string, boolean]>([
    ['/a/b', '/a', true], ['/a/b/c', '/a', true], ['/a', '/a', false], ['/a/', '/a', false],
    ['/ab', '/a', false], ['/a/../b', '/a', false], ['/a/b/..', '/a', false], ['/a/..b', '/a', true],
    ['/x', '/', true], ['/', '/', false], ['/a/b', '/a/b/c', false],
  ])('%s in %s -> %s', (c, r, want) => expect(isStrictlyInside(c, r)).toBe(want));
});
