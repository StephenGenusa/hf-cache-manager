// The small GGUF repo the fake Hub serves in the download E2E and the layout golden test: three single-file quants
// with tiny valid GGUF headers (so advice can size them), one mmproj and a config.json. Every size is the real size of
// the bytes served (the fake Hub cannot advertise a size apart from the bytes), so everything is a few KB.
import type { FakeHubRepo } from './fake-hub';
import { tinyGgufHeader } from './app-fixture';

export const GGUF_REPO_ID = 'acme/tiny-GGUF';
export const GGUF_COMMIT = 'c0ffee'.repeat(6) + 'abcd';   // 40 hex chars

/** Distinct, deterministic bytes (so no two blobs share an etag). */
const filler = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

export function ggufRepo(nested = false): FakeHubRepo {
  const files: Record<string, Uint8Array> = {
    'tiny-Q4_K_M.gguf': tinyGgufHeader(4096, 15),
    'tiny-Q8_0.gguf': tinyGgufHeader(4096, 7),
    'tiny-BF16.gguf': tinyGgufHeader(4096, 32),
    'mmproj-F16.gguf': filler(2048, 3),
    'config.json': new TextEncoder().encode('{"model_type":"llama"}'),
  };
  if (nested) files['onnx/deep/model.onnx'] = filler(1024, 9);
  return { repoId: GGUF_REPO_ID, commit: GGUF_COMMIT, files, lfs: Object.keys(files).filter((f) => f !== 'config.json') };
}
