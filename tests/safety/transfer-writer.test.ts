// The transfer drive writer is the one file outside fsx/safe-fs that may create and append files on a volume the app
// does not own (the user's USB drive). This pins what it must never contain: any way to remove, replace, move or
// shorten a file. A plain text scan of the source, like the other safety tests.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRITER = 'src/core/transfer/drive-writer.ts';
const code = (text: string): string => text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
// One string, so no banned name stands alone as a literal in this file.
const BANNED = 'unlink rename rmdir rm truncate ftruncate copyFile cp symlink link chmod chown utimes appendFile'.split(' ');

describe('the transfer drive writer adds and never takes away', () => {
  it('names no call that deletes, moves, replaces, shortens or relinks a file', async () => {
    const text = code(await readFile(path.join(root, WRITER), 'utf8'));
    for (const banned of BANNED) {
      expect(text, banned).not.toMatch(new RegExp('\\b' + banned + '(Sync)?\\s*[(]'));
    }
    expect(text).not.toMatch(/O_TRUNC/);
    expect(text).not.toMatch(/recursive/);
    // a path-level writeFile replaces; only a handle created with O_EXCL is written
    expect(text).not.toMatch(/fsp\.writeFile\s*[(]/);
  });

  it('opens files for writing only with exclusive create or append, and never by a string flag', async () => {
    const text = code(await readFile(path.join(root, WRITER), 'utf8'));
    expect(text).toContain('const CREATE = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW;');
    expect(text).toContain('const APPEND = fsConstants.O_WRONLY | fsConstants.O_APPEND | NOFOLLOW;');
    const opens = [...text.matchAll(/fsp\.open[(]([^)]*)[)]/g)].map((m) => m[1]!.split(',').slice(1).join(',').trim());
    expect(opens.length).toBeGreaterThan(0);
    for (const flags of opens) expect(['CREATE', 'size === null ? CREATE : APPEND']).toContain(flags);
  });

  it('is the only file of the transfer code that imports node fs', async () => {
    const dirs = ['src/core/transfer', 'src/main/transfer'];
    const listed = await Promise.all(dirs.map(async (d) => (await readdir(path.join(root, d))).map((n) => `${d}/${n}`)));
    const files = [...listed.flat(), 'src/main/transfer-service.ts'];
    expect(files).toContain(WRITER);
    for (const f of files) {
      const imports = /from\s+['"](node:)?fs(\/promises)?['"]/.test(code(await readFile(path.join(root, f), 'utf8')));
      expect(imports, f).toBe(f === WRITER);
    }
  });
});
