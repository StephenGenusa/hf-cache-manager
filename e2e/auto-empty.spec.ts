import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, ageDeletion, filesByInode, filesWithContent, heldIds, holdGroups, inodeOf, sha256Of, test, QWEN } from './harness';

const GRACE_MS = 4000;

test('auto-empty: the pending notice shows its deadline after the first scan, and dismissing it keeps the items', async ({ fx, launch }) => {
  const payload = inodeOf(fx.qwen.blobOf('Qwen3.6-27B-Q8_0.gguf'));
  const first = await launch();
  await holdGroups(first.page, QWEN, ['quant:Q8_0']);
  await first.app.close();
  const [id] = heldIds(fx);
  await ageDeletion(fx, id!, 20);

  const { page } = await launch({ HFCM_E2E_AUTO_EMPTY_GRACE_MS: String(GRACE_MS) });
  const notice = page.getByTestId('startup-notice').filter({ hasText: 'emptied' });
  await expect(notice).toBeVisible();
  await expect(notice.getByTestId('notice-countdown')).toContainText('will be emptied at');
  const shownAt = Date.now();   // the countdown started at or before this moment (it is armed when the notice is delivered)
  await notice.getByTestId('notice-dismiss').click();
  await expect(notice).toHaveCount(0);
  await page.waitForTimeout(Math.max(0, shownAt + GRACE_MS + 3000 - Date.now()));   // well past the deadline
  expect(heldIds(fx)).toEqual([id]);
  expect(existsSync(join(fx.holdRoot, id!, 'manifest.json'))).toBe(true);
  // the held payload is still on disk, inside its deletion folder
  expect((filesByInode(fx.root).get(payload) ?? [])[0]?.startsWith(join(fx.holdRoot, id!) + '/')).toBe(true);
  await page.getByTestId('nav-recently-deleted').click();
  await expect(page.locator(`[data-deletion-id="${id!}"]`)).toBeVisible();
});

test('auto-empty: without a dismissal the announced items are emptied once the grace period ends', async ({ fx, launch }) => {
  const payload = inodeOf(fx.qwen.blobOf('Qwen3.6-27B-Q8_0.gguf'));
  const first = await launch();
  await holdGroups(first.page, QWEN, ['quant:Q8_0']);
  await first.app.close();
  const [id] = heldIds(fx);
  await ageDeletion(fx, id!, 20);

  const { page } = await launch({ HFCM_E2E_AUTO_EMPTY_GRACE_MS: String(GRACE_MS) });
  await expect(page.getByTestId('startup-notice').filter({ hasText: 'emptied' }).getByTestId('notice-countdown')).toBeVisible();
  const held = filesByInode(fx.root).get(payload) ?? [];   // held, not yet emptied
  expect(held).toHaveLength(1);
  const bytes = sha256Of(held[0]!);
  await expect.poll(() => heldIds(fx), { timeout: GRACE_MS * 5 }).toEqual([]);
  // emptied: the payload is gone from disk, not just its folder entry
  expect(filesWithContent(fx.root, bytes)).toEqual([]);
  expect(existsSync(fx.qwen.blobOf('Qwen3.6-27B-Q8_0.gguf'))).toBe(false);
});
