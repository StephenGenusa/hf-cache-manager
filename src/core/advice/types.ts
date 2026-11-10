// Shared types for file advice. Pure data: no Node, no electron.
import type { RepoFormat, Tool } from '../../shared/knowledge/rules';
import type { AdviceSettings, MachineProfile } from './profile';
import type { Knowledge } from '../../shared/knowledge/types';
import type { DiffusionSignal } from '../classify/diffusion-signal';
import type { GroupKind, RepoKind } from '../types';
import type { ModelShape } from './shape';

export type { AdviceSettings, GpuKind, MachineProfile } from './profile';

export type Tint = 'green' | 'yellow' | 'red';

/** One group of the detail view, as facts: works for files on disk and, later, files not downloaded yet. */
export interface AdviceGroupInput {
  key: string; kind: GroupKind; label: string; bytes: number; relpaths: string[];
  shape: ModelShape | null; shards: { present: number; expected: number } | null; locked: boolean;
}

export interface AdviceInput {
  /** `repoKind` is the classifier's primary kind: only language-model repos get a format line, and transformers
   *  repos and diffusers pipelines one judgment for the whole repo. */
  repoId: string; format: RepoFormat; repoKind: RepoKind; groups: AdviceGroupInput[];
  /** The model's shape from config.json (transformers repos), null when unknown or not read. */
  repoShape: ModelShape | null;
  /** The weight bytes `countedWeights` picks (one format, one variant for pipelines, each folder's index), with a note
   *  naming the duplicates left out: a transformers repo's weights, a pipeline's components; null when not judged. */
  repoWeights: { bytes: number; note: string | null } | null;
  /** A partial download (`.incomplete`) or a sharded checkpoint whose index names a shard that is not present. */
  incomplete: boolean;
  /** Why a 'diffusion' repo is one, which words its repo line. */
  diffusionSignal?: DiffusionSignal | null;
  machine: MachineProfile; settings: AdviceSettings; tools: Tool[]; knowledge: Knowledge;
}

export interface GroupAdvice { key: string; tint: Tint | null; reason: string; explanation: string; facts: string[] }

export interface RepoAdvice { groups: GroupAdvice[]; repoLine: GroupAdvice | null; basis: string }
