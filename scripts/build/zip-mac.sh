#!/usr/bin/env bash
# Zips the macOS app built on Linux, keeping its symlinks (the last step of npm run build:mac).
#
# electron-builder keeps symlinks in a mac zip only when it runs on a Mac. Elsewhere it zips with 7-Zip, which follows
# them: Electron Framework.framework's `Versions/Current` and its top-level links each become a full copy (a bundle
# three times the size that codesign rejects). So build:mac asks electron-builder for the unpacked app (`--mac dir`)
# and this zips it with Info-ZIP's `zip -y`, which stores a symlink as a symlink.
#
# Output: dist/<name>-<version>-mac-x64.zip, the name electron-builder.yml gives a Mac-built zip (a Linux cross-build
# is x64 only). An existing zip of that name is never replaced: remove it first. scripts/build/build-macos.sh, on a
# Mac, still lets electron-builder zip.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"
product="$(sed -n 's/^productName:[[:space:]]*//p' electron-builder.yml)"
[ -n "$product" ] || { echo "zip-mac: electron-builder.yml has no productName" >&2; exit 1; }
app="dist/mac/$product.app"
zip="$root/dist/$name-$version-mac-x64.zip"

[ -d "$app" ] || { echo "zip-mac: $app is missing; run electron-builder --mac dir first" >&2; exit 1; }
command -v zip >/dev/null || { echo "zip-mac: Info-ZIP zip is not installed (apt install zip)" >&2; exit 1; }
[ ! -e "$zip" ] || { echo "zip-mac: $zip already exists; remove it to build it again" >&2; exit 1; }

# -r recurse, -y store symlinks as links, -X no extra file attributes, -q quiet
(cd dist/mac && zip -qryX "$zip" "$product.app")
echo "zip-mac: $zip"
