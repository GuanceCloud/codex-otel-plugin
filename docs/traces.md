# Trace 字段说明

本文档说明 codex-otel-plugin 上报到 OTLP Trace 的 span 结构、字段命名、token 口径和 UI 展示建议。

## Trace 结构

一次 Codex turn 会生成一棵 trace 树：

```text
agent_run
├── llm
│   ├── assistant
│   ├── tool:exec_command
│   └── tool:apply_patch
├── llm
│   └── assistant
└── llm
```

span 关系：

- `agent_run` 是一个 Codex turn 的根 span。
- `llm` 是一次模型调用，parent 是 `agent_run`。
- `assistant` 是一次助手消息输出，parent 是对应的 `llm` span；同一个 `llm` step 内最多生成一个聚合后的 `assistant` span。
- `tool:<name>` 是一次工具调用，parent 是触发该工具调用的 `llm` span。
- 一个 turn 内可能有多个 `llm` span，因为模型可能在工具调用前后多次生成响应。
- 一个 `llm` span 下可能有一个 `assistant` span 和多个 `tool:<name>` span。

同一个 step 内的多条 assistant `response_item` 会聚合为一条 assistant 输出；若存在 Codex `agent_message` 事件，则把它视为该 step 的最终助手输出文本，并用于补齐 `assistant` span 的结束时间。

## Span Name

| Span name | 含义 | 典型展示 |
| --- | --- | --- |
| `agent_run` | Codex 一轮用户请求的根节点 | 本轮汇总 |
| `llm` | 一次大模型调用 | 模型调用 |
| `assistant` | 一次助手消息输出 | 助手输出 |
| `tool:<name>` | 一次工具调用 | `tool:exec_command`、`tool:apply_patch` |

建议 UI 上按 span name 判断节点类型，不额外依赖多层前缀字段。

## 基础 OTLP 字段

每个 span 都会包含标准 OTLP span 字段：

| 字段 | 含义 |
| --- | --- |
| `trace_id` | Trace ID |
| `span_id` | Span ID |
| `parent_id` | 父 Span ID |
| `name` | Span name |
| `kind` | Span kind |
| `start_time_unix_nano` | 开始时间，纳秒 |
| `end_time_unix_nano` | 结束时间，纳秒 |
| `duration_ms` | 持续时间，毫秒 |
| `status` | OTLP span status |
| `attributes` | 业务属性 |
| `resource` | OTLP resource attributes |
| `scope` | OTLP instrumentation scope |

## Canonical Attributes

Codex hook 默认使用扁平 canonical tag，不生成多层业务前缀字段。

### 会话与运行字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `session_id` | Codex session ID | 全部 |
| `session_key` | 会话聚合 key，当前等于 `session_id` | 全部 |
| `session_agent` | 会话来源，当前为 `codex` | 全部 |
| `run_id` | 当前 turn ID | 全部 |
| `run_ids` | 当前 turn ID，兼容数组/聚合展示 | 全部 |
| `request_type` | 请求类型，当前通常为 `user_request` | 全部 |
| `is_internal_request` | 是否内部请求，当前通常为 `false` | 全部 |

### 模型字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `provider_name` | 模型供应商，例如 `openai` | `agent_run`、`llm`、`assistant`、`tool:*` |
| `model_name` | 模型名称，例如 `gpt-5.5` | `agent_run`、`llm`、`assistant`、`tool:*` |

说明：

- `request_model` 和 `response_model` 不再使用。
- UI 应统一使用 `model_name` 展示模型名。

### 输入输出字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `input_preview` | 输入预览，已按最大长度裁剪 | `agent_run`、`llm` |
| `input_length` | 输入预览长度 | `agent_run`、`llm` |
| `output_preview` | 输出预览，已按最大长度裁剪 | `agent_run`、`llm`、`assistant` |
| `output_length` | 输出文本长度 | `agent_run`、`llm`、`assistant` |
| `output_kind` | 输出类型，例如 `text`、`tool_call` | `llm`、`assistant` |

### 助手消息字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `role` | 消息角色，助手消息为 `assistant` | `assistant` |
| `assistant_message_start_time` | rollout 中 assistant response item 的开始时间 | `assistant` |
| `assistant_message_end_time` | 助手消息结束时间；若存在 `agent_message` 事件，则取该事件时间 | `assistant` |
| `assistant_message_event_time` | Codex `agent_message` 事件时间 | `assistant` |
| `message_index` | 当前 `llm` span 下的助手消息序号 | `assistant` |

### 工具字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `tool_count` | 当前 turn 的工具调用数量 | `agent_run` |
| `tool_name` | 工具名称 | `tool:*` |
| `tool_call_id` | 工具调用 ID | `tool:*` |
| `tool_command` | 工具目标命令，当前从 `args.cmd` 或 `args.command` 提取 | `tool:*` |
| `tool_args_preview` | 工具入参预览 | `tool:*` |
| `tool_result_preview` | 工具结果预览 | `tool:*` |
| `tool_result_status` | 工具结果状态，`completed` 或 `error` | `tool:*` |

### 状态字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `status` | 业务状态，通常为 `ok` 或 `error` | 全部 |
| `final_status` | turn 最终状态 | `agent_run` |
| `reason` | 错误或取消原因 | `agent_run`、`tool:*` |

`final_status` 当前取值：

| 值 | 含义 |
| --- | --- |
| `completed` | turn 已完成 |
| `cancelled` | turn 被用户中断或取消 |
| `unset` | 未能确认完成状态 |

Stop hook 可能早于 `task_complete` 写入。解析器会在已有 `agent_message`、assistant 最终输出或带文本 step 时推断为 `completed`。

只有启动上下文、没有真实用户输入、模型输出、工具调用或 token usage 的空白 turn 不会上报。典型例子是只包含 `session_meta`、`task_started`、`turn_context`、环境上下文和 `task_complete` 的启动会话。

## Token 字段

### 字段口径

| 字段 | UI 名称 | 含义 | 推荐展示 |
| --- | --- | --- | --- |
| `usage_input_tokens` | 输入 Token | 非缓存输入 token，计算方式为 `input_tokens - cached_input_tokens` | 默认展示 |
| `usage_output_tokens` | 输出 Token | 模型输出 token | 默认展示 |
| `usage_total_tokens` | 总 Token | 非缓存输入 token + 输出 token | 默认展示 |
| `usage_cache_read_input_tokens` | 缓存命中输入 Token | 命中缓存的输入 token | 高级/诊断 |
| `usage_cache_total_tokens` | 缓存命中 Token | 缓存 token 总量；当前等于 `usage_cache_read_input_tokens` | 默认展示 |
| `usage_reasoning_tokens` | 推理 Token | 模型内部推理过程消耗的输出 token | 高级/诊断 |
| `usage_context_input_tokens` | 上下文输入 Token | Codex 原始完整上下文输入 token，包含缓存命中部分 | 高级/诊断 |
| `usage_context_total_tokens` | 上下文总 Token | Codex 原始完整上下文总 token | 高级/诊断 |

核心公式：

```text
usage_input_tokens = max(0, input_tokens - cached_input_tokens)
usage_total_tokens = usage_input_tokens + usage_output_tokens
usage_cache_total_tokens = usage_cache_read_input_tokens
```

`usage_context_*` 是 Codex 原始上下文口径，可能比本次新增消耗大很多，不建议放在主指标区。

### Span 层级口径

`llm` span 上的 `usage_*` 表示单次模型调用。

`agent_run` span 上的 `usage_*` 表示当前 turn 的最终汇总：

- `usage_input_tokens` 按所有 `llm` span 累加。
- `usage_output_tokens` 按所有 `llm` span 累加。
- `usage_total_tokens` 按所有 `llm` span 累加。
- `usage_cache_read_input_tokens` 按所有 `llm` span 累加。
- `usage_cache_total_tokens` 按所有 `llm` span 累加。
- `usage_reasoning_tokens` 按所有 `llm` span 累加。
- `usage_context_input_tokens` 保留最后一次模型调用的完整上下文输入口径。
- `usage_context_total_tokens` 保留最后一次模型调用的完整上下文总量口径。

不要把多次 `usage_context_*` 相加，否则会把完整上下文重复累计。

`assistant` span 不携带 `usage_*` 字段，避免 UI 或后端把同一次模型调用的 token 重复计算。

### 推理 Token

`usage_reasoning_tokens` 来自 Codex rollout 中的：

```text
last_token_usage.reasoning_output_tokens
```

它表示模型服务端返回的 reasoning token usage 明细，可以理解为模型在生成回答过程中用于内部推理/思考的 token。

理解方式：

```text
大模型调用
├── 输入 token
├── 输出 token
│   ├── 可见回答 token
│   └── 推理 token reasoning tokens
└── 缓存命中 token
```

注意：

- 不是所有模型都会返回 `reasoning_output_tokens`。
- 不同模型或供应商可能对 reasoning token 是否计入 `output_tokens` 有不同口径。
- UI 上建议把它当作输出明细或诊断字段，不要再额外加到 `usage_total_tokens`，避免重复计算。
- 如果字段不存在或值为 0，建议隐藏。

## UI 展示建议

### Trace 顶部概览

顶部概览建议只展示四个 token 指标：

| UI 名称 | 字段 |
| --- | --- |
| 输入 Token | `usage_input_tokens` |
| 输出 Token | `usage_output_tokens` |
| 缓存命中 Token | `usage_cache_total_tokens` |
| 总 Token | `usage_total_tokens` |

### Span 列表

`agent_run` 展示 turn 汇总：

```text
agent_run  1.01 min  70.93K  gpt-5.5
```

`llm` 展示单次模型调用：

```text
llm  314 ms  46.51K
```

`assistant` 展示助手输出内容：

```text
assistant  300 ms  There are two files...
```

`tool:*` 默认不展示 token，只展示耗时、状态和工具名：

```text
tool:exec_command  289 ms
```

调用分析表的“目标/命令”建议优先展示 `tool_command`，最后回退到 `tool_args_preview`。

### 属性面板分组

不要在属性面板中平铺所有 token 字段。建议分组：

```text
Token 用量
- 输入 Token: usage_input_tokens
- 输出 Token: usage_output_tokens
- 总 Token: usage_total_tokens
- 推理 Token: usage_reasoning_tokens

缓存
- 缓存命中 Token: usage_cache_total_tokens
- 缓存命中输入 Token: usage_cache_read_input_tokens

上下文
- 上下文输入 Token: usage_context_input_tokens
- 上下文总 Token: usage_context_total_tokens
```

默认展示：

- `usage_input_tokens`
- `usage_output_tokens`
- `usage_total_tokens`
- `usage_cache_total_tokens`

默认折叠到高级/诊断：

- `usage_cache_read_input_tokens`
- `usage_context_input_tokens`
- `usage_context_total_tokens`
- `usage_reasoning_tokens`

## 字段展示名

UI 文案建议使用中文名，字段名只在原始属性或调试视图里展示。

| 字段 | 中文展示名 |
| --- | --- |
| `session_id` | Session ID |
| `run_id` | Run ID |
| `provider_name` | 模型供应商 |
| `model_name` | 模型名称 |
| `input_preview` | 输入预览 |
| `output_preview` | 输出预览 |
| `tool_count` | 工具调用数 |
| `tool_name` | 工具名称 |
| `tool_result_status` | 工具结果状态 |
| `final_status` | 最终状态 |
| `status` | 状态 |
| `reason` | 原因 |
| `usage_input_tokens` | 输入 Token |
| `usage_output_tokens` | 输出 Token |
| `usage_total_tokens` | 总 Token |
| `usage_cache_total_tokens` | 缓存命中 Token |
| `usage_cache_read_input_tokens` | 缓存命中输入 Token |
| `usage_reasoning_tokens` | 推理 Token |
| `usage_context_input_tokens` | 上下文输入 Token |
| `usage_context_total_tokens` | 上下文总 Token |
