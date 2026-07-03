# Changelog

按日期记录项目功能与代码提交。

## 2026-07-02

- 发布 `v0.1.8`
- 将 `gen_ai.agent.operation.count` 从逐 span 上报改为按 turn 内 operation 维度聚合后上报
- 明确文档口径：`gen_ai.agent.operation.count` 为 turn 内聚合值，`gen_ai.agent.operation.duration` 仍按 span 上报

- 发布 `v0.1.7`
- 将 `gen_ai.agent.operation.count` 的 OTLP Sum data point 编码改为 `asDouble`，兼容目标端对计数指标的识别
- 补充 metrics 文档，明确 operation 指标只覆盖 `llm`、`skill:*`、`tool:*`，不包含 `invoke_agent`、`assistant`

- 发布 `v0.1.6`
- 增强 Codex Stop hook 启动期与异常期诊断日志，补充 `hook invoked`、异常 phase 和 stack 记录
- 新增 `timeout_ms` 配置，默认单次 OTLP HTTP 请求超时调整为 `25000ms`
- 安装脚本生成的 Stop hook 总超时从 `30s` 提高到 `60s`，降低 trace 和 metrics 串行上报被截断的概率

## 2026-06-17

- 11:46 提交代码：新增 configuration.md, development.md, install.md 等 5 项；更新 AGENTS.md, README.md, metrics.md, codex-config.js
