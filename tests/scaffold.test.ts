import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('scaffold', () => {
  it('is an ESM package on Node >= 22', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.engines.node).toBe('>=22');
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22);
  });
  it('pins every dependency to an exact version', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [name, v] of Object.entries(all)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('defines the shared commands', () => {
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts.lint).toBe('eslint .');
    expect(pkg.scripts.typecheck).toBe('tsc -b');
    expect(pkg.scripts.build).toBe('electron-vite build');
  });
});
