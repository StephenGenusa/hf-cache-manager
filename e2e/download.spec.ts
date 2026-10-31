import { expect, test, QWEN } from './harness';
import { ggufRepo, GGUF_REPO_ID } from '../tests/helpers/fake-gguf-repo';

/** The E2E machine: a fixed 24 GB NVIDIA Linux PC, so the test never reads the real machine's GPU. */
const MACHINE = JSON.stringify({
  platform: 'linux', gpuName: 'Test GPU', gpuBytes: 24 * 2 ** 30, gpuKind: 'nvidia', computeCap: 8.9, drivesDisplay: false, ramBytes: 64 * 2 ** 30,
});

test('download mode looks up a fake-Hub repo, downloads the best pick and shows it in the library', async ({ launch, fakeHub }) => {
  const hub = await fakeHub([ggufRepo()]);
  const { app, page } = await launch({ HFCM_E2E_MACHINE: MACHINE, HF_ENDPOINT: hub.endpoint });
  await expect(page.getByTestId('repo-row').filter({ hasText: QWEN })).toBeVisible();

  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByTestId('hub-input').fill(GGUF_REPO_ID);
  await page.getByTestId('hub-input').press('Enter');
  await expect(page.getByTestId('dl-row')).toHaveCount(5);   // 3 quants, the mmproj and config.json

  // every quant has a readable header: BF16 (the most bits per weight) is the one green quant row
  await expect(page.locator('[data-testid="dl-row"][data-group-key^="quant:"][data-tint="green"]')).toHaveCount(1);
  await expect(page.locator('[data-group-key="quant:BF16"]')).toHaveAttribute('data-tint', 'green');

  await page.getByRole('button', { name: 'Select the best pick' }).click();
  await expect(page.locator('[data-group-key="quant:BF16"]')).toHaveAttribute('data-checked', 'true');
  await expect(page.getByTestId('download-button')).toBeEnabled();
  await page.getByTestId('download-button').click();

  await page.getByTestId('btn-downloads').click();
  const item = page.getByTestId('download-item').filter({ hasText: GGUF_REPO_ID });
  await expect(item).toBeVisible();
  await expect(item.getByTestId('download-state').first()).toHaveText(/done/i, { timeout: 30_000 });
  await expect(item.getByTestId('download-state').filter({ hasNotText: /done/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close downloads' }).click();

  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByTestId('btn-rescan').click();
  await expect(page.locator(`[data-testid="repo-row"][data-repo-id="${GGUF_REPO_ID}"]`)).toBeVisible({ timeout: 15_000 });
  // the fake Hub served the API and the CDN
  expect(hub.requests.some((r) => r.url.includes('/api/models/acme/tiny-GGUF/revision/'))).toBe(true);
  expect(hub.requests.some((r) => r.url.includes('/cdn/'))).toBe(true);
  // Main refused no request as non-loopback, so nothing was sent anywhere but the fake Hub
  const blocked = await app.evaluate(() => (globalThis as { __hfcmE2E?: { networkBlocked(): number } }).__hfcmE2E?.networkBlocked() ?? -1);
  expect(blocked).toBe(0);
});
