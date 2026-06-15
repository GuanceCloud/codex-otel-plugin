import {
  decodeExportTraceServiceRequest,
  encodeExportTraceServiceResponse,
} from "./proto.js";

export function decodeExportTraceRequest(buffer) {
  return decodeExportTraceServiceRequest(buffer);
}

export function decodeJsonExportTraceRequest(buffer) {
  return JSON.parse(Buffer.from(buffer).toString("utf-8"));
}

export function encodeExportTraceResponse(response = {}) {
  return encodeExportTraceServiceResponse(response);
}

export function normalizeExportTraceRequest(request, ingest = {}) {
  const records = [];

  for (const resourceSpan of request.resourceSpans ?? []) {
    const resourceAttributes = attributesToObject(resourceSpan.resource?.attributes);

    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      const scope = {
        name: scopeSpan.scope?.name,
        version: scopeSpan.scope?.version,
        attributes: attributesToObject(scopeSpan.scope?.attributes),
      };

      for (const span of scopeSpan.spans ?? []) {
        records.push(normalizeSpan(span, resourceAttributes, scope, ingest));
      }
    }
  }

  return records;
}

export function normalizeSpan(span, resourceAttributes, scope, ingest) {
  const attributes = attributesToObject(span.attributes);
  const gtrace = extractGtrace(attributes, span.name);
  const startNs = toBigIntOrZero(span.startTimeUnixNano);
  const endNs = toBigIntOrZero(span.endTimeUnixNano);

  return {
    trace_id: bytesToHex(span.traceId),
    span_id: bytesToHex(span.spanId),
    parent_id: bytesToHex(span.parentSpanId),
    name: span.name,
    kind: span.kind,
    start_time_unix_nano: startNs.toString(),
    end_time_unix_nano: endNs.toString(),
    start_time: nsToIso(startNs),
    end_time: nsToIso(endNs),
    duration_ms: durationMs(startNs, endNs),
    status: normalizeStatus(span.status),
    trace_state: span.traceState,
    attributes,
    resource: resourceAttributes,
    scope,
    gtrace,
    ingest,
  };
}

export function attributesToObject(attributes = []) {
  const out = {};
  for (const item of attributes) {
    if (!item?.key) continue;
    out[item.key] = anyValueToJson(item.value);
  }
  return out;
}

export function anyValueToJson(value) {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return parseInteger(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.bytesValue !== undefined) return bytesToHex(value.bytesValue);
  if (value.arrayValue !== undefined) {
    return (value.arrayValue.values ?? []).map((entry) => anyValueToJson(entry));
  }
  if (value.kvlistValue !== undefined) {
    return attributesToObject(value.kvlistValue.values);
  }
  return undefined;
}

function extractGtrace(attributes, spanName) {
  return {
    trace: {
      name: attributes["gtrace.trace.name"] ?? attributes.trace_name,
      session_id: attributes["gtrace.session.id"] ?? attributes.session_id,
      user_id: attributes["gtrace.user.id"] ?? attributes.user_id,
      metadata: collectPrefixed(attributes, "gtrace.trace.metadata."),
    },
    observation: {
      type: attributes["gtrace.observation.type"] ?? attributes.span_type ?? observationTypeFromSpanName(spanName),
      input: parseMaybeJson(attributes["gtrace.observation.input"] ?? attributes.input_preview),
      output: parseMaybeJson(attributes["gtrace.observation.output"] ?? attributes.output_preview),
      model_name: attributes["gtrace.model.name"] ?? attributes.model_name ?? attributes.request_model,
      usage: parseMaybeJson(attributes["gtrace.usage"]) ?? usageFromCanonicalAttributes(attributes),
    },
    environment: attributes["gtrace.environment"],
  };
}

function observationTypeFromSpanName(spanName) {
  if (spanName === "agent_run") return "agent";
  if (spanName === "llm") return "llm";
  if (String(spanName).startsWith("tool:")) return "tool";
  return undefined;
}

function usageFromCanonicalAttributes(attributes) {
  const usage = {};
  if (typeof attributes.usage_input_tokens === "number") usage.input = attributes.usage_input_tokens;
  if (typeof attributes.usage_output_tokens === "number") usage.output = attributes.usage_output_tokens;
  if (typeof attributes.usage_total_tokens === "number") usage.total = attributes.usage_total_tokens;
  if (typeof attributes.usage_cache_read_input_tokens === "number") {
    usage.cache_read_input_tokens = attributes.usage_cache_read_input_tokens;
  }
  if (typeof attributes.usage_cache_total_tokens === "number") {
    usage.cache_total_tokens = attributes.usage_cache_total_tokens;
  }
  if (typeof attributes.usage_context_input_tokens === "number") usage.context_input_tokens = attributes.usage_context_input_tokens;
  if (typeof attributes.usage_context_total_tokens === "number") usage.context_total_tokens = attributes.usage_context_total_tokens;
  if (typeof attributes.usage_reasoning_tokens === "number") usage.reasoning_tokens = attributes.usage_reasoning_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function collectPrefixed(attributes, prefix) {
  const out = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = parseMaybeJson(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeStatus(status) {
  return {
    code: status?.code ?? "STATUS_CODE_UNSET",
    message: status?.message,
  };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!["{", "["].includes(trimmed[0])) return value;
  return parseJson(trimmed) ?? value;
}

function parseJson(value) {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseInteger(value) {
  if (typeof value === "number") return value;
  const asBigInt = BigInt(value);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return asBigInt <= max && asBigInt >= -max ? Number(asBigInt) : asBigInt.toString();
}

function bytesToHex(value) {
  if (!value || value.length === 0) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[0-9a-fA-F]+$/.test(trimmed)) return trimmed.toLowerCase();
    return Buffer.from(trimmed, "base64").toString("hex");
  }
  return Buffer.from(value).toString("hex");
}

function toBigIntOrZero(value) {
  if (value === undefined || value === null || value === "") return 0n;
  return BigInt(value);
}

function nsToIso(ns) {
  if (ns <= 0n) return undefined;
  return new Date(Number(ns / 1_000_000n)).toISOString();
}

function durationMs(startNs, endNs) {
  if (startNs <= 0n || endNs <= 0n || endNs < startNs) return undefined;
  return Number(endNs - startNs) / 1_000_000;
}
