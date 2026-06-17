# codex-otel-plugin

`codex-otel-plugin` 是一个 Codex 可观测采集插件。它通过 Codex Stop hook 读取 rollout transcript，将一次 Codex turn 转换为 OpenTelemetry OTLP Trace 与 Metrics，并通过 HTTP/protobuf 上报。

当前实现只使用 Node.js 内置模块，没有运行时 npm 第三方依赖。

## 能力概览

- 采集 Codex turn、模型调用、工具调用和 token usage。
- 生成 `agent_run`、`llm`、`assistant`、`tool:<name>` 四类 span。
- 使用 OTLP Trace 与 Metrics HTTP/protobuf 上报。
- Metrics 从同批 trace spans 派生，触发时机与 traces 相同，不做定时上报。
- 支持 Dataway/GTrace 风格的 `endpoint + tracePath + metricsPath + headers` 配置。
- 提供本地 ingest/debug server，便于接收和检查 OTLP JSON/protobuf 数据。

## 工作流程

```text
Codex Stop hook
    |
    v
src/codex-hook-wrapper.js
    |
    v
src/codex-parse.js 解析 rollout JSONL
    |
    v
src/codex-collector.js 生成 span
    |
    v
src/codex-metrics.js 从 span 派生 metrics
    |
    v
src/codex-otlp.js / src/proto.js 编码 OTLP protobuf
    |
    v
POST <endpoint>/<tracePath>
POST <endpoint>/<metricsPath>
```

## 快速开始

要求：

- Node.js >= 22
- 远程安装需要 `curl`、`tar`、`gzip`

推荐直接使用远程安装器：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest \
      --endpoint https://llm-openway.guance.com \
      --x-token <token>
```

安装完成后重启 Codex，让 Stop hook 重新加载。

更多安装、升级、卸载和参数说明见 [docs/install.md](docs/install.md)。

## 文档导航

| 文档 | 说明 |
| --- | --- |
| [docs/install.md](docs/install.md) | 安装、升级、卸载、安装参数和开发安装 |
| [docs/configuration.md](docs/configuration.md) | Hook 文件配置、认证和 `resourceAttributes` 约定 |
| [docs/development.md](docs/development.md) | 本地调试服务、验证命令和排查方式 |
| [docs/traces.md](docs/traces.md) | Trace/span 结构、字段命名、token 口径和展示建议 |
| [docs/metrics.md](docs/metrics.md) | Metrics 指标体系、tag、token 映射和 OTLP 形态 |

## 数据模型

Trace 字段、Span name、token 口径和 UI 展示建议见 [docs/traces.md](docs/traces.md)。

Metrics 指标体系、tag 设计和 OTLP 形态见 [docs/metrics.md](docs/metrics.md)。

当前 Metrics 只从当前 turn 的 spans 派生以下核心指标：

- `gen_ai.agent.request.count`
- `gen_ai.agent.request.duration`
- `gen_ai.agent.operation.count`
- `gen_ai.agent.operation.duration`
- `gen_ai.agent.token.usage`

Metrics 默认带 `session_id`，不带 `session_key` / `run_id`。全局筛选类 tag 建议通过 `resourceAttributes` 放在 OTLP `resource.attributes` 中，并由 trace 和 metrics 共用。

## 开发

常用命令：

```bash
npm test
npm ls --all
npm start
npm run codex:hook
```

更多本地调试、验证和排查说明见 [docs/development.md](docs/development.md)。
