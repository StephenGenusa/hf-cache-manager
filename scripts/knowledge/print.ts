// Builds the knowledge JSON from the GGUF quant guide and writes src/shared/knowledge/knowledge.generated.json:
//   HFCM_QUANT_GUIDE=<path to the guide .md> npm run knowledge
// Without the guide nothing is written and the committed JSON stays as it is.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildKnowledge } from '../../src/shared/knowledge/build.ts';

const at = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const guide = process.env['HFCM_QUANT_GUIDE'] ?? '';
if (guide === '' || !existsSync(guide)) {
  console.error('knowledge: set HFCM_QUANT_GUIDE to the guide .md; knowledge.generated.json is left as it is');
  process.exit(1);
}
const md = readFileSync(guide, 'utf8');
const aliases = JSON.parse(readFileSync(at('src/shared/knowledge/aliases.json'), 'utf8'));
writeFileSync(at('src/shared/knowledge/knowledge.generated.json'), `${JSON.stringify(buildKnowledge(md, aliases), null, 2)}\n`);
