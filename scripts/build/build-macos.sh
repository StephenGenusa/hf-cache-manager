#!/usr/bin/env bash
# Release build for macOS, run on a Mac (Apple Silicon or Intel):
#
#   scripts/build/build-macos.sh [--e2e] [--skip-checks] [--arch arm64|x64|both]
#
# Checks the tools and the signing credentials, installs exactly what package-lock.json names (npm ci), runs lint,
# the type check and the unit tests, and builds a .dmg and a .zip for each architecture (both by default) into dist/,
# then prints where they are, with sizes and SHA-256.
#
# Signing: with a "Developer ID Application" certificate in the keychain (or CSC_LINK and CSC_KEY_PASSWORD) the app is
# signed; with notarization credentials as well (APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER; or APPLE_ID,
# APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID; or APPLE_KEYCHAIN_PROFILE) it is notarized too. Without a certificate
# the app is ad-hoc signed only (it runs, but Gatekeeper warns on first open).
#
#   --e2e          also run the end-to-end suite against the build (npm run e2e).
#   --skip-checks  skip lint, the type check and the unit tests (not for a release).
#   --arch         build one architecture only.
set -euo pipefail

e2e=0
checks=1
arch=both
while [ $# -gt 0 ]; do
  case "$1" in
    --e2e) e2e=1 ;;
    --skip-checks) checks=0 ;;
    --arch)
      [ $# -ge 2 ] || { echo "--arch needs arm64, x64 or both" >&2; exit 2; }
      arch="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $1 (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done
case "$arch" in
  arm64) arch_flags=(--arm64) ;;
  x64) arch_flags=(--x64) ;;
  both) arch_flags=(--x64 --arm64) ;;
  *) echo "--arch must be arm64, x64 or both, not $arch" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf 'build-macos: %s\n' "$*" >&2
  exit 1
}

step "Checking prerequisites"
[ "$(uname -s)" = "Darwin" ] || fail "this script runs on macOS (a .dmg needs hdiutil); on Linux, npm run build:mac makes an unsigned x64 zip"
for tool in node npm xcrun hdiutil codesign security; do
  command -v "$tool" >/dev/null || fail "$tool is missing (Node.js from nodejs.org; the others come with the Xcode Command Line Tools: xcode-select --install)"
done
node scripts/build/check-node.mjs || exit 1
echo "npm $(npm --version)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "note: the working tree has uncommitted changes; they go into this build"
fi
version="$(node -p "require('./package.json').version")"
echo "Building HF Cache Manager $version for macOS ($arch)"

# Signing and notarization: what is there decides what is made.
sign_flags=()
if [ -n "${CSC_LINK:-}" ] || security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  signed=1
  echo "Signing: a Developer ID Application certificate was found; the app will be signed"
  if { [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; } ||
    { [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; } ||
    [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
    echo "Notarization: credentials found; the app will be notarized (this takes a few minutes)"
  else
    echo "Notarization: no credentials; the app is signed but not notarized, and Gatekeeper still warns on first open"
  fi
else
  signed=0
  echo "Signing: no Developer ID Application certificate and no CSC_LINK."
  echo "  Building UNSIGNED (ad-hoc signed, so it runs on Apple Silicon). Gatekeeper refuses it on first open:"
  echo "  right-click the app and choose Open, or run"
  echo "  xattr -dr com.apple.quarantine \"/Applications/HF Cache Manager.app\""
  # "-" is electron-builder's ad-hoc identity; the hardened runtime and notarization are for Developer ID builds only.
  sign_flags=(-c.mac.identity=- -c.mac.hardenedRuntime=false -c.mac.notarize=false)
fi

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

step "Building the app (npm run build)"
npm run build

step "Packaging: dmg and zip (${arch_flags[*]})"
npx --no-install electron-builder --mac dmg zip "${arch_flags[@]}" ${sign_flags[@]+"${sign_flags[@]}"}

if [ "$e2e" = 1 ]; then
  step "End-to-end tests (npm run e2e)"
  npm run e2e
fi

step "Artifacts"
shopt -s nullglob
found=0
for f in dist/*"$version"*.dmg dist/*"$version"*-mac.zip; do
  found=1
  size="$(stat -f %z "$f" | awk '{ printf "%.1f MB", $1 / 1048576 }')"
  sum="$(shasum -a 256 "$f" | cut -d' ' -f1)"
  printf '  %s  %s\n  sha256 %s\n' "$root/$f" "$size" "$sum"
done
[ "$found" = 1 ] || fail "no dmg or zip for $version in dist/"
if [ "$signed" = 0 ]; then
  echo
  echo "These builds are not signed with a Developer ID; see the Signing note above."
fi
