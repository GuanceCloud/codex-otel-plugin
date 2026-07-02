# Changelog

按日期记录项目功能与代码提交。

## 2026-07-02

- 发布 `v0.1.6`
- 增强 Codex Stop hook 启动期与异常期诊断日志，补充 `hook invoked`、异常 phase 和 stack 记录
- 新增 `timeout_ms` 配置，默认单次 OTLP HTTP 请求超时调整为 `25000ms`
- 安装脚本生成的 Stop hook 总超时从 `30s` 提高到 `60s`，降低 trace 和 metrics 串行上报被截断的概率

## 2026-06-17

- 11:46 提交代码：新增 configuration.md, development.md, install.md 等 5 项；更新 AGENTS.md, README.md, metrics.md, codex-config.js
