import { expect, openRepo, test, QWEN } from './harness';

/** The E2E machine: a fixed 24 GB NVIDIA Linux PC, so the test never reads the real machine's GPU. */
const MACHINE = JSON.stringify({
  platform: 'linux', gpuName: 'Test GPU', gpuBytes: 24 * 2 ** 30, gpuKind: 'nvidia', computeCap: 8.9, drivesDisplay: false, ramBytes: 64 * 2 ** 30,
});

test('keep advice tints the one best quant green, shows the basis line and hints on name parts', async ({ launch }) => {
  const { page } = await launch({ HFCM_E2E_MACHINE: MACHINE });
  await openRepo(page, QWEN);
  await expect(page.getByTestId('advice-basis-text')).toHaveText(/^Linux · Test GPU 24 GB · 64 GB RAM · 32K context · /);
  // every Qwen quant carries a readable header, so all were compared: BF16 (the most bits per weight) is the one green
  // quant row; the other green row is the mmproj (needed for images)
  await expect(page.locator('[data-testid="group-row"][data-group-key^="quant:"][data-tint="green"]')).toHaveCount(1);
  await expect(page.locator('[data-group-key="quant:BF16"]')).toHaveAttribute('data-tint', 'green');
  const otherGreens = page.locator('[data-testid="group-row"][data-tint="green"]:not([data-group-key^="quant:"])');
  await expect(otherGreens).toHaveCount(1);
  await expect(otherGreens).toHaveAttribute('data-group-key', /^mmproj:/);
  await expect(page.locator('[data-group-key="quant:Q8_0"]')).not.toHaveAttribute('data-tint', 'green');   // compared, and not the pick
  await page.locator('[data-group-key="quant:Q8_0"]').getByTestId('name-part-known').filter({ hasText: 'Q8_0' }).first().hover();
  await expect(page.getByRole('tooltip')).toContainText('bits per weight');
});
