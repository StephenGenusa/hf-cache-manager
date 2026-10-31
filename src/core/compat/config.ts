// Read-only reader for hfhub's config.toml. The app never writes this file: no writer is exported.
import path from 'node:path';
import { parse } from 'smol-toml';
import { isNotFound, readFs, type ReadFs } from '../fsx';
import { expandUser } from '../paths';
import type { ViewName } from '../types';

export { expandUser };

export class ConfigError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ViewConfig { root: string | null; aliases: Record<string, string>; problem?: string }
export interface HfhubConfig { path: string; exists: boolean; views: Record<ViewName, ViewConfig> }

const VIEW_NAMES: readonly ViewName[] = ['lmstudio', 'ollama'];

/** `HFHUB_CONFIG` (empty counts as unset, like the CLI) with `~` expanded, else `~/.config/hfhub/config.toml`. */
export function configPath(env: NodeJS.ProcessEnv, home: string): string {
  const e = env.HFHUB_CONFIG;
  if (e) return expandUser(e, home);
  return path.join(home, '.config', 'hfhub', 'config.toml');
}

const disabled = (): Record<ViewName, ViewConfig> => ({
  lmstudio: { root: null, aliases: {} },
  ollama: { root: null, aliases: {} },
});

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

function readView(name: ViewName, section: Record<string, unknown>, home: string, file: string): ViewConfig {
  const out: ViewConfig = { root: null, aliases: {} };
  const root = section.root;
  if (root !== undefined) {
    if (typeof root !== 'string') throw new ConfigError(`views.${name}.root must be a string`, file);
    if (root !== '') {
      const expanded = expandUser(root, home);
      if (path.isAbsolute(expanded)) out.root = expanded;
      else out.problem = `root is not an absolute path: ${root}`;
    }
  }
  const aliases = section.aliases;
  if (aliases !== undefined) {
    if (!isTable(aliases)) throw new ConfigError(`views.${name}.aliases must be a table`, file);
    for (const [k, v] of Object.entries(aliases)) {
      if (typeof v !== 'string') throw new ConfigError(`views.${name}: alias ${k} must be a string`, file);
      out.aliases[k] = v;
    }
  }
  return out;
}

export async function loadConfig(env: NodeJS.ProcessEnv, home: string, fs: ReadFs = readFs): Promise<HfhubConfig> {
  const file = configPath(env, home);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return { path: file, exists: false, views: disabled() };
    throw new ConfigError(`cannot read config: ${(e as Error).message}`, file);
  }
  let data: Record<string, unknown>;
  try {
    data = parse(text);
  } catch (e) {
    throw new ConfigError(`invalid TOML: ${(e as Error).message}`, file);
  }
  const views = disabled();
  const v = data.views;
  if (v === undefined) return { path: file, exists: true, views };
  if (!isTable(v)) throw new ConfigError('views must be a table', file);
  for (const name of VIEW_NAMES) {
    const section = v[name];
    if (section === undefined) continue;
    if (!isTable(section)) throw new ConfigError(`views.${name} must be a table`, file);
    views[name] = readView(name, section, home, file);
  }
  return { path: file, exists: true, views };
}
