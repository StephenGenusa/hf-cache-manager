import { existsSync, lstatSync } from 'node:fs';
import { expect, expectLogged, filesWithContent, heldIds, openRepo, selectGroups, sha256Of, test, QWEN } from './harness';

test('permanent delete requires typing the full repo id', async ({ fx, page }) => {
  const shards = ['BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', 'BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf'];
  const blobs = shards.map((f) => fx.qwen.blobOf(f));
  const hashes = blobs.map(sha256Of);
  await openRepo(page, QWEN);
  await selectGroups(page, ['quant:BF16']);
  await page.getByTestId('btn-review').click();
  const dlg = page.getByTestId('review-dialog');
  const go = dlg.getByTestId('btn-permanent');
  const input = dlg.getByTestId('confirm-input');
  await expect(go).toBeDisabled();
  await input.fill('unsloth/Qwen3.6-27B-GG');
  await expect(go).toBeDisabled();
  await input.fill('Unsloth/Qwen3.6-27B-GGUF');
  await expect(go).toBeDisabled();
  await input.fill(QWEN);
  await expect(go).toBeEnabled();
  await go.click();
  await expectLogged(page, 'Deleted · 5.4 kB freed');
  await expect(page.getByTestId('result-toast')).toHaveCount(0); // a success shows no popup
  expect(existsSync(fx.qwen.file('BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf'))).toBe(false);
  expect(existsSync(fx.qwen.file('BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf'))).toBe(false);
  expect(heldIds(fx)).toEqual([]); // nothing held
  // the payloads themselves are gone: no blob path, and no file anywhere in the run dir holds their bytes
  for (const b of blobs) expect(existsSync(b), b).toBe(false);
  for (const h of hashes) expect(filesWithContent(fx.root, h)).toEqual([]);
  expect(lstatSync(fx.qwen.file('Qwen3.6-27B-Q8_0.gguf')).isSymbolicLink()).toBe(true);
});
