import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { isStrictlyInside, resolveHfHome, resolveHubRoot } from '../core/paths';
import { readFs } from '../core/fsx';
import type { ReadFs } from '../core/fsx';

/** Every location the app reads or writes that an E2E run must keep inside the temp dir. */
export interface GuardPaths {
  hubRoot: string;
  userDataDir: string | null;
  configPath: string;
  /** Configured LM Studio / Ollama roots; null when a view is not configured. */
  viewRoots: ReadonlyArray<string | null>;
  hfHome: string;
  home: string;
}

const MAX_LINK_HOPS = 40;

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}
const isMissing = (e: unknown): boolean => errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR';

/**
 * realpath of the nearest existing ancestor, with the missing segments appended. A dangling symlink is followed
 * (lstat + readlink) so its target is what gets checked. Only ENOENT/ENOTDIR mean "missing"; anything else throws.
 */
export async function realpathNearest(p: string, fs: ReadFs = readFs, hops = 0): Promise<string> {
  if (hops > MAX_LINK_HOPS) throw new Error(`too many symbolic links resolving ${p}`);
  const abs = resolve(p);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    try {
      const st = await fs.lstat(cur);
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(cur), await fs.readlink(cur));
        const real = await realpathNearest(target, fs, hops + 1);
        return missing.length === 0 ? real : join(real, ...missing);
      }
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    const up = dirname(cur);
    if (up === cur) return abs;
    missing.unshift(relative(up, cur));
    cur = up;
  }
}

/** E2E mode is on for any non-empty HFCM_E2E or HFCM_E2E_ROOT: fail closed (a harness that loses one still trips the guard). */
export function isE2E(env: NodeJS.ProcessEnv): boolean {
  return ['HFCM_E2E', 'HFCM_E2E_ROOT'].some((k) => env[k] !== undefined && env[k] !== '');
}

function nonEmpty(v: string | undefined): v is string {
  return v !== undefined && v !== '';
}

export interface GuardOptions {
  fs?: ReadFs;
  /** The passwd home (os.userInfo().homedir), not $HOME. */
  homedir?: string;
  projectDir?: string;
}

const RUN_DIR_PREFIX = 'hfcm-e2e-';

/**
 * Deletion-safety guard, the only entry point. When HFCM_E2E is set, resolves every path the app will touch (hub,
 * userData, config.toml, LM Studio / Ollama roots, HF_HOME, HOME) through symlinks (nearest existing ancestor) and
 * throws unless each lies strictly inside the temp root. The temp root itself is never trusted: it must be a per-run
 * `hfcm-e2e-*` directory that is not `/`, not the passwd home or an ancestor of it, and not the project or an ancestor.
 * Does nothing when HFCM_E2E is unset. Call it before any service is built.
 */
export async function guardTestEnv(
  env: NodeJS.ProcessEnv,
  rawPaths: GuardPaths,
  tmpRoot: string,
  opts: GuardOptions = {},
): Promise<void> {
  if (!isE2E(env)) return;
  const check = await beginGuard(env, tmpRoot, opts);
  await check('the hub', rawPaths.hubRoot);
  await check('userData', rawPaths.userDataDir);
  await check('the config path', rawPaths.configPath);
  for (const r of rawPaths.viewRoots) if (r !== null) await check('a view root', r);
  await check('HF_HOME', rawPaths.hfHome);
  await check('HOME', rawPaths.home);
}

/**
 * The early guard: runs before Electron takes the single-instance lock or writes any profile file. Validates the temp
 * root and the environment with the same rules as `guardTestEnv`, and requires HFCM_USER_DATA_DIR and HFHUB_CONFIG to
 * be set and inside the temp root (so the config is never read from the real home either). Everything else
 * that needs no config read is checked here too (the hub, HF_HOME and `home`, resolved exactly as the services will), so
 * a run aimed at a real cache exits before Electron has written anything. View roots need config.toml and stay with
 * `guardTestEnv`. Does nothing when HFCM_E2E is unset.
 */
export async function preflightTestEnv(env: NodeJS.ProcessEnv, home: string, tmpRoot: string, opts: GuardOptions = {}): Promise<void> {
  if (!isE2E(env)) return;
  const check = await beginGuard(env, tmpRoot, opts);
  await check('userData (HFCM_USER_DATA_DIR)', nonEmpty(env['HFCM_USER_DATA_DIR']) ? env['HFCM_USER_DATA_DIR'] : null);
  await check('the config path (HFHUB_CONFIG)', nonEmpty(env['HFHUB_CONFIG']) ? env['HFHUB_CONFIG'] : null);
  await check('the hub', resolveHubRoot(env, home));
  await check('HF_HOME', resolveHfHome(env, home));
  await check('HOME', home);
}

/** Validates the temp root and the environment variables; returns the per-path containment check. */
async function beginGuard(
  env: NodeJS.ProcessEnv, tmpRoot: string, opts: GuardOptions,
): Promise<(label: string, p: string | null) => Promise<void>> {
  const fs = opts.fs ?? readFs;
  const fail = (msg: string): never => {
    throw new Error(`HFCM_E2E is set but ${msg}`);
  };
  const real = async (p: string): Promise<string> => (isAbsolute(p) ? realpathNearest(p, fs) : p);
  const home = await real(opts.homedir ?? userInfo().homedir);
  const project = await real(opts.projectDir ?? process.cwd());
  const tmp = await real(tmpRoot);
  const unusable = (): never => fail(`the temp dir is not usable: ${tmpRoot}`);
  const coversOrIs = (outer: string, inner: string): boolean => outer === inner || isStrictlyInside(inner, outer);
  if (!isAbsolute(tmpRoot) || parse(tmp).root === tmp || !basename(tmp).startsWith(RUN_DIR_PREFIX)) unusable();
  if (coversOrIs(tmp, home) || coversOrIs(tmp, project)) unusable();

  if (!nonEmpty(env['HFHUB_CONFIG'])) fail('HFHUB_CONFIG is not set (the config path would fall back to the real home)');
  for (const name of ['HUGGINGFACE_CO_STAGING', 'ELECTRON_RENDERER_URL'] as const) {
    if (nonEmpty(env[name])) fail(`${name} must not be set`);
  }
  return async (label, p) => {
    if (p === null || p === '') return fail(`${label} is not set`);
    if (!isAbsolute(p) || !isStrictlyInside(await real(p), tmp)) fail(`${label} is outside the temp dir: ${p}`);
  };
}
