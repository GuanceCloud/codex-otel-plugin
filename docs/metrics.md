# Metrics 指标设计

本文档说明 codex-otel-plugin 的 OTLP Metrics 指标体系、派生规则、tag 口径和配置约定。

当前 Metrics 按 OpenTelemetry GenAI semantic conventions 输出；metrics 仍从同批 trace spans 派生，不重新解析 transcript。

## 上报链路

```text
Codex Stop hook
    |
    v
src/codex-hook-wrapper.js
    |
    v
src/codex-collector.js 生成 spans
    |
    v
src/codex-metrics.js 从 spans 派生 metrics
    |
    v
src/codex-otlp.js / src/proto.js 编码 OTLP Metrics protobuf
    |
    v
POST <endpoint>/<metricsPath>
```

如果 `collectRollout()` 产出的 spans 为空，traces 和 metrics 都不上报。典型场景是只有启动上下文、没有真实用户输入、模型输出、工具调用或 token usage 的空白 turn。

## 指标清单

| 指标名 | 类型 | 单位 | 来源 | 描述 |
| --- | --- | --- | --- | --- |
| `gen_ai.workflow.duration` | Histogram | `s` | `agent_run` span duration | Codex turn 端到端工作流耗时。 |
| `gen_ai.client.operation.duration` | Histogram | `s` | `llm`、`tool:*` span duration | GenAI client operation 耗时。 |
| `gen_ai.client.token.usage` | Histogram | `{token}` | `llm` span 的 `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | 模型调用输入、输出 token 用量。 |

当前不生成：

- `gen_ai.client.operation.time_to_first_chunk`: Codex rollout 当前没有稳定首 chunk 时间来源。
- `gen_ai.client.operation.time_per_output_chunk`: Codex Stop hook 只做结束后解析，不做流式 chunk 计时。
- `gen_ai.server.*`: 本插件采集的是 Codex 客户端侧行为，不是模型服务端。
- 旧 `gen_ai.agent.*` 自定义指标：已替换为官方 GenAI 指标。

## Tag 设计

### Resource Attributes

resource attributes 适合放“一个实例/一个 Agent/一个部署周期内相对稳定”的全局 tag。当前默认包含：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `service.name` | 固定值 | 当前为 `gtrace-codex`。 |
| `telemetry.sdk.language` | 固定值 | 当前为 `nodejs`。 |
| `telemetry.sdk.name` | 固定值 | 当前为 `gtrace`。 |
| `telemetry.sdk.version` | 固定值 | 当前插件内置采集版本。 |
| `host` | 自动采集 | 当前宿主机 hostname。 |
| `agent_runtime` | 固定值 | 当前为 `codex`。 |
| `gen_ai.agent.version` | rollout session meta | Codex CLI 版本。 |
| `runtime_environment` | 配置 `environment` | 运行环境。 |

推荐额外补充：

| 字段 | 说明 |
| --- | --- |
| `deployment.environment` | prod/test/dev 等环境隔离。 |
| `app_id` | 监测应用或 Agent 应用 ID。 |
| `app_name` | 页面展示用应用名。 |
| `agent_type` | Agent 类型，例如 `assistant`、`workflow-agent`。 |
| `agent_source` | Agent 来源，例如 `codex`、`sdk`、`api`。 |

`resourceAttributes` 会合并到 trace resource 和 metrics resource。安装脚本的 `--tag KEY=VALUE` 也会写入 `resourceAttributes`。

### 通用 Tags

以下 tags 适用于当前 metrics：

| tag | 来源 | 说明 |
| --- | --- | --- |
| `gen_ai.conversation.id` | span attributes | Codex session ID，用于和 trace 会话字段对齐。 |
| `gen_ai.operation.name` | span attributes | `chat` 或 `execute_tool`；`gen_ai.workflow.duration` 不带该 tag。 |
| `gen_ai.provider.name` | span attributes | 模型供应商，例如 `openai`。 |
| `gen_ai.request.model` | span attributes | 请求模型名称。 |
| `gen_ai.response.model` | span attributes | 响应模型名称。 |
| `error.type` | span attributes | 错误类型；错误时当前为 `_OTHER`。 |

`run_id` 不作为默认 metrics tag。按单次 turn 排查时应优先使用 trace。

### Workflow Tags

`gen_ai.workflow.duration` 额外包含：

| tag | 来源 | 说明 |
| --- | --- | --- |
| `final_status` | `agent_run.attributes.final_status` | `completed`、`cancelled`、`unset` 或 `error`。 |

### Tool Tags

`gen_ai.client.operation.duration` 在 `gen_ai.operation.name=execute_tool` 时额外包含：

| tag | 来源 | 说明 |
| --- | --- | --- |
| `gen_ai.tool.name` | `tool:*` span attributes | 工具名称。 |
| `tool_result_status` | `tool:*` span attributes | `completed` 或 `error`。 |

### Token Tags

`gen_ai.client.token.usage` 额外包含：

| tag | 说明 |
| --- | --- |
| `gen_ai.token.type` | `input` 或 `output`。 |

token 指标只从 `llm` span 派生，不从 `agent_run` 汇总字段派生，避免同一次模型调用被重复计数。

## Token 映射

| `llm` span 字段 | Metric | `gen_ai.token.type` | 说明 |
| --- | --- | --- | --- |
| `gen_ai.usage.input_tokens` | `gen_ai.client.token.usage` | `input` | 输入 token，包含缓存命中输入 token。 |
| `gen_ai.usage.output_tokens` | `gen_ai.client.token.usage` | `output` | 输出 token。 |

`gen_ai.usage.cache_read.input_tokens` 和 `gen_ai.usage.reasoning.output_tokens` 只保留在 trace span attributes 中，不生成默认 token metric。OpenTelemetry 当前 `gen_ai.token.type` 只定义 `input` 和 `output`，避免继续输出旧的 `cache_read`、`cache_total`、`reasoning`、`total` 自定义 token type。

token 值不存在、不是数字或小于等于 0 时，不生成对应 data point。

## OTLP 形态

Metrics 使用 OTLP Metrics HTTP/protobuf 上报。当前三个指标均使用 OTLP `Histogram`，每次观测生成一个 data point：

- `aggregationTemporality`: `AGGREGATION_TEMPORALITY_DELTA`
- `count`: `1`
- `sum`: 当前观测值
- `min`: 当前观测值
- `max`: 当前观测值

`gen_ai.client.operation.duration` bucket：

```text
0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92
```

`gen_ai.workflow.duration` bucket：

```text
1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200
```

token histogram bucket：

```text
1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864
```

## 指标变更关系

| 旧指标 / tag | 新指标 / tag |
| --- | --- |
| `gen_ai.agent.request.count` | 停止输出 |
| `gen_ai.agent.request.duration` | `gen_ai.workflow.duration` |
| `gen_ai.agent.operation.count` | 停止输出 |
| `gen_ai.agent.operation.duration` | `gen_ai.client.operation.duration` |
| `gen_ai.agent.token.usage` | `gen_ai.client.token.usage` |
| `session_id` | `gen_ai.conversation.id` |
| `provider_name` | `gen_ai.provider.name` |
| `model_name` | `gen_ai.request.model`、`gen_ai.response.model` |
| `operation_name` | `gen_ai.operation.name` |
| `tool_name` | `gen_ai.tool.name` |
| `token_type` | `gen_ai.token.type` |
| `token_type=total/cache_read/cache_total/reasoning` | 停止输出，只保留 trace attributes |
| duration unit `ms` | duration unit `s` |

## 配置与调试

推荐 Dataway/GTrace 配置：

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

本地 server 接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/public/otel/v1/metrics` | 接收 OTLP Metrics JSON/protobuf。 |
| `GET` | `/metrics?limit=50` | 查看最近规范化 metric data point。 |

修改 metrics 指标名、tag、token 映射或 OTLP 编码时，至少同步：

- `src/codex-metrics.js`
- `src/codex-otlp.js`
- `src/proto.js`
- `src/otlp.js`
- `test/ingest-smoke.test.js`
- `README.md`
- `docs/metrics.md`
- `docs/traces.md`
- `AGENTS.md`

修改 hook 上报协议时必须验证 OTLP Metrics protobuf 路径，不只验证 JSON 路径。
