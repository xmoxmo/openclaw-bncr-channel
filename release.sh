#!/usr/bin/env bash
set -euo pipefail

# ⚠️ DEPRECATED (2026-08-31)：npm 发布已切换为 GitHub Actions OIDC Trusted Publishing。
# 正确路径：在 exports/bncr-public 提交并推送 main + tag，npm 由 OIDC 自动发布
# （见 /root/.openclaw/workspace/memory/docs/bncr/bncr-release-flow.md 第 5–7 步）。
# 本脚本依赖已废弃的本地 npm token 方案，保留仅作历史参考。
if [[ "${ALLOW_DEPRECATED_RELEASE:-0}" != "1" ]]; then
  cat >&2 <<'EOF'
[release] ⛔ DEPRECATED: 不要再使用 ./release.sh 发布。
[release]    正确流程：exports/bncr-public 推 main + tag → GitHub Actions OIDC 自动 npm publish。
[release]    文档：memory/docs/bncr/bncr-release-flow.md（第 5–7 步）
[release]    如确需临时启用旧路径：ALLOW_DEPRECATED_RELEASE=1 ./release.sh ...
EOF
  exit 1
fi

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

echo "[release] check release version policy"
npm run selfcheck:release

echo "[release] dry-run pack"
npm pack --dry-run

echo "[release] publish"
npm publish --access public

echo "[release] done: $PKG_NAME@$PKG_VERSION"

echo "[release] suggested git tag: v$PKG_VERSION"
