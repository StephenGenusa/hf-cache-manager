// Playwright harness for the E2E suite. Every test gets its own fixture cache built in a fresh
// `mkdtemp(<tmpdir>/hfcm-e2e-)` run dir, launches the BUILT app (out/main/index.js) with an env that points every
// location the app can touch into that run dir (e2e/launch-env.ts), and in teardown closes the app, checks every canary
// (sha256 + inode) and removes the run dir through the test helpers (which refuse anything outside the temp base).
//
// Safety layers, outermost first: the env builder drops every real location from the parent env and refuses paths
// outside the run dir; the app's own E2E pre-check and guard (src/main/env-guard.ts) refuse to start otherwise; canaries
// beside the hub, the view root, the run dir and in a separate sandbox prove after each test that nothing else moved.
import { _electron as electron, expect, test as base } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardTestEnv } from '../src/main/env-guard';
import { DELETION_ID_RE } from '../src/core/hold/manifest';
import { buildAppFixture, type AppFixture } from '../tests/helpers/app-fixture';
import { createCanaryContext, plantStandardCanaries, type Context } from '../tests/helpers/canary-core';
import type { RepoHandle } from '../tests/helpers/fixture';
import { startFakeHub, type FakeHub, type FakeHubRepo } from '../tests/helpers/fake-hub';
import { makeTempRoot, removeTempRoot } from '../tests/helpers/tmp';
import { buildLaunchEnv, launchCwd, launchOptions, type LaunchPaths } from './launch-env';

export { expect };

export const QWEN = 'unsloth/Qwen3.6-27B-GGUF';
export const REPO_IDS = [
  QWEN, 'black-forest-labs/FLUX.1-dev', 'org/shared-a', 'org/shared-b', 'org/dupe', 'bartowski/tiny-GGUF', 'org/partial',
] as const;

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mainJs = join(repoRoot, 'out/main/index.js');

export interface E2EFixture extends AppFixture {
  qwen: RepoHandle;
  /** Recently Deleted: `<dirname(hub)>/.hf-cache-manager/recently-deleted`. */
  holdRoot: string;
}

export interface Launched { app: ElectronApplication; page: Page }

function pathsOf(fx: AppFixture): LaunchPaths {
  return { root: fx.root, hubRoot: fx.hubRoot, configPath: fx.configFile, hfHome: fx.hfHome, home: fx.home, userDataDir: fx.userDataDir };
}

async function openWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/** Launches the built app on `fx` with HFCM_E2E always on (the env is built here, never per test). */
export async function launchApp(fx: AppFixture, extraEnv: Record<string, string> = {}): Promise<Launched> {
  const app = await electron.launch(launchOptions(mainJs, buildLaunchEnv(process.env, pathsOf(fx), { extra: extraEnv }), launchCwd(repoRoot, fx.root)));
  try {
    return { app, page: await openWindow(app) };
  } catch (e) {
    await app.close();
    throw e;
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A launch the app must refuse: resolves with its exit code and everything it printed.
 * - If the app exits before Playwright attaches, `launch` throws and its message carries the process log (stderr lines
 *   and `exitCode=N`).
 * - Otherwise stderr/stdout are collected from the process streams until it exits. Lines Playwright's own reader took
 *   before ours was attached come back in the "Browser logs" of any call made after the exit, which is appended too.
 * - An app that is still running after `timeoutMs` is closed and the call fails (a refusal that did not happen).
 */
export async function launchExpectingExit(
  fx: AppFixture, extraEnv: Record<string, string>, timeoutMs = 20_000,
): Promise<{ code: number | null; output: string }> {
  let app: ElectronApplication;
  try {
    app = await electron.launch(launchOptions(mainJs, buildLaunchEnv(process.env, pathsOf(fx), { extra: extraEnv }), launchCwd(repoRoot, fx.root)));
  } catch (e) {
    const text = errText(e);
    const m = /exitCode=(\d+|null)/.exec(text);
    return { code: m === null || m[1] === 'null' ? null : Number(m[1]), output: text };
  }
  const proc = app.process();
  let output = '';
  proc.stderr?.on('data', (b: Buffer) => { output += b.toString(); });
  proc.stdout?.on('data', (b: Buffer) => { output += b.toString(); });
  const exited = proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve(proc.exitCode)
    : new Promise<number | null>((done) => proc.once('exit', (c) => done(c)));
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((done) => { timer = setTimeout(() => done('timeout'), timeoutMs); });
  const code = await Promise.race([exited, timedOut]);
  clearTimeout(timer);
  if (code === 'timeout') {
    await app.close();
    throw new Error(`the app was expected to refuse to start but was still running after ${timeoutMs} ms`);
  }
  try {
    await app.evaluate(() => 0);
  } catch (e) {
    output += `\n${errText(e)}`;
  }
  return { code, output };
}

/**
 * The one unguarded launch: a first start with no HFCM_USER_DATA_DIR, so Electron derives userData from the isolated
 * XDG_CONFIG_HOME. Without HFCM_E2E the app's guard is off, so the harness runs the same guard rules itself on every
 * location the app will use (default userData included) before launching, and refuses to launch unless all are inside
 * the run dir. The app is always closed when `body` ends.
 */
export async function withFirstRun(fx: AppFixture, body: (l: Launched & { userData: string }) => Promise<void>): Promise<void> {
  const env = buildLaunchEnv(process.env, pathsOf(fx), { mode: 'first-run' });
  const configHome = env['XDG_CONFIG_HOME'] ?? '';   // userData defaults to <XDG_CONFIG_HOME>/<app name>
  await guardTestEnv({ ...env, HFCM_E2E: '1' }, {
    hubRoot: fx.hubRoot, userDataDir: configHome, configPath: fx.configFile, viewRoots: [fx.lmstudioRoot], hfHome: fx.hfHome, home: fx.home,
  }, fx.root);
  const app = await electron.launch(launchOptions(mainJs, env, launchCwd(repoRoot, fx.root)));
  try {
    const page = await openWindow(app);
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    await body({ app, page, userData });
  } finally {
    await app.close();
  }
}

// ------------------------------------------------------------------ UI helpers

export async function openRepo(page: Page, repoId: string): Promise<void> {
  await page.locator(`[data-testid="repo-row"][data-repo-id="${repoId}"]`).click();
  await expect(page.getByTestId('repo-detail-header')).toContainText(repoId);
}

export async function selectGroups(page: Page, keys: string[]): Promise<void> {
  for (const k of keys) {
    const box = page.locator(`[data-group-key="${k}"] [role=checkbox]`);
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'true');
  }
}

/** Waits until the session log's newest entry contains `text` (a success shows no popup), then closes the log. */
export async function expectLogged(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId('review-dialog')).toBeHidden();
  await page.getByTestId('btn-session-log').click();
  await expect(page.getByTestId('session-log-entry').filter({ hasText: text }).last()).toBeVisible();
  await page.getByTestId('btn-session-log').click();
}

/** Select → review → Move to Recently Deleted, waiting for the session log entry. */
export async function holdGroups(page: Page, repoId: string, keys: string[]): Promise<void> {
  await openRepo(page, repoId);
  await selectGroups(page, keys);
  await page.getByTestId('btn-review').click();
  await page.getByTestId('review-dialog').getByTestId('btn-hold').click();
  await expectLogged(page, 'Moved to Recently Deleted');
}

/** The deletion folders in Recently Deleted (canaries and anything else that is not a deletion id are ignored). */
export function heldIds(fx: E2EFixture): string[] {
  try {
    return readdirSync(fx.holdRoot).filter((n) => DELETION_ID_RE.test(n)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** Back-dates a held deletion's manifest by `days` (the app is closed), so the next start finds it due for auto-empty. */
export function ageDeletion(fx: E2EFixture, id: string, days: number): void {
  const p = join(fx.holdRoot, id, 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8')) as { createdAt: number };
  m.createdAt -= days * 86_400_000;
  writeFileSync(p, JSON.stringify(m));
}

/** Every regular file under `root` (links not followed), keyed by inode: where a payload lives, wherever it was moved. */
export function filesByInode(root: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.set(st.ino, [...(out.get(st.ino) ?? []), p]);
    }
  };
  walk(root);
  return out;
}

/** sha256 of a file's bytes. */
export function sha256Of(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/**
 * Every regular file under `root` whose content hashes to `sha` (each fixture payload's content is unique). Used for
 * "the payload is gone" checks, where an inode alone could be reused by a file created after the deletion.
 */
export function filesWithContent(root: string, sha: string): string[] {
  return [...filesByInode(root).values()].flat().filter((p) => sha256Of(p) === sha);
}

/** The inode of an existing regular file. */
export function inodeOf(p: string): number {
  const st = lstatSync(p);
  if (!st.isFile()) throw new Error(`${p} is not a regular file`);
  return st.ino;
}

// ------------------------------------------------------------------ fixtures

interface Fixtures {
  fx: E2EFixture;
  /** Launch the app on `fx` (any number of times; every app is closed in teardown). */
  launch: (extraEnv?: Record<string, string>) => Promise<Launched>;
  app: ElectronApplication;
  page: Page;
  /**
   * Starts a loopback fake Hub (and CDN) in the test process; its `endpoint` is what a test passes as the HF_ENDPOINT
   * extra. In teardown (after every app is closed) the hub is closed and the harness asserts that it received requests
   * (the app really used it). Main's hubFetch refuses every non-loopback URL under E2E and counts it; download.spec
   * asserts that count is 0.
   */
  fakeHub: (repos: FakeHubRepo[]) => Promise<FakeHub>;
}

export const test = base.extend<Fixtures>({
  // `playwright` is requested only because a fixture must destructure something (no-empty-pattern)
  fx: async ({ playwright: _playwright }, use, testInfo) => {
    const canaries: Context = createCanaryContext(await makeTempRoot('hfcm-canary-'));
    let violations: string[] = [];
    const errors: unknown[] = [];
    let bodyError: unknown = null;
    try {
      await plantStandardCanaries(canaries);
      const app = await buildAppFixture({ canaries, rootPrefix: 'hfcm-e2e-', qwenGgufHeaders: true });
      const qwen = app.repo(QWEN);
      // beside the hub, beside the view root and in the run dir; the user's own file in the view (never ours to touch)
      await canaries.protect([join(app.lmstudioRoot, 'bartowski/tiny-GGUF/tiny-Q4_K_M.gguf'), app.configFile]);
      await canaries.plant(join(app.root, 'hf', 'beside-hub.bin'));
      await canaries.plant(join(app.root, 'lmstudio', 'beside-view.bin'));
      await canaries.plant(join(app.root, 'run-dir.bin'));
      const holdRoot = join(app.root, 'hf', '.hf-cache-manager', 'recently-deleted');
      await use(Object.assign(app, { qwen, holdRoot }));
    } catch (e) {
      bodyError = e;
    } finally {
      try {
        violations = await canaries.verify();
      } catch (e) {
        errors.push(e);
      }
      for (const fn of canaries.takeCleanups()) {
        try {
          await fn();   // the fixture's dispose: releases its canaries (throws on tampering) and removes the run dir
        } catch (e) {
          errors.push(e);
        }
      }
      try {
        await removeTempRoot(canaries.sandbox);
      } catch (e) {
        errors.push(e);
      }
    }
    // The canary verdict is always reported, also when the test or the setup already failed
    const problems = [...violations.map((v) => `canary violated: ${v}`), ...errors.map((e) => `teardown: ${errText(e)}`)];
    if (problems.length > 0) {
      await testInfo.attach('canary-and-teardown-problems', { body: problems.join('\n'), contentType: 'text/plain' });
      const also = bodyError === null ? '' : `\n(the test itself also failed: ${errText(bodyError)})`;
      throw new Error(`E2E teardown found ${problems.length} problem(s):\n${problems.join('\n')}${also}`);
    }
    if (bodyError !== null) throw bodyError;
  },
  // depends on fakeHub so that every app is closed before the fake Hub is torn down (no request cut off mid-way)
  launch: async ({ fx, fakeHub: _fakeHub }, use) => {
    const apps: ElectronApplication[] = [];
    await use(async (extraEnv = {}) => {
      const l = await launchApp(fx, extraEnv);
      apps.push(l.app);
      return l;
    });
    for (const a of apps) await a.close();
  },
  app: async ({ launch }, use) => {
    const { app, page } = await launch();
    await expect(page.getByTestId('repo-row').first()).toBeVisible();
    await use(app);
  },
  page: async ({ app }, use) => {
    await use(await app.firstWindow());
  },
  fakeHub: async ({ playwright: _playwright }, use) => {
    const hubs: FakeHub[] = [];
    await use(async (repos) => {
      const h = await startFakeHub(repos);
      hubs.push(h);
      return h;
    });
    const problems: string[] = [];
    for (const h of hubs) {
      if (h.requests.length === 0) problems.push('the fake Hub received no request: the app did not use it');
      await h.close();
    }
    if (problems.length > 0) throw new Error(`fake Hub check failed:\n${problems.join('\n')}`);
  },
});
