# Trace Fields

This document describes the OTLP Trace model emitted by `codex-otel-plugin`: span structure, field naming, token semantics, and UI guidance. See [metrics.md](metrics.md) for metric semantics.

Trace attributes are emitted using OpenTelemetry GenAI semantic conventions where possible and follow the [GTrace AI Trace Semantic Conventions](https://github.com/GuanceCloud/guance-gtrace-ai-semantic-conventions/blob/main/docs/en/trace-semantic-conventions.md). The current span names are `invoke_agent`, `llm`, `assistant`, `skill:<name>`, and `tool:<name>`.

## Trace Structure

One Codex turn produces a trace tree like this:

```text
invoke_agent
├── llm
├── tool:exec_command
│   └── skill:plugin-creator
├── llm
└── assistant
```

Span relationships:

- `invoke_agent` is the root span for a Codex turn and maps to `gen_ai.operation.name=invoke_agent`.
- `llm` is a single model call. Its parent is `invoke_agent`, and it maps to `gen_ai.operation.name=chat`.
- `assistant` is a single assistant message output. Its parent is `invoke_agent`, and it does not carry token usage.
- `tool:<name>` is a single tool call. Its parent is `invoke_agent`, and it maps to `gen_ai.operation.name=execute_tool`. `triggered_by.llm_span_id` preserves the triggering model-call relationship.
- `skill:<name>` represents one confirmed Skill resource use. Its parent is always the corresponding `tool:<name>` span and it maps to `gen_ai.operation.name=skill`. Different tools that access the same Skill keep separate `skill:*` children.
- If a tool call cannot be confidently attributed to a skill, only the `tool:*` span is kept.
- The `llm` span covers only the real model request. It is never extended to cover a later assistant event or tool completion.

## Skill Detection Rules

Codex transcripts do not currently contain a native `skill_invoked` event. The plugin therefore uses high-confidence detection only:

- If tool arguments directly contain a `.../SKILL.md` path, create the matching `skill:<name>` span.
- If later tool arguments keep accessing files under the same skill directory, attribute each confirmed access to its own corresponding tool call. Do not merge different tools into an `llm -> skill` span.
- If the transcript only mentions a skill name, only lists skills, or cannot be stably linked to a skill directory, no `skill:*` span is created.

## Resource Attributes

Default resource attributes:

| Field | Meaning |
| --- | --- |
| `service.name` | `gtrace-codex` |
| `telemetry.sdk.language` | `nodejs` |
| `telemetry.sdk.name` | `gtrace` |
| `telemetry.sdk.version` | built-in plugin collector version |
| `host` | current hostname |
| `agent_runtime` | `codex` |
| `gen_ai.agent.version` | Codex CLI version |
| `runtime_environment` | runtime environment from config `environment` |

Configured `resourceAttributes` are merged into every trace resource. They are appropriate for global tags shared across traces and metrics, such as `deployment.environment`, `app_id`, `app_name`, `agent_type`, and `agent_source`. Do not put `run_id`, real user input, or high-cardinality one-shot values into resource attributes.

## GenAI Attributes

### Session, Agent, and Model

| Field | Meaning | Typical spans |
| --- | --- | --- |
| `gen_ai.conversation.id` | Codex session ID | all |
| `session_id` | compatibility alias with the same value as `gen_ai.conversation.id` | all |
| `gen_ai.agent.name` | agent name, currently `codex` | all |
| `gen_ai.agent.version` | agent version, currently the Codex CLI version | all |
| `gen_ai.operation.name` | GenAI operation name: `invoke_agent`, `chat`, `skill`, `execute_tool` | `invoke_agent`, `llm`, `skill:*`, `tool:*` |
| `gen_ai.output.type` | declared output type; currently `text` for normal Codex chat requests and `json` for explicit JSON output requests | `invoke_agent`, `llm`, `assistant` |
| `gen_ai.input.messages` | structured input messages array, using the OpenTelemetry GenAI message schema | `invoke_agent`, `llm` |
| `gen_ai.output.messages` | structured output messages array, using the OpenTelemetry GenAI message schema | `invoke_agent`, `llm`, `assistant` |
| `gen_ai.provider.name` | model provider, for example `openai` | `invoke_agent`, `llm`, `assistant`, `tool:*` |
| `gen_ai.request.model` | requested model name | `invoke_agent`, `llm`, `assistant`, `tool:*` |
| `gen_ai.response.model` | response model name | `invoke_agent`, `llm`, `assistant`, `tool:*` |
| `gen_ai.response.finish_reasons` | finish reason array for the generation | `invoke_agent`, `llm` |

Current message mapping rules:

- `invoke_agent.gen_ai.input.messages`: the current turn's user input
- `invoke_agent.gen_ai.output.messages`: the current turn's final assistant output
- the first `llm.gen_ai.input.messages`: the user input
- later `llm.gen_ai.input.messages`: previous tool results, emitted as `role=tool` with `tool_call_response` parts
- `llm.gen_ai.output.messages`: the current model output; text replies use `text`, reasoning uses `reasoning`, and tool requests use `tool_call`
- `assistant.gen_ai.output.messages`: the emitted assistant message itself, using the same structured message schema as other spans
- `gen_ai.response.finish_reasons`: currently mapped to `stop`, `tool_call`, or `cancelled`

### Request Fields

| Field | Meaning | Typical spans |
| --- | --- | --- |
| `gen_ai.request.choice.count` | requested number of choices | `invoke_agent`, `llm` |
| `gen_ai.request.seed` | request seed | `invoke_agent`, `llm` |
| `gen_ai.request.temperature` | request temperature | `invoke_agent`, `llm` |
| `gen_ai.request.top_p` | request top_p | `invoke_agent`, `llm` |
| `gen_ai.request.max_tokens` | requested max output tokens | `invoke_agent`, `llm` |
| `gen_ai.request.presence_penalty` | request presence penalty | `invoke_agent`, `llm` |
| `gen_ai.request.frequency_penalty` | request frequency penalty | `invoke_agent`, `llm` |
| `gen_ai.request.stop_sequences` | request stop sequences | `invoke_agent`, `llm` |
| `gen_ai.system_instructions` | system instructions, currently extracted from `base_instructions` and developer instructions | `invoke_agent`, `llm` |
| `gen_ai.tool.definitions` | available tool definitions, currently extracted from `turn_context.tools` and related fields | `invoke_agent`, `llm` |

### Skill Fields

As of 2026-06-25, `skill` still has no first-class OpenTelemetry GenAI semantic field. This plugin keeps the existing compatibility fields while adding project-specific `gen_ai.skill.*` extensions. `gen_ai.skill.name`, `gen_ai.skill.description`, and `gen_ai.skill.version` are aligned with community direction but are not yet formal standard fields.

| Field | Meaning | Typical spans |
| --- | --- | --- |
| `skill.name` | skill name, derived from the directory that contains `SKILL.md` | `skill:*`, `tool:*` |
| `skill.description` | skill description, equal to `gen_ai.skill.description`; prefers `description` from `SKILL.md` frontmatter and falls back to the first descriptive paragraph | `skill:*`, `tool:*` |
| `skill.path` | absolute path to the skill entry file, currently the detected `.../SKILL.md` | `skill:*`, `tool:*` |
| `skill_call_id` | tool call ID that ties the `skill:*` span to the triggering tool call | `skill:*`, `tool:*` |
| `skill.source.type` | skill source type, currently `system`, `user`, or `workspace` | `skill:*`, `tool:*` |
| `skill.result_status` | skill result status, currently `completed` or `error` depending on child tools | `skill:*`, `tool:*` |
| `gen_ai.skill.name` | `gen_ai.*` extension for the skill name | `skill:*`, `tool:*` |
| `gen_ai.skill.path` | `gen_ai.*` extension for the absolute skill entry path | `skill:*`, `tool:*` |
| `gen_ai.skill.source.type` | `gen_ai.*` extension for the skill source type | `skill:*`, `tool:*` |
| `gen_ai.skill.result.status` | `gen_ai.*` extension for the skill result status | `skill:*`, `tool:*` |
| `gen_ai.skill.description` | skill description; prefers `description` in `SKILL.md` frontmatter and falls back to the first descriptive paragraph | `skill:*`, `tool:*` |
| `gen_ai.skill.version` | skill version; prefers `SKILL.md` frontmatter, then `package.json.version` in the same directory; omitted when no stable metadata exists | `skill:*`, `tool:*` |

### Token Fields

| Field | Meaning | Typical spans |
| --- | --- | --- |
| `gen_ai.usage.input_tokens` | input tokens, including cache-hit input tokens | `invoke_agent`, `llm` |
| `gen_ai.usage.output_tokens` | output tokens | `invoke_agent`, `llm` |
| `gen_ai.usage.cache_read.input_tokens` | provider-managed cache-hit input tokens | `invoke_agent`, `llm` |
| `gen_ai.usage.reasoning.output_tokens` | reasoning output tokens | `invoke_agent`, `llm` |

`llm.gen_ai.usage.*` always describes one model call. `invoke_agent.gen_ai.usage.*` contains the current turn aggregate, preferably from Codex `total_token_usage` and otherwise from the sum of its model calls. `assistant` spans do not carry token usage.

`gen_ai.usage.input_tokens` follows the OpenTelemetry meaning of full input tokens, so it differs from older `usage_input_tokens` semantics that excluded cached input tokens.

### Tool Fields

| Field | Meaning | Typical spans |
| --- | --- | --- |
| `gen_ai.tool.name` | tool name | `tool:*` |
| `gen_ai.tool.call.id` | tool call ID | `tool:*` |
| `gen_ai.tool.call.arguments` | clipped tool argument preview | `tool:*` |
| `gen_ai.tool.call.result` | clipped tool result; strings keep original line breaks, objects and arrays keep their structure | `tool:*` |
| `triggered_by.llm_span_id` | span ID of the `llm` call that triggered the tool | `tool:*` |

`tool_command` is still preserved as a project field and is extracted from `args.cmd` or `args.command`.

## Project-Specific Fields

These fields do not have a direct GenAI standard equivalent or are intentionally kept as plugin-specific troubleshooting fields:

| Field | Meaning | Typical spans |
| --- | --- | --- |
| `run_id` / `run_ids` | current turn ID | all |
| `session_create_at` | session creation time | `invoke_agent` |
| `session_updated_at` | session update time for the current turn | `invoke_agent` |
| `session_channel` | session source channel | `invoke_agent` |
| `ttft` | time to first token, in milliseconds | `llm` |
| `input_preview` / `input_length` | input preview and length | `invoke_agent`, `llm` |
| `output_preview` / `output_length` | output preview and length | `invoke_agent`, `llm`, `assistant` |
| `output_kind` | output kind such as `text` or `tool_call` | `llm`, `assistant` |
| `tool_count` | number of tool calls in the current turn | `invoke_agent` |
| `tool_command` | target command for the tool | `tool:*` |
| `tool_result_status` | tool result status, `completed` or `error` | `tool:*` |
| `final_status` | terminal turn status | `invoke_agent` |
| `status` | business status, usually `ok` or `error`; operation metrics derive their `status` tag from this field and related terminal state fields | all |
| `reason` | error or cancellation reason | `invoke_agent`, `tool:*` |
| `error.type` | OpenTelemetry error type, currently `_OTHER` for error cases | `invoke_agent`, `tool:*` |

Current `final_status` values:

| Value | Meaning |
| --- | --- |
| `completed` | the turn completed |
| `cancelled` | the turn was interrupted or cancelled |
| `unset` | completion could not be confirmed |

The Stop hook may run before `task_complete` is written. The parser infers `completed` if an `agent_message`, final assistant output, or a textual step already exists.

To avoid separate trace chains for the same `turn_id` in intermediate and terminal states, only terminal turns are uploaded: `completed` or `cancelled`. `unset` stays internal and does not normally appear in OTLP Trace uploads. Once a terminal turn is written to the transcript `.gtrace` sidecar, it is never uploaded again even if re-parsing later produces a different fingerprint.

Blank turns that contain only startup context and no real user input, model output, tool call, or token usage are not uploaded.

`llm` span duration includes `ttft` but ends at the model-call `token_count` boundary. The implementation shifts the start time back to the inferred request start and stores the wait separately in `ttft`; later assistant and tool events cannot extend the model-call duration.

## Field Migration Notes

| Old field | New field / handling |
| --- | --- |
| `session_id` | still emitted for compatibility, alongside `gen_ai.conversation.id` |
| no unified structured input/output field | add `gen_ai.input.messages` and `gen_ai.output.messages` |
| `session_agent` | `gen_ai.agent.name` |
| `agent_version` | `gen_ai.agent.version` |
| `provider_name` | `gen_ai.provider.name` |
| `model_name` | `gen_ai.request.model`, `gen_ai.response.model` |
| `tool_name` | `gen_ai.tool.name` |
| `tool_call_id` | `gen_ai.tool.call.id` |
| `tool_args_preview` | `gen_ai.tool.call.arguments` |
| `tool_result_preview` | `gen_ai.tool.call.result` |
| `usage_input_tokens` | stopped; `gen_ai.usage.input_tokens` now means full input tokens including cache hits |
| `usage_output_tokens` | `gen_ai.usage.output_tokens` |
| `usage_total_tokens` | stopped; derive totals from `gen_ai.usage.input_tokens + gen_ai.usage.output_tokens` if needed |
| `usage_cache_read_input_tokens` | `gen_ai.usage.cache_read.input_tokens` |
| `usage_cache_total_tokens` | stopped; currently equivalent to `gen_ai.usage.cache_read.input_tokens` |
| `usage_reasoning_tokens` | `gen_ai.usage.reasoning.output_tokens` |
| `usage_context_input_tokens` | stopped; full input semantics now live in `gen_ai.usage.input_tokens` |
| `usage_context_total_tokens` | stopped |
| `request_model` / `response_model` | not emitted as primary fields; use `gen_ai.request.model` / `gen_ai.response.model` |

## UI Guidance

Recommended top-level overview fields:

| UI label | Field |
| --- | --- |
| Input Tokens | `gen_ai.usage.input_tokens` |
| Output Tokens | `gen_ai.usage.output_tokens` |
| Cache-Hit Tokens | `gen_ai.usage.cache_read.input_tokens` |
| Reasoning Tokens | `gen_ai.usage.reasoning.output_tokens` |

For the "target / command" column in a call-analysis table, prefer `tool_command`, then fall back to `gen_ai.tool.call.arguments`.
