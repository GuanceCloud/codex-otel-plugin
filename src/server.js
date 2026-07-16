import http from "node:http";
import { fileURLToPath, URL } from "node:url";
import { gunzip, inflate } from "node:zlib";
import { promisify } from "node:util";

import {
  decodeExportMetricsRequest,
  decodeExportTraceRequest,
  decodeJsonExportMetricsRequest,
  decodeJsonExportTraceRequest,
  encodeExportMetricsResponse,
  encodeExportTraceResponse,
  normalizeExportMetricsRequest,
  normalizeExportTraceRequest,
} from "./otlp.js";
import { FileStore } from "./store.js";
import { isMainModule } from "./codex-utils.js";

const DEFAULT_PORT = 3030;
const DEFAULT_DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

export function createServer(options = {}) {
  const store = options.store ?? new FileStore(options.dataDir ?? process.env.GTRACE_DATA_DIR ?? DEFAULT_DATA_DIR);
  const expectedPublicKey = options.publicKey ?? process.env.GTRACE_PUBLIC_KEY;
  const expectedSecretKey = options.secretKey ?? process.env.GTRACE_SECRET_KEY;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, service: "gtrace" });
      }

      if (req.method === "GET" && url.pathname === "/api/public/health") {
        return sendJson(res, 200, { ok: true, service: "gtrace-otlp" });
      }

      if (req.method === "GET" && url.pathname === "/traces") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
        return sendJson(res, 200, { data: await store.listSpans(Number.isFinite(limit) ? limit : 50) });
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
        return sendJson(res, 200, { data: await store.listMetrics(Number.isFinite(limit) ? limit : 50) });
      }

      if (req.method === "POST" && url.pathname === "/api/public/otel/v1/traces") {
        const auth = parseBasicAuth(req.headers.authorization);
        if (!isAuthorized(auth, expectedPublicKey, expectedSecretKey)) {
          console.error("[gtrace] unauthorized OTLP ingest request");
          return sendJson(res, 401, { error: "unauthorized" });
        }

        const body = await readBody(req);
        const decodedBody = await decodeBody(body, req.headers["content-encoding"]);
        const rawRequest = decodeTraceRequest(decodedBody, req.headers["content-type"]);
        const ingest = {
          public_key: auth?.username,
          sdk_name: req.headers["x-gtrace-sdk-name"],
          sdk_version: req.headers["x-gtrace-sdk-version"],
          content_type: req.headers["content-type"],
          user_agent: req.headers["user-agent"],
          received_at: new Date().toISOString(),
        };
        const spans = normalizeExportTraceRequest(rawRequest, ingest);
        const saved = await store.saveBatch({ rawRequest, spans, ingest });

        return sendOtlpSuccess(res, req.headers["content-type"], saved);
      }

      if (req.method === "POST" && url.pathname === "/api/public/otel/v1/metrics") {
        const auth = parseBasicAuth(req.headers.authorization);
        if (!isAuthorized(auth, expectedPublicKey, expectedSecretKey)) {
          console.error("[gtrace] unauthorized OTLP metrics ingest request");
          return sendJson(res, 401, { error: "unauthorized" });
        }

        const body = await readBody(req);
        const decodedBody = await decodeBody(body, req.headers["content-encoding"]);
        const rawRequest = decodeMetricRequest(decodedBody, req.headers["content-type"]);
        const ingest = {
          public_key: auth?.username,
          sdk_name: req.headers["x-gtrace-sdk-name"],
          sdk_version: req.headers["x-gtrace-sdk-version"],
          content_type: req.headers["content-type"],
          user_agent: req.headers["user-agent"],
          received_at: new Date().toISOString(),
        };
        const metrics = normalizeExportMetricsRequest(rawRequest, ingest);
        const saved = await store.saveBatch({ rawRequest, metrics, ingest });

        return sendOtlpMetricSuccess(res, req.headers["content-type"], saved);
      }

      if (req.method === "POST" && url.pathname === "/api/gtrace/v1/codex-spans") {
        const auth = parseBasicAuth(req.headers.authorization);
        if (!isAuthorized(auth, expectedPublicKey, expectedSecretKey)) {
          console.error("[gtrace] unauthorized Codex native ingest request");
          return sendJson(res, 401, { error: "unauthorized" });
        }

        const body = await readBody(req);
        const decodedBody = await decodeBody(body, req.headers["content-encoding"]);
        const payload = JSON.parse(decodedBody.toString("utf-8"));
        const spans = Array.isArray(payload.spans) ? payload.spans : [];
        const ingest = {
          source: "gtrace-codex-native",
          public_key: auth?.username,
          content_type: req.headers["content-type"],
          user_agent: req.headers["user-agent"],
          received_at: new Date().toISOString(),
          rollout_file: payload.rollout_file,
          session_id: payload.session?.session_id,
        };
        const saved = await store.saveBatch({
          rawRequest: {
            type: "gtrace.codex.spans",
            rollout_file: payload.rollout_file,
            session: payload.session,
            turn_count: payload.turn_count,
          },
          spans: spans.map((span) => ({ ...span, ingest: { ...span.ingest, ...ingest } })),
          ingest,
        });
        return sendJson(res, 200, { ok: true, batch_id: saved.id, span_count: saved.spanCount });
      }

      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[gtrace] failed to ingest OTLP request:", message);
      return sendJson(res, 400, { error: "bad_request", message });
    }
  });
}

function isAuthorized(auth, expectedPublicKey, expectedSecretKey) {
  if (!expectedPublicKey && !expectedSecretKey) return true;
  return auth?.username === expectedPublicKey && auth?.password === expectedSecretKey;
}

function parseBasicAuth(header) {
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf-8");
  const index = decoded.indexOf(":");
  if (index < 0) return undefined;
  return {
    username: decoded.slice(0, index),
    password: decoded.slice(index + 1),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function decodeBody(body, encoding) {
  if (!encoding || encoding === "identity") return body;
  if (encoding === "gzip") return gunzipAsync(body);
  if (encoding === "deflate") return inflateAsync(body);
  throw new Error(`unsupported content-encoding: ${encoding}`);
}

function decodeTraceRequest(body, contentType = "") {
  if (String(contentType).includes("application/json")) {
    return decodeJsonExportTraceRequest(body);
  }
  return decodeExportTraceRequest(body);
}

function decodeMetricRequest(body, contentType = "") {
  if (String(contentType).includes("application/json")) {
    return decodeJsonExportMetricsRequest(body);
  }
  return decodeExportMetricsRequest(body);
}

function sendOtlpSuccess(res, contentType = "", saved) {
  const headers = {
    "x-gtrace-batch-id": saved.id,
    "x-gtrace-span-count": String(saved.spanCount),
  };

  if (String(contentType).includes("application/json")) {
    res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
    return res.end("{}\n");
  }

  res.writeHead(200, { ...headers, "content-type": "application/x-protobuf" });
  return res.end(encodeExportTraceResponse());
}

function sendOtlpMetricSuccess(res, contentType = "", saved) {
  const headers = {
    "x-gtrace-batch-id": saved.id,
    "x-gtrace-metric-count": String(saved.metricCount),
  };

  if (String(contentType).includes("application/json")) {
    res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
    return res.end("{}\n");
  }

  res.writeHead(200, { ...headers, "content-type": "application/x-protobuf" });
  return res.end(encodeExportMetricsResponse());
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

if (isMainModule(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? `${DEFAULT_PORT}`, 10);
  const server = createServer();
  server.listen(port, () => {
    console.log(`gtrace listening on http://localhost:${port}`);
    console.log("OTLP trace ingest: /api/public/otel/v1/traces");
    console.log("OTLP metrics ingest: /api/public/otel/v1/metrics");
  });
}
