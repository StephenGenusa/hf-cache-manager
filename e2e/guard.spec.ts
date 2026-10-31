import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { treeDigest } from '../tests/helpers/tree-digest';
import { makeTempRoot, removeTempRoot } from '../tests/helpers/tmp';
import { expect, launchApp, launchExpectingExit, test, withFirstRun } from './harness';

test('a hub outside the run dir makes the app refuse to start, writing nothing there', async ({ fx }) => {
  const elsewhere = await makeTempRoot('hfcm-t-');
  try {
    const hub = join(elsewhere, 'hub');
    await mkdir(join(hub, 'models--a--b', 'blobs'), { recursive: true });
    await writeFile(join(hub, 'models--a--b', 'blobs', 'x'), 'payload\n');
    const before = await treeDigest(elsewhere);
    const exit = await launchExpectingExit(fx, { HF_HUB_CACHE: hub });
    // The guard's message is printed only by exitEarly, immediately before process.exit(1).
    expect(exit.output).toContain('HFCM_E2E is set but the hub is outside the temp dir');
    // The exit code is 1 (not a crash or a quit with 0). The one exception: when the exit races Playwright's attach,
    // Playwright kills the already-exiting process while tearing its failed launch down, and only its <kill> is visible.
    expect(exit.code === 1 || (exit.code === null && exit.output.includes('<kill>')), exit.output).toBe(true);
    expect(await treeDigest(elsewhere)).toEqual(before);
    expect(readdirSync(elsewhere)).toEqual(['hub']);
    // refused by the pre-check, before Electron took its lock or wrote a profile: even the run dir's userData is untouched
    expect(readdirSync(fx.userDataDir)).toEqual([]);
    // control: the same launch without the outside hub starts normally, so the hub alone is what was refused
    const { app, page } = await launchApp(fx);
    try {
      await expect(page.getByTestId('repo-row').first()).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    await removeTempRoot(elsewhere);
  }
});

test('first launch with an isolated HOME and no userData override creates the default userData folder', async ({ fx }) => {
  expect(readdirSync(fx.home)).toEqual([]);
  await withFirstRun(fx, async ({ page, userData }) => {
    await expect(page.getByTestId('repo-row').first()).toBeVisible();
    expect(userData.startsWith(join(fx.home, '.config') + '/')).toBe(true);
    expect(existsSync(userData)).toBe(true);
  });
});
