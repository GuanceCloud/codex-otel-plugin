const TOKEN_ATTRIBUTE_TYPES = [
  ["usage_input_tokens", "input"],
  ["usage_output_tokens", "output"],
  ["usage_total_tokens", "total"],
  ["usage_cache_read_input_tokens", "cache_read"],
  ["usage_cache_total_tokens", "cache_total"],
  ["usage_reasoning_tokens", "reasoning"],
];

const REQUEST_COUNT = {
  name: "gen_ai.agent.request.count",
  type: "sum",
  unit: "1",
  description: "Agent request count.",
};

const REQUEST_DURATION = {
  name: "gen_ai.agent.request.duration",
  type: "histogram",
  unit: "ms",
  description: "Agent request duration.",
};

const TOKEN_USAGE = {
  name: "gen_ai.agent.token.usage",
  type: "histogram",
  unit: "{token}",
  description: "Agent model token usage.",
};

const OPERATION_COUNT = {
  name: "gen_ai.agent.operation.count",
  type: "sum",
  unit: "1",
  description: "Agent operation count.",
};

const OPERATION_DURATION = {
  name: "gen_ai.agent.operation.duration",
  type: "histogram",
  unit: "ms",
  description: "Agent operation duration.",
};

function setAttr(attributes, key, value) {
  if (value !== undefined && value !== null && value !== "") attributes[key] = value;
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function spanDuration(span) {
  const duration = finitePositive(span.duration_ms);
  if (duration !== undefined) return duration;
  try {
    const start = BigInt(span.start_time_unix_nano ?? 0);
    const end = BigInt(span.end_time_unix_nano ?? 0);
    if (start > 0n && end > start) return Number(end - start) / 1_000_000;
  } catch {
    return undefined;
  }
  return undefined;
}

function statusCode(span) {
  return String(span.status?.code ?? "").toUpperCase();
}

function requestOutcome(span) {
  const finalStatus = span.attributes?.final_status;
  if (finalStatus === "completed" || finalStatus === "cancelled" || finalStatus === "unset") {
    return finalStatus;
  }
  if (span.attributes?.status === "error" || statusCode(span).includes("ERROR")) return "error";
  return "completed";
}

function operationOutcome(span) {
  if (span.attributes?.tool_result_status === "error") return "error";
  if (span.attributes?.status === "error" || statusCode(span).includes("ERROR")) return "error";
  return "completed";
}

function baseAttrs(span) {
  const attributes = {};
  setAttr(attributes, "agent_runtime", span.resource?.agent_runtime ?? span.attributes?.agent_runtime ?? "codex");
  setAttr(attributes, "session_id", span.attributes?.session_id);
  setAttr(attributes, "session_key", span.attributes?.session_key);
  setAttr(attributes, "provider_name", span.attributes?.provider_name);
  setAttr(attributes, "model_name", span.attributes?.model_name);
  return attributes;
}

function metric(meta, span, value, attributes) {
  return {
    ...meta,
    value,
    attributes,
    resource: span.resource ?? {},
    scope: span.scope ?? {},
    start_time_unix_nano: span.start_time_unix_nano,
    time_unix_nano: span.end_time_unix_nano ?? span.start_time_unix_nano,
  };
}

function requestMetrics(span) {
  const attributes = {
    ...baseAttrs(span),
    outcome: requestOutcome(span),
  };
  setAttr(attributes, "session_agent", span.attributes?.session_agent);
  setAttr(attributes, "final_status", span.attributes?.final_status);

  const out = [metric(REQUEST_COUNT, span, 1, attributes)];
  const duration = spanDuration(span);
  if (duration !== undefined) out.push(metric(REQUEST_DURATION, span, duration, attributes));
  return out;
}

function llmMetrics(span) {
  const operationAttributes = {
    ...baseAttrs(span),
    operation_name: "model",
    outcome: operationOutcome(span),
  };
  const out = [metric(OPERATION_COUNT, span, 1, operationAttributes)];
  const duration = spanDuration(span);
  if (duration !== undefined) out.push(metric(OPERATION_DURATION, span, duration, operationAttributes));

  for (const [attributeName, tokenType] of TOKEN_ATTRIBUTE_TYPES) {
    const value = finitePositive(span.attributes?.[attributeName]);
    if (value === undefined) continue;
    out.push(
      metric(TOKEN_USAGE, span, value, {
        ...baseAttrs(span),
        outcome: operationOutcome(span),
        token_type: tokenType,
      }),
    );
  }
  return out;
}

function toolMetrics(span) {
  const attributes = {
    ...baseAttrs(span),
    operation_name: "tool",
    outcome: operationOutcome(span),
  };
  setAttr(attributes, "tool_name", span.attributes?.tool_name ?? String(span.name ?? "").replace(/^tool:/, ""));
  setAttr(attributes, "tool_result_status", span.attributes?.tool_result_status);

  const out = [metric(OPERATION_COUNT, span, 1, attributes)];
  const duration = spanDuration(span);
  if (duration !== undefined) out.push(metric(OPERATION_DURATION, span, duration, attributes));
  return out;
}

export function buildCodexMetrics(spans = []) {
  const metrics = [];
  for (const span of spans) {
    if (span.name === "agent_run") metrics.push(...requestMetrics(span));
    else if (span.name === "llm") metrics.push(...llmMetrics(span));
    else if (String(span.name).startsWith("tool:")) metrics.push(...toolMetrics(span));
  }
  return metrics;
}
