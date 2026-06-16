# codex-otel-plugin

`codex-otel-plugin` 是一个 Codex 可观测采集插件。它通过 Codex Stop hook 读取 rollout transcript，将一次 Codex turn 转换为 OpenTelemetry OTLP Trace，并通过 HTTP/protobuf 上报。

当前实现只使用 Node.js 内置模块，没有运行时 npm 第三方依赖。

## 能力概览

- 采集 Codex turn、模型调用、工具调用和 token usage。
- 生成 `agent_run`、`llm`、`tool:<name>` 三类 span。
- 使用 OTLP Trace HTTP/protobuf 上报。
- 支持 Dataway/GTrace 风格的 `endpoint + tracePath + headers` 配置。
- 提供本地 ingest/debug server，便于接收和检查 OTLP JSON/protobuf 数据。

Trace 字段、Span name、token 口径和 UI 展示建议见 [docs/traces.md](docs/traces.md)。

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
src/codex-otlp.js / src/proto.js 编码 OTLP protobuf
    |
    v
POST <endpoint>/<tracePath>
```

安装脚本会写入的 Hook 命令：

```text
node ~/.codex/plugins/cache/codex-otel-plugin/tracing/<version>/src/codex-hook-wrapper.js
```

## 运行要求

- Node.js >= 22
- 远程安装需要 `curl`、`tar`、`gzip`
- 无需安装运行时依赖

说明：Codex 会触发 Stop hook，但不会为 hook 提供 Node.js 运行时。当前 hook 是 Node.js 脚本，因此客户环境需要有 Node.js 22+。

如果 Node.js 已安装但不在非交互 shell 的 `PATH` 中，可以指定 Node 路径：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | CODEX_OTEL_NODE=/path/to/node bash -s -- latest --endpoint <endpoint> --x-token <token>
```

## 安装

推荐使用远程安装器，不需要 `git clone`：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest \
      --endpoint https://llm-openway.guance.com \
      --x-token <token>
```

安装脚本会完成：

- 创建本地 Codex marketplace：`~/.codex/plugin-sources/codex-otel-plugin`
- 写入插件：`tracing@codex-otel-plugin`
- 写入 Stop hook：`node ~/.codex/plugins/cache/codex-otel-plugin/tracing/<version>/src/codex-hook-wrapper.js`
- 写入 Codex 配置：`~/.codex/config.toml`
- 同步完整运行文件到 Codex 插件缓存：`~/.codex/plugins/cache/codex-otel-plugin/tracing/<version>`
- 写入上报配置：`~/.codex/gtrace.json`

`~/.codex/config.toml` 会写入以下配置，用于让 Codex 启用插件：

```toml
[marketplaces.codex-otel-plugin]
source_type = "local"
source = "/home/<user>/.codex/plugin-sources/codex-otel-plugin"

[plugins."tracing@codex-otel-plugin"]
enabled = true
```

上面的命令会生成：

```json
{
  "enabled": true,
  "endpoint": "https://llm-openway.guance.com",
  "tracePath": "v1/write/otel-llm",
  "headers": {
    "X-Token": "<token>",
    "To-Headless": "true"
  },
  "debug": true
}
```

配置完成后重启 Codex，让 Stop hook 重新加载。

如果只安装文件、稍后手动配置：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest --no-config
```

## 升级

升级也使用同一条命令。已安装过的环境可以省略 `--endpoint` 和 `--x-token`，脚本会复用现有 `~/.codex/gtrace.json`：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest
```

升级脚本会重新下载插件文件、重写插件和 hook 配置，更新 `~/.codex/config.toml` 并同步 Codex 插件缓存；不会覆盖 `~/.codex/gtrace.json`。

安装指定版本：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- v0.1.0
```

## 卸载

只卸载插件：

```bash
codex plugin remove tracing@codex-otel-plugin
```

彻底清理本地 source、cache 和上报配置：

```bash
codex plugin remove tracing@codex-otel-plugin
codex plugin marketplace remove codex-otel-plugin
rm -rf ~/.codex/plugin-sources/codex-otel-plugin
rm -rf ~/.codex/plugins/cache/codex-otel-plugin
rm -f ~/.codex/gtrace.json
```

如果只想停用插件但保留安装文件，也可以只执行：

```bash
codex plugin remove tracing@codex-otel-plugin
```

不要先手工删除 `~/.codex/plugin-sources/codex-otel-plugin`，再执行 `codex plugin list` 或 `codex plugin marketplace list`。如果 marketplace 配置还在，而 source 目录已经被手工删掉，Codex 会报 marketplace manifest 缺失。

安装参数：

| 参数 | 说明 |
| --- | --- |
| `latest` / `vX.Y.Z` / `X.Y.Z` | 安装版本，默认 `latest` |
| `--endpoint URL` | 接收端基础地址，例如 `https://llm-openway.guance.com` |
| `--x-token TOKEN` | 写入 `headers.X-Token` |
| `--trace-path PATH` | Trace 写入路径，GTrace 默认 `v1/write/otel-llm` |
| `--type gtrace|otlp` | 配置预设，默认 `gtrace` |
| `--header KEY=VALUE` | 追加 HTTP header，可重复 |
| `--tag KEY=VALUE` | 追加 metadata/tag，可重复 |
| `--config-file PATH` | 指定上报配置文件，默认 `~/.codex/gtrace.json` |
| `--codex-config PATH` | 指定 Codex 配置文件，默认 `~/.codex/config.toml` |
| `--no-config` | 只安装插件，不写 `gtrace.json` |

如果需要指定自定义 release 资产地址，可以覆盖下载 URL：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | CODEX_OTEL_ARCHIVE_URL=<plugin-release-tar-gz-url> bash -s -- latest --endpoint <endpoint> --x-token <token>
```

开发安装：

```bash
git clone https://github.com/GuanceCloud/codex-otel-plugin.git
cd codex-otel-plugin
./scripts/install.sh --refresh --endpoint https://llm-openway.guance.com --x-token <token>
```

## 开发命令

```bash
npm test
npm start
npm run codex:hook
```

`npm start` 会启动本地调试服务，默认监听：

```text
http://localhost:3030
```

## Codex Hook 配置

Hook 会读取以下配置：

1. `~/.codex/gtrace.json`
2. 当前项目下的 `.codex/gtrace.json`
3. 环境变量覆盖

本地调试配置：

```json
{
  "enabled": true,
  "endpoint": "http://localhost:3030",
  "tracePath": "api/public/otel/v1/traces",
  "debug": true
}
```

如果 `endpoint` 已经是完整 OTLP traces 地址，可以直接配置 `otel_traces_url`：

```json
{
  "enabled": true,
  "otel_traces_url": "http://localhost:4318/v1/traces",
  "debug": true
}
```

兼容 Basic Auth：

```json
{
  "enabled": true,
  "endpoint": "http://localhost:3030",
  "tracePath": "api/public/otel/v1/traces",
  "public_key": "pk-test",
  "secret_key": "sk-test"
}
```

如果 `headers.Authorization` 已配置，hook 会优先使用该值，不再自动覆盖。

## 环境变量

常用覆盖项：

```bash
export GTRACE_CODEX_ENABLED=true
export GTRACE_ENDPOINT="http://localhost:4318"
export GTRACE_TRACE_PATH="v1/traces"
export GTRACE_OTEL_TRACES_URL="http://localhost:4318/v1/traces"
export GTRACE_CODEX_DEBUG=true
```

认证相关：

```bash
export GTRACE_PUBLIC_KEY="pk-test"
export GTRACE_SECRET_KEY="sk-test"
```

排查相关：

```bash
export GTRACE_CODEX_HOOK_LOG_FILE="$HOME/.codex/gtrace-hook.log"
export GTRACE_CODEX_FAIL_ON_ERROR=true
```

## 本地调试服务

启动：

```bash
npm start
```

接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 本地服务健康检查 |
| `GET` | `/api/public/health` | OTLP ingest 健康检查 |
| `POST` | `/api/public/otel/v1/traces` | 接收 OTLP Trace JSON/protobuf |
| `POST` | `/api/gtrace/v1/codex-spans` | 接收原生 JSON 调试 span |
| `GET` | `/traces?limit=50` | 查看最近规范化 span |

本地落盘目录：

```text
data/batches/*.json
data/spans.ndjson
```

`data/` 只用于调试，不是字段规范来源。

## Trace 数据模型

一轮 Codex 请求生成一棵 trace 树：

```text
agent_run
├── llm
│   ├── tool:exec_command
│   └── tool:apply_patch
├── llm
└── llm
```

核心约定：

- `agent_run` 表示一次 Codex turn 的根 span。
- `llm` 表示一次模型调用。
- `tool:<name>` 表示一次工具调用。
- 字段使用扁平 canonical tag。
- 模型字段统一使用 `model_name`。
- `llm` span 的 `usage_*` 是单次模型调用口径。
- `agent_run` span 的 `usage_*` 是当前 turn 汇总口径。
- 只有启动上下文、没有真实用户输入、模型输出、工具调用或 token usage 的空白 turn 不会上报。

详细字段说明见 [docs/traces.md](docs/traces.md)。

## 验证

修改代码或字段口径后至少运行：

```bash
npm test
npm ls --all
```

期望结果：

```text
5 tests passed
```

```text
gtrace@0.1.0 /home/liurui/code/codex-otel-plugin
└── (empty)
```

测试覆盖：

- OTLP JSON ingest。
- OTLP protobuf ingest。
- Codex hook 解析 rollout 并上报 OTLP protobuf。
- Stop hook 早于 `task_complete` 写入时的 completed 状态推断。
- 空白启动 turn 过滤，不生成 OTLP span。

## 排查

查看 hook 日志：

```bash
tail -n 100 ~/.codex/gtrace-hook.log
```

查看本地 ingest 数据：

```bash
curl "http://localhost:3030/traces?limit=20"
tail -n 20 data/spans.ndjson
ls -lt data/batches | head
```

查看已上传 turn 标记：

```bash
find ~/.codex/sessions -name "*.gtrace" -type f
```

如果 Stop hook 报错，优先检查：

- `~/.codex/gtrace.json` 是否启用。
- `endpoint`、`tracePath` 或 `otel_traces_url` 是否指向正确 OTLP Trace 接口。
- 认证 header 是否正确。
- `~/.codex/gtrace-hook.log` 中的 HTTP 状态码和错误信息。

## 维护约束

- 不提交真实 token、真实用户输入或敏感 rollout 内容。
- 保持无运行时第三方依赖，除非明确改变项目约束。
- 字段命名以 [docs/traces.md](docs/traces.md) 为准。
- 修改 span 层级、字段名或 token 口径时，同步更新测试和文档。
