// LM Studio view driver: <root>/<org>/<name>/<basename>.gguf absolute symlinks into the hub's repo blobs.
// Deviations from the CLI, all in the safe direction:
// - `remove` ignores its owned-sha argument (only the Ollama view needs it) and never deletes a non-symlink (the CLI unlinks a user's regular file at an owned path); it warns.
// - A symlink is removed only when the plan's recorded facts still match; otherwise it is kept with a warning.
// - Folders that are symlinks are never traversed or created through (V20); the entry is skipped with a warning.
// - `isStale` compares link targets with the realpath'd hub only (V33, see linkIntoHub).
import { dirname, join } from 'node:path';
import { pyCompare, pySort } from '../compat/pyjson';
import { STATE_FILE, withinView, type OwnedEntry } from '../compat/state';
import { factsMatch, factsOf, readFs, type ReadFs } from '../fsx';
import { viewPathProblemResolved } from './view-path';
import { SafeFsError } from '../safe-fs';
import type { FileFacts } from '../types';
import { mmprojFor } from './entries';
import type { ApplyCtx, Desired, ForeignEntry, GgufEntry, LinkSpec, Presence, ViewDriver } from './view-types';
import { CreateIncomplete, SkipEntry } from './view-types';
import { ensureParent, linkIntoHub, removeEmptyParents, viewFs, walkTree } from './walk';

type Status = 'ok' | 'wrong' | 'missing';

const slashes = (s: string): number => s.split('/').length - 1;
const hasGgufSuffix = (rel: string): boolean => (process.platform === 'win32' ? rel.toLowerCase() : rel).endsWith('.gguf');

export function lmstudioDriver(root: string, hubRoot: string, fs: ReadFs = readFs): ViewDriver {
  const abs = (rel: string): string => join(root, ...rel.split('/'));

  const statusOf = (l: LinkSpec, facts: FileFacts | null): Status =>
    facts === null ? 'missing' : facts.isSymlink && facts.linkTarget === l.target ? 'ok' : 'wrong';

  const statuses = async (d: Desired): Promise<Array<{ link: LinkSpec; facts: FileFacts | null; status: Status }>> => {
    const out = [];
    for (const link of d.links) {
      const facts = await factsOf(fs, abs(link.path));
      out.push({ link, facts, status: statusOf(link, facts) });
    }
    return out;
  };

  return {
    name: 'lmstudio',
    root,

    desired(entries: GgufEntry[], warnings: string[]): Desired[] {
      const out: Desired[] = [];
      const taken = new Map<string, string>();
      const repoIds = [...new Set(entries.map((e) => e.repoId))];
      for (const repoId of repoIds) {
        const weights = entries.filter((e) => e.repoId === repoId && !e.isMmproj).sort((a, b) =>
          (a.isCurrent ? 0 : 1) - (b.isCurrent ? 0 : 1) || slashes(a.relpath) - slashes(b.relpath) || pyCompare(a.relpath, b.relpath));
        for (const e of weights) {
          const rel = `${repoId}/${e.basename}`;
          const mm = mmprojFor(entries, repoId);
          const outside = [rel, ...(mm === null ? [] : [`${repoId}/${mm.basename}`])].find((p) => !withinView(p));
          if (outside !== undefined) {
            warnings.push(`[lmstudio] ${e.key}: view path ${outside} lies outside the view; skipped`);
            continue;
          }
          const other = taken.get(rel);
          if (other !== undefined) {
            warnings.push(`[lmstudio] ${e.key}: ${rel} already used by ${other}; skipped`);
            continue;
          }
          taken.set(rel, e.key);
          const links: LinkSpec[] = [{ path: rel, primary: true, target: e.blobPath }];
          if (mm !== null) links.push({ path: `${repoId}/${mm.basename}`, primary: false, target: mm.blobPath });
          out.push({ key: e.key, repoId, sha256: e.sha256, paths: pySort(links.map((l) => l.path)), links });
        }
      }
      return out;
    },

    async presence(d: Desired): Promise<Presence> {
      const st = await statuses(d);
      if (st.some((s) => s.status === 'wrong')) return 'wrong';
      if (st.find((s) => s.link.primary)?.status !== 'ok') return 'absent';
      return st.every((s) => s.status === 'ok') ? 'correct' : 'partial';
    },

    async isStale(d: Desired, _owned: OwnedEntry): Promise<boolean> {
      const wrong = (await statuses(d)).filter((s) => s.status === 'wrong');
      return wrong.length > 0 && wrong.every((s) =>
        s.facts?.linkTarget !== undefined && linkIntoHub(dirname(abs(s.link.path)), s.facts.linkTarget, hubRoot));
    },

    async foreignReason(): Promise<undefined> {
      return undefined;   // a wrong LM Studio path is reported by `foreign` itself
    },

    async foreign(ownedPaths: ReadonlySet<string>): Promise<ForeignEntry[]> {
      const out: ForeignEntry[] = [];
      for await (const { rel, facts } of walkTree(fs, root, (r) => r === STATE_FILE)) {
        if (!hasGgufSuffix(rel) || ownedPaths.has(rel)) continue;
        if (facts.linkTarget !== undefined) out.push({ key: `lmstudio:${rel}`, path: rel, target: facts.linkTarget });
        else if (facts.isFile) out.push({ key: `lmstudio:${rel}`, path: rel });
      }
      return out;
    },

    async create(d: Desired, ctx: ApplyCtx): Promise<string[]> {
      const vfs = viewFs(ctx.safeFs, root, ctx.fs);
      // Phase 1, no writes: every refusal happens before the first link is touched.
      const todo: Array<{ link: LinkSpec; path: string; status: Status; expect: FileFacts | null }> = [];
      for (const link of d.links) {
        const p = abs(link.path);
        const problem = await viewPathProblemResolved(ctx.fs, p, root, ctx.safeFs.roots);
        if (problem !== null) throw new SkipEntry(`${link.path}: ${problem}; skipped`);
        const facts = await factsOf(ctx.fs, p);
        if (facts !== null && !facts.isSymlink) throw new SkipEntry(`a file exists at ${link.path}`);
        const status = statusOf(link, facts);
        if (status === 'ok') continue;
        let expect: FileFacts | null = null;
        if (status === 'wrong') {
          expect = ctx.expect(link.path) ?? null;
          if (expect === null || facts === null || !factsMatch(facts, expect)) throw new SkipEntry('changed since preview');
        }
        todo.push({ link, path: p, status, expect });
      }
      for (const t of todo) await ensureParent(ctx, root, t.path);
      // Phase 2: replace wrong symlinks, create missing ones. A correct link is left alone (CLI create: continue).
      const written: string[] = [];
      for (const t of todo) {
        try {
          if (t.expect !== null) {
            await vfs.unlink(t.path, t.expect);
            written.push(t.link.path);   // the old link is gone from here on
          }
          await vfs.symlink(t.link.target, t.path);
          if (!written.includes(t.link.path)) written.push(t.link.path);
        } catch (e) {
          // SkipEntry still means "nothing written"; after the first write the failure is CreateIncomplete.
          if (written.length > 0) throw new CreateIncomplete(written, e);
          if (e instanceof SafeFsError && e.code !== 'IO') throw new SkipEntry(`${t.link.path}: ${e.message}; skipped`);
          throw e;
        }
      }
      return [...d.paths];
    },

    async remove(paths: string[], ctx: ApplyCtx, _sha256: string): Promise<string[]> {
      const vfs = viewFs(ctx.safeFs, root, ctx.fs);
      const removed: string[] = [];
      for (const rel of paths) {
        const p = abs(rel);
        const problem = await viewPathProblemResolved(ctx.fs, p, root, ctx.safeFs.roots);
        if (problem !== null) {
          ctx.warnings.push(`${rel}: ${problem}; not removed`);
          continue;
        }
        // viewPathProblemResolved above already proves the parent resolves inside the view root (CLI inside_root).
        const facts = await factsOf(ctx.fs, p);
        if (facts === null) continue;
        if (!facts.isSymlink) {
          ctx.warnings.push(`${rel}: not a symlink; left in place`);
          continue;
        }
        const expect = ctx.expect(rel);
        if (expect === null || expect === undefined || !factsMatch(facts, expect)) {
          ctx.warnings.push(`${rel}: changed since preview; left in place`);
          continue;
        }
        try {
          await vfs.unlink(p, expect);
        } catch (e) {
          if (e instanceof SafeFsError && e.code !== 'IO') {
            ctx.warnings.push(`${rel}: ${e.code === 'STALE' ? 'changed since preview' : e.message}; left in place`);
            continue;
          }
          throw e;
        }
        removed.push(rel);
        await removeEmptyParents(ctx, root, p);
      }
      return removed;
    },
  };
}
