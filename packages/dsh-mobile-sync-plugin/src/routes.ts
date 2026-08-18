// src/routes.ts —— 配对路由 + 移动端 API 代理路由 + 移动端静态页面路由
// 所有路由通过 ctx.webServer.register() 注册
// 配对路由 (/api/pair/*) 仅限 loopback；移动端路由 (/m, /m/api/*) 需配对 cookie
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { PairingService } from './pairing.js';
import type { EventStore } from './event-store.js';
import type { ApiProxy } from './dsh-client.js';
import type { SyncBridge } from './sync.js';
import {
  readJsonBody, writeJson, writeStatic, requireMethod, openSSE, pushSSE,
} from './http-utils.js';
import {
  fetchRpc,
  listWorkspaces, listSessions, createSession, getHistory,
  promptSession, cancelSession, selectModel, listModels,
  historyToMessages, normPath, baseName,
} from './dsh-client.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 手机端 API 方法白名单（安全：不暴露 settings/credentials/host-action）
const MOBILE_RPC_ALLOW = new Set([
  'workspace.list', 'session.list', 'session.create',
  'session.history', 'session.prompt', 'session.cancel',
  'session.models', 'session.selectModel',
]);

function getCookie(req: any): string | undefined {
  const cookieHeader = req.headers?.cookie || '';
  const match = cookieHeader.match(/dsh-msc-[^;]+/);
  return match ? match[0].trim() : undefined;
}

function isLoopback(req: any): boolean {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// ---- 配对路由（仅 loopback）----
export function makePairRoutes(pairing: PairingService, workspaceParam?: string, sync?: SyncBridge): WebRoute[] {
  return [
    // 签发 QR token
    {
      kind: 'exact', path: '/api/pair/issue', handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: '配对面板仅限本机使用' });
        if (!requireMethod(req, res, 'POST')) return;
        try {
          const result = await pairing.issueToken(workspaceParam);
          writeJson(res, 200, result);
        } catch (e: any) { writeJson(res, 500, { error: String(e.message) }); }
      },
    },
    // 接受配对（手机端扫码后调用）
    {
      kind: 'exact', path: '/api/pair/accept', handler: async (req, res) => {
        if (!requireMethod(req, res, 'POST')) return;
        const body = await readJsonBody(req);
        const result = pairing.accept(String(body.token || ''), String(body.label || ''));
        if (result.ok && result.cookie) {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': `dsh-msc=${result.cookie}; HttpOnly; Path=/m; SameSite=Lax; Max-Age=604800`,
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          writeJson(res, 403, { ok: false, error: result.error });
        }
        sync?.notifyDevices(); // 设备上线 → 广播
      },
    },
    // 心跳
    {
      kind: 'exact', path: '/api/pair/heartbeat', handler: async (req, res) => {
        if (!requireMethod(req, res, 'POST')) return;
        const ok = pairing.heartbeat(getCookie(req) || '');
        writeJson(res, ok ? 200 : 403, { ok });
        sync?.notifyDevices();
      },
    },
    // 停止（撤销所有设备）
    {
      kind: 'exact', path: '/api/pair/stop', handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: '仅限本机' });
        if (!requireMethod(req, res, 'POST')) return;
        pairing.stop();
        writeJson(res, 200, { ok: true });
        sync?.notifyDevices();
      },
    },
    // 状态（桌面端 SSE）
    {
      kind: 'exact', path: '/api/pair/status', handler: (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: '仅限本机' });
        if (!requireMethod(req, res, 'GET')) return;
        pairing.openStatusStream(res);
      },
    },
  ];
}

// ---- 移动端 API 代理路由（/m/api/*，需配对 cookie + 方法白名单）----
export function makeMobileApiRoutes(
  pairing: PairingService,
  eventStore: EventStore,
  apiProxy: ApiProxy,
  defaultCwd: string,
  sync: SyncBridge,
): WebRoute[] {
  const requireMobile = (req: any, res: any): boolean => {
    if (!pairing.isPaired(getCookie(req))) {
      writeJson(res, 403, { error: '设备未配对或已离线' });
      return false;
    }
    return true;
  };

  // 通用 RPC 代理：POST /m/api/rpc { method, payload }
  const rpcProxyRoute: WebRoute = {
    kind: 'exact', path: '/m/api/rpc', handler: async (req, res) => {
      if (!requireMethod(req, res, 'POST') || !requireMobile(req, res)) return;
      const { method, payload } = await readJsonBody(req);
      const m = String(method || '');
      if (!MOBILE_RPC_ALLOW.has(m)) return writeJson(res, 403, { error: `方法 ${m} 不在手机端白名单` });
      try {
        const value = await fetchRpc(apiProxy, m, (payload || {}) as Record<string, unknown>);
        writeJson(res, 200, { ok: true, value });
      } catch (e: any) { writeJson(res, 502, { ok: false, error: e.message }); }
    },
  };

  // 工作区列表
  const workspacesRoute: WebRoute = {
    kind: 'exact', path: '/m/api/workspaces', handler: async (req, res) => {
      if (!requireMethod(req, res, 'GET') || !requireMobile(req, res)) return;
      try {
        const [ws, ss] = await Promise.all([listWorkspaces(apiProxy), listSessions(apiProxy)]);
        const matched = new Map<string, Set<string>>();
        for (const w of ws) matched.set(w.workspaceId, new Set((w.sessionIds || []).filter(Boolean)));
        const sorted = [...ws].sort((a: any, b: any) => normPath(b.path).length - normPath(a.path).length);
        for (const s of ss) {
          const cwd = normPath(s.cwd);
          if (!cwd) continue;
          const w = sorted.find((x: any) => { const p = normPath(x.path); return cwd === p || cwd.startsWith(p + '/'); });
          if (w) { const set = matched.get(w.workspaceId); if (set) set.add(s.sessionId); }
        }
        writeJson(res, 200, { items: ws.map((w: any) => ({
          workspaceId: w.workspaceId, path: w.path, title: w.title || null,
          sessionCount: (matched.get(w.workspaceId) || new Set()).size,
        })).sort((a: any, b: any) => b.sessionCount - a.sessionCount) });
      } catch (e: any) { writeJson(res, 502, { error: e.message }); }
    },
  };

  // 会话列表 + 新建会话（合并为一个路由，按 method 分发，避免 duplicate route）
  const sessionsRoute: WebRoute = {
    kind: 'exact', path: '/m/api/sessions', handler: async (req, res) => {
      if (!requireMobile(req, res)) return;
      if (req.method === 'GET') {
        try {
          const items = await listSessions(apiProxy);
          writeJson(res, 200, { items: items.map((s: any) => {
            const proj = (s.projections?.values) || {};
            return {
              sessionId: s.sessionId, cwd: s.cwd, title: proj.title || baseName(s.cwd),
              updatedAt: s.updatedAt, running: !!s.running, blank: !!s.blank,
              permissions: proj.permissions, todos: Array.isArray(proj.todos) ? proj.todos : undefined,
            };
          }) });
        } catch (e: any) { writeJson(res, 502, { error: e.message }); }
      } else if (req.method === 'POST') {
        const b = await readJsonBody(req);
        try {
          const sid = await createSession(apiProxy, String(b.cwd || defaultCwd), String(b.agentPreset || 'standard'));
          writeJson(res, 200, { sessionId: sid });
        } catch (e: any) { writeJson(res, 502, { error: e.message }); }
      } else {
        writeJson(res, 405, { error: 'Method not allowed' });
      }
    },
  };

  // 对话历史
  const historyRoute: WebRoute = {
    kind: 'prefix', path: '/m/api/sessions/', handler: async (req, res) => {
      if (!requireMobile(req, res)) return;
      const url = new URL(req.url || '', 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      // /m/api/sessions/:id/history | /prompt | /cancel | /model | /permission | /events | /events.stream
      if (parts.length < 4) return writeJson(res, 404, { error: '路径不完整' });
      const sid = parts[2];
      const action = parts[3];

      if (action === 'history' && req.method === 'GET') {
        try {
          const events = await getHistory(apiProxy, sid);
          writeJson(res, 200, { messages: historyToMessages(events), eventCount: events.length });
        } catch (e: any) { writeJson(res, 502, { error: e.message }); }
      } else if (action === 'prompt' && req.method === 'POST') {
        const b = await readJsonBody(req);
        try {
          const content: any[] = [{ type: 'text', text: String(b.text || '') }];
          for (const img of (b.images as any[]) || []) {
            if (img?.data) content.push({ type: 'image', mediaType: img.mediaType || 'image/jpeg', data: img.data, ...(img.name ? { name: img.name } : {}) });
          }
          if (b.interrupt) await cancelSession(apiProxy, sid);
          await promptSession(apiProxy, sid, content);
          writeJson(res, 200, { ok: true });
        } catch (e: any) { writeJson(res, 502, { error: e.message }); }
      } else if (action === 'cancel' && req.method === 'POST') {
        try { await cancelSession(apiProxy, sid); writeJson(res, 200, { ok: true }); }
        catch (e: any) { writeJson(res, 502, { error: e.message }); }
      } else if (action === 'model') {
        if (req.method === 'GET') {
          try { writeJson(res, 200, await listModels(apiProxy, sid)); }
          catch (e: any) { writeJson(res, 502, { error: e.message }); }
        } else if (req.method === 'POST') {
          const b = await readJsonBody(req);
          try { await selectModel(apiProxy, sid, String(b.model || '')); writeJson(res, 200, { ok: true }); }
          catch (e: any) { writeJson(res, 502, { error: e.message }); }
        }
      } else if (action === 'permission' && req.method === 'POST') {
        const b = await readJsonBody(req);
        try {
          await promptSession(apiProxy, sid, [{ type: 'text', text: '/permission ' + String(b.mode || '') }]);
          writeJson(res, 200, { ok: true });
        } catch (e: any) { writeJson(res, 502, { error: e.message }); }
      } else if (action === 'events' && req.method === 'GET') {
        const after = Number(url.searchParams.get('afterSeq')) || 0;
        try { writeJson(res, 200, await eventStore.getEvents(sid, after)); }
        catch (e: any) { writeJson(res, 502, { error: e.message }); }
      } else if (action === 'events.stream' && req.method === 'GET') {
        // 离线补同步：连接建立时先回放 afterSeq 之后的缓冲事件（断线期间错过的），再挂实时推送
        const after = Number(url.searchParams.get('afterSeq')) || 0;
        const replay = await eventStore.getEvents(sid, after);
        const stream = openSSE(res);
        for (const it of replay.items) pushSSE(stream, sid, it);
        pushSSE(stream, '__hello', { sessionId: sid, lastSeq: replay.lastSeq });
        eventStore.addSseClient(stream, sid);
        const ka = setInterval(() => { if (!stream.closed) { try { res.write(': keepalive\n\n'); } catch {} } else clearInterval(ka); }, 25000);
      } else {
        writeJson(res, 404, { error: `未知操作: ${action}` });
      }
    },
  };

  // 待审批/提问
  const pendingRoute: WebRoute = {
    kind: 'exact', path: '/m/api/pending', handler: (req, res) => {
      if (!requireMethod(req, res, 'GET') || !requireMobile(req, res)) return;
      writeJson(res, 200, { items: eventStore.listPending() });
    },
  };
  const approveRoute: WebRoute = {
    kind: 'prefix', path: '/m/api/approvals/', handler: async (req, res) => {
      if (!requireMethod(req, res, 'POST') || !requireMobile(req, res)) return;
      const url = new URL(req.url || '', 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[parts.length - 1];
      const b = await readJsonBody(req);
      writeJson(res, 200, await eventStore.respond({ approvalId: id, outcome: String(b.outcome) }));
    },
  };
  const questionRoute: WebRoute = {
    kind: 'prefix', path: '/m/api/questions/', handler: async (req, res) => {
      if (!requireMethod(req, res, 'POST') || !requireMobile(req, res)) return;
      const url = new URL(req.url || '', 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[parts.length - 1];
      const b = await readJsonBody(req);
      writeJson(res, 200, await eventStore.respond({ key: 'q:' + id, answer: b.answer }));
    },
  };

  // 终端
  const terminalRoute: WebRoute = {
    kind: 'exact', path: '/m/api/terminal', handler: async (req, res) => {
      if (!requireMethod(req, res, 'POST') || !requireMobile(req, res)) return;
      const b = await readJsonBody(req);
      const result = await runTerminal(String(b.command || ''), String(b.cwd || defaultCwd));
      writeJson(res, 200, result);
    },
  };

  // 文件浏览
  const filesRoute: WebRoute = {
    kind: 'exact', path: '/m/api/files', handler: async (req, res) => {
      if (!requireMethod(req, res, 'GET') || !requireMobile(req, res)) return;
      const url = new URL(req.url || '', 'http://x');
      const dir = url.searchParams.get('path') || defaultCwd;
      try {
        const { readdir, stat } = await import('node:fs/promises');
        const entries = await readdir(dir, { withFileTypes: true });
        const items = await Promise.all(entries.map(async (e) => {
          const full = path.join(dir, e.name);
          let size: number | undefined, mtime: number | undefined;
          try { const s = await stat(full); size = s.size; mtime = s.mtimeMs; } catch {}
          return { name: e.name, dir: e.isDirectory(), size, mtime };
        }));
        writeJson(res, 200, { path: dir, items: items.sort((a: any, b: any) => (b.dir - a.dir) || String(a.name).localeCompare(String(b.name))) });
      } catch (e: any) { writeJson(res, 502, { error: e.message }); }
    },
  };

  const fileRoute: WebRoute = {
    kind: 'exact', path: '/m/api/file', handler: async (req, res) => {
      if (!requireMethod(req, res, 'GET') || !requireMobile(req, res)) return;
      const url = new URL(req.url || '', 'http://x');
      const file = url.searchParams.get('path') || '';
      try {
        const data = await readFile(file, 'utf8');
        writeJson(res, 200, { path: file, content: data, size: data.length });
      } catch (e: any) { writeJson(res, 502, { error: e.message }); }
    },
  };

  // 心跳
  const heartbeatRoute: WebRoute = {
    kind: 'exact', path: '/m/api/heartbeat', handler: (req, res) => {
      if (!requireMethod(req, res, 'POST') || !requireMobile(req, res)) return;
      writeJson(res, 200, { ok: true });
    },
  };

  // 双向同步（手机半边）
  const mobileSyncStateRoute: WebRoute = {
    kind: 'exact', path: '/m/api/sync/state', handler: (req, res) => {
      if (!requireMethod(req, res, 'GET') || !requireMobile(req, res)) return;
      writeJson(res, 200, sync.snapshot());
    },
  };
  const mobileSyncStreamRoute: WebRoute = {
    kind: 'exact', path: '/m/api/sync', handler: (req, res) => {
      if (!requireMethod(req, res, 'GET') || !requireMobile(req, res)) return;
      sync.openMobileStream(res);
    },
  };
  const mobileSyncReportRoute: WebRoute = {
    kind: 'exact', path: '/m/api/sync/mobile-state', handler: async (req, res) => {
      if (!requireMethod(req, res, 'POST') || !requireMobile(req, res)) return;
      const b = await readJsonBody(req);
      const patch: Record<string, unknown> = {};
      if (typeof b.activeSessionId === 'string') patch.activeSessionId = b.activeSessionId || null;
      if (typeof b.activeSessionTitle === 'string') patch.activeSessionTitle = b.activeSessionTitle || null;
      if (typeof b.model === 'string') patch.model = b.model || null;
      if (typeof b.permission === 'string') patch.permission = b.permission || null;
      if (typeof b.action === 'string' && b.action) sync.recordAction('mobile', b.action);
      sync.setState('mobile', patch);
      writeJson(res, 200, { ok: true });
    },
  };

  return [
    rpcProxyRoute, workspacesRoute, sessionsRoute,
    historyRoute, pendingRoute, approveRoute, questionRoute,
    terminalRoute, filesRoute, fileRoute, heartbeatRoute,
    mobileSyncStateRoute, mobileSyncStreamRoute, mobileSyncReportRoute,
  ];
}

// ---- 双向同步路由（PC 半边，仅 loopback）----
export function makeSyncRoutes(sync: SyncBridge): WebRoute[] {
  // PC client 订阅：实时接收手机端状态 + 设备列表
  const pcStreamRoute: WebRoute = {
    kind: 'exact', path: '/api/sync', handler: (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: '仅限本机' });
      if (!requireMethod(req, res, 'GET')) return;
      sync.openPcStream(res);
    },
  };
  // PC client 上报：PC 端当前会话 / 模型 / 权限变化
  const pcReportRoute: WebRoute = {
    kind: 'exact', path: '/api/sync/pc-state', handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: '仅限本机' });
      if (!requireMethod(req, res, 'POST')) return;
      const b = await readJsonBody(req);
      const patch: Record<string, unknown> = {};
      if (typeof b.activeSessionId === 'string') patch.activeSessionId = b.activeSessionId || null;
      if (typeof b.activeSessionTitle === 'string') patch.activeSessionTitle = b.activeSessionTitle || null;
      if (typeof b.model === 'string') patch.model = b.model || null;
      if (typeof b.permission === 'string') patch.permission = b.permission || null;
      if (typeof b.action === 'string' && b.action) sync.recordAction('pc', b.action);
      sync.setState('pc', patch);
      writeJson(res, 200, { ok: true });
    },
  };
  return [pcStreamRoute, pcReportRoute];
}

// ---- 移动端静态页面路由 ----
export function makeMobileRoutes(): WebRoute[] {
  // 构建后 relay.html 可能出现在两个位置：
  // 1) lib/assets/relay.html（tsdown copy 产物，紧邻 lib/index.js）
  // 2) assets/relay.html（源码目录，npm publish 时随 files 字段发布）
  const relayPath1 = path.join(__dirname, 'assets', 'relay.html');   // lib/assets/
  const relayPath2 = path.join(__dirname, '..', 'assets', 'relay.html'); // assets/
  const relayPath = existsSync(relayPath1) ? relayPath1 : relayPath2;

  const handlePage: WebRoute['handler'] = async (_req, res) => {
    if (!existsSync(relayPath)) return writeStatic(res, 503, 'text/plain', 'relay.html 未构建');
    const html = await readFile(relayPath, 'utf8');
    writeStatic(res, 200, 'text/html', html);
  };

  // /m → 308 重定向到 /m/
  const redirectRoot: WebRoute['handler'] = (req, res) => {
    const url = new URL(req.url ?? '/m', 'http://x');
    res.writeHead(308, { location: '/m/' + url.search });
    res.end();
  };

  // 配对页面（手机扫码后落地）
  const handlePair: WebRoute['handler'] = async (req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const token = url.searchParams.get('token');
    if (!token) {
      writeStatic(res, 400, 'text/html', '<h1>配对链接无效</h1><p>缺少 token 参数</p>');
      return;
    }
    // 返回一个自动提交 token 的中转页面
    const html = pairRedirectHtml(token);
    writeStatic(res, 200, 'text/html', html);
  };

  return [
    { kind: 'exact', path: '/m', handler: redirectRoot },
    { kind: 'exact', path: '/m/', handler: handlePage },
    { kind: 'exact', path: '/m/pair', handler: handlePair },
  ];
}

function pairRedirectHtml(token: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>配对中…</title><style>body{font-family:system-ui;text-align:center;padding:40px 20px;background:#191919;color:#eee}
.dot{display:inline-block;width:10px;height:10px;background:#4a90d9;border-radius:50%;animation:p 1s infinite}@keyframes p{50%{opacity:0}}</style>
</head><body><p><span class="dot"></span> 正在配对…</p></body>
<script>
fetch('/api/pair/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'${token}'})})
.then(r=>r.json()).then(j=>{ if(j.ok){location.href='/m/';} else { document.body.innerHTML='<h2>配对失败</h2><p>'+j.error+'</p><button onclick="location.reload()">重试</button>'; } })
.catch(e=>{ document.body.innerHTML='<h2>网络错误</h2><p>'+e+'</p>'; });
</script></html>`;
}

function runTerminal(command: string, cwd: string): Promise<any> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/c', command] : ['-c', command],
      { cwd: cwd || process.cwd(), env: process.env },
    );
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({
      ok: code === 0, exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(),
      elapsedMs: Date.now() - started,
    }));
    child.on('error', (e) => resolve({
      ok: false, exitCode: -1, stdout: '', stderr: String(e),
      elapsedMs: Date.now() - started,
    }));
  });
}
