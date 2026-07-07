import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadRollout, parseSession } from "./codex-parse.js";
import { loadUploadedTurnStates } from "./codex-sidecar.js";
import { clipValue, toText } from "./codex-utils.js";

const ATTR = {
  agentName: "gen_ai.agent.name",
  agentVersion: "gen_ai.agent.version",
  conversationId: "gen_ai.conversation.id",
  inputMessages: "gen_ai.input.messages",
  operationName: "gen_ai.operation.name",
  outputMessages: "gen_ai.output.messages",
  outputType: "gen_ai.output.type",
  providerName: "gen_ai.provider.name",
  requestChoiceCount: "gen_ai.request.choice.count",
  requestFrequencyPenalty: "gen_ai.request.frequency_penalty",
  requestMaxTokens: "gen_ai.request.max_tokens",
  requestModel: "gen_ai.request.model",
  requestPresencePenalty: "gen_ai.request.presence_penalty",
  requestSeed: "gen_ai.request.seed",
  requestStopSequences: "gen_ai.request.stop_sequences",
  requestTemperature: "gen_ai.request.temperature",
  requestTopP: "gen_ai.request.top_p",
  responseFinishReasons: "gen_ai.response.finish_reasons",
  responseModel: "gen_ai.response.model",
  skillDescriptionCompat: "skill.description",
  skillDescription: "gen_ai.skill.description",
  skillCallId: "skill_call_id",
  systemInstructions: "gen_ai.system_instructions",
  skillNameGenAi: "gen_ai.skill.name",
  skillName: "skill.name",
  skillPath: "skill.path",
  skillPathGenAi: "gen_ai.skill.path",
  skillResultStatusGenAi: "gen_ai.skill.result.status",
  skillSourceType: "skill.source.type",
  skillSourceTypeGenAi: "gen_ai.skill.source.type",
  skillResultStatus: "skill.result_status",
  skillVersion: "gen_ai.skill.version",
  toolDefinitions: "gen_ai.tool.definitions",
  toolCallArguments: "gen_ai.tool.call.arguments",
  toolCallId: "gen_ai.tool.call.id",
  toolCallResult: "gen_ai.tool.call.result",
  toolName: "gen_ai.tool.name",
  usageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  usageInputTokens: "gen_ai.usage.input_tokens",
  usageOutputTokens: "gen_ai.usage.output_tokens",
  usageReasoningOutputTokens: "gen_ai.usage.reasoning.output_tokens",
};

const SKILL_FILE_PATTERN = /\/[^\s"'`]+\/SKILL\.md\b/g;
const ABSOLUTE_PATH_PATTERN = /\/[^\s"'`]+/g;

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
  if (typeof input === "number") details.input = input;
  if (typeof output === "number") details.output = output;
  if (typeof cacheRead === "number") details.cache_read_input_tokens = cacheRead;
  if (typeof usage.reasoning_output_tokens === "number") details.reasoning_output_tokens = usage.reasoning_output_tokens;
  return Object.keys(details).length > 0 ? details : undefined;
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

function isTerminalTurn(turn) {
  return Boolean(turn?.completed || turn?.aborted);
}

function preview(value, maxChars) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : serialize(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? clipValue(normalized, maxChars) : undefined;
}

function normalizeFilePath(value) {
  if (typeof value !== "string" || !value) return undefined;
  return value.replace(/\\/g, "/");
}

function yamlScalar(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseSkillFrontmatter(content) {
  if (typeof content !== "string") return {};
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return {};

  const out = {};
  let section;
  for (const line of match[1].split("\n")) {
    const entry = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!entry) continue;

    const indent = entry[1].length;
    const key = entry[2];
    const value = yamlScalar(entry[3]);
    if (indent === 0) {
      section = value === undefined ? key : undefined;
      if (value !== undefined) out[key] = value;
      continue;
    }

    if (section === "metadata" && value !== undefined) out[`metadata.${key}`] = value;
  }

  return out;
}

function extractSkillDescription(content) {
  if (typeof content !== "string") return undefined;
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
  const lines = body.split("\n");
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || line.startsWith("#")) continue;
    return line;
  }
  return undefined;
}

async function loadSkillMetadata(skillFile, cache) {
  const normalized = normalizeFilePath(skillFile);
  if (!normalized) return undefined;

  const cached = cache?.get(normalized);
  if (cached) return await cached;

  const task = (async () => {
    try {
      const content = await fs.readFile(normalized, "utf-8");
      const frontmatter = parseSkillFrontmatter(content);
      let version = frontmatter.version ?? frontmatter["metadata.version"];
      if (!version) {
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(normalized), "package.json"), "utf-8"));
          version = typeof pkg?.version === "string" ? pkg.version : undefined;
        } catch {
          // package.json is optional for skills
        }
      }

      return {
        description: frontmatter.description ?? extractSkillDescription(content),
        version,
      };
    } catch {
      return {};
    }
  })();

  cache?.set(normalized, task);
  const metadata = await task;
  cache?.set(normalized, metadata);
  return metadata;
}

function durationMs(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function normalizeBounds(start, end) {
  if (!Number.isFinite(start)) return { start, end };
  return {
    start,
    end: Number.isFinite(end) && end > start ? end : start + 1,
  };
}

function setAttr(attributes, key, value) {
  if (value !== undefined && value !== null) attributes[key] = value;
}

function setModelAttrs(attributes, model) {
  setAttr(attributes, ATTR.requestModel, model);
  setAttr(attributes, ATTR.responseModel, model);
}

function setUsageAttrs(attributes, usage) {
  setAttr(attributes, ATTR.usageInputTokens, usage?.input);
  setAttr(attributes, ATTR.usageOutputTokens, usage?.output);
  setAttr(attributes, ATTR.usageCacheReadInputTokens, usage?.cache_read_input_tokens);
  setAttr(attributes, ATTR.usageReasoningOutputTokens, usage?.reasoning_output_tokens);
}

function messageValue(value, maxChars) {
  if (value === undefined || value === null) return undefined;
  return clipValue(serialize(value), maxChars);
}

function clipStructuredValue(value, maxChars) {
  if (typeof value === "string") return clipValue(value, maxChars);
  if (Array.isArray(value)) return value.map((entry) => clipStructuredValue(entry, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clipStructuredValue(entry, maxChars)]),
    );
  }
  return value;
}

function collectStringValues(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringValues(entry, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStringValues(entry, out);
  }
  return out;
}

function textPart(value, maxChars) {
  const content = messageValue(value, maxChars);
  return content ? { type: "text", content } : undefined;
}

function reasoningPart(value, maxChars) {
  const content = messageValue(value, maxChars);
  return content ? { type: "reasoning", content } : undefined;
}

function toolCallRequestPart(tc, maxChars) {
  if (!tc?.name) return undefined;
  const part = {
    type: "tool_call",
    name: tc.name,
  };
  setAttr(part, "id", tc.callId);
  setAttr(part, "arguments", messageValue(tc.args, maxChars));
  return part;
}

function toolCallResponsePart(tc, maxChars) {
  const output = messageValue(tc.output, maxChars);
  const error = messageValue(tc.error, maxChars);
  if (output === undefined && error === undefined) return undefined;

  const part = {
    type: "tool_call_response",
    response:
      error === undefined
        ? output
        : {
            ...(output !== undefined ? { output } : {}),
            error,
          },
  };
  setAttr(part, "id", tc.callId);
  return part;
}

function buildInputMessages(userInput, toolCalls, maxChars) {
  const messages = [];
  const userText = textPart(userInput, maxChars);
  if (userText) messages.push({ role: "user", parts: [userText] });

  for (const tc of toolCalls ?? []) {
    const part = toolCallResponsePart(tc, maxChars);
    if (!part) continue;
    const message = { role: "tool", parts: [part] };
    setAttr(message, "name", tc.name);
    messages.push(message);
  }

  return messages.length > 0 ? messages : undefined;
}

function buildOutputMessages({ text, reasoning, toolCalls, finishReason }, maxChars) {
  const parts = [];
  const reasoningMessagePart = reasoningPart(reasoning, maxChars);
  const textMessagePart = textPart(text, maxChars);
  if (reasoningMessagePart) parts.push(reasoningMessagePart);
  if (textMessagePart) parts.push(textMessagePart);
  for (const tc of toolCalls ?? []) {
    const toolCallPart = toolCallRequestPart(tc, maxChars);
    if (toolCallPart) parts.push(toolCallPart);
  }
  if (parts.length === 0) return undefined;
  return [
    {
      role: "assistant",
      parts,
      finish_reason: finishReason,
    },
  ];
}

function numericAttr(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerAttr(value) {
  return Number.isInteger(value) ? value : undefined;
}

function choiceCountAttr(value) {
  return Number.isInteger(value) && value !== 1 ? value : undefined;
}

function stringArrayAttr(value) {
  if (Array.isArray(value)) {
    const out = value.map((entry) => String(entry)).filter(Boolean);
    return out.length > 0 ? out : undefined;
  }
  if (typeof value === "string" && value) return [value];
  return undefined;
}

function normalizeOutputType(value) {
  const text = typeof value === "string" ? value : value?.type;
  if (!text) return "text";
  const normalized = String(text).toLowerCase();
  if (normalized === "text") return "text";
  if (normalized === "image") return "image";
  if (normalized === "speech" || normalized === "audio") return "speech";
  if (normalized.includes("json")) return "json";
  return normalized;
}

function buildSystemInstructions(sessionMeta, invocationParams, maxChars) {
  const entries = [
    sessionMeta.baseInstructions,
    invocationParams?.collaboration_mode?.settings?.developer_instructions,
  ]
    .filter((value, index, array) => typeof value === "string" && value && array.indexOf(value) === index)
    .map((value) => textPart(value, maxChars))
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function normalizeToolDefinition(definition) {
  if (!definition || typeof definition !== "object") return definition;
  if (definition.type || !definition.name) return definition;
  return {
    type: "function",
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.parameters ? { parameters: definition.parameters } : {}),
  };
}

function buildToolDefinitions(invocationParams, maxChars) {
  const raw =
    invocationParams?.tools ??
    invocationParams?.tool_definitions ??
    invocationParams?.available_tools ??
    invocationParams?.functions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((definition) => clipStructuredValue(normalizeToolDefinition(definition), maxChars));
}

function setRequestAttributes(attributes, invocationParams, maxChars) {
  const outputType = normalizeOutputType(
    invocationParams?.output_type ?? invocationParams?.outputType ?? invocationParams?.response_format,
  );
  setAttr(attributes, ATTR.outputType, outputType);
  setAttr(attributes, ATTR.requestChoiceCount, choiceCountAttr(invocationParams?.n ?? invocationParams?.choice_count));
  setAttr(attributes, ATTR.requestSeed, integerAttr(invocationParams?.seed));
  setAttr(attributes, ATTR.requestTemperature, numericAttr(invocationParams?.temperature));
  setAttr(attributes, ATTR.requestTopP, numericAttr(invocationParams?.top_p));
  setAttr(attributes, ATTR.requestMaxTokens, integerAttr(invocationParams?.max_tokens ?? invocationParams?.max_output_tokens));
  setAttr(attributes, ATTR.requestPresencePenalty, numericAttr(invocationParams?.presence_penalty));
  setAttr(attributes, ATTR.requestFrequencyPenalty, numericAttr(invocationParams?.frequency_penalty));
  setAttr(attributes, ATTR.requestStopSequences, stringArrayAttr(invocationParams?.stop_sequences ?? invocationParams?.stop));
  setAttr(attributes, ATTR.toolDefinitions, buildToolDefinitions(invocationParams, maxChars));
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
  const bounds = normalizeBounds(start, end);
  return {
    trace_id: traceId,
    span_id: spanId,
    parent_id: parentId,
    name,
    kind: "SPAN_KIND_INTERNAL",
    start_time_unix_nano: nsFromMs(bounds.start).toString(),
    end_time_unix_nano: nsFromMs(bounds.end).toString(),
    start_time: isoFromMs(bounds.start),
    end_time: isoFromMs(bounds.end),
    duration_ms: durationMs(bounds.start, bounds.end),
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
      session_id: attributes[ATTR.conversationId],
      user_id: attributes.user_id,
    },
    observation: {
      type: observationTypeFromSpanName(spanName),
      model_name: attributes[ATTR.responseModel] ?? attributes[ATTR.requestModel],
      usage: usageFromAttributes(attributes),
    },
  };
}

function observationTypeFromSpanName(spanName) {
  if (spanName === "invoke_agent") return "agent";
  if (spanName === "llm") return "llm";
  if (spanName === "assistant") return "assistant";
  if (String(spanName).startsWith("skill:")) return "skill";
  if (String(spanName).startsWith("tool:")) return "tool";
  return undefined;
}

function usageFromAttributes(attributes) {
  const usage = {};
  if (typeof attributes[ATTR.usageInputTokens] === "number") usage.input = attributes[ATTR.usageInputTokens];
  if (typeof attributes[ATTR.usageOutputTokens] === "number") usage.output = attributes[ATTR.usageOutputTokens];
  if (typeof usage.input === "number" || typeof usage.output === "number") {
    usage.total = (usage.input ?? 0) + (usage.output ?? 0);
  }
  if (typeof attributes[ATTR.usageCacheReadInputTokens] === "number") {
    usage.cache_read_input_tokens = attributes[ATTR.usageCacheReadInputTokens];
  }
  if (typeof attributes[ATTR.usageReasoningOutputTokens] === "number") {
    usage.reasoning_tokens = attributes[ATTR.usageReasoningOutputTokens];
  }
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

function matchesFromText(text, pattern) {
  if (typeof text !== "string" || !text) return [];
  return Array.from(new Set(text.match(pattern) ?? []));
}

function skillSourceTypeFromPath(skillFile) {
  if (skillFile.includes("/.codex/skills/.system/")) return "system";
  if (skillFile.includes("/.codex/skills/")) return "user";
  return "workspace";
}

function skillContextFromSkillFile(skillFile) {
  const normalized = normalizeFilePath(skillFile);
  if (!normalized) return undefined;
  const rootPath = path.posix.dirname(normalized);
  const skillName = rootPath.split("/").filter(Boolean).at(-1);
  if (!skillName) return undefined;
  return {
    skillName,
    skillFile: normalized,
    rootPath,
    skillSourceType: skillSourceTypeFromPath(normalized),
  };
}

function detectSkillRefs(toolCall, activeSkillContexts = new Map()) {
  const refs = new Map();
  for (const text of collectStringValues(toolCall?.args)) {
    for (const skillFile of matchesFromText(text, SKILL_FILE_PATTERN)) {
      const direct = skillContextFromSkillFile(skillFile);
      if (!direct) continue;
      refs.set(direct.rootPath, { ...direct, resourcePath: direct.skillFile, direct: true });
    }

    for (const resourcePath of matchesFromText(text, ABSOLUTE_PATH_PATTERN)) {
      const normalized = normalizeFilePath(resourcePath);
      if (!normalized) continue;
      for (const active of activeSkillContexts.values()) {
        if (normalized === active.skillFile || normalized.startsWith(`${active.rootPath}/`)) {
          refs.set(active.rootPath, { ...active, resourcePath: normalized, direct: false });
        }
      }
    }
  }
  return Array.from(refs.values());
}

function buildSkillContexts(toolCalls = []) {
  const contexts = new Map();
  const toolCallToSkill = new Map();

  for (const toolCall of toolCalls) {
    const refs = detectSkillRefs(toolCall, contexts);
    if (refs.length !== 1) continue;

    const ref = refs[0];
    const context =
      contexts.get(ref.rootPath) ??
      {
        skillName: ref.skillName,
        skillFile: ref.skillFile,
        rootPath: ref.rootPath,
        skillSourceType: ref.skillSourceType,
      };
    contexts.set(ref.rootPath, context);
    toolCallToSkill.set(toolCall, context);
  }

  return {
    toolCallToSkill,
  };
}

function mergeSkillOutputPreview(toolCalls, maxChars) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  if (toolCalls.length === 1) return preview(toText(toolCalls[0]?.output), maxChars);

  const outputs = toolCalls
    .map((tc) => ({
      name: tc?.name,
      output: tc?.output != null ? clipValue(toText(tc.output), maxChars) : undefined,
      ...(tc?.error ? { error: clipValue(tc.error, maxChars) } : {}),
    }))
    .filter((entry) => entry.output !== undefined || entry.error !== undefined);
  return outputs.length > 0 ? preview(outputs, maxChars) : undefined;
}

async function populateTurnSkillMetadata(turn, cache) {
  if (!cache) return;
  for (const step of turn.steps ?? []) {
    const { toolCallToSkill } = buildSkillContexts(step.toolCalls);
    for (const skill of toolCallToSkill.values()) {
      if (!skill?.skillFile) continue;
      await loadSkillMetadata(skill.skillFile, cache);
    }
  }
}

function setSkillAttributes(attributes, skill, metadata, resultStatus, skillCallId, maxChars) {
  const description = preview(metadata?.description, maxChars);
  setAttr(attributes, ATTR.skillName, skill?.skillName);
  setAttr(attributes, ATTR.skillDescriptionCompat, description);
  setAttr(attributes, ATTR.skillPath, skill?.skillFile);
  setAttr(attributes, ATTR.skillSourceType, skill?.skillSourceType);
  setAttr(attributes, ATTR.skillResultStatus, resultStatus);
  setAttr(attributes, ATTR.skillCallId, skill ? skillCallId : undefined);

  setAttr(attributes, ATTR.skillNameGenAi, skill?.skillName);
  setAttr(attributes, ATTR.skillPathGenAi, skill?.skillFile);
  setAttr(attributes, ATTR.skillSourceTypeGenAi, skill?.skillSourceType);
  setAttr(attributes, ATTR.skillResultStatusGenAi, resultStatus);
  setAttr(attributes, ATTR.skillDescription, description);
  setAttr(attributes, ATTR.skillVersion, metadata?.version);
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

function latestStepChildEndTime(step) {
  const assistantEnds = assistantMessagesFromStep(step).map((message) => message.endTime ?? message.startTime);
  const toolEnds = step.toolCalls.map((tc) => tc.endTime ?? step.endTime);
  return Math.max(step.endTime, ...assistantEnds, ...toolEnds);
}

function llmRequestStartTime(turn, steps, index) {
  if (index <= 0) return turn.startTime;
  const previousStep = steps[index - 1];
  if (!previousStep) return turn.startTime;
  return latestStepChildEndTime(previousStep);
}

function commonAttributes(config, sessionMeta) {
  const attributes = {
    [ATTR.agentName]: "codex",
    [ATTR.agentVersion]: sessionMeta.cliVersion,
    [ATTR.conversationId]: sessionMeta.sessionId,
    session_id: sessionMeta.sessionId,
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
    host: os.hostname(),
    agent_runtime: "codex",
    [ATTR.agentVersion]: sessionMeta.cliVersion,
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
  const systemInstructions = buildSystemInstructions(sessionMeta, turn.invocationParams, maxChars);

  const rootAttributes = commonAttributes(config, sessionMeta);
  setAttr(rootAttributes, "run_id", turn.turnId);
  setAttr(rootAttributes, "run_ids", turn.turnId);
  setAttr(rootAttributes, ATTR.operationName, "invoke_agent");
  setAttr(rootAttributes, ATTR.providerName, sessionMeta.modelProvider);
  setModelAttrs(rootAttributes, turn.model);
  setRequestAttributes(rootAttributes, turn.invocationParams, maxChars);
  setAttr(rootAttributes, ATTR.systemInstructions, systemInstructions);
  setAttr(rootAttributes, ATTR.responseFinishReasons, [turn.aborted ? "cancelled" : "stop"]);
  setAttr(rootAttributes, "session_create_at", sessionMeta.createdAt);
  setAttr(rootAttributes, "session_updated_at", isoFromMs(turn.endTime));
  setAttr(rootAttributes, "session_channel", sessionMeta.channel);
  setAttr(rootAttributes, "input_preview", preview(turn.userInput, maxChars));
  setAttr(rootAttributes, "input_length", turn.userInput?.length);
  setAttr(rootAttributes, "output_preview", preview(turn.finalOutput, maxChars));
  setAttr(rootAttributes, "output_length", turn.finalOutput?.length);
  setAttr(rootAttributes, ATTR.inputMessages, buildInputMessages(turn.userInput, [], maxChars));
  setAttr(
    rootAttributes,
    ATTR.outputMessages,
    buildOutputMessages(
      {
        text: turn.finalOutput,
        toolCalls: [],
        finishReason: turn.aborted ? "cancelled" : "stop",
      },
      maxChars,
    ),
  );
  setAttr(rootAttributes, "tool_count", turn.steps.reduce((n, s) => n + s.toolCalls.length, 0));
  setAttr(rootAttributes, "final_status", statusFromTurn(turn));
  setAttr(rootAttributes, "status", turn.aborted ? "error" : "ok");
  setAttr(rootAttributes, "reason", turn.aborted ? "Turn interrupted by user" : undefined);
  setAttr(rootAttributes, "error.type", turn.aborted ? "_OTHER" : undefined);

  const spans = [
    makeSpan({
      traceId,
      spanId: rootSpanId,
      parentId: ctx.parentSpanId ? ctx.parentSpanId : undefined,
      name: "invoke_agent",
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
  let previousToolCalls;
  turn.steps.forEach((step, index) => {
    const generationSpanId = randomSpanId();
    const { toolCallToSkill } = buildSkillContexts(step.toolCalls);
    const skillGroups = new Map();
    const usage = usageDetails(step.usage);
    const llmRequestStart = llmRequestStartTime(turn, turn.steps, index);
    const ttft =
      Number.isFinite(llmRequestStart) && Number.isFinite(step.startTime) && step.startTime >= llmRequestStart
        ? step.startTime - llmRequestStart
        : 0;
    const llmEndTime = latestStepChildEndTime(step);
    const generationInput = index === 0 ? clipValue(turn.userInput, maxChars) : previousToolResults;
    const generationOutput = buildGenerationOutput(step, maxChars);
    const attributes = commonAttributes(config, sessionMeta);
    setAttr(attributes, "run_id", turn.turnId);
    setAttr(attributes, "run_ids", turn.turnId);
    setAttr(attributes, ATTR.operationName, "chat");
    setAttr(attributes, ATTR.providerName, sessionMeta.modelProvider);
    setModelAttrs(attributes, turn.model);
    setRequestAttributes(attributes, turn.invocationParams, maxChars);
    setAttr(attributes, ATTR.systemInstructions, systemInstructions);
    setAttr(attributes, ATTR.responseFinishReasons, [step.toolCalls.length > 0 ? "tool_call" : "stop"]);
    setAttr(attributes, "input_preview", preview(generationInput, maxChars));
    setAttr(attributes, "input_length", preview(generationInput, maxChars)?.length);
    setAttr(attributes, "output_preview", preview(generationOutput, maxChars));
    setAttr(attributes, "output_length", preview(generationOutput, maxChars)?.length);
    setAttr(
      attributes,
      ATTR.inputMessages,
      buildInputMessages(index === 0 ? turn.userInput : undefined, previousToolCalls, maxChars),
    );
    setAttr(
      attributes,
      ATTR.outputMessages,
      buildOutputMessages(
        {
          text: step.text,
          reasoning: step.reasoning,
          toolCalls: step.toolCalls,
          finishReason: step.toolCalls.length > 0 ? "tool_call" : "stop",
        },
        maxChars,
      ),
    );
    setAttr(attributes, "output_kind", step.toolCalls.length > 0 ? "tool_call" : "text");
    setUsageAttrs(attributes, usage);
    setAttr(attributes, "step_index", index);
    setAttr(attributes, "ttft", ttft);
    setAttr(attributes, "status", "ok");

    spans.push(
      makeSpan({
        traceId,
        spanId: generationSpanId,
        parentId: rootSpanId,
        name: "llm",
        start: ttft > 0 ? llmRequestStart : step.startTime,
        end: llmEndTime,
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
      setAttr(assistantAttributes, ATTR.providerName, sessionMeta.modelProvider);
      setModelAttrs(assistantAttributes, turn.model);
      setAttr(assistantAttributes, ATTR.outputType, "text");
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
      const skill = toolCallToSkill.get(tc);
      const skillMetadata = skill?.skillFile ? ctx.skillMetadataCache?.get(skill.skillFile) : undefined;
      const toolAttributes = commonAttributes(config, sessionMeta);
      const command = toolCommand(tc);
      const toolSpanId = randomSpanId();
      setAttr(toolAttributes, "run_id", turn.turnId);
      setAttr(toolAttributes, "run_ids", turn.turnId);
      setAttr(toolAttributes, ATTR.operationName, "execute_tool");
      setAttr(toolAttributes, ATTR.providerName, sessionMeta.modelProvider);
      setModelAttrs(toolAttributes, turn.model);
      setAttr(toolAttributes, ATTR.toolName, tc.name || "tool");
      setAttr(toolAttributes, ATTR.toolCallId, tc.callId);
      setAttr(toolAttributes, "tool_command", preview(command, maxChars));
      setAttr(toolAttributes, ATTR.toolCallArguments, preview(tc.args, maxChars));
      setAttr(toolAttributes, ATTR.toolCallResult, preview(toText(tc.output), maxChars));
      setSkillAttributes(
        toolAttributes,
        skill,
        skillMetadata,
        skill ? (tc.error ? "error" : "completed") : undefined,
        tc.callId,
        maxChars,
      );
      setAttr(toolAttributes, "tool_result_status", tc.error ? "error" : "completed");
      setAttr(toolAttributes, "status", tc.error ? "error" : "ok");
      setAttr(toolAttributes, "reason", tc.error ? clipValue(tc.error, maxChars) : undefined);
      setAttr(toolAttributes, "error.type", tc.error ? "_OTHER" : undefined);
      spans.push(
        makeSpan({
          traceId,
          spanId: toolSpanId,
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

      if (!skill) continue;
      const skillKey = skill.rootPath ?? skill.skillFile ?? skill.skillName;
      if (!skillGroups.has(skillKey)) {
        skillGroups.set(skillKey, {
          skill,
          metadata: skillMetadata,
          toolSpans: [],
          toolCalls: [],
        });
      }
      const group = skillGroups.get(skillKey);
      group.toolSpans.push({ spanId: toolSpanId, toolCall: tc });
      group.toolCalls.push(tc);
      if (!group.metadata && skillMetadata) group.metadata = skillMetadata;
    }

    for (const group of skillGroups.values()) {
      const { skill, metadata, toolSpans, toolCalls } = group;
      const hasError = toolCalls.some((tc) => tc.error);
      const firstStart = Math.min(...toolCalls.map((tc) => tc.startTime));
      const lastEnd = Math.max(...toolCalls.map((tc) => tc.endTime ?? step.endTime));
      const singleTool = toolSpans.length === 1 ? toolSpans[0] : undefined;
      const skillAttributes = commonAttributes(config, sessionMeta);
      setAttr(skillAttributes, "run_id", turn.turnId);
      setAttr(skillAttributes, "run_ids", turn.turnId);
      setAttr(skillAttributes, ATTR.operationName, "skill");
      setAttr(skillAttributes, ATTR.providerName, sessionMeta.modelProvider);
      setModelAttrs(skillAttributes, turn.model);
      setSkillAttributes(
        skillAttributes,
        skill,
        metadata,
        hasError ? "error" : "completed",
        singleTool?.toolCall?.callId,
        maxChars,
      );
      setAttr(skillAttributes, "tool_count", toolSpans.length);
      setAttr(skillAttributes, "input_preview", preview(skill.skillFile, maxChars));
      setAttr(skillAttributes, "output_preview", mergeSkillOutputPreview(toolCalls, maxChars));
      setAttr(skillAttributes, "status", hasError ? "error" : "ok");
      setAttr(
        skillAttributes,
        "reason",
        hasError ? clipValue(toolCalls.map((tc) => tc.error).filter(Boolean).join("\n"), maxChars) : undefined,
      );
      setAttr(skillAttributes, "error.type", hasError ? "_OTHER" : undefined);

      spans.push(
        makeSpan({
          traceId,
          parentId: singleTool ? singleTool.spanId : generationSpanId,
          name: `skill:${skill.skillName}`,
          start: firstStart,
          end: lastEnd,
          attributes: skillAttributes,
          resource,
          scope,
          ingest,
          status: {
            code: hasError ? "STATUS_CODE_ERROR" : "STATUS_CODE_UNSET",
            message: hasError ? toolCalls.map((tc) => tc.error).filter(Boolean).join("\n") : undefined,
          },
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
    previousToolCalls = step.toolCalls.length > 0 ? step.toolCalls : undefined;
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

function turnFingerprint(turn) {
  const digest = crypto.createHash("sha256");
  digest.update(
    JSON.stringify({
      turnId: turn.turnId,
      completed: turn.completed,
      aborted: turn.aborted,
      startTime: turn.startTime,
      endTime: turn.endTime,
      model: turn.model,
      userInput: turn.userInput,
      finalOutput: turn.finalOutput,
      subagentThreadIds: turn.subagentThreadIds,
      steps: turn.steps.map((step) => ({
        startTime: step.startTime,
        endTime: step.endTime,
        text: step.text,
        reasoning: step.reasoning,
        usage: step.usage,
        assistantMessages: step.assistantMessages,
        toolCalls: step.toolCalls,
      })),
    }),
  );
  return digest.digest("hex");
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
  const uploadedTurnStates = [];
  const skillMetadataCache = new Map();

  if (ctx.parentSpanId) {
    for (const turn of turns) {
      if (!isObservableTurn(turn)) continue;
      await populateTurnSkillMetadata(turn, skillMetadataCache);
      const built = buildTurnSpans(turn, sessionMeta, config, {
        rolloutFile,
        traceId: ctx.traceId,
        parentSpanId: ctx.parentSpanId,
        skillMetadataCache,
      });
      allSpans.push(...built.spans);
    }
    return { sessionMeta, turns, spans: allSpans, uploadedTurnStates };
  }

  const uploaded = await loadUploadedTurnStates(rolloutFile);
  for (const turn of turns) {
    if (!isObservableTurn(turn)) continue;
    if (!isTerminalTurn(turn)) continue;
    await populateTurnSkillMetadata(turn, skillMetadataCache);
    const fingerprint = turn.turnId ? turnFingerprint(turn) : undefined;
    const uploadedState = turn.turnId ? uploaded.get(turn.turnId) : undefined;
    if (turn.turnId && uploadedState) continue;

    const built = buildTurnSpans(turn, sessionMeta, config, { rolloutFile, skillMetadataCache });
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

    if (turn.turnId && fingerprint) {
      uploaded.set(turn.turnId, fingerprint);
      uploadedTurnStates.push({ turnId: turn.turnId, fingerprint });
    }
  }

  return { sessionMeta, turns, spans: allSpans, uploadedTurnStates };
}
