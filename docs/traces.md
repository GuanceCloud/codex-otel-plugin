# Trace 字段说明

本文档说明 codex-otel-plugin 上报到 OTLP Trace 的 span 结构、字段命名、token 口径和 UI 展示建议。Metrics 指标体系见 [metrics.md](metrics.md)。

当前 Trace attributes 按 OpenTelemetry GenAI semantic conventions 输出。Span name 当前使用 `invoke_agent`、`llm`、`assistant`、`skill:<name>`、`tool:<name>`。

## Trace 结构

一次 Codex turn 会生成一棵 trace 树：

```text
invoke_agent
├── llm
│   ├── tool:exec_command
│   │   └── skill:plugin-creator
│   └── assistant
└── llm
    └── assistant
```

span 关系：

- `invoke_agent` 是一个 Codex turn 的根 span，对应 `gen_ai.operation.name=invoke_agent`。
- `llm` 是一次模型调用，parent 是 `invoke_agent`，对应 `gen_ai.operation.name=chat`。
- `assistant` 是一次助手消息输出，parent 是对应的 `llm` span，不携带 token usage。
- `tool:<name>` 是一次工具调用；parent 是触发该工具调用的 `llm` span，对应 `gen_ai.operation.name=execute_tool`。
- `skill:<name>` 是一次 skill 资源使用跨度；当某个工具调用被识别为读取 skill 的 `SKILL.md` 或同一 skill 目录资源时，会在该 `tool:*` 下生成对应的 `skill:*` span。当前使用 `gen_ai.operation.name=skill` 表示 skill 语义。
- 当工具调用没有稳定归属到某个 skill 时，只保留 `tool:*` span，不强行生成 `skill:*`。
- `llm` span 的结束时间至少覆盖其下 assistant / tool 子节点，避免父节点显示为 `0ns` 而子节点仍有持续时间。

## Skill 识别规则

Codex transcript 当前没有原生 `skill_invoked` 事件。本插件只做高置信度识别：

- 工具参数中直接出现某个 `.../SKILL.md` 路径时，创建对应 `skill:<name>` span。
- 同一 `llm` step 内后续工具参数若继续访问同一 skill 目录下资源，也会挂到这个 `skill:<name>` span 下。
- 仅提到 skill 名、只有 skills 列表、或无法稳定关联到某个 skill 目录时，不会强行生成 `skill:*` span。

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
| `session_id` | Codex session ID 兼容字段，值与 `gen_ai.conversation.id` 相同 | 全部 |
| `gen_ai.agent.name` | Agent 名称，当前为 `codex` | 全部 |
| `gen_ai.agent.version` | Agent 版本，当前使用 Codex CLI 版本 | 全部 |
| `gen_ai.operation.name` | GenAI 操作名：`invoke_agent`、`chat`、`skill`、`execute_tool` | `invoke_agent`、`llm`、`skill:*`、`tool:*` |
| `gen_ai.output.type` | 请求侧声明的输出类型；当前默认按 Codex chat 请求映射为 `text`，显式 JSON 输出请求映射为 `json` | `invoke_agent`、`llm`、`assistant` |
| `gen_ai.input.messages` | 结构化输入消息数组，当前按 OpenTelemetry GenAI message schema 输出 | `invoke_agent`、`llm` |
| `gen_ai.output.messages` | 结构化输出消息数组，当前按 OpenTelemetry GenAI message schema 输出 | `invoke_agent`、`llm` |
| `gen_ai.provider.name` | 模型供应商，例如 `openai` | `invoke_agent`、`llm`、`assistant`、`tool:*` |
| `gen_ai.request.model` | 请求模型名 | `invoke_agent`、`llm`、`assistant`、`tool:*` |
| `gen_ai.response.model` | 响应模型名 | `invoke_agent`、`llm`、`assistant`、`tool:*` |
| `gen_ai.response.finish_reasons` | 当前 generation 对应的停止原因数组 | `invoke_agent`、`llm` |

当前消息映射约定：

- `invoke_agent.gen_ai.input.messages`：当前 turn 的用户输入。
- `invoke_agent.gen_ai.output.messages`：当前 turn 的最终助手输出。
- 首个 `llm.gen_ai.input.messages`：用户输入。
- 后续 `llm.gen_ai.input.messages`：上一轮工具调用结果，按 `role=tool` + `tool_call_response` part 输出。
- `llm.gen_ai.output.messages`：当前模型输出，文本回复用 `text` part，reasoning 用 `reasoning` part，工具请求用 `tool_call` part。
- `gen_ai.response.finish_reasons`：当前实现按 `stop`、`tool_call`、`cancelled` 映射。

### 请求字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `gen_ai.request.choice.count` | 请求的候选输出数量 | `invoke_agent`、`llm` |
| `gen_ai.request.seed` | 请求 seed | `invoke_agent`、`llm` |
| `gen_ai.request.temperature` | 请求 temperature | `invoke_agent`、`llm` |
| `gen_ai.request.top_p` | 请求 top_p | `invoke_agent`、`llm` |
| `gen_ai.request.max_tokens` | 请求 max output tokens | `invoke_agent`、`llm` |
| `gen_ai.request.presence_penalty` | 请求 presence penalty | `invoke_agent`、`llm` |
| `gen_ai.request.frequency_penalty` | 请求 frequency penalty | `invoke_agent`、`llm` |
| `gen_ai.request.stop_sequences` | 请求 stop sequences | `invoke_agent`、`llm` |
| `gen_ai.system_instructions` | 系统指令，当前从 `base_instructions` 和 developer instructions 提取 | `invoke_agent`、`llm` |
| `gen_ai.tool.definitions` | 模型可用工具定义列表；当前从 `turn_context.tools` 等字段提取 | `invoke_agent`、`llm` |

### Skill 字段

截至 2026-06-25，`skill` 仍没有 OpenTelemetry GenAI 已落地的一等字段。本插件保留现有兼容字段，同时补充 `gen_ai.skill.*` 项目扩展字段；其中 `gen_ai.skill.name`、`gen_ai.skill.description`、`gen_ai.skill.version` 与社区提案方向一致，但当前仍不是正式标准字段。

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `skill.name` | skill 名称，来自 `SKILL.md` 所在目录名 | `skill:*`、`tool:*` |
| `skill.path` | skill 入口文件绝对路径，当前为识别到的 `.../SKILL.md` | `skill:*`、`tool:*` |
| `skill.source.type` | skill 来源类型，当前取值 `system`、`user`、`workspace` | `skill:*`、`tool:*` |
| `skill.result_status` | skill 结果状态，当前按其子 tool 是否报错映射为 `completed` 或 `error` | `skill:*`、`tool:*` |
| `gen_ai.skill.name` | skill 名称的 `gen_ai.*` 扩展字段 | `skill:*`、`tool:*` |
| `gen_ai.skill.path` | skill 入口文件绝对路径的 `gen_ai.*` 扩展字段 | `skill:*`、`tool:*` |
| `gen_ai.skill.source.type` | skill 来源类型的 `gen_ai.*` 扩展字段 | `skill:*`、`tool:*` |
| `gen_ai.skill.result.status` | skill 结果状态的 `gen_ai.*` 扩展字段 | `skill:*`、`tool:*` |
| `gen_ai.skill.description` | skill 描述；优先读取 `SKILL.md` frontmatter 中的 `description`，无 frontmatter 时回退正文首个说明段落 | `skill:*`、`tool:*` |
| `gen_ai.skill.version` | skill 版本；优先读取 `SKILL.md` frontmatter 的 `version`，其次读取同目录 `package.json.version`；没有明确元数据时不生成 | `skill:*`、`tool:*` |

### Token 字段

| 字段 | 含义 | 常见 span |
| --- | --- | --- |
| `gen_ai.usage.input_tokens` | 输入 token，包含缓存命中输入 token | `invoke_agent`、`llm` |
| `gen_ai.usage.output_tokens` | 输出 token | `invoke_agent`、`llm` |
| `gen_ai.usage.cache_read.input_tokens` | 命中 provider-managed cache 的输入 token | `invoke_agent`、`llm` |
| `gen_ai.usage.reasoning.output_tokens` | reasoning 输出 token | `invoke_agent`、`llm` |

`llm` span 上的 `gen_ai.usage.*` 表示单次模型调用；`invoke_agent` span 上的 `gen_ai.usage.*` 表示当前 turn 内所有 `llm` span 的汇总。`assistant` span 不携带 token usage，避免重复计算。

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
| `session_create_at` | 会话创建时间 | `invoke_agent` |
| `session_updated_at` | 当前 turn 对应的会话更新时间 | `invoke_agent` |
| `session_channel` | 会话来源通道 | `invoke_agent` |
| `input_preview` / `input_length` | 输入预览与长度 | `invoke_agent`、`llm` |
| `output_preview` / `output_length` | 输出预览与长度 | `invoke_agent`、`llm`、`assistant` |
| `output_kind` | 输出类型，例如 `text`、`tool_call` | `llm`、`assistant` |
| `tool_count` | 当前 turn 的工具调用数量 | `invoke_agent` |
| `tool_command` | 工具目标命令 | `tool:*` |
| `tool_result_status` | 工具结果状态，`completed` 或 `error` | `tool:*` |
| `final_status` | turn 最终状态 | `invoke_agent` |
| `status` | 业务状态，通常为 `ok` 或 `error` | 全部 |
| `reason` | 错误或取消原因 | `invoke_agent`、`tool:*` |
| `error.type` | OpenTelemetry 错误类型，当前错误时为 `_OTHER` | `invoke_agent`、`tool:*` |

`final_status` 当前取值：

| 值 | 含义 |
| --- | --- |
| `completed` | turn 已完成 |
| `cancelled` | turn 被用户中断或取消 |
| `unset` | 未能确认完成状态 |

Stop hook 可能早于 `task_complete` 写入。解析器会在已有 `agent_message`、assistant 最终输出或带文本 step 时推断为 `completed`。

为避免同一个 `turn_id` 的中间态和完成态分别形成两条链路，当前只上报终态 turn：`completed` 或 `cancelled`。`unset` 仅作为内部状态保留，正常 OTLP Trace 上报不会看到未完成 turn。终态 turn 一旦成功写入对应 transcript 的 `.gtrace` sidecar，后续重解析即使算出不同 fingerprint，也不会再次上报。

只有启动上下文、没有真实用户输入、模型输出、工具调用或 token usage 的空白 turn 不会上报。

## 字段变更关系

| 旧字段 | 新字段 / 处理方式 |
| --- | --- |
| `session_id` | 兼容保留，同时继续输出 `gen_ai.conversation.id` |
| 无统一结构化输入/输出字段 | 新增 `gen_ai.input.messages`、`gen_ai.output.messages` |
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
