import { defineConfig } from '@playwright/test';

// README screenshots (npm run screenshots): not part of the E2E suite. Same run-dir isolation as playwright.config.ts.
export default defineConfig({
  testDir: 'e2e/screenshots',
  testMatch: '*.shots.ts',
  globalSetup: './tests/global-run-tmp.ts',
  workers: 1,
  timeout: 120_000,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/screenshots',
});
