// src/server.mjs —— 手机端 HTTP + SSE 服务端
// 职责：静态资源 relay.html + Bearer 鉴权 + REST API + SSE 实时流 + 终端/文件操作
// 零依赖：Node 22+ 内置 http / fs / child_process / 全局 fetch & WebSocket
import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  listWorkspaces, listSessions, createSession, getHistory,
  promptSession, cancelSession, selectModel, listModels,
  historyToMessages, normPath, baseName,
} from './dsh-client.mjs';
import { PORT, TOKEN, DEFAULT_CWD, ALLOW_INTERNET, VERSION } from './config.mjs';
import { createSyncBridge } from './sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// ---- 请求解析工具 ----
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function authOk(req) {
  if (!TOKEN) return true; // 未设 token → 不鉴权（仅本机/受信网络使用）
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7) === TOKEN;
  // 也支持 ?token= 查询参数（SSE/静态页方便）
  const u = new URL(req.url, 'http://x');
  return u.searchParams.get('token') === TOKEN;
}

// ---- 会话 ↔ 工作区分组（与 DSH cwd 前缀为准）----
async function groupedWorkspaces() {
  const [ws, ss] = await Promise.all([listWorkspaces(), listSessions()]);
  const matched = new Map();
  for (const w of ws) matched.set(w.workspaceId, new Set((w.sessionIds || []).filter(Boolean)));
  const sorted = [...ws].sort((a, b) => normPath(b.path).length - normPath(a.path).length);
  for (const s of ss) {
    const cwd = normPath(s.cwd);
    if (!cwd) continue;
    const w = sorted.find((x) => { const p = normPath(x.path); return cwd === p || cwd.startsWith(p + '/'); });
    if (w) { const set = matched.get(w.workspaceId); if (set) set.add(s.sessionId); }
  }
  return ws.map((w) => ({
    workspaceId: w.workspaceId, path: w.path, title: w.title || null,
    sessionCount: (matched.get(w.workspaceId) || new Set()).size,
  })).sort((a, b) => b.sessionCount - a.sessionCount);
}

// ---- 终端：在电脑上执行命令（流式 stdout/stderr）----
function runTerminal(command, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/c', command] : ['-c', command],
      { cwd: cwd || DEFAULT_CWD, env: process.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({
      ok: code === 0, exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(),
      elapsedMs: Date.now() - started,
    }));
    child.on('error', (e) => resolve({ ok: false, exitCode: -1, stdout: '', stderr: String(e), elapsedMs: Date.now() - started }));
  });
}

// ---- 文件浏览 ----
async function listFiles(dir) {
  const target = dir || DEFAULT_CWD;
  const entries = await readdir(target, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (e) => {
    const full = path.join(target, e.name);
    let size, mtime;
    try { const s = await stat(full); size = s.size; mtime = s.mtimeMs; } catch {}
    return { name: e.name, dir: e.isDirectory(), size, mtime };
  }));
  return { path: target, items: items.sort((a, b) => (b.dir - a.dir) || String(a.name).localeCompare(String(b.name))) };
}
async function readFileContent(file) {
  const data = await readFile(file, 'utf8');
  return { path: file, content: data, size: data.length };
}

// ---- 路由 ----
export function createServer(eventStore) {
  const sync = createSyncBridge();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    // CORS（方便手机跨域 / 本地调试）
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // ---- 静态资源（relay.html 等，无需鉴权以加载登录页）----
    if ((req.method === 'GET') && (pathname === '/' || pathname === '/index.html')) {
      try {
        const html = await readFile(path.join(WEB_DIR, 'relay.html'), 'utf8');
        res.writeHead(200, { 'content-type': MIME['.html'] });
        return res.end(html);
      } catch { return sendJson(res, 404, { error: '前端文件缺失，请确认 web/relay.html 存在' }); }
    }
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, version: VERSION, authRequired: !!TOKEN });
    }

    // ---- 鉴权 ----
    if (!authOk(req)) return sendJson(res, 401, { error: '未授权：请提供正确的 token' });

    try {
      // ============ 会话 / 工作区 ============
      if (req.method === 'GET' && pathname === '/api/workspaces') {
        return sendJson(res, 200, { items: await groupedWorkspaces() });
      }
      if (req.method === 'GET' && pathname === '/api/sessions') {
        const wsId = url.searchParams.get('workspace');
        let items = await listSessions();
        if (wsId) {
          const [ws] = (await listWorkspaces()).filter((w) => w.workspaceId === wsId);
          const wsPaths = ws ? [normPath(ws.path)] : [];
          const ids = ws ? new Set((ws.sessionIds || [])) : null;
          items = items.filter((s) => {
            const cwd = normPath(s.cwd);
            if (cwd && wsPaths.some((p) => cwd === p || cwd.startsWith(p + '/'))) return true;
            return !!ids && ids.has(s.sessionId);
          });
        }
        return sendJson(res, 200, { items: items.map((s) => {
          const proj = (s.projections && s.projections.values) || {};
          return {
            sessionId: s.sessionId, cwd: s.cwd, title: proj.title || baseName(s.cwd),
            updatedAt: s.updatedAt, running: !!s.running, blank: !!s.blank,
            permissions: proj.permissions, tokenUsage: proj.tokenUsage,
            todos: Array.isArray(proj.todos) ? proj.todos : undefined,
          };
        }) });
      }
      if (req.method === 'POST' && pathname === '/api/sessions') {
        const b = await readBody(req);
        const cwd = b.cwd || DEFAULT_CWD;
        const sid = await createSession(cwd, b.agentPreset || 'standard');
        return sendJson(res, 200, { sessionId: sid });
      }

      // ============ 对话历史 ============
      const histMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
      if (req.method === 'GET' && histMatch) {
        const events = await getHistory(histMatch[1]);
        return sendJson(res, 200, { messages: historyToMessages(events), eventCount: events.length });
      }

      // ============ 发送消息 / 中断 ============
      const promptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
      if (req.method === 'POST' && promptMatch) {
        const b = await readBody(req);
        const content = [{ type: 'text', text: String(b.text || '') }];
        for (const img of b.images || []) {
          if (img && img.data) content.push({ type: 'image', mediaType: img.mediaType || 'image/jpeg', data: img.data, ...(img.name ? { name: img.name } : {}) });
        }
        if (b.interrupt) await cancelSession(promptMatch[1]);
        await promptSession(promptMatch[1], content);
        return sendJson(res, 200, { ok: true });
      }
      const cancelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        await cancelSession(cancelMatch[1]);
        return sendJson(res, 200, { ok: true });
      }

      // ============ 模型 / 权限 ============
      const modelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/model$/);
      if (req.method === 'GET' && modelMatch) {
        return sendJson(res, 200, await listModels(modelMatch[1]));
      }
      if (req.method === 'POST' && modelMatch) {
        const b = await readBody(req);
        await selectModel(modelMatch[1], b.model);
        return sendJson(res, 200, { ok: true });
      }
      // 权限预设切换：DSH 的 /permission 命令经 session.prompt 发送
      const permMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/permission$/);
      if (req.method === 'POST' && permMatch) {
        const b = await readBody(req);
        await promptSession(permMatch[1], [{ type: 'text', text: '/permission ' + String(b.mode || '') }]);
        return sendJson(res, 200, { ok: true });
      }

      // ============ 实时事件（轮询 + SSE）============
      const evMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (req.method === 'GET' && evMatch) {
        const after = Number(url.searchParams.get('afterSeq')) || 0;
        return sendJson(res, 200, await eventStore.getEvents(evMatch[1], after));
      }
      const sseMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events\.stream$/);
      if (req.method === 'GET' && sseMatch) {
        // 离线补同步：连接建立时先回放 afterSeq 之后的缓冲事件，再挂实时推送
        const after = Number(url.searchParams.get('afterSeq')) || 0;
        const replay = await eventStore.getEvents(sseMatch[1], after);
        res.writeHead(200, {
          'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform',
          'connection': 'keep-alive', 'x-accel-buffering': 'no',
        });
        for (const it of replay.items) {
          res.write(`event: ${sseMatch[1]}\ndata: ${JSON.stringify(it)}\n\n`);
        }
        res.write(`event: __hello\ndata: ${JSON.stringify({ sessionId: sseMatch[1], lastSeq: replay.lastSeq })}\n\n`);
        eventStore.addSseClient(res);
        const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 25000);
        res.on('close', () => clearInterval(ka));
        return; // 长连接，由 eventStore 推送
      }

      // ============ 双向同步（手机半边）============
      if (req.method === 'GET' && pathname === '/m/api/sync/state') {
        return sendJson(res, 200, sync.snapshot());
      }
      if (req.method === 'GET' && pathname === '/m/api/sync') {
        sync.openMobileStream(res);
        return;
      }
      if (req.method === 'POST' && pathname === '/m/api/sync/mobile-state') {
        const b = await readBody(req);
        const patch = {};
        if (typeof b.activeSessionId === 'string') patch.activeSessionId = b.activeSessionId || null;
        if (typeof b.activeSessionTitle === 'string') patch.activeSessionTitle = b.activeSessionTitle || null;
        if (typeof b.model === 'string') patch.model = b.model || null;
        if (typeof b.permission === 'string') patch.permission = b.permission || null;
        if (typeof b.action === 'string' && b.action) sync.recordAction('mobile', b.action);
        sync.setState('mobile', patch);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/sync') {
        sync.openPcStream(res);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/sync/pc-state') {
        const b = await readBody(req);
        const patch = {};
        if (typeof b.activeSessionId === 'string') patch.activeSessionId = b.activeSessionId || null;
        if (typeof b.activeSessionTitle === 'string') patch.activeSessionTitle = b.activeSessionTitle || null;
        if (typeof b.model === 'string') patch.model = b.model || null;
        if (typeof b.permission === 'string') patch.permission = b.permission || null;
        if (typeof b.action === 'string' && b.action) sync.recordAction('pc', b.action);
        sync.setState('pc', patch);
        return sendJson(res, 200, { ok: true });
      }

      // ============ 审批 / 提问 ============
      if (req.method === 'GET' && pathname === '/api/pending') {
        return sendJson(res, 200, { items: eventStore.listPending() });
      }
      const apprMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
      if (req.method === 'POST' && apprMatch) {
        const b = await readBody(req);
        return sendJson(res, 200, await eventStore.respond({ approvalId: apprMatch[1], outcome: b.outcome }));
      }
      const qMatch = pathname.match(/^\/api\/questions\/([^/]+)$/);
      if (req.method === 'POST' && qMatch) {
        const b = await readBody(req);
        return sendJson(res, 200, await eventStore.respond({ key: 'q:' + qMatch[1], answer: b.answer }));
      }

      // ============ 终端 ============
      if (req.method === 'POST' && pathname === '/api/terminal') {
        const b = await readBody(req);
        return sendJson(res, 200, await runTerminal(String(b.command || ''), b.cwd));
      }

      // ============ 文件浏览 ============
      if (req.method === 'GET' && pathname === '/api/files') {
        return sendJson(res, 200, await listFiles(url.searchParams.get('path')));
      }
      if (req.method === 'GET' && pathname === '/api/file') {
        return sendJson(res, 200, await readFileContent(url.searchParams.get('path')));
      }

      return sendJson(res, 404, { error: '未知路由: ' + req.method + ' ' + pathname });
    } catch (e) {
      return sendJson(res, 502, { error: 'DSH 网关调用失败: ' + String(e.message || e) });
    }
  });

  const host = ALLOW_INTERNET ? '0.0.0.0' : '127.0.0.1';
  return { server, host, port: PORT, sync };
}
