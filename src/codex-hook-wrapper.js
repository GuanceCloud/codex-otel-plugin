import * as fs from "node:fs/promises";

import { collectRollout } from "./codex-collector.js";
import { resolveConfig } from "./codex-config.js";
import { codexSpansToOtlpProtobufRequest } from "./codex-otlp.js";
import { markTurnUploaded } from "./codex-sidecar.js";
import { readStdin } from "./codex-utils.js";
import { encodeExportTraceServiceRequest } from "./proto.js";

function resolveOtelUrl(endpoint, path) {
  const normalizedPath = String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalizedPath) return endpoint;
  const endpointWithoutQueryOrFragment = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  const escapedPath = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`/${escapedPath}$`, "i").test(endpointWithoutQueryOrFragment)) return endpoint;
  return `${endpoint}/${normalizedPath}`;
}

function endpoint(config) {
  if (config.otel_traces_url) return config.otel_traces_url;
  return resolveOtelUrl(config.endpoint ?? config.base_url, config.tracePath);
}

function authHeader(config) {
  if (!config.public_key && !config.secret_key) return undefined;
  return `Basic ${Buffer.from(`${config.public_key ?? ""}:${config.secret_key ?? ""}`).toString("base64")}`;
}

async function appendLog(config, message, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    message,
    ...(extra ? { extra } : {}),
  });
  try {
    await fs.appendFile(config.hook_log_file, `${line}\n`, "utf-8");
  } catch {
    // Hook logs must never break Codex.
  }
}

async function upload(config, payload) {
  const headers = { ...(config.headers ?? {}), "content-type": "application/x-protobuf" };
  const auth = authHeader(config);
  if (auth && !headers.authorization && !headers.Authorization) headers.authorization = auth;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms ?? 10_000);
  const url = endpoint(config);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: encodeExportTraceServiceRequest(codexSpansToOtlpProtobufRequest(payload.spans)),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`gtrace upload failed: HTTP ${response.status} ${body}`);
    }
    const body = await response.text();
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch {
      return { response: body };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function runHook(options = {}) {
  const hookInput = options.hookInput ?? (await readStdin());
  const config = options.config ?? resolveConfig();
  if (!config.enabled) {
    await appendLog(config, "gtrace disabled");
    return;
  }
  if (!hookInput.transcript_path) {
    await appendLog(config, "hook payload missing transcript_path");
    return;
  }

  const result = await collectRollout(hookInput.transcript_path, config);
  await appendLog(config, "parsed rollout", {
    transcript_path: hookInput.transcript_path,
    turns: result.turns.length,
    spans: result.spans.length,
  });
  if (result.spans.length === 0) return;

  const response = await upload(config, {
    rollout_file: hookInput.transcript_path,
    session: {
      session_id: result.sessionMeta.sessionId,
      cli_version: result.sessionMeta.cliVersion,
      model_provider: result.sessionMeta.modelProvider,
    },
    turn_count: result.turns.length,
    spans: result.spans,
  });
  for (const turnId of result.completedTurnIds ?? []) {
    await markTurnUploaded(hookInput.transcript_path, turnId);
  }
  await appendLog(config, "uploaded spans", response);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHook().catch(async (error) => {
    const config = resolveConfig();
    const message = error instanceof Error ? error.message : String(error);
    await appendLog(config, "failed", { error: message });
    if (config.debug) console.error("[gtrace-codex-hook] failed:", message);
    if (config.fail_on_error) process.exitCode = 1;
  });
}
