# 安装与升级

本文档说明 `codex-otel-plugin` 的运行要求、安装方式、升级、卸载和安装参数。

## 运行要求

- Node.js >= 22
- 远程安装需要 `curl`、`tar`、`gzip`
- 无需安装运行时 npm 依赖

Codex 会触发 Stop hook，但不会为 hook 提供 Node.js 运行时。当前 hook 是 Node.js 脚本，因此目标环境需要有 Node.js 22+。

如果 Node.js 已安装但不在非交互 shell 的 `PATH` 中，可以显式指定：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | CODEX_OTEL_NODE=/path/to/node bash -s -- latest --endpoint <endpoint> --x-token <token>
```

## 远程安装

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
- 移除冲突的 tracing 插件：当前会主动执行 `codex plugin remove tracing@codex-observability-plugin`，并清理其 `plugins.*` / `hooks.state.*` 残留配置，避免同一份 transcript 被两个 Stop hook 重复上报
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

默认生成的 `~/.codex/gtrace.json` 形态见 [configuration.md](configuration.md)。

配置完成后重启 Codex，让 Stop hook 重新加载。

## 只安装文件

如果只安装文件、稍后手动配置：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest --no-config
```

## 最小自检

安装后建议至少检查：

```bash
codex plugin list
codex plugin marketplace list
find ~/.codex/plugins/cache/codex-otel-plugin/tracing -maxdepth 2 -type d | sort
cat ~/.codex/gtrace.json
```

预期结果：

- `codex plugin list` 中存在 `tracing@codex-otel-plugin`，状态为 `installed, enabled`
- 如果本机装过 `codex-observability-plugin`，其 `tracing` 插件应已被移除
- `codex plugin marketplace list` 中存在 `codex-otel-plugin`
- cache 目录中存在版本目录，例如 `~/.codex/plugins/cache/codex-otel-plugin/tracing/0.1.5`
- `~/.codex/gtrace.json` 中包含 `endpoint`、`tracePath`、`metricsPath`、`headers.X-Token`

## 升级

升级使用同一条命令。已安装过的环境可以省略 `--endpoint` 和 `--x-token`，脚本会复用现有 `~/.codex/gtrace.json`：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest
```

升级脚本会重新下载插件文件、重写插件和 hook 配置，更新 `~/.codex/config.toml` 并同步 Codex 插件缓存；不会覆盖 `~/.codex/gtrace.json`。

安装指定版本：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- v0.1.5
```

如果需要指定自定义 release 资产地址，可以覆盖下载 URL：

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | CODEX_OTEL_ARCHIVE_URL=<plugin-release-tar-gz-url> bash -s -- latest --endpoint <endpoint> --x-token <token>
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

## 安装参数

| 参数 | 说明 |
| --- | --- |
| `latest` / `vX.Y.Z` / `X.Y.Z` | 安装版本，默认 `latest` |
| `--endpoint URL` | 接收端基础地址，例如 `https://llm-openway.guance.com` |
| `--x-token TOKEN` | 写入 `headers.X-Token` |
| `--trace-path PATH` | Trace 写入路径，GTrace 默认 `v1/write/otel-llm` |
| `--metrics-path PATH` | Metrics 写入路径，GTrace 默认 `v1/write/otel-metrics` |
| `--type gtrace|otlp` | 配置预设，默认 `gtrace` |
| `--header KEY=VALUE` | 追加 HTTP header，可重复 |
| `--tag KEY=VALUE` | 追加全局 resource attribute，可重复 |
| `--config-file PATH` | 指定上报配置文件，默认 `~/.codex/gtrace.json` |
| `--codex-config PATH` | 指定 Codex 配置文件，默认 `~/.codex/config.toml` |
| `--no-config` | 只安装插件，不写 `gtrace.json` |

## 开发安装

如果需要从源码目录安装当前工作树：

```bash
git clone https://github.com/GuanceCloud/codex-otel-plugin.git
cd codex-otel-plugin
./scripts/install.sh --refresh --endpoint https://llm-openway.guance.com --x-token <token>
```
