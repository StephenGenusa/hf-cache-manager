export interface GgufSpec { arch: string; fileType: number; tensors: number[][]; tokens?: number; pad?: number }
export interface CaseFile { path: string; text?: string; gguf?: GgufSpec; plain?: boolean; store?: boolean; dangling?: boolean }
export interface CaseSnapshot { commit: string; mtime: number; files: CaseFile[] }
export interface CaseRepo { id: string; type?: 'model' | 'dataset' | 'space'; main: string; snapshots: CaseSnapshot[] }
export type ViewFileSpec = string | { link: string };
export interface CaseSpec {
  repos: CaseRepo[];
  views: Array<'lmstudio' | 'ollama'>;
  aliases?: Record<string, string>;
  viewFiles?: { lmstudio?: Record<string, ViewFileSpec>; ollama?: Record<string, ViewFileSpec> };
  noConfig?: boolean;
}
export interface BuiltCase {
  dir: string; hub: string; home: string; configPath: string;
  lmstudio: string | null; ollama: string | null;
  env: { HF_HUB_CACHE: string; HFHUB_CONFIG: string; HF_HOME: string };
}
export function buildCase(dir: string, spec: CaseSpec): Promise<BuiltCase>;
export function ggufBytes(o: GgufSpec): Uint8Array;
export function sha256Hex(b: Uint8Array | string): string;
