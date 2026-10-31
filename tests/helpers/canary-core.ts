import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isUnderTmp } from './tmp';

export interface CanaryRecord {
  path: string;
  kind: 'file' | 'symlink' | 'dir';
  ino: number;
  sha256?: string;
  linkTarget?: string;
}
export interface CanaryContext {
  readonly sandbox: string;
  plant(p: string, content?: string | Uint8Array): Promise<string>;
  protect(paths: string[]): Promise<void>;
  /** Verify then stop protecting paths strictly under `root`; throws (keeping the records) on any path outside root or any violation. */
  releaseUnder(root: string, paths: string[]): Promise<void>;
  verify(): Promise<string[]>;
  onCleanup(fn: () => Promise<void>): void;
  records(): readonly CanaryRecord[];
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export function contentFor(text: string, size: number): Buffer {
  return Buffer.from(text.repeat(Math.ceil(size / text.length)).slice(0, size));
}

async function snapshot(path: string): Promise<CanaryRecord> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) return { path, kind: 'symlink', ino: st.ino, linkTarget: await readlink(path) };
  if (st.isDirectory()) return { path, kind: 'dir', ino: st.ino };
  return { path, kind: 'file', ino: st.ino, sha256: sha(await readFile(path)) };
}

export class Context implements CanaryContext {
  private recs = new Map<string, CanaryRecord>();
  private cleanups: Array<() => Promise<void>> = [];
  constructor(readonly sandbox: string) {}

  async plant(p: string, content: string | Uint8Array = 'canary\n'): Promise<string> {
    const abs = isAbsolute(p) ? resolve(p) : join(this.sandbox, p);
    if (!isUnderTmp(abs)) throw new Error(`plant refuses ${p}: outside tmp`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    await this.protect([abs]);
    return abs;
  }
  async protect(paths: string[]): Promise<void> {
    for (const p of paths) this.recs.set(p, await snapshot(p));
  }
  async releaseUnder(root: string, paths: string[]): Promise<void> {
    const base = resolve(root);
    for (const p of paths) {
      if (!resolve(p).startsWith(base + '/')) throw new Error(`releaseUnder refuses ${p}: not strictly under ${root}`);
    }
    const recs = paths.map((p) => this.recs.get(p)).filter((r): r is CanaryRecord => r !== undefined);
    const violations = await this.check(recs);
    if (violations.length) throw new Error(`canary violations before release: ${violations.join('; ')}`);
    for (const p of paths) this.recs.delete(p);
  }
  async verify(): Promise<string[]> {
    return this.check([...this.recs.values()]);
  }
  private async check(recs: CanaryRecord[]): Promise<string[]> {
    const out: string[] = [];
    for (const r of recs) {
      let cur: CanaryRecord;
      try {
        cur = await snapshot(r.path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          out.push(`${r.path}: missing`);
          continue;
        }
        throw e;
      }
      if (cur.kind !== r.kind) {
        out.push(`${r.path}: type changed`);
        continue;
      }
      if (cur.ino !== r.ino) out.push(`${r.path}: replaced (inode changed)`);
      if (r.kind === 'file' && cur.sha256 !== r.sha256) out.push(`${r.path}: content changed`);
      if (r.kind === 'symlink' && cur.linkTarget !== r.linkTarget) out.push(`${r.path}: link target changed`);
    }
    return out;
  }
  onCleanup(fn: () => Promise<void>): void {
    this.cleanups.push(fn);
  }
  records(): readonly CanaryRecord[] {
    return [...this.recs.values()];
  }
  takeCleanups(): Array<() => Promise<void>> {
    return this.cleanups.reverse();
  }
}


/** Vitest-free canary context for one sandbox: Playwright fixtures call verify() then run the cleanups. */
export function createCanaryContext(sandbox: string): Context {
  return new Context(sandbox);
}

/** The standard canaries: a 4 KiB file, a nested file and a link to the first (link skipped where symlinks are refused). */
export async function plantStandardCanaries(ctx: CanaryContext): Promise<void> {
  await ctx.plant('outside.bin', contentFor('canary\n', 4096));
  await ctx.plant('nested/deep/outside.txt', 'outside canary\n');
  try {
    const l = join(ctx.sandbox, 'link-to-outside');
    await symlink('outside.bin', l);
    await ctx.protect([l]);
  } catch (e) {
    if (!['EPERM', 'ENOSYS', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
  }
}
