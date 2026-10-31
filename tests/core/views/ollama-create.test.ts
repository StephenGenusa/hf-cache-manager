import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pyDumpsCompact, pyLoads, pySort, type PyJson } from '../../../src/core/compat/pyjson';
import type { OwnedEntry } from '../../../src/core/compat/state';
import { factsOf } from '../../../src/core/fsx';
import { ggufEntries } from '../../../src/core/views/entries';
import { fileReadAt, fileTypeName, readGgufHeader, type GgufHeader } from '../../../src/core/views/gguf-header';
import { ollamaDriver } from '../../../src/core/views/ollama';
import { aliasAction, finish, makeOllamaCreate, patchManifest, synthesise } from '../../../src/core/views/ollama-create';
import { MT, registryCollisions } from '../../../src/core/views/registry';
import { CreateIncomplete, SkipEntry, type ApplyCtx, type Desired } from '../../../src/core/views/view-types';
import type { FileFacts } from '../../../src/core/types';
import { SafeFs } from '../../../src/core/safe-fs';
import { failingFs } from '../../helpers/failing-fs';
import { useCanaries } from '../../helpers/canary';
import { treeDigest } from '../../helpers/tree-digest';
import { fakeFetch, ggufBytes, loadCase, sha256Hex, type CaseSpec, type FetchFn, type LoadedCase } from './_case';

useCanaries();
beforeEach(() => expect.hasAssertions());

const R = 'acme/Tiny-GGUF';
const GG = { arch: 'llama', fileType: 15, tensors: [[1000, 1000], [500]] };
const q4 = sha256Hex(ggufBytes(GG));
const pf = sha256Hex('pf');
const spec: CaseSpec = { repos: [{ id: R, main: 'c2', snapshots: [{ commit: 'c2', mtime: 2, files: [
  { path: 'Tiny-Q4_K_M.gguf', gguf: GG }, { path: 'mmproj-F16.gguf', text: 'pf' }] }] }], views: ['ollama'] };
const KEY = `${R}:Tiny-Q4_K_M.gguf`;
const MAN = `manifests/hf.co/${R}/Q4_K_M`;
const alias = (n: string): string => `manifests/registry.ollama.ai/library/${n}/latest`;
const blob = (h: string): string => `blobs/sha256-${h}`;
const hubBlob = (lc: LoadedCase, h: string): string => path.join(lc.model.hubRoot, 'models--acme--Tiny-GGUF', 'blobs', h);
const dig = (h: string): string => `sha256:${h}`;

// A registry manifest with a template and a params layer plus a config blob.
const TPL = '{{ .Prompt }}';
const PARAMS = '{"stop":["x"]}';
const CFG_IN = '{"model_format":"gguf","extra":1}';
const regManifest = (extraLayers: Array<Record<string, unknown>> = []): string => JSON.stringify({
  schemaVersion: 2, mediaType: MT.manifest, config: { digest: dig(sha256Hex(CFG_IN)), mediaType: MT.config, size: CFG_IN.length },
  layers: [{ mediaType: MT.model, digest: dig('9'.repeat(64)), size: 1 }, { mediaType: MT.template, digest: dig(sha256Hex(TPL)), size: TPL.length },
    { mediaType: MT.params, digest: dig(sha256Hex(PARAMS)), size: PARAMS.length }, ...extraLayers],
});
const blobs: Record<string, string> = { [sha256Hex(TPL)]: TPL, [sha256Hex(PARAMS)]: PARAMS, [sha256Hex(CFG_IN)]: CFG_IN };
/** Answers /manifests/ with `manifestBody` (404 when null) and /blobs/<digest> from `blobs`; records the URLs. */
function router(manifestBody: string | null, table: Record<string, string> = blobs): FetchFn & { urls: string[] } {
  const urls: string[] = [];
  const f: FetchFn = async (url) => {
    urls.push(url);
    const body = url.includes('/manifests/') ? manifestBody : (table[url.slice(url.lastIndexOf(':') + 1)] ?? null);
    const bytes = new TextEncoder().encode(body ?? '');
    return { status: body === null ? 404 : 200, arrayBuffer: async () => bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer };
  };
  return Object.assign(f, { urls });
}

interface Setup {
  lc: LoadedCase; root: string; d: Desired; planned: Map<string, FileFacts | null>; warnings: string[];
  create: (d: Desired, ctx: ApplyCtx, prev?: OwnedEntry) => Promise<string[]>; ctx: () => ApplyCtx; run: () => Promise<string[]>;
}
async function setup(opts: { fetch?: FetchFn; offline?: boolean; aliases?: Record<string, string>; collisions?: Map<string, string>; s?: CaseSpec } = {}): Promise<Setup> {
  const lc = await loadCase(opts.s ?? spec);
  const root = realpathSync(lc.c.ollama!);
  const entries = ggufEntries(lc.model);
  const create = makeOllamaCreate({
    registry: { root, fs: lc.fs, fetch: opts.fetch ?? fakeFetch({ status: 404 }), offline: opts.offline ?? false, token: null },
    hubRoot: lc.model.hubRoot,
    readGguf: async (abs) => {
      const r = fileReadAt(abs);
      try {
        return await readGgufHeader(r.readAt);
      } finally {
        await r.close();
      }
    },
    collisions: opts.collisions ?? registryCollisions(entries),
  });
  const aliases = opts.aliases ?? { tiny: KEY };
  const drv = ollamaDriver(root, lc.model.hubRoot, aliases, create, lc.fs);
  const d = drv.desired(entries, []).find((x) => x.key === KEY)!;
  const planned = new Map<string, FileFacts | null>();
  const warnings: string[] = [];
  const ctx = (): ApplyCtx => ({ safeFs: lc.safeFs, fs: lc.fs, expect: (rel) => planned.get(rel), warnings });
  return { lc, root, d, planned, warnings, create, ctx, run: () => create(d, ctx()) };
}
const put = (root: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const read = (root: string, rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const seedMissing = (root: string): void => put(root, `.hfhub-registry/${R}/Tiny-Q4_K_M.gguf.json`, '{"missing": true}');

const header = (kv: Array<[string, unknown]>, paramCount = 0): GgufHeader => ({ version: 3, nTensors: 0n, kv: new Map(kv), paramCount });
const m = (text: string): Map<string, PyJson> => pyLoads(text) as Map<string, PyJson>;

describe('synthesise + finish (REF 5.5 steps 3-4)', () => {
  it('produce the exact CLI bytes', () => {
    const h = header([['general.architecture', 'llama'], ['general.file_type', 15]], 1_000_500);
    const { manifest, config } = synthesise(h, { sha256: q4, size: 10 }, null);
    const out = finish(manifest, config);
    const cfg = `{"model_format":"gguf","model_family":"llama","model_families":["llama"],"model_type":"1.0M","file_type":"${fileTypeName(15)}","architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":["sha256:${q4}"]}}`;
    expect(Buffer.from(out.cfgBytes).toString()).toBe(cfg);
    expect(out.cfgDigest).toBe(`sha256:${sha256Hex(cfg)}`);
    expect(out.manifestText).toBe(`{"schemaVersion":2,"mediaType":"${MT.manifest}","layers":[{"digest":"sha256:${q4}","mediaType":"${MT.model}","size":10}],"config":{"digest":"sha256:${sha256Hex(cfg)}","mediaType":"${MT.config}","size":${cfg.length}}}`);
  });

  it('writes non-ASCII as \\u escapes with the digest of those bytes (checked against Python json.dumps)', () => {
    const a = 'a'.repeat(64);
    const { manifest, config } = synthesise(header([['general.architecture', 'é-x']]), { sha256: a, size: 1 }, null);
    const out = finish(manifest, config);
    const cfg = '{"model_format":"gguf","model_family":"\\u00e9-x","model_families":["\\u00e9-x"],"model_type":"0.0M","file_type":"unknown","architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":["sha256:' + a + '"]}}';
    expect(Buffer.from(out.cfgBytes).toString()).toBe(cfg);
    expect(cfg.length).toBe(271);
    expect(out.cfgDigest).toBe('sha256:2b5e08f5f69d2959bb8405afeebd4d9378747c0130edcc3c911074d9f03e4619');
  });

  it('adds the projector layer second; falls back to "unknown" for missing, odd and non-integer values', () => {
    const { manifest } = synthesise(header([]), { sha256: 'a', size: 1 }, { sha256: 'b', size: 2 });
    expect(pyDumpsCompact(manifest.get('layers')!)).toBe(`[{"digest":"sha256:a","mediaType":"${MT.model}","size":1},{"digest":"sha256:b","mediaType":"${MT.projector}","size":2}]`);
    const cfgOf = (kv: Array<[string, unknown]>): Map<string, PyJson> => synthesise(header(kv), { sha256: 'a', size: 1 }, null).config;
    expect(cfgOf([]).get('model_family')).toBe('unknown');
    expect(cfgOf([['general.architecture', 5], ['general.file_type', 'x']]).get('model_family')).toBe('5');
    expect(cfgOf([['general.architecture', 5n]]).get('model_family')).toBe('5');
    expect(cfgOf([['general.architecture', true]]).get('model_family')).toBe('True');
    expect(cfgOf([['general.architecture', false]]).get('model_family')).toBe('False');
    expect(cfgOf([['general.architecture', ['x']]]).get('model_family')).toBe('unknown');
    expect(cfgOf([['general.file_type', 'x']]).get('file_type')).toBe('unknown');
    expect(cfgOf([['general.file_type', 99]]).get('file_type')).toBe('unknown');
    expect(cfgOf([['general.file_type', 7n]]).get('file_type')).toBe('Q8_0');
    expect(cfgOf([['general.file_type', true]]).get('file_type')).toBe('F16');
  });
});

describe('patchManifest', () => {
  const REG = `{"schemaVersion":2,"mediaType":"${MT.manifest}","config":{"digest":"sha256:old"},"layers":[{"mediaType":"${MT.model}","digest":"sha256:hfmodel","size":1},{"mediaType":"${MT.template}","digest":"sha256:t","size":3}]}`;

  it('replaces the model, inserts the projector at index 1, keeps other layers and the config position', () => {
    const reg = m(REG);
    const p = patchManifest(reg, { sha256: 'q4', size: 10 }, { sha256: 'pf', size: 4 });
    expect(pyDumpsCompact(p)).toBe(`{"schemaVersion":2,"mediaType":"${MT.manifest}","config":{"digest":"sha256:old"},"layers":[{"digest":"sha256:q4","mediaType":"${MT.model}","size":10},{"digest":"sha256:pf","mediaType":"${MT.projector}","size":4},{"mediaType":"${MT.template}","digest":"sha256:t","size":3}]}`);
    expect(pyDumpsCompact(reg)).toBe(REG);   // the input is not modified
  });

  it('drops the registry projector when we have none, and replaces it in place when we have one', () => {
    const withProj = REG.replace('"layers":[', `"layers":[{"mediaType":"${MT.projector}","digest":"sha256:rp","size":9},`);
    const dropped = patchManifest(m(withProj), { sha256: 'q4', size: 10 }, null);
    expect(pyDumpsCompact(dropped.get('layers')!)).toBe(`[{"digest":"sha256:q4","mediaType":"${MT.model}","size":10},{"mediaType":"${MT.template}","digest":"sha256:t","size":3}]`);
    const swapped = patchManifest(m(withProj), { sha256: 'q4', size: 10 }, { sha256: 'pf', size: 4 });
    expect(pyDumpsCompact(swapped.get('layers')!)).toBe(`[{"digest":"sha256:pf","mediaType":"${MT.projector}","size":4},{"digest":"sha256:q4","mediaType":"${MT.model}","size":10},{"mediaType":"${MT.template}","digest":"sha256:t","size":3}]`);
  });

  it('refuses a manifest without a layers array or with a malformed layer', () => {
    expect(() => patchManifest(m('{"layers":5}'), { sha256: 'a', size: 1 }, null)).toThrow(SkipEntry);
    expect(() => patchManifest(m('{}'), { sha256: 'a', size: 1 }, null)).toThrow(SkipEntry);
    expect(() => patchManifest(m('{"layers":[1]}'), { sha256: 'a', size: 1 }, null)).toThrow(SkipEntry);
    expect(() => patchManifest(m('{"layers":[{"digest":"x"}]}'), { sha256: 'a', size: 1 }, null)).toThrow(SkipEntry);
  });
});

describe('finish', () => {
  it('overwrites rootfs keys in place on an existing rootfs', () => {
    const { manifestText, cfgBytes } = finish(m('{"layers":[{"digest":"sha256:a"}]}'), m('{"rootfs":{"diff_ids":[],"x":1,"type":"z"},"os":"linux"}'));
    expect(Buffer.from(cfgBytes).toString()).toBe('{"rootfs":{"diff_ids":["sha256:a"],"x":1,"type":"layers"},"os":"linux"}');
    expect(manifestText).toBe(`{"layers":[{"digest":"sha256:a"}],"config":{"digest":"sha256:${sha256Hex(cfgBytes)}","mediaType":"${MT.config}","size":${cfgBytes.length}}}`);
  });

  it('adds rootfs last when absent and keeps an existing manifest config key in place; does not modify its inputs', () => {
    const manifest = m('{"config":{"digest":"sha256:old"},"layers":[{"digest":"sha256:a"},{"digest":"sha256:b"}]}');
    const config = m('{"os":"linux"}');
    const out = finish(manifest, config);
    expect(Buffer.from(out.cfgBytes).toString()).toBe('{"os":"linux","rootfs":{"type":"layers","diff_ids":["sha256:a","sha256:b"]}}');
    expect(out.manifestText.startsWith(`{"config":{"digest":"${out.cfgDigest}","mediaType":"${MT.config}"`)).toBe(true);
    expect(pyDumpsCompact(config)).toBe('{"os":"linux"}');
    expect(pyDumpsCompact(manifest)).toBe('{"config":{"digest":"sha256:old"},"layers":[{"digest":"sha256:a"},{"digest":"sha256:b"}]}');
  });

  it('refuses a rootfs that is not an object and a layer without a digest', () => {
    expect(() => finish(m('{"layers":[]}'), m('{"rootfs":[]}'))).toThrow(SkipEntry);
    expect(() => finish(m('{"layers":[]}'), m('{"rootfs":null}'))).toThrow(SkipEntry);
    expect(() => finish(m('{"layers":[{"mediaType":"m"}]}'), m('{}'))).toThrow(SkipEntry);
  });
});

describe('aliasAction', () => {
  const ours = dig(q4);
  const man = (layers: string): string => `{"layers":${layers}}`;
  it.each([
    ['identical text', 'T', 'T', 'skip'],
    ['our model digest, other text', man(`[{"mediaType":"${MT.model}","digest":"${ours}"}]`), 'T', 'write'],
    ['another model', man(`[{"mediaType":"${MT.model}","digest":"sha256:other"}]`), 'T', 'refuse'],
    ['unparseable', 'nope', 'T', 'refuse'],
    ['not an object', '[]', 'T', 'refuse'],
    ['no layers array', '{"layers":3}', 'T', 'refuse'],
    ['no model layer', man(`[{"mediaType":"${MT.template}","digest":"${ours}"}]`), 'T', 'refuse'],
    ['layer not an object', man('[3]'), 'T', 'refuse'],
    ['model layer without digest', man(`[{"mediaType":"${MT.model}"}]`), 'T', 'refuse'],
  ])('%s', (_n, existing, text, want) => { expect(aliasAction(existing, text, ours)).toBe(want); });

  it('the previous model digest of an update is ours to overwrite too; nothing else is', () => {
    const prev = dig(sha256Hex('old'));
    const naming = (d: string): string => man(`[{"mediaType":"${MT.model}","digest":"${d}"}]`);
    expect(aliasAction(naming(prev), 'T', ours, prev)).toBe('write');
    expect(aliasAction(naming(prev), 'T', ours)).toBe('refuse');
    expect(aliasAction(naming(prev), 'T', ours, null)).toBe('refuse');
    expect(aliasAction(naming('sha256:other'), 'T', ours, prev)).toBe('refuse');
    expect(aliasAction(naming(ours), 'T', ours, prev)).toBe('write');
  });
});

describe('create (synthesised: cached {"missing": true})', () => {
  it('writes links, config blob and hf.co manifest; returns the owned paths', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    const before = await treeDigest(s.root);
    const owned = await s.run();
    const { manifest, config } = synthesise(header([['general.architecture', 'llama'], ['general.file_type', 15]], 1_000_500),
      { sha256: q4, size: s.d.ollama!.entry.size }, { sha256: pf, size: s.d.ollama!.mmproj!.size });
    const { manifestText, cfgBytes, cfgDigest } = finish(manifest, config);
    const cfgHex = cfgDigest.slice(7);
    expect(owned).toEqual(pySort([blob(q4), blob(pf), blob(cfgHex), MAN]));
    expect(readlinkSync(path.join(s.root, blob(q4)))).toBe(hubBlob(s.lc, q4));
    expect(readlinkSync(path.join(s.root, blob(pf)))).toBe(hubBlob(s.lc, pf));
    expect(read(s.root, MAN)).toBe(manifestText);
    expect(Buffer.from(readFileSync(path.join(s.root, blob(cfgHex)))).equals(Buffer.from(cfgBytes))).toBe(true);
    expect(s.warnings).toEqual([`${KEY}: not on the Hub registry; model relies on its embedded chat template`]);
    const after = await treeDigest(s.root);
    expect(Object.keys(after).filter((k) => !(k in before)).sort()).toEqual(
      ['blobs', blob(q4), blob(pf), blob(cfgHex), 'manifests', 'manifests/hf.co', `manifests/hf.co/${R}`, `manifests/hf.co/acme`, MAN].sort());
  });

  it('is idempotent: a second create changes nothing and returns the same paths', async () => {
    const s = await setup();
    seedMissing(s.root);
    const first = await s.run();
    const tree = await treeDigest(s.root);
    expect(await s.run()).toEqual(first);
    const again = await treeDigest(s.root);
    expect(Object.keys(again)).toEqual(Object.keys(tree));
    // only the hf.co manifest is rewritten (new inode), with the same content
    const changed = Object.keys(tree).filter((k) => tree[k] !== again[k]);
    expect(changed).toEqual([MAN]);
    expect(again[MAN]!.split(':')[3]).toBe(tree[MAN]!.split(':')[3]);
  });

  it('a synthesised create without a projector writes one model layer', async () => {
    const s = await setup({ aliases: {}, s: { ...spec, repos: [{ ...spec.repos[0]!, snapshots: [{ ...spec.repos[0]!.snapshots[0]!, files: [spec.repos[0]!.snapshots[0]!.files[0]!] }] }] } });
    seedMissing(s.root);
    const owned = await s.run();
    expect(owned).toHaveLength(3);
    expect(JSON.parse(read(s.root, MAN)).layers).toHaveLength(1);
  });

  it('an unreadable GGUF is a SkipEntry and nothing is written', async () => {
    const s = await setup({ s: { ...spec, repos: [{ ...spec.repos[0]!, snapshots: [{ ...spec.repos[0]!.snapshots[0]!, files: [{ path: 'Tiny-Q4_K_M.gguf', text: 'not gguf' }] }] }] } });
    seedMissing(s.root);
    const before = await treeDigest(s.root);
    await expect(s.run()).rejects.toThrow(/cannot read the GGUF header \(not a GGUF file\)/);
    expect(await treeDigest(s.root)).toEqual(before);
  });

  it('refuses an entry that is not an Ollama entry', async () => {
    const s = await setup();
    await expect(s.create({ ...s.d, ollama: undefined }, s.ctx())).rejects.toThrow(/not an Ollama entry/);
  });
});

describe('create (registry)', () => {
  it('fetches small layers as regular files, patches the manifest, rewrites rootfs; never overwrites an existing blob', async () => {
    const f = router(regManifest());
    const s = await setup({ fetch: f, aliases: {} });
    put(s.root, blob(sha256Hex(PARAMS)), 'user copy');   // already on disk: kept as is
    const owned = await s.run();
    const o = s.d.ollama!;
    const cfg = `{"model_format":"gguf","extra":1,"rootfs":{"type":"layers","diff_ids":["${dig(q4)}","${dig(pf)}","${dig(sha256Hex(TPL))}","${dig(sha256Hex(PARAMS))}"]}}`;
    // model replaced in place (first), projector inserted at index 1, then the registry's small layers
    const manifest = `{"schemaVersion":2,"mediaType":"${MT.manifest}","config":{"digest":"sha256:${sha256Hex(cfg)}","mediaType":"${MT.config}","size":${cfg.length}},"layers":[` +
      `{"digest":"${dig(q4)}","mediaType":"${MT.model}","size":${o.entry.size}},{"digest":"${dig(pf)}","mediaType":"${MT.projector}","size":${o.mmproj!.size}},` +
      `{"mediaType":"${MT.template}","digest":"${dig(sha256Hex(TPL))}","size":${TPL.length}},{"mediaType":"${MT.params}","digest":"${dig(sha256Hex(PARAMS))}","size":${PARAMS.length}}]}`;
    expect(read(s.root, MAN)).toBe(manifest);
    expect(read(s.root, blob(sha256Hex(cfg)))).toBe(cfg);
    expect(read(s.root, blob(sha256Hex(TPL)))).toBe(TPL);
    expect(read(s.root, blob(sha256Hex(PARAMS)))).toBe('user copy');
    expect(owned).toEqual(pySort([blob(q4), blob(pf), blob(sha256Hex(cfg)), blob(sha256Hex(TPL)), blob(sha256Hex(PARAMS)), MAN]));
    expect(s.warnings).toEqual([]);
    // the registry cache holds Python-default JSON, and the config blob is cached verbatim
    const py = `{"schemaVersion": 2, "mediaType": "${MT.manifest}", "config": {"digest": "${dig(sha256Hex(CFG_IN))}", "mediaType": "${MT.config}", "size": ${CFG_IN.length}}, "layers": [` +
      `{"mediaType": "${MT.model}", "digest": "${dig('9'.repeat(64))}", "size": 1}, {"mediaType": "${MT.template}", "digest": "${dig(sha256Hex(TPL))}", "size": ${TPL.length}}, ` +
      `{"mediaType": "${MT.params}", "digest": "${dig(sha256Hex(PARAMS))}", "size": ${PARAMS.length}}]}`;
    expect(read(s.root, `.hfhub-registry/${R}/Tiny-Q4_K_M.gguf.json`)).toBe(py);
    expect(read(s.root, `.hfhub-registry/${R}/Tiny-Q4_K_M.gguf.config.json`)).toBe(CFG_IN);
    expect(f.urls.filter((u) => u.includes(sha256Hex(PARAMS)))).toEqual([]);
  });

  it('a cached empty config counts as {}', async () => {
    const s = await setup({ offline: true, aliases: {} });
    put(s.root, `.hfhub-registry/${R}/Tiny-Q4_K_M.gguf.json`, regManifest());
    put(s.root, `.hfhub-registry/${R}/Tiny-Q4_K_M.gguf.config.json`, '');
    put(s.root, blob(sha256Hex(TPL)), TPL);
    put(s.root, blob(sha256Hex(PARAMS)), PARAMS);
    await s.run();
    const cfg = `{"rootfs":{"type":"layers","diff_ids":["${dig(q4)}","${dig(pf)}","${dig(sha256Hex(TPL))}","${dig(sha256Hex(PARAMS))}"]}}`;
    expect(read(s.root, blob(sha256Hex(cfg)))).toBe(cfg);
  });

  it('does not fetch a layer already on disk, nor the same layer twice', async () => {
    const dup = { mediaType: MT.license, digest: dig(sha256Hex(TPL)), size: TPL.length };
    const f = router(regManifest([dup]));
    const s = await setup({ fetch: f, aliases: {} });
    put(s.root, blob(sha256Hex(PARAMS)), PARAMS);
    await s.run();
    expect(f.urls.filter((u) => u.endsWith(dig(sha256Hex(TPL))))).toHaveLength(1);
    expect(f.urls.some((u) => u.endsWith(dig(sha256Hex(PARAMS))))).toBe(false);
  });

  it('is all-or-nothing: a missing small layer while offline is a SkipEntry and writes nothing', async () => {
    const s = await setup({ offline: true });
    put(s.root, `.hfhub-registry/${R}/Tiny-Q4_K_M.gguf.json`, regManifest());
    put(s.root, `.hfhub-registry/${R}/Tiny-Q4_K_M.gguf.config.json`, CFG_IN);
    put(s.root, blob(sha256Hex(TPL)), TPL);   // params is missing
    const before = await treeDigest(s.root);
    await expect(s.run()).rejects.toThrow(SkipEntry);
    expect(await treeDigest(s.root)).toEqual(before);
  });

  it('a layer whose bytes fail their sha256, or a network failure, skips before any view write', async () => {
    const bad = router(regManifest(), { ...blobs, [sha256Hex(PARAMS)]: 'tampered' });
    const s = await setup({ fetch: bad });
    const before = await treeDigest(s.root);
    await expect(s.run()).rejects.toThrow(/failed its sha256 check/);
    const after = await treeDigest(s.root);
    const added = Object.keys(after).filter((k) => !(k in before));
    expect(added.filter((k) => !k.startsWith('.hfhub-registry'))).toEqual([]);
    const down = await setup({ fetch: fakeFetch(new Error('boom')) });
    await expect(down.run()).rejects.toThrow(/registry unreachable/);
  });

  it.each([
    ['a non-sha256 small layer digest', JSON.stringify({ config: { digest: dig(sha256Hex(CFG_IN)) }, layers: [{ mediaType: MT.template, digest: 'sha256:../../x' }] }), /not sha256/],
    ['no config digest', JSON.stringify({ layers: [] }), /no config digest/],
    ['a config that is not JSON', JSON.stringify({ config: { digest: dig(sha256Hex('nope')) }, layers: [] }), /not valid JSON/],
    ['a config that is not an object', JSON.stringify({ config: { digest: dig(sha256Hex('[]')) }, layers: [] }), /not an object/],
    ['no layers', JSON.stringify({ config: { digest: dig(sha256Hex(CFG_IN)) } }), /no layers array/],
  ])('skips for %s', async (_n, body, msg) => {
    const s = await setup({ fetch: router(body, { ...blobs, [sha256Hex('nope')]: 'nope', [sha256Hex('[]')]: '[]' }) });
    const before = await treeDigest(s.root);
    await expect(s.run()).rejects.toThrow(msg);
    const after = await treeDigest(s.root);
    expect(Object.keys(after).filter((k) => !(k in before) && !k.startsWith('.hfhub-registry') && k !== '.hfhub-registry')).toEqual([]);
  });

  it('a registry that is down for the config blob is a skip too', async () => {
    const s = await setup({ fetch: router(regManifest(), {}) });
    await expect(s.run()).rejects.toThrow(/not found/);
  });
});

describe('create refusals', () => {
  it('refuses a colliding registry-cache basename', async () => {
    const s = await setup({ collisions: new Map([[KEY, `${KEY}: registry cache name Tiny-Q4_K_M.gguf collides with x/Tiny-Q4_K_M.gguf; skipped`]]) });
    const before = await treeDigest(s.root);
    await expect(s.run()).rejects.toThrow(/registry cache key collision/);
    expect(await treeDigest(s.root)).toEqual(before);
  });

  it('refuses a real collision found by registryCollisions', async () => {
    const two: CaseSpec = { ...spec, repos: [{ ...spec.repos[0]!, snapshots: [{ ...spec.repos[0]!.snapshots[0]!, files: [
      { path: 'Tiny-Q4_K_M.gguf', gguf: GG }, { path: 'sub/tiny-q4_k_m.gguf', text: 'other' }] }] }] };
    const s = await setup({ s: two });
    await expect(s.run()).rejects.toThrow(/registry cache key collision/);
  });

  it('a symlinked folder in the way of the manifest is a SkipEntry before any write', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    mkdirSync(path.join(s.root, 'manifests', 'hf.co', 'acme'), { recursive: true });
    mkdirSync(path.join(s.root, 'elsewhere'));
    symlinkSync(path.join(s.root, 'elsewhere'), path.join(s.root, 'manifests', 'hf.co', 'acme', 'Tiny-GGUF'));
    const before = await treeDigest(s.root);
    await expect(s.run()).rejects.toThrow(SkipEntry);
    const after = await treeDigest(s.root);
    // at most empty folders were made by the pre-write mkdirp; no file or link was written
    expect(Object.fromEntries(Object.entries(after).filter(([, v]) => v !== 'dir'))).toEqual(Object.fromEntries(Object.entries(before).filter(([, v]) => v !== 'dir')));
  });

  it('a symlink or folder where a manifest must go is a SkipEntry', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    mkdirSync(path.join(s.root, MAN), { recursive: true });
    await expect(s.run()).rejects.toThrow(/in the way/);
  });

  it('a manifest changed since the plan is STALE: CreateIncomplete (blobs already written), the manifest is not overwritten', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    put(s.root, MAN, 'v1');
    s.planned.set(MAN, await factsOf(s.lc.fs, path.join(s.root, MAN)));
    writeFileSync(path.join(s.root, MAN), 'v2 changed by Ollama');
    const err = await s.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreateIncomplete);
    expect((err as CreateIncomplete).written).toContain(blob(q4));
    expect((err as CreateIncomplete).written).not.toContain(MAN);
    expect(read(s.root, MAN)).toBe('v2 changed by Ollama');
  });

  it('a plan that said "absent" for the manifest: one that appeared before execute is not overwritten', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    s.planned.set(MAN, null);
    put(s.root, MAN, 'written by ollama');
    const err = await s.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreateIncomplete);
    expect(read(s.root, MAN)).toBe('written by ollama');
  });

  it('a refused first write names the path in its SkipEntry', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    put(s.root, MAN, 'v1');
    const ctx = { ...s.ctx(), expect: (rel: string): FileFacts | null | undefined => (rel === MAN ? null : undefined) };
    // every blob exists already, so the manifest is the first write and the plan says it must be absent
    for (const h of [q4, pf]) put(s.root, blob(h), 'x');
    const { manifest, config } = synthesise(header([['general.architecture', 'llama'], ['general.file_type', 15]], 1_000_500),
      { sha256: q4, size: s.d.ollama!.entry.size }, { sha256: pf, size: s.d.ollama!.mmproj!.size });
    put(s.root, blob(finish(manifest, config).cfgDigest.slice(7)), 'x');
    const err = await s.create(s.d, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkipEntry);
    expect((err as SkipEntry).message.startsWith(`${MAN}: `)).toBe(true);
  });

  it('a manifest that appears between the check and the write (no plan entry) is not overwritten', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    const ctx = { ...s.ctx(), expect: (rel: string): undefined => { if (rel === MAN) put(s.root, MAN, 'appeared'); return undefined; } };
    const err = await s.create(s.d, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreateIncomplete);
    expect(read(s.root, MAN)).toBe('appeared');
    expect((err as CreateIncomplete).written).not.toContain(MAN);
  });

  it('an alias that appears between the check and the write is not overwritten; one that changed is not either', async () => {
    const s = await setup({ aliases: { a: KEY, b: KEY } });
    seedMissing(s.root);
    put(s.root, alias('b'), JSON.stringify({ layers: [{ mediaType: MT.model, digest: dig(q4) }] }));   // ours, stale: will be rewritten
    const ctx = { ...s.ctx(), expect: (rel: string): undefined => {
      if (rel === alias('a')) put(s.root, alias('a'), 'someone else');
      if (rel === alias('b')) writeFileSync(path.join(s.root, alias('b')), 'changed under us');
      return undefined;
    } };
    const err = await s.create(s.d, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreateIncomplete);
    expect(read(s.root, alias('a'))).toBe('someone else');
    const err2 = await s.create(s.d, { ...s.ctx(), expect: (rel: string): undefined => { if (rel === alias('b')) writeFileSync(path.join(s.root, alias('b')), 'changed again'); return undefined; } }).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(CreateIncomplete);
    expect(read(s.root, alias('b'))).toBe('changed again');
  });

  it('overwrites an existing manifest that matches the plan, and one the plan did not see (CLI behaviour)', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    put(s.root, MAN, 'old');
    s.planned.set(MAN, await factsOf(s.lc.fs, path.join(s.root, MAN)));
    await s.run();
    expect(read(s.root, MAN)).toContain('"schemaVersion":2');
    writeFileSync(path.join(s.root, MAN), 'old again');
    s.planned.clear();
    await s.run();
    expect(read(s.root, MAN)).toContain('"schemaVersion":2');
  });
});

describe('create: aliases', () => {
  const ABCD = { a: KEY, b: KEY, c: KEY, d: KEY, e: KEY };
  it('alias of another model is kept but a stale alias of ours is refreshed', async () => {
    const s = await setup({ aliases: ABCD });
    seedMissing(s.root);
    // first run: every alias is absent, so all five are written (absent -> written), and it gives us "our" manifest text
    const first = await s.run();
    const ours = read(s.root, MAN);
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      expect(read(s.root, alias(n))).toBe(ours);
      expect(first).toContain(alias(n));
    }
    put(s.root, alias('b'), ours);                                                                   // identical text -> skipped + owned
    // (a..e now exist from the first run; b-e are replaced below to set up each case, a keeps the text it was given)
    put(s.root, alias('c'), JSON.stringify({ layers: [{ mediaType: MT.model, digest: dig(q4) }, { mediaType: MT.template, digest: 'sha256:t' }] }));  // ours, stale -> rewritten
    const other = JSON.stringify({ layers: [{ mediaType: MT.model, digest: 'sha256:' + 'f'.repeat(64) }] });
    put(s.root, alias('d'), other);                                                                  // another model -> untouched
    put(s.root, alias('e'), '{not json');                                                            // unparseable -> untouched
    const bTree = await factsOf(s.lc.fs, path.join(s.root, alias('b')));
    s.warnings.length = 0;
    const owned = await s.run();
    expect(read(s.root, alias('a'))).toBe(ours);                                                      // a: identical text from the first run -> skipped
    expect((await factsOf(s.lc.fs, path.join(s.root, alias('b'))))?.mtimeMs).toBe(bTree?.mtimeMs);
    expect(read(s.root, alias('c'))).toBe(ours);
    expect(read(s.root, alias('d'))).toBe(other);
    expect(read(s.root, alias('e'))).toBe('{not json');
    expect(owned).toContain(alias('a'));
    expect(owned).toContain(alias('b'));
    expect(owned).toContain(alias('c'));
    expect(owned).not.toContain(alias('d'));
    expect(owned).not.toContain(alias('e'));
    expect(owned).toEqual(pySort(new Set(owned)));
    expect(s.warnings.filter((w) => w.includes('belongs to another model'))).toEqual([
      `${KEY}: alias ${alias('d')} exists and belongs to another model; not overwritten`,
      `${KEY}: alias ${alias('e')} exists and belongs to another model; not overwritten`]);
  });

  it('an alias that is a symlink or folder is refused, not written through', async () => {
    const s = await setup({ aliases: { a: KEY, b: KEY } });
    seedMissing(s.root);
    mkdirSync(path.join(s.root, alias('a')), { recursive: true });
    put(s.root, 'target.txt', 'x');
    mkdirSync(path.dirname(path.join(s.root, alias('b'))), { recursive: true });
    symlinkSync(path.join(s.root, 'target.txt'), path.join(s.root, alias('b')));
    const owned = await s.run();
    expect(owned.some((p) => p.includes('library'))).toBe(false);
    expect(read(s.root, 'target.txt')).toBe('x');
    expect(s.warnings.filter((w) => w.includes('belongs to another model'))).toHaveLength(2);
  });
});

describe('create: hub links', () => {
  it('unlinks a wrong hub link only with matching plan facts (update case)', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    const old = hubBlob(s.lc, 'f'.repeat(64));   // a superseded cache file of ours: into the hub, dangling
    mkdirSync(path.join(s.root, 'blobs'), { recursive: true });
    symlinkSync(old, path.join(s.root, blob(q4)));
    const before = await treeDigest(s.root);
    await expect(s.run()).rejects.toThrow(/changed since preview/);      // no expect from the plan
    expect(await treeDigest(s.root)).toEqual(before);
    s.planned.set(blob(q4), await factsOf(s.lc.fs, path.join(s.root, blob(q4))));
    await s.run();
    expect(readlinkSync(path.join(s.root, blob(q4)))).toBe(hubBlob(s.lc, q4));
  });

  it('a stale expect on a wrong link skips with nothing written', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    mkdirSync(path.join(s.root, 'blobs'), { recursive: true });
    symlinkSync(hubBlob(s.lc, 'f'.repeat(64)), path.join(s.root, blob(q4)));
    s.planned.set(blob(q4), { ...(await factsOf(s.lc.fs, path.join(s.root, blob(q4))))!, ino: 1 });
    const before = await treeDigest(s.root);
    await expect(s.run()).rejects.toThrow(SkipEntry);
    expect(await treeDigest(s.root)).toEqual(before);
  });

  it("leaves the user's own link and a regular file alone, still owned, with a warning for the link", async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    mkdirSync(path.join(s.root, 'blobs'), { recursive: true });
    symlinkSync('/somewhere/else/model.gguf', path.join(s.root, blob(q4)));
    put(s.root, blob(pf), 'ollama downloaded this');
    const owned = await s.run();
    expect(readlinkSync(path.join(s.root, blob(q4)))).toBe('/somewhere/else/model.gguf');
    expect(read(s.root, blob(pf))).toBe('ollama downloaded this');
    expect(owned).toContain(blob(q4));
    expect(owned).toContain(blob(pf));
    expect(s.warnings.some((w) => w.includes(`${blob(q4)}: points elsewhere`))).toBe(true);
  });

  it('a link to another copy of the same blob name is correct and left alone', async () => {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    mkdirSync(path.join(s.root, 'blobs'), { recursive: true });
    const other = path.join(s.lc.model.hubRoot, 'models--other--Repo', 'blobs', q4);
    symlinkSync(other, path.join(s.root, blob(q4)));
    await s.run();
    expect(readlinkSync(path.join(s.root, blob(q4)))).toBe(other);
    expect(existsSync(path.join(s.root, blob(pf)))).toBe(true);
  });
});

describe('create: failure after the first write', () => {
  async function withFailing(method: 'writeFile' | 'rename', when: (p: string) => boolean): Promise<{ s: Setup; ctx: ApplyCtx }> {
    const s = await setup({ aliases: {} });
    seedMissing(s.root);
    const safeFs = await SafeFs.create({ hubRoot: s.lc.model.hubRoot, viewRoots: [s.root], holdRoot: null }, failingFs(s.lc.fs, method, 'EACCES', when));
    return { s, ctx: { ...s.ctx(), safeFs } };
  }

  it('an I/O failure on the manifest write throws CreateIncomplete listing exactly what was written; never a SkipEntry', async () => {
    const { s, ctx } = await withFailing('writeFile', (p) => p.includes('/manifests/hf.co/'));
    const err = await s.create(s.d, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreateIncomplete);
    expect(err).not.toBeInstanceOf(SkipEntry);
    const { manifest, config } = synthesise(header([['general.architecture', 'llama'], ['general.file_type', 15]], 1_000_500),
      { sha256: q4, size: s.d.ollama!.entry.size }, { sha256: pf, size: s.d.ollama!.mmproj!.size });
    const cfgHex = finish(manifest, config).cfgDigest.slice(7);
    expect(pySort((err as CreateIncomplete).written)).toEqual(pySort([blob(q4), blob(pf), blob(cfgHex)]));
    expect((err as CreateIncomplete).cause).toMatchObject({ code: 'IO' });
    for (const rel of (err as CreateIncomplete).written) expect(existsSync(path.join(s.root, rel)) || readlinkSync(path.join(s.root, rel)) !== '').toBe(true);
    expect(existsSync(path.join(s.root, MAN))).toBe(false);
  });

  it('a failure on the very first write is not CreateIncomplete and leaves no file or link', async () => {
    const { s, ctx } = await withFailing('writeFile', () => true);
    const before = await treeDigest(s.root);
    const err = await s.create(s.d, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CreateIncomplete);
    const after = await treeDigest(s.root);
    expect(Object.entries(after).filter(([, v]) => v !== 'dir')).toEqual(Object.entries(before).filter(([, v]) => v !== 'dir'));
  });
});

describe('ollama-create coverage closers', () => {
  it('finish refuses a manifest without a layers array and a layer that is not an object', () => {
    expect(() => finish(m('{}'), m('{}'))).toThrow(new SkipEntry('manifest has no layers array; skipped'));
    expect(() => finish(m('{"layers":[5]}'), m('{}'))).toThrow(new SkipEntry('manifest layer has no digest; skipped'));
  });

  it('a GGUF reader that throws a non-Error value is still reported as a SkipEntry with that text', async () => {
    const s = await setup();
    seedMissing(s.root);
    const create = makeOllamaCreate({
      registry: { root: s.root, fs: s.lc.fs, fetch: fakeFetch({ status: 404 }), offline: false, token: null },
      hubRoot: s.lc.model.hubRoot,
      readGguf: () => Promise.reject('plain string failure'),
      collisions: registryCollisions(ggufEntries(s.lc.model)),
    });
    await expect(create(s.d, s.ctx())).rejects.toThrow(new SkipEntry(`${KEY}: cannot read the GGUF header (plain string failure); skipped`));
  });

  it('an existing alias file that cannot be read is treated as another model\'s and left alone', async () => {
    const s = await setup({ aliases: { a: KEY } });
    seedMissing(s.root);
    await s.run();
    const before = read(s.root, alias('a'));
    s.warnings.length = 0;
    const ctx: ApplyCtx = { ...s.ctx(), fs: failingFs(s.lc.fs, 'readFile', 'EACCES', (p) => p.endsWith(alias('a'))) };
    const owned = await s.create(s.d, ctx);
    expect(owned).not.toContain(alias('a'));
    expect(s.warnings.filter((w) => w.includes('belongs to another model'))).toEqual([`${KEY}: alias ${alias('a')} exists and belongs to another model; not overwritten`]);
    expect(read(s.root, alias('a'))).toBe(before);
  });

  it('a blob whose existence cannot be determined (not "missing") aborts the create', async () => {
    const s = await setup();
    seedMissing(s.root);
    const before = await treeDigest(s.root);
    const ctx: ApplyCtx = { ...s.ctx(), fs: failingFs(s.lc.fs, 'stat', 'EACCES', (p) => p.includes('/blobs/sha256-')) };
    await expect(s.create(s.d, ctx)).rejects.toThrow(/EACCES/);
    expect(await treeDigest(s.root)).toEqual(before);
  });
});

describe('create: a manifest the user pulled with Ollama is never overwritten with another model', () => {
  const theirs = 'f'.repeat(64);
  const naming = (h: string): string => JSON.stringify({ layers: [{ mediaType: MT.model, digest: dig(h) }] });
  const MSG = `${MAN}: model downloaded by Ollama; not replaced`;

  it('an hf.co manifest naming another model whose blob is a regular file: SkipEntry, nothing written', async () => {
    const s = await setup();
    seedMissing(s.root);
    put(s.root, MAN, naming(theirs));
    put(s.root, `blobs/sha256-${theirs}`, 'weights the user pulled');
    const before = await treeDigest(s.root);
    await expect(s.run()).rejects.toThrow(new SkipEntry(MSG));
    expect(await treeDigest(s.root)).toEqual(before);
  });

  it('written as before (CLI parity) when that blob is a link, the manifest names our model or no model, or does not parse', async () => {
    for (const [text, blob] of [[naming(theirs), 'link'], [naming(q4), 'file'], ['{"layers":[]}', 'none'], ['{bad', 'none']] as const) {
      const s = await setup();
      seedMissing(s.root);
      put(s.root, MAN, text);
      if (blob === 'link') {
        mkdirSync(path.join(s.root, 'blobs'), { recursive: true });
        symlinkSync(path.join(s.lc.model.hubRoot, 'elsewhere'), path.join(s.root, `blobs/sha256-${theirs}`));
      }
      if (blob === 'file') put(s.root, `blobs/sha256-${q4}`, 'weights the user pulled');
      s.planned.set(MAN, await factsOf(s.lc.fs, path.join(s.root, MAN)));
      expect(await s.run()).toContain(MAN);
      expect(read(s.root, MAN)).not.toBe(text);
    }
  });

  it('an hf.co manifest that cannot be read, or is over the 16 MiB cap, is a SkipEntry', async () => {
    const s = await setup();
    seedMissing(s.root);
    put(s.root, MAN, naming(theirs));
    const failing: ApplyCtx = { ...s.ctx(), fs: failingFs(s.lc.fs, 'readFile', 'EACCES', (p) => p.endsWith(MAN)) };
    await expect(s.create(s.d, failing)).rejects.toThrow(new SkipEntry(`${MAN}: cannot be read to check its model; skipped`));
    writeFileSync(path.join(s.root, MAN), Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(s.run()).rejects.toThrow(new SkipEntry(`${MAN}: too large to check; skipped`));
  });

  it('an owned alias naming the previous model, whose blob is a regular file, is refused (not overwritten, not owned)', async () => {
    const old = 'b'.repeat(64);
    const s = await setup();
    seedMissing(s.root);
    put(s.root, alias('tiny'), naming(old));
    put(s.root, `blobs/sha256-${old}`, 'weights the user pulled');
    const owned = await s.create(s.d, s.ctx(), { paths: [alias('tiny')], sha256: old });
    expect(owned).not.toContain(alias('tiny'));
    expect(read(s.root, alias('tiny'))).toBe(naming(old));
    expect(s.warnings).toContain(`${KEY}: alias ${alias('tiny')} names a model downloaded by Ollama; not overwritten`);
  });
});
