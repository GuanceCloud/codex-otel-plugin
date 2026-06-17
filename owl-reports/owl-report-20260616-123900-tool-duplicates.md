# 工具调用重复显示排查报告

## 范围

- 时间范围：2026-06-16 12:20:00 到 2026-06-16 12:30:00 Asia/Shanghai
- 数据域：本地 Codex rollout、Guance DQL T/LLM 查询
- Session ID：`019ece6e-9c09-7163-a51d-f46efa8af46a`
- Run ID：`019eceab-1654-7b53-a93b-84f403c10775`

## 发现

- Guance DQL T/LLM 查询在当前 owl 工作空间未命中该 `session_id/run_id/trace_id`，无法用远端 DQL 明细直接证明。
- 本地 rollout 命中该 session/run，且 `.gtrace` sidecar 已包含该 run_id，说明该 turn 已被上传标记处理。
- 本地解析该 run 后，截图中看似重复的工具记录对应不同 `tool_call_id` 和不同命令。

## 证据

- `2026-06-16 12:24:29` 两条 `exec_command`：
  - `npm test`
  - `npm ls --all`
- `2026-06-16 12:24:35` 两条 `exec_command`：
  - `bash scripts/build-release.sh && cat dist/SHA256SUMS`
  - `git diff --stat && git status --short --branch`
- `2026-06-16 12:25:04` 三条 `exec_command`：
  - `gh release download ...`
  - `git status --short --branch`
  - `gh release view v0.1.1 ...`

## 判断

- 事实：这些记录不是同一个 `tool_call_id` 的重复 span，而是同一 step 内并行执行的多个工具调用。
- 事实：当前 UI 的“目标/命令”列显示为 `-`，导致不同命令看起来像重复数据。
- 推断：调用分析表需要优先展示 `tool_target_command` / `tool_command`，否则并行工具调用很容易被误判为重复。

## 已处理

- parser 增加同 `call_id` 工具调用去重，防止真实重复事件生成重复 span。
- collector 新增 `tool_command` 和 `tool_target_command` 字段，从 `args.cmd` 或 `args.command` 提取。
- 文档和测试已同步。
- `v0.1.1` release 已覆盖发布。

## 验证

- `npm test` 通过。
- `npm ls --all` 为空依赖树。
- 已下载 `v0.1.1` release 包验证字段和测试存在。
