import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReadFs, StatLike } from '../../../src/core/fsx';
import { holdAvailability, holdRootFor } from '../../../src/core/hold/hold-root';
import { useCanaries } from '../../helpers/canary';
import { buildFixture, type Fixture } from '../../helpers/fixture';

useCanaries();

const SYMLINK = 'Recently Deleted folder is a symlink; refusing to use it';
const NOT_DIR = 'Recently Deleted folder is not a directory';
const OTHER_DRIVE = 'Recently Deleted is on a different drive';

const mgrDir = (fx: Fixture): string => join(dirname(fx.hubRoot), '.hf-cache-manager');

/** A ReadFs over `inner` whose lstat/stat of exactly `path` report `dev + 1`; every call still goes through `inner`. */
function otherDevAt(inner: ReadFs, path: string): ReadFs & { lstatCalls: string[] } {
  const bump = (p: string, st: StatLike): StatLike =>
    p === path ? Object.assign(Object.create(st) as StatLike, { dev: st.dev + 1 }) : st;
  const lstatCalls: string[] = [];
  return Object.assign(Object.create(inner) as ReadFs, {
    lstatCalls,
    lstat: async (p: string) => {
      lstatCalls.push(p);
      return bump(p, await inner.lstat(p));
    },
    stat: async (p: string) => bump(p, await inner.stat(p)),
  });
}

describe('holdRootFor', () => {
  it('holdRootFor', () => expect(holdRootFor(join(sep, 'mnt', 'c', 'huggingface', 'hub')))
    .toBe(join(sep, 'mnt', 'c', 'huggingface', '.hf-cache-manager', 'recently-deleted')));
});

describe('holdAvailability', () => {
  it('holdAvailability ok on the same device, holdRoot existing or not', async () => {
    const withHold = await buildFixture({ holdRoot: true });
    expect(await holdAvailability(withHold.hubRoot, withHold.fs))
      .toEqual({ ok: true, holdRoot: holdRootFor(withHold.hubRoot) });
    expect(holdRootFor(withHold.hubRoot)).toBe(withHold.holdRoot);

    const without = await buildFixture({});
    expect(await holdAvailability(without.hubRoot, without.fs))
      .toEqual({ ok: true, holdRoot: holdRootFor(without.hubRoot) });

    // .hf-cache-manager exists (AppLock created it) but recently-deleted does not
    await without.fs.mkdir(mgrDir(without));
    expect(await holdAvailability(without.hubRoot, without.fs))
      .toEqual({ ok: true, holdRoot: holdRootFor(without.hubRoot) });
  });

  it('holdAvailability is read-only: it creates nothing', async () => {
    const fx = await buildFixture({});
    expect(await holdAvailability(fx.hubRoot, fx.fs)).toMatchObject({ ok: true });
    await expect(fx.fs.lstat(mgrDir(fx))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holdAvailability refuses a symlinked hold folder', async () => {
    // recently-deleted is a symlink to a real dir on the same device
    const a = await buildFixture({});
    await a.fs.mkdir(join(a.root, 'elsewhere'));
    await a.fs.mkdir(mgrDir(a));
    await a.fs.symlink(join(a.root, 'elsewhere'), holdRootFor(a.hubRoot));
    expect(await holdAvailability(a.hubRoot, a.fs)).toEqual({ ok: false, reason: SYMLINK });

    // .hf-cache-manager is a symlink to a dir that holds a real recently-deleted
    const b = await buildFixture({});
    await b.fs.mkdir(join(b.root, 'elsewhere', 'recently-deleted'), { recursive: true });
    await b.fs.symlink(join(b.root, 'elsewhere'), mgrDir(b));
    expect(await holdAvailability(b.hubRoot, b.fs)).toEqual({ ok: false, reason: SYMLINK });

    // a dangling symlink is refused too
    const c = await buildFixture({});
    await c.fs.mkdir(mgrDir(c));
    await c.fs.symlink(join(c.root, 'nowhere'), holdRootFor(c.hubRoot));
    expect(await holdAvailability(c.hubRoot, c.fs)).toEqual({ ok: false, reason: SYMLINK });
  });

  it('holdAvailability refuses a hold path that is a regular file', async () => {
    const a = await buildFixture({});
    await a.fs.mkdir(mgrDir(a));
    await a.fs.writeFile(holdRootFor(a.hubRoot), 'x');
    expect(await holdAvailability(a.hubRoot, a.fs)).toEqual({ ok: false, reason: NOT_DIR });

    const b = await buildFixture({});
    await b.fs.writeFile(mgrDir(b), 'x'); // .hf-cache-manager is a file, so recently-deleted cannot exist
    expect(await holdAvailability(b.hubRoot, b.fs)).toEqual({ ok: false, reason: NOT_DIR });
  });

  it('holdAvailability refuses a different device', async () => {
    // no hold folders yet: the nearest existing ancestor is the hub's parent
    const a = await buildFixture({});
    const fsA = otherDevAt(a.fs, dirname(a.hubRoot));
    expect(await holdAvailability(a.hubRoot, fsA)).toEqual({ ok: false, reason: OTHER_DRIVE });
    expect(fsA.lstatCalls).toContain(dirname(a.hubRoot));

    // the hold root exists and is itself on another device (a mount point), its parent is not
    const b = await buildFixture({ holdRoot: true });
    expect(await holdAvailability(b.hubRoot, otherDevAt(b.fs, b.holdRoot))).toEqual({ ok: false, reason: OTHER_DRIVE });

    // only .hf-cache-manager exists and it is on another device
    const c = await buildFixture({});
    await c.fs.mkdir(mgrDir(c));
    expect(await holdAvailability(c.hubRoot, otherDevAt(c.fs, mgrDir(c)))).toEqual({ ok: false, reason: OTHER_DRIVE });

    // a different device on an ancestor that is NOT the nearest existing one does not matter
    const d = await buildFixture({ holdRoot: true });
    expect(await holdAvailability(d.hubRoot, otherDevAt(d.fs, dirname(d.hubRoot))))
      .toEqual({ ok: true, holdRoot: holdRootFor(d.hubRoot) });
  });

  it('holdAvailability with a missing hub', async () => {
    const fx = await buildFixture({ hubMissing: true, holdRoot: true });
    expect(await holdAvailability(fx.hubRoot, fx.fs)).toEqual({ ok: false, reason: 'Hub folder not found' });
  });

  it('holdAvailability refuses a hub that is not a real directory', async () => {
    const a = await buildFixture({ hubMissing: true });
    await a.fs.writeFile(a.hubRoot, 'x');
    expect(await holdAvailability(a.hubRoot, a.fs)).toEqual({ ok: false, reason: 'Hub folder not found' });

    const b = await buildFixture({ hubMissing: true });
    await b.fs.mkdir(join(b.root, 'real-hub'));
    await b.fs.symlink(join(b.root, 'real-hub'), b.hubRoot);
    expect(await holdAvailability(b.hubRoot, b.fs)).toEqual({ ok: false, reason: 'Hub folder is not a real directory' });
  });

  it('holdAvailability reports an unexpected lstat error as unavailable, not ok', async () => {
    const fx = await buildFixture({ holdRoot: true });
    const fs = Object.assign(Object.create(fx.fs) as ReadFs, {
      lstat: async (p: string) => {
        if (p === fx.holdRoot) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return fx.fs.lstat(p);
      },
    });
    expect(await holdAvailability(fx.hubRoot, fs))
      .toEqual({ ok: false, reason: 'Could not check the Recently Deleted folder: EACCES' });
  });
});
