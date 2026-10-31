#!/usr/bin/env bash
# Generates the golden fixtures by running the real Python CLI (hf-xfer) on the cases in tests/golden/cases.
#
#   HFXFER=/abs/path/to/venv/bin/hf-xfer PYTHON=/abs/path/to/python3 scripts/golden/generate.sh
#
# Needs: the hf-xfer CLI, python3 and node.
#   - HFXFER / PYTHON: pass ABSOLUTE paths to the real executables (the venv's hf-xfer and python). The CLI runs under
#     `env -i` with HOME redirected, so pyenv / asdf shims, which look in $HOME, do not work; a venv or uv install does.
# Safety:
#   - the CLI and its hub/view copies run inside one mktemp -d directory. It holds no fixtures; it is deleted when the
#     run succeeds and KEPT (its path is printed) when the run fails, so the CLI logs and trees can be inspected
#   - the only places written outside it are tests/golden/pyjson/expected.json and tests/golden/cases/*/ (expected/,
#     the staging dir .expected.staging/ and expected.prev-<UTC timestamp>/, all git-ignored except expected/)
#   - a case's fixtures are built in tests/golden/cases/<case>/.expected.staging/ (same filesystem) and renamed to
#     expected/ only when the whole case succeeded. An existing expected/ is NEVER deleted: it is renamed to
#     expected.prev-<UTC timestamp>/ next to it and the path is printed. An already existing staging dir stops the
#     script. On failure the staging dir is removed, but only if this run created it
#   - the CLI runs with a clean environment: HOME, HF_HOME, HF_HUB_CACHE, HFHUB_CONFIG, XDG_* and TMPDIR all point
#     into the temp directory, offline mode is on, proxies point at a closed port and no token is passed. It never
#     sees your real cache, config or token
#   - `hf-xfer sync` exits 0 even when it skipped, aborted or refused a view, so the log of every call is checked:
#     the script fails unless each of the case's views reports "applied:" and none reports skipped/aborted/refused.
#     Each CLI log is kept next to the fixtures as expected/<step>/cli.log (not compared by the tests).
set -euo pipefail

HFXFER="${HFXFER:-hf-xfer}"
PY="${PYTHON:-python3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
G="$ROOT/tests/golden"

command -v "$HFXFER" >/dev/null 2>&1 || { echo "hf-xfer not found (set HFXFER=/absolute/path/to/hf-xfer)" >&2; exit 1; }
command -v "$PY" >/dev/null 2>&1 || { echo "python not found (set PYTHON=/absolute/path/to/python3)" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node not found" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hfcm-golden.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"   # resolved once, so the CLI and the listings agree on every path
case "$WORK" in
  */hfcm-golden.??????) ;;
  *) echo "unexpected temp dir: $WORK" >&2; exit 1 ;;
esac
STAGING=""   # the staging dir of the case in progress, set only after this run created it
on_exit() {
  local rc=$?
  if [ -n "$STAGING" ]; then
    case "$STAGING" in
      "$G"/cases/*/.expected.staging) [ -d "$STAGING" ] && [ ! -L "$STAGING" ] && rm -rf -- "$STAGING" ;;
    esac
  fi
  if [ "$rc" -eq 0 ]; then
    # Only ever the directory created above, checked again here.
    case "$WORK" in
      */hfcm-golden.??????) [ -d "$WORK" ] && [ ! -L "$WORK" ] && rm -rf -- "$WORK" ;;
    esac
  else
    echo "FAILED (exit $rc). Temp dir kept for inspection: $WORK" >&2
  fi
}
trap on_exit EXIT

# field <json file> <dotted key>: prints one value from a JSON file.
field() {
  "$PY" -I -c 'import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[k]
print(d)' "$1" "$2"
}

# --- pyjson vectors ---------------------------------------------------------------------------------------------
"$PY" -I "$ROOT/scripts/golden/pyjson_vectors.py" "$G/pyjson/inputs.json" > "$WORK/pyjson-expected.json"
mkdir -p "$G/pyjson"
cp -- "$WORK/pyjson-expected.json" "$G/pyjson/expected.json.new"
mv -- "$G/pyjson/expected.json.new" "$G/pyjson/expected.json"
echo "generated pyjson/expected.json"

# --- sync cases -------------------------------------------------------------------------------------------------
for name in sync-fresh sync-registry sync-adopt delete-repo lmstudio-collision; do
  T="$WORK/$name"
  mkdir -p "$T"
  node "$G/build-fixture.mjs" "$G/cases/$name/case.json" "$T/case" > "$T/built.json"
  CASE_DIR="$(field "$T/built.json" dir)"
  HUB="$(field "$T/built.json" env.HF_HUB_CACHE)"
  CFG="$(field "$T/built.json" env.HFHUB_CONFIG)"
  HOME_DIR="$(field "$T/built.json" home)"
  HFHOME="$(field "$T/built.json" env.HF_HOME)"
  # The case's own configured views (its "views" list), one per line.
  mapfile -t VIEWS < <("$PY" -I -c 'import json, sys
for v in json.load(open(sys.argv[1]))["views"]:
    print(v)' "$G/cases/$name/case.json")
  mkdir -p "$T/tmp" "$T/xdg"

  STAGE="$G/cases/$name/.expected.staging"
  EXPECTED="$G/cases/$name/expected"
  if [ -e "$STAGE" ] || [ -L "$STAGE" ]; then
    echo "staging dir already exists: $STAGE (left over from another run? check it, then move it away)" >&2
    exit 1
  fi
  mkdir -- "$STAGE"
  STAGING="$STAGE"

  # cli <step> <args...>: runs hf-xfer, keeps its log as $STAGE/<step>/cli.log and checks what it says.
  cli() {
    local step="$1"; shift
    local view_args=()
    local v
    for v in "${VIEWS[@]}"; do view_args+=(--view "$v"); done
    mkdir -p "$STAGE/$step"
    local log="$STAGE/$step/cli.log"
    if ! env -i PATH="$PATH" LANG="${LANG:-C.UTF-8}" \
        HOME="$HOME_DIR" HF_HOME="$HFHOME" HF_HUB_CACHE="$HUB" HFHUB_CONFIG="$CFG" \
        XDG_CACHE_HOME="$T/xdg" XDG_CONFIG_HOME="$HOME_DIR/.config" TMPDIR="$T/tmp" \
        HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
        HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY= \
        "$HFXFER" "$@" "${view_args[@]}" > "$log" 2>&1; then
      cat "$log" >&2
      echo "hf-xfer $* failed in case $name ($step)" >&2
      exit 1
    fi
    if grep -Eq '^\[(lmstudio|ollama)\] (skipped|aborted|refused)' "$log"; then
      cat "$log" >&2
      echo "hf-xfer skipped, aborted or refused a view in case $name ($step); not a usable fixture" >&2
      exit 1
    fi
    for v in "${VIEWS[@]}"; do
      if ! grep -Eq "^\[$v\] applied:" "$log"; then
        cat "$log" >&2
        echo "hf-xfer did not report '[$v] applied:' in case $name ($step); not a usable fixture" >&2
        exit 1
      fi
    done
  }

  snap() {
    local v root
    for v in "${VIEWS[@]}"; do
      root="$(field "$T/built.json" "$v")"
      "$PY" -I "$ROOT/scripts/golden/list_tree.py" "$root" "$HUB" "$CASE_DIR" "$STAGE/$1/$v"
    done
  }

  cli after-sync sync --execute --offline
  snap after-sync
  case "$name" in
    sync-adopt)
      # Delete the state files (single files), so the second sync must adopt what is already there.
      for v in "${VIEWS[@]}"; do
        VROOT="$(field "$T/built.json" "$v")"
        case "$VROOT" in
          "$WORK"/?*) rm -f -- "$VROOT/.hfhub-state.json" ;;
          *) echo "view root outside the temp dir: '$VROOT'" >&2; exit 1 ;;
        esac
      done
      cli after-adopt sync --execute --offline
      snap after-adopt
      ;;
    delete-repo)
      # A rename, not a delete: the repo folder leaves the hub and the next sync prunes its entries.
      mkdir -p "$CASE_DIR/moved"
      mv -- "$HUB/models--acme--Tiny-GGUF" "$CASE_DIR/moved/"
      cli after-delete sync --execute --offline
      snap after-delete
      ;;
  esac

  # The whole case succeeded: set the old fixtures aside (never deleted), then rename the staged ones into place.
  if [ -e "$EXPECTED" ]; then
    PREV="$G/cases/$name/expected.prev-$(date -u +%Y%m%dT%H%M%SZ)"
    if [ -e "$PREV" ]; then echo "$PREV already exists; run again in a second" >&2; exit 1; fi
    mv -- "$EXPECTED" "$PREV"
    echo "previous fixtures moved to $PREV"
  fi
  mv -- "$STAGE" "$EXPECTED"
  STAGING=""
  echo "generated cases/$name/expected"
done
echo "done. Review 'git status tests/golden', then commit the expected files."
