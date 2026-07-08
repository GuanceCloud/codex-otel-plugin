# codex-otel-plugin

`codex-otel-plugin` is an observability plugin for Codex. It reads Codex rollout transcripts from the Stop hook, converts each Codex turn into OpenTelemetry OTLP Traces and Metrics, and uploads them over HTTP/protobuf.

The current implementation uses only built-in Node.js modules and has no runtime npm dependencies.

## Capabilities

- Collect Codex turns, model calls, skill resource usage, tool calls, structured input/output messages, request parameters, and token usage.
- Emit five span classes: `invoke_agent`, `llm`, `assistant`, `skill:<name>`, and `tool:<name>`.
- Merge repeated reads of the same skill directory inside one `llm` step into a single `skill:<name>` span while keeping each underlying tool call span.
- Upload both OTLP Traces and OTLP Metrics over HTTP/protobuf.
- Derive metrics from the same trace spans and upload them at the same time as traces, without periodic flushing.
- Support Dataway / GTrace-style `endpoint + tracePath + metricsPath + headers` configuration.
- Provide a local ingest/debug server for inspecting OTLP JSON/protobuf payloads.

## Flow

```text
Codex Stop hook
    |
    v
src/codex-hook-wrapper.js
    |
    v
src/codex-parse.js parses rollout JSONL
    |
    v
src/codex-collector.js builds spans
    |
    v
src/codex-metrics.js derives metrics from spans
    |
    v
src/codex-otlp.js / src/proto.js encode OTLP protobuf
    |
    v
POST <endpoint>/<tracePath>
POST <endpoint>/<metricsPath>
```

## Quick Start

Requirements:

- Node.js >= 22
- `curl`, `tar`, and `gzip` for remote installation

The recommended path is the remote installer:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest \
      --endpoint https://llm-openway.guance.com \
      --x-token <token>
```

Restart Codex after installation so the Stop hook is reloaded.

If `codex-observability-plugin` is also installed on the same machine, the installer removes its `tracing` plugin and clears stale config entries so the same transcript is not uploaded twice.

If the receiver is occasionally slow, the default timeout for a single OTLP HTTP request is `25000ms`. You can override it with `timeout_ms` in `~/.codex/gtrace.json`.

See [docs/install.md](docs/install.md) for installation, upgrade, uninstall, and installer options.

## Documentation

| Document | Description |
| --- | --- |
| [docs/install.md](docs/install.md) | Installation, upgrade, uninstall, installer options, and development install |
| [docs/configuration.md](docs/configuration.md) | Hook config, authentication, and `resourceAttributes` conventions |
| [docs/development.md](docs/development.md) | Local debug server, verification commands, and troubleshooting |
| [docs/traces.md](docs/traces.md) | Trace/span structure, field naming, token semantics, and UI guidance |
| [docs/metrics.md](docs/metrics.md) | Metric design, tags, token mapping, and OTLP shape |

## Data Model

See [docs/traces.md](docs/traces.md) for trace fields, span names, `gen_ai.input.messages` / `gen_ai.output.messages`, tool result fields, token semantics, and UI guidance.

See [docs/metrics.md](docs/metrics.md) for the metric model, tag design, and OTLP encoding choices.

The current skill-related fields keep compatibility `skill.*` fields while also adding project-specific `gen_ai.skill.*` extensions. `description` and `version` are emitted only when they can be extracted reliably from local skill metadata. `skill.description` and `skill_call_id` remain trace-only attributes. See [docs/traces.md](docs/traces.md) and [docs/metrics.md](docs/metrics.md) for the exact field list.

Current metrics derived from each turn's spans:

- `gen_ai.workflow.duration`
- `gen_ai.agent.operation.count`
- `gen_ai.agent.operation.duration`
- `gen_ai.client.token.usage`

`gen_ai.agent.operation.count` is emitted once per operation span (`model`, `tool`, `skill`) with trimmed count-specific attributes. `gen_ai.agent.operation.duration` remains span-based and keeps the richer operation context.

Metrics include `gen_ai.conversation.id` and the compatibility field `session_id`, but they do not include `session_key` or `run_id`. Global filter tags should be placed in OTLP `resource.attributes` through `resourceAttributes` so traces and metrics can share them. Field migration notes are documented in [docs/traces.md](docs/traces.md) and [docs/metrics.md](docs/metrics.md).

## Development

Common commands:

```bash
npm test
npm ls --all
npm start
npm run codex:hook
```

See [docs/development.md](docs/development.md) for more local debugging, verification, and troubleshooting details.
