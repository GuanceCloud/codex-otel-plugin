# Changelog

按日期记录项目功能与代码提交。

## 2026-07-22

- 发布 `v0.1.14`
- 将 `gtrace.json` 的写入时机调整到 `codex plugin add` 之后，避免 macOS 安装链路把旧的 `X-Token`、`agent_id`、`agent_name` 回写回来
- 补充安装配置覆盖行为的回归测试

## 2026-07-16

- 发布 `v0.1.13`
- 新增 Windows 本地与远程 PowerShell 安装器，发布构建同时生成 ZIP 资产
- 明确 `gtrace.json.enabled` 为 hook 脚本启停开关，关闭时在读取 stdin/transcript 前退出
- Linux/macOS 与 Windows 安装器支持显式启停参数，普通升级保留已有 `enabled` 值
- 修复 Windows 下 ESM 入口文件 URL 判断和默认数据目录路径转换

## 2026-07-02

- 发布 `v0.1.12`
- `gen_ai.agent.operation.count` 与 `gen_ai.agent.operation.duration` 的指标 tag 统一从 `outcome` 切换到 `status`
- 同步更新 metrics 文档、README、AGENTS 与测试断言，移除 operation metrics 对 `outcome` 的使用

- 发布 `v0.1.11`
- `assistant` span 新增 `gen_ai.output.messages`，与现有 `output_preview` 对齐
- `gen_ai.tool.call.result` 改为直接保留原始 tool 结果，字符串保留原文和换行，对象/数组保留结构

- 发布 `v0.1.9`
- `invoke_agent` 移除 `gen_ai.usage.*` 聚合 tag，仅在 `llm` span 保留 token usage 字段
- 同一 `llm` step 内多个 tool 命中同一 skill 目录时，合并为单个 `skill:<name>` span，避免重复 skill 记录

- 发布 `v0.1.8`
- 调整 `gen_ai.agent.operation.count`：恢复按 span 上报，移除 `operation_name`，并精简 count attrs
- 当 `debug=true` 时，在 hook 日志中输出完整 metrics payload，包含完整 metric attrs/resource tags

- 发布 `v0.1.7`
- 将 `gen_ai.agent.operation.count` 的 OTLP Sum data point 编码改为 `asDouble`，兼容目标端对计数指标的识别
- 补充 metrics 文档，明确 operation 指标只覆盖 `llm`、`skill:*`、`tool:*`，不包含 `invoke_agent`、`assistant`

- 发布 `v0.1.6`
- 增强 Codex Stop hook 启动期与异常期诊断日志，补充 `hook invoked`、异常 phase 和 stack 记录
- 新增 `timeout_ms` 配置，默认单次 OTLP HTTP 请求超时调整为 `25000ms`
- 安装脚本生成的 Stop hook 总超时从 `30s` 提高到 `60s`，降低 trace 和 metrics 串行上报被截断的概率

## 2026-06-17

- 11:46 提交代码：新增 configuration.md, development.md, install.md 等 5 项；更新 AGENTS.md, README.md, metrics.md, codex-config.js
