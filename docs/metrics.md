# Metrics 指标设计

本文档说明 codex-otel-plugin 的 OTLP Metrics 指标体系、派生规则、tag 口径和配置约定。

## 设计目标

Metrics 用于支撑 Codex turn、模型调用、工具调用和 token 消耗的聚合分析。当前实现遵循以下原则：

- 与 traces 使用同一上报时机：Codex Stop hook 解析 rollout 后，同步上报一次。
- 从当前 turn 已生成的 spans 派生 metrics，不重新解析 transcript。
- 第一版只做 turn 级核心指标，不做 session 累计、不做 runtime 队列或 webhook 类指标。
- 指标名参考 `openclaw-otel-plugin` 当前推荐的 `gen_ai.agent.*` 命名。
- 保持 canonical tag，避免新增 `gtrace.*` 或旧兼容语义前缀字段。
- 默认带 `session_id` / `session_key`，用于和 trace 侧会话字段对齐；默认不带 `run_id`。
- 全局筛选类 tag 放在 OTLP `resource.attributes`，trace 和 metrics 共享同一批 resource attributes。

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
| `gen_ai.agent.request.count` | Counter | `1` | `agent_run` span | Codex turn 请求次数。 |
| `gen_ai.agent.request.duration` | Histogram | `ms` | `agent_run` span duration | Codex turn 总耗时。 |
| `gen_ai.agent.operation.count` | Counter | `1` | `llm`、`tool:*` span | Agent 内部 operation 次数。 |
| `gen_ai.agent.operation.duration` | Histogram | `ms` | `llm`、`tool:*` span duration | Agent 内部 operation 耗时。 |
| `gen_ai.agent.token.usage` | Histogram | `{token}` | `llm` span 的 `usage_*` 字段 | 模型调用 token 用量。 |

当前不生成：

- `gen_ai.agent.session.*`: 需要跨 hook 状态和增量去重，第一版不做。
- `gen_ai.runtime.*`: Codex Stop hook 没有实时队列、webhook、session state 事件来源。
- `gen_ai.client.*`: 保留给 OTEL 原生 GenAI client 语义，本插件当前不写自定义数据。

## Tag 设计

### Resource Attributes

resource attributes 适合放“一个实例/一个 Agent/一个部署周期内相对稳定”的全局 tag。当前默认包含：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `service.name` | 固定值 | 当前为 `gtrace-codex`。 |
| `telemetry.sdk.language` | 固定值 | 当前为 `nodejs`。 |
| `telemetry.sdk.name` | 固定值 | 当前为 `gtrace`。 |
| `telemetry.sdk.version` | 固定值 | 当前插件内置采集版本。 |
| `agent_runtime` | 固定值 | 当前为 `codex`。 |
| `agent_version` | rollout session meta | Codex CLI 版本。 |
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

以下 tags 适用于所有当前 metrics：

| tag | 来源 | 说明 |
| --- | --- | --- |
| `agent_runtime` | span resource / attributes | 当前默认 `codex`。 |
| `session_id` | span attributes | Codex session ID。 |
| `session_key` | span attributes | 会话聚合 key，当前等于 `session_id`。 |
| `provider_name` | span attributes | 模型供应商，例如 `openai`。 |
| `model_name` | span attributes | 模型名称。 |
| `outcome` | span status / attributes | 聚合分析结果状态。 |

`run_id` 不作为默认 metrics tag。按单次 turn 排查时应优先使用 trace。

### Request Tags

`gen_ai.agent.request.count` 和 `gen_ai.agent.request.duration` 额外包含：

| tag | 来源 | 说明 |
| --- | --- | --- |
| `session_agent` | `agent_run.attributes.session_agent` | 当前为 `codex`。 |
| `final_status` | `agent_run.attributes.final_status` | `completed`、`cancelled` 或 `unset`。 |

request 指标的 `outcome` 优先来自 `final_status`。如果 span 明确为 error，则为 `error`。

### Operation Tags

`gen_ai.agent.operation.count` 和 `gen_ai.agent.operation.duration` 额外包含：

| tag | 适用范围 | 说明 |
| --- | --- | --- |
| `operation_name` | 全部 operation | `model` 或 `tool`。 |
| `tool_name` | `operation_name=tool` | 工具名称。 |
| `tool_result_status` | `operation_name=tool` | `completed` 或 `error`。 |

model operation 来自 `llm` span。tool operation 来自 `tool:*` span。

operation 指标的 `outcome` 规则：

- 工具 `tool_result_status=error` 时为 `error`。
- span attributes `status=error` 或 OTLP status error 时为 `error`。
- 其他情况为 `completed`。

### Token Tags

`gen_ai.agent.token.usage` 额外包含：

| tag | 说明 |
| --- | --- |
| `token_type` | token 类型，见下方映射表。 |

token 指标只从 `llm` span 派生，不从 `agent_run` 汇总字段派生，避免同一次模型调用被重复计数。

## Token 映射

| `llm` span 字段 | Metric | `token_type` | 说明 |
| --- | --- | --- | --- |
| `usage_input_tokens` | `gen_ai.agent.token.usage` | `input` | 非缓存输入 token。 |
| `usage_output_tokens` | `gen_ai.agent.token.usage` | `output` | 输出 token。 |
| `usage_total_tokens` | `gen_ai.agent.token.usage` | `total` | 非缓存输入 token + 输出 token。 |
| `usage_cache_read_input_tokens` | `gen_ai.agent.token.usage` | `cache_read` | 缓存命中的输入 token。 |
| `usage_cache_total_tokens` | `gen_ai.agent.token.usage` | `cache_total` | 缓存 token 总量，当前等于 cache read。 |
| `usage_reasoning_tokens` | `gen_ai.agent.token.usage` | `reasoning` | 模型服务端返回的 reasoning token 明细。 |

`usage_context_input_tokens` 和 `usage_context_total_tokens` 不生成默认 token metric。它们表示 Codex 原始完整上下文口径，可能比本次新增消耗大很多，默认只保留在 trace span attributes 中。

token 值不存在、不是数字或小于等于 0 时，不生成对应 data point。

## OTLP 形态

Metrics 使用 OTLP Metrics HTTP/protobuf 上报。

Counter 指标使用 OTLP `Sum`：

- `aggregationTemporality`: `AGGREGATION_TEMPORALITY_DELTA`
- `isMonotonic`: `true`

Histogram 指标使用 OTLP `Histogram`，每次观测生成一个 data point：

- `count`: `1`
- `sum`: 当前观测值
- `min`: 当前观测值
- `max`: 当前观测值

duration histogram 默认 bucket：

```text
1, 5, 10, 50, 100, 500, 1000, 5000, 30000, 120000
```

token histogram 默认 bucket：

```text
1, 10, 100, 1000, 10000, 100000, 1000000
```

## 配置

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

本地调试配置：

```json
{
  "enabled": true,
  "endpoint": "http://localhost:3030",
  "tracePath": "api/public/otel/v1/traces",
  "metricsPath": "api/public/otel/v1/metrics",
  "debug": true
}
```

如果 trace 和 metrics 使用完整 OTLP URL，可以配置：

```json
{
  "enabled": true,
  "otel_traces_url": "http://localhost:4318/v1/traces",
  "otel_metrics_url": "http://localhost:4318/v1/metrics",
  "debug": true
}
```

环境变量覆盖：

```bash
export GTRACE_METRICS_PATH="v1/metrics"
export GTRACE_CODEX_METRICS_PATH="v1/metrics"
export GTRACE_OTEL_METRICS_URL="http://localhost:4318/v1/metrics"
export GTRACE_CODEX_OTEL_METRICS_URL="http://localhost:4318/v1/metrics"
```

安装脚本支持：

```bash
./scripts/install.sh \
  --endpoint https://llm-openway.guance.com \
  --trace-path v1/write/otel-llm \
  --metrics-path v1/write/otel-metrics \
  --x-token <token>
```

## 本地调试

本地 server 接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/public/otel/v1/metrics` | 接收 OTLP Metrics JSON/protobuf。 |
| `GET` | `/metrics?limit=50` | 查看最近规范化 metric data point。 |

落盘文件：

```text
data/batches/*.json
data/metrics.ndjson
```

排查命令：

```bash
curl "http://localhost:3030/metrics?limit=20"
tail -n 20 data/metrics.ndjson
ls -lt data/batches | head
```

## 维护要求

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
