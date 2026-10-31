import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Strips the Windows extended-length prefix from readlink text: `\\?\UNC\x` -> `\\x`, `\\?\x` -> `x`. */
export function normalizeLinkText(raw: string): string {
  if (raw.startsWith('\\\\?\\UNC\\')) return '\\\\' + raw.slice(8);
  if (raw.startsWith('\\\\?\\')) return raw.slice(4);
  return raw;
}

/** Python `os.path.expanduser` subset: `~` and `~/...` (also `~\...` on win32); `~user` is left alone. */
export function expandUser(p: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || (platform === 'win32' && p.startsWith('~\\'))) return home + p.slice(1);
  return p;
}

/** Python `os.path.expandvars` subset: `$NAME`, `${NAME}` (and `%NAME%` on win32); undefined names stay verbatim. */
export function expandVars(p: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const re = platform === 'win32' ? /\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)|%([A-Za-z0-9_]+)%/g : /\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g;
  return p.replace(re, (m, a?: string, b?: string, c?: string) => {
    const v = env[a ?? b ?? c ?? ''];
    return v === undefined ? m : v;
  });
}

/** Env lookup where an empty string counts as unset (deliberate deviation from Python). */
function envVal(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function expand(p: string, env: NodeJS.ProcessEnv, home: string): string {
  return expandVars(expandUser(p, home), env);
}

function expandOpt(p: string | undefined, env: NodeJS.ProcessEnv, home: string): string | undefined {
  return p === undefined ? undefined : expand(p, env, home);
}

export function resolveHfHome(env: NodeJS.ProcessEnv, home: string): string {
  const hfHome = envVal(env, 'HF_HOME');
  const xdg = envVal(env, 'XDG_CACHE_HOME');
  return resolve(expand(hfHome ?? join(xdg ?? join(home, '.cache'), 'huggingface'), env, home));
}

export function resolveHubRoot(env: NodeJS.ProcessEnv, home: string): string {
  const staging = (envVal(env, 'HUGGINGFACE_CO_STAGING') ?? '').toUpperCase();
  if (['1', 'ON', 'YES', 'TRUE'].includes(staging)) {
    return resolve(join(home, '.cache', 'huggingface_staging', 'hub'));
  }
  const explicit = envVal(env, 'HF_HUB_CACHE') ?? envVal(env, 'HUGGINGFACE_HUB_CACHE');
  return resolve(expand(explicit ?? join(resolveHfHome(env, home), 'hub'), env, home));
}

/** Ignores XDG_CACHE_HOME and HF_TOKEN_PATH. */
export function resolveTokenPath(env: NodeJS.ProcessEnv, home: string): string {
  const base = expandOpt(envVal(env, 'HF_HOME'), env, home) ?? join(home, '.cache', 'huggingface');
  return resolve(join(base, 'token'));
}

/** Total order of strings by UTF-16 code unit (as `<`), the order every sorted plan list uses. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isStrictlyInside(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
