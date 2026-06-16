#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"
ASSET_NAME="${ASSET_NAME:-codex-otel-plugin.tar.gz}"
INSTALLER_NAME="${INSTALLER_NAME:-install-release.sh}"

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
STAGE_DIR="$DIST_DIR/codex-otel-plugin-$VERSION"

rm -rf "$DIST_DIR"
mkdir -p "$STAGE_DIR"

cp -R \
  "$REPO_ROOT/src" \
  "$REPO_ROOT/scripts" \
  "$REPO_ROOT/test" \
  "$REPO_ROOT/docs" \
  "$REPO_ROOT/package.json" \
  "$REPO_ROOT/package-lock.json" \
  "$REPO_ROOT/README.md" \
  "$REPO_ROOT/AGENTS.md" \
  "$STAGE_DIR/"

tar -czf "$DIST_DIR/$ASSET_NAME" -C "$STAGE_DIR" .
cp "$REPO_ROOT/scripts/install-release.sh" "$DIST_DIR/$INSTALLER_NAME"

sha256sum "$DIST_DIR/$ASSET_NAME" "$DIST_DIR/$INSTALLER_NAME" > "$DIST_DIR/SHA256SUMS"

printf 'Built release assets in %s\n' "$DIST_DIR"
