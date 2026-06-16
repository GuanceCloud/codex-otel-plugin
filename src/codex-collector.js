import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadRollout, parseSession } from "./codex-parse.js";
import { loadUploadedTurnIds } from "./codex-sidecar.js";
import { clipValue, toText } from "./codex-utils.js";

function randomTraceId() {
  return crypto.randomBytes(16).toString("hex");
}

function randomSpanId() {
  return crypto.randomBytes(8).toString("hex");
}

function nsFromMs(ms) {
  return BigInt(ms) * 1_000_000n;
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

function usageDetails(usage) {
  if (!usage) return undefined;
  const details = {};
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const cacheRead = typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : undefined;
  const uncachedInput = input === undefined ? undefined : Math.max(0, input - (cacheRead ?? 0));
  if (typeof uncachedInput === "number") details.input = uncachedInput;
  if (typeof output === "number") details.output = output;
  if (typeof uncachedInput === "number" || typeof output === "number") {
    details.total = (uncachedInput ?? 0) + (output ?? 0);
  }
  if (typeof cacheRead === "number") {
    details.cache_read_input_tokens = cacheRead;
    details.cache_total_tokens = cacheRead;
  }
  if (typeof input === "number") details.context_input_tokens = input;
  if (typeof usage.total_tokens === "number") details.context_total_tokens = usage.total_tokens;
  if (typeof usage.reasoning_output_tokens === "number") details.reasoning_tokens = usage.reasoning_output_tokens;
  return Object.keys(details).length > 0 ? details : undefined;
}

function aggregateUsageDetails(steps) {
  const aggregate = {};
  let hasUsage = false;
  for (const step of steps) {
    const usage = usageDetails(step.usage);
    if (!usage) continue;
    hasUsage = true;

    if (typeof usage.input === "number") aggregate.input = (aggregate.input ?? 0) + usage.input;
    if (typeof usage.output === "number") aggregate.output = (aggregate.output ?? 0) + usage.output;
    if (typeof usage.total === "number") aggregate.total = (aggregate.total ?? 0) + usage.total;
    if (typeof usage.cache_read_input_tokens === "number") {
      aggregate.cache_read_input_tokens =
        (aggregate.cache_read_input_tokens ?? 0) + usage.cache_read_input_tokens;
    }
    if (typeof usage.cache_total_tokens === "number") {
      aggregate.cache_total_tokens = (aggregate.cache_total_tokens ?? 0) + usage.cache_total_tokens;
    }
    if (typeof usage.reasoning_tokens === "number") {
      aggregate.reasoning_tokens = (aggregate.reasoning_tokens ?? 0) + usage.reasoning_tokens;
    }

    if (typeof usage.context_input_tokens === "number") {
      aggregate.context_input_tokens = usage.context_input_tokens;
    }
    if (typeof usage.context_total_tokens === "number") {
      aggregate.context_total_tokens = usage.context_total_tokens;
    }
  }
  return hasUsage ? aggregate : undefined;
}

function statusFromTurn(turn) {
  if (turn.aborted) return "cancelled";
  return turn.completed ? "completed" : "unset";
}

function isObservableTurn(turn) {
  return Boolean(
    preview(turn.userInput, 1) ||
      preview(turn.finalOutput, 1) ||
      turn.steps.some((step) =>
        preview(step.text, 1) ||
        preview(step.reasoning, 1) ||
        step.toolCalls.length > 0 ||
        usageDetails(step.usage),
      ),
  );
}

function preview(value, maxChars) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : serialize(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? clipValue(normalized, maxChars) : undefined;
}

function durationMs(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function setAttr(attributes, key, value) {
  if (value !== undefined && value !== null) attributes[key] = value;
}

function flattenMetadata(attributes, prefix, metadata = {}) {
  for (const [key, value] of Object.entries(metadata)) setAttr(attributes, `${prefix}.${key}`, value);
}

function makeSpan({
  traceId,
  spanId = randomSpanId(),
  parentId,
  name,
  start,
  end,
  attributes,
  resource,
  scope,
  ingest,
  status,
}) {
  return {
    trace_id: traceId,
    span_id: spanId,
    parent_id: parentId,
    name,
    kind: "SPAN_KIND_INTERNAL",
    start_time_unix_nano: nsFromMs(start).toString(),
    end_time_unix_nano: nsFromMs(end).toString(),
    start_time: isoFromMs(start),
    end_time: isoFromMs(end),
    duration_ms: durationMs(start, end),
    status: status ?? { code: "STATUS_CODE_UNSET" },
    attributes,
    resource,
    scope,
    gtrace: extractGtrace(attributes, name),
    ingest,
  };
}

function extractGtrace(attributes, spanName) {
  return {
    trace: {
      name: attributes.trace_name,
      session_id: attributes.session_id,
      user_id: attributes.user_id,
    },
    observation: {
      type: observationTypeFromSpanName(spanName),
      model_name: attributes.model_name,
      usage: usageFromAttributes(attributes),
    },
  };
}

function observationTypeFromSpanName(spanName) {
  if (spanName === "agent_run") return "agent";
  if (spanName === "llm") return "llm";
  if (spanName === "assistant") return "assistant";
  if (String(spanName).startsWith("tool:")) return "tool";
  return undefined;
}

function usageFromAttributes(attributes) {
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

function buildGenerationOutput(step, maxChars) {
  const output = {};
  if (step.text) output.content = clipValue(step.text, maxChars);
  if (step.reasoning) output.reasoning = clipValue(step.reasoning, maxChars);
  if (step.toolCalls.length > 0) {
    output.tool_calls = step.toolCalls.map((tc) => ({
      id: tc.callId,
      name: tc.name,
      arguments: clipValue(tc.args, maxChars),
    }));
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function toolCommand(tc) {
  const args = tc.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const command = args.cmd ?? args.command;
  if (Array.isArray(command)) return command.map((part) => String(part)).join(" ");
  if (typeof command === "string") return command;
  return undefined;
}

function assistantMessagesFromStep(step) {
  if (Array.isArray(step.assistantMessages) && step.assistantMessages.length > 0) {
    return step.assistantMessages.filter((message) => preview(message.text, 1));
  }
  if (preview(step.text, 1)) {
    return [{ text: step.text, startTime: step.startTime, endTime: step.endTime }];
  }
  return [];
}

function commonAttributes(config, sessionMeta) {
  const attributes = {
    session_id: sessionMeta.sessionId,
    session_key: sessionMeta.sessionId,
    session_agent: "codex",
    request_type: "user_request",
    is_internal_request: false,
  };
  setAttr(attributes, "user_id", config.user_id);
  for (const [key, value] of Object.entries(config.metadata ?? {})) setAttr(attributes, key, value);
  return attributes;
}

function resourceAttributes(config, sessionMeta) {
  const resource = {
    "service.name": "gtrace-codex",
    "telemetry.sdk.language": "nodejs",
    "telemetry.sdk.name": "gtrace",
    "telemetry.sdk.version": "0.1.0",
    agent_runtime: "codex",
    agent_version: sessionMeta.cliVersion,
    runtime_environment: config.environment,
  };
  for (const [key, value] of Object.entries(config.resourceAttributes ?? {})) setAttr(resource, key, value);
  return resource;
}

function buildTurnSpans(turn, sessionMeta, config, ctx) {
  const maxChars = config.max_chars;
  const traceId = ctx.traceId ?? randomTraceId();
  const rootSpanId = ctx.parentSpanId ?? randomSpanId();
  const resource = resourceAttributes(config, sessionMeta);
  const scope = { name: "gtrace-codex-collector", version: "0.1.0", attributes: {} };
  const ingest = {
    source: "gtrace-codex-hook",
    rollout_file: ctx.rolloutFile,
    received_at: new Date().toISOString(),
  };

  const rootAttributes = commonAttributes(config, sessionMeta);
  const rootUsage = aggregateUsageDetails(turn.steps);
  setAttr(rootAttributes, "run_id", turn.turnId);
  setAttr(rootAttributes, "run_ids", turn.turnId);
  setAttr(rootAttributes, "provider_name", sessionMeta.modelProvider);
  setAttr(rootAttributes, "model_name", turn.model);
  setAttr(rootAttributes, "input_preview", preview(turn.userInput, maxChars));
  setAttr(rootAttributes, "input_length", turn.userInput?.length);
  setAttr(rootAttributes, "output_preview", preview(turn.finalOutput, maxChars));
  setAttr(rootAttributes, "output_length", turn.finalOutput?.length);
  setAttr(rootAttributes, "tool_count", turn.steps.reduce((n, s) => n + s.toolCalls.length, 0));
  setAttr(rootAttributes, "usage_input_tokens", rootUsage?.input);
  setAttr(rootAttributes, "usage_output_tokens", rootUsage?.output);
  setAttr(rootAttributes, "usage_total_tokens", rootUsage?.total);
  setAttr(rootAttributes, "usage_cache_read_input_tokens", rootUsage?.cache_read_input_tokens);
  setAttr(rootAttributes, "usage_cache_total_tokens", rootUsage?.cache_total_tokens);
  setAttr(rootAttributes, "usage_context_input_tokens", rootUsage?.context_input_tokens);
  setAttr(rootAttributes, "usage_context_total_tokens", rootUsage?.context_total_tokens);
  setAttr(rootAttributes, "usage_reasoning_tokens", rootUsage?.reasoning_tokens);
  setAttr(rootAttributes, "final_status", statusFromTurn(turn));
  setAttr(rootAttributes, "status", turn.aborted ? "error" : "ok");
  setAttr(rootAttributes, "reason", turn.aborted ? "Turn interrupted by user" : undefined);

  const spans = [
    makeSpan({
      traceId,
      spanId: rootSpanId,
      parentId: ctx.parentSpanId ? ctx.parentSpanId : undefined,
      name: "agent_run",
      start: turn.startTime,
      end: turn.endTime,
      attributes: rootAttributes,
      resource,
      scope,
      ingest,
      status: { code: turn.aborted ? "STATUS_CODE_ERROR" : "STATUS_CODE_UNSET" },
    }),
  ];

  let previousToolResults;
  turn.steps.forEach((step, index) => {
    const generationSpanId = randomSpanId();
    const usage = usageDetails(step.usage);
    const generationInput = index === 0 ? clipValue(turn.userInput, maxChars) : previousToolResults;
    const generationOutput = buildGenerationOutput(step, maxChars);
    const attributes = commonAttributes(config, sessionMeta);
    setAttr(attributes, "run_id", turn.turnId);
    setAttr(attributes, "run_ids", turn.turnId);
    setAttr(attributes, "provider_name", sessionMeta.modelProvider);
    setAttr(attributes, "model_name", turn.model);
    setAttr(attributes, "input_preview", preview(generationInput, maxChars));
    setAttr(attributes, "input_length", preview(generationInput, maxChars)?.length);
    setAttr(attributes, "output_preview", preview(generationOutput, maxChars));
    setAttr(attributes, "output_length", preview(generationOutput, maxChars)?.length);
    setAttr(attributes, "output_kind", step.toolCalls.length > 0 ? "tool_call" : "text");
    setAttr(attributes, "usage_input_tokens", usage?.input);
    setAttr(attributes, "usage_output_tokens", usage?.output);
    setAttr(attributes, "usage_total_tokens", usage?.total);
    setAttr(attributes, "usage_cache_read_input_tokens", usage?.cache_read_input_tokens);
    setAttr(attributes, "usage_cache_total_tokens", usage?.cache_total_tokens);
    setAttr(attributes, "usage_context_input_tokens", usage?.context_input_tokens);
    setAttr(attributes, "usage_context_total_tokens", usage?.context_total_tokens);
    setAttr(attributes, "usage_reasoning_tokens", usage?.reasoning_tokens);
    setAttr(attributes, "step_index", index);
    setAttr(attributes, "status", "ok");

    spans.push(
      makeSpan({
        traceId,
        spanId: generationSpanId,
        parentId: rootSpanId,
        name: "llm",
        start: step.startTime,
        end: step.endTime,
        attributes,
        resource,
        scope,
        ingest,
      }),
    );

    assistantMessagesFromStep(step).forEach((message, messageIndex) => {
      const assistantStart = Number.isFinite(message.startTime) ? message.startTime : step.startTime;
      const assistantEnd =
        Number.isFinite(message.endTime) && message.endTime >= assistantStart
          ? message.endTime
          : assistantStart;
      const assistantAttributes = commonAttributes(config, sessionMeta);
      setAttr(assistantAttributes, "run_id", turn.turnId);
      setAttr(assistantAttributes, "run_ids", turn.turnId);
      setAttr(assistantAttributes, "provider_name", sessionMeta.modelProvider);
      setAttr(assistantAttributes, "model_name", turn.model);
      setAttr(assistantAttributes, "role", "assistant");
      setAttr(assistantAttributes, "output_preview", preview(message.text, maxChars));
      setAttr(assistantAttributes, "output_length", message.text?.length);
      setAttr(assistantAttributes, "output_kind", "text");
      setAttr(assistantAttributes, "assistant_message_start_time", isoFromMs(assistantStart));
      setAttr(assistantAttributes, "assistant_message_end_time", isoFromMs(assistantEnd));
      setAttr(
        assistantAttributes,
        "assistant_message_event_time",
        Number.isFinite(message.eventTime) ? isoFromMs(message.eventTime) : undefined,
      );
      setAttr(assistantAttributes, "step_index", index);
      setAttr(assistantAttributes, "message_index", messageIndex);
      setAttr(assistantAttributes, "status", "ok");

      spans.push(
        makeSpan({
          traceId,
          parentId: generationSpanId,
          name: "assistant",
          start: assistantStart,
          end: assistantEnd,
          attributes: assistantAttributes,
          resource,
          scope,
          ingest,
        }),
      );
    });

    for (const tc of step.toolCalls) {
      const toolAttributes = commonAttributes(config, sessionMeta);
      const command = toolCommand(tc);
      setAttr(toolAttributes, "run_id", turn.turnId);
      setAttr(toolAttributes, "run_ids", turn.turnId);
      setAttr(toolAttributes, "provider_name", sessionMeta.modelProvider);
      setAttr(toolAttributes, "model_name", turn.model);
      setAttr(toolAttributes, "tool_name", tc.name || "tool");
      setAttr(toolAttributes, "tool_call_id", tc.callId);
      setAttr(toolAttributes, "tool_command", preview(command, maxChars));
      setAttr(toolAttributes, "tool_args_preview", preview(tc.args, maxChars));
      setAttr(toolAttributes, "tool_result_preview", preview(toText(tc.output), maxChars));
      setAttr(toolAttributes, "tool_result_status", tc.error ? "error" : "completed");
      setAttr(toolAttributes, "status", tc.error ? "error" : "ok");
      setAttr(toolAttributes, "reason", tc.error ? clipValue(tc.error, maxChars) : undefined);
      spans.push(
        makeSpan({
          traceId,
          parentId: generationSpanId,
          name: `tool:${tc.name || "tool"}`,
          start: tc.startTime,
          end: tc.endTime ?? step.endTime,
          attributes: toolAttributes,
          resource,
          scope,
          ingest,
          status: { code: tc.error ? "STATUS_CODE_ERROR" : "STATUS_CODE_UNSET", message: tc.error },
        }),
      );
    }

    previousToolResults =
      step.toolCalls.length > 0
        ? step.toolCalls.map((tc) => ({
            name: tc.name,
            output: tc.output != null ? clipValue(toText(tc.output), maxChars) : undefined,
            ...(tc.error ? { error: clipValue(tc.error, maxChars) } : {}),
          }))
        : undefined;
  });

  return { spans, traceId, rootSpanId };
}

function serialize(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function findSubagentRollout(parentFile, threadId) {
  const suffix = `-${threadId}.jsonl`;
  const root = path.resolve(path.dirname(parentFile), "../../..");

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(full);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return full;
      }
    }
    return undefined;
  }

  return walk(root);
}

export async function collectRollout(rolloutFile, config, ctx = {}) {
  const { sessionMeta, turns } = parseSession(await loadRollout(rolloutFile));
  const allSpans = [];
  const completedTurnIds = [];

  if (ctx.parentSpanId) {
    for (const turn of turns) {
      if (!isObservableTurn(turn)) continue;
      const built = buildTurnSpans(turn, sessionMeta, config, {
        rolloutFile,
        traceId: ctx.traceId,
        parentSpanId: ctx.parentSpanId,
      });
      allSpans.push(...built.spans);
    }
    return { sessionMeta, turns, spans: allSpans, completedTurnIds };
  }

  const uploaded = await loadUploadedTurnIds(rolloutFile);
  for (const turn of turns) {
    if (turn.completed && turn.turnId && uploaded.has(turn.turnId)) continue;
    if (!isObservableTurn(turn)) continue;

    const built = buildTurnSpans(turn, sessionMeta, config, { rolloutFile });
    allSpans.push(...built.spans);

    for (const threadId of turn.subagentThreadIds) {
      const subFile = await findSubagentRollout(rolloutFile, threadId);
      if (!subFile) continue;
      const sub = await collectRollout(subFile, config, {
        traceId: built.traceId,
        parentSpanId: built.rootSpanId,
      });
      allSpans.push(...sub.spans);
    }

    if (turn.completed && turn.turnId) {
      uploaded.add(turn.turnId);
      completedTurnIds.push(turn.turnId);
    }
  }

  return { sessionMeta, turns, spans: allSpans, completedTurnIds };
}
