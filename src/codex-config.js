import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Fall through to comma-separated parsing.
    }
  }
  return trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseMetadata(value) {
  if (!value) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEndpoint(endpoint) {
  const trimmed = typeof endpoint === "string" ? endpoint.trim() : "";
  return trimmed ? trimmed.replace(/\/+$/, "") : "http://localhost:3030";
}

function normalizeSignalPath(value, fallback) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.replace(/^\/+/, "").replace(/\/+$/, "") : fallback;
}

function parseHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item.trim()) headers[key] = item.trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function resolveConfig(options = {}) {
  const home = options.home ?? process.env.HOME ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const globalConfig = readJsonIfExists(path.join(home, ".codex", "gtrace.json"));
  const localConfig = readJsonIfExists(path.join(cwd, ".codex", "gtrace.json"));
  const merged = {
    enabled: false,
    endpoint: undefined,
    tracePath: "api/public/otel/v1/traces",
    max_chars: 20_000,
    debug: false,
    fail_on_error: false,
    ...globalConfig,
    ...localConfig,
  };

  return {
    ...merged,
    enabled: parseBoolean(env.TRACE_TO_GTRACE) ?? parseBoolean(env.GTRACE_CODEX_ENABLED) ?? merged.enabled,
    public_key: env.GTRACE_PUBLIC_KEY ?? env.GTRACE_CODEX_PUBLIC_KEY ?? merged.public_key,
    secret_key: env.GTRACE_SECRET_KEY ?? env.GTRACE_CODEX_SECRET_KEY ?? merged.secret_key,
    endpoint: normalizeEndpoint(
      env.GTRACE_ENDPOINT ??
        env.GTRACE_CODEX_ENDPOINT ??
        merged.endpoint ??
        merged.base_url,
    ),
    base_url: normalizeEndpoint(env.GTRACE_BASE_URL ?? env.GTRACE_CODEX_BASE_URL ?? merged.base_url),
    tracePath: normalizeSignalPath(
      env.GTRACE_TRACE_PATH ?? env.GTRACE_CODEX_TRACE_PATH ?? merged.tracePath,
      "api/public/otel/v1/traces",
    ),
    otel_traces_url:
      env.GTRACE_OTEL_TRACES_URL ?? env.GTRACE_CODEX_OTEL_TRACES_URL ?? merged.otel_traces_url,
    protocol: "http/protobuf",
    headers: parseHeaders(merged.headers),
    environment: env.GTRACE_ENVIRONMENT ?? env.GTRACE_CODEX_ENVIRONMENT ?? merged.environment,
    user_id: env.GTRACE_CODEX_USER_ID ?? merged.user_id,
    tags: parseTags(env.GTRACE_CODEX_TAGS) ?? parseTags(merged.tags),
    metadata: parseMetadata(env.GTRACE_CODEX_METADATA) ?? parseMetadata(merged.metadata),
    max_chars: parseInteger(env.GTRACE_CODEX_MAX_CHARS) ?? parseInteger(merged.max_chars) ?? 20_000,
    debug: parseBoolean(env.GTRACE_CODEX_DEBUG) ?? parseBoolean(merged.debug) ?? false,
    fail_on_error:
      parseBoolean(env.GTRACE_CODEX_FAIL_ON_ERROR) ?? parseBoolean(merged.fail_on_error) ?? false,
    hook_log_file:
      env.GTRACE_CODEX_HOOK_LOG_FILE ?? merged.hook_log_file ?? path.join(home, ".codex", "gtrace-hook.log"),
  };
}
