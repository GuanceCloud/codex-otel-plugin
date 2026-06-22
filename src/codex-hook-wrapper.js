import * as fs from "node:fs/promises";

import { collectRollout } from "./codex-collector.js";
import { resolveConfig } from "./codex-config.js";
import { buildCodexMetrics } from "./codex-metrics.js";
import { codexMetricsToOtlpProtobufRequest, codexSpansToOtlpProtobufRequest } from "./codex-otlp.js";
import { acquireRolloutLock, markTurnUploaded, releaseRolloutLock } from "./codex-sidecar.js";
import { readStdin } from "./codex-utils.js";
import { encodeExportMetricsServiceRequest, encodeExportTraceServiceRequest } from "./proto.js";

function resolveOtelUrl(endpoint, path) {
  const normalizedPath = String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalizedPath) return endpoint;
  const endpointWithoutQueryOrFragment = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  const escapedPath = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`/${escapedPath}$`, "i").test(endpointWithoutQueryOrFragment)) return endpoint;
  return `${endpoint}/${normalizedPath}`;
}

function endpoint(config, signal) {
  if (signal === "metrics" && config.otel_metrics_url) return config.otel_metrics_url;
  if (signal === "traces" && config.otel_traces_url) return config.otel_traces_url;
  return resolveOtelUrl(
    config.endpoint ?? config.base_url,
    signal === "metrics" ? config.metricsPath : config.tracePath,
  );
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

async function upload(config, signal, body) {
  const headers = { ...(config.headers ?? {}), "content-type": "application/x-protobuf" };
  const auth = authHeader(config);
  if (auth && !headers.authorization && !headers.Authorization) headers.authorization = auth;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms ?? 10_000);
  const url = endpoint(config, signal);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`gtrace upload failed: HTTP ${response.status} ${body}`);
    }
    const responseBody = await response.text();
    if (!responseBody) return {};
    try {
      return JSON.parse(responseBody);
    } catch {
      return { response: responseBody };
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadTraces(config, spans) {
  return upload(config, "traces", encodeExportTraceServiceRequest(codexSpansToOtlpProtobufRequest(spans)));
}

async function uploadMetrics(config, metrics) {
  return upload(config, "metrics", encodeExportMetricsServiceRequest(codexMetricsToOtlpProtobufRequest(metrics)));
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

  const rolloutLock = await acquireRolloutLock(hookInput.transcript_path, {
    staleMs: config.lock_stale_ms,
  });
  if (!rolloutLock) {
    await appendLog(config, "skipped duplicate hook run", {
      transcript_path: hookInput.transcript_path,
    });
    return;
  }

  try {
    const result = await collectRollout(hookInput.transcript_path, config);
    await appendLog(config, "parsed rollout", {
      transcript_path: hookInput.transcript_path,
      turns: result.turns.length,
      spans: result.spans.length,
    });
    if (result.spans.length === 0) return;

    const response = await uploadTraces(config, result.spans);
    for (const item of result.uploadedTurnStates ?? []) {
      await markTurnUploaded(hookInput.transcript_path, item.turnId, item.fingerprint);
    }
    await appendLog(config, "uploaded spans", response);

    const metrics = buildCodexMetrics(result.spans);
    if (metrics.length > 0) {
      const metricsResponse = await uploadMetrics(config, metrics);
      await appendLog(config, "uploaded metrics", { ...metricsResponse, metrics: metrics.length });
    }
  } finally {
    await releaseRolloutLock(rolloutLock);
  }
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
