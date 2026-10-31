import { lstat, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeTempRoot, removeTempRoot } from '../helpers/tmp';
import { BANNED_PACKAGES, findForbidden } from './forbidden';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_TOP = new Set(['node_modules', 'out', 'dist']);
// The one file allowed to name node:child_process (execFile for nvidia-smi); the scan skips only that id, only there.
export const CHILD_PROCESS_ALLOWLIST: readonly string[] = ['src/main/hardware.ts'];
const EXT = /\.(ts|tsx|js|mjs|cjs|mts|cts)$/;

async function scanTree(
  dirs: string[],
  opts: { base?: string; exclude?: string[]; allowChildProcess?: readonly string[] } = {},
): Promise<{ hits: string[]; files: number }> {
  const base = opts.base ?? root;
  const exclude = opts.exclude ?? [];
  const hits: string[] = [];
  let files = 0;
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      const st = await lstat(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_TOP.has(rel)) continue; // only at the top level of the scan base
        if (exclude.some((e) => (rel + '/').startsWith(e))) continue;
        await walk(full);
      } else if (st.isFile() && EXT.test(name)) {
        if (exclude.some((e) => rel.startsWith(e))) continue;
        files++;
        const text = await readFile(full, 'utf8');
        for (const id of findForbidden(text)) {
          if (id === 'child-process' && opts.allowChildProcess?.includes(rel)) continue;
          const re = (await import('./forbidden')).FORBIDDEN.find((f) => f.id === id)!.re;
          const idx = text.search(re);
          const line = text.slice(0, idx).split('\n').length;
          hits.push(`${rel}:${line}: ${id}`);
        }
      }
    }
  }
  for (const d of dirs) await walk(path.join(base, d));
  return { hits, files };
}

describe('findForbidden', () => {
  it.each([
    ['fs.rmSync(p, { recursive: true, force: true })', 'fs-rm'],
    ['await fs.promises.rm(p)', 'fs-rm'],
    ['await rm(p)', 'fs-rm'],
    ['fs.rmdirSync(p, { recursive: true })', 'rmdir-recursive'],
    ['await fsp.rmdir(dir, {\n  recursive: true })', 'rmdir-recursive'],
    ["import rimraf from 'rimraf'", 'rimraf'],
    ["import { deleteAsync } from 'del'", 'del-pkg'],
    ["const fse = require('fs-extra')", 'fs-extra'],
    ['shell.trashItem(p)', 'trash'],
    ['shell.moveItemToTrash(p)', 'trash'],
    ["import trash from 'trash'", 'trash'],
    ["execSync('rm -rf ' + dir)", 'shell-rm-r'],
    ["spawn('rm', ['-r', d])", 'shell-rm-argv'],
    ["exec('rmdir /s /q x')", 'win-rd-s'],
    ['emptyDirSync(d)', 'empty-dir'],
    ['fs.rmdirSync(join(a, b), { recursive: true })', 'rmdir-recursive'],
    ['fs.rmdirSync(join(a, f(b)), { recursive: true })', 'rmdir-recursive'],
    ["fs['rm'](p, { recursive: true })", 'fs-rm'],
    ['const f = fs.rm;', 'fs-rm'],
    ['[a].map(fs.promises.rm)', 'fs-rm'],
    ['fs.rm.call(fs, p)', 'fs-rm'],
    ['const { rm: r } = fs.promises;', 'fs-rm'],
    ['rm?.(p)', 'fs-rm'],
    ["require('node:child_process')", 'child-process'],
    ["import { execa } from 'execa'", 'child-process'],
    ["import sh from 'shelljs'", 'child-process'],
    ["spawn('find', [d, '-delete'])", 'find-delete'],
    ["exec('rm --recursive d')", 'long-recursive'],
    ["exec('Remove-Item -Recurse d')", 'remove-item'],
    ["exec('del /s /q d')", 'win-del-s'],
    ['await import(`node:child_process`)', 'child-process'],
    ['require(`child_process`)', 'child-process'],
    ['import(`execa`)', 'child-process'],
    ['await import(`fs-extra`)', 'fs-extra'],
    ['require(`fs-extra/esm`)', 'fs-extra'],
    ['await import(`del`)', 'del-pkg'],
    ['await import(`trash`)', 'trash'],
    ["spawn(`rm`, [`-r`, d])", 'shell-rm-argv'],
  ])('flags %s', (src, id) => expect(findForbidden(src)).toContain(id));

  it.each([
    'confirm(x)',
    'perform()',
    'await fs.rmdir(p)',
    'await fs.rmdir(path.join(a, b));',
    'await fs.mkdir(p, { recursive: true })',
    "el.classList.remove('x')",
    'const firm = 1;',
    'await fs.rmdir(p); await fs.mkdir(q, { recursive: true });',
    'await fs.rmdir(p)\nawait fs.mkdir(q, { recursive: true })',
  ])('allows %s', (src) => expect(findForbidden(src)).toEqual([]));
});

describe('source tree', () => {
  it('contains no recursive-delete API anywhere under src/, tests/ or e2e/', async () => {
    const { hits, files } = await scanTree(['src', 'tests', 'e2e'], { exclude: ['tests/safety/'], allowChildProcess: CHILD_PROCESS_ALLOWLIST });
    expect(files).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });

  it('the child_process allow-list is exactly src/main/hardware.ts', () => {
    expect(CHILD_PROCESS_ALLOWLIST).toEqual(['src/main/hardware.ts']);
  });

  it('the allow-list skips child-process only for that exact path', async () => {
    const tmp = await makeTempRoot('hfcm-t-');
    try {
      await mkdir(path.join(tmp, 'src', 'main'), { recursive: true });
      const code = "import { execFile } from 'node:child_process';\n";
      await writeFile(path.join(tmp, 'src', 'main', 'hardware.ts'), code);
      await writeFile(path.join(tmp, 'src', 'main', 'other.ts'), code);
      const { hits } = await scanTree(['src'], { base: tmp, allowChildProcess: CHILD_PROCESS_ALLOWLIST });
      expect(hits).toEqual(['src/main/other.ts:1: child-process']);
    } finally {
      await removeTempRoot(tmp);
    }
  });

  it('positive control: detects a planted violation in a temp dir', async () => {
    const tmp = await makeTempRoot('hfcm-t-');
    try {
      await mkdir(path.join(tmp, 'src'));
      await writeFile(path.join(tmp, 'src', 'bad.ts'), 'a();\nfs.rmSync(p, { recursive: true });\n');
      await writeFile(path.join(tmp, 'src', 'ok.ts'), 'const x = 1;\n');
      const { hits, files } = await scanTree(['src'], { base: tmp });
      expect(files).toBe(2);
      expect(hits).toEqual(['src/bad.ts:2: fs-rm']);
    } finally {
      await removeTempRoot(tmp);
    }
  });

  it('scanTree skips out/dist/node_modules only at the top level of the base', async () => {
    const tmp = await makeTempRoot('hfcm-t-');
    try {
      const bad = 'fs.rmSync(p);\n';
      for (const d of ['node_modules', 'src/node_modules', 'src/dist', 'src/out/deep']) {
        await mkdir(path.join(tmp, d), { recursive: true });
        await writeFile(path.join(tmp, d, 'bad.ts'), bad);
      }
      await writeFile(path.join(tmp, 'src', 'cjs.cts'), bad);
      const nested = await scanTree(['src'], { base: tmp });
      expect(nested.hits.sort()).toEqual([
        'src/cjs.cts:1: fs-rm',
        'src/dist/bad.ts:1: fs-rm',
        'src/node_modules/bad.ts:1: fs-rm',
        'src/out/deep/bad.ts:1: fs-rm',
      ]);
      const top = await scanTree(['.'], { base: tmp });
      expect(top.hits).not.toContain('node_modules/bad.ts:1: fs-rm');
      expect(top.hits).toContain('src/dist/bad.ts:1: fs-rm');
    } finally {
      await removeTempRoot(tmp);
    }
  });

  it('package.json scripts contain no banned patterns', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const bad = Object.entries(pkg.scripts ?? {}).flatMap(([k, v]) =>
      findForbidden(String(v)).map((id) => `${k}: ${id}`),
    );
    expect(bad).toEqual([]);
  });

  it('package.json declares none of the banned packages', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => (BANNED_PACKAGES as readonly string[]).includes(d))).toEqual([]);
  });
});
