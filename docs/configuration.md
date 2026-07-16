# Configuration

This document describes how `codex-otel-plugin` loads hook configuration, recommended config layouts, authentication, and global `resourceAttributes`.

## Config Resolution Order

The Codex hook loads configuration in this order:

1. `~/.codex/gtrace.json`
2. `.codex/gtrace.json` in the current project

Runtime configuration is file-based only. Environment-variable overrides are no longer supported.

## Script Switch

`enabled` is the Stop hook script switch:

- `true`: read the rollout transcript and upload terminal turns.
- `false`: return immediately before reading stdin or the transcript; no trace or metric request is sent.

The plugin can stay installed and enabled in Codex while this runtime switch is `false`. Changing the JSON value takes effect on the next Stop hook invocation. Normal upgrades preserve the existing value. Use `--enable-script` / `--disable-script` on Linux and macOS, or `-EnableScript` / `-DisableScript` on Windows, only when the installer should change it.

## Recommended Dataway / GTrace Config

```json
{
  "enabled": true,
  "endpoint": "https://llm-openway.guance.com",
  "tracePath": "v1/write/otel-llm",
  "metricsPath": "v1/write/otel-metrics",
  "timeout_ms": 25000,
  "headers": {
    "X-Token": "<token>",
    "To-Headless": "true"
  },
  "resourceAttributes": {
    "deployment.environment": "prod",
    "app_id": "codex-monitor",
    "app_name": "Codex OTEL",
    "agent_type": "assistant",
    "agent_source": "codex"
  },
  "debug": true
}
```

Do not put real tokens into repository files, test fixtures, or documentation examples.

## Local Debug Config

```json
{
  "enabled": true,
  "endpoint": "http://localhost:3030",
  "tracePath": "api/public/otel/v1/traces",
  "metricsPath": "api/public/otel/v1/metrics",
  "timeout_ms": 25000,
  "resourceAttributes": {
    "deployment.environment": "dev",
    "app_id": "codex-local"
  },
  "debug": true
}
```

## Full OTLP URL Config

If traces and metrics use full OTLP URLs, configure them directly:

```json
{
  "enabled": true,
  "otel_traces_url": "http://localhost:4318/v1/traces",
  "otel_metrics_url": "http://localhost:4318/v1/metrics",
  "timeout_ms": 25000,
  "debug": true
}
```

Compatible config fields:

- `base_url`
- `otel_traces_url`
- `otel_metrics_url`
- `public_key`
- `secret_key`
- `resourceAttributes`
- `timeout_ms`

`timeout_ms` is the timeout for a single HTTP request. The default is `25000` milliseconds. Traces and metrics are uploaded as separate requests. Increase this value if your receiver is slow.

## Authentication

Basic Auth is supported:

```json
{
  "enabled": true,
  "endpoint": "http://localhost:3030",
  "tracePath": "api/public/otel/v1/traces",
  "metricsPath": "api/public/otel/v1/metrics",
  "public_key": "pk-test",
  "secret_key": "sk-test"
}
```

If `headers.Authorization` is already configured, the hook keeps it as-is. Otherwise it can synthesize a Basic Auth header from `public_key` and `secret_key`.

## Resource Attributes

Global filter tags should live in OTLP `resource.attributes`. Traces and metrics share the same `resourceAttributes`. Recommended fields:

- `host`
- `deployment.environment`
- `app_id`
- `app_name`
- `agent_type`
- `agent_source`

Notes:

- `host` is collected from the current hostname by default, and can be overridden with `resourceAttributes.host`.
- Do not put `run_id`, real user input, or other one-shot high-cardinality fields into `resourceAttributes`.
- The installer flag `--tag KEY=VALUE` writes values into `resourceAttributes`.
- `tags` is kept only as a compatibility input. At runtime it is folded into `resourceAttributes`. New configs do not need to keep duplicate values across `tags`, `metadata`, and `resourceAttributes`.
- `metadata` is copied into span attributes. Use it only when you explicitly want custom fields repeated on every span.

To change configuration, edit `~/.codex/gtrace.json` or the current project's `.codex/gtrace.json`.
