// The environment the E2E harness hands to the launched app. Pure: no fs, no Playwright, so a
// vitest test pins exactly what an E2E run can reach (tests/e2e/launch-env.test.ts).
//
// Built from an ALLOW-LIST: only the display, locale and terminal variables pass through from the
// parent env. Everything else (HOME, every HF_* / XDG_* location, DBUS_SESSION_BUS_ADDRESS, LD_PRELOAD, NODE_OPTIONS,
// ELECTRON_*, any future location variable) is left out. HOME and the XDG base dirs are then set inside the run dir, so
// Chromium, GTK and fontconfig write only there, and without a session bus Chromium cannot reach the real keyring
// (`launchOptions` also passes --password-store=basic).
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export interface LaunchPaths {
  /** The per-run `mkdtemp(<tmpdir>/hfcm-e2e-)` dir (realpath). */
  root: string;
  hubRoot: string;
  configPath: string;
  hfHome: string;
  home: string;
  userDataDir: string;
}

const ALLOWED = /^(PATH|DISPLAY|XAUTHORITY|WAYLAND_DISPLAY|LANG|LC_[A-Z_]+|TZ|TERM)$/;
/**
 * The only variables a test may add: an outside hub (the refusal test), the guarded grace override, the guarded machine
 * profile (main honours it only after guardTestEnv passed) and HF_ENDPOINT, which must be the loopback
 * fake Hub: main also refuses any other endpoint under E2E, so a test can never reach the real Hub.
 */
const ALLOWED_EXTRA = new Set(['HF_HUB_CACHE', 'HFCM_E2E_AUTO_EMPTY_GRACE_MS', 'HFCM_E2E_MACHINE', 'HFCM_E2E_DISK', 'HF_ENDPOINT']);
const LOOPBACK_ENDPOINT = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/[^?#@]*)?$/;
export const RUN_DIR_PREFIX = 'hfcm-e2e-';

const strictlyInside = (p: string, root: string): boolean => {
  const rel = relative(root, resolve(p));
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};

function checkPaths(p: LaunchPaths): void {
  if (!isAbsolute(p.root) || resolve(p.root) !== p.root || !basename(p.root).startsWith(RUN_DIR_PREFIX)) {
    throw new Error(`not a per-run run dir: ${p.root}`);
  }
  for (const k of ['hubRoot', 'configPath', 'hfHome', 'home', 'userDataDir'] as const) {
    if (!isAbsolute(p[k]) || !strictlyInside(p[k], p.root)) throw new Error(`${k} is outside the run dir: ${p[k]}`);
  }
}

export interface LaunchEnvOptions {
  /**
   * 'guarded' (default): HFCM_E2E on, HFCM_E2E_ROOT and HFCM_USER_DATA_DIR set. 'first-run': the one unguarded launch
   * (no guard, no userData override, so Electron uses its default userData under the isolated XDG_CONFIG_HOME); the
   * caller must run the guard rules on these paths itself before launching (harness `withFirstRun`).
   */
  mode?: 'guarded' | 'first-run';
  extra?: Record<string, string>;
}

export function buildLaunchEnv(parent: NodeJS.ProcessEnv, p: LaunchPaths, opts: LaunchEnvOptions = {}): Record<string, string> {
  checkPaths(p);
  const mode = opts.mode ?? 'guarded';
  const extra = opts.extra ?? {};
  for (const k of Object.keys(extra)) if (!ALLOWED_EXTRA.has(k)) throw new Error(`${k} is not an allowed extra variable`);
  if (extra['HF_ENDPOINT'] !== undefined && !LOOPBACK_ENDPOINT.test(extra['HF_ENDPOINT'])) {
    throw new Error(`HF_ENDPOINT must be a loopback http origin (the fake Hub): '${extra['HF_ENDPOINT']}'`);
  }
  if (mode === 'first-run' && Object.keys(extra).length > 0) throw new Error('the first-run launch takes no extra variables');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (v !== undefined && ALLOWED.test(k)) out[k] = v;
  Object.assign(out, {
    HOME: p.home, XDG_CONFIG_HOME: join(p.home, '.config'), XDG_DATA_HOME: join(p.home, '.local', 'share'), XDG_CACHE_HOME: join(p.home, '.cache'),
    HF_HUB_CACHE: p.hubRoot, HFHUB_CONFIG: p.configPath, HF_HOME: p.hfHome, HFCM_OFFLINE: '1',
    // every mode, the unguarded first-run launch included: the app never runs nvidia-smi under the E2E suite
    HFCM_NO_GPU_DETECT: '1',
  });
  if (mode === 'guarded') Object.assign(out, { HFCM_USER_DATA_DIR: p.userDataDir, HFCM_E2E: '1', HFCM_E2E_ROOT: p.root });
  return { ...out, ...extra };
}

/** The guard treats the cwd as the project dir; launching from inside the run dir would make the guard refuse it. */
export function launchCwd(cwd: string, root: string): string {
  if (resolve(cwd) === resolve(root) || strictlyInside(cwd, root)) throw new Error(`refusing to launch with cwd inside the run dir: ${cwd}`);
  return cwd;
}

/**
 * The options of every Electron launch: `chromiumSandbox: true`, because Playwright otherwise prepends `--no-sandbox`
 * to Electron's arguments on Linux (the app must never run unsandboxed), and `--password-store=basic`, so Chromium
 * never opens the user's keyring. tests/e2e/launch-sites.test.ts checks that every launch in e2e/ goes through here.
 */
export function launchOptions(mainJs: string, env: Record<string, string>, cwd: string, packagedApp?: string): {
  args: string[]; env: Record<string, string>; cwd: string; chromiumSandbox: true; executablePath?: string;
} {
  // A packaged build (README screenshots, npm run screenshots with HFCM_APP_EXE) carries its own app: no main script.
  if (packagedApp !== undefined) return { args: ['--password-store=basic'], env, cwd, chromiumSandbox: true, executablePath: packagedApp };
  return { args: ['--password-store=basic', mainJs], env, cwd, chromiumSandbox: true };
}
