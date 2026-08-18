// src/dsh-client.ts —— DSH 网关客户端（RPC 调用 + 事件/历史归一化）
// 从中继版本迁移，适配插件 ctx：基址取自 ctx.webServer 的端口而非固定 127.0.0.1:3080
// RPC 信封：{type:'client-request', rpcId, method, payload}；响应取 result.value

// ApiProxy 的精确类型随 DSH 版本变化，用 any 兜底
export type ApiProxy = any;

let rpcCounter = 0;
function rpcId(): string {
  return 'ms-rpc-' + (rpcCounter++).toString(36) + '-' + Date.now().toString(36);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function isoTime(t: unknown): string {
  const n = Number(t);
  return new Date(Number.isFinite(n) && n > 0 ? n : Date.now()).toISOString();
}

// ---- 核心 RPC（通过 ApiProxy 服务代理到 DSH host）----
// apiProxy.callRpc(method, payload) 返回 { ok, value, error }
export async function fetchRpc(apiProxy: ApiProxy, method: string, payload: Record<string, unknown> = {}): Promise<any> {
  const result = await apiProxy.callRpc(method, payload);
  if (!result?.ok) throw new Error(method + ' 失败: ' + JSON.stringify(result?.error || {}).slice(0, 200));
  return result.value;
}

// ---- 会话 / 工作区 ----
export const listWorkspaces = (apiProxy: ApiProxy) => fetchRpc(apiProxy, 'workspace.list', {}).then((v: any) => v.items || []);
export const listSessions = (apiProxy: ApiProxy) => fetchRpc(apiProxy, 'session.list', {}).then((v: any) => v.items || []);
export function createSession(apiProxy: ApiProxy, cwd: string, agentPreset = 'standard'): Promise<string> {
  return fetchRpc(apiProxy, 'session.create', { cwd, agentPreset }).then((v: any) => v.sessionId);
}
export function getHistory(apiProxy: ApiProxy, sessionId: string): Promise<any[]> {
  return fetchRpc(apiProxy, 'session.history', { sessionId }).then((v: any) => v.events || []);
}
export function promptSession(apiProxy: ApiProxy, sessionId: string, content: any[]): Promise<void> {
  return fetchRpc(apiProxy, 'session.prompt', { sessionId, mode: 'queue', content }).then(() => {});
}
export function cancelSession(apiProxy: ApiProxy, sessionId: string): Promise<void> {
  return fetchRpc(apiProxy, 'session.cancel', { sessionId }).catch(() => {});
}
export function selectModel(apiProxy: ApiProxy, sessionId: string, model: string): Promise<void> {
  return fetchRpc(apiProxy, 'session.selectModel', { sessionId, model }).then(() => {});
}
export function listModels(apiProxy: ApiProxy, sessionId: string): Promise<any> {
  return fetchRpc(apiProxy, 'session.models', { sessionId }).catch(() => ({ items: [], groups: [] }));
}

// ---- 工具：从 tool/call 参数 JSON 提取一行摘要 ----
export function summarizeArgs(argsJson: string): string {
  let obj: any = null;
  try { obj = JSON.parse(argsJson); } catch { /* 非 JSON → 截断 */ }
  if (obj && typeof obj === 'object') {
    for (const k of ['path', 'file_path', 'filePath', 'file', 'cwd', 'directory', 'dir', 'src', 'dest', 'target', 'command', 'name', 'url', 'text', 'query']) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
      if (typeof v === 'number') return String(v);
    }
    return JSON.stringify(obj).slice(0, 120);
  }
  return String(argsJson).slice(0, 120);
}

// ---- 会话事件 → 流式条目 ----
export interface StreamItem {
  seq: number;
  type: string;
  kind: string;
  time: string;
  text?: string;
  subtype?: string;
  step?: number;
  turn?: number;
  callId?: string;
  arguments?: string;
  argsSummary?: string;
  result?: string;
  isError?: boolean;
  usage?: { input?: number; output?: number; cacheRead?: number };
}

export function eventToStreamItem(ev: any): StreamItem | null {
  if (!ev || typeof ev !== 'object') return null;
  const type: string = ev.type;
  const data: any = ev.data || {};
  const item: StreamItem = { seq: Number(ev.seq) || 0, type, kind: 'other', time: isoTime(ev.time) };
  if (typeof data.step === 'number') item.step = data.step;
  if (typeof data.turn === 'number') item.turn = data.turn;

  let text: string | undefined;

  if (type === 'assistant/chunk') {
    const c = data.chunk;
    if (c && typeof c === 'object') {
      if (c.type === 'text-delta' && typeof c.text === 'string') { text = c.text; item.kind = 'text'; item.subtype = 'text'; }
      else if (c.type === 'reasoning-delta' && typeof c.text === 'string') { text = c.text; item.kind = 'thinking'; item.subtype = 'reasoning'; }
      else if (c.type === 'tool-call-delta' && typeof c.name === 'string') { text = c.name; item.kind = 'tool'; item.subtype = 'tool'; }
      else if (c.type === 'usage' && c.usage) {
        item.kind = 'usage';
        item.usage = { input: c.usage.inputTokens, output: c.usage.outputTokens, cacheRead: c.usage.cacheReadTokens };
      }
    }
  } else if (type === 'assistant/message' || type === 'user/message') {
    const content = type === 'assistant/message' ? (data.message?.content) : data.content;
    if (Array.isArray(content)) {
      const t = content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('');
      if (t) { text = t; item.kind = 'text'; }
    }
  } else if (type === 'tool/call') {
    if (data.name) { text = String(data.name); item.kind = 'tool'; }
    if (data.callId) item.callId = String(data.callId);
    if (data.arguments) { item.arguments = String(data.arguments); item.argsSummary = summarizeArgs(data.arguments); }
  } else if (type === 'tool/result') {
    const msg = data.message;
    if (msg) {
      const texts: string[] = [];
      const collect = (arr: any[]) => {
        for (const c of arr || []) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
          else if (Array.isArray(c.content)) collect(c.content);
        }
      };
      collect(Array.isArray(msg.content) ? msg.content : []);
      const t = texts.join('');
      const callId = msg.callId || (msg.source?.callId);
      if (callId) item.callId = String(callId);
      if (msg.isError !== undefined) item.isError = !!msg.isError;
      if (t) { text = t; item.kind = 'tool-result'; item.result = t; }
    }
  } else if (type === 'turn/end') item.kind = 'done';
  else if (type === 'step/start') item.kind = 'step-start';
  else if (type === 'step/end') item.kind = 'step-end';

  if (text !== undefined) item.text = text;
  return item;
}

// ---- session.history events → 对话消息数组 ----
export interface ChatMessage {
  role: string;
  text: string;
  time: string;
  callId?: string;
  arguments?: string;
  argsSummary?: string;
  result?: string;
  isError?: boolean;
  messageId?: string;
}

export function historyToMessages(events: any[]): ChatMessage[] {
  const items: ChatMessage[] = [];
  const isNoise = (t: string) => /^\s*<(system-reminder|runtime-context|compacted-summary)>/.test(String(t || ''));
  for (const ev of events || []) {
    const e = ev?.event;
    if (!e) continue;
    const data = e.data || {};
    if (e.type === 'user/message' && Array.isArray(data.content)) {
      const text = data.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('');
      if (text && !isNoise(text)) items.push({ role: 'user', text, time: isoTime(e.time) });
    } else if (e.type === 'assistant/message') {
      const content = data.message?.content;
      if (Array.isArray(content)) {
        const text = content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('');
        const entry: ChatMessage = { role: 'assistant', text, time: isoTime(e.time) };
        if (data.message?.id) entry.messageId = String(data.message.id);
        items.push(entry);
      }
    } else if (e.type === 'tool/call' && data.name) {
      const entry: ChatMessage = { role: 'tool', text: String(data.name), time: isoTime(e.time) };
      if (data.callId) entry.callId = String(data.callId);
      if (data.arguments) { entry.arguments = String(data.arguments); entry.argsSummary = summarizeArgs(data.arguments); }
      items.push(entry);
    } else if (e.type === 'tool/result') {
      const msg = data.message || {};
      const callId = msg.callId || (msg.source?.callId);
      const texts: string[] = [];
      const collect = (arr: any[]) => {
        for (const c of arr || []) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
          else if (Array.isArray(c.content)) collect(c.content);
        }
      };
      collect(Array.isArray(msg.content) ? msg.content : []);
      const result = texts.join('');
      const isError = !!msg.isError;
      if (callId) {
        const target = items.filter((x) => x.role === 'tool' && x.callId === callId);
        if (target.length) { target[target.length - 1].result = result; target[target.length - 1].isError = isError; continue; }
      }
      if (result) items.push({ role: 'tool-result', text: result, isError, time: isoTime(e.time) });
    }
  }
  return items;
}

export function normPath(p: string): string { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
export function baseName(p: string): string {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : (s || '未命名');
}
