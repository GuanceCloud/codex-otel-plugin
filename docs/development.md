# 开发与调试

本文档说明 `codex-otel-plugin` 的本地开发命令、调试服务、验证方式和排查命令。

## 常用命令

```bash
npm test
npm ls --all
npm start
npm run codex:hook
```

`npm start` 会启动本地调试服务，默认监听：

```text
http://localhost:3030
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
| `POST` | `/api/public/otel/v1/metrics` | 接收 OTLP Metrics JSON/protobuf |
| `POST` | `/api/gtrace/v1/codex-spans` | 接收原生 JSON 调试 span |
| `GET` | `/traces?limit=50` | 查看最近规范化 span |
| `GET` | `/metrics?limit=50` | 查看最近规范化 metric data point |

本地落盘目录：

```text
data/batches/*.json
data/spans.ndjson
data/metrics.ndjson
```

`data/` 只用于调试，不是字段规范来源。

## 验证

修改代码、字段口径或文档口径后，至少运行：

```bash
npm test
npm ls --all
```

期望结果：

```text
10 tests passed
```

```text
gtrace@0.1.2 /home/liurui/code/codex-otel-plugin
└── (empty)
```

当前测试覆盖：

- OTLP JSON ingest
- OTLP protobuf ingest
- Codex hook 解析 rollout 并上报 OTLP Trace/Metrics protobuf
- Stop hook 早于 `task_complete` 写入时的 completed 状态推断
- 空白启动 turn 过滤，不生成 OTLP span

## 排查

查看 hook 日志：

```bash
tail -n 100 ~/.codex/gtrace-hook.log
```

查看本地 ingest 数据：

```bash
curl "http://localhost:3030/traces?limit=20"
curl "http://localhost:3030/metrics?limit=20"
tail -n 20 data/spans.ndjson
tail -n 20 data/metrics.ndjson
ls -lt data/batches | head
```

查看已上传 turn 标记：

```bash
find ~/.codex/sessions -name "*.gtrace" -type f
```

`.gtrace` 文件按行记录 `turnId<TAB>fingerprint`。旧版本留下的纯 `turnId` 行仍会兼容读取。

查看并发去重锁：

```bash
find ~/.codex/sessions -name "*.gtrace.lock" -type f
```

如果 Stop hook 报错，优先检查：

- `~/.codex/gtrace.json` 是否启用
- `endpoint`、`tracePath`、`metricsPath`、`otel_traces_url` 或 `otel_metrics_url` 是否指向正确 OTLP 接口
- 认证 header 是否正确
- `~/.codex/gtrace-hook.log` 中的 HTTP 状态码和错误信息
- 如果看到重复数据，检查 `~/.codex/gtrace-hook.log` 是否存在 `skipped duplicate hook run`，它表示同一个 transcript 的并发 hook 已被锁抑制
- 再检查对应 transcript 的 `.gtrace` 是否持续增长但内容指纹没有变化；同一 `turnId` 的相同 fingerprint 不应再次上传
