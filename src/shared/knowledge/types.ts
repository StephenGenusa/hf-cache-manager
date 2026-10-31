export type EntryKind =
  | 'quant-type' | 'recipe' | 'file-part' | 'size' | 'variant' | 'training' | 'uncensoring'
  | 'speculative' | 'quant-method' | 'runtime' | 'family' | 'format' | 'author-label';

export interface KnowledgeEntry {
  /** Stable: `${kind}:${first token}`. */
  id: string;
  kind: EntryKind;
  /** Literal tags, as written in the guide's first column. */
  tokens: string[];
  /** Regex sources from aliases.json (matched case-insensitively, anchored to a part). */
  patterns: string[];
  title: string;
  /** The table's meaning cell, markdown links and backticks stripped. */
  text: string;
  /** Guide anchor, e.g. "speculative-decoding-tags". */
  section: string;
  bpw?: number;
  verdict?: string;
  authorLabel?: boolean;
}

export interface Knowledge {
  checkedOn: string;
  entries: KnowledgeEntry[];
}

export type Aliases = Array<{
  id: string;
  kind: EntryKind;
  title: string;
  text: string;
  section: string;
  patterns: string[];
  tokens?: string[];
}>;
