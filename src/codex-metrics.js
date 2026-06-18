const TOKEN_ATTRIBUTE_TYPES = [
  ["gen_ai.usage.input_tokens", "input"],
  ["gen_ai.usage.output_tokens", "output"],
];

const WORKFLOW_DURATION = {
  name: "gen_ai.workflow.duration",
  type: "histogram",
  unit: "s",
  description: "GenAI workflow duration.",
};

const TOKEN_USAGE = {
  name: "gen_ai.client.token.usage",
  type: "histogram",
  unit: "{token}",
  description: "Number of input and output tokens used.",
};

const OPERATION_DURATION = {
  name: "gen_ai.client.operation.duration",
  type: "histogram",
  unit: "s",
  description: "GenAI operation duration.",
};

function setAttr(attributes, key, value) {
  if (value !== undefined && value !== null && value !== "") attributes[key] = value;
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function spanDuration(span) {
  const duration = finitePositive(span.duration_ms);
  if (duration !== undefined) return duration / 1000;
  try {
    const start = BigInt(span.start_time_unix_nano ?? 0);
    const end = BigInt(span.end_time_unix_nano ?? 0);
    if (start > 0n && end > start) return Number(end - start) / 1_000_000_000;
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
  setAttr(attributes, "gen_ai.conversation.id", span.attributes?.["gen_ai.conversation.id"]);
  setAttr(attributes, "session_id", span.attributes?.session_id ?? span.attributes?.["gen_ai.conversation.id"]);
  setAttr(attributes, "gen_ai.operation.name", span.attributes?.["gen_ai.operation.name"]);
  setAttr(attributes, "gen_ai.provider.name", span.attributes?.["gen_ai.provider.name"]);
  setAttr(attributes, "gen_ai.request.model", span.attributes?.["gen_ai.request.model"]);
  setAttr(attributes, "gen_ai.response.model", span.attributes?.["gen_ai.response.model"]);
  setAttr(attributes, "error.type", span.attributes?.["error.type"]);
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
    "gen_ai.conversation.id": span.attributes?.["gen_ai.conversation.id"],
    session_id: span.attributes?.session_id ?? span.attributes?.["gen_ai.conversation.id"],
    "error.type": span.attributes?.["error.type"],
  };
  setAttr(attributes, "final_status", requestOutcome(span));

  const duration = spanDuration(span);
  return duration === undefined ? [] : [metric(WORKFLOW_DURATION, span, duration, attributes)];
}

function llmMetrics(span) {
  const operationAttributes = {
    ...baseAttrs(span),
  };
  if (operationOutcome(span) === "error") setAttr(operationAttributes, "error.type", span.attributes?.["error.type"] ?? "_OTHER");
  const out = [];
  const duration = spanDuration(span);
  if (duration !== undefined) out.push(metric(OPERATION_DURATION, span, duration, operationAttributes));

  for (const [attributeName, tokenType] of TOKEN_ATTRIBUTE_TYPES) {
    const value = finitePositive(span.attributes?.[attributeName]);
    if (value === undefined) continue;
    out.push(
      metric(TOKEN_USAGE, span, value, {
        ...baseAttrs(span),
        "gen_ai.token.type": tokenType,
      }),
    );
  }
  return out;
}

function toolMetrics(span) {
  const attributes = {
    ...baseAttrs(span),
  };
  if (operationOutcome(span) === "error") setAttr(attributes, "error.type", span.attributes?.["error.type"] ?? "_OTHER");
  setAttr(attributes, "gen_ai.tool.name", span.attributes?.["gen_ai.tool.name"] ?? String(span.name ?? "").replace(/^tool:/, ""));
  setAttr(attributes, "tool_result_status", span.attributes?.tool_result_status);

  const duration = spanDuration(span);
  return duration === undefined ? [] : [metric(OPERATION_DURATION, span, duration, attributes)];
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
