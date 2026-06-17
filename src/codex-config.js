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

function parseResourceAttributes(value) {
  const parsed = parseMetadata(value);
  if (!parsed) return undefined;
  const attributes = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (!key || item === undefined || item === null || item === "") continue;
    if (["string", "number", "boolean"].includes(typeof item)) attributes[key] = item;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function tagsToResourceAttributes(tags = []) {
  const attributes = {};
  for (const tag of tags) {
    const [key, ...rest] = String(tag).split("=");
    if (!key || rest.length === 0) continue;
    const value = rest.join("=").trim();
    if (value) attributes[key.trim()] = value;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
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
  const globalConfig = readJsonIfExists(path.join(home, ".codex", "gtrace.json"));
  const localConfig = readJsonIfExists(path.join(cwd, ".codex", "gtrace.json"));
  const merged = {
    enabled: false,
    endpoint: undefined,
    tracePath: "api/public/otel/v1/traces",
    metricsPath: "api/public/otel/v1/metrics",
    max_chars: 20_000,
    debug: false,
    fail_on_error: false,
    ...globalConfig,
    ...localConfig,
  };

  const tags = parseTags(merged.tags);
  const configuredResourceAttributes = parseResourceAttributes(merged.resourceAttributes);

  return {
    ...merged,
    enabled: parseBoolean(merged.enabled) ?? false,
    public_key: merged.public_key,
    secret_key: merged.secret_key,
    endpoint: normalizeEndpoint(merged.endpoint ?? merged.base_url),
    base_url: normalizeEndpoint(merged.base_url),
    tracePath: normalizeSignalPath(
      merged.tracePath,
      "api/public/otel/v1/traces",
    ),
    metricsPath: normalizeSignalPath(
      merged.metricsPath,
      "api/public/otel/v1/metrics",
    ),
    otel_traces_url: merged.otel_traces_url,
    otel_metrics_url: merged.otel_metrics_url,
    protocol: "http/protobuf",
    headers: parseHeaders(merged.headers),
    environment: merged.environment,
    user_id: merged.user_id,
    tags,
    metadata: parseMetadata(merged.metadata),
    resourceAttributes: {
      ...(tagsToResourceAttributes(tags) ?? {}),
      ...(configuredResourceAttributes ?? {}),
    },
    max_chars: parseInteger(merged.max_chars) ?? 20_000,
    debug: parseBoolean(merged.debug) ?? false,
    fail_on_error: parseBoolean(merged.fail_on_error) ?? false,
    hook_log_file: merged.hook_log_file ?? path.join(home, ".codex", "gtrace-hook.log"),
  };
}
