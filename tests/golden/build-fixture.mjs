// Deterministic hub / view / config builder shared by the unit tests and scripts/golden/generate.sh.
// Plain ESM, Node built-ins only, so a shell script can run it without a build.
//
// CaseSpec (JSON):
//   {
//     repos: [{ id, type?: 'model', main, snapshots: [{ commit, mtime /* seconds */,
//               files: [{ path, text? | gguf?: { arch, fileType, tensors, tokens?, pad? },
//                         plain?: bool /* regular file in the snapshot, no blob */,
//                         store?: bool /* repo blob is a relative link into <hub>/blobs/<xx>/<h> */,
//                         dangling?: bool /* the snapshot link is written but its blob is not (a broken link) */ }] }] }],
//     views: ('lmstudio' | 'ollama')[],   // creates <dir>/views/<name>/; a view left out is configured but not created
//     aliases?: { [alias]: target },      // written under [views.ollama.aliases]
//     viewFiles?: { lmstudio?: { [rel]: string | { link: string } }, ollama?: { ... } },  // '@HUB@' in a link = hub path
//     noConfig?: bool                     // config.toml is not written (HFHUB_CONFIG still points at it)
//   }
// Blob etag = sha256 of the content; identical content in one repo shares one blob. A store payload is named
// sha256('xet:' + etag) and gets a ".refs" file; the store marker is written as "1\n".
import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => { const t = Buffer.from(s, 'utf8'); return Buffer.concat([u64(t.length), t]); };

/** A minimal GGUF v3 file: arch + file type (+ a token array), tensor infos (dims only), then `pad` zero bytes. */
export function ggufBytes(o) {
  const kvs = [
    Buffer.concat([str('general.architecture'), u32(8), str(o.arch)]),
    Buffer.concat([str('general.file_type'), u32(4), u32(o.fileType)]),
  ];
  if (o.tokens !== undefined) {
    const items = [];
    for (let i = 0; i < o.tokens; i++) items.push(str(`t${i}`));
    kvs.push(Buffer.concat([str('tokenizer.ggml.tokens'), u32(9), u32(8), u64(o.tokens), ...items]));
  }
  const infos = o.tensors.map((dims, i) =>
    Buffer.concat([str(`blk.${i}.w`), u32(dims.length), ...dims.map((d) => u64(d)), u32(0), u64(0)]));
  const out = [Buffer.from('GGUF'), u32(3), u64(o.tensors.length), u64(kvs.length), ...kvs, ...infos];
  if (o.pad) out.push(Buffer.alloc(o.pad));
  return new Uint8Array(Buffer.concat(out));
}

const contentOf = (f) => (f.gguf ? ggufBytes(f.gguf) : Buffer.from(f.text ?? '', 'utf8'));
const put = async (p, data) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); };
const link = async (target, p) => { await mkdir(dirname(p), { recursive: true }); await symlink(target, p); };
const q = (s) => JSON.stringify(s);

export async function buildCase(dir, spec) {
  const hub = join(dir, 'hub');
  const home = join(dir, 'home');
  const hfHome = join(dir, 'hf');
  const configPath = join(home, '.config', 'hfhub', 'config.toml');
  const roots = { lmstudio: join(dir, 'views', 'lmstudio'), ollama: join(dir, 'views', 'ollama') };
  const created = new Set(spec.views ?? []);
  await mkdir(hub, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(hfHome, { recursive: true });

  const storeRefs = new Map(); // payload path -> Set of ref lines
  const storeData = new Map(); // payload path -> content
  const stamps = []; // [snapshot dir, mtime seconds]
  for (const repo of spec.repos ?? []) {
    const folderName = `${repo.type ?? 'model'}s--${repo.id.replaceAll('/', '--')}`;
    const folder = join(hub, folderName);
    await mkdir(join(folder, 'blobs'), { recursive: true });
    const blobs = new Map(); // etag already written in this repo
    for (const snap of repo.snapshots) {
      const snapDir = join(folder, 'snapshots', snap.commit);
      await mkdir(snapDir, { recursive: true });
      stamps.push([snapDir, snap.mtime]);
      for (const f of snap.files) {
        const at = join(snapDir, ...f.path.split('/'));
        const content = contentOf(f);
        if (f.plain) { await put(at, content); continue; }
        const etag = sha256Hex(content);
        if (!f.dangling && !blobs.has(etag)) {
          blobs.set(etag, true);
          const blobAt = join(folder, 'blobs', etag);
          if (f.store) {
            const h = sha256Hex(`xet:${etag}`);
            const payload = join(hub, 'blobs', h.slice(0, 2), h);
            storeData.set(payload, content);
            if (!storeRefs.has(payload)) storeRefs.set(payload, new Set());
            storeRefs.get(payload).add(`${folderName}/blobs/${etag}`);
            await link(`../../blobs/${h.slice(0, 2)}/${h}`, blobAt);
          } else {
            await put(blobAt, content);
          }
        }
        await link(`${'../'.repeat(1 + f.path.split('/').length)}blobs/${etag}`, at);
      }
    }
    await put(join(folder, 'refs', 'main'), repo.main);
  }
  if (storeData.size > 0) await put(join(hub, 'blobs', '.huggingface-shared-blobs'), '1\n');
  for (const [payload, content] of storeData) {
    await put(payload, content);
    await put(`${payload}.refs`, [...storeRefs.get(payload)].sort().map((l) => `${l}\n`).join(''));
  }

  for (const v of created) await mkdir(roots[v], { recursive: true });
  for (const v of ['lmstudio', 'ollama']) {
    for (const [rel, val] of Object.entries(spec.viewFiles?.[v] ?? {})) {
      const at = join(roots[v], ...rel.split('/'));
      if (typeof val === 'string') await put(at, val);
      else await link(val.link.replaceAll('@HUB@', hub), at);
    }
  }

  if (!spec.noConfig) {
    let toml = `[views.lmstudio]\nroot = ${q(roots.lmstudio)}\n\n[views.ollama]\nroot = ${q(roots.ollama)}\n`;
    const aliases = Object.entries(spec.aliases ?? {});
    if (aliases.length > 0) toml += `\n[views.ollama.aliases]\n${aliases.map(([k, v]) => `${q(k)} = ${q(v)}\n`).join('')}`;
    await put(configPath, toml);
  }

  // Directory mtimes last: creating entries inside a directory changes it.
  for (const [d, secs] of stamps) await utimes(d, secs, secs);

  return {
    dir, hub, home, configPath,
    lmstudio: spec.noConfig && !created.has('lmstudio') ? null : roots.lmstudio,
    ollama: spec.noConfig && !created.has('ollama') ? null : roots.ollama,
    env: { HF_HUB_CACHE: hub, HFHUB_CONFIG: configPath, HF_HOME: hfHome },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [casePath, outDir] = process.argv.slice(2);
  if (!casePath || !outDir) {
    console.error('usage: node tests/golden/build-fixture.mjs <case.json> <outdir>');
    process.exit(2);
  }
  const built = await buildCase(outDir, JSON.parse(await readFile(casePath, 'utf8')));
  console.log(JSON.stringify(built));
}
