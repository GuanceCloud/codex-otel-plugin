#!/usr/bin/env bash
set -euo pipefail

REPO="${CODEX_OTEL_REPO:-GuanceCloud/codex-otel-plugin}"
REF="${CODEX_OTEL_VERSION:-${CODEX_OTEL_REF:-latest}}"
RELEASE_ASSET_NAME="${CODEX_OTEL_RELEASE_ASSET_NAME:-codex-otel-plugin.tar.gz}"

latest_release_api_url() {
  printf 'https://api.github.com/repos/%s/releases/latest' "$REPO"
}

resolve_release_ref() {
  local ref="$1"
  if [[ "$ref" != "latest" ]]; then
    printf '%s' "$ref"
    return 0
  fi

  local api_url="${CODEX_OTEL_RELEASE_API_URL:-$(latest_release_api_url)}"
  local response
  local tag
  response="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api_url")"
  tag="$(printf '%s' "$response" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [[ -z "$tag" ]]; then
    echo "Failed to resolve latest release tag from $api_url" >&2
    exit 1
  fi
  printf '%s' "$tag"
}

release_archive_url() {
  local ref="$1"
  printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "$ref" "$RELEASE_ASSET_NAME"
}

RESOLVED_REF="${REF}"
ARCHIVE_URL="${CODEX_OTEL_ARCHIVE_URL:-}"

case "${1:-}" in
  -h|--help)
    cat <<HELP
Usage:
  install-release.sh [latest|vX.Y.Z|X.Y.Z] [install options]

Examples:
  curl -fsSL <installer-url> | bash -s -- latest --endpoint https://llm-openway.guance.com --x-token <token>
  curl -fsSL <installer-url> | bash -s -- v0.1.1 --no-config

Install options are passed to scripts/install.sh:
  --type gtrace|otlp
  --endpoint URL
  --x-token TOKEN
  --trace-path PATH
  --header KEY=VALUE
  --tag KEY=VALUE
  --config-file PATH
  --codex-config PATH
  --no-config

Environment variables:
  CODEX_OTEL_REPO         GitHub repo. Default: GuanceCloud/codex-otel-plugin
  CODEX_OTEL_VERSION      Release version. Default: latest
  CODEX_OTEL_RELEASE_ASSET_NAME  Release asset name. Default: codex-otel-plugin.tar.gz
  CODEX_OTEL_RELEASE_API_URL     Override latest-release API endpoint.
  CODEX_OTEL_ARCHIVE_URL  Full release tar.gz URL override.
  CODEX_OTEL_NODE         Node.js executable path when node is not in PATH.
HELP
    exit 0
    ;;
esac

if [[ "$#" -gt 0 && "$1" != --* ]]; then
  case "$1" in
    latest)
      REF="latest"
      ;;
    v*)
      REF="$1"
      ;;
    *)
      REF="v$1"
      ;;
  esac
  shift
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

resolve_node() {
  local candidate
  if [[ -n "${CODEX_OTEL_NODE:-}" ]]; then
    if [[ -x "$CODEX_OTEL_NODE" ]]; then
      printf '%s' "$CODEX_OTEL_NODE"
      return 0
    fi
    echo "CODEX_OTEL_NODE is not executable: $CODEX_OTEL_NODE" >&2
    exit 1
  fi

  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.volta/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  cat >&2 <<'EOF'
Missing required command: node

codex-otel-plugin requires Node.js >= 22 because the Codex Stop hook runs as a Node.js script.

Fix options:
  1. Install Node.js 22+ and retry.
  2. If Node is already installed but not in PATH, run:
     CODEX_OTEL_NODE=/path/to/node bash -s -- latest ...
EOF
  exit 1
}

check_node_version() {
  local node_bin="$1"
  local major
  major="$("$node_bin" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  if [[ -z "$major" || "$major" -lt 22 ]]; then
    echo "Node.js >= 22 is required. Found: $("$node_bin" -v 2>/dev/null || echo unknown) at $node_bin" >&2
    exit 1
  fi
}

need curl
need tar
need gzip
if [[ -z "$ARCHIVE_URL" ]]; then
  RESOLVED_REF="$(resolve_release_ref "$REF")"
  ARCHIVE_URL="$(release_archive_url "$RESOLVED_REF")"
else
  RESOLVED_REF="$REF"
fi
NODE_BIN="$(resolve_node)"
check_node_version "$NODE_BIN"
export CODEX_OTEL_NODE="$NODE_BIN"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/repo"
echo "Downloading $ARCHIVE_URL"
curl -fsSL "$ARCHIVE_URL" | tar -xz --strip-components=1 -C "$TMP_DIR/repo"

echo "Installing plugin from temporary archive"
bash "$TMP_DIR/repo/scripts/install.sh" --refresh "$@"
