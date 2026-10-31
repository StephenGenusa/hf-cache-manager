#!/usr/bin/env bash
# Release build for Linux, run on Linux (x64):
#
#   scripts/build/build-linux.sh [--e2e] [--skip-checks]
#
# Checks the tools, installs exactly what package-lock.json names (npm ci), runs lint, the type check and the unit
# tests, builds the AppImage (dist/hf-cache-manager-<version>.AppImage) and prints where it is, with its size and
# SHA-256.
#
#   --e2e          also run the end-to-end suite against the build (npm run e2e; under xvfb-run when installed).
#   --skip-checks  skip lint, the type check and the unit tests (not for a release).
set -euo pipefail

e2e=0
checks=1
for arg in "$@"; do
  case "$arg" in
    --e2e) e2e=1 ;;
    --skip-checks) checks=0 ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf 'build-linux: %s\n' "$*" >&2
  exit 1
}

step "Checking prerequisites"
[ "$(uname -s)" = "Linux" ] || fail "this script builds the Linux release and runs on Linux; use build-macos.sh or build-windows.ps1 elsewhere"
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) fail "the Linux build is x64; this machine is $(uname -m)" ;;
esac
command -v node >/dev/null || fail "Node.js is not installed (see package.json engines)"
command -v npm >/dev/null || fail "npm is not installed"
node scripts/build/check-node.mjs || exit 1
echo "npm $(npm --version)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "note: the working tree has uncommitted changes; they go into this build"
fi
version="$(node -p "require('./package.json').version")"
echo "Building HF Cache Manager $version"

step "Installing dependencies (npm ci)"
npm ci

if [ "$checks" = 1 ]; then
  step "Lint"
  npm run lint
  step "Type check"
  npm run typecheck
  step "Unit tests"
  npm test
fi

step "Building the AppImage (npm run build:linux)"
npm run build:linux

if [ "$e2e" = 1 ]; then
  step "End-to-end tests (npm run e2e)"
  if command -v xvfb-run >/dev/null; then xvfb-run -a npm run e2e; else npm run e2e; fi
fi

step "Artifacts"
shopt -s nullglob
found=0
for f in dist/*-"$version".AppImage; do
  found=1
  # The file's own length (du can count blocks not yet written).
  size="$(stat -c %s "$f" | awk '{ printf "%.1f MB", $1 / 1048576 }')"
  sum="$(sha256sum "$f" | cut -d' ' -f1)"
  printf '  %s  %s\n  sha256 %s\n' "$root/$f" "$size" "$sum"
done
[ "$found" = 1 ] || fail "no AppImage for $version in dist/"
echo "  unpacked app: $root/dist/linux-unpacked"
echo
echo "Run it with: chmod +x <AppImage> && ./<AppImage>"
