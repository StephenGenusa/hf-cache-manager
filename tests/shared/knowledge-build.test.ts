import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import aliasesJson from '../../src/shared/knowledge/aliases.json';
import { buildKnowledge } from '../../src/shared/knowledge/build';
import { KNOWLEDGE } from '../../src/shared/knowledge';
import type { Aliases } from '../../src/shared/knowledge/types';

const aliases = aliasesJson as Aliases;
const k = KNOWLEDGE;
const byToken = (t: string) => k.entries.find((e) => e.tokens.includes(t));
const entry = (id: string) => k.entries.find((e) => e.id === id)!;

test('checkedOn is read from the guide header', () => expect(k.checkedOn).toBe('2026-10-25'));
test('every backticked tag of the tag list has an entry', () => {
  for (const t of ['MTP', 'abliterated', 'Heretic', 'it', 'VL', 'mmproj', 'QAT', 'UD', 'i1', 'APEX', 'XQ'])
    expect(byToken(t), t).toBeDefined();
});
test('quant types carry bpw from the type table', () => {
  expect(byToken('Q6_K')).toMatchObject({ kind: 'quant-type', bpw: 6.5625 });
  expect(byToken('IQ4_XS')).toMatchObject({ kind: 'quant-type', bpw: 4.25 });
  expect(byToken('Q4_K_M')!.verdict).toBe('The usual default.');
});
test('author labels are marked', () => expect(byToken('NEO')!.authorLabel).toBe(true));
test('aliases add patterns', () => expect(entry('file-part:shard').patterns).toContain('\\d{5}-of-\\d{5}'));
test('model families take their tokens from the plain first column', () => {
  expect(entry('family:Qwen3.5').tokens).toEqual(['Qwen3.5', 'Qwen3.6', 'Qwen3.8']);
  expect(byToken('Nemotron 3.5')).toBeDefined();
});
test('every entry has text', () => expect(KNOWLEDGE.entries.every((e) => e.text.trim().length > 0)).toBe(true));
test('a merged entry takes section, title and text from the same row', () => {
  const e = byToken('Q4_K_M')!;
  expect(e.section).toBe('32-k-quants-_k');
  expect(e.text).toMatch(/Q6_K/);
  expect(e.title).toContain('About half');
  expect(e.verdict).toBe('The usual default.');
  expect(e.bpw).toBe(4.5);
});
test('a row without a meaning cell is described by its other cells', () => {
  expect(byToken('IQ2_XXS')!.text).toContain('2.0625');
});
test('entry ids are unique', () => expect(new Set(k.entries.map((e) => e.id)).size).toBe(k.entries.length));
// HFCM_QUANT_GUIDE names the guide the JSON is built from (npm run knowledge); without it only the committed JSON is checked.
const GUIDE = process.env['HFCM_QUANT_GUIDE'] ?? '';
test.skipIf(GUIDE === '' || !existsSync(GUIDE))('the committed JSON is up to date with the guide (run `npm run knowledge`)', async () => {
  const md = (await readFile(GUIDE, 'utf8')).replace(/\r\n/g, '\n');
  expect(buildKnowledge(md, aliases)).toEqual(KNOWLEDGE);
});
