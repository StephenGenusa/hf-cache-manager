import { defineConfig } from '@playwright/test';

// E2E runs the built app (`npm run e2e` builds first). One worker: each test launches its own Electron on its own
// fixture, and the tests must never race over a shared display or temp base.
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './tests/global-run-tmp.ts',
  workers: 1,
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
});
