import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, openRepo, test, QWEN, REPO_IDS } from './harness';

test('the built app scans the fixture in its worker and serves the renderer over the real IPC', async ({ fx, app, page }) => {
  const main = await app.evaluate(({ app: a }) => ({
    userData: a.getPath('userData'), env: { ...process.env }, cwd: process.cwd(), argv: process.argv,
    noSandbox: a.commandLine.hasSwitch('no-sandbox'), passwordStore: a.commandLine.getSwitchValue('password-store'),
  }));
  expect(main.passwordStore).toBe('basic');
  // no session bus: Electron itself sets the 'disabled:' sentinel when the launch env has none
  expect(['disabled:', undefined]).toContain(main.env['DBUS_SESSION_BUS_ADDRESS']);
  for (const k of ['LD_PRELOAD', 'NODE_OPTIONS', 'XDG_RUNTIME_DIR', 'HF_TOKEN', 'HUGGINGFACE_CO_STAGING', 'ELECTRON_RENDERER_URL']) {
    expect(main.env[k], k).toBeUndefined();
  }
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'HF_HOME']) expect(main.env[k]?.startsWith(`${fx.root}/`), k).toBe(true);
  expect(main.noSandbox).toBe(false);
  expect(main.argv.filter((x) => x.includes('no-sandbox'))).toEqual([]);
  expect(main.env['HFCM_E2E']).toBe('1');
  expect(main.env['HFCM_E2E_ROOT']).toBe(fx.root);
  expect(main.env['HOME']).toBe(fx.home);
  expect(main.env['HF_HUB_CACHE']).toBe(fx.hubRoot);
  expect(main.env['HFHUB_CONFIG']).toBe(fx.configFile);
  expect(main.userData).toBe(fx.userDataDir);
  expect(main.cwd.startsWith(fx.root)).toBe(false);

  for (const id of REPO_IDS) await expect(page.locator(`[data-testid="repo-row"][data-repo-id="${id}"]`)).toHaveCount(1);
  await openRepo(page, QWEN);
  for (const k of ['quant:Q8_0', 'quant:BF16', 'quant:Q6_K']) await expect(page.locator(`[data-group-key="${k}"]`)).toBeVisible();
  await page.keyboard.press('/');
  await page.keyboard.type('FLUX');
  await expect(page.getByTestId('repo-row')).toHaveCount(1);
});

test('settings show the fixture paths and the auto-empty choice is saved in userData only', async ({ fx, page }) => {
  await page.getByTestId('nav-settings').click();
  const view = page.getByTestId('settings-view');
  await expect(view.getByTestId('set-hub')).toContainText(fx.hubRoot);
  await expect(view.getByTestId('set-config')).toContainText(fx.configFile);
  await expect(view.getByTestId('set-view-lmstudio')).toContainText(fx.lmstudioRoot);
  await expect(view.getByTestId('auto-empty-select')).toHaveValue('14');
  await view.getByTestId('auto-empty-select').selectOption('never');
  await expect(view.getByTestId('auto-empty-select')).toHaveValue('never');
  const saved = (): unknown => {
    try {
      return JSON.parse(readFileSync(join(fx.userDataDir, 'settings.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  // The file also keeps the advice block (the defaults here); auto-empty is the only change
  await expect.poll(saved).toEqual({
    autoEmptyDays: null,
    advice: { gpuBytes: null, gpuKind: null, ramBytes: null, drivesDisplay: null, context: 32768, kvType: 'f16', tools: null },
  });
});
