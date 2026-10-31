/**
 * Checks the running Node against `engines.node` in package.json, for the release build scripts beside this file.
 * Only the ">=X", ">=X.Y" and ">=X.Y.Z" forms are understood; anything else is an error, so a change there is noticed
 * here.
 *
 *   node scripts/build/check-node.mjs     exit 0 and "Node 24.1.0 (needs >=22)", or exit 1
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const range = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines?.node;
const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range ?? '');
if (!m) {
  console.error(`check-node: package.json engines.node is ${JSON.stringify(range)}; expected ">=X[.Y[.Z]]"`);
  process.exit(1);
}
const want = m.slice(1).map((n) => Number(n ?? 0));
const have = process.versions.node.split('.').map(Number);
const cmp = have[0] - want[0] || have[1] - want[1] || have[2] - want[2];
if (cmp < 0) {
  console.error(`Node ${process.versions.node} is too old: this project needs Node ${range} (package.json engines).`);
  process.exit(1);
}
console.log(`Node ${process.versions.node} (needs ${range})`);
