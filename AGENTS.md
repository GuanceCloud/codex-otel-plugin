# AGENTS.md

本文件是 `/home/liurui/code/codex-otel-plugin` 项目的 Agent/Codex 维护指令。后续在本项目内工作时优先遵循本文件，再参考 README 和 `docs/` 下的设计文档。

## 项目定位

`codex-otel-plugin` 是 Codex 可观测数据采集插件，核心能力是读取 Codex rollout transcript，并以 OTLP Trace / Metrics HTTP/protobuf 上报。

主流程：

1. Codex Stop hook 执行 `src/codex-hook-wrapper.js`
2. hook 从 stdin 读取 Codex 传入的 `transcript_path`
3. `src/codex-parse.js` 解析 rollout JSONL
4. `src/codex-collector.js` 生成 `agent_run`、`llm`、`assistant`、`tool:<name>` span
5. `src/codex-metrics.js` 从 span 派生 turn 级 metrics
6. `src/codex-otlp.js` 和 `src/proto.js` 编码 OTLP Trace / Metrics protobuf
7. 按 `~/.codex/gtrace.json` 或项目 `.codex/gtrace.json` 配置上报

本项目还包含一个本地调试 ingest 服务 `src/server.js`，用于接收 OTLP JSON/protobuf 和原生 JSON 调试数据。

## 目录职责

```text
README.md                 项目使用说明
docs/traces.md            Trace/span/字段/token/UI 展示设计说明
docs/metrics.md           Metrics 指标体系、tag、token 映射和 OTLP 形态说明
AGENTS.md                 Agent 维护指令
package.json              Node.js 脚本与项目元信息
scripts/install.sh        本地 Codex marketplace/plugin 安装脚本
scripts/install-release.sh 远程下载安装与升级脚本
src/codex-hook-wrapper.js Codex Stop hook 入口和远端上报
src/codex-config.js       gtrace.json 与环境变量解析
src/codex-parse.js        Codex rollout JSONL 解析
src/codex-collector.js    Codex turn 到 span 的核心映射
src/codex-metrics.js      从内部 span 派生 OTLP metrics 语义
src/codex-otlp.js         内部 span/metric 到 OTLP request 的转换
src/proto.js              项目内最小 OTLP Trace/Metrics protobuf 编解码
src/otlp.js               接收端 OTLP Trace/Metrics 规范化解析
src/server.js             本地 ingest/debug server
src/store.js              本地 data/ 落盘调试
test/ingest-smoke.test.js 集成/smoke 测试
```

`data/` 是本地运行产物，不作为 schema 来源。不要把旧 `data/` 内容当作当前字段规范。

## 运行与验证

要求 Node.js >= 22。

每次修改源码、字段、协议或文档口径后，至少运行：

```bash
npm test
npm ls --all
```

当前目标是无运行时 npm 第三方依赖，`npm ls --all` 应保持：

```text
gtrace@0.1.1 /home/liurui/code/codex-otel-plugin
└── (empty)
```

常用命令：

```bash
npm start
npm run codex:hook
```

## 配置约定

Codex hook 读取配置顺序：

1. `~/.codex/gtrace.json`
2. 当前项目 `.codex/gtrace.json`
3. 环境变量覆盖

推荐 Dataway/GTrace 风格：

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

不要把真实 token 写入仓库文件、测试 fixture、README、AGENTS.md 或 `docs/`。

兼容配置字段：

- `base_url`
- `otel_traces_url`
- `otel_metrics_url`
- `public_key`
- `secret_key`
- `resourceAttributes`

如果 `headers.Authorization` 已存在，不要覆盖；否则可用 `public_key` / `secret_key` 自动补 Basic Auth。

全局筛选类 tag 应放在 OTLP `resource.attributes`，通过 `resourceAttributes` 配置或安装脚本 `--tag KEY=VALUE` 写入。推荐字段：

- `host`
- `deployment.environment`
- `app_id`
- `app_name`
- `agent_type`
- `agent_source`

`host` 默认自动采集当前宿主机 hostname，也可通过 `resourceAttributes.host` 覆盖。不要把 `run_id`、真实用户输入或高基数一次性字段放进 resource attributes。

## Trace 字段规范

详细字段说明、span name、token 口径和 UI 展示建议统一维护在：

```text
docs/traces.md
```

核心约定：

- 根 span name 是 `agent_run`
- 模型调用 span name 是 `llm`
- 助手消息 span name 是 `assistant`，parent 是对应的 `llm` span
- 工具调用 span name 是 `tool:<name>`
- 工具命令字段使用 `tool_command`，从 `args.cmd` 或 `args.command` 提取
- 字段使用扁平 canonical tag
- `agent_run` 额外包含 `session_create_at`、`session_updated_at`、`session_channel`
- 模型字段统一使用 `model_name`
- 不再使用 `request_model` 和 `response_model`
- 不生成旧兼容语义前缀字段
- 不生成 `gtrace.*` 业务前缀字段

Token 口径：

- `usage_input_tokens`: 非缓存输入 token
- `usage_output_tokens`: 输出 token
- `usage_total_tokens`: 非缓存输入 token + 输出 token
- `usage_cache_read_input_tokens`: 缓存命中的输入 token
- `usage_cache_total_tokens`: 缓存 token 总量，当前等于 `usage_cache_read_input_tokens`
- `usage_reasoning_tokens`: 模型服务端返回的 reasoning token 明细
- `usage_context_input_tokens`: 原始完整上下文输入 token
- `usage_context_total_tokens`: 原始完整上下文总 token

`llm` span 上的 `usage_*` 表示单次模型调用；`agent_run` span 上的 `usage_*` 表示当前 turn 汇总；`assistant` span 不携带 `usage_*`，避免重复计算 token。

## 状态逻辑

`final_status` 由 `src/codex-collector.js` 中的 `statusFromTurn()` 生成：

- `completed`: turn 已完成
- `cancelled`: turn 被中断或取消
- `unset`: 未能确认完成状态

`src/codex-parse.js` 已处理 Stop hook 早于 `task_complete` 写入的情况。若已有 `agent_message`、assistant 最终输出或带文本 step，会推断为 completed。

`src/codex-collector.js` 会跳过空白 turn。没有真实用户输入、模型输出、工具调用或 token usage 的启动上下文，不应生成 `agent_run`、`llm`、`assistant` 或 `tool:*` span。

修改该逻辑时必须保留或更新测试：

```text
Codex parser infers completed status when Stop hook runs before task_complete is written
Codex collector skips blank turns that only contain startup context
```

## Metrics 现状

当前已有独立 OTLP Metrics HTTP/protobuf 上报，触发时机与 traces 相同：Codex Stop hook 解析 rollout 后，从同批 spans 派生 metrics 并同步上报一次，不做周期性 flush。

详细指标体系、tag、token 映射和 OTLP 形态统一维护在：

```text
docs/metrics.md
```

第一版只做 turn 级核心指标：

- `gen_ai.agent.request.count`
- `gen_ai.agent.request.duration`
- `gen_ai.agent.operation.count`
- `gen_ai.agent.operation.duration`
- `gen_ai.agent.token.usage`

Metrics 默认带 `session_id`，用于与 trace 侧会话字段对齐；默认不带 `session_key` / `run_id`。不要新增 session 累计指标或 runtime 队列类指标，除非用户明确要求并同步设计去重状态。

`usage_context_*` 不生成默认 token metric，避免把完整上下文口径当成本次新增 token 消耗。

## 修改约束

1. 保持无运行时第三方依赖。不要引入 `protobufjs`、OpenTelemetry SDK 或其他观测 SDK，除非用户明确改变约束。
2. 手写文件修改优先使用 `apply_patch`。
3. 不要恢复或生成第三方许可文件。
4. 不要写入真实 token、真实用户输入或敏感 rollout 内容。
5. 字段命名优先使用当前 canonical tag，避免新增多层前缀。
6. 修改 token 口径、span 层级或字段名时，必须同步：
   - `src/codex-collector.js`
   - `src/otlp.js`
   - `test/ingest-smoke.test.js`
   - `README.md`
   - `docs/metrics.md`
   - `docs/traces.md`
   - `AGENTS.md`
7. 修改 hook 上报协议时，必须验证 OTLP Trace 和 Metrics protobuf 路径，不只验证 JSON 路径。
8. 不要把旧观测插件缓存当成本项目实现来源；本项目当前链路不依赖外部观测 SDK。

## 排查命令

查看 hook 日志：

```bash
tail -n 100 ~/.codex/gtrace-hook.log
```

查看已上传 turn 标记：

```bash
ls -l ~/.codex/sessions/**/*.gtrace
```

查看最近本地 ingest 数据：

```bash
tail -n 20 data/spans.ndjson
tail -n 20 data/metrics.ndjson
ls -lt data/batches | head
```
