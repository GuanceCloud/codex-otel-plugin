# Metrics Design

This document describes the OTLP Metrics model in `codex-otel-plugin`, including derivation rules, tag semantics, and OTLP encoding choices.

Metrics are derived from the same trace spans produced for a completed Codex hook run. The plugin does not re-parse the transcript separately for metrics.

Large request-side fields such as `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, and raw tool outputs such as `gen_ai.tool.call.result` stay on trace span attributes only. They are not copied into metric tags to avoid high cardinality and oversized points.

## Upload Pipeline

```text
Codex Stop hook
    |
    v
src/codex-hook-wrapper.js
    |
    v
src/codex-collector.js builds spans
    |
    v
src/codex-metrics.js derives metrics from spans
    |
    v
src/codex-otlp.js / src/proto.js encode OTLP Metrics protobuf
    |
    v
POST <endpoint>/<metricsPath>
```

If `collectRollout()` returns no spans, neither traces nor metrics are uploaded. The common case is a blank turn that contains only startup context and no real user input, model output, tool call, or token usage.

## Metric List

| Metric | Type | Unit | Source | Description |
| --- | --- | --- | --- | --- |
| `gen_ai.workflow.duration` | Histogram | `s` | `invoke_agent` span duration | Duration of a Codex turn. |
| `gen_ai.agent.operation.count` | Sum | `-` | `llm`, `skill:*`, and `tool:*` spans | Count of agent-side operations. One data point is emitted per operation span. |
| `gen_ai.agent.operation.duration` | Histogram | `ms` | `llm`, `skill:*`, and `tool:*` span duration | Duration of agent-side operations. |
| `gen_ai.client.token.usage` | Histogram | `{token}` | `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` on `llm` spans | Input and output token usage for model calls. |

`gen_ai.agent.operation.count` and `gen_ai.agent.operation.duration` currently cover only these operation classes:

- `llm`
- `skill:*`
- `tool:*`

Dimension mapping:

- `llm` -> `gen_ai.operation.name=chat`
- `skill:*` -> `gen_ai.operation.name=skill`
- `tool:*` -> `gen_ai.operation.name=execute_tool`

Not included:

- `invoke_agent`
- `assistant`

`invoke_agent` produces only `gen_ai.workflow.duration`. `assistant` produces neither operation count, operation duration, nor token usage metrics.

Count emission semantics:

- `gen_ai.agent.operation.count` is emitted once per `llm`, `tool:*`, or `skill:*` span.
- Each count data point currently has value `1`.
- Repeated operations are counted by summing points in downstream queries.

Metrics that are not currently emitted:

- `gen_ai.client.operation.time_to_first_chunk`: the Codex rollout does not provide a stable first-chunk timestamp
- `gen_ai.client.operation.time_per_output_chunk`: the Stop hook parses after completion and does not time streaming chunks
- `gen_ai.server.*`: this plugin observes Codex client-side behavior, not model-server internals
- `gen_ai.client.operation.duration`: replaced by the compatibility metric `gen_ai.agent.operation.duration`

## Tag Design

### Resource Attributes

Resource attributes are intended for stable global tags that remain roughly constant for one deployment, one agent instance, or one host lifecycle. By default the plugin includes:

| Field | Source | Notes |
| --- | --- | --- |
| `service.name` | fixed | Always `gtrace-codex` |
| `telemetry.sdk.language` | fixed | Always `nodejs` |
| `telemetry.sdk.name` | fixed | Always `gtrace` |
| `telemetry.sdk.version` | fixed | Built-in plugin collector version |
| `host` | automatic | Current hostname |
| `agent_runtime` | fixed | Always `codex` |
| `gen_ai.agent.version` | rollout session meta | Codex CLI version |
| `runtime_environment` | config `environment` | Runtime environment |

Recommended additions:

| Field | Notes |
| --- | --- |
| `deployment.environment` | prod / test / dev split |
| `app_id` | monitored app or agent application ID |
| `app_name` | display name for the app |
| `agent_type` | agent type such as `assistant` or `workflow-agent` |
| `agent_source` | source such as `codex`, `sdk`, or `api` |

`resourceAttributes` are merged into both trace resources and metric resources. The installer flag `--tag KEY=VALUE` also writes into `resourceAttributes`.

### Common Tags

These tags are applicable to current metrics:

| Tag | Source | Notes |
| --- | --- | --- |
| `gen_ai.conversation.id` | span attributes | Codex session ID, aligned with trace session fields |
| `session_id` | span attributes | Compatibility field with the same value as `gen_ai.conversation.id` |
| `gen_ai.operation.name` | span attributes | Canonical operation name: `chat`, `skill`, or `execute_tool`; workflow metrics do not carry it by default |
| `outcome` | span attributes | Compatibility dimension: `completed` or `error` |
| `provider_name` | span attributes | Compatibility alias for `gen_ai.provider.name` |
| `gen_ai.provider.name` | span attributes | Provider name such as `openai` |
| `request_model` | span attributes | Compatibility alias for `gen_ai.request.model` |
| `gen_ai.request.model` | span attributes | Requested model name |
| `response_model` | span attributes | Compatibility alias for `gen_ai.response.model` |
| `gen_ai.response.model` | span attributes | Response model name |
| `model_name` | span attributes | Uses `response_model`, falling back to `request_model` |
| `error.type` | span attributes | Error type, currently `_OTHER` for error cases |

`run_id` is not included as a default metric tag. Use traces first when debugging a single turn.

### Workflow Tags

`gen_ai.workflow.duration` additionally includes:

| Tag | Source | Notes |
| --- | --- | --- |
| `final_status` | `invoke_agent.attributes.final_status` | Normal uploads use `completed`, `cancelled`, or `error`; unfinished `unset` turns do not currently produce workflow metrics |

### Operation Tags

`gen_ai.agent.operation.count` and `gen_ai.agent.operation.duration` expose these dimensions:

| Tag | Source | Notes |
| --- | --- | --- |
| `agent_runtime` | resource / span | Always `codex` |
| `gen_ai.operation.name=chat` | `llm` span | Count tags keep only `gen_ai.provider.name`, `gen_ai.request.model`, and `gen_ai.response.model`; duration tags still keep the richer compatibility fields |
| `gen_ai.operation.name=execute_tool` | `tool:*` span | Count tags keep only `gen_ai.tool.name`; duration tags still keep tool, model, and skill-related compatibility fields |
| `gen_ai.operation.name=skill` | `skill:*` span | Count tags keep only `gen_ai.skill.name`; duration tags still keep the richer skill-related fields |
| `gen_ai.skill.*` | `skill:*` / `tool:*` span | Preserved so trace and metric queries can align |

`skill.description`, `gen_ai.skill.description`, `gen_ai.skill.path`, and `skill_call_id` are intentionally excluded from default metric tags to avoid long text and high-cardinality values. They remain available on traces only.

For `operation_name=model`, `gen_ai.agent.operation.duration` includes TTFT time. The wait value is still preserved separately as trace attribute `ttft`, in milliseconds.

### Token Tags

`gen_ai.client.token.usage` additionally includes:

| Tag | Notes |
| --- | --- |
| `gen_ai.token.type` | `input` or `output` |

Token metrics are derived only from `llm` spans, never from aggregated `invoke_agent` usage fields, to avoid double counting the same model call.

## Token Mapping

| `llm` span field | Metric | `gen_ai.token.type` | Notes |
| --- | --- | --- | --- |
| `gen_ai.usage.input_tokens` | `gen_ai.client.token.usage` | `input` | Input tokens, including cache-hit input tokens |
| `gen_ai.usage.output_tokens` | `gen_ai.client.token.usage` | `output` | Output tokens |

`gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.reasoning.output_tokens` remain on trace span attributes only. They do not emit default token metrics. OpenTelemetry currently defines only `input` and `output` for `gen_ai.token.type`, so legacy custom token types such as `cache_read`, `cache_total`, `reasoning`, and `total` are not emitted.

If a token value is missing, non-numeric, or less than or equal to zero, the corresponding data point is not generated.

## OTLP Shape

Metrics are uploaded through OTLP Metrics HTTP/protobuf:

- `gen_ai.agent.operation.count` uses OTLP `Sum`
- `gen_ai.workflow.duration`, `gen_ai.agent.operation.duration`, and `gen_ai.client.token.usage` use OTLP `Histogram`
- `aggregationTemporality`: `AGGREGATION_TEMPORALITY_DELTA`
- histogram data points use `count=1`
- histogram `sum`, `min`, and `max` are the current observation value

For `gen_ai.agent.operation.count`, each OTLP data point represents one operation span and carries value `1`.

`gen_ai.agent.operation.duration` buckets:

```text
10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480, 40960, 81920
```

`gen_ai.workflow.duration` buckets:

```text
1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200
```

Token histogram buckets:

```text
1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864
```

## Metric Migration Notes

| Old metric / tag | New metric / tag |
| --- | --- |
| `gen_ai.agent.request.count` | stopped |
| `gen_ai.agent.request.duration` | `gen_ai.workflow.duration` |
| `gen_ai.agent.operation.count` | preserved |
| `gen_ai.agent.operation.duration` | preserved |
| `gen_ai.agent.token.usage` | `gen_ai.client.token.usage` |
| `session_id` | still emitted for compatibility, alongside `gen_ai.conversation.id` |
| `provider_name` | `gen_ai.provider.name` |
| `model_name` | `gen_ai.request.model`, `gen_ai.response.model` |
| `operation_name` | `gen_ai.operation.name` |
| `tool_name` | `gen_ai.tool.name` |
| `token_type` | `gen_ai.token.type` |
| `token_type=total/cache_read/cache_total/reasoning` | stopped; kept only on trace attributes |
| duration unit `ms` | duration unit `s` |

## Config and Debugging

Recommended Dataway / GTrace config:

```json
{
  "enabled": true,
  "endpoint": "https://llm-openway.guance.com",
  "tracePath": "v1/write/otel-llm",
  "metricsPath": "v1/write/otel-metrics",
  "headers": {
    "X-Token": "<token>",
    "To-Headless": "true"
  },
  "debug": true
}
```

Local server endpoints:

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/public/otel/v1/metrics` | Accept OTLP Metrics JSON/protobuf |
| `GET` | `/metrics?limit=50` | Inspect recent normalized metric data points |

When changing metric names, tags, token mapping, or OTLP encoding, update at least:

- `src/codex-metrics.js`
- `src/codex-otlp.js`
- `src/proto.js`
- `src/otlp.js`
- `test/ingest-smoke.test.js`
