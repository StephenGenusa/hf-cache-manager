import { expectTypeOf, it } from 'vitest';
import type {
  Op, OpRole, ExecErrorCode, FreedReason, GroupKind, RepoKind, FileFacts, SafeRoots, DeletionPlan,
  Repo, ExecResult, ExecHooks, ViewImpactLine, ViewImpactProvider, CacheModel,
} from '../../src/core/types';
import { useCanaries } from '../helpers/canary';

useCanaries();

// Enforced by `npm run typecheck` (tests/** is in tsconfig.node.json); vitest alone proves nothing here.
it('Op kinds are exactly the contract set', () => {
  expectTypeOf<Op['kind']>().toEqualTypeOf<
    'unlink' | 'rmdir-empty' | 'hold-rename' | 'restore-rename' | 'store-sweep' | 'store-refs-add' | 'write-file'>();
});
it('unions match the contract', () => {
  expectTypeOf<OpRole>().toEqualTypeOf<'snapshot-link' | 'repo-blob' | 'repo-folder' | 'store-payload' | 'view-link' | 'view-manifest' | 'view-blob' | 'held-item'>();
  expectTypeOf<ExecErrorCode>().toEqualTypeOf<'STALE' | 'EXPIRED' | 'USED' | 'UNKNOWN_PLAN' | 'FINGERPRINT' | 'CONFIRM' | 'CONTAINMENT' | 'LOCKED' | 'ACTIVE_DOWNLOAD' | 'IO' | 'ROLLED_BACK'>();
  expectTypeOf<FreedReason>().toEqualTypeOf<'only-link' | 'hardlink-others-remain' | 'hardlink-all-planned' | 'store-shared' | 'store-unreferenced' | 'store-uncertain' | 'link-only' | 'plain-file' | 'special-file'>();
  expectTypeOf<GroupKind>().toEqualTypeOf<'quant' | 'mmproj' | 'draft' | 'component' | 'weights' | 'tokenizer-config' | 'assets' | 'superseded' | 'root-file' | 'other'>();
  expectTypeOf<RepoKind>().toEqualTypeOf<'gguf' | 'diffusers' | 'transformers' | 'adapter' | 'single-file' | 'diffusion' | 'component' | 'dataset' | 'space' | 'unknown'>();
});
it('FileFacts and SafeRoots shapes', () => {
  expectTypeOf<FileFacts>().toEqualTypeOf<{ dev: number; ino: number; size: number; mtimeMs: number; nlink: number; isSymlink: boolean; isDirectory: boolean; isFile: boolean; linkTarget?: string }>();
  expectTypeOf<SafeRoots>().toEqualTypeOf<{ hubRoot: string; viewRoots: string[]; holdRoot: string | null }>();
  expectTypeOf<DeletionPlan['confirmPhrase']>().toEqualTypeOf<string | null>();
});
it('later contract additions', () => {
  expectTypeOf<Repo['folderFacts']>().toEqualTypeOf<FileFacts>();
  expectTypeOf<Repo['otherFiles']>().toEqualTypeOf<Array<{ path: string; facts: FileFacts }>>();
  expectTypeOf<Repo['otherDirs']>().toEqualTypeOf<string[]>();
  expectTypeOf<ExecResult['notes']>().toEqualTypeOf<string[] | undefined>();
  expectTypeOf<ViewImpactLine['action']>().toEqualTypeOf<'remove' | 'keep-shared' | 'state-update' | 'blocked' | 'foreign'>();
  expectTypeOf<ExecHooks['beforeFirstOp']>().toEqualTypeOf<((plan: DeletionPlan) => Promise<void>) | undefined>();
  expectTypeOf<ExecHooks['afterOp']>().toEqualTypeOf<((plan: DeletionPlan, index: number) => Promise<void>) | undefined>();
  expectTypeOf<ViewImpactProvider['impactFor']>().toEqualTypeOf<
    (model: CacheModel, doomedRepoBlobPaths: string[]) => Promise<{ ops: Op[]; lines: ViewImpactLine[] }>>();
});
it('negative cases fail typecheck if the types were wrong', () => {
  // @ts-expect-error 'bogus' is not an Op kind
  const k: Op['kind'] = 'bogus';
  // @ts-expect-error 'foreign' must not be missing from, and 'other' must not be in, the action union
  const a: ViewImpactLine['action'] = 'other';
  // @ts-expect-error notes is string[], not number[]
  const n: ExecResult['notes'] = [1];
  // @ts-expect-error Repo.folderFacts is FileFacts, not string
  const f: Repo['folderFacts'] = 'x';
  void [k, a, n, f];
});
