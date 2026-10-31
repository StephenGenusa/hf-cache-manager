import type { Knowledge, KnowledgeEntry } from './types';

export interface NamePart {
  text: string;
  entryId: string | null;
  looksLikeTag: boolean;
}

const SEPARATOR = /[/\-. ]/;
const MAX_RUN_SPAN = 4;
const EXTENSION = /\.gguf$/i;

/** Quant types and recipe tokens appear in any case in file names; short ones stay exact so 'It' is not 'it'. */
function isCaseInsensitive(entry: KnowledgeEntry, token: string): boolean {
  return (
    (entry.kind === 'quant-type' || entry.kind === 'recipe') && token.length > 3
  );
}

interface Index {
  exact: Map<string, string>;
  folded: Map<string, string>;
  patterns: Array<{ re: RegExp; id: string }>;
}

const indexes = new WeakMap<Knowledge, Index>();

function buildIndex(k: Knowledge): Index {
  const exact = new Map<string, string>();
  const folded = new Map<string, string>();
  const patterns: Index['patterns'] = [];
  for (const e of k.entries) {
    for (const raw of e.tokens) {
      // The guide writes some tags with a leading or trailing separator ('UD-', '-Quality', 'MTP/').
      const token = raw.replace(/^[/\-.]+|[/\-.]+$/g, '');
      if (
        !token ||
        SEPARATOR.test(token.replace(/[-.]/g, '')) ||
        token.includes('/')
      )
        continue;
      if (!exact.has(token)) exact.set(token, e.id);
      if (isCaseInsensitive(e, token) && !folded.has(token.toLowerCase()))
        folded.set(token.toLowerCase(), e.id);
    }
    for (const p of e.patterns)
      patterns.push({ re: new RegExp(`^(?:${p})$`, 'i'), id: e.id });
  }
  return { exact, folded, patterns };
}

function lookup(span: string, ix: Index): string | null {
  return (
    ix.exact.get(span) ??
    ix.folded.get(span.toLowerCase()) ??
    ix.patterns.find((p) => p.re.test(span))?.id ??
    null
  );
}

function looksLikeTag(run: string): boolean {
  if (run.length > 12) return false;
  if (/^[A-Z0-9_]+$/.test(run) && /[A-Z]/.test(run)) return true;
  return /\d/.test(run) && run.includes('_');
}

/** Splits a repo id, quant label or file name into parts; the texts always join back to the input. */
export function nameParts(text: string, k: Knowledge): NamePart[] {
  let ix = indexes.get(k);
  if (!ix) indexes.set(k, (ix = buildIndex(k)));

  const ext = EXTENSION.exec(text);
  const body = ext ? text.slice(0, ext.index) : text;

  // Alternating runs and single-character separators.
  const pieces: Array<{ text: string; sep: boolean }> = [];
  let run = '';
  for (const ch of body) {
    if (SEPARATOR.test(ch)) {
      if (run) pieces.push({ text: run, sep: false });
      run = '';
      pieces.push({ text: ch, sep: true });
    } else run += ch;
  }
  if (run) pieces.push({ text: run, sep: false });

  const parts: NamePart[] = [];
  let i = 0;
  while (i < pieces.length) {
    const piece = pieces[i]!;
    if (piece.sep) {
      parts.push({ text: piece.text, entryId: null, looksLikeTag: false });
      i++;
      continue;
    }
    let matched = false;
    // Longest span first: up to MAX_RUN_SPAN runs and the separators between them.
    for (let runs = MAX_RUN_SPAN; runs >= 1 && !matched; runs--) {
      let end = i;
      let seen = 1;
      while (
        seen < runs &&
        end + 2 < pieces.length &&
        pieces[end + 1]!.sep &&
        !pieces[end + 2]!.sep
      ) {
        end += 2;
        seen++;
      }
      if (seen !== runs) continue;
      const span = pieces
        .slice(i, end + 1)
        .map((p) => p.text)
        .join('');
      const id = lookup(span, ix);
      // A span is one part only when its runs cannot each be explained on their own ('UD-Q4_K_XL' is UD + Q4_K_XL).
      const runTexts = pieces.slice(i, end + 1).filter((p) => !p.sep);
      const finer = runs > 1 && runTexts.every((p) => lookup(p.text, ix));
      if (id && !finer) {
        parts.push({ text: span, entryId: id, looksLikeTag: false });
        i = end + 1;
        matched = true;
      }
    }
    if (!matched) {
      parts.push({
        text: piece.text,
        entryId: null,
        looksLikeTag: looksLikeTag(piece.text),
      });
      i++;
    }
  }
  if (ext) parts.push({ text: ext[0], entryId: null, looksLikeTag: false });
  return parts;
}
