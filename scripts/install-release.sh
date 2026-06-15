#!/usr/bin/env bash
set -euo pipefail

REPO="${CODEX_OTEL_REPO:-GuanceCloud/codex-otel-plugin}"
REF="${CODEX_OTEL_VERSION:-${CODEX_OTEL_REF:-main}}"
INSTALL_DIR="${CODEX_OTEL_INSTALL_DIR:-$HOME/.codex/codex-otel-plugin}"
ARCHIVE_URL="${CODEX_OTEL_ARCHIVE_URL:-https://github.com/$REPO/archive/$REF.tar.gz}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

safe_replace_dir() {
  local src="$1"
  local dest="$2"
  if [[ -z "$dest" || "$dest" == "/" || "$dest" == "$HOME" ]]; then
    echo "Refusing unsafe install dir: $dest" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dest")"
  rm -rf "$dest"
  mv "$src" "$dest"
}

need curl
need tar
need gzip
need node

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/repo"
echo "Downloading $ARCHIVE_URL"
curl -fsSL "$ARCHIVE_URL" | tar -xz --strip-components=1 -C "$TMP_DIR/repo"

safe_replace_dir "$TMP_DIR/repo" "$INSTALL_DIR"

echo "Installed files to $INSTALL_DIR"
bash "$INSTALL_DIR/scripts/install.sh" --refresh
