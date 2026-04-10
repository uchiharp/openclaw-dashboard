import express from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT) || 18790;

// === 配置 ===
const OPENCLAW_HOME = path.join(process.env.HOME, '.openclaw');
const AGENTS_DIR = path.join(OPENCLAW_HOME, 'agents');
const CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
const LOG_DIR = '/tmp/openclaw';
const BACKUP_DIR = path.join(OPENCLAW_HOME, 'workspace', 'memory', 'sessions');

// Gateway API 配置（用于归档时调用 AI 蒸馏）
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '048db2a178e473f45b6bb8d7aed0da81fe9dc94592d823b8';

// Token 认证：通过环境变量 DASHBOARD_TOKEN 设置，未设置则不启用认证
// 启动时打印到终端，不通过 API 暴露（修复 QA P0：token 泄露）
const AUTH_TOKEN = process.env.DASHBOARD_TOKEN || '';
const requiresAuth = !!AUTH_TOKEN;

// === 中间件 ===
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Token 认证
app.use((req, res, next) => {
  if (!requiresAuth) return next();
  if (req.method === 'GET') return next(); // GET 不强制认证
  const token = req.headers['x-dashboard-token'];
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ code: 40100, data: null, message: 'invalid token' });
  }
  next();
});

// 统一响应格式
function ok(data, meta = {}) {
  return { code: 0, data, message: 'ok', meta };
}
function err(code, message) {
  return { code, data: null, message };
}

// === 写操作锁 ===
const inflightOps = new Map();
function withLock(key, fn) {
  if (inflightOps.has(key)) return err(42900, 'operation already in progress');
  inflightOps.set(key, true);
  try { return fn(); }
  finally { inflightOps.delete(key); }
}

// === 数据读取工具 ===
function safeReadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return { data: JSON.parse(raw), quality: 'ok' };
  } catch (e) {
    if (e.code === 'ENOENT') return { data: null, quality: 'missing' };
    return { data: null, quality: 'corrupted', error: e.message };
  }
}

function safeExec(cmd, timeout = 5000) {
  try {
    const result = execSync(cmd, { timeout, encoding: 'utf-8', shell: '/bin/zsh' });
    return { data: result.trim(), quality: 'ok' };
  } catch (e) {
    return { data: null, quality: 'error', error: e.message.slice(0, 200) };
  }
}

function tailJSONL(filePath, n = 30) {
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    if (fileSize === 0) return [];
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(fileSize, 64 * 1024));
    const readStart = Math.max(0, fileSize - buf.length);
    fs.readSync(fd, buf, 0, buf.length, readStart);
    fs.closeSync(fd);
    const content = buf.toString('utf-8');
    const lines = content.split('\n').filter(Boolean);
    const result = [];
    for (let i = lines.length - 1; i >= 0 && result.length < n; i--) {
      try { result.unshift(JSON.parse(lines[i])); } catch {}
    }
    return result;
  } catch { return []; }
}

function getAgentSessions(agentId) {
  const sj = path.join(AGENTS_DIR, agentId, 'sessions', 'sessions.json');
  const { data, quality } = safeReadJSON(sj);
  if (!data || quality !== 'ok') return { sessions: [], quality };
  const sessions = Object.entries(data).map(([key, v]) => ({
    sessionKey: key, sessionId: v.sessionId || '', status: v.status || 'unknown',
    model: v.model || '', totalTokens: v.totalTokens || 0, contextTokens: v.contextTokens || 0,
    updatedAt: v.updatedAt || 0, createdAt: v.createdAt || 0, kind: v.kind || '',
  }));
  return { sessions, quality: 'ok' };
}

function usagePercent(total, context) {
  if (!context || context === 0) return 0;
  return Math.round((total / context) * 100);
}

// === 磁盘计算（纯 Node.js，无 shell 调用）修复 Architect P0 ===
function getDirSize(dirPath) {
  try {
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) total += getDirSize(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
    return total;
  } catch { return 0; }
}

// 缓存磁盘大小（5 分钟过期）
const diskCache = new Map();
const DISK_CACHE_TTL = 5 * 60 * 1000;
function getCachedDirSize(dirPath) {
  const now = Date.now();
  const cached = diskCache.get(dirPath);
  if (cached && now - cached.ts < DISK_CACHE_TTL) return cached.size;
  const size = getDirSize(dirPath);
  diskCache.set(dirPath, { size, ts: now });
  return size;
}

// === 原子写入（修复 QA P1：sessions.json 写入与 Gateway 冲突） ===
function atomicWriteJSON(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath); // rename 是原子的
}

// === SSE 事件广播（修复 Architect P1：SSE 已建但没用） ===
const sseClients = new Set();
function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
}

// === 路由 ===

// 系统信息（不暴露 token）
app.get('/api/system', (req, res) => {
  const configResult = safeReadJSON(CONFIG_PATH);
  const config = configResult.data || {};
  const agents = (config.agents?.list || []).map(a => ({
    id: a.id, name: a.identity?.name || a.id, emoji: a.identity?.emoji || '🤖',
  }));
  const healthResult = safeExec('openclaw health --json 2>/dev/null');
  let health = null;
  try { health = JSON.parse(healthResult.data || 'null'); } catch {}
  res.json(ok({ authenticated: requiresAuth, agents, health, uptime: process.uptime() }));
});

// Agent 总览（修复 QA P1：readdir 加 try-catch）
app.get('/api/agents', (req, res) => {
  let agentDirs;
  try {
    agentDirs = fs.readdirSync(AGENTS_DIR).filter(d =>
      fs.statSync(path.join(AGENTS_DIR, d)).isDirectory()
    );
  } catch { return res.json(ok([])); }

  const configResult = safeReadJSON(CONFIG_PATH);
  const agentList = configResult.data?.agents?.list || [];
  const agentMap = {};
  for (const a of agentList) agentMap[a.id] = a;

  const result = agentDirs.map(id => {
    const identity = agentMap[id]?.identity || {};
    const { sessions, quality } = getAgentSessions(id);
    const running = sessions.filter(s => s.status === 'running').length;
    const done = sessions.filter(s => s.status === 'done').length;
    const failed = sessions.filter(s => s.status === 'failed').length;
    const totalTokens = sessions.reduce((sum, s) => sum + s.totalTokens, 0);
    const maxUsage = sessions.reduce((max, s) => {
      const pct = usagePercent(s.totalTokens, s.contextTokens);
      return pct > max ? pct : max;
    }, 0);

    return {
      id, name: identity.name || id, emoji: identity.emoji || '🤖',
      dataQuality: quality, sessionCount: sessions.length,
      running, done, failed, totalTokens, maxUsage,
      diskUsage: getCachedDirSize(path.join(AGENTS_DIR, id, 'sessions')),
    };
  });

  res.json(ok(result));
});

// 单个 Agent 详情
app.get('/api/agents/:id', (req, res) => {
  const { id } = req.params;
  const { sessions, quality } = getAgentSessions(id);
  const now = Date.now();
  const withUsage = sessions
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(s => ({
      ...s,
      usage: usagePercent(s.totalTokens, s.contextTokens),
      ageMinutes: Math.round((now - (s.updatedAt || 0)) / 60000),
    }));
  res.json(ok({ sessions: withUsage, dataQuality: quality }));
});

// Agent 错误日志（修复 Architect P1：优先 Gateway 日志，限制 JSONL 扫描）
app.get('/api/agents/:id/logs', (req, res) => {
  const { id } = req.params;
  const limit = parseInt(req.query.limit) || 20;
  const errors = [];
  const now = Date.now();

  // 优先查 Gateway 日志
  try {
    const logFiles = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log')).sort();
    const latestLog = logFiles[logFiles.length - 1];
    if (latestLog) {
      const lines = tailJSONL(path.join(LOG_DIR, latestLog), 200);
      for (const line of lines) {
        const str = JSON.stringify(line);
        if (str.includes(id) && (str.includes('"error"') || str.includes('429') || str.includes('failed'))) {
          const ts = line._meta?.date || line.time || '';
          errors.push({
            source: 'gateway-log', agent: id, snippet: str.slice(0, 300),
            timestamp: ts, ageMinutes: ts ? Math.round((now - new Date(ts).getTime()) / 60000) : null,
          });
        }
      }
    }
  } catch {}

  // 不够时再扫最近 5 个 JSONL
  if (errors.length < limit) {
    const { sessions } = getAgentSessions(id);
    const recentSessions = sessions
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 5);

    for (const session of recentSessions) {
      if (!session.sessionId) continue;
      const jf = path.join(AGENTS_DIR, id, 'sessions', `${session.sessionId}.jsonl`);
      const lines = tailJSONL(jf, 50);
      for (const line of lines) {
        const msg = line.message || {};
        if (msg.errorMessage || msg.stopReason === 'error') {
          errors.push({
            sessionId: session.sessionId, sessionKey: session.sessionKey, role: msg.role || '',
            error: (msg.errorMessage || 'stopReason: error').slice(0, 300),
            timestamp: line.timestamp || '',
            ageMinutes: line.timestamp ? Math.round((now - new Date(line.timestamp).getTime()) / 60000) : null,
          });
        }
      }
    }
  }

  errors.sort((a, b) => (b.ageMinutes || 99999) - (a.ageMinutes || 99999));
  res.json(ok(errors.slice(0, limit)));
});

// Agent 磁盘占用（纯 Node.js）
app.get('/api/agents/:id/disk', (req, res) => {
  const { id } = req.params;
  const sessionsDir = path.join(AGENTS_DIR, id, 'sessions');
  const workspaceDir = path.join(AGENTS_DIR, id, 'workspace');
  const sessionsSize = getCachedDirSize(sessionsDir);
  const workspaceSize = getCachedDirSize(workspaceDir);
  let fileCount = 0;
  try { fileCount = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')).length; } catch {}
  res.json(ok({ sessionsSize, workspaceSize, totalSize: sessionsSize + workspaceSize, fileCount }));
});

// Agent 正在执行的任务
app.get('/api/agents/:id/running', (req, res) => {
  const { id } = req.params;
  const { sessions } = getAgentSessions(id);
  const now = Date.now();
  const runningTasks = sessions.filter(s => s.status === 'running').map(s => {
    const lines = tailJSONL(path.join(AGENTS_DIR, id, 'sessions', `${s.sessionId}.jsonl`), 10);
    const lastActions = [];
    for (const line of lines) {
      const msg = line.message || {};
      if (msg.role === 'assistant') {
        for (const c of (msg.content || [])) {
          if (c.type === 'toolCall') lastActions.push({ tool: c.name, args: JSON.stringify(c.arguments || {}).slice(0, 150), timestamp: line.timestamp || '' });
          if (c.type === 'text' && c.text) lastActions.push({ type: 'text', text: c.text.slice(0, 200), timestamp: line.timestamp || '' });
        }
      }
    }
    return { sessionKey: s.sessionKey, sessionId: s.sessionId, model: s.model, ageMinutes: Math.round((now - (s.updatedAt || 0)) / 60000), lastActions: lastActions.reverse() };
  });
  res.json(ok(runningTasks));
});

// Kill Session
app.delete('/api/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const result = withLock(`session-${sessionId}`, () => {
    let agentDirs;
    try { agentDirs = fs.readdirSync(AGENTS_DIR); } catch { return err(50000, 'cannot read agents dir'); }

    for (const agentId of agentDirs) {
      const sj = path.join(AGENTS_DIR, agentId, 'sessions', 'sessions.json');
      const { data, quality } = safeReadJSON(sj);
      if (!data || quality !== 'ok') continue;
      const targetKey = Object.keys(data).find(k => data[k].sessionId === sessionId);
      if (!targetKey) continue;

      const status = data[targetKey].status;
      try { fs.unlinkSync(path.join(AGENTS_DIR, agentId, 'sessions', `${sessionId}.jsonl`)); } catch {}

      const backupDir = path.join(OPENCLAW_HOME, 'workspace', 'memory', 'sessions', agentId);
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, `${sessionId}.meta.json`), JSON.stringify({
          ...data[targetKey], killedAt: new Date().toISOString(), killedBy: 'dashboard',
        }, null, 2));
      } catch {}

      delete data[targetKey];
      atomicWriteJSON(sj, data);
      broadcastSSE('session-killed', { agentId, sessionId, sessionKey: targetKey });
      return ok({ killed: true, agentId, sessionKey: targetKey, previousStatus: status });
    }
    return err(40400, 'session not found');
  });
  res.json(result);
});

// Reset Agent
app.post('/api/agents/:id/sessions/reset', (req, res) => {
  const { id } = req.params;
  const result = withLock(`reset-${id}`, () => {
    const sj = path.join(AGENTS_DIR, id, 'sessions', 'sessions.json');
    const { data, quality } = safeReadJSON(sj);
    if (!data || quality !== 'ok') return err(40400, 'agent sessions not found');

    let deleted = 0;
    for (const key of Object.keys(data)) {
      const sid = data[key].sessionId;
      if (sid) { try { fs.unlinkSync(path.join(AGENTS_DIR, id, 'sessions', `${sid}.jsonl`)); } catch {} }
      deleted++;
    }

    const backupDir = path.join(OPENCLAW_HOME, 'workspace', 'memory', 'sessions', id);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, `sessions-reset-${Date.now()}.json`), JSON.stringify(data, null, 2));

    atomicWriteJSON(sj, {});
    broadcastSSE('agent-reset', { agentId: id, deletedSessions: deleted });
    return ok({ reset: true, agentId: id, deletedSessions: deleted });
  });
  res.json(result);
});

// 归档 Agent（混合方案：备份 → AI 蒸馏 → 清理）
// 状态存储在 ~/.openclaw/workspace/dashboard/archive-tasks.json
app.post('/api/agents/:id/sessions/archive', async (req, res) => {
  const { id } = req.params;
  const lockKey = `archive-${id}`;
  const result = withLock(lockKey, () => {
    // 第一步：读取 session 列表
    const sj = path.join(AGENTS_DIR, id, 'sessions', 'sessions.json');
    const { data, quality } = safeReadJSON(sj);
    if (!data || quality !== 'ok') return err(40400, 'agent sessions not found');

    // 筛选可归档的 session（非 running，使用率 > 0）
    const archivable = [];
    for (const [key, v] of Object.entries(data)) {
      if (v.status === 'running') continue;
      const sid = v.sessionId;
      if (!sid) continue;
      const jf = path.join(AGENTS_DIR, id, 'sessions', `${sid}.jsonl`);
      if (!fs.existsSync(jf)) continue;
      const usage = usagePercent(v.totalTokens || 0, v.contextTokens || 0);
      archivable.push({ key, sid, status: v.status, usage, jsonlPath: jf, meta: v });
    }

    if (archivable.length === 0) return ok({ archived: false, message: '没有可归档的会话' });

    // 第二步：备份 JSONL 文件到安全位置
    const backupDir = path.join(BACKUP_DIR, id);
    fs.mkdirSync(backupDir, { recursive: true });
    const backedUp = [];
    for (const s of archivable) {
      const dest = path.join(backupDir, `${s.sid}.jsonl`);
 try {
        fs.copyFileSync(s.jsonlPath, dest);
        backedUp.push(s.sid);
      } catch {}
    }

    // 第三步：通过 Gateway API 让 AI 执行蒸馏
    // 异步执行，不阻塞响应
    const archiveTaskId = `archive-${id}-${Date.now()}`;
    const taskFile = path.join(__dirname, 'archive-tasks.json');
    let tasks = {};
    try { tasks = JSON.parse(fs.readFileSync(taskFile, 'utf-8')); } catch {}
    tasks[archiveTaskId] = {
      agentId: id,
      status: 'distilling',
      totalSessions: archivable.length,
      backedUp,
      startedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    fs.writeFileSync(taskFile, JSON.stringify(tasks, null, 2));

    // 异步执行 AI 蒸馏（不阻塞 HTTP 响应）
    (async () => {
      try {
        const archived = [];
        const failed = [];

        for (const s of archivable) {
          // 读取 JSONL 尾部内容（最近 80 条对话）
          const lines = tailJSONL(s.jsonlPath, 80);
          const dialogContent = lines
            .filter(l => l.message?.role && ['user', 'assistant'].includes(l.message.role))
            .map(l => {
              const role = l.message.role === 'user' ? '用户' : 'AI';
              const text = (l.message.content || [])
                .filter(c => c.type === 'text')
                .map(c => c.text?.slice(0, 800) || '')
                .join('');
              return `${role}: ${text.slice(0, 500)}`;
            })
            .join('\n');

          if (!dialogContent.trim()) {
            failed.push({ sid: s.sid, reason: '无对话内容' });
            archived.push(s.sid); // 仍然归档（备份已有）
            continue;
          }

          // 通过 openclaw agent CLI 调用 AI 蒸馏
          let summary = dialogContent.slice(0, 500); // 默认降级
          try {
            const distillPrompt = `请将以下对话蒸馏为不超过300字的摘要。只保留关键决策、重要结论和待办事项，去掉闲聊和重复内容。直接输出摘要，不要加任何前缀。\n\n---\n${dialogContent.slice(0, 8000)}`;
            // 用 execSync 同步调用（在 async 块中可以 wrap）
            const result = execSync(`openclaw agent --agent learn --message ${JSON.stringify(distillPrompt)}`, {
                timeout: 60000, encoding: 'utf-8', shell: '/bin/zsh'
              }).trim();
            if (result && result.length > 10) {
              summary = result.slice(0, 1000);
            }
          } catch (e) {
            // 蒸馏失败，使用简单截取作为降级
            console.log(`[archive] distill failed for ${s.sid}: ${e.message.slice(0, 100)}`);
          }

          // 存储摘要文件
          const summaryFile = path.join(backupDir, `${s.sid}.summary.md`);
          const summaryText = `# ${id} 会话摘要\n\n**Session:** ${s.sid}\n**时间:** ${s.meta.updatedAt ? new Date(s.meta.updatedAt).toLocaleString('zh-CN') : '未知'}\n**状态:** ${s.status}\n**使用率:** ${s.usage}%\n\n## 摘要\n\n${summary}\n\n---\n*归档时间: ${new Date().toISOString()}*\n*由 Dashboard AI 蒸馏归档*`;
          fs.writeFileSync(summaryFile, summaryText);
          archived.push(s.sid);
        }

        // 第四步：蒸馏完成后，从 sessions.json 删除已归档的 session
        if (archived.length > 0) {
          const { data: currentData } = safeReadJSON(sj);
          if (currentData) {
            for (const sid of archived) {
              const targetKey = Object.keys(currentData).find(k => currentData[k].sessionId === sid);
              if (targetKey) delete currentData[targetKey];
              try { fs.unlinkSync(path.join(AGENTS_DIR, id, 'sessions', `${sid}.jsonl`)); } catch {}
            }
            atomicWriteJSON(sj, currentData);
          }
        }

        // 更新任务状态
        try {
          const tasksNow = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
          if (tasksNow[archiveTaskId]) {
            tasksNow[archiveTaskId].status = 'done';
            tasksNow[archiveTaskId].archived = archived;
            tasksNow[archiveTaskId].failed = failed;
            tasksNow[archiveTaskId].completedAt = new Date().toISOString();
            fs.writeFileSync(taskFile, JSON.stringify(tasksNow, null, 2));
          }
        } catch {}

        broadcastSSE('archive-complete', { agentId: id, archived: archived.length, failed: failed.length });
      } catch (e) {
        // 更新任务状态为失败
        try {
          const tasksNow = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
          if (tasksNow[archiveTaskId]) {
            tasksNow[archiveTaskId].status = 'error';
            tasksNow[archiveTaskId].error = e.message;
            tasksNow[archiveTaskId].completedAt = new Date().toISOString();
            fs.writeFileSync(taskFile, JSON.stringify(tasksNow, null, 2));
          }
        } catch {}
        broadcastSSE('archive-error', { agentId: id, error: e.message });
      }
    })();

    return ok({
      archived: false,
      taskId: archiveTaskId,
      message: `开始归档 ${archivable.length} 个会话，备份已完成，AI 蒸馏中...`,
      backedUp: backedUp.length,
      toDistill: archivable.length,
    });
  });
  res.json(result);
});

// 查询归档任务状态
app.get('/api/agents/:id/archive-status', (req, res) => {
  try {
    const taskFile = path.join(__dirname, 'archive-tasks.json');
    const tasks = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
    const agentTasks = Object.entries(tasks)
      .filter(([_, t]) => t.agentId === req.params.id)
      .map(([id, t]) => ({ id, ...t }))
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    res.json(ok(agentTasks.slice(0, 5)));
  } catch {
    res.json(ok([]));
  }
});

// Cron 任务列表
app.get('/api/cron', (req, res) => {
  const result = safeExec('openclaw cron list --json 2>/dev/null', 5000);
  if (result.quality !== 'ok') return res.json(ok([], { cronQuality: result.quality }));
  try {
    const crons = JSON.parse(result.data).map(c => ({
      id: c.id, name: c.name, description: c.description, enabled: c.enabled,
      schedule: c.schedule?.expr || '', timezone: c.schedule?.tz || '', model: c.payload?.model || '',
      state: c.state ? {
        lastStatus: c.state.lastStatus,
        lastRunAt: c.state.lastRunAtMs ? new Date(c.state.lastRunAtMs).toLocaleString('zh-CN') : null,
        nextRunAt: c.state.nextRunAtMs ? new Date(c.state.nextRunAtMs).toLocaleString('zh-CN') : null,
        consecutiveErrors: c.state.consecutiveErrors || 0, lastError: c.state.lastError || null,
        lastDuration: c.state.lastDurationMs ? `${Math.round(c.state.lastDurationMs / 1000)}s` : null,
      } : null,
      delivery: c.delivery ? { mode: c.delivery.mode, channel: c.delivery.channel, to: c.delivery.to } : null,
    }));
    res.json(ok(crons));
  } catch { res.json(ok([], { cronQuality: 'parse-error' })); }
});

// 飞书渠道状态
app.get('/api/channels', (req, res) => {
  const { data: config } = safeReadJSON(CONFIG_PATH);
  if (!config) return res.json(ok([]));
  const channels = [];
  for (const [accountId, account] of Object.entries(config.channels?.feishu?.accounts || {})) {
    channels.push({ provider: 'feishu', accountId, appId: account.appId, displayName: account.displayName || accountId });
  }
  res.json(ok(channels));
});

// MemPalace
app.get('/api/mempalace', (req, res) => {
  res.json(ok({ available: false, note: 'MemPalace 是独立 MCP 服务，需要通过 Gateway 工具调用。' }));
});

// SSE 实时推送
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); } }, 30000);
  req.on('close', () => clearInterval(heartbeat));
});

// 启动
app.listen(PORT, '127.0.0.1', () => {
  console.log(`
╔══════════════════════════════════════════╗
║   OpenClaw Agent Dashboard              ║
║   http://localhost:${PORT}                 ║
║   Auth: ${requiresAuth ? 'ENABLED (token required for writes)' : 'disabled (set DASHBOARD_TOKEN to enable)'}
${requiresAuth ? `║   Token: ${AUTH_TOKEN}` : '║   (no token set, all local access allowed)'}
╚══════════════════════════════════════════╝
  `);
});
