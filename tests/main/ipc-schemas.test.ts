import { beforeEach, describe, expect, expectTypeOf, test } from 'vitest';
import { DELETION_ID_RE } from '../../src/core/hold/manifest';
import { API_METHODS, CHANNELS, DOWNLOAD_DONE_EVENT, DOWNLOAD_PROGRESS_EVENT, SCAN_PROGRESS_EVENT } from '../../src/shared/api';
import type {
  ApiErrorCode, ApiResult, DiskInfoDTO, DownloadGroupDTO, DownloadPreviewDTO, DownloadsDTO, HubLookupDTO, RecentLookupDTO, MachineProfileDTO, RepoAdviceDTO, EmptyPlanDTO, ExecResultDTO, HeldListDTO, HfcmApi, InvokeMethod, LibraryDTO,
  PlanDTO, PlanPairDTO, RepoDetailDTO, SelectionPreviewDTO, SettingsDTO, StartupNoticeDTO, SyncPlanDTO, SyncResultDTO,
} from '../../src/shared/api';
import { DEFAULT_ADVICE } from '../../src/main/app-settings';
import { ADVICE_SETTINGS, ARG_SCHEMAS, DELETION_ID_PATTERN, GROUP_KEY, parseArgs } from '../../src/shared/ipc-schemas';
import { useCanaries } from '../helpers/canary';

useCanaries();
beforeEach(() => expect.hasAssertions());

const ok = { repos: [{ repoId: 'unsloth/Qwen3.6-27B-GGUF', whole: false, groupKeys: ['quant:Q8_0', 'component:vae/'], unlockComponents: false }] };
const REAL_DELETION_ID = '2026-10-25T14-03-07-123Z-1a2b3c4d';

test('accepts a group selection and a whole-repo selection', () => {
  expect(parseArgs('planDelete', [ok]).ok).toBe(true);
  expect(parseArgs('planDelete', [{ repos: [{ repoId: 'gpt2', whole: true }] }]).ok).toBe(true);
});

test.each(['/home/user/.cache/huggingface/hub/models--a--b', '../etc', 'org/../x', 'org/..', 'C:\\x', 'org/name/extra', '.hidden/x', ''])(
  'rejects path-like repoId %j', (id) => {
    expect(parseArgs('planDelete', [{ repos: [{ repoId: id, whole: true }] }]).ok).toBe(false);
  });

test('rejects unknown fields at every level', () => {
  expect(parseArgs('planDelete', [{ ...ok, path: '/tmp/x' }]).ok).toBe(false);
  expect(parseArgs('planDelete', [{ repos: [{ ...ok.repos[0], path: '/tmp/x' }] }]).ok).toBe(false);
  expect(parseArgs('planDelete', [{ repos: [{ repoId: 'a/b', whole: true, groupKeys: ['quant:Q8_0'] }] }]).ok).toBe(false);
  expect(parseArgs('executeSync', [crypto.randomUUID(), { allowMassRemoval: true, force: true }]).ok).toBe(false);
});

test('rejects group keys with backslash or NUL, and empty key lists', () => {
  for (const k of ['quant:..\\..\\x', 'quant:a\0b', 'Q8_0', '/abs:x'])
    expect(parseArgs('previewSelection', [{ repos: [{ repoId: 'a/b', whole: false, groupKeys: [k], unlockComponents: false }] }]).ok).toBe(false);
  expect(parseArgs('previewSelection', [{ repos: [{ repoId: 'a/b', whole: false, groupKeys: [], unlockComponents: false }] }]).ok).toBe(false);
});

test('GROUP_KEY allows a 250-char root-file name but not an unbounded one', () => {
  expect(GROUP_KEY.safeParse(`root-file:${'a'.repeat(250)}`).success).toBe(true);
  expect(GROUP_KEY.safeParse(`root-file:${'a'.repeat(4090)}`).success).toBe(false);
  expect(GROUP_KEY.safeParse('q:x').success).toBe(true);
  expect(GROUP_KEY.safeParse('q').success).toBe(false);
});

test('rejects a repo id with two slashes and over-long ids', () => {
  expect(parseArgs('repoDetail', ['a/b/c']).ok).toBe(false);
  expect(parseArgs('repoDetail', [`a/${'b'.repeat(200)}`]).ok).toBe(false);
  expect(parseArgs('repoDetail', ['a/b']).ok).toBe(true);
});

test('executePlan: exact arity, uuid, 64-hex fingerprint, mode enum, bounded confirm', () => {
  const id = crypto.randomUUID(), fp = 'a'.repeat(64);
  expect(parseArgs('executePlan', [id, fp, 'permanent', 'Qwen3.6-27B-GGUF']).ok).toBe(true);
  expect(parseArgs('executePlan', [id, fp, 'hold', null]).ok).toBe(true);
  expect(parseArgs('executePlan', [id, fp, 'trash', null]).ok).toBe(false);
  expect(parseArgs('executePlan', ['x', fp, 'hold', null]).ok).toBe(false);
  expect(parseArgs('executePlan', [id, 'abc', 'hold', null]).ok).toBe(false);
  expect(parseArgs('executePlan', [id, fp, 'hold', null, '/tmp']).ok).toBe(false);
  expect(parseArgs('executePlan', [id, fp, 'hold']).ok).toBe(false);
  expect(parseArgs('executePlan', [id, fp, 'permanent', 'x'.repeat(257)]).ok).toBe(false);
  expect(parseArgs('executePlan', [id, 'A'.repeat(64), 'hold', null]).ok).toBe(false);
});

test.each(['../x', 'a/b', 'a\\b', '.', '20261025T140307Z-1a2b3c4d/..', '20261025T140307Z-1a2b3c4d', ''])('rejects deletionId %j', (d) => {
  expect(parseArgs('planRestore', [d]).ok).toBe(false);
  expect(parseArgs('planEmpty', [{ deletionId: d }]).ok).toBe(false);
});

test('DELETION_ID is the core regex, and accepts a real-format id', () => {
  expect(DELETION_ID_PATTERN.source).toBe(DELETION_ID_RE.source);
  expect(DELETION_ID_PATTERN.flags).toBe(DELETION_ID_RE.flags);
  expect(parseArgs('planRestore', [REAL_DELETION_ID]).ok).toBe(true);
  expect(parseArgs('planEmpty', [{ deletionId: REAL_DELETION_ID }]).ok).toBe(true);
});

test('planEmpty accepts {all:true} or one deletion, strictly', () => {
  expect(parseArgs('planEmpty', [{ all: true }]).ok).toBe(true);
  expect(parseArgs('planEmpty', [{ all: false }]).ok).toBe(false);
  expect(parseArgs('planEmpty', [{ all: true, deletionId: REAL_DELETION_ID }]).ok).toBe(false);
  expect(parseArgs('planEmpty', [{}]).ok).toBe(false);
});

test('setAutoEmptyDays accepts 1..3650 or null only', () => {
  expect(parseArgs('setAutoEmptyDays', [14]).ok).toBe(true);
  expect(parseArgs('setAutoEmptyDays', [null]).ok).toBe(true);
  expect(parseArgs('setAutoEmptyDays', [3650]).ok).toBe(true);
  for (const v of [0, 1.5, 4000, '14']) expect(parseArgs('setAutoEmptyDays', [v]).ok).toBe(false);
});

test('executeSync: uuid and strict options', () => {
  expect(parseArgs('executeSync', [crypto.randomUUID(), { allowMassRemoval: false }]).ok).toBe(true);
  expect(parseArgs('executeSync', ['nope', { allowMassRemoval: false }]).ok).toBe(false);
  expect(parseArgs('executeSync', [crypto.randomUUID(), { allowMassRemoval: 'yes' }]).ok).toBe(false);
});

test('ackStartupNotice takes one uuid', () => {
  expect(parseArgs('ackStartupNotice', [crypto.randomUUID()]).ok).toBe(true);
  expect(parseArgs('ackStartupNotice', ['settings-unreadable']).ok).toBe(true);
  expect(parseArgs('ackStartupNotice', ['held-unreadable']).ok).toBe(true);
  expect(parseArgs('ackStartupNotice', ['auto-empty-pending']).ok).toBe(true);
  expect(parseArgs('ackStartupNotice', ['auto-empty-skipped']).ok).toBe(true);
  expect(parseArgs('ackStartupNotice', ['auto-empty']).ok).toBe(false);
  expect(parseArgs('ackStartupNotice', ['/tmp/x']).ok).toBe(false);
  expect(parseArgs('ackStartupNotice', ['other-notice']).ok).toBe(false);
});

test('selection size bounds', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ repoId: `o/r${i}`, whole: true }));
  expect(parseArgs('planDelete', [{ repos: rows(500) }]).ok).toBe(true);
  expect(parseArgs('planDelete', [{ repos: rows(501) }]).ok).toBe(false);
  expect(parseArgs('planDelete', [{ repos: [] }]).ok).toBe(false);
});

test.each(['scan', 'cancelScan', 'listHeld', 'planSync', 'settings', 'diskInfo', 'startupNotices'] as const)(
  '%s takes no arguments', (m) => {
    expect(parseArgs(m, []).ok).toBe(true);
    expect(parseArgs(m, ['/tmp']).ok).toBe(false);
  });

test('failures carry a message and no args', () => {
  const r = parseArgs('setAutoEmptyDays', [0]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  const g = parseArgs('repoDetail', ['a/b']);
  expect(g).toEqual({ ok: true, args: ['a/b'] });
});

test('every invoke method has a schema and a channel', () => {
  expect(Object.keys(ARG_SCHEMAS).sort()).toEqual([...API_METHODS].sort());
  expect(API_METHODS).toHaveLength(30);
  expect(new Set(API_METHODS).size).toBe(30);
  expect(API_METHODS.slice(16, 20)).toEqual(['advice', 'machineProfile', 'setAdviceSettings', 'redetectMachine']);
  expect(API_METHODS.slice(-10)).toEqual([
    'hubLookup', 'downloadAdvice', 'downloadPreview', 'downloadStart', 'downloadPause', 'downloadResume', 'downloadCancel', 'downloads', 'recentLookups',
    'lookupGroups']);
  for (const m of API_METHODS) expect(CHANNELS[m]).toBe(`hfcm:${m}`);
  expect(SCAN_PROGRESS_EVENT).toBe('hfcm:scan-progress');
  expect(DOWNLOAD_PROGRESS_EVENT).toBe('hfcm:download-progress');
  expect(DOWNLOAD_DONE_EVENT).toBe('hfcm:download-done');
  for (const ev of [SCAN_PROGRESS_EVENT, DOWNLOAD_PROGRESS_EVENT, DOWNLOAD_DONE_EVENT]) expect(Object.values(CHANNELS)).not.toContain(ev);
  // The events are subscriptions, never invoke channels
  expect(API_METHODS as readonly string[]).not.toContain('onDownloadProgress');
  expect(API_METHODS as readonly string[]).not.toContain('onDownloadDone');
});

test('rejects a repoId repeated within one selection', () => {
  const dup = { repos: [{ repoId: 'a/b', whole: true }, { repoId: 'a/b', whole: true }] };
  expect(parseArgs('planDelete', [dup]).ok).toBe(false);
  const mixed = { repos: [{ repoId: 'a/b', whole: true }, { ...ok.repos[0], repoId: 'a/b' }] };
  expect(parseArgs('previewSelection', [mixed]).ok).toBe(false);
});

test('rejects a groupKey repeated within one repo, but not across repos', () => {
  const g = (repoId: string, groupKeys: string[]) => ({ repoId, whole: false, groupKeys, unlockComponents: false });
  expect(parseArgs('planDelete', [{ repos: [g('a/b', ['quant:Q8_0', 'quant:Q8_0'])] }]).ok).toBe(false);
  expect(parseArgs('planDelete', [{ repos: [g('a/b', ['quant:Q8_0']), g('c/d', ['quant:Q8_0'])] }]).ok).toBe(true);
});

test('caps the total groupKeys across a selection at 5000', () => {
  const keys = (n: number, p: string) => Array.from({ length: n }, (_, i) => `quant:${p}${i}`);
  const g = (repoId: string, groupKeys: string[]) => ({ repoId, whole: false, groupKeys, unlockComponents: false });
  const five = Array.from({ length: 5 }, (_, i) => g(`o/r${i}`, keys(1000, 'k')));
  expect(parseArgs('planDelete', [{ repos: five }]).ok).toBe(true);
  expect(parseArgs('planDelete', [{ repos: [...five, g('o/extra', ['quant:x'])] }]).ok).toBe(false);
});

describe('type contract', () => {
  test('every API method has the pinned return type', () => {
    expectTypeOf<ReturnType<HfcmApi['scan']>>().toEqualTypeOf<Promise<ApiResult<LibraryDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['cancelScan']>>().toEqualTypeOf<Promise<ApiResult<null>>>();
    expectTypeOf<ReturnType<HfcmApi['repoDetail']>>().toEqualTypeOf<Promise<ApiResult<RepoDetailDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['previewSelection']>>().toEqualTypeOf<Promise<ApiResult<SelectionPreviewDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['planDelete']>>().toEqualTypeOf<Promise<ApiResult<PlanPairDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['executePlan']>>().toEqualTypeOf<Promise<ApiResult<ExecResultDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['listHeld']>>().toEqualTypeOf<Promise<ApiResult<HeldListDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['planRestore']>>().toEqualTypeOf<Promise<ApiResult<PlanDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['planEmpty']>>().toEqualTypeOf<Promise<ApiResult<EmptyPlanDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['setAutoEmptyDays']>>().toEqualTypeOf<Promise<ApiResult<null>>>();
    expectTypeOf<ReturnType<HfcmApi['planSync']>>().toEqualTypeOf<Promise<ApiResult<SyncPlanDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['executeSync']>>().toEqualTypeOf<Promise<ApiResult<SyncResultDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['settings']>>().toEqualTypeOf<Promise<ApiResult<SettingsDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['diskInfo']>>().toEqualTypeOf<Promise<ApiResult<DiskInfoDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['startupNotices']>>().toEqualTypeOf<Promise<ApiResult<StartupNoticeDTO[]>>>();
    expectTypeOf<ReturnType<HfcmApi['ackStartupNotice']>>().toEqualTypeOf<Promise<ApiResult<null>>>();
    expectTypeOf<ReturnType<HfcmApi['advice']>>().toEqualTypeOf<Promise<ApiResult<RepoAdviceDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['machineProfile']>>().toEqualTypeOf<Promise<ApiResult<MachineProfileDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['setAdviceSettings']>>().toEqualTypeOf<Promise<ApiResult<MachineProfileDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['redetectMachine']>>().toEqualTypeOf<Promise<ApiResult<MachineProfileDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['onScanProgress']>>().toEqualTypeOf<() => void>();
    expectTypeOf<ReturnType<HfcmApi['hubLookup']>>().toEqualTypeOf<Promise<ApiResult<HubLookupDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['downloadAdvice']>>().toEqualTypeOf<Promise<ApiResult<RepoAdviceDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['downloadPreview']>>().toEqualTypeOf<Promise<ApiResult<DownloadPreviewDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['downloadStart']>>().toEqualTypeOf<Promise<ApiResult<{ id: string }>>>();
    expectTypeOf<ReturnType<HfcmApi['downloadPause']>>().toEqualTypeOf<Promise<ApiResult<null>>>();
    expectTypeOf<ReturnType<HfcmApi['downloads']>>().toEqualTypeOf<Promise<ApiResult<DownloadsDTO>>>();
    expectTypeOf<ReturnType<HfcmApi['recentLookups']>>().toEqualTypeOf<Promise<ApiResult<RecentLookupDTO[]>>>();
    expectTypeOf<ReturnType<HfcmApi['lookupGroups']>>().toEqualTypeOf<Promise<ApiResult<DownloadGroupDTO[]>>>();
    expectTypeOf<ReturnType<HfcmApi['onDownloadProgress']>>().toEqualTypeOf<() => void>();
    expectTypeOf<ReturnType<HfcmApi['onDownloadDone']>>().toEqualTypeOf<() => void>();
    expectTypeOf<'OFFLINE'>().toExtend<ApiErrorCode>();
    expectTypeOf<(typeof API_METHODS)[number]>().toEqualTypeOf<InvokeMethod>();
    expectTypeOf<'CONFIG'>().toExtend<ApiErrorCode>();
    expectTypeOf<SettingsDTO['platform']>().toExtend<string>();
    expect(API_METHODS).toHaveLength(30); // the assertions above are compile-time; typecheck is the gate
  });
});

test('a parse failure carries the issue paths (no values)', () => {
  const r = parseArgs('planDelete', [{ repos: [{ repoId: '/etc', whole: true }] }]);
  expect(r).toMatchObject({ ok: false, paths: ['0.repos.0.repoId'] });
  expect(parseArgs('scan', ['x'])).toMatchObject({ ok: false, paths: ['args'] });
});

describe('advice channels', () => {
  test('advice takes exactly one repo id: no path, no extra argument', () => {
    expect(parseArgs('advice', ['unsloth/Qwen3.6-27B-GGUF'])).toEqual({ ok: true, args: ['unsloth/Qwen3.6-27B-GGUF'] });
    for (const bad of ['/home/x/.cache/huggingface/hub/models--a--b', '../etc', 'org/../x', 'C:\\x', 'org/name/extra', '']) {
      expect(parseArgs('advice', [bad]).ok, bad).toBe(false);
    }
    expect(parseArgs('advice', []).ok).toBe(false);
    expect(parseArgs('advice', ['a/b', '/tmp/x']).ok).toBe(false);
    expect(parseArgs('advice', [{ repoId: 'a/b' }]).ok).toBe(false);
  });

  test('machineProfile and redetectMachine take no arguments', () => {
    for (const m of ['machineProfile', 'redetectMachine'] as const) {
      expect(parseArgs(m, []).ok).toBe(true);
      expect(parseArgs(m, ['/tmp/x']).ok).toBe(false);
    }
  });

  test('setAdviceSettings takes exactly one strict advice block (the same schema settings.json is parsed with)', () => {
    expect(parseArgs('setAdviceSettings', [DEFAULT_ADVICE])).toEqual({ ok: true, args: [DEFAULT_ADVICE] });
    const full = { gpuBytes: 24e9, gpuKind: 'nvidia', ramBytes: 64e9, drivesDisplay: true, context: 131072, kvType: 'q8_0', tools: ['llama.cpp', 'ollama'] };
    expect(parseArgs('setAdviceSettings', [full]).ok).toBe(true);
    expect(parseArgs('setAdviceSettings', [{ ...DEFAULT_ADVICE, path: '/tmp/x' }]).ok).toBe(false);
    expect(parseArgs('setAdviceSettings', [DEFAULT_ADVICE, '/tmp/x']).ok).toBe(false);
    expect(parseArgs('setAdviceSettings', []).ok).toBe(false);
    expect(parseArgs('setAdviceSettings', [{ ...DEFAULT_ADVICE, context: 4096 }]).ok).toBe(false);
    expect(parseArgs('setAdviceSettings', [{ ...DEFAULT_ADVICE, gpuBytes: 1 }]).ok).toBe(false);
    expect(parseArgs('setAdviceSettings', [{ ...DEFAULT_ADVICE, tools: ['/bin/sh'] }]).ok).toBe(false);
    expect(parseArgs('setAdviceSettings', [{ ...DEFAULT_ADVICE, tools: ['ollama', 'ollama'] }]).ok).toBe(false);
    const missing: Record<string, unknown> = { ...DEFAULT_ADVICE };
    delete missing['kvType'];
    expect(parseArgs('setAdviceSettings', [missing]).ok).toBe(false);
    expect(ADVICE_SETTINGS.safeParse(DEFAULT_ADVICE).success).toBe(true);
  });
});

describe('download mode schemas', () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  test('hubLookup takes one string of at most 400 characters', () => {
    expect(parseArgs('hubLookup', ['unsloth/Qwen3.6-27B-GGUF@main'])).toEqual({ ok: true, args: ['unsloth/Qwen3.6-27B-GGUF@main'] });
    expect(parseArgs('hubLookup', ['x'.repeat(400)]).ok).toBe(true);
    for (const bad of [['x'.repeat(401)], [''], [42], [], ['a/b', 'extra'], [{ path: '/etc' }]]) expect(parseArgs('hubLookup', bad).ok, JSON.stringify(bad)).toBe(false);
  });
  test('downloadPreview: a uuid and 1..500 distinct group keys; no paths, no unknown fields', () => {
    expect(parseArgs('downloadPreview', [ID, ['quant:Q4_K_M', 'mmproj:mmproj-F16']]).ok).toBe(true);
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `quant:k${i}`);
    expect(parseArgs('downloadPreview', [ID, keys(500)]).ok).toBe(true);
    for (const bad of [
      [ID, keys(501)], [ID, []], [ID, ['quant:a', 'quant:a']], ['/home/me/model.gguf', ['quant:a']], [ID, ['/etc/passwd']],
      [ID, ['quant:a\\..\\b']], [ID, ['quant:\0']], [ID, [{ key: 'quant:a' }]], [ID, ['quant:a'], { path: '/x' }], [ID, 'quant:a'],
    ]) expect(parseArgs('downloadPreview', bad).ok, JSON.stringify(bad)).toBe(false);
  });
  test('lookupGroups takes one look-up uuid', () => {
    expect(parseArgs('lookupGroups', [ID]).ok).toBe(true);
    for (const bad of [[], ['org/name'], [ID, ID], ['/tmp/x']]) expect(parseArgs('lookupGroups', bad).ok, JSON.stringify(bad)).toBe(false);
  });

  test('downloadAdvice takes one look-up uuid', () => {
    expect(parseArgs('downloadAdvice', [ID]).ok).toBe(true);
    for (const bad of [[], ['org/name'], [ID, ID], ['/tmp/x']]) expect(parseArgs('downloadAdvice', bad).ok, JSON.stringify(bad)).toBe(false);
  });
  test('downloadStart: a uuid and a 64-hex fingerprint', () => {
    expect(parseArgs('downloadStart', [ID, 'a'.repeat(64)]).ok).toBe(true);
    for (const bad of [[ID, 'A'.repeat(64)], [ID, 'a'.repeat(63)], ['nope', 'a'.repeat(64)], [ID], [ID, 'a'.repeat(64), 'x']]) {
      expect(parseArgs('downloadStart', bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  test('pause / resume / cancel take one uuid; downloads and recentLookups take nothing', () => {
    for (const m of ['downloadPause', 'downloadResume', 'downloadCancel'] as const) {
      expect(parseArgs(m, [ID]).ok).toBe(true);
      for (const bad of [[], ['../x'], [ID, ID], ['/tmp/a']]) expect(parseArgs(m, bad).ok, `${m} ${JSON.stringify(bad)}`).toBe(false);
    }
    for (const m of ['downloads', 'recentLookups'] as const) {
      expect(parseArgs(m, []).ok).toBe(true);
      expect(parseArgs(m, ['/x']).ok).toBe(false);
    }
  });
});
