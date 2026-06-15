#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG_FILE="${CODEX_CONFIG_FILE:-$CODEX_HOME/config.toml}"
CONFIG_FILE="${GTRACE_CONFIG_FILE:-$CODEX_HOME/gtrace.json}"
MARKETPLACE_NAME="${MARKETPLACE_NAME:-codex-otel-plugin}"
PLUGIN_NAME="${PLUGIN_NAME:-tracing}"
MARKETPLACE_ROOT="${MARKETPLACE_ROOT:-$CODEX_HOME/$MARKETPLACE_NAME}"
PLUGIN_ROOT="$MARKETPLACE_ROOT/plugins/$PLUGIN_NAME"
REFRESH=false
WRITE_CONFIG=1
INSTALL_TYPE="${CODEX_OTEL_INSTALL_TYPE:-gtrace}"
ENDPOINT="${GTRACE_ENDPOINT:-${CODEX_OTEL_ENDPOINT:-}}"
TRACE_PATH="${GTRACE_TRACE_PATH:-${CODEX_OTEL_TRACE_PATH:-}}"
X_TOKEN="${GTRACE_X_TOKEN:-${X_TOKEN:-}}"
DEBUG="${GTRACE_CODEX_DEBUG:-true}"
TAGS=()
HEADERS=()
TRACE_PATH_EXPLICIT=0

if [[ -n "$TRACE_PATH" ]]; then
  TRACE_PATH_EXPLICIT=1
fi

log() {
  printf '[install] %s\n' "$1"
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
     CODEX_OTEL_NODE=/path/to/node scripts/install.sh ...
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

usage() {
  cat <<HELP
Usage:
  scripts/install.sh [--refresh] [--type gtrace|otlp] [--endpoint URL] [--x-token TOKEN] [--trace-path PATH] [--tag KEY=VALUE] [--no-config]

Options:
  --refresh        Remove and re-add the installed plugin cache through Codex CLI.
  --type           Config preset. Default: gtrace. Values: gtrace, otlp.
  --endpoint       Receiver base URL, for example https://llm-openway.guance.com.
  --x-token        Dataway/GTrace X-Token. The value is written to gtrace.json and never printed.
  --trace-path     Trace route. Defaults to v1/write/otel-llm for gtrace and v1/traces for otlp.
  --header         Extra HTTP header as KEY=VALUE. Can be repeated.
  --tag            Metadata tag as KEY=VALUE. Can be repeated.
  --config-file    Config file. Default: $CODEX_HOME/gtrace.json.
  --codex-config   Codex config file. Default: $CODEX_HOME/config.toml.
  --no-config      Install plugin files only; do not create or update gtrace.json.

Environment variables:
  CODEX_HOME              Codex home. Default: ~/.codex
  CODEX_OTEL_ENDPOINT     Same as --endpoint
  GTRACE_ENDPOINT         Same as --endpoint
  CODEX_OTEL_TRACE_PATH   Same as --trace-path
  GTRACE_TRACE_PATH       Same as --trace-path
  GTRACE_X_TOKEN          Same as --x-token
  X_TOKEN                 Same as --x-token
  CODEX_OTEL_NODE         Node.js executable path when node is not in PATH
  GTRACE_CONFIG_FILE      Same as --config-file
  CODEX_CONFIG_FILE       Same as --codex-config
HELP
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --refresh|--reinstall)
      REFRESH=true
      ;;
    --no-config)
      WRITE_CONFIG=0
      ;;
    --type)
      shift
      [[ "$#" -gt 0 ]] || { echo "--type requires a value" >&2; exit 2; }
      INSTALL_TYPE="$1"
      ;;
    --type=*)
      INSTALL_TYPE="${1#*=}"
      ;;
    --endpoint)
      shift
      [[ "$#" -gt 0 ]] || { echo "--endpoint requires a URL" >&2; exit 2; }
      ENDPOINT="$1"
      ;;
    --endpoint=*)
      ENDPOINT="${1#*=}"
      ;;
    --trace-path)
      shift
      [[ "$#" -gt 0 ]] || { echo "--trace-path requires a path" >&2; exit 2; }
      TRACE_PATH="$1"
      TRACE_PATH_EXPLICIT=1
      ;;
    --trace-path=*)
      TRACE_PATH="${1#*=}"
      TRACE_PATH_EXPLICIT=1
      ;;
    --x-token)
      shift
      [[ "$#" -gt 0 ]] || { echo "--x-token requires a token" >&2; exit 2; }
      X_TOKEN="$1"
      ;;
    --x-token=*)
      X_TOKEN="${1#*=}"
      ;;
    --header)
      shift
      [[ "$#" -gt 0 ]] || { echo "--header requires KEY=VALUE" >&2; exit 2; }
      HEADERS+=("$1")
      ;;
    --header=*)
      HEADERS+=("${1#*=}")
      ;;
    --tag)
      shift
      [[ "$#" -gt 0 ]] || { echo "--tag requires KEY=VALUE" >&2; exit 2; }
      TAGS+=("$1")
      ;;
    --tag=*)
      TAGS+=("${1#*=}")
      ;;
    --config-file)
      shift
      [[ "$#" -gt 0 ]] || { echo "--config-file requires a path" >&2; exit 2; }
      CONFIG_FILE="$1"
      ;;
    --config-file=*)
      CONFIG_FILE="${1#*=}"
      ;;
    --codex-config)
      shift
      [[ "$#" -gt 0 ]] || { echo "--codex-config requires a path" >&2; exit 2; }
      CODEX_CONFIG_FILE="$1"
      ;;
    --codex-config=*)
      CODEX_CONFIG_FILE="${1#*=}"
      ;;
    --debug)
      DEBUG=true
      ;;
    --no-debug)
      DEBUG=false
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ! -f "$REPO_ROOT/src/codex-hook-wrapper.js" ]]; then
  echo "Cannot find src/codex-hook-wrapper.js under $REPO_ROOT" >&2
  exit 1
fi

NODE_BIN="$(resolve_node)"
check_node_version "$NODE_BIN"

case "$INSTALL_TYPE" in
  gtrace|otlp|otel)
    ;;
  *)
    echo "Unsupported --type: $INSTALL_TYPE. Supported values: gtrace, otlp" >&2
    exit 2
    ;;
esac
if [[ "$INSTALL_TYPE" == "otel" ]]; then
  INSTALL_TYPE="otlp"
fi

if [[ -z "$TRACE_PATH" && ( -n "$ENDPOINT" || ! -f "$CONFIG_FILE" || "$TRACE_PATH_EXPLICIT" -eq 1 ) ]]; then
  if [[ "$INSTALL_TYPE" == "gtrace" ]]; then
    TRACE_PATH="v1/write/otel-llm"
  else
    TRACE_PATH="v1/traces"
  fi
fi

VERSION="$("$NODE_BIN" -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || printf '0.1.0')"
CACHE_PLUGIN_ROOT="$CODEX_HOME/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION"
CACHE_HOOK_SCRIPT="$CACHE_PLUGIN_ROOT/src/codex-hook-wrapper.js"
HOOK_COMMAND="$NODE_BIN $CACHE_HOOK_SCRIPT"

mkdir -p "$PLUGIN_ROOT/.codex-plugin" "$PLUGIN_ROOT/hooks" "$MARKETPLACE_ROOT/.agents/plugins"

cleanup_legacy_marketplace_runtime() {
  if [[ "$MARKETPLACE_ROOT" == "$REPO_ROOT" ]]; then
    return
  fi
  rm -rf \
    "$MARKETPLACE_ROOT/src" \
    "$MARKETPLACE_ROOT/scripts" \
    "$MARKETPLACE_ROOT/test" \
    "$MARKETPLACE_ROOT/docs" \
    "$MARKETPLACE_ROOT/README.md" \
    "$MARKETPLACE_ROOT/AGENTS.md" \
    "$MARKETPLACE_ROOT/package.json" \
    "$MARKETPLACE_ROOT/package-lock.json"
}

cleanup_legacy_marketplace_runtime

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

sync_plugin_cache() {
  mkdir -p "$(dirname "$CACHE_PLUGIN_ROOT")"
  rm -rf "$CACHE_PLUGIN_ROOT"
  mkdir -p "$CACHE_PLUGIN_ROOT"
  cp -R "$PLUGIN_ROOT/." "$CACHE_PLUGIN_ROOT/"
  cp -R "$REPO_ROOT/src" "$CACHE_PLUGIN_ROOT/src"
  cp "$REPO_ROOT/package.json" "$CACHE_PLUGIN_ROOT/package.json"
  if [[ -f "$REPO_ROOT/package-lock.json" ]]; then
    cp "$REPO_ROOT/package-lock.json" "$CACHE_PLUGIN_ROOT/package-lock.json"
  fi
  log "updated plugin cache: $CACHE_PLUGIN_ROOT"
}

write_codex_config() {
  CODEX_CONFIG_FILE_RUNTIME="$CODEX_CONFIG_FILE" \
  CODEX_MARKETPLACE_NAME_RUNTIME="$MARKETPLACE_NAME" \
  CODEX_MARKETPLACE_ROOT_RUNTIME="$MARKETPLACE_ROOT" \
  CODEX_PLUGIN_SELECTOR_RUNTIME="$PLUGIN_NAME@$MARKETPLACE_NAME" \
  "$NODE_BIN" <<'NODE'
const fs = require("fs");
const path = require("path");

const configFile = process.env.CODEX_CONFIG_FILE_RUNTIME;
const marketplaceName = process.env.CODEX_MARKETPLACE_NAME_RUNTIME;
const marketplaceRoot = process.env.CODEX_MARKETPLACE_ROOT_RUNTIME;
const pluginSelector = process.env.CODEX_PLUGIN_SELECTOR_RUNTIME;

function tomlString(value) {
  return JSON.stringify(String(value));
}

function removeSection(source, header) {
  const lines = source.split(/\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]/.test(trimmed)) {
      skipping = trimmed === header;
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

fs.mkdirSync(path.dirname(configFile), { recursive: true });
let content = "";
if (fs.existsSync(configFile)) {
  content = fs.readFileSync(configFile, "utf8");
}

const marketplaceHeader = `[marketplaces.${marketplaceName}]`;
const quotedMarketplaceHeader = `[marketplaces.${tomlString(marketplaceName)}]`;
const pluginHeader = `[plugins.${tomlString(pluginSelector)}]`;
content = removeSection(content, marketplaceHeader);
content = removeSection(content, quotedMarketplaceHeader);
content = removeSection(content, pluginHeader);

const nextSections = [
  `${marketplaceHeader}
source_type = "local"
source = ${tomlString(marketplaceRoot)}`,
  `${pluginHeader}
enabled = true`,
];

const next = `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${nextSections.join("\n\n")}\n`;
fs.writeFileSync(configFile, next, "utf8");
NODE
}

sync_plugin_cache
write_codex_config
log "updated Codex config: $CODEX_CONFIG_FILE"

write_config() {
  local tags_json='[]'
  local headers_json='[]'
  if [[ "${#TAGS[@]}" -gt 0 ]]; then
    tags_json="$(printf '%s\n' "${TAGS[@]}" | "$NODE_BIN" -e 'const fs=require("fs"); const lines=fs.readFileSync(0,"utf8").split(/\n/).map(s=>s.trim()).filter(Boolean); process.stdout.write(JSON.stringify(lines));')"
  fi
  if [[ "${#HEADERS[@]}" -gt 0 ]]; then
    headers_json="$(printf '%s\n' "${HEADERS[@]}" | "$NODE_BIN" -e 'const fs=require("fs"); const lines=fs.readFileSync(0,"utf8").split(/\n/).map(s=>s.trim()).filter(Boolean); process.stdout.write(JSON.stringify(lines));')"
  fi

  GTRACE_CONFIG_FILE_RUNTIME="$CONFIG_FILE" \
  GTRACE_ENDPOINT_RUNTIME="$ENDPOINT" \
  GTRACE_TRACE_PATH_RUNTIME="$TRACE_PATH" \
  GTRACE_INSTALL_TYPE_RUNTIME="$INSTALL_TYPE" \
  GTRACE_X_TOKEN_RUNTIME="$X_TOKEN" \
  GTRACE_DEBUG_RUNTIME="$DEBUG" \
  GTRACE_TAGS_RUNTIME="$tags_json" \
  GTRACE_HEADERS_RUNTIME="$headers_json" \
  "$NODE_BIN" <<'NODE'
const fs = require("fs");
const path = require("path");

const configFile = process.env.GTRACE_CONFIG_FILE_RUNTIME;
const endpoint = process.env.GTRACE_ENDPOINT_RUNTIME || "";
const tracePath = process.env.GTRACE_TRACE_PATH_RUNTIME || "";
const installType = process.env.GTRACE_INSTALL_TYPE_RUNTIME || "gtrace";
const xToken = process.env.GTRACE_X_TOKEN_RUNTIME || "";
const debug = process.env.GTRACE_DEBUG_RUNTIME !== "false";
const tags = JSON.parse(process.env.GTRACE_TAGS_RUNTIME || "[]");
const extraHeaders = JSON.parse(process.env.GTRACE_HEADERS_RUNTIME || "[]");

let config = {};
if (fs.existsSync(configFile)) {
  const raw = fs.readFileSync(configFile, "utf8").trim();
  if (raw) config = JSON.parse(raw);
}

config.enabled = true;
if (endpoint) config.endpoint = endpoint;
if (tracePath) config.tracePath = tracePath;
config.debug = debug;
config.headers = config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
  ? config.headers
  : {};

if (installType === "gtrace") {
  config.headers["To-Headless"] ??= "true";
}
if (xToken) {
  config.headers["X-Token"] = xToken;
}
for (const header of extraHeaders) {
  const [key, ...rest] = String(header).split("=");
  if (!key || rest.length === 0) continue;
  config.headers[key] = rest.join("=");
}
if (Object.keys(config.headers).length === 0) {
  delete config.headers;
}

config.tags = Array.isArray(config.tags) ? config.tags : [];
config.metadata = config.metadata && typeof config.metadata === "object" && !Array.isArray(config.metadata)
  ? config.metadata
  : {};
for (const tag of tags) {
  const [key, ...rest] = String(tag).split("=");
  if (!key || rest.length === 0) continue;
  const value = rest.join("=");
  if (!config.tags.includes(tag)) config.tags.push(tag);
  config.metadata[key] = value;
}
if (config.tags.length === 0) delete config.tags;
if (Object.keys(config.metadata).length === 0) delete config.metadata;

fs.mkdirSync(path.dirname(configFile), { recursive: true });
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}

if [[ "$WRITE_CONFIG" -eq 1 ]]; then
  if [[ -n "$ENDPOINT" || -f "$CONFIG_FILE" ]]; then
    write_config
    log "updated $CONFIG_FILE"
    if [[ -n "$ENDPOINT" ]]; then
      log "configured endpoint: $ENDPOINT"
    fi
    log "configured trace path: $TRACE_PATH"
    if [[ -n "$X_TOKEN" ]]; then
      log "configured X-Token: <redacted>"
    fi
  else
    log "skipped config because --endpoint was not provided"
  fi
else
  log "skipped config because --no-config was set"
fi

if ! command -v codex >/dev/null 2>&1; then
  cat <<EOF

Codex CLI was not found, so the installer skipped the optional plugin refresh command.
The installer already wrote $CODEX_CONFIG_FILE and synced the plugin cache.

Next steps:
  1. Configure $CONFIG_FILE if it was not written by this installer
  2. Restart Codex so the Stop hook is reloaded
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
The installer already wrote $CODEX_CONFIG_FILE and synced the plugin cache.
If Codex still does not load the plugin after restart, run this to refresh the cache:
  codex plugin remove "$PLUGIN_NAME@$MARKETPLACE_NAME"
  codex plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME"
EOF
fi

cat <<EOF

Next steps:
  1. Configure $CONFIG_FILE if it was not written by this installer
  2. Restart Codex so the Stop hook is reloaded
EOF
