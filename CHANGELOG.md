# Changelog

## 1.2.0 — 2026-11-20

- **Check for updates:** one click compares every cached repo with its `main` revision on the Hub and gives an
  **update** badge to each repo where the Hub has a newer version of a file you already have. The **Updates** chip
  keeps only those repos. The findings are saved, survive a restart, and clear once the files are refreshed. Opening a
  badged repo checks it again and marks the groups and files with a newer version. The check uses your token for gated
  and private repos, waits as long as the Hub asks when it rate-limits, and can be cancelled.
- **Repo menu:** right-click a repo in the library, a looked-up repo or a recent look-up for **Open on Hugging Face**;
  library repos also have **Open in Download tab**. Clicking a repo's name opens its Hugging Face page.
- **Select All** ticks every group of the open repo. Locked components stay out until they are unlocked.
- **Downloads:** when a new revision reuses files already in the cache, they are checked against their hash before
  they are linked, and the file's line shows how much has been checked, so a long check no longer looks stuck.
- **Fix: clearer error for a mismatched cached file.** When the cache already holds a file under the Hub's name with
  other content, the download now says so and how to clear it (delete it from the library, then download again),
  instead of "a different file is already there".

## 1.1.0 — 2026-11-19

- **Export to drive:** copy models from the library to a USB drive. The app shows the connected drives, checks that
  the selection fits, and writes only inside a folder named `hf-cache-manager-transfer`. It never deletes or replaces
  a file on the drive. Large files are stored in parts of 1 GB, so the drive can use FAT32, exFAT, NTFS or ext4.
- **Load from USB:** in Download mode, list the models on a connected drive and load them into the cache. Each file is
  checked against its Hugging Face hash before it enters the cache. Nothing in the cache or in the saved settings
  points to the drive. Loading never goes online, so it works with `HF_HUB_OFFLINE=1`.
- **Configuration:** `HFCM_TRANSFER_ROOTS` names the folders to use as drives when a drive is mounted in an unusual
  place.
- **Fix: Windows caches with the shared blob store.** The store marker and `.refs` files that `huggingface_hub` writes
  with CRLF line endings on Windows are now read correctly. A file that is not LFS, linked to a blob named by its
  40-hex git id, now counts that blob's size instead of 0.

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
