# Changelog

## 1.0.1 — 2026-11-10

- **Diffusion and ComfyUI repos:** a new kind, "Diffusion / ComfyUI", for repos whose model card or configs say they
  are a diffusion model or packaged for ComfyUI, with advice worded to match.
- **Name hints:** `W#A#`, `MXFP#`, `INT#` and `LoRA` in file names are explained.
- **Fix:** a download look-up no longer expires while you are still choosing files. When a look-up again is needed,
  the footer says why (the look-up expired, the cache changed, or the repo changed on the Hub) instead of always
  saying the repo changed.

## 1.0.0 — 2026-10-31

First release.

- **Library:** every cached model, dataset and space by name, size and kind, with LM Studio and Ollama usage; search,
  sort and filters; a header meter of the cache against the whole disk.
- **Contents in human terms:** GGUF quants, vision projectors and draft models, pipeline components and sharded
  weights as groups; hover hints for every part of a model file name.
- **Keep advice:** green, yellow or red verdicts per quant from the GGUF header's model shape against your GPU, RAM,
  context length, KV-cache type and tools; one judgment for each non-GGUF repo. Detected hardware can be adjusted in
  Settings.
- **Safe deletion:** a review of every file removed and kept, the space actually freed, and the LM Studio and Ollama
  links affected; the cache is re-checked when you confirm.
- **Recently Deleted:** restorable deletions on the same disk, emptied automatically after 14 days (configurable);
  permanent deletion with a typed confirmation.
- **Download mode:** look up a repo id or Hugging Face URL, see what each file requires on disk with advice for this
  PC, and download into the cache exactly as `hf download` would: resumable, verified against the Hub's SHA-256, with a
  free-space check and a downloads panel.
- **Sync:** rebuild the LM Studio and Ollama symlink views with a preview first, compatible with the `hf-xfer` CLI from
  [hf-hub-utilities](https://github.com/StephenGenusa/hf-hub-utilities).
- **Packages:** Linux AppImage, Windows installer and macOS zip (x64).

See [Known limitations](README.md#known-limitations).
