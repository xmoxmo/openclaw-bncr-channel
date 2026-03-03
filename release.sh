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
