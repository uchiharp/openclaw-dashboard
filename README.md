# 🦞 OpenClaw Dashboard

OpenClaw Agent 可视化管理面板——监控会话、查看对话、归档蒸馏、管理 Agent。

![Node.js](https://img.shields.io/badge/Node.js-≥18-green)
![License](https://img.shields.io/badge/License-MIT-blue)

## 截图

TODO: 添加截图

## 功能

- **Agent 总览** — 所有 Agent 运行状态、会话数、Token 使用率、磁盘占用
- **会话管理** — 查看对话详情、终止异常会话
- **AI 蒸馏归档** — 备份对话 → AI 生成摘要 → 自动清理
- **实时监控** — SSE 推送，会话变更无需刷新
- **定时任务** — 查看 Cron 任务状态
- **错误日志** — 汇总 Agent 错误，快速定位问题

## 前置条件

- [OpenClaw](https://github.com/openclaw/openclaw) 已安装并运行
- Node.js ≥ 18
- Dashboard 需要读取 OpenClaw 的数据目录，**请在运行 OpenClaw 的同一台机器上启动**

## 快速开始

### 1. 克隆 & 安装

```bash
git clone https://github.com/uchiharp/openclaw-dashboard.git
cd openclaw-dashboard
npm install
```

### 2. 启动

```bash
npm start
# 或开发模式（文件改动自动重启）
npm run dev
```

打开 [http://localhost:18790](http://localhost:18790) 即可访问。

### 3. 可选配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `DASHBOARD_PORT` | `18790` | 监听端口 |
| `DASHBOARD_TOKEN` | (无) | 设置后启用写操作认证（GET 不强制） |
| `DISTILL_AGENT` | (自动检测) | 归档蒸馏用的 agent，默认取第一个可用 agent |
| `DISTILL_TO_MEMPALACE` | `false` | 设为 `1` 或 `true` 启用蒸馏后存入 MemPalace |
| `GATEWAY_TOKEN` | (无) | Gateway API token，MemPalace 功能需要 |

启动时认证：

```bash
DASHBOARD_TOKEN=your-secret-here npm start
```

带认证时，写操作（终止、重置、归档）需在请求头中携带：

```
X-Dashboard-Token: your-secret-here
```

> 💡 如果不设置 `DASHBOARD_TOKEN`，所有操作无需认证。本地使用通常不需要。

### 4. AI 蒸馏归档（可选）

归档功能会调用 `openclaw agent` CLI 来生成会话摘要。如果需要：

- 确保 `openclaw` 命令可用（`which openclaw`）
- 确保 AI agent 已配置好 API key

归档流程：
1. 备份 JSONL 对话文件到 `~/.openclaw/workspace/memory/sessions/`
2. 逐个调用 AI 蒸馏生成摘要
3. 如果 AI 调用失败，降级为简单文本截取
4. 从 sessions.json 删除已归档会话，清理 JSONL 文件

## 使用说明

### 左侧边栏

- **Agent 列表** — 按最近活跃时间排序，点击查看详情
- **Logo 🦞** — 点击返回总览看板
- **定时任务** — 显示 Cron 任务运行状态

### Agent 详情页

| 按钮 | 功能 | 说明 |
|------|------|------|
| 📦 归档会话 | AI 蒸馏归档 | 备份 → 摘要 → 清理，异步执行 |
| 🗑 重置所有会话 | 清空 | **不可撤销**，会备份到本地 |
| 🔄 刷新 | 手动刷新 | 重新加载当前 Agent 数据 |
| 终止 | 终止会话 | 需二次确认 |

### 会话列表

- **展开/折叠** — 点击会话行可查看对话详情
- **状态颜色** — 🟡 运行中 · 🟢 已完成 · 🔴 失败 · 🟠 超时
- **使用率** — 显示 Token 上下文使用百分比

## 技术栈

- **后端**: Express 5 + 纯 Node.js（无模板引擎）
- **前端**: Tailwind CSS + Alpine.js（单文件 SPA）
- **部署**: 零构建，`npm install && npm start` 即可

## 项目结构

```
openclaw-dashboard/
├── server.mjs          # Express 后端（API + 静态文件）
├── public/
│   └── index.html      # 前端单页（Tailwind + Alpine.js）
├── package.json
├── .gitignore
└── README.md
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/system` | 系统信息、Gateway 状态 |
| GET | `/api/agents` | Agent 列表（含排序） |
| GET | `/api/agents/:id` | Agent 会话列表 |
| GET | `/api/agents/:id/running` | 正在运行的任务 |
| GET | `/api/agents/:id/logs` | 错误日志 |
| GET | `/api/agents/:id/disk` | 磁盘占用 |
| DELETE | `/api/sessions/:id` | 终止会话 |
| POST | `/api/agents/:id/sessions/reset` | 重置所有会话 |
| POST | `/api/agents/:id/sessions/archive` | 归档会话（AI 蒸馏） |
| GET | `/api/agents/:id/archive-status` | 归档任务状态 |
| GET | `/api/sessions/:id/content` | 会话对话内容（分页） |
| GET | `/api/cron` | 定时任务列表 |
| GET | `/api/events` | SSE 实时事件流 |

## 安全说明

- 默认不启用认证，适合本地使用
- 设置 `DASHBOARD_TOKEN` 后写操作需认证
- Token 启动时仅显示前4位
- 所有路由参数经过 `safeId` 校验（防路径遍历）
- 查询参数有上限限制

## 开发

```bash
# 开发模式（文件改动自动重启）
npm run dev

# 修改前端
# 直接编辑 public/index.html，刷新浏览器即可
```

## 许可

MIT
