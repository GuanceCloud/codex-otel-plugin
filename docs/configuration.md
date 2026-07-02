# 配置说明

本文档说明 `codex-otel-plugin` 的 Hook 配置读取顺序、推荐配置、认证方式和全局 `resourceAttributes` 约定。

## 配置读取顺序

Codex hook 按以下顺序读取配置：

1. `~/.codex/gtrace.json`
2. 当前项目下的 `.codex/gtrace.json`

运行时配置只支持 `gtrace.json` 文件，不再支持通过环境变量覆盖。

## 推荐 Dataway/GTrace 配置

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

不要把真实 token 写入仓库文件、测试 fixture 或文档示例。

## 本地调试配置

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

## 完整 OTLP URL 配置

如果 trace 和 metrics 使用完整 OTLP URL，可以直接配置：

```json
{
  "enabled": true,
  "otel_traces_url": "http://localhost:4318/v1/traces",
  "otel_metrics_url": "http://localhost:4318/v1/metrics",
  "timeout_ms": 25000,
  "debug": true
}
```

兼容配置字段：

- `base_url`
- `otel_traces_url`
- `otel_metrics_url`
- `public_key`
- `secret_key`
- `resourceAttributes`
- `timeout_ms`

`timeout_ms` 是单次 HTTP 请求超时，默认 `25000` 毫秒。trace 和 metrics 分别各发一次请求；如果你的接收端链路较慢，可以显式调大。

## 认证

兼容 Basic Auth：

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

如果 `headers.Authorization` 已配置，hook 会优先使用该值，不再自动覆盖；否则可以通过 `public_key` / `secret_key` 自动补 Basic Auth。

## Resource Attributes

全局筛选类 tag 应放在 OTLP `resource.attributes`，trace 和 metrics 会共享同一批 `resourceAttributes`。推荐字段：

- `host`
- `deployment.environment`
- `app_id`
- `app_name`
- `agent_type`
- `agent_source`

说明：

- `host` 默认自动采集当前宿主机 hostname，也可通过 `resourceAttributes.host` 覆盖。
- 不要把 `run_id`、真实用户输入或高基数一次性字段放进 `resourceAttributes`。
- 安装脚本的 `--tag KEY=VALUE` 会把值写入 `resourceAttributes`。
- `tags` 只作为兼容输入保留，运行时会被折叠进 `resourceAttributes`；新配置不需要同时保留 `tags`、`metadata` 和 `resourceAttributes` 三份相同内容。
- `metadata` 会写成 span attributes；只有你明确需要把某些自定义字段复制到每个 span 上时才需要配置它。

如需调整配置，请直接修改 `~/.codex/gtrace.json` 或当前项目 `.codex/gtrace.json`。
