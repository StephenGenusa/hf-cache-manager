import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, configPath, expandUser, loadConfig } from '../../../src/core/compat/config';
import { expandUser as pathsExpandUser } from '../../../src/core/paths';
import { useCanaries } from '../../helpers/canary';
import { tempDir } from '../_temp';

useCanaries();
beforeEach(() => expect.hasAssertions());

let tmp = '';
beforeEach(async () => {
  tmp = await tempDir();
});
const write = (name: string, text: string): void => writeFileSync(path.join(tmp, name), text);
const load = () => loadConfig({ HFHUB_CONFIG: path.join(tmp, 'config.toml') }, '/home/s');

describe('config.toml reader', () => {
  it('re-exports expandUser from paths (V26)', () => {
    expect(expandUser).toBe(pathsExpandUser);
  });
  it('uses HFHUB_CONFIG with ~ expanded', () => {
    expect(configPath({ HFHUB_CONFIG: '~/x/c.toml' }, '/h')).toBe(path.join('/h', 'x/c.toml'));
    expect(configPath({ HFHUB_CONFIG: '' }, '/h')).toBe(path.join('/h', '.config', 'hfhub', 'config.toml'));
    expect(configPath({}, '/h')).toBe(path.join('/h', '.config', 'hfhub', 'config.toml'));
  });
  it('test_missing_file_gives_disabled_views', async () => {
    const c = await loadConfig({ HFHUB_CONFIG: path.join(tmp, 'nope.toml') }, tmp);
    expect(c).toEqual({
      path: path.join(tmp, 'nope.toml'),
      exists: false,
      views: { lmstudio: { root: null, aliases: {} }, ollama: { root: null, aliases: {} } },
    });
  });
  it('reads roots (~ expanded) and aliases; ignores other tables', async () => {
    write('config.toml', '# c\n[views.lmstudio]\nroot = "~/lm"\n[views.ollama]\nroot = "/o"\n[views.ollama.aliases]\n"qwen3.6:27b" = "unsloth/Q:Q-UD-Q4_K_XL.gguf"\n[other]\nx = 1\n');
    const c = await load();
    expect(c.exists).toBe(true);
    expect(c.views.lmstudio).toEqual({ root: path.join('/home/s', 'lm'), aliases: {} });
    expect(c.views.ollama).toEqual({ root: '/o', aliases: { 'qwen3.6:27b': 'unsloth/Q:Q-UD-Q4_K_XL.gguf' } });
  });
  it('a file without a views table disables both views', async () => {
    write('config.toml', '[other]\nx = 1\n');
    const c = await load();
    expect(c.exists).toBe(true);
    expect(c.views.lmstudio).toEqual({ root: null, aliases: {} });
  });
  it('empty root disables the view', async () => {
    write('config.toml', '[views.lmstudio]\nroot = ""\n');
    expect((await load()).views.lmstudio).toEqual({ root: null, aliases: {} });
  });
  it('relative or ~user root disables the view with a problem', async () => {
    write('config.toml', '[views.lmstudio]\nroot = "models"\n[views.ollama]\nroot = "~bob/o"\n');
    const c = await load();
    expect(c.views.lmstudio).toEqual({ root: null, aliases: {}, problem: 'root is not an absolute path: models' });
    expect(c.views.ollama.problem).toBe('root is not an absolute path: ~bob/o');
  });
  it.each([
    ['[views.lmstudio\n', /TOML/],
    ['[views.lmstudio]\nroot = 3\n', /root must be a string/],
    ['[views.ollama]\naliases = "x"\n', /aliases must be a table/],
    ['[views.ollama.aliases]\na = 1\n', /alias a must be a string/],
    ['views = 1\n', /views must be a table/],
    ['[views]\nollama = 1\n', /views.ollama must be a table/],
  ])('throws ConfigError for %j', async (text, msg) => {
    write('config.toml', text);
    await expect(load()).rejects.toThrow(ConfigError);
    await expect(load()).rejects.toThrow(msg);
  });
  it('a directory at the config path is a ConfigError carrying the path', async () => {
    const e = await loadConfig({ HFHUB_CONFIG: tmp }, '/h').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).path).toBe(tmp);
  });
  it('never writes the config file', async () => {
    write('config.toml', '[views.lmstudio]\nroot = "/x"\n');
    const before = statSync(path.join(tmp, 'config.toml'));
    await load();
    expect(statSync(path.join(tmp, 'config.toml')).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(path.join(tmp, 'config.tmp'))).toBe(false);
  });
});
