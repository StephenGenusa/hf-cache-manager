import { appendFile } from 'node:fs/promises';
import { treeDigest } from '../tests/helpers/tree-digest';
import { expect, openRepo, selectGroups, test, QWEN } from './harness';

test('a cache change between review and confirm is refused and nothing is touched', async ({ fx, page }) => {
  await openRepo(page, QWEN);
  await selectGroups(page, ['quant:Q8_0']);
  await page.getByTestId('btn-review').click();
  const dlg = page.getByTestId('review-dialog');
  await dlg.getByTestId('confirm-input').fill(QWEN);
  await expect(dlg.getByTestId('btn-permanent')).toBeEnabled();
  await appendFile(fx.qwen.blobOf('Qwen3.6-27B-Q8_0.gguf'), 'x');
  const before = await treeDigest(fx.root);
  await dlg.getByTestId('btn-permanent').click();
  await expect(dlg.getByTestId('stale-message').getByText('The cache changed since you reviewed — please review again.', { exact: true })).toBeVisible();
  await expect(dlg.getByTestId('btn-permanent')).toBeDisabled();
  // Invariant: no user or cache file is touched; only the app's lock folder may be created. The refused execute takes the
  // AppLock (dirname(hub)/.hf-cache-manager) before re-checking the fingerprint, and leaves that folder empty.
  const after = await treeDigest(fx.root);
  const appData = 'hf/.hf-cache-manager';
  if (before[appData] === undefined && after[appData] === 'dir') {
    expect(Object.keys(after).filter((k) => k.startsWith(`${appData}/`))).toEqual([]);
    delete after[appData];
  }
  expect(after).toEqual(before);
  await dlg.getByTestId('btn-review-again').click();
  await expect(page.getByTestId('review-dialog').getByTestId('stat-freed')).toHaveAttribute('data-bytes', '2871');
});
