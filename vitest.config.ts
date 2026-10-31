import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const all100 = { branches: 100, lines: 100, functions: 100, statements: 100 };

// Under Stryker (each test-runner process has STRYKER_MUTATOR_WORKER; this config is then read from a sandbox inside
// the project's gitignored .stryker-tmp/):
// - the fast-check properties run 10 times instead of 40, unless FC_NUM_RUNS is set explicitly: the deterministic tests
//   carry the mutation score, the properties only add to it;
// - TMPDIR is <project>/.stryker-tmp/t, so the run's temp dir (tests/global-run-tmp.ts) stays inside the project.
const underStryker = process.env.STRYKER_MUTATOR_WORKER !== undefined;
const strykerEnv: Record<string, string> = {};
if (underStryker) {
  if (process.env.FC_NUM_RUNS === undefined) strykerEnv.FC_NUM_RUNS = '10';
  const tmp = join(dirname(dirname(fileURLToPath(import.meta.url))), 't');
  mkdirSync(tmp, { recursive: true });
  process.env.TMPDIR = tmp;
}

export default defineConfig({
  test: {
    globalSetup: ['tests/global-run-tmp.ts'],
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/renderer/**', '**/node_modules/**'],
          env: strykerEnv,
        },
      },
      {
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/renderer/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/main/hub/policy.ts'],
      thresholds: {
        'src/core/plan/planner.ts': all100,
        'src/core/plan/closure.ts': all100,
        'src/core/plan/freed.ts': all100,
        'src/core/exec/executor.ts': all100,
        'src/core/exec/store-ops.ts': all100,
        'src/core/safe-fs.ts': all100,
        'src/core/hold/manifest.ts': all100,
        'src/core/hold/view-limits.ts': all100,
        'src/core/hold/held.ts': all100,
        'src/core/hold/tree.ts': all100,
        'src/core/sync/sync.ts': all100,
        'src/core/views/impact.ts': all100,
        'src/core/views/lmstudio.ts': all100,
        'src/core/views/ollama.ts': all100,
        'src/core/views/ollama-create.ts': all100,
        'src/core/views/walk.ts': all100,
        'src/core/compat/state.ts': all100,
        'src/core/views/reconcile.ts': all100,
        'src/core/views/view-path.ts': all100,
        'src/core/advice/engine.ts': all100,
        'src/core/advice/shape.ts': all100,
        'src/core/download/download-fs.ts': all100,
        'src/main/hub/policy.ts': all100,
      },
    },
  },
});
