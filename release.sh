#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./release.sh            # uses package.json version
#   ./release.sh 0.2.2      # bumps to provided version before publish

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PKG_DIR"

if [[ $# -gt 0 ]]; then
  NEW_VERSION="$1"
  echo "[release] bump version -> $NEW_VERSION"
  npm version "$NEW_VERSION" --no-git-tag-version
fi

PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"

IFS='.' read -r VERSION_MAJOR VERSION_MINOR VERSION_PATCH <<<"$PKG_VERSION"
if [[ ! "$PKG_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[release] invalid version format: $PKG_VERSION (expected x.y.z)" >&2
  exit 1
fi
if (( VERSION_PATCH > 9 )); then
  echo "[release] invalid version policy: patch=$VERSION_PATCH is not allowed; bump minor instead (example: 0.1.9 -> 0.2.0)" >&2
  exit 1
fi

echo "[release] package: $PKG_NAME@$PKG_VERSION"

echo "[release] check npm login"
npm whoami >/dev/null
echo "[release] npm login ok"

echo "[release] dry-run pack"
npm pack --dry-run

echo "[release] publish"
npm publish --access public

echo "[release] done: $PKG_NAME@$PKG_VERSION"

echo "[release] suggested git tag: v$PKG_VERSION"
