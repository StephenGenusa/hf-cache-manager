import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './harness';

test('sync preview then execute adds links and leaves foreign files alone', async ({ fx, page }) => {
  const foreign = join(fx.lmstudioRoot, 'bartowski/tiny-GGUF/tiny-Q4_K_M.gguf');
  await page.getByTestId('btn-sync').click();
  const dlg = page.getByTestId('sync-dialog');
  await expect(dlg.getByTestId('sync-add').filter({ hasText: 'Qwen3.6-27B-Q6_K.gguf' })).toBeVisible();
  await expect(dlg.locator('[data-testid="sync-foreign"][data-key="lmstudio:bartowski/tiny-GGUF/tiny-Q4_K_M.gguf"]')).toBeVisible();
  await dlg.getByTestId('btn-sync-execute').click();
  await expect(dlg).toContainText('LM Studio:');
  expect(readlinkSync(join(fx.lmstudioRoot, 'unsloth/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q6_K.gguf'))).toBe(fx.qwen.blobOf('Qwen3.6-27B-Q6_K.gguf'));
  expect(readFileSync(foreign, 'utf8')).toBe('user file\n');
});
