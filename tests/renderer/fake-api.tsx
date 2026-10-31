import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { ApiProvider } from '../../src/renderer/lib/api';
import type {
  ApiResult, DownloadGroupDTO, GroupAdviceDTO, GroupDTO, HfcmApi, HubLookupDTO, LibraryDTO, MachineProfileDTO, PlanDTO, PlanPairDTO, NamePartDTO, RepoAdviceDTO, RepoDetailDTO, RepoSummaryDTO,
} from '../../src/shared/api';

import { KNOWLEDGE } from '../../src/shared/knowledge';
import { nameParts } from '../../src/shared/knowledge/name-parts';

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });

export const group = (key: string, kind: GroupDTO['kind'], label: string, bytes: number, over: Partial<GroupDTO> = {}): GroupDTO => ({
  key, kind, label, fileCount: 1, apparentBytes: bytes, reclaimableBytes: bytes, shards: null, locked: false,
  usedBy: { lmstudio: [], ollama: [] }, files: [], warning: null, ...over,
});

export const QWEN_DETAIL: RepoDetailDTO = {
  repoId: 'unsloth/Qwen3.6-27B-GGUF', type: 'model', kinds: ['gguf'], kindLabel: 'GGUF quant collection',
  revisionShort: 'a3f9c1e', downloadedAtMs: Date.UTC(2026, 8, 2), apparentBytes: 118_400_000_000, hasLockedGroups: false,
  groups: [
    group('quant:UD-Q4_K_XL', 'quant', 'UD-Q4_K_XL', 17_600_000_000, { usedBy: { lmstudio: ['Qwen3.6'], ollama: ['qwen3.6'] } }),
    group('quant:Q8_0', 'quant', 'Q8_0', 28_700_000_000, { usedBy: { lmstudio: ['Qwen3.6'], ollama: [] } }),
    group('quant:BF16', 'quant', 'BF16', 53_800_000_000, { fileCount: 2, shards: { present: 2, expected: 2 } }),
    group('quant:Q6_K', 'quant', 'Q6_K', 22_100_000_000, { reclaimableBytes: null }),
    group('mmproj:mmproj-F16', 'mmproj', 'mmproj-F16', 900_000_000),
    group('assets:README', 'assets', 'README + 4 images', 2_000_000, { fileCount: 5 }),
  ],
};

export const FLUX_DETAIL: RepoDetailDTO = {
  repoId: 'black-forest-labs/FLUX.1-dev', type: 'model', kinds: ['diffusers'], kindLabel: 'Diffusers pipeline',
  revisionShort: 'b1c2d3e', downloadedAtMs: Date.UTC(2026, 7, 14), apparentBytes: 57_900_000_000, hasLockedGroups: true,
  groups: [
    group('component:transformer/', 'component', 'transformer/', 23_800_000_000, { locked: true, fileCount: 3 }),
    group('component:vae/', 'component', 'vae/', 170_000_000, { locked: true }),
    group('root-file:flux1-dev.safetensors', 'root-file', 'flux1-dev.safetensors', 23_800_000_000),
  ],
};

const plan = (mode: PlanDTO['mode'], phrase: string | null): PlanDTO => ({
  planId: mode === 'hold' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002',
  fingerprint: 'a'.repeat(64), mode, purpose: 'delete', title: 'Review deletion — unsloth/Qwen3.6-27B-GGUF',
  repoIds: ['unsloth/Qwen3.6-27B-GGUF'], groupCount: 2, createdAt: 1_000, expiresAt: 601_000, filesRemoved: 3,
  freedBytes: 82_500_000_000, apparentBytes: 82_500_000_000, sharedBytes: 0, files: [], ops: [], viewLines: [],
  viewsUnaffected: ['ollama'], kept: [], keptFiles: [], warnings: [], confirmPhrase: phrase, holdRootDisplay: '/data/models/.hfcm-held',
});

export const QWEN_PAIR: PlanPairDTO = {
  hold: plan('hold', null), holdUnavailableReason: null, permanent: plan('permanent', 'unsloth/Qwen3.6-27B-GGUF'),
};

const repo = (repoId: string, kinds: RepoSummaryDTO['kinds'], badge: string, bytes: number, mod: number, over: Partial<RepoSummaryDTO> = {}): RepoSummaryDTO => ({
  repoId, type: 'model', kinds, badge, apparentBytes: bytes, lastModifiedMs: mod, usage: { lmstudio: 0, ollama: 0 },
  partialDownloads: 0, ambiguous: false, ...over,
});

export const LIBRARY: LibraryDTO = {
  hubRoot: '/data/models/hub', hubPresent: true, scannedAt: 5_000, hubBytes: 1_000_000_000_000, heldBytes: 0, heldCount: 0, lastAutoEmpty: null, scanError: null,
  repos: [
    repo('unsloth/Qwen3.6-27B-GGUF', ['gguf'], 'GGUF · 6 quants', 118_400_000_000, 300, { usage: { lmstudio: 2, ollama: 1 } }),
    repo('black-forest-labs/FLUX.1-dev', ['diffusers'], 'Diffusers pipeline', 57_900_000_000, 200),
    repo('Qwen/Qwen3-32B', ['transformers'], 'Safetensors · 17 shards', 65_500_000_000, 100),
    repo('bartowski/gemma-4-31b-it-GGUF', ['gguf'], 'GGUF · 3 quants', 54_000_000_000, 400, { usage: { lmstudio: 1, ollama: 0 } }),
    repo('org/partial', ['gguf'], 'GGUF · 1 quant', 1_000_000_000, 50, { partialDownloads: 2 }),
  ],
};

const parts = (text: string): NamePartDTO[] => nameParts(text, KNOWLEDGE).map((p) => ({ text: p.text, entryId: p.entryId, looksLikeTag: p.looksLikeTag }));
const GB = 1_000_000_000;
const dlFile = (path: string, size: number, state: 'absent' | 'cached' | 'partial' | 'update' = 'absent', have = 0) => ({ path, size: Math.round(size), state, have: Math.round(have) });
const dlGroup = (key: string, kind: DownloadGroupDTO['kind'], label: string, files: DownloadGroupDTO['files'], over: Partial<DownloadGroupDTO> = {}): DownloadGroupDTO => ({
  key, kind, label, files, complete: true, selectable: true, reason: null,
  requiresBytes: files.reduce((n, f) => n + (f.state === 'cached' ? 0 : f.size - (f.state === 'partial' ? f.have : 0)), 0), ...over,
});

/** A realistic Hub look-up of a GGUF repo: a green quant, a yellow partial one, a red one, a cached one, an update, a green mmproj and an incomplete set. */
export const HUB_LOOKUP: HubLookupDTO = {
  lookupId: '11111111-1111-4111-8111-111111111111', repoId: 'unsloth/Qwen3.6-27B-GGUF', type: 'model', revision: 'main',
  commit: 'a3f9c1e0000000000000000000000000000000aa', badge: 'GGUF · 6 quants', gated: false, private: false, lastModified: '2026-10-01T10:00:00Z',
  downloadable: true, notDownloadableReason: null, shapesPending: true,
  groups: [
    dlGroup('quant:UD-Q4_K_XL', 'quant', 'UD-Q4_K_XL', [dlFile('Qwen3.6-27B-UD-Q4_K_XL.gguf', 17.6 * GB)]),
    dlGroup('quant:Q8_0', 'quant', 'Q8_0', [dlFile('Qwen3.6-27B-Q8_0.gguf', 19.6 * GB, 'partial', 12.3 * GB)]),
    dlGroup('quant:BF16', 'quant', 'BF16', [dlFile('Qwen3.6-27B-BF16.gguf', 53.8 * GB)]),
    dlGroup('quant:Q6_K', 'quant', 'Q6_K', [dlFile('Qwen3.6-27B-Q6_K.gguf', 22.1 * GB, 'cached', 22.1 * GB)]),
    dlGroup('quant:Q5_K_M', 'quant', 'Q5_K_M', [dlFile('Qwen3.6-27B-Q5_K_M.gguf', 19.1 * GB, 'update', 19.1 * GB)]),
    dlGroup('mmproj:mmproj-F16', 'mmproj', 'mmproj-F16', [dlFile('mmproj-F16.gguf', 0.9 * GB)]),
    dlGroup('quant:IQ2_M', 'quant', 'IQ2_M', [dlFile('Qwen3.6-27B-IQ2_M-00001-of-00002.gguf', 5 * GB)], {
      complete: false, selectable: false, reason: 'Shard 2 of 2 is missing on the Hub',
    }),
  ],
  advice: { repoId: 'unsloth/Qwen3.6-27B-GGUF', repoParts: parts('unsloth/Qwen3.6-27B-GGUF'), basis: 'Linux, 64 GB RAM, no GPU', repoLine: null, groups: [] },
};
const TINTS: Record<string, GroupAdviceDTO['tint']> = { 'quant:UD-Q4_K_XL': 'green', 'quant:Q8_0': 'yellow', 'quant:BF16': 'red', 'mmproj:mmproj-F16': 'green' };
/** The advice for a look-up: names always, tints and reasons only once the shapes are read (`withSizes`). */
export const hubAdvice = (l: HubLookupDTO, withSizes: boolean): RepoAdviceDTO => ({
  ...l.advice,
  groups: l.groups.filter((g) => g.selectable).map((g) => ({
    key: g.key, tint: withSizes ? (TINTS[g.key] ?? null) : null, reason: withSizes && TINTS[g.key] !== undefined ? `${g.label} fits in RAM` : '',
    explanation: withSizes ? 'Estimated from the model shape' : '', facts: [],
    labelParts: parts(g.label), files: g.files.map((f) => ({ relpath: f.path, parts: parts(f.path) })),
  })),
});
const DETAILS: RepoDetailDTO[] = [QWEN_DETAIL, FLUX_DETAIL];

/** Advice for a fixture repo: name parts from the real splitter, no tint or reason (adds those). */
export const adviceFor = (repoId: string, detail?: RepoDetailDTO): RepoAdviceDTO => {
  const d = detail ?? DETAILS.find((x) => x.repoId === repoId);
  const groups: GroupAdviceDTO[] = (d?.groups ?? []).map((g) => ({
    key: g.key, tint: null, reason: '', explanation: '', facts: [],
    labelParts: parts(g.label), files: g.files.map((f) => ({ relpath: f.relpath, parts: parts(f.relpath) })),
  }));
  return { repoId, repoParts: parts(repoId), basis: '', repoLine: null, groups };
};

/** A minimal machine profile so the advice methods exist; Tasks 9 and 10 refine them. */
const PROFILE: MachineProfileDTO = {
  detected: { platform: 'linux', ramBytes: 64 * 2 ** 30, gpuName: null, gpuBytes: null, gpuKind: 'other', computeCap: null, drivesDisplay: false },
  settings: { gpuBytes: null, gpuKind: null, ramBytes: null, drivesDisplay: null, context: 32768, kvType: 'f16', tools: null },
  adviceError: null,
  effective: { gpuBytes: null, ramBytes: 64 * 2 ** 30, gpuKind: 'other' },
  defaultTools: ['llama.cpp'],
};

/** A fake `window.api`: every method resolves with fixtures unless overridden. */
export function makeFakeApi(over: Partial<HfcmApi> = {}): HfcmApi {
  const api: HfcmApi = {
    scan: () => Promise.resolve(ok(LIBRARY)),
    cancelScan: () => Promise.resolve(ok(null)),
    repoDetail: (id) => Promise.resolve(ok(id === FLUX_DETAIL.repoId ? FLUX_DETAIL : QWEN_DETAIL)),
    previewSelection: () => Promise.resolve(ok({ groupCount: 0, freedBytes: 0, viewLinksAffected: 0, warnings: [] })),
    planDelete: () => Promise.resolve(ok(QWEN_PAIR)),
    executePlan: (planId, _fp, mode) => Promise.resolve(ok({
      ok: true, planId, mode, purpose: 'delete', appliedOps: 1, totalOps: 1, error: null, freedBytesPlanned: 0,
      heldBytes: 0, diskFreeDelta: 0, followUp: null, notes: [],
    })),
    listHeld: () => Promise.resolve(ok({ available: true, unavailableReason: null, totalBytes: 0, items: [], autoEmptyDays: 14, autoEmptyAt: null })),
    planRestore: () => Promise.resolve(ok(QWEN_PAIR.permanent)),
    planEmpty: () => Promise.resolve(ok({ plans: [], skipped: [], freedBytes: 0, apparentBytes: 0, sharedBytes: 0 })),
    setAutoEmptyDays: () => Promise.resolve(ok(null)),
    planSync: () => Promise.resolve(ok({ planId: 'p', createdAt: 0, expiresAt: 0, views: [], warnings: [] })),
    executeSync: () => Promise.resolve(ok({ ok: true, views: [], massRemovalViews: [] })),
    settings: () => Promise.resolve(ok({
      hubRoot: LIBRARY.hubRoot, hubPresent: true, configPath: '/cfg/config.toml', configExists: true, configError: null, settingsError: null,
      views: [], holdRoot: null, holdUnavailableReason: null, journalPath: '/ud/journal', symlinks: { ok: true, detail: '' },
      autoEmptyDays: 14, platform: 'linux',
    })),
    diskInfo: () => Promise.resolve(ok({ pathDisplay: '/data/models', totalBytes: 2_000_000_000_000, freeBytes: 500_000_000_000, usedBytes: 1_500_000_000_000 })),
    startupNotices: () => Promise.resolve(ok([])),
    ackStartupNotice: () => Promise.resolve(ok(null)),
    advice: (repoId) => Promise.resolve(ok(adviceFor(repoId))),
    machineProfile: () => Promise.resolve(ok(PROFILE)),
    setAdviceSettings: (settings) => Promise.resolve(ok({ ...PROFILE, settings })),
    redetectMachine: () => Promise.resolve(ok(PROFILE)),
    // Minimal download-mode stubs (Tasks 9 and 10 refine them)
    hubLookup: () => Promise.resolve(ok({ ...HUB_LOOKUP, advice: hubAdvice(HUB_LOOKUP, false) })),
    downloadAdvice: () => Promise.resolve(ok(hubAdvice(HUB_LOOKUP, true))),
    downloadPreview: (_id, keys) => Promise.resolve(ok({
      previewId: 'p1', fingerprint: 'f'.repeat(64), fits: true, reason: null, freeBytes: 500 * GB, files: keys.length,
      requiresBytes: HUB_LOOKUP.groups.filter((g) => keys.includes(g.key)).reduce((n, g) => n + g.requiresBytes, 0),
    })),
    downloadStart: () => Promise.resolve(ok({ id: 'dl1' })),
    downloadPause: () => Promise.resolve(ok(null)),
    downloadResume: () => Promise.resolve(ok(null)),
    downloadCancel: () => Promise.resolve(ok(null)),
    downloads: () => Promise.resolve(ok({ items: [], disabledReason: null, notes: [] })),
    lookupGroups: () => Promise.resolve(ok(HUB_LOOKUP.groups)),
    recentLookups: () => Promise.resolve(ok([{ input: 'bartowski/gemma-4-31b-it-GGUF', repoId: 'bartowski/gemma-4-31b-it-GGUF', type: 'model', revision: 'main', at: 1_000 }])),
    onScanProgress: () => () => undefined,
    onDownloadProgress: () => () => undefined,
    onDownloadDone: () => () => undefined,
    ...over,
  };
  return api;
}

/** Renders `ui` with a fresh query client (no retries) and `api` injected through the ApiProvider. */
export function renderWithProviders(ui: ReactElement, api: HfcmApi = makeFakeApi()): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ApiProvider api={api}>{ui}</ApiProvider>
    </QueryClientProvider>,
  );
}
