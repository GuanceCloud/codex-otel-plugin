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

const OPERATION_COUNT = {
  name: "gen_ai.agent.operation.count",
  type: "sum",
  unit: "",
  description: "Agent-side operation count.",
};

const OPERATION_DURATION = {
  name: "gen_ai.agent.operation.duration",
  type: "histogram",
  unit: "ms",
  description: "Agent-side operation duration.",
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

function legacyOperationName(span) {
  if (span.name === "llm") return "model";
  if (String(span.name).startsWith("tool:")) return "tool";
  if (String(span.name).startsWith("skill:")) return "skill";
  return undefined;
}

function baseAttrs(span) {
  const attributes = {};
  const modelName = span.attributes?.["gen_ai.response.model"] ?? span.attributes?.["gen_ai.request.model"];
  setAttr(attributes, "agent_runtime", span.resource?.agent_runtime);
  setAttr(attributes, "gen_ai.conversation.id", span.attributes?.["gen_ai.conversation.id"]);
  setAttr(attributes, "session_id", span.attributes?.session_id ?? span.attributes?.["gen_ai.conversation.id"]);
  setAttr(attributes, "operation_name", legacyOperationName(span));
  setAttr(attributes, "gen_ai.operation.name", span.attributes?.["gen_ai.operation.name"]);
  setAttr(attributes, "outcome", operationOutcome(span));
  setAttr(attributes, "provider_name", span.attributes?.["gen_ai.provider.name"]);
  setAttr(attributes, "gen_ai.provider.name", span.attributes?.["gen_ai.provider.name"]);
  setAttr(attributes, "request_model", span.attributes?.["gen_ai.request.model"]);
  setAttr(attributes, "gen_ai.request.model", span.attributes?.["gen_ai.request.model"]);
  setAttr(attributes, "response_model", span.attributes?.["gen_ai.response.model"]);
  setAttr(attributes, "gen_ai.response.model", span.attributes?.["gen_ai.response.model"]);
  setAttr(attributes, "model_name", modelName);
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

function maxTime(a, b) {
  if (!a) return b;
  if (!b) return a;
  try {
    return BigInt(a) >= BigInt(b) ? a : b;
  } catch {
    return a;
  }
}

function minTime(a, b) {
  if (!a) return b;
  if (!b) return a;
  try {
    return BigInt(a) <= BigInt(b) ? a : b;
  } catch {
    return a;
  }
}

function operationCountGroupKey(span, attributes) {
  return JSON.stringify({
    run_id: span.attributes?.run_id ?? null,
    resource: span.resource ?? {},
    scope: span.scope ?? {},
    attributes,
  });
}

function addOperationCount(groups, span, attributes) {
  const key = operationCountGroupKey(span, attributes);
  const pointTime = span.end_time_unix_nano ?? span.start_time_unix_nano;
  if (!groups.has(key)) {
    groups.set(
      key,
      metric(OPERATION_COUNT, span, 1, attributes),
    );
    return;
  }

  const current = groups.get(key);
  current.value += 1;
  current.start_time_unix_nano = minTime(current.start_time_unix_nano, span.start_time_unix_nano);
  current.time_unix_nano = maxTime(current.time_unix_nano, pointTime);
}

function requestMetrics(span) {
  const attributes = {
    agent_runtime: span.resource?.agent_runtime,
    "gen_ai.conversation.id": span.attributes?.["gen_ai.conversation.id"],
    session_id: span.attributes?.session_id ?? span.attributes?.["gen_ai.conversation.id"],
    "error.type": span.attributes?.["error.type"],
  };
  setAttr(attributes, "final_status", requestOutcome(span));

  const duration = spanDuration(span);
  return duration === undefined ? [] : [metric(WORKFLOW_DURATION, span, duration, attributes)];
}

function skillMetrics(span, operationCountGroups) {
  const attributes = {
    ...baseAttrs(span),
  };
  setAttr(attributes, "skill_name", span.attributes?.["skill.name"] ?? span.attributes?.["gen_ai.skill.name"]);
  setAttr(attributes, "skill.name", span.attributes?.["skill.name"]);
  setAttr(attributes, "gen_ai.skill.name", span.attributes?.["gen_ai.skill.name"]);
  setAttr(attributes, "skill_source", span.attributes?.["skill.source.type"] ?? span.attributes?.["gen_ai.skill.source.type"]);
  setAttr(attributes, "skill.source.type", span.attributes?.["skill.source.type"]);
  setAttr(attributes, "gen_ai.skill.source.type", span.attributes?.["gen_ai.skill.source.type"]);
  setAttr(attributes, "skill.result_status", span.attributes?.["skill.result_status"]);
  setAttr(attributes, "gen_ai.skill.result.status", span.attributes?.["gen_ai.skill.result.status"]);
  setAttr(attributes, "gen_ai.skill.version", span.attributes?.["gen_ai.skill.version"]);
  if (operationOutcome(span) === "error") setAttr(attributes, "error.type", span.attributes?.["error.type"] ?? "_OTHER");

  addOperationCount(operationCountGroups, span, attributes);
  const out = [];
  const durationMs = finitePositive(span.duration_ms);
  if (durationMs !== undefined) out.push(metric(OPERATION_DURATION, span, durationMs, attributes));
  return out;
}

function llmMetrics(span, operationCountGroups) {
  const operationAttributes = {
    ...baseAttrs(span),
  };
  if (operationOutcome(span) === "error") setAttr(operationAttributes, "error.type", span.attributes?.["error.type"] ?? "_OTHER");
  addOperationCount(operationCountGroups, span, operationAttributes);
  const out = [];
  const durationMs = finitePositive(span.duration_ms);
  if (durationMs !== undefined) out.push(metric(OPERATION_DURATION, span, durationMs, operationAttributes));

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

function toolMetrics(span, operationCountGroups) {
  const attributes = {
    ...baseAttrs(span),
  };
  if (operationOutcome(span) === "error") setAttr(attributes, "error.type", span.attributes?.["error.type"] ?? "_OTHER");
  setAttr(attributes, "tool_name", span.attributes?.["gen_ai.tool.name"] ?? String(span.name ?? "").replace(/^tool:/, ""));
  setAttr(attributes, "gen_ai.tool.name", span.attributes?.["gen_ai.tool.name"] ?? String(span.name ?? "").replace(/^tool:/, ""));
  setAttr(attributes, "skill_name", span.attributes?.["skill.name"] ?? span.attributes?.["gen_ai.skill.name"]);
  setAttr(attributes, "skill.name", span.attributes?.["skill.name"]);
  setAttr(attributes, "gen_ai.skill.name", span.attributes?.["gen_ai.skill.name"]);
  setAttr(attributes, "skill_source", span.attributes?.["skill.source.type"] ?? span.attributes?.["gen_ai.skill.source.type"]);
  setAttr(attributes, "skill.source.type", span.attributes?.["skill.source.type"]);
  setAttr(attributes, "gen_ai.skill.source.type", span.attributes?.["gen_ai.skill.source.type"]);
  setAttr(attributes, "skill.result_status", span.attributes?.["skill.result_status"]);
  setAttr(attributes, "gen_ai.skill.result.status", span.attributes?.["gen_ai.skill.result.status"]);
  setAttr(attributes, "gen_ai.skill.version", span.attributes?.["gen_ai.skill.version"]);
  setAttr(attributes, "tool_result_status", span.attributes?.tool_result_status);

  addOperationCount(operationCountGroups, span, attributes);
  const out = [];
  const durationMs = finitePositive(span.duration_ms);
  if (durationMs !== undefined) out.push(metric(OPERATION_DURATION, span, durationMs, attributes));
  return out;
}

export function buildCodexMetrics(spans = []) {
  const metrics = [];
  const operationCountGroups = new Map();
  for (const span of spans) {
    if (span.name === "invoke_agent") metrics.push(...requestMetrics(span));
    else if (String(span.name).startsWith("skill:")) metrics.push(...skillMetrics(span, operationCountGroups));
    else if (span.name === "llm") metrics.push(...llmMetrics(span, operationCountGroups));
    else if (String(span.name).startsWith("tool:")) metrics.push(...toolMetrics(span, operationCountGroups));
  }
  metrics.unshift(...operationCountGroups.values());
  return metrics;
}
