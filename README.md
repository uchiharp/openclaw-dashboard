# OpenClaw Dashboard

Agent 监控面板 —— 查看 OpenClaw 所有 agent 的运行状态、会话列表、使用率，并支持 AI 蒸馏归档。

## 功能

- 📊 **Agent 概览** — 全局状态、运行数、失败数、磁盘占用
- 📋 **会话列表** — 每个 agent 的历史会话、使用率、模型信息
- ⚡ **运行中任务** — 实时查看正在执行的 agent 任务
- 📦 **AI 蒸馏归档** — 一键备份并让 AI 生成会话摘要
- 🗑 **会话管理** — 终止/重置会话
- ⏰ **自动刷新** — 30 秒倒计时自动更新

## 启动

```bash
cd ~/.openclaw/workspace/dashboard
node server.mjs
```

访问 http://localhost:18790

## 技术栈

- **后端**: Node.js + Express
- **前端**: Alpine.js + Tailwind CSS（单文件 SPA）
- **数据源**: 直接读取 `~/.openclaw/agents/*/sessions/sessions.json`
- **蒸馏**: 通过 `openclaw agent` CLI 调用 AI 生成摘要
