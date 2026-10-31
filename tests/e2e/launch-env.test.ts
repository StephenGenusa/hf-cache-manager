import { expect, test } from 'vitest';
import { buildLaunchEnv, launchCwd, launchOptions } from '../../e2e/launch-env';

const ROOT = '/tmp/hfcm-e2e-AbC123';
const PATHS = {
  root: ROOT, hubRoot: `${ROOT}/hf/hub`, configPath: `${ROOT}/config/config.toml`, hfHome: `${ROOT}/hf-home`,
  home: `${ROOT}/home`, userDataDir: `${ROOT}/userdata`,
};
/** A polluted parent env: real locations, session buses, preloads and Node / Electron switches. */
const POLLUTED = {
  PATH: '/usr/bin', DISPLAY: ':1', XAUTHORITY: '/run/user/1000/gdm/Xauthority', WAYLAND_DISPLAY: 'wayland-0', LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8', LC_MESSAGES: 'C', TZ: 'UTC', TERM: 'xterm',
  HOME: '/home/user', USERPROFILE: '/home/user', HF_HUB_CACHE: '/home/user/.cache/huggingface/hub', HUGGINGFACE_HUB_CACHE: '/x',
  HF_HOME: '/home/user/.cache/huggingface', XDG_CACHE_HOME: '/home/user/.cache', XDG_CONFIG_HOME: '/home/user/.config',
  XDG_DATA_HOME: '/home/user/.local/share', XDG_STATE_HOME: '/home/user/.local/state', XDG_RUNTIME_DIR: '/run/user/1000',
  HFHUB_CONFIG: '/home/user/.config/hfhub/config.toml', HF_TOKEN: 'hf_secret', HF_TOKEN_PATH: '/home/user/.cache/huggingface/token',
  HUGGINGFACE_CO_STAGING: '1', ELECTRON_RENDERER_URL: 'http://localhost:5173', ELECTRON_RUN_AS_NODE: '1',
  HFCM_E2E_AUTO_EMPTY_GRACE_MS: '1', HFCM_USER_DATA_DIR: '/home/user/ud', HFCM_NO_GPU_DETECT: '0',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', LD_PRELOAD: '/evil.so', NODE_OPTIONS: '--require /evil.js',
  GTK_PATH: '/home/user/gtk', SSH_AUTH_SOCK: '/run/user/1000/ssh', GNOME_KEYRING_CONTROL: '/run/user/1000/keyring', TMPDIR: '/home/user/tmp',
  SOME_FUTURE_LOCATION: '/home/user/somewhere',
};
const ALLOWED_THROUGH = {
  PATH: '/usr/bin', DISPLAY: ':1', XAUTHORITY: '/run/user/1000/gdm/Xauthority', WAYLAND_DISPLAY: 'wayland-0', LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8', LC_MESSAGES: 'C', TZ: 'UTC', TERM: 'xterm',
};
const ISOLATED = {
  HOME: PATHS.home, XDG_CONFIG_HOME: `${PATHS.home}/.config`, XDG_DATA_HOME: `${PATHS.home}/.local/share`, XDG_CACHE_HOME: `${PATHS.home}/.cache`,
  HF_HUB_CACHE: PATHS.hubRoot, HFHUB_CONFIG: PATHS.configPath, HF_HOME: PATHS.hfHome, HFCM_OFFLINE: '1',
  HFCM_NO_GPU_DETECT: '1',
};

test('a polluted parent env yields exactly the allow-list plus the run-dir locations and the guard switches', () => {
  expect(buildLaunchEnv(POLLUTED, PATHS)).toEqual({
    ...ALLOWED_THROUGH, ...ISOLATED, HFCM_USER_DATA_DIR: PATHS.userDataDir, HFCM_E2E: '1', HFCM_E2E_ROOT: ROOT,
  });
});

test('the first-run env comes from the same builder: same isolation, no guard and no userData override', () => {
  expect(buildLaunchEnv(POLLUTED, PATHS, { mode: 'first-run' })).toEqual({ ...ALLOWED_THROUGH, ...ISOLATED });
});

test('extra vars: the guarded E2E machine profile passes through, GPU detection stays off, first-run refuses it', () => {
  const machine = '{"platform":"linux"}';
  const env = buildLaunchEnv(POLLUTED, PATHS, { extra: { HFCM_E2E_MACHINE: machine } });
  expect(env['HFCM_E2E_MACHINE']).toBe(machine);
  expect(env['HFCM_NO_GPU_DETECT']).toBe('1');
  expect(buildLaunchEnv({ ...POLLUTED, HFCM_E2E_MACHINE: machine }, PATHS)['HFCM_E2E_MACHINE']).toBeUndefined();   // never from the parent env
  expect(() => buildLaunchEnv(POLLUTED, PATHS, { mode: 'first-run', extra: { HFCM_E2E_MACHINE: machine } })).toThrow(/first-run/);
});

test('extra vars: the guarded E2E disk passes through, never from the parent env', () => {
  const disk = '{"totalBytes":2,"freeBytes":1}';
  expect(buildLaunchEnv(POLLUTED, PATHS, { extra: { HFCM_E2E_DISK: disk } })['HFCM_E2E_DISK']).toBe(disk);
  expect(buildLaunchEnv({ ...POLLUTED, HFCM_E2E_DISK: disk }, PATHS)['HFCM_E2E_DISK']).toBeUndefined();
});

test('extra vars: only HF_HUB_CACHE and the E2E grace override are accepted, anything else throws', () => {
  const env = buildLaunchEnv(POLLUTED, PATHS, { extra: { HF_HUB_CACHE: '/elsewhere/hub', HFCM_E2E_AUTO_EMPTY_GRACE_MS: '4000' } });
  expect(env['HF_HUB_CACHE']).toBe('/elsewhere/hub');
  expect(env['HFCM_E2E_AUTO_EMPTY_GRACE_MS']).toBe('4000');
  for (const k of ['HFCM_E2E', 'HFCM_E2E_ROOT', 'HFCM_USER_DATA_DIR', 'HFHUB_CONFIG', 'HOME', 'HF_HOME', 'HUGGINGFACE_HUB_CACHE', 'HFCM_OFFLINE',
    'XDG_CONFIG_HOME', 'HFCM_NO_GPU_DETECT', 'DBUS_SESSION_BUS_ADDRESS', 'LD_PRELOAD', 'NODE_OPTIONS', 'PATH']) {
    expect(() => buildLaunchEnv(POLLUTED, PATHS, { extra: { [k]: '/x' } }), k).toThrow(/not an allowed extra/);
  }
  expect(() => buildLaunchEnv(POLLUTED, PATHS, { mode: 'first-run', extra: { HF_HUB_CACHE: '/x' } })).toThrow(/first-run/);
});

test('HF_ENDPOINT passes only as an explicit extra, and only as a loopback http origin', () => {
  expect(buildLaunchEnv({ ...POLLUTED, HF_ENDPOINT: 'http://127.0.0.1:9' }, PATHS)['HF_ENDPOINT']).toBeUndefined();   // never from the parent env
  expect(buildLaunchEnv(POLLUTED, PATHS, { extra: { HF_ENDPOINT: 'http://127.0.0.1:41234' } })['HF_ENDPOINT']).toBe('http://127.0.0.1:41234');
  expect(buildLaunchEnv(POLLUTED, PATHS, { extra: { HF_ENDPOINT: 'http://localhost:9' } })['HF_ENDPOINT']).toBe('http://localhost:9');
  expect(buildLaunchEnv(POLLUTED, PATHS, { extra: { HF_ENDPOINT: 'http://[::1]:9' } })['HF_ENDPOINT']).toBe('http://[::1]:9');   // as policy.ts accepts it
  for (const bad of ['https://huggingface.co', 'http://example.com:9', 'http://127.0.0.1.evil.com:9', 'http://user@127.0.0.1:9', '']) {
    expect(() => buildLaunchEnv(POLLUTED, PATHS, { extra: { HF_ENDPOINT: bad } }), bad).toThrow(/loopback/);
  }
});

test('the run dir must be a realpath-shaped hfcm-e2e-* dir and every path must be strictly inside it', () => {
  expect(() => buildLaunchEnv(POLLUTED, { ...PATHS, root: '/tmp/hfcm-fx-1' })).toThrow(/run dir/);
  expect(() => buildLaunchEnv(POLLUTED, { ...PATHS, root: 'tmp/hfcm-e2e-1' })).toThrow(/run dir/);
  for (const k of ['hubRoot', 'configPath', 'hfHome', 'home', 'userDataDir'] as const) {
    expect(() => buildLaunchEnv(POLLUTED, { ...PATHS, [k]: `/home/user/${k}` }), k).toThrow(/outside the run dir/);
    expect(() => buildLaunchEnv(POLLUTED, { ...PATHS, [k]: ROOT }), k).toThrow(/outside the run dir/);
    expect(() => buildLaunchEnv(POLLUTED, { ...PATHS, [k]: `${ROOT}-x/a` }), k).toThrow(/outside the run dir/);
  }
});

test('the app is never launched with its cwd inside the run dir', () => {
  expect(launchCwd('/repo', ROOT)).toBe('/repo');
  expect(() => launchCwd(`${ROOT}/x`, ROOT)).toThrow(/cwd/);
  expect(() => launchCwd(ROOT, ROOT)).toThrow(/cwd/);
});

test('every launch keeps the Chromium sandbox on and never uses the real keyring', () => {
  const o = launchOptions('/repo/out/main/index.js', { HOME: PATHS.home }, '/repo');
  expect(o).toEqual({
    args: ['--password-store=basic', '/repo/out/main/index.js'], env: { HOME: PATHS.home }, cwd: '/repo', chromiumSandbox: true,
  });
  expect(o.args.some((a) => a.includes('no-sandbox'))).toBe(false);
});

test('every launch mode turns GPU detection off (the app never runs nvidia-smi under the E2E suite)', () => {
  for (const mode of ['guarded', 'first-run'] as const) expect(buildLaunchEnv(POLLUTED, PATHS, { mode })['HFCM_NO_GPU_DETECT'], mode).toBe('1');
  expect(buildLaunchEnv(POLLUTED, PATHS, { extra: { HFCM_E2E_AUTO_EMPTY_GRACE_MS: '4000' } })['HFCM_NO_GPU_DETECT']).toBe('1');
});
