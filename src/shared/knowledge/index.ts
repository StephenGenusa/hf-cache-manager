import generated from './knowledge.generated.json';
import type { Knowledge } from './types';

export type { Aliases, EntryKind, Knowledge, KnowledgeEntry } from './types';
export const KNOWLEDGE = generated as unknown as Knowledge;
