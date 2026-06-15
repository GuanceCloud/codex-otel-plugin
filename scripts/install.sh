#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
MARKETPLACE_NAME="${MARKETPLACE_NAME:-gtrace-codex-observe}"
PLUGIN_NAME="${PLUGIN_NAME:-tracing}"
MARKETPLACE_ROOT="${MARKETPLACE_ROOT:-$CODEX_HOME/$MARKETPLACE_NAME}"
PLUGIN_ROOT="$MARKETPLACE_ROOT/plugins/$PLUGIN_NAME"
REFRESH=false

for arg in "$@"; do
  case "$arg" in
    --refresh|--reinstall)
      REFRESH=true
      ;;
    -h|--help)
      cat <<HELP
Usage: scripts/install.sh [--refresh]

Creates the local Codex marketplace and plugin files for:
  $PLUGIN_NAME@$MARKETPLACE_NAME

Options:
  --refresh    Remove and re-add the installed plugin cache through Codex CLI.
HELP
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$REPO_ROOT/src/codex-hook-wrapper.js" ]]; then
  echo "Cannot find src/codex-hook-wrapper.js under $REPO_ROOT" >&2
  exit 1
fi

VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || printf '0.1.0')"
HOOK_COMMAND="node $REPO_ROOT/src/codex-hook-wrapper.js"

mkdir -p "$PLUGIN_ROOT/.codex-plugin" "$PLUGIN_ROOT/hooks" "$MARKETPLACE_ROOT/.agents/plugins"

cat > "$MARKETPLACE_ROOT/.agents/plugins/marketplace.json" <<JSON
{
  "name": "$MARKETPLACE_NAME",
  "interface": {
    "displayName": "gtrace Codex Observe"
  },
  "plugins": [
    {
      "name": "$PLUGIN_NAME",
      "source": {
        "source": "local",
        "path": "./plugins/$PLUGIN_NAME"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Coding"
    }
  ]
}
JSON

cat > "$PLUGIN_ROOT/.codex-plugin/plugin.json" <<JSON
{
  "name": "$PLUGIN_NAME",
  "version": "$VERSION",
  "description": "Trace Codex sessions to GTrace through OTLP.",
  "author": {
    "name": "Guance"
  },
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "GTrace Codex Observe",
    "shortDescription": "Trace Codex sessions to GTrace.",
    "longDescription": "Uploads Codex session traces to GTrace by using OpenTelemetry OTLP Trace HTTP/protobuf.",
    "developerName": "Guance",
    "category": "Coding",
    "capabilities": [
      "Read"
    ],
    "defaultPrompt": []
  }
}
JSON

cat > "$PLUGIN_ROOT/hooks/hooks.json" <<JSON
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_COMMAND",
            "timeout": 30,
            "statusMessage": "Uploading Codex trace to GTrace"
          }
        ]
      }
    ]
  }
}
JSON

echo "Wrote local marketplace: $MARKETPLACE_ROOT"
echo "Wrote plugin: $PLUGIN_ROOT"
echo "Hook command: $HOOK_COMMAND"

if ! command -v codex >/dev/null 2>&1; then
  cat <<EOF

Codex CLI was not found. After Codex is available, run:
  codex plugin marketplace add "$MARKETPLACE_ROOT"
  codex plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME"
EOF
  exit 0
fi

if ! codex plugin marketplace list | awk 'NR > 1 {print $1}' | grep -qx "$MARKETPLACE_NAME"; then
  codex plugin marketplace add "$MARKETPLACE_ROOT"
fi

if [[ "$REFRESH" == true ]]; then
  codex plugin remove "$PLUGIN_NAME@$MARKETPLACE_NAME" >/dev/null 2>&1 || true
fi

if ! codex plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME"; then
  cat <<EOF

Plugin files were written, but Codex CLI did not add the plugin automatically.
If the plugin is already installed, run this to refresh the cache:
  codex plugin remove "$PLUGIN_NAME@$MARKETPLACE_NAME"
  codex plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME"
EOF
fi

cat <<EOF

Next steps:
  1. Configure $CODEX_HOME/gtrace.json
  2. Restart Codex so the Stop hook is reloaded
EOF
