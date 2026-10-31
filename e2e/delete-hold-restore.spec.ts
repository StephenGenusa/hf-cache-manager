import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { treeDigest } from '../tests/helpers/tree-digest';
import { COMMIT } from '../tests/helpers/app-fixture';
import { expect, expectLogged, filesByInode, heldIds, inodeOf, openRepo, selectGroups, test, QWEN } from './harness';

test('select → review → Move to Recently Deleted → restore', async ({ fx, page }) => {
  const hubBefore = await treeDigest(fx.hubRoot);
  const moved = ['Qwen3.6-27B-Q8_0.gguf', 'BF16/Qwen3.6-27B-BF16-00001-of-00002.gguf', 'BF16/Qwen3.6-27B-BF16-00002-of-00002.gguf'];
  const payload = new Map(moved.map((f) => [f, inodeOf(fx.qwen.blobOf(f))]));
  await openRepo(page, QWEN);
  await selectGroups(page, ['quant:Q8_0', 'quant:BF16']);
  await expect(page.getByTestId('action-bar-freed')).toHaveAttribute('data-bytes', '8250');
  await page.keyboard.press('Control+Backspace');
  const dlg = page.getByTestId('review-dialog');
  await expect(dlg.getByTestId('stat-files')).toHaveText(/3/);
  await expect(dlg.getByTestId('hold-note')).toContainText('freed when Recently Deleted is emptied');
  await dlg.getByTestId('btn-hold').click();
  await expectLogged(page, 'Moved to Recently Deleted · 0 B freed now · 8.3 kB held');
  await expect(page.getByTestId('result-toast')).toHaveCount(0); // a success shows no popup
  expect(existsSync(fx.qwen.file('Qwen3.6-27B-Q8_0.gguf'))).toBe(false);
  const ids = heldIds(fx);
  expect(ids).toHaveLength(1);
  const id = ids[0]!;
  const held = join(fx.holdRoot, id, 'models--unsloth--Qwen3.6-27B-GGUF', 'snapshots', COMMIT, 'Qwen3.6-27B-Q8_0.gguf');
  expect(lstatSync(held).isSymbolicLink()).toBe(true);
  expect(existsSync(join(fx.lmstudioRoot, 'unsloth/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q8_0.gguf'))).toBe(false);
  // every payload (Q8_0 and both BF16 shards) was moved, not copied or deleted: its inode now lives only in the deletion folder
  const byIno = filesByInode(fx.root);
  for (const [f, ino] of payload) {
    expect(existsSync(fx.qwen.file(f)), f).toBe(false);
    expect(existsSync(fx.qwen.blobOf(f)), f).toBe(false);
    const where = byIno.get(ino) ?? [];
    expect(where, f).toHaveLength(1);
    expect(where[0]!.startsWith(join(fx.holdRoot, id) + '/'), f).toBe(true);
  }

  await page.getByTestId('nav-recently-deleted').click();
  await page.locator(`[data-deletion-id="${id}"]`).getByTestId('btn-restore').click();
  await page.getByTestId('review-dialog').getByTestId('btn-restore-confirm').click();
  await expect(page.getByTestId('result-toast').filter({ hasText: 'Restored' })).toBeVisible();
  expect(await treeDigest(fx.hubRoot)).toEqual(hubBefore);
  expect(readdirSync(join(fx.holdRoot)).filter((n) => n === id)).toEqual([]);
  await page.getByRole('button', { name: 'Open Sync preview' }).click();
  await expect(page.getByTestId('sync-add').filter({ hasText: 'Qwen3.6-27B-Q8_0.gguf' })).toBeVisible();
});
