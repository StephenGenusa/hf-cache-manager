import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const res = (await eslint.lintText(code, { filePath: path.join(root, filePath) }))[0]!;
  return res.messages.map((m) => m.ruleId ?? 'parse-error');
}

describe('eslint bans', () => {
  it.each([
    ['src/core/x.ts', "import { app } from 'electron';", 'no-restricted-imports'],
    ['src/core/x.ts', "const e = await import('electron');", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { exec } from 'node:child_process';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { rm } from 'node:fs/promises';", 'no-restricted-syntax'],
    ['src/main/x.ts', "import * as fs from 'node:fs'; fs.rmSync('a', { recursive: true });", 'no-restricted-syntax'],
    ['src/main/x.ts', "import fsp from 'node:fs/promises'; await fsp.rm('a');", 'no-restricted-syntax'],
    ['src/main/x.ts', "import * as fs from 'node:fs'; fs.rmdirSync('a', { recursive: true });", 'no-restricted-syntax'],
    ['src/main/x.ts', "import rimraf from 'rimraf';", 'no-restricted-imports'],
    ['src/main/x.ts', "import del from 'del';", 'no-restricted-imports'],
    ['src/main/x.ts', "import fse from 'fs-extra';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { shell } from 'electron'; await shell.trashItem('a');", 'no-restricted-syntax'],
    ['src/core/x.ts', "import rimraf from 'rimraf';", 'no-restricted-imports'],
    ['src/core/x.ts', "import * as fs from 'node:fs'; fs.rmSync('a');", 'no-restricted-syntax'],
    ['src/main/x.ts', "import fs from 'node:fs'; fs['rm'](p, { recursive: true });", 'no-restricted-syntax'],
    ['src/main/x.ts', "import fs from 'node:fs'; const f = fs.rm;", 'no-restricted-syntax'],
    ['src/main/x.ts', "import fs from 'node:fs'; [a].map(fs.promises.rm);", 'no-restricted-syntax'],
    ['src/main/x.ts', "import fs from 'node:fs'; promisify(fs.rmdir)(p, { recursive: true });", 'no-restricted-syntax'],
    ['src/main/x.ts', "import fs from 'node:fs'; fs.rm.call(fs, p);", 'no-restricted-syntax'],
    ['src/main/x.ts', "import fs from 'node:fs'; fs.rmdirSync(...args);", 'no-restricted-syntax'],
    ['src/main/x.ts', "import fs from 'node:fs'; const { rm: r } = fs.promises;", 'no-restricted-syntax'],
    ['src/main/x.ts', "const { rm: r } = require('node:fs');", 'no-restricted-syntax'],
    ['src/main/x.ts', "const { rmSync } = await import('node:fs');", 'no-restricted-syntax'],
    ['src/main/x.ts', "import { rm } from 'node:fs'; rm?.(p);", 'no-restricted-syntax'],
    ['src/main/x.ts', "export { rm } from 'node:fs/promises';", 'no-restricted-syntax'],
    ['src/main/x.ts', "import { \"rm\" as r } from 'node:fs/promises';", 'no-restricted-syntax'],
    ['src/main/x.ts', "import { shell } from 'electron'; shell['trashItem'](p);", 'no-restricted-syntax'],
    ['src/main/x.ts', "import fs from 'node:fs'; fs.rmdirSync('a');", 'no-restricted-syntax'],
    ['src/core/fsx.ts', "import fs from 'node:fs'; fs.rmdirSync('a', { recursive: true });", 'no-restricted-syntax'],
    ['src/core/safe-fs.ts', "import fs from 'node:fs'; fs.rmdirSync(...args);", 'no-restricted-syntax'],
    ['tests/helpers/tmp.ts', "import fs from 'node:fs'; fs.rmdirSync('a', { recursive: true });", 'no-restricted-syntax'],
    ['src/main/x.ts', "const cp = require('node:child_process');", 'no-restricted-syntax'],
    // hardware.ts may import only execFile
    ['src/main/hardware.ts', "import { exec } from 'node:child_process';", 'no-restricted-imports'],
    ['src/main/hardware.ts', "import { spawn, execFile } from 'child_process';", 'no-restricted-imports'],
    ['src/main/hardware.ts', "import * as cp from 'node:child_process';", 'no-restricted-imports'],
    ['src/main/hardware.ts', "const cp = require('node:child_process');", 'no-restricted-syntax'],
    ['src/main/hardware.ts', "const cp = await import('node:child_process');", 'no-restricted-syntax'],
    ['src/main/hardware2.ts', "import { execFile } from 'node:child_process';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { execFile } from 'node:child_process';", 'no-restricted-imports'],
    ['src/core/hardware.ts', "import { execFile } from 'node:child_process';", 'no-restricted-imports'],
    ['src/main/x.ts', "const cp = await import('child_process');", 'no-restricted-syntax'],
    ['src/main/x.ts', "import { exec } from 'child_process';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { execa } from 'execa';", 'no-restricted-imports'],
    ['src/main/x.ts', "import sh from 'shelljs';", 'no-restricted-imports'],
    ['src/main/x.ts', "// eslint-disable-next-line no-restricted-syntax\nimport fs from 'node:fs'; fs.rmSync('a');", 'no-restricted-syntax'],
    ['src/main/x.ts', "/* eslint-disable */\nimport fs from 'node:fs'; fs.rmSync('a');", 'no-restricted-syntax'],
    ['tests/x.test.ts', "import * as fs from 'node:fs'; fs.rmSync('a', { recursive: true });", 'no-restricted-syntax'],
    // I1a: only the fs allowlist may import node fs in src/
    ['src/main/x.ts', "import * as fs from 'node:fs';", 'no-restricted-imports'],
    ['src/main/x.ts', "import fs from 'fs';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { readFile } from 'fs/promises';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { readFile } from 'node:fs/promises';", 'no-restricted-imports'],
    ['src/core/paths.ts', "import { readFile } from 'node:fs/promises';", 'no-restricted-imports'],
    ['src/renderer/src/x.ts', "import fs from 'node:fs';", 'no-restricted-imports'],
    ['src/main/x.ts', "export { readFile } from 'node:fs/promises';", 'no-restricted-imports'],
    ['src/main/x.ts', "export * from 'fs';", 'no-restricted-imports'],
    ['src/main/x.ts', "const fs = await import('node:fs');", 'no-restricted-syntax'],
    ['src/main/x.ts', "const fs = await import('fs/promises');", 'no-restricted-syntax'],
    ['src/main/x.ts', 'const fs = await import(`node:fs`);', 'no-restricted-syntax'],
    ['src/main/x.ts', 'const fs = await import(`fs/promises`);', 'no-restricted-syntax'],
    ['src/main/x.ts', "const fs = require('node:fs');", 'no-restricted-syntax'],
    ['src/main/x.ts', "const fs = require('fs/promises');", 'no-restricted-syntax'],
    ['src/main/x.ts', 'const fs = require(`fs`);', 'no-restricted-syntax'],
    // I1b: nodeFs mutators only inside fsx/safe-fs
    ['src/main/x.ts', "import { nodeFs } from '../core/fsx'; await nodeFs.unlink(p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs.rename(a, b);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs.writeFile(p, 'x');", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs.mkdir(p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs.symlink(t, p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs.link(a, b);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs.rmdir(p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; const f = nodeFs.appendFile;", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; nodeFs.copyFile(a, b);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs.open(p, 'wx');", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; nodeFs.truncate(p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; nodeFs.chmod(p, 0);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; nodeFs.utimes(p, 0, 0);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs['unlink'](p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs?.unlink(p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; const { unlink } = nodeFs;", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; const { rename: mv } = nodeFs;", 'no-restricted-syntax'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; const { 'unlink': u } = nodeFs;", 'no-restricted-syntax'],
    // F2a: only fsx/safe-fs may value-import nodeFs
    ['src/core/x.ts', "import { nodeFs } from './fsx';", 'no-restricted-imports'],
    ['src/core/x.ts', "import { nodeFs as f } from './fsx'; await f.unlink(p);", 'no-restricted-imports'],
    ['src/main/x.ts', "import { nodeFs as f } from '../core/fsx';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { nodeFs } from '../core/fsx.js';", 'no-restricted-imports'],
    ['src/core/scan/x.ts', "import { nodeFs } from '../fsx'; const f = nodeFs; await f.unlink(p);", 'no-restricted-imports'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; const s = new SafeFs(roots, nodeFs);", 'no-restricted-imports'],
    ['src/core/x.ts', "import { nodeFs } from './fsx'; await nodeFs.lstat(p);", 'no-restricted-imports'],
    ['src/main/x.ts', "export { nodeFs } from '../core/fsx';", 'no-restricted-imports'],
    ['src/core/x.ts', "import { type nodeFs } from './fsx';", 'no-restricted-imports'],
    // The one exception: mkdirOneLevel may be imported only by src/main/user-data.ts
    ['src/main/bootstrap.ts', "import { mkdirOneLevel } from '../core/fsx'; await mkdirOneLevel(p);", 'no-restricted-imports'],
    ['src/core/x.ts', "import { mkdirOneLevel as m } from './fsx';", 'no-restricted-imports'],
    ['src/main/x.ts', "import * as x from '../core/fsx'; x.mkdirOneLevel(p);", 'no-restricted-syntax'],
    ['src/main/x.ts', "const { mkdirOneLevel: m } = await import('../core/fsx');", 'no-restricted-syntax'],
    ['src/main/x.ts', "export { mkdirOneLevel } from '../core/fsx';", 'no-restricted-imports'],
    // F2b: only FS_IMPORT_ALLOWLIST files may name FsLike
    ['src/core/x.ts', "import type { FsLike } from './fsx';", 'no-restricted-imports'],
    ['src/core/x.ts', "import { type FsLike } from './fsx';", 'no-restricted-imports'],
    ['src/main/x.ts', "import { FsLike as F } from '../core/fsx';", 'no-restricted-imports'],
    ['src/main/x.ts', "export type { FsLike } from '../core/fsx';", 'no-restricted-imports'],
    ['src/core/x.ts', "type F = import('./fsx').FsLike;", 'no-restricted-syntax'],
    // F2c: no namespace imports of fsx, no .nodeFs member access (static or dynamic import)
    ['src/core/x.ts', "import * as x from './fsx'; await x.nodeFs.unlink(p);", 'no-restricted-imports'],
    ['src/core/x.ts', "import * as x from './fsx'; await x.nodeFs.unlink(p);", 'no-restricted-syntax'],
    ['src/main/x.ts', "import * as x from '../core/fsx';", 'no-restricted-syntax'],
    ['src/main/x.ts', "export * from '../core/fsx';", 'no-restricted-imports'],
    ['src/main/x.ts', "export * as x from '../core/fsx';", 'no-restricted-imports'],
    ['src/core/x.ts', "await (await import('./fsx')).nodeFs.unlink(p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "const m = await import('./fsx'); await m['nodeFs'].unlink(p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "const { nodeFs: f } = await import('./fsx'); await f.unlink(p);", 'no-restricted-syntax'],
    ['src/core/x.ts', "const m = await import(`./fsx`); m.nodeFs;", 'no-restricted-syntax'],
    ['src/main/x.ts', "const m = require('../core/fsx'); m.nodeFs.unlink(p);", 'no-restricted-syntax'],
    // The allowlist grows by exactly lock.ts and journal.ts; the executor and siblings stay banned
    ['src/core/exec/executor.ts', "import { open } from 'node:fs/promises';", 'no-restricted-imports'],
    ['src/core/exec/executor.ts', "import * as fs from 'node:fs';", 'no-restricted-imports'],
    ['src/core/exec/executor.ts', "const fs = await import('node:fs');", 'no-restricted-syntax'],
    ['src/core/exec/errors.ts', "import { open } from 'node:fs/promises';", 'no-restricted-imports'],
    ['src/core/exec/lock.ts', "import { rm } from 'node:fs/promises';", 'no-restricted-syntax'],
    ['src/core/exec/journal.ts', "import fs from 'node:fs'; fs.rmdirSync('a');", 'no-restricted-syntax'],
    ['src/core/exec/lock.ts', "import { nodeFs } from '../fsx'; await nodeFs.unlink(p);", 'no-restricted-syntax'],
    ['src/core/exec/journal.ts', "import { app } from 'electron';", 'no-restricted-imports'],
  ])('%s: %s is rejected by %s', async (filePath, code, rule) => {
    expect(await ruleIds(filePath, code)).toContain(rule);
  });

  it.each([
    ['src/main/user-data.ts', "import { mkdirOneLevel } from '../core/fsx'; await mkdirOneLevel(p);"],
    ['src/core/fsx.ts', "export const mkdirOneLevel = (p) => nodeFs.mkdir(p);"],
    ['src/main/x.ts', "import { app } from 'electron';"],
    ['src/core/fsx.ts', "import * as fs from 'node:fs'; fs.rmdirSync('a');"],
    ['tests/helpers/guarded-fs.ts', "import * as fs from 'node:fs'; fs.rmdirSync('a');"],
    ['src/core/fsx.ts', "import * as fs from 'node:fs'; import fsp from 'node:fs/promises'; import f from 'fs'; import g from 'fs/promises';"],
    ['src/core/safe-fs.ts', "import * as fs from 'node:fs'; const p = await import('node:fs/promises'); const q = require(`fs`);"],
    ['src/core/fsx.ts', "export const nodeFs = {}; nodeFs.unlink(p); nodeFs['rename'](a, b); const { mkdir } = nodeFs;"],
    ['src/core/safe-fs.ts', "import { nodeFs } from './fsx'; await nodeFs.unlink(p); await nodeFs.writeFile(p, 'x');"],
    ['src/core/x.ts', "import type { Stats } from 'node:fs';"],
    ['src/core/x.ts', "import { readFs } from './fsx'; await readFs.lstat(p); await readFs.readdir(p); const { readlink } = readFs;"],
    ['src/core/x.ts', "import { readFs, type ReadFs } from './fsx'; export async function f(fs: ReadFs = readFs) { return fs.lstat(p); }"],
    ['src/main/x.ts', "import { readFs, type ReadFs } from '../core/fsx'; export const r: ReadFs = readFs;"],
    ['src/core/x.ts', "import { factsOf, isNotFound } from './fsx'; const m = await import('./fsx'); m.readFs.lstat(p);"],
    ['src/core/safe-fs.ts', "import { nodeFs, type FsLike } from './fsx'; const f: FsLike = nodeFs;"],
    ['src/core/fsx.ts', "export const nodeFs = {}; export const readFs = nodeFs; export interface FsLike {}"],
    ['tests/core/x.test.ts', "import * as x from '../../src/core/fsx'; import { nodeFs as f, type FsLike } from '../../src/core/fsx'; x.nodeFs.unlink(p); const g: FsLike = f;"],
    ['src/core/x.ts', "const other = { unlink() {} }; other.unlink(); fs2.rename(a, b);"],
    ['tests/core/x.test.ts', "import * as fs from 'node:fs'; import { nodeFs } from '../../src/core/fsx'; nodeFs.unlink(p);"],
    ['src/core/exec/lock.ts', "import { constants, lstat, mkdir, open, unlink } from 'node:fs/promises'; await mkdir(d); await unlink(f);"],
    ['src/core/exec/journal.ts', "import { constants, open } from 'node:fs/promises'; const fh = await open(f, constants.O_APPEND);"],
    ['src/main/hardware.ts', "import { execFile } from 'node:child_process';"],
  ])('%s: %s is allowed', async (filePath, code) => {
    const ids = await ruleIds(filePath, code);
    expect(ids).not.toContain('no-restricted-imports');
    expect(ids).not.toContain('no-restricted-syntax');
  });
});
