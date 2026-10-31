import { classifyRepo } from '../core/classify/classify';
import { factsOf, readFs } from '../core/fsx';
import { scanHub } from '../core/scan/scanner';
import type { CacheModel, RepoView } from '../core/types';
import type { ScanProgressDTO } from '../shared/api';

export interface ScanOutput { model: CacheModel; views: RepoView[] }
export type ScanMessage =
  | { type: 'progress'; p: ScanProgressDTO }
  | { type: 'done'; output: ScanOutput }
  | { type: 'error'; message: string };

/**
 * Read-only: scan the hub, then classify each repo, posting progress. Never throws; every failure (including a missing
 * hub, which must not look like an empty library) becomes one `error` message.
 */
export async function runScanJob(hubRoot: string, post: (m: ScanMessage) => void): Promise<void> {
  try {
    if ((await factsOf(readFs, hubRoot)) === null) throw new Error(`Cache not found at ${hubRoot}`);
    post({ type: 'progress', p: { phase: 'scan', done: 0, total: 1 } });
    const model = await scanHub(hubRoot);
    post({ type: 'progress', p: { phase: 'scan', done: 1, total: 1 } });
    const views: RepoView[] = [];
    for (const repo of model.repos) {
      views.push(classifyRepo(repo));
      post({ type: 'progress', p: { phase: 'classify', done: views.length, total: model.repos.length } });
    }
    post({ type: 'done', output: { model, views } });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}
