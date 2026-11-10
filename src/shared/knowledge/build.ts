// Builds the name-hint knowledge from the GGUF quant guide. Pure; run through scripts/knowledge/print.ts.
// Keep this file free of non-erasable TypeScript (enums, parameter properties): node runs it directly.
import type { Aliases, EntryKind, Knowledge, KnowledgeEntry } from './types';

const GLOSSARY_KINDS: Record<string, EntryKind> = {
  'size and architecture tags': 'size',
  'variant and modality tags': 'variant',
  'training tags': 'training',
  'uncensoring tags': 'uncensoring',
  'speculative decoding tags': 'speculative',
  'quant method tags': 'quant-method',
  'runtimes, engines and files': 'runtime',
  "davidau's other labels": 'author-label',
  'model families seen in the sample': 'family',
};

const MEANING_COLUMNS = ['meaning', 'notes', 'what the mix does', 'what it is', 'what you need instead'];

/** GitHub's heading anchor. */
export function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
  return cells.map((c) => c.replace(/\\\|/g, '|').trim());
}

/** The kind of the entries of the tables under a heading, or null when the section is not knowledge. */
function kindFor(h2: string, h3: string): EntryKind | null {
  const glossary = GLOSSARY_KINDS[h3.toLowerCase()];
  if (glossary !== undefined && h2.startsWith('9.')) return glossary;
  if (h2.startsWith('3.')) return 'quant-type';
  if (h2.startsWith('4.')) return 'recipe';
  if (h2.startsWith('7.')) return 'format';
  if (h2.startsWith('1.') && h3.toLowerCase() === 'file name parts') return 'file-part';
  return null;
}

function tokensOf(cell: string, kind: EntryKind): string[] {
  if (kind === 'family') {
    return stripMarkdown(cell.replace(/\([^)]*\)/g, ''))
      .split(', ')
      .map((t) => t.trim())
      .filter((t) => t !== '');
  }
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? '').trim()).filter((t) => t !== '');
}

function firstNumber(cell: string): number | undefined {
  const m = /\d+(?:\.\d+)?/.exec(cell);
  return m === null ? undefined : Number(m[0]);
}

function firstSentence(s: string): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(s);
  return (m === null ? s : m[0]).replace(/\.$/, '');
}

/** Fills `into` from a second row with the same id. The row with a real meaning cell supplies section, title and text together. */
function merge(into: KnowledgeEntry, from: KnowledgeEntry, intoReal: boolean, fromReal: boolean): boolean {
  for (const t of from.tokens) if (!into.tokens.includes(t)) into.tokens.push(t);
  for (const p of from.patterns) if (!into.patterns.includes(p)) into.patterns.push(p);
  if (!intoReal && fromReal) {
    into.text = from.text;
    into.title = from.title;
    into.section = from.section;
  }
  if (into.bpw === undefined && from.bpw !== undefined) into.bpw = from.bpw;
  if (into.verdict === undefined && from.verdict !== undefined) into.verdict = from.verdict;
  if (from.authorLabel === true) into.authorLabel = true;
  return intoReal || fromReal;
}

export function buildKnowledge(markdown: string, aliases: Aliases): Knowledge {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const checked = /\*\*Checked on\*\*\s*\|\s*(\d{4}-\d{2}-\d{2})/.exec(markdown);
  const checkedOn = checked?.[1] ?? '';

  const byId = new Map<string, KnowledgeEntry>();
  const real = new Set<string>();
  const add = (e: KnowledgeEntry, hasMeaning: boolean): void => {
    const have = byId.get(e.id);
    if (have === undefined) {
      byId.set(e.id, e);
      if (hasMeaning) real.add(e.id);
    } else if (merge(have, e, real.has(e.id), hasMeaning)) real.add(e.id);
  };

  let h2 = '';
  let h3: string;
  let section = '';
  let inFence = false;
  let header: string[] | null = null;
  let originalHeader: string[] | null = null;
  let kind: EntryKind | null = null;

  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const text = stripMarkdown(heading[2] ?? '');
      if (heading[1] === '##') {
        h2 = text;
        h3 = '';
      } else h3 = text;
      section = slug(text);
      kind = kindFor(h2, h3);
      header = null;
      continue;
    }
    if (!line.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = splitRow(line);
    if (header === null) {
      originalHeader = cells;
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    if (kind === null) continue;

    const tokens = tokensOf(cells[0] ?? '', kind);
    const first = tokens[0];
    if (first === undefined) continue;
    const col = (names: string[]): string | undefined => {
      const i = header!.findIndex((h) => names.includes(h));
      return i < 0 ? undefined : cells[i];
    };
    const meaning = stripMarkdown(col(MEANING_COLUMNS) ?? '');
    const bpwCell = col(['bpw', 'bpw of base type']);
    const verdictCell = col(['verdict']);
    // No meaning cell: describe the row by its other cells so every entry has text.
    const others = originalHeader!
      .map((h, i) => ({ h, v: stripMarkdown(cells[i] ?? '') }))
      .filter((c, i) => i > 0 && c.v !== '')
      .map((c) => `${c.h}: ${c.v}.`)
      .join(' ');
    const text = meaning !== '' ? meaning : others !== '' ? others : stripMarkdown(cells[0] ?? '');
    const entry: KnowledgeEntry = {
      id: `${kind}:${first}`,
      kind,
      tokens,
      patterns: [],
      title: `${first}: ${firstSentence(text)}`,
      text,
      section,
    };
    const bpw = bpwCell === undefined ? undefined : firstNumber(bpwCell);
    if (bpw !== undefined) entry.bpw = bpw;
    if (verdictCell !== undefined && verdictCell !== '') entry.verdict = stripMarkdown(verdictCell);
    if (kind === 'author-label' || /author(?:'s own)? labels?/i.test(meaning)) entry.authorLabel = true;
    add(entry, meaning !== '');
  }

  for (const a of aliases) {
    add({ id: a.id, kind: a.kind, tokens: a.tokens ?? [], patterns: a.patterns, title: a.title, text: a.text, section: a.section }, true);
    // An alias for an entry the guide also has speaks for it: the same hint for every spelling.
    Object.assign(byId.get(a.id)!, { title: a.title, text: a.text, section: a.section });
  }
  return { checkedOn, entries: [...byId.values()] };
}
