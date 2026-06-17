# Trace 字段说明

本文档说明 codex-otel-plugin 上报到 OTLP Trace 的 span 结构、字段命名、token 口径和 UI 展示建议。Metrics 指标体系见 [metrics.md](metrics.md)。

当前 Trace attributes 按 OpenTelemetry GenAI semantic conventions 输出。Span name 为兼容现有 UI 仍保留 `agent_run`、`llm`、`assistant`、`tool:<name>`。

## Trace 结构

一次 Codex turn 会生成一棵 trace 树：

```text
agent_run
├── llm
│   ├── assistant
│   └── tool:exec_command
└── llm
    └── assistant
```

span 关系：

- `agent_run` 是一个 Codex turn 的根 span，对应 `gen_ai.operation.name=invoke_agent`。
- `llm` 是一次模型调用，parent 是 `agent_run`，对应 `gen_ai.operation.name=chat`。
- `assistant` 是一次助手消息输出，parent 是对应的 `llm` span，不携带 token usage。
- `tool:<name>` 是一次工具调用，parent 是触发该工具调用的 `llm` span，对应 `gen_ai.operation.name=execute_tool`。
- `llm` span 的结束时间至少覆盖其下 assistant / tool 子节点，避免父节点显示为 `0ns` 而子节点仍有持续时间。

## Resource Attributes

默认 resource attributes：

| 字段 | 含义 |
| --- | --- |
| `service.name` | 当前为 `gtrace-codex` |
| `telemetry.sdk.language` | 当前为 `nodejs` |
| `telemetry.sdk.name` | 当前为 `gtrace` |
| `telemetry.sdk.version` | 当前插件内置采集版本 |
| `host` | 当前宿主机 hostname |
| `agent_runtime` | 当前为 `codex` |
| `gen_ai.agent.version` | Codex CLI 版本 |
| `runtime_environment` | 运行环境，来自配置 `environment` |

配置中的 `resourceAttributes` 会合并到每个 trace resource 上，适合放跨 trace/metric 统一筛选的全局 tag，例如 `deployment.environment`、`app_id`、`app_name`、`agent_type`、`agent_source`。不要把 `run_id`、真实用户输入或高基数一次性字段放进 resource attributes。

## GenAI Attributes

### 会话、Agent 与模型

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `gen_ai.conversation.id` | Codex session ID | 全部 |
| `gen_ai.agent.name` | Agent 名称，当前为 `codex` | 全部 |
| `gen_ai.operation.name` | GenAI 操作名：`invoke_agent`、`chat`、`execute_tool` | `agent_run`、`llm`、`tool:*` |
| `gen_ai.provider.name` | 模型供应商，例如 `openai` | `agent_run`、`llm`、`assistant`、`tool:*` |
| `gen_ai.request.model` | 请求模型名 | `agent_run`、`llm`、`assistant`、`tool:*` |
| `gen_ai.response.model` | 响应模型名 | `agent_run`、`llm`、`assistant`、`tool:*` |

### Token 字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `gen_ai.usage.input_tokens` | 输入 token，包含缓存命中输入 token | `agent_run`、`llm` |
| `gen_ai.usage.output_tokens` | 输出 token | `agent_run`、`llm` |
| `gen_ai.usage.cache_read.input_tokens` | 命中 provider-managed cache 的输入 token | `agent_run`、`llm` |
| `gen_ai.usage.reasoning.output_tokens` | reasoning 输出 token | `agent_run`、`llm` |

`llm` span 上的 `gen_ai.usage.*` 表示单次模型调用；`agent_run` span 上的 `gen_ai.usage.*` 表示当前 turn 内所有 `llm` span 的汇总。`assistant` span 不携带 token usage，避免重复计算。

`gen_ai.usage.input_tokens` 按 OpenTelemetry 语义包含所有输入 token，因此和旧 `usage_input_tokens` 的“非缓存输入 token”口径不同。

### 工具字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `gen_ai.tool.name` | 工具名称 | `tool:*` |
| `gen_ai.tool.call.id` | 工具调用 ID | `tool:*` |
| `gen_ai.tool.call.arguments` | 工具入参预览，按 `max_chars` 裁剪 | `tool:*` |
| `gen_ai.tool.call.result` | 工具结果预览，按 `max_chars` 裁剪 | `tool:*` |

`tool_command` 仍保留，用于从 `args.cmd` 或 `args.command` 提取命令展示。

## 项目字段

以下字段没有直接的 GenAI 官方等价或属于本插件排查字段，继续保留：

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `run_id` / `run_ids` | 当前 turn ID | 全部 |
| `session_create_at` | 会话创建时间 | `agent_run` |
| `session_updated_at` | 当前 turn 对应的会话更新时间 | `agent_run` |
| `session_channel` | 会话来源通道 | `agent_run` |
| `input_preview` / `input_length` | 输入预览与长度 | `agent_run`、`llm` |
| `output_preview` / `output_length` | 输出预览与长度 | `agent_run`、`llm`、`assistant` |
| `output_kind` | 输出类型，例如 `text`、`tool_call` | `llm`、`assistant` |
| `tool_count` | 当前 turn 的工具调用数量 | `agent_run` |
| `tool_command` | 工具目标命令 | `tool:*` |
| `tool_result_status` | 工具结果状态，`completed` 或 `error` | `tool:*` |
| `final_status` | turn 最终状态 | `agent_run` |
| `status` | 业务状态，通常为 `ok` 或 `error` | 全部 |
| `reason` | 错误或取消原因 | `agent_run`、`tool:*` |
| `error.type` | OpenTelemetry 错误类型，当前错误时为 `_OTHER` | `agent_run`、`tool:*` |

`final_status` 当前取值：

| 值 | 含义 |
| --- | --- |
| `completed` | turn 已完成 |
| `cancelled` | turn 被用户中断或取消 |
| `unset` | 未能确认完成状态 |

Stop hook 可能早于 `task_complete` 写入。解析器会在已有 `agent_message`、assistant 最终输出或带文本 step 时推断为 `completed`。

只有启动上下文、没有真实用户输入、模型输出、工具调用或 token usage 的空白 turn 不会上报。

## 字段变更关系

| 旧字段 | 新字段 / 处理方式 |
| --- | --- |
| `session_id` | `gen_ai.conversation.id` |
| `session_agent` | `gen_ai.agent.name` |
| `agent_version` | `gen_ai.agent.version` |
| `provider_name` | `gen_ai.provider.name` |
| `model_name` | `gen_ai.request.model`、`gen_ai.response.model` |
| `tool_name` | `gen_ai.tool.name` |
| `tool_call_id` | `gen_ai.tool.call.id` |
| `tool_args_preview` | `gen_ai.tool.call.arguments` |
| `tool_result_preview` | `gen_ai.tool.call.result` |
| `usage_input_tokens` | 停止输出；`gen_ai.usage.input_tokens` 改为完整输入 token，包含缓存命中 |
| `usage_output_tokens` | `gen_ai.usage.output_tokens` |
| `usage_total_tokens` | 停止输出；需要总量时由 `gen_ai.usage.input_tokens + gen_ai.usage.output_tokens` 推导 |
| `usage_cache_read_input_tokens` | `gen_ai.usage.cache_read.input_tokens` |
| `usage_cache_total_tokens` | 停止输出；当前等价于 `gen_ai.usage.cache_read.input_tokens` |
| `usage_reasoning_tokens` | `gen_ai.usage.reasoning.output_tokens` |
| `usage_context_input_tokens` | 停止输出；完整输入口径已合并到 `gen_ai.usage.input_tokens` |
| `usage_context_total_tokens` | 停止输出 |
| `request_model` / `response_model` | 不输出；使用 `gen_ai.request.model` / `gen_ai.response.model` |

## UI 展示建议

顶部概览建议展示：

| UI 名称 | 字段 |
| --- | --- |
| 输入 Token | `gen_ai.usage.input_tokens` |
| 输出 Token | `gen_ai.usage.output_tokens` |
| 缓存命中 Token | `gen_ai.usage.cache_read.input_tokens` |
| 推理 Token | `gen_ai.usage.reasoning.output_tokens` |

调用分析表的“目标/命令”建议优先展示 `tool_command`，最后回退到 `gen_ai.tool.call.arguments`。
