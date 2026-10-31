// Every Electron launch in the E2E suite must go through the shared `launchOptions` (chromiumSandbox: true and
// --password-store=basic): Playwright otherwise prepends --no-sandbox on Linux.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const dir = join(import.meta.dirname, '..', '..', 'e2e');
const files = readdirSync(dir).filter((n) => n.endsWith('.ts')).map((n) => ({ name: n, text: readFileSync(join(dir, n), 'utf8') }));

test('every electron.launch( call takes launchOptions( directly', () => {
  const calls = files.flatMap((f) => [...f.text.matchAll(/\.launch\(\s*([^\s(]*)/g)].map((m) => `${f.name}: ${m[1] ?? ''}`));
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((c) => !c.endsWith(': launchOptions'))).toEqual([]);
});

test('only the harness imports Playwright\'s Electron launcher, and only launch-env sets the sandbox option', () => {
  expect(files.filter((f) => /import\s*\{[^}]*\b_electron\b/.test(f.text)).map((f) => f.name)).toEqual(['harness.ts']);
  expect(files.filter((f) => /chromiumSandbox/.test(f.text)).map((f) => f.name)).toEqual(['launch-env.ts']);
});
