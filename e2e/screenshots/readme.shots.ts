// README screenshots (npm run screenshots): the built app on a showcase cache, written to docs/screenshots/. With
// HFCM_APP_EXE set to a packaged executable, that build is shot instead.
//
// The cache is built in a fresh run dir like every E2E fixture and launched through the same guarded harness env
// (HFCM_E2E on, every location inside the run dir, no network but the loopback fake Hub). Its model files are sparse:
// a real GGUF header (or safetensors-sized hole) followed by nothing, so a "17.6 GB" quant costs a few KB of disk and
// the advice still reads a real model shape. The run dir is removed at the end.
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, open, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeHub, type FakeHubRepo } from '../../tests/helpers/fake-hub';
import { makeTempRoot, removeTempRoot } from '../../tests/helpers/tmp';
import { buildLaunchEnv, launchCwd, launchOptions } from '../launch-env';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const outDir = join(repoRoot, 'docs', 'screenshots');
const GB = 1e9;
const MB = 1e6;

/** A fixed example PC and disk, so the images are the same on every machine and show nothing of the one that ran it. */
const MACHINE = JSON.stringify({
  platform: 'linux', gpuName: 'NVIDIA GeForce RTX 5090', gpuBytes: 32 * 2 ** 30, gpuKind: 'nvidia', computeCap: 12,
  drivesDisplay: true, ramBytes: 64 * 2 ** 30,
});
const DISK = JSON.stringify({ totalBytes: 4_000_000_000_000, freeBytes: 1_200_000_000_000 });

// ---------------------------------------------------------------- GGUF headers

interface Arch { arch: string; layers: number; heads: number; kvHeads: number; embd: number; keyLength: number; ctx: number; experts?: number }
const QWEN: Arch = { arch: 'qwen3', layers: 64, heads: 40, kvHeads: 8, embd: 5120, keyLength: 128, ctx: 262_144 };
const GEMMA: Arch = { arch: 'gemma3', layers: 62, heads: 32, kvHeads: 16, embd: 5376, keyLength: 128, ctx: 131_072 };
const GPT_OSS: Arch = { arch: 'gpt-oss', layers: 24, heads: 64, kvHeads: 8, embd: 2880, keyLength: 64, ctx: 131_072, experts: 32 };

function ggufHeader(a: Arch, fileType: number): Buffer {
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (t: string): Buffer => Buffer.concat([u64(Buffer.byteLength(t)), Buffer.from(t)]);
  const kvStr = (k: string, v: string): Buffer => Buffer.concat([str(k), u32(8), str(v)]);
  const kvU32 = (k: string, v: number): Buffer => Buffer.concat([str(k), u32(4), u32(v)]);
  const kvs = [
    kvStr('general.architecture', a.arch), kvU32('general.file_type', fileType), kvU32(`${a.arch}.block_count`, a.layers),
    kvU32(`${a.arch}.attention.head_count`, a.heads), kvU32(`${a.arch}.attention.head_count_kv`, a.kvHeads),
    kvU32(`${a.arch}.embedding_length`, a.embd), kvU32(`${a.arch}.attention.key_length`, a.keyLength),
    kvU32(`${a.arch}.attention.value_length`, a.keyLength), kvU32(`${a.arch}.context_length`, a.ctx),
    ...(a.experts === undefined ? [] : [kvU32(`${a.arch}.expert_count`, a.experts)]),
  ];
  const tensor = Buffer.concat([str('token_embd.weight'), u32(1), u64(a.embd), u32(8), u64(0)]);
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(kvs.length), ...kvs, tensor]);
}

// ---------------------------------------------------------------- the showcase cache

/** A file: its path in the snapshot, its size, and the bytes at its start (the rest is a sparse hole). */
interface ShowFile { path: string; size: number; head?: Buffer | string }
interface ShowRepo { id: string; type?: 'model' | 'dataset'; files: ShowFile[] }

const json = (o: unknown): string => JSON.stringify(o, null, 2);
const gguf = (path: string, size: number, a: Arch, fileType: number): ShowFile => ({ path, size, head: ggufHeader(a, fileType) });
const text = (path: string, body: string): ShowFile => ({ path, size: Buffer.byteLength(body), head: body });
const shards = (dir: string, stem: string, sizes: number[]): ShowFile[] => sizes.map((size, i) => ({
  path: `${dir}${stem}-${String(i + 1).padStart(5, '0')}-of-${String(sizes.length).padStart(5, '0')}.safetensors`, size,
}));
const index = (dir: string, files: ShowFile[]): ShowFile => text(`${dir}${dir === '' ? 'model' : 'diffusion_pytorch_model'}.safetensors.index.json`, json({
  metadata: { total_size: files.reduce((n, f) => n + f.size, 0) },
  weight_map: Object.fromEntries(files.map((f, i) => [`layers.${i}.weight`, f.path.slice(dir.length)])),
}));
const README = (title: string): ShowFile => text('README.md', `# ${title}\n\nModel card.\n`);

const qwen8b = shards('', 'model', [3.96 * GB, 3.99 * GB, 3.96 * GB, 3.19 * GB, 1.24 * GB]);
const fluxT = shards('transformer/', 'diffusion_pytorch_model', [9.98 * GB, 9.95 * GB, 3.87 * GB]);
const fluxTe2 = shards('text_encoder_2/', 'model', [4.99 * GB, 4.53 * GB]);

const SHOWCASE: ShowRepo[] = [
  { id: 'unsloth/Qwen3.6-27B-GGUF', files: [
    gguf('Qwen3.6-27B-UD-IQ3_XXS.gguf', 10.8 * GB, QWEN, 23), gguf('Qwen3.6-27B-UD-Q4_K_XL.gguf', 17.6 * GB, QWEN, 15), gguf('Qwen3.6-27B-Q6_K.gguf', 22.4 * GB, QWEN, 18),
    gguf('Qwen3.6-27B-Q8_0.gguf', 28.7 * GB, QWEN, 7), { path: 'mmproj-F16.gguf', size: 0.93 * GB },
    { path: 'mmproj-BF16.gguf', size: 0.93 * GB }, README('Qwen3.6-27B GGUF'),
  ] },
  { id: 'bartowski/gemma-4-31b-it-GGUF', files: [
    gguf('gemma-4-31b-it-IQ4_XS.gguf', 17.0 * GB, GEMMA, 30), gguf('gemma-4-31b-it-Q4_K_M.gguf', 18.9 * GB, GEMMA, 15),
    gguf('gemma-4-31b-it-Q5_K_M.gguf', 22.1 * GB, GEMMA, 17), { path: 'mmproj-gemma-4-31b-it-f16.gguf', size: 0.85 * GB },
    README('gemma-4-31b-it GGUF'),
  ] },
  { id: 'unsloth/gpt-oss-20b-GGUF', files: [
    gguf('gpt-oss-20b-F16.gguf', 13.8 * GB, GPT_OSS, 1), gguf('gpt-oss-20b-Q4_K_M.gguf', 11.6 * GB, GPT_OSS, 15), README('gpt-oss-20b GGUF'),
  ] },
  { id: 'Qwen/Qwen3-8B', files: [
    ...qwen8b, index('', qwen8b),
    text('config.json', json({
      architectures: ['Qwen3ForCausalLM'], model_type: 'qwen3', num_hidden_layers: 36, num_attention_heads: 32,
      num_key_value_heads: 8, hidden_size: 4096, head_dim: 128, max_position_embeddings: 40_960, torch_dtype: 'bfloat16',
    })),
    { path: 'tokenizer.json', size: 11.4 * MB }, text('tokenizer_config.json', '{}'), text('generation_config.json', '{}'), README('Qwen3-8B'),
  ] },
  { id: 'black-forest-labs/FLUX.1-dev', files: [
    text('model_index.json', json({
      _class_name: 'FluxPipeline', scheduler: ['diffusers', 'FlowMatchEulerDiscreteScheduler'], text_encoder: ['transformers', 'CLIPTextModel'],
      text_encoder_2: ['transformers', 'T5EncoderModel'], tokenizer: ['transformers', 'CLIPTokenizer'],
      tokenizer_2: ['transformers', 'T5TokenizerFast'], transformer: ['diffusers', 'FluxTransformer2DModel'], vae: ['diffusers', 'AutoencoderKL'],
    })),
    ...fluxT, index('transformer/', fluxT), ...fluxTe2, text('text_encoder_2/model.safetensors.index.json', json({
      metadata: {}, weight_map: Object.fromEntries(fluxTe2.map((f, i) => [`l${i}`, f.path.slice('text_encoder_2/'.length)])),
    })),
    { path: 'text_encoder/model.safetensors', size: 246 * MB }, { path: 'vae/diffusion_pytorch_model.safetensors', size: 168 * MB },
    text('vae/config.json', '{}'), text('scheduler/scheduler_config.json', '{}'), { path: 'tokenizer/vocab.json', size: 1.06 * MB },
    { path: 'flux1-dev.safetensors', size: 23.8 * GB }, { path: 'ae.safetensors', size: 335 * MB }, README('FLUX.1 [dev]'),
  ] },
  { id: 'openai/whisper-large-v3', files: [
    { path: 'model.safetensors', size: 3.09 * GB }, { path: 'tokenizer.json', size: 2.48 * MB },
    text('config.json', json({ architectures: ['WhisperForConditionalGeneration'], model_type: 'whisper', torch_dtype: 'float16' })),
    README('Whisper large-v3'),
  ] },
  { id: 'sentence-transformers/all-MiniLM-L6-v2', files: [
    { path: 'model.safetensors', size: 90.9 * MB }, text('config.json', json({ architectures: ['BertModel'], model_type: 'bert' })),
    { path: 'tokenizer.json', size: 466 * 1024 }, README('all-MiniLM-L6-v2'),
  ] },
];

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** Writes `repo` in the Hugging Face cache layout under `hub`: blobs, snapshots/<commit> links and refs/main. */
async function writeRepo(hub: string, repo: ShowRepo): Promise<void> {
  const folder = join(hub, `${repo.type === 'dataset' ? 'datasets' : 'models'}--${repo.id.replace('/', '--')}`);
  const commit = hex(20);
  await mkdir(join(folder, 'blobs'), { recursive: true });
  await mkdir(join(folder, 'refs'), { recursive: true });
  await writeFile(join(folder, 'refs', 'main'), commit);
  for (const f of repo.files) {
    const blob = join(folder, 'blobs', f.size > 10 * MB ? hex(32) : hex(20));   // sha256 for LFS-sized files, git sha1 otherwise
    const h = await open(blob, 'wx');
    try {
      if (f.head !== undefined) await h.write(typeof f.head === 'string' ? Buffer.from(f.head) : f.head);
      await h.truncate(Math.round(f.size));   // the rest is a hole: no disk is used for it
    } finally {
      await h.close();
    }
    const link = join(folder, 'snapshots', commit, ...f.path.split('/'));
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), blob), link);
  }
}

// ---------------------------------------------------------------- the Hub repo shown in Download mode

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const HUB_QUANTS: Array<[string, number, number]> = [
  ['UD-IQ2_M', 10.4, 29], ['IQ4_XS', 17.7, 30], ['UD-Q4_K_XL', 19.6, 15], ['Q5_K_M', 23.5, 17], ['Q6_K', 27.2, 18], ['Q8_0', 35.1, 7],
];
const HUB_REPO: FakeHubRepo = (() => {
  const files: Record<string, Uint8Array> = {};
  const listedSizes: Record<string, number> = {};
  const qwen32: Arch = { ...QWEN, layers: 64, heads: 64, embd: 5120 };
  for (const [label, gb, ft] of HUB_QUANTS) {
    const name = `Qwen3.6-35B-A3B-${label}.gguf`;
    files[name] = ggufHeader({ ...qwen32, experts: 128 }, ft);
    listedSizes[name] = Math.round(gb * GB);
  }
  files['mmproj-F16.gguf'] = enc('mmproj');
  listedSizes['mmproj-F16.gguf'] = Math.round(0.86 * GB);
  files['README.md'] = enc('# Qwen3.6-35B-A3B GGUF\n');
  files['images/benchmark.png'] = enc('png');
  return {
    repoId: 'unsloth/Qwen3.6-35B-A3B-GGUF', commit: hex(20), files, listedSizes,
    lfs: Object.keys(files).filter((f) => f.endsWith('.gguf') || f.endsWith('.png')),
  };
})();

// ---------------------------------------------------------------- the shots

/**
 * The run dir's hub path wherever the UI prints it, shown as the default cache location a user would see (the run dir
 * itself is an artefact of the isolated launch). Display text only; nothing else on the page changes.
 */
async function showDefaultHubPath(page: Page, hubRoot: string): Promise<void> {
  await page.evaluate((hub) => {
    // The page's DOM, typed here: this project compiles e2e/ against Node's types only.
    interface Text { nodeValue: string | null }
    const doc = (globalThis as unknown as { document: { body: unknown; createTreeWalker(root: unknown, show: number): { nextNode(): Text | null } } }).document;
    const walk = doc.createTreeWalker(doc.body, 4);   // NodeFilter.SHOW_TEXT
    for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
      if (n.nodeValue?.includes(hub) === true) n.nodeValue = n.nodeValue.split(hub).join('~/.cache/huggingface/hub');
    }
  }, hubRoot);
}

async function shot(page: Page, name: string, hubRoot: string): Promise<void> {
  await page.mouse.move(0, 0);   // no stray hover
  await page.waitForTimeout(400);   // tooltips and transitions settle
  await showDefaultHubPath(page, hubRoot);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
}

test('README screenshots', async () => {
  test.setTimeout(120_000);
  const root = await makeTempRoot('hfcm-e2e-');
  const hub = await startFakeHub([HUB_REPO]);
  try {
    const paths = {
      root, hubRoot: join(root, 'hub'), configPath: join(root, 'hfhub-config.toml'), hfHome: join(root, 'hf-home'),
      home: join(root, 'home'), userDataDir: join(root, 'user-data'),
    };
    for (const d of [paths.hubRoot, paths.hfHome, paths.home, paths.userDataDir]) await mkdir(d, { recursive: true });
    for (const r of SHOWCASE) await writeRepo(paths.hubRoot, r);
    const env = buildLaunchEnv(process.env, paths, { extra: { HFCM_E2E_MACHINE: MACHINE, HFCM_E2E_DISK: DISK, HF_ENDPOINT: hub.endpoint } });
    // HFCM_APP_EXE: shoot a packaged build instead (dist/linux-unpacked/hf-cache-manager), which also proves it runs
    const exe = process.env['HFCM_APP_EXE'];
    const app = await electron.launch(launchOptions(join(repoRoot, 'out/main/index.js'), env, launchCwd(repoRoot, root), exe === '' ? undefined : exe));
    try {
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w?.setContentSize(1440, 900);
        w?.center();
      });
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId('repo-row')).toHaveCount(SHOWCASE.length, { timeout: 30_000 });

      // 1. the library with a GGUF repo open: the quants with keep advice and name hints
      const qwen = page.locator('[data-testid="repo-row"][data-repo-id="unsloth/Qwen3.6-27B-GGUF"]');
      await qwen.click();
      await expect(page.locator('[data-testid="group-row"][data-tint]').first()).toBeVisible({ timeout: 15_000 });
      await shot(page, 'library', paths.hubRoot);

      // 2. a deletion review: the red quants ticked, what is freed and what stays
      for (const key of ['quant:Q6_K', 'quant:Q8_0', 'mmproj:vision projector (BF16)']) {
        await page.locator(`[data-testid="group-row"][data-group-key="${key}"] [data-testid="group-checkbox"]`).click();
      }
      await expect(page.getByTestId('btn-review')).toBeEnabled({ timeout: 10_000 });
      await page.getByTestId('btn-review').click();
      await expect(page.getByTestId('review-dialog')).toBeVisible();
      await shot(page, 'review', paths.hubRoot);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('review-dialog')).toHaveCount(0);

      // 3. Download mode: a Hub repo with Requires, cache state and advice for this PC
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      await page.getByTestId('hub-input').fill('https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF');
      await page.getByTestId('hub-input').press('Enter');
      await expect(page.getByTestId('dl-row').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Reading model shape…')).toHaveCount(0, { timeout: 15_000 });
      await page.getByRole('button', { name: 'Select the best pick' }).click();
      await page.waitForTimeout(800);
      await shot(page, 'download', paths.hubRoot);
    } finally {
      await app.close();
    }
  } finally {
    await hub.close();
    await removeTempRoot(root);
  }
});
