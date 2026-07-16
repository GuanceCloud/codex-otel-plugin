import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

function removeSectionsMatching(source, predicate) {
  const lines = source.split(/\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]/.test(trimmed)) {
      skipping = predicate(trimmed);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function writeCodexConfig(options) {
  const {
    configFile,
    marketplaceName,
    marketplaceRoot,
    pluginSelector,
    conflictingPluginSelectors = [],
  } = options;

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  let content = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";

  const marketplaceHeader = `[marketplaces.${marketplaceName}]`;
  const quotedMarketplaceHeader = `[marketplaces.${tomlString(marketplaceName)}]`;
  const pluginHeader = `[plugins.${tomlString(pluginSelector)}]`;
  content = removeSection(content, marketplaceHeader);
  content = removeSection(content, quotedMarketplaceHeader);
  content = removeSection(content, pluginHeader);
  for (const selector of conflictingPluginSelectors) {
    content = removeSection(content, `[plugins.${tomlString(selector)}]`);
    const hookStatePrefix = `[hooks.state.${tomlString(selector).slice(0, -1)}:`;
    content = removeSectionsMatching(content, (header) => header.startsWith(hookStatePrefix));
  }

  const nextSections = [
    `${marketplaceHeader}\nsource_type = "local"\nsource = ${tomlString(marketplaceRoot)}`,
    `${pluginHeader}\nenabled = true`,
  ];
  const next = `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${nextSections.join("\n\n")}\n`;
  fs.writeFileSync(configFile, next, "utf8");
}

export function writeHooksConfig({ hooksFile, command }) {
  let config = {};
  if (fs.existsSync(hooksFile)) {
    const raw = fs.readFileSync(hooksFile, "utf8").trim();
    if (raw) config = JSON.parse(raw);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  const stopGroups = Array.isArray(config.hooks.Stop) ? config.hooks.Stop : [];
  config.hooks.Stop = stopGroups.filter((group) => {
    const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
    return !handlers.some((handler) =>
      typeof handler?.command === "string" && handler.command.includes("codex-hook-wrapper.js")
    );
  });
  config.hooks.Stop.push({
    hooks: [{
      type: "command",
      command,
      timeout: 60,
      statusMessage: "Uploading Codex trace to GTrace",
    }],
  });
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function canonicalHeaderName(key) {
  const normalized = String(key).trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "";
  if (normalized === "to-headless") return "To-Headless";
  if (normalized === "x-token") return "X-Token";
  if (normalized === "authorization") return "Authorization";
  return String(key).trim();
}

function normalizeHeaders(headers) {
  const next = {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return next;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const canonicalKey = canonicalHeaderName(key);
    if (canonicalKey) next[canonicalKey] = value.trim();
  }
  return next;
}

function splitAssignment(value) {
  const [key, ...rest] = String(value).split("=");
  if (!key || rest.length === 0) return undefined;
  return [key.trim(), rest.join("=").trim()];
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function writeGtraceConfig(options) {
  const {
    configFile,
    endpoint = "",
    tracePath = "",
    metricsPath = "",
    installType = "gtrace",
    xToken = "",
    debug = true,
    scriptEnabled,
    tags = [],
    extraHeaders = [],
  } = options;

  let config = {};
  if (fs.existsSync(configFile)) {
    const raw = fs.readFileSync(configFile, "utf8").trim();
    if (raw) config = JSON.parse(raw);
  }

  if (typeof scriptEnabled === "boolean") {
    config.enabled = scriptEnabled;
  } else {
    config.enabled = booleanValue(config.enabled) ?? true;
  }
  if (endpoint) config.endpoint = endpoint;
  if (tracePath) config.tracePath = tracePath;
  if (metricsPath) config.metricsPath = metricsPath;
  config.debug = Boolean(debug);
  config.headers = normalizeHeaders(config.headers);

  if (installType === "gtrace") config.headers["To-Headless"] ??= "true";
  if (xToken) config.headers["X-Token"] = xToken;
  for (const header of extraHeaders) {
    const assignment = splitAssignment(header);
    if (!assignment) continue;
    const canonicalKey = canonicalHeaderName(assignment[0]);
    if (canonicalKey) config.headers[canonicalKey] = assignment[1];
  }
  if (Object.keys(config.headers).length === 0) delete config.headers;

  config.metadata = config.metadata && typeof config.metadata === "object" && !Array.isArray(config.metadata)
    ? config.metadata
    : {};
  config.resourceAttributes = config.resourceAttributes && typeof config.resourceAttributes === "object" && !Array.isArray(config.resourceAttributes)
    ? config.resourceAttributes
    : {};
  if (Array.isArray(config.tags)) {
    for (const tag of config.tags) {
      const assignment = splitAssignment(tag);
      if (assignment && !(assignment[0] in config.resourceAttributes)) {
        config.resourceAttributes[assignment[0]] = assignment[1];
      }
    }
    delete config.tags;
  }
  for (const tag of tags) {
    const assignment = splitAssignment(tag);
    if (!assignment) continue;
    config.resourceAttributes[assignment[0]] = assignment[1];
    if (config.metadata[assignment[0]] === assignment[1]) delete config.metadata[assignment[0]];
  }
  if (Object.keys(config.metadata).length === 0) delete config.metadata;
  if (Object.keys(config.resourceAttributes).length === 0) delete config.resourceAttributes;

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function optionsFromEnvironment(action) {
  if (action === "write-codex-config") {
    return {
      configFile: process.env.CODEX_CONFIG_FILE_RUNTIME,
      marketplaceName: process.env.CODEX_MARKETPLACE_NAME_RUNTIME,
      marketplaceRoot: process.env.CODEX_MARKETPLACE_ROOT_RUNTIME,
      pluginSelector: process.env.CODEX_PLUGIN_SELECTOR_RUNTIME,
      conflictingPluginSelectors: parseJson(process.env.CODEX_CONFLICTING_PLUGIN_SELECTORS_RUNTIME, []),
    };
  }
  if (action === "write-hooks-config") {
    return {
      hooksFile: process.env.CODEX_HOOKS_FILE_RUNTIME,
      command: process.env.CODEX_HOOK_COMMAND_RUNTIME,
    };
  }
  return {
    configFile: process.env.GTRACE_CONFIG_FILE_RUNTIME,
    endpoint: process.env.GTRACE_ENDPOINT_RUNTIME,
    tracePath: process.env.GTRACE_TRACE_PATH_RUNTIME,
    metricsPath: process.env.GTRACE_METRICS_PATH_RUNTIME,
    installType: process.env.GTRACE_INSTALL_TYPE_RUNTIME,
    xToken: process.env.GTRACE_X_TOKEN_RUNTIME,
    debug: process.env.GTRACE_DEBUG_RUNTIME !== "false",
    scriptEnabled: booleanValue(process.env.GTRACE_SCRIPT_ENABLED_RUNTIME),
    tags: parseJson(process.env.GTRACE_TAGS_RUNTIME, []),
    extraHeaders: parseJson(process.env.GTRACE_HEADERS_RUNTIME, []),
  };
}

const action = process.argv[2];
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (action === "write-codex-config") writeCodexConfig(optionsFromEnvironment(action));
  else if (action === "write-hooks-config") writeHooksConfig(optionsFromEnvironment(action));
  else if (action === "write-gtrace-config") writeGtraceConfig(optionsFromEnvironment(action));
  else throw new Error(`Unsupported installer config action: ${action || "<empty>"}`);
}
