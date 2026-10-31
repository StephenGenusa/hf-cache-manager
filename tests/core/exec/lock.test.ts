import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecError } from '../../../src/core/exec/errors';
import { AppLock } from '../../../src/core/exec/lock';
import { useCanaries } from '../../helpers/canary';
import { setMtime } from '../../helpers/tmp';
import { buildTree, type Tree } from '../support/scenarios';

useCanaries();

const BAD_DIR = 'lock folder is a symlink or not a directory';
const alive = (): boolean => true;
const dead = (): boolean => false;

let t: Tree | null = null;
afterEach(async () => {
  await t?.dispose();
  t = null;
});
const tree = async (): Promise<Tree> => (t = await buildTree({ repos: [] }));
const lockFile = (dir: string): string => join(dir, 'app.lock');

async function caught(p: Promise<unknown>): Promise<ExecError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ExecError);
    return e as ExecError;
  }
  throw new Error('expected a rejection');
}

describe('AppLock', () => {
  it('constructor refuses a relative dir', () => {
    expect(() => new AppLock('relative/dir')).toThrow();
  });

  it('acquire writes <dir>/app.lock with the exact content and isHeld reports it', async () => {
    const tr = await tree();
    const lock = new AppLock(tr.lockDir, { pid: 4242, isPidAlive: alive });
    expect(await lock.isHeld(tr.now)).toBe(false);
    await lock.acquire(tr.now);
    expect(await readFile(lockFile(tr.lockDir), 'utf8')).toBe(`{"pid":4242,"at":${tr.now}}\n`);
    expect(await lock.isHeld(tr.now)).toBe(true);
    await lock.release();
    await expect(lstat(lockFile(tr.lockDir))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await lock.isHeld(tr.now)).toBe(false);
  });

  it('inv8: second acquire while held by a live pid → LOCKED with pid in message', async () => {
    const tr = await tree();
    await new AppLock(tr.lockDir, { pid: 4242, isPidAlive: alive }).acquire(tr.now);
    const other = new AppLock(tr.lockDir, { pid: 5151, isPidAlive: alive });
    const err = await caught(other.acquire(tr.now + 1));
    expect(err.code).toBe('LOCKED');
    expect(err.message).toContain('4242');
    expect(await readFile(lockFile(tr.lockDir), 'utf8')).toBe(`{"pid":4242,"at":${tr.now}}\n`);
    // the same pid acquiring again is also LOCKED (no re-entry)
    const same = new AppLock(tr.lockDir, { pid: 4242, isPidAlive: alive });
    expect((await caught(same.acquire(tr.now + 2))).code).toBe('LOCKED');
  });

  it('stale lock from a dead pid is replaced', async () => {
    const tr = await tree();
    await new AppLock(tr.lockDir, { pid: 4242, isPidAlive: alive }).acquire(tr.now);
    const seen: number[] = [];
    const next = new AppLock(tr.lockDir, { pid: 5151, isPidAlive: (p) => (seen.push(p), dead()) });
    expect(await next.isHeld(tr.now + 5)).toBe(false);
    await next.acquire(tr.now + 5);
    expect(seen).toContain(4242);
    expect(await readFile(lockFile(tr.lockDir), 'utf8')).toBe(`{"pid":5151,"at":${tr.now + 5}}\n`);
  });

  it('unparseable lock younger than 60 s → LOCKED; older → replaced', async () => {
    const tr = await tree();
    const p = lockFile(tr.lockDir);
    await tr.fs.writeFile(p, '{"pid":12');
    await setMtime(p, tr.now - 30_000);
    const lock = new AppLock(tr.lockDir, { pid: 5151, isPidAlive: alive });
    expect(await lock.isHeld(tr.now)).toBe(true);
    expect((await caught(lock.acquire(tr.now))).code).toBe('LOCKED');
    expect(await readFile(p, 'utf8')).toBe('{"pid":12');
    await setMtime(p, tr.now - 61_000);
    expect(await lock.isHeld(tr.now)).toBe(false);
    await lock.acquire(tr.now);
    expect(await readFile(p, 'utf8')).toBe(`{"pid":5151,"at":${tr.now}}\n`);
  });

  it('a lock naming a non-positive or non-integer pid counts as unparseable', async () => {
    const tr = await tree();
    const p = lockFile(tr.lockDir);
    const probed: number[] = [];
    const lock = new AppLock(tr.lockDir, { pid: 5151, isPidAlive: (x) => (probed.push(x), true) });
    for (const body of ['{"pid":0,"at":1}\n', '{"pid":-1,"at":1}\n', '{"pid":1.5,"at":1}\n', '{"pid":"7","at":1}\n']) {
      await tr.fs.writeFile(p, body);
      await setMtime(p, tr.now - 1_000);
      expect((await caught(lock.acquire(tr.now))).code).toBe('LOCKED');
      await tr.fs.unlink(p);
    }
    expect(probed).toEqual([]);
  });

  it('release leaves a lock owned by another pid alone', async () => {
    const tr = await tree();
    const owner = new AppLock(tr.lockDir, { pid: 4242, isPidAlive: alive });
    await owner.acquire(tr.now);
    await new AppLock(tr.lockDir, { pid: 5151, isPidAlive: alive }).release();
    expect(await readFile(lockFile(tr.lockDir), 'utf8')).toBe(`{"pid":4242,"at":${tr.now}}\n`);
    await owner.release();
    await expect(lstat(lockFile(tr.lockDir))).rejects.toMatchObject({ code: 'ENOENT' });
    await owner.release(); // missing lock: no-op
  });

  it('a missing lock folder is created non-recursively', async () => {
    const tr = await tree();
    const dir = join(tr.root, 'fresh-mgr');
    await new AppLock(dir, { pid: 4242, isPidAlive: alive }).acquire(tr.now);
    expect((await lstat(dir)).isDirectory()).toBe(true);
    expect(await readdir(dir)).toEqual(['app.lock']);
    const deep = join(tr.root, 'no-parent', 'mgr');
    expect((await caught(new AppLock(deep, { pid: 4242 }).acquire(tr.now))).code).toBe('IO');
    await expect(lstat(join(tr.root, 'no-parent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a symlinked lock folder is refused and nothing is written through it', async () => {
    const tr = await tree();
    const target = join(tr.root, 'elsewhere');
    await tr.fs.mkdir(target);
    const dir = join(tr.root, 'linked-mgr');
    await tr.fs.symlink(target, dir, 'dir');
    const lock = new AppLock(dir, { pid: 4242, isPidAlive: alive });
    const err = await caught(lock.acquire(tr.now));
    expect(err.code).toBe('IO');
    expect(err.message).toBe(BAD_DIR);
    expect(await readdir(target)).toEqual([]);
    expect((await caught(lock.isHeld(tr.now))).message).toBe(BAD_DIR);
    expect((await caught(lock.release())).message).toBe(BAD_DIR);
  });

  it('a lock folder that is a file is refused', async () => {
    const tr = await tree();
    const dir = join(tr.root, 'file-mgr');
    await tr.fs.writeFile(dir, 'x');
    const err = await caught(new AppLock(dir, { pid: 4242 }).acquire(tr.now));
    expect(err.code).toBe('IO');
    expect(err.message).toBe(BAD_DIR);
    expect(await readFile(dir, 'utf8')).toBe('x');
  });

  it.each([['O_NOFOLLOW', undefined], ['lstat/fstat fallback', 0]] as const)(
    'a symlink at app.lock is never followed (%s)', async (_label, noFollowFlag) => {
      const tr = await tree();
      const target = join(tr.root, 'victim.txt');
      await tr.fs.writeFile(target, 'keep');
      await tr.fs.symlink(target, lockFile(tr.lockDir), 'file');
      const lock = new AppLock(tr.lockDir, { pid: 4242, isPidAlive: dead, noFollowFlag });
      expect((await caught(lock.acquire(tr.now + 120_000))).code).toBe('IO');
      expect(await lock.isHeld(tr.now)).toBe(true);
      expect((await lstat(lockFile(tr.lockDir))).isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('keep');
      await tr.fs.unlink(lockFile(tr.lockDir));
      await lock.acquire(tr.now);
      expect(await readFile(lockFile(tr.lockDir), 'utf8')).toBe(`{"pid":4242,"at":${tr.now}}\n`);
      await lock.release();
      expect(await readdir(tr.lockDir)).not.toContain('app.lock');
    });

  it('release leaves the file alone when it was replaced by another pid, or by our pid with another at', async () => {
    const tr = await tree();
    const p = lockFile(tr.lockDir);
    for (const body of ['{"pid":5151,"at":TS}\n', '{"pid":4242,"at":999}\n']) {
      const lock = new AppLock(tr.lockDir, { pid: 4242, isPidAlive: alive });
      await lock.acquire(tr.now);
      const replaced = body.replace('TS', String(tr.now));
      await tr.fs.writeFile(p, replaced);
      await lock.release();
      expect(await readFile(p, 'utf8')).toBe(replaced);
      await tr.fs.unlink(p);
    }
  });

  describe('stale takeover', () => {
    const STALE = '{"pid":999,"at":1}\n';
    const only999Dead = (p: number): boolean => p !== 999;

    it('another instance taking over between our stale read and our unlink leaves exactly one owner', async () => {
      const tr = await tree();
      const p = lockFile(tr.lockDir);
      await tr.fs.writeFile(p, STALE);
      const a = new AppLock(tr.lockDir, { pid: 4242, isPidAlive: only999Dead });
      const b = new AppLock(tr.lockDir, {
        pid: 5151, isPidAlive: only999Dead,
        beforeTakeover: async () => { await a.acquire(tr.now); },
      });
      const err = await caught(b.acquire(tr.now + 1));
      expect(err.code).toBe('LOCKED');
      expect(err.message).toContain('4242');
      expect(await readFile(p, 'utf8')).toBe(`{"pid":4242,"at":${tr.now}}\n`);
      expect(await readdir(tr.lockDir)).not.toContain('app.lock.takeover');
      await b.release(); // b never owned it: no-op
      expect(await a.isHeld(tr.now)).toBe(true);
    });

    it('a raw re-create (possibly reusing the stale inode) between stale read and unlink is never deleted', async () => {
      const tr = await tree();
      const p = lockFile(tr.lockDir);
      await tr.fs.writeFile(p, STALE);
      const fresh = `{"pid":4242,"at":${tr.now}}\n`;
      const b = new AppLock(tr.lockDir, {
        pid: 5151, isPidAlive: only999Dead,
        beforeTakeover: async () => {
          await tr.fs.unlink(p);
          await tr.fs.writeFile(p, fresh, { flag: 'wx' });
        },
      });
      expect((await caught(b.acquire(tr.now + 1))).code).toBe('LOCKED');
      expect(await readFile(p, 'utf8')).toBe(fresh);
    });

    it('a fresh takeover guard from a live taker → LOCKED and the stale lock is left alone', async () => {
      const tr = await tree();
      const p = lockFile(tr.lockDir);
      const g = join(tr.lockDir, 'app.lock.takeover');
      await tr.fs.writeFile(p, STALE);
      await tr.fs.writeFile(g, `{"pid":4242,"at":${tr.now}}\n`);
      await setMtime(g, tr.now - 1_000);
      const b = new AppLock(tr.lockDir, { pid: 5151, isPidAlive: only999Dead });
      expect((await caught(b.acquire(tr.now))).code).toBe('LOCKED');
      expect(await readFile(p, 'utf8')).toBe(STALE);
      expect(await readFile(g, 'utf8')).toBe(`{"pid":4242,"at":${tr.now}}\n`);
    });

    it.each([
      ['a dead taker', '{"pid":999,"at":1}\n', 1_000],
      ['a taker older than 60 s', '{"pid":4242,"at":1}\n', 61_000],
      ['an unparseable guard older than 60 s', '{"pi', 61_000],
    ])('a guard left by %s is removed and the takeover proceeds', async (_l, guardBody, age) => {
      const tr = await tree();
      const p = lockFile(tr.lockDir);
      const g = join(tr.lockDir, 'app.lock.takeover');
      await tr.fs.writeFile(p, STALE);
      await tr.fs.writeFile(g, guardBody);
      await setMtime(g, tr.now - age);
      const b = new AppLock(tr.lockDir, { pid: 5151, isPidAlive: only999Dead });
      await b.acquire(tr.now);
      expect(await readFile(p, 'utf8')).toBe(`{"pid":5151,"at":${tr.now}}\n`);
      expect(await readdir(tr.lockDir)).not.toContain('app.lock.takeover');
    });

    it('an unparseable guard younger than 60 s → LOCKED', async () => {
      const tr = await tree();
      const g = join(tr.lockDir, 'app.lock.takeover');
      await tr.fs.writeFile(lockFile(tr.lockDir), STALE);
      await tr.fs.writeFile(g, '{"pi');
      await setMtime(g, tr.now - 1_000);
      const b = new AppLock(tr.lockDir, { pid: 5151, isPidAlive: only999Dead });
      expect((await caught(b.acquire(tr.now))).code).toBe('LOCKED');
      expect(await readFile(g, 'utf8')).toBe('{"pi');
    });
  });

  it('recordIsOurs is true only for a record with our pid that this instance does not hold', async () => {
    const tr = await tree();
    const ours = new AppLock(tr.lockDir, { pid: 4242, isPidAlive: alive });
    expect(await ours.recordIsOurs()).toBe(false); // no folder yet
    await new AppLock(tr.lockDir, { pid: 4242, isPidAlive: alive }).acquire(tr.now); // a stale record of our pid
    expect(await ours.recordIsOurs()).toBe(true);
    expect(await new AppLock(tr.lockDir, { pid: 5151, isPidAlive: alive }).recordIsOurs()).toBe(false);
    const holder = new AppLock(join(tr.root, 'other-lock-dir'), { pid: 4242, isPidAlive: alive });
    await holder.acquire(tr.now);
    expect(await holder.recordIsOurs()).toBe(false); // held right now by this instance: not stale
    await holder.release();
    expect(await holder.recordIsOurs()).toBe(false); // nothing there
  });

  it('recordIsOurs is false for an unparseable record and never throws', async () => {
    const tr = await tree();
    const lock = new AppLock(tr.lockDir, { pid: 4242, isPidAlive: alive });
    await lock.acquire(tr.now);
    await lock.release();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(lockFile(tr.lockDir), 'garbage');
    expect(await lock.recordIsOurs()).toBe(false);
    await writeFile(join(tr.root, 'not-a-dir'), 'x');
    expect(await new AppLock(join(tr.root, 'not-a-dir')).recordIsOurs()).toBe(false); // ensureDir throws: still false
  });

  it('the default isPidAlive treats this process as alive', async () => {
    const tr = await tree();
    await new AppLock(tr.lockDir).acquire(tr.now);
    const err = await caught(new AppLock(tr.lockDir, { pid: 5151 }).acquire(tr.now));
    expect(err.code).toBe('LOCKED');
    expect(err.message).toContain(String(process.pid));
  });
});
