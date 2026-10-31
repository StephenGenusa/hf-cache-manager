import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { findNetwork, NETWORK_ALLOWLIST, networkAllowed } from './forbidden';

// Global fetch, node:http/https/net/tls and undici only in src/main/hub/**, src/main/core-port.ts,
// tests/**, e2e/**.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPECTED = ['src/main/hub/**', 'src/main/core-port.ts', 'tests/**', 'e2e/**'];
const EXT = /\.(ts|tsx|js|mjs|cjs|mts|cts)$/;
const eslint = new ESLint({ cwd: root });

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const res = (await eslint.lintText(code, { filePath: path.join(root, filePath) }))[0]!;
  return res.messages.map((m) => m.ruleId ?? 'parse-error');
}
const NET_RULES = ['no-restricted-imports', 'no-restricted-syntax', 'no-restricted-globals'];

async function walk(dir: string, out: string[]): Promise<void> {
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    const st = await lstat(full);
    if (st.isDirectory()) await walk(full, out);
    else if (st.isFile() && EXT.test(name)) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
}

describe('network allow-list', () => {
  it('is exactly the allow-list globs, in the scan and in eslint.config.js', async () => {
    expect([...NETWORK_ALLOWLIST]).toEqual(EXPECTED);
    const cfg = (await import(pathToFileURL(path.join(root, 'eslint.config.js')).href)) as { NET_ALLOWLIST: string[] };
    expect(cfg.NET_ALLOWLIST).toEqual(EXPECTED);
  });

  it.each([
    ['src/main/hub/client.ts', true], ['src/main/hub/x/y.ts', true], ['src/main/core-port.ts', true],
    ['tests/x.test.ts', true], ['e2e/a.spec.ts', true],
    ['src/main/hub.ts', false], ['src/main/hubx/a.ts', false], ['src/main/core-port.tsx', false],
    ['src/main/x/core-port.ts', false], ['src/core/x.ts', false], ['scripts/x.mjs', false], ['testsx/a.ts', false],
  ])('networkAllowed(%s) = %s', (rel, ok) => expect(networkAllowed(rel)).toBe(ok));
});

describe('findNetwork', () => {
  it.each([
    ["await fetch('https://x')", 'global-fetch'],
    ['globalThis.fetch(u)', 'global-fetch'],
    ["window['fetch'](u)", 'global-fetch'],
    ['self?.fetch', 'global-fetch'],
    ["import http from 'node:http';", 'net-module'],
    ["import https from 'https';", 'net-module'],
    ["require('net')", 'net-module'],
    ['await import(`node:tls`)', 'net-module'],
    ["import { request } from 'undici';", 'net-module'],
    ["import x from 'undici/lib/x';", 'net-module'],
    ["import { net } from 'electron';", 'electron-net'],
    ["import { app, net as n } from 'electron';", 'electron-net'],
    ['electron.net.request(u)', 'electron-net'],
  ])('flags %s', (src, id) => expect(findNetwork(src)).toContain(id));

  it.each([
    'ctx.fetch(url, init)',
    'deps.fetch',
    'fetch: FetchLike;',
    'void library.refetch()',
    "url.protocol === 'http:'",
    "const s = 'network';",
    "import { app } from 'electron';",
  ])('allows %s', (src) => expect(findNetwork(src)).toEqual([]));
});

describe('source tree', () => {
  it('names no network API outside the allow-list (src/, scripts/, root config files)', async () => {
    const files: string[] = [];
    await walk(path.join(root, 'src'), files);
    await walk(path.join(root, 'scripts'), files);
    for (const name of await readdir(root)) if (EXT.test(name) && name !== 'eslint.config.js') files.push(name);
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const rel of files) {
      if (networkAllowed(rel)) continue;
      for (const id of findNetwork(await readFile(path.join(root, rel), 'utf8'))) hits.push(`${rel}: ${id}`);
    }
    expect(hits).toEqual([]);
  });

  it('positive control: the allow-listed files do name the network', async () => {
    expect(findNetwork(await readFile(path.join(root, 'src/main/hub/client.ts'), 'utf8'))).toContain('global-fetch');
    expect(findNetwork(await readFile(path.join(root, 'src/main/core-port.ts'), 'utf8'))).toContain('global-fetch');
  });
});

describe('eslint network bans', () => {
  it.each([
    ['src/main/x.ts', "await fetch('https://x');", 'no-restricted-globals'],
    ['src/main/x.ts', 'const f = fetch;', 'no-restricted-globals'],
    ['src/main/x.ts', 'globalThis.fetch(u);', 'no-restricted-syntax'],
    ['src/main/x.ts', "globalThis['fetch'](u);", 'no-restricted-syntax'],
    ['src/main/x.ts', 'const { fetch: f } = globalThis;', 'no-restricted-syntax'],
    ['src/renderer/x.tsx', 'window.fetch(u);', 'no-restricted-syntax'],
    ['src/renderer/x.tsx', 'void fetch(u);', 'no-restricted-globals'],
    ['src/core/x.ts', "import http from 'node:http';", 'no-restricted-imports'],
    ['src/main/x.ts', "import https from 'https';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { connect } from 'node:net';", 'no-restricted-imports'],
    ['src/main/x.ts', "import * as tls from 'tls';", 'no-restricted-imports'],
    ['src/main/x.ts', "import h2 from 'node:http2';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { request } from 'undici';", 'no-restricted-imports'],
    ['src/main/x.ts', "import x from 'undici/lib/x';", 'no-restricted-imports'],
    ['src/main/x.ts', "export * from 'node:https';", 'no-restricted-imports'],
    ['src/main/x.ts', "const h = require('node:http');", 'no-restricted-syntax'],
    ['src/main/x.ts', "const h = await import('https');", 'no-restricted-syntax'],
    ['src/main/x.ts', 'const h = await import(`undici`);', 'no-restricted-syntax'],
    ['src/main/x.ts', "import { net } from 'electron';", 'no-restricted-syntax'],
    ['src/main/x.ts', "import electron from 'electron'; electron.net.fetch(u);", 'no-restricted-syntax'],
    ['src/main/x.ts', 'const g = globalThis; g.fetch(u);', 'no-restricted-syntax'],
    ['src/renderer/x.tsx', 'const w = window;', 'no-restricted-syntax'],
    ['src/main/x.ts', "Reflect.get(globalThis, 'fetch')(u);", 'no-restricted-syntax'],
    ["src/main/x.ts", "const { net } = require('electron');", 'no-restricted-syntax'],
    ['src/main/hub.ts', "import http from 'node:http';", 'no-restricted-imports'],
    ['src/main/hubx/a.ts', 'await fetch(u);', 'no-restricted-globals'],
    ['src/main/core-port2.ts', 'globalThis.fetch(u);', 'no-restricted-syntax'],
    ['src/main/hardware.ts', 'await fetch(u);', 'no-restricted-globals'],
    ['src/main/user-data.ts', "import http from 'node:http';", 'no-restricted-imports'],
    ['src/core/fsx.ts', "import net from 'node:net';", 'no-restricted-imports'],
    ['scripts/x.mjs', "import http from 'node:http';", 'no-restricted-imports'],
    ['electron.vite.config.ts', 'await fetch(u);', 'no-restricted-globals'],
  ])('%s: %s is rejected by %s', async (filePath, code, rule) => {
    expect(await ruleIds(filePath, code)).toContain(rule);
  });

  it.each([
    ['src/main/hub/client.ts', "await fetch(u); globalThis.fetch(u); import http from 'node:http';"],
    ['src/main/hub/deep/x.ts', "import { request } from 'undici'; const h = await import('node:https');"],
    ['src/main/core-port.ts', 'const f = (u, i) => globalThis.fetch(u, i);'],
    ['tests/main/x.test.ts', "import http from 'node:http'; import type { AddressInfo } from 'node:net'; await fetch(u);"],
    ['tests/helpers/fake-hub.ts', "import http from 'node:http';"],
    ['tests/helpers/tmp.ts', "import http from 'node:http'; await fetch(u);"],
    ['e2e/x.spec.ts', "import http from 'node:http'; await fetch(u);"],
    ['src/main/x.ts', "import type { AddressInfo } from 'node:net';"],
    ['src/main/x.ts', 'export async function f(fetch: typeof globalThis.fetch) { return fetch(u); }'],
    ['src/core/x.ts', 'ctx.fetch(u); deps.fetch; const o = { fetch: f };'],
  ])('%s: %s is allowed', async (filePath, code) => {
    const ids = await ruleIds(filePath, code);
    for (const r of NET_RULES) expect(ids).not.toContain(r);
  });
});
