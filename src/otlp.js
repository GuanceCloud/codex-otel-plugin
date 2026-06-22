import {
  decodeExportMetricsServiceRequest,
  decodeExportTraceServiceRequest,
  encodeExportMetricsServiceResponse,
  encodeExportTraceServiceResponse,
} from "./proto.js";

export function decodeExportTraceRequest(buffer) {
  return decodeExportTraceServiceRequest(buffer);
}

export function decodeExportMetricsRequest(buffer) {
  return decodeExportMetricsServiceRequest(buffer);
}

export function decodeJsonExportTraceRequest(buffer) {
  return JSON.parse(Buffer.from(buffer).toString("utf-8"));
}

export function decodeJsonExportMetricsRequest(buffer) {
  return JSON.parse(Buffer.from(buffer).toString("utf-8"));
}

export function encodeExportTraceResponse(response = {}) {
  return encodeExportTraceServiceResponse(response);
}

export function encodeExportMetricsResponse(response = {}) {
  return encodeExportMetricsServiceResponse(response);
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

export function normalizeExportMetricsRequest(request, ingest = {}) {
  const records = [];

  for (const resourceMetric of request.resourceMetrics ?? []) {
    const resourceAttributes = attributesToObject(resourceMetric.resource?.attributes);

    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      const scope = {
        name: scopeMetric.scope?.name,
        version: scopeMetric.scope?.version,
        attributes: attributesToObject(scopeMetric.scope?.attributes),
      };

      for (const metric of scopeMetric.metrics ?? []) {
        records.push(...normalizeMetric(metric, resourceAttributes, scope, ingest));
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

function normalizeMetric(metric, resourceAttributes, scope, ingest) {
  if (metric.sum) {
    return (metric.sum.dataPoints ?? []).map((point) => ({
      name: metric.name,
      description: metric.description,
      unit: metric.unit,
      type: "sum",
      value: numberPointValue(point),
      aggregation_temporality: metric.sum.aggregationTemporality,
      is_monotonic: metric.sum.isMonotonic,
      start_time_unix_nano: stringifyOptional(point.startTimeUnixNano),
      time_unix_nano: stringifyOptional(point.timeUnixNano),
      attributes: attributesToObject(point.attributes),
      resource: resourceAttributes,
      scope,
      ingest,
    }));
  }
  if (metric.histogram) {
    return (metric.histogram.dataPoints ?? []).map((point) => ({
      name: metric.name,
      description: metric.description,
      unit: metric.unit,
      type: "histogram",
      aggregation_temporality: metric.histogram.aggregationTemporality,
      count: parseInteger(point.count ?? "0"),
      sum: point.sum,
      min: point.min,
      max: point.max,
      bucket_counts: (point.bucketCounts ?? []).map(parseInteger),
      explicit_bounds: point.explicitBounds ?? [],
      start_time_unix_nano: stringifyOptional(point.startTimeUnixNano),
      time_unix_nano: stringifyOptional(point.timeUnixNano),
      attributes: attributesToObject(point.attributes),
      resource: resourceAttributes,
      scope,
      ingest,
    }));
  }
  if (metric.gauge) {
    return (metric.gauge.dataPoints ?? []).map((point) => ({
      name: metric.name,
      description: metric.description,
      unit: metric.unit,
      type: "gauge",
      value: numberPointValue(point),
      start_time_unix_nano: stringifyOptional(point.startTimeUnixNano),
      time_unix_nano: stringifyOptional(point.timeUnixNano),
      attributes: attributesToObject(point.attributes),
      resource: resourceAttributes,
      scope,
      ingest,
    }));
  }
  return [];
}

function numberPointValue(point) {
  if (point.asInt !== undefined) return parseInteger(point.asInt);
  if (point.asDouble !== undefined) return point.asDouble;
  return undefined;
}

function stringifyOptional(value) {
  return value === undefined || value === null ? undefined : String(value);
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
      session_id: attributes["gtrace.session.id"] ?? attributes["gen_ai.conversation.id"] ?? attributes.session_id,
      user_id: attributes["gtrace.user.id"] ?? attributes.user_id,
      metadata: collectPrefixed(attributes, "gtrace.trace.metadata."),
    },
    observation: {
      type: attributes["gtrace.observation.type"] ?? attributes.span_type ?? observationTypeFromSpanName(spanName),
      input: parseMaybeJson(attributes["gtrace.observation.input"] ?? attributes.input_preview),
      output: parseMaybeJson(attributes["gtrace.observation.output"] ?? attributes.output_preview),
      model_name:
        attributes["gtrace.model.name"] ??
        attributes["gen_ai.response.model"] ??
        attributes["gen_ai.request.model"] ??
        attributes.model_name ??
        attributes.request_model,
      usage: parseMaybeJson(attributes["gtrace.usage"]) ?? usageFromCanonicalAttributes(attributes),
    },
    environment: attributes["gtrace.environment"],
  };
}

function observationTypeFromSpanName(spanName) {
  if (spanName === "invoke_agent") return "agent";
  if (spanName === "llm") return "llm";
  if (spanName === "assistant") return "assistant";
  if (String(spanName).startsWith("tool:")) return "tool";
  return undefined;
}

function usageFromCanonicalAttributes(attributes) {
  const usage = {};
  const inputTokens = attributes["gen_ai.usage.input_tokens"] ?? attributes.usage_input_tokens;
  const outputTokens = attributes["gen_ai.usage.output_tokens"] ?? attributes.usage_output_tokens;
  if (typeof inputTokens === "number") usage.input = inputTokens;
  if (typeof outputTokens === "number") usage.output = outputTokens;
  if (typeof attributes.usage_total_tokens === "number") {
    usage.total = attributes.usage_total_tokens;
  } else if (typeof usage.input === "number" || typeof usage.output === "number") {
    usage.total = (usage.input ?? 0) + (usage.output ?? 0);
  }
  const cacheReadInputTokens = attributes["gen_ai.usage.cache_read.input_tokens"] ?? attributes.usage_cache_read_input_tokens;
  if (typeof cacheReadInputTokens === "number") {
    usage.cache_read_input_tokens = cacheReadInputTokens;
  }
  if (typeof attributes.usage_cache_read_input_tokens === "number") {
    usage.cache_read_input_tokens = attributes.usage_cache_read_input_tokens;
  }
  if (typeof attributes.usage_cache_total_tokens === "number") {
    usage.cache_total_tokens = attributes.usage_cache_total_tokens;
  }
  if (typeof attributes.usage_context_input_tokens === "number") usage.context_input_tokens = attributes.usage_context_input_tokens;
  if (typeof attributes.usage_context_total_tokens === "number") usage.context_total_tokens = attributes.usage_context_total_tokens;
  const reasoningTokens = attributes["gen_ai.usage.reasoning.output_tokens"] ?? attributes.usage_reasoning_tokens;
  if (typeof reasoningTokens === "number") usage.reasoning_tokens = reasoningTokens;
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
