import * as fs from "node:fs/promises";

import { isPrimitive, toText } from "./codex-utils.js";

export async function loadRollout(file) {
  const data = await fs.readFile(file, "utf-8");
  const lines = [];
  for (const raw of data.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed rollout lines.
    }
  }
  return lines;
}

function extractMessageText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (["input_text", "output_text", "text"].includes(part.type)) {
        return typeof part.text === "string" ? part.text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isSyntheticUserContext(text) {
  const trimmed = text.trim();
  return Boolean(
    /^<(environment_context|user_instructions)\b/.test(trimmed) ||
      trimmed.startsWith("# AGENTS.md instructions") ||
      trimmed.includes("<environment_context>") ||
      trimmed.includes("<permissions instructions>"),
  );
}

function extractReasoning(item) {
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((entry) =>
        entry && typeof entry === "object" && "text" in entry ? toText(entry.text) : toText(entry),
      )
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(item.summary) && item.summary.length > 0) {
    return item.summary.map((entry) => toText(entry)).filter(Boolean).join("\n");
  }
  return "";
}

function parseArgs(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractToolError(payload) {
  const explicit = payload.error ?? payload.codex_error_info;
  if (explicit != null) return isPrimitive(explicit) ? String(explicit) : JSON.stringify(explicit);
  const streams = [payload.stdout, payload.stderr]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n");
  if (typeof payload.aggregated_output === "string" && payload.aggregated_output) {
    return payload.aggregated_output;
  }
  if (streams) return streams;
  if (typeof payload.exit_code === "number") return `Exit code: ${payload.exit_code}`;
  return undefined;
}

function newTurn(startTime) {
  return {
    turnId: undefined,
    startTime,
    endTime: startTime,
    steps: [],
    subagentThreadIds: [],
    completed: false,
    aborted: false,
  };
}

export function parseSession(lines) {
  let sessionMeta = { sessionId: "unknown" };
  const turns = [];
  let turn = null;
  let step = null;
  let toolCallsById = new Map();
  let lastTimestamp = Date.now();

  function newStep(startTime) {
    return { startTime, endTime: startTime, toolCalls: [] };
  }

  function ensureTurn(ts) {
    if (!turn) turn = newTurn(ts);
    return turn;
  }

  function ensureStep(ts) {
    if (!step) step = newStep(ts);
    return step;
  }

  function closeStep(ts, usage) {
    if (!step) return;
    step.endTime = Math.max(step.endTime, ts);
    if (usage) step.usage = usage;
    turn.steps.push(step);
    step = null;
  }

  function inferCompleted(currentTurn) {
    return Boolean(
      currentTurn?.lastAgentMessage ||
        currentTurn?.finalOutput ||
        currentTurn?.steps?.some((item) => item.text),
    );
  }

  function finishTurn(ts, opts) {
    if (!turn) return;
    closeStep(ts);
    turn.endTime = Math.max(turn.endTime, ts);
    turn.completed = opts.completed;
    turn.aborted = opts.aborted;
    turn.userInput = turn.userInput ?? turn.userInputFallback;
    turn.finalOutput = turn.lastAgentMessage ?? turn.steps.filter((s) => s.text).at(-1)?.text;
    delete turn.lastAgentMessage;
    delete turn.userInputFallback;
    turns.push(turn);
    turn = null;
    toolCallsById = new Map();
  }

  function finishCurrentTurn(ts, opts = {}) {
    finishTurn(ts, {
      completed: opts.completed ?? inferCompleted(turn),
      aborted: opts.aborted ?? false,
    });
  }

  for (const line of lines) {
    const ts = Number.isFinite(Date.parse(line.timestamp)) ? Date.parse(line.timestamp) : lastTimestamp;
    lastTimestamp = ts;

    if (line.type === "session_meta") {
      const p = line.payload ?? {};
      sessionMeta = {
        sessionId: typeof p.id === "string" ? p.id : sessionMeta.sessionId,
        cliVersion: p.cli_version,
        modelProvider: p.model_provider ?? undefined,
        baseInstructions: p.base_instructions?.text,
      };
      continue;
    }

    if (line.type === "turn_context") {
      const t = ensureTurn(ts);
      const p = line.payload ?? {};
      t.model = p.model ?? t.model;
      t.invocationParams = p;
      continue;
    }

    if (line.type === "response_item") {
      const p = line.payload ?? {};
      ensureTurn(ts);

      if (p.type === "message") {
        const text = extractMessageText(p.content);
        if (p.role === "assistant") {
          const s = ensureStep(ts);
          if (text) s.text = s.text ? `${s.text}\n${text}` : text;
        } else if (p.role === "user" && text) {
          if (!turn.userInputFallback && !isSyntheticUserContext(text)) {
            turn.userInputFallback = text;
          }
        }
      } else if (p.type === "function_call") {
        const s = ensureStep(ts);
        const tc = {
          callId: p.call_id,
          name: p.name,
          args: parseArgs(p.arguments),
          startTime: ts,
        };
        s.toolCalls.push(tc);
        toolCallsById.set(tc.callId, tc);
      } else if (p.type === "custom_tool_call") {
        const s = ensureStep(ts);
        const tc = {
          callId: p.call_id,
          name: p.name,
          args: parseArgs(p.input),
          startTime: ts,
        };
        s.toolCalls.push(tc);
        toolCallsById.set(tc.callId, tc);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const tc = toolCallsById.get(p.call_id);
        if (tc) {
          if (tc.output == null) tc.output = p.output;
          tc.endTime = Math.max(tc.endTime ?? ts, ts);
        }
      } else if (p.type === "reasoning") {
        const reasoning = extractReasoning(p);
        if (reasoning) {
          const s = ensureStep(ts);
          s.reasoning = s.reasoning ? `${s.reasoning}\n${reasoning}` : reasoning;
        }
      }
      continue;
    }

    if (line.type === "event_msg") {
      const p = line.payload ?? {};
      const et = p.type;

      if (et === "task_started") {
        if (turn) finishCurrentTurn(ts);
        turn = newTurn(ts);
        turn.turnId = typeof p.turn_id === "string" ? p.turn_id : undefined;
        continue;
      }

      ensureTurn(ts);

      if (et === "user_message" && typeof p.message === "string") {
        if (!turn.userInput) turn.userInput = p.message;
      } else if (et === "agent_message" && typeof p.message === "string") {
        turn.lastAgentMessage = p.message;
      } else if (et === "token_count") {
        if (p.info?.total_token_usage) turn.totalUsage = p.info.total_token_usage;
        closeStep(ts, p.info?.last_token_usage ?? undefined);
      } else if (et === "task_complete") {
        if (typeof p.last_agent_message === "string") turn.lastAgentMessage = p.last_agent_message;
        finishTurn(ts, { completed: true, aborted: false });
      } else if (et === "turn_aborted") {
        finishTurn(ts, { completed: true, aborted: true });
      } else {
        if (et === "collab_agent_spawn_end" && typeof p.new_thread_id === "string") {
          turn.subagentThreadIds.push(p.new_thread_id);
        }
        if (typeof p.call_id === "string" && typeof et === "string" && et.endsWith("_end")) {
          const tc = toolCallsById.get(p.call_id);
          if (tc) {
            tc.endTime = Math.max(tc.endTime ?? ts, ts);
            if (p.status === "failed" || p.status === "declined") tc.error = extractToolError(p);
            if (tc.output == null) tc.output = p.aggregated_output ?? p.stdout ?? p.result;
          }
        }
      }
    }
  }

  if (turn) finishCurrentTurn(lastTimestamp);
  return { sessionMeta, turns };
}
