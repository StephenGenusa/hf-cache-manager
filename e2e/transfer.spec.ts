import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, expectLogged, holdGroups, openRepo, selectGroups, test } from './harness';

const TINY = 'bartowski/tiny-GGUF';
const QUANT = 'quant:Q4_K_M';

/**
 * Export to drive, then Load from USB, through the real UI of the built app. The "drive" is a folder inside the run
 * dir named by HFCM_TRANSFER_ROOTS (the app searches for no real drive under E2E). The quant is exported, moved to
 * Recently Deleted so the cache no longer has it, and loaded back from the drive.
 */
test('a quant is exported to a drive, removed from the cache and loaded back from the drive', async ({ fx, launch }) => {
  const usb = join(fx.root, 'usb');
  mkdirSync(usb);
  const { page } = await launch({ HFCM_TRANSFER_ROOTS: usb });

  // Export
  await openRepo(page, TINY);
  await selectGroups(page, [QUANT]);
  await page.getByTestId('btn-export').click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog.getByTestId('export-volume')).toHaveCount(1);
  await expect(dialog.getByTestId('export-preview')).toContainText('1 file to copy');
  await dialog.getByTestId('export-start').click();
  await expect(dialog).toBeHidden();
  const exported = page.getByTestId('export-item');
  await expect(exported.getByTestId('export-state')).toHaveText('Done', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Close downloads' }).click();
  expect(readdirSync(usb)).toEqual(['hf-cache-manager-transfer']);
  expect(readdirSync(join(usb, 'hf-cache-manager-transfer')).sort()).toEqual(['FORMAT', 'manifests', 'objects']);
  expect(readdirSync(join(usb, 'hf-cache-manager-transfer', 'manifests'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();

  // The cache loses the quant
  await holdGroups(page, TINY, [QUANT]);

  // Load from USB
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByTestId('btn-load-usb').click();
  const onDrive = page.getByTestId('drive-repo').filter({ hasText: TINY });
  await expect(onDrive).toBeVisible();
  await onDrive.click();
  await expect(page.getByTestId('lookup-from-drive')).toBeVisible();
  const row = page.locator(`[data-testid="dl-row"][data-group-key="${QUANT}"]`);
  await expect(row).toBeVisible();
  await row.getByTestId('dl-checkbox').click();
  await expect(page.getByTestId('download-button')).toBeEnabled();
  await expect(page.getByTestId('download-button')).toContainText('Load');
  await page.getByTestId('download-button').click();

  await page.getByTestId('btn-downloads').click();
  const item = page.getByTestId('download-item').filter({ hasText: TINY });
  await expect(item.getByTestId('download-from-drive')).toBeVisible();
  await expect(item.getByTestId('download-state').first()).toHaveText(/done/i, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Close downloads' }).click();

  // Back in the library, with the quant in the cache again
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByTestId('btn-rescan').click();
  await openRepo(page, TINY);
  await expect(page.locator(`[data-group-key="${QUANT}"]`)).toBeVisible({ timeout: 15_000 });
  await expectLogged(page, `Downloaded ${TINY}`);
});

test('with no drive connected, Export says so and Load from USB finds nothing', async ({ launch }) => {
  const { page } = await launch();
  await openRepo(page, TINY);
  await selectGroups(page, [QUANT]);
  await page.getByTestId('btn-export').click();
  await expect(page.getByTestId('export-no-drive')).toBeVisible();
  await expect(page.getByTestId('export-start')).toBeDisabled();
  await page.getByTestId('export-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByTestId('btn-load-usb').click();
  await expect(page.getByTestId('drive-none')).toBeVisible();
});
