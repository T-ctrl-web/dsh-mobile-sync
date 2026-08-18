// src/dsh-client.mjs —— DSH Web 网关客户端（RPC 调用 + 事件/历史归一化）
// 网关基址默认 http://127.0.0.1:3080（DSH Web UI 端口）
// RPC 信封：{type:'client-request', rpcId, method, payload}；响应取 result.value
// 事件流 events.mux 是 WebSocket（非 SSE），帧形 {method, rpcId?, payload}
import { DSH_BASE } from './config.mjs';

let rpcCounter = 0;
export function rpcId() {
  return 'rpc-' + (rpcCounter++).toString(36) + '-' + Date.now().toString(36);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function isoTime(t) {
  const n = Number(t);
  return new Date(Number.isFinite(n) && n > 0 ? n : Date.now()).toISOString();
}

// ---- 核心 RPC ----
export async function fetchRpc(method, payload = {}) {
  const resp = await fetch(DSH_BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: rpcId(), method, payload }),
  });
  if (!resp.ok) throw new Error(method + ' HTTP ' + resp.status);
  const json = await resp.json();
  if (!json.result?.ok) throw new Error(method + ' 失败: ' + JSON.stringify(json.result?.error || {}).slice(0, 200));
  return json.result.value;
}

// ---- 会话 / 工作区 ----
export const listWorkspaces = () => fetchRpc('workspace.list', {}).then((v) => (v.items || []));
export const listSessions = () => fetchRpc('session.list', {}).then((v) => (v.items || []));
export function createSession(cwd, agentPreset = 'standard') {
  return fetchRpc('session.create', { cwd, agentPreset }).then((v) => v.sessionId);
}
export function getHistory(sessionId) {
  return fetchRpc('session.history', { sessionId }).then((v) => v.events || []);
}
export function promptSession(sessionId, content) {
  return fetchRpc('session.prompt', { sessionId, mode: 'queue', content });
}
export function cancelSession(sessionId) {
  return fetchRpc('session.cancel', { sessionId }).catch(() => {});
}
export function selectModel(sessionId, model) {
  return fetchRpc('session.selectModel', { sessionId, model });
}
export function listModels(sessionId) {
  // session.models 返回模型目录；不同 DSH 版本字段略有差异，统一兜底
  return fetchRpc('session.models', { sessionId }).then(
    (v) => v,
    () => ({ items: [], groups: [] })
  );
}

// ---- 审批 / 提问应答（client-response 信封）----
export async function respond(rpcId, value) {
  const resp = await fetch(DSH_BASE + '/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
  });
  const json = await resp.json().catch(() => ({}));
  if (json && (json.ok === false || json.result?.ok === false)) {
    throw new Error(JSON.stringify(json.error || json.result?.error || 'respond 被拒绝').slice(0, 300));
  }
  return json;
}

// ---- 工具：从 tool/call 参数 JSON 提取一行摘要（优先路径/命令字段）----
export function summarizeArgs(argsJson) {
  let obj = null;
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

// ---- 会话事件 → 流式条目（增量轮询 / SSE 用）----
// 提取规则：assistant/chunk 增量文本（text/reasoning/tool-call-delta）；
//   assistant/message 与 user/message 的 content[].text；tool/call 的 name+参数；
//   tool/result 的双层嵌套文本（message.content[].content[].text）+ isError；
//   turn/end 标记完成，step/start|end 标记分步边界。
export function eventToStreamItem(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const type = ev.type;
  const data = ev.data || {};
  const item = { seq: Number(ev.seq) || 0, type, time: isoTime(ev.time) };
  if (typeof data.step === 'number') item.step = data.step;
  if (typeof data.turn === 'number') item.turn = data.turn;

  let text, kind = 'other', subtype;
  if (type === 'assistant/chunk') {
    const c = data.chunk;
    if (c && typeof c === 'object') {
      if (c.type === 'text-delta' && typeof c.text === 'string') { text = c.text; kind = 'text'; subtype = 'text'; }
      else if (c.type === 'reasoning-delta' && typeof c.text === 'string') { text = c.text; kind = 'thinking'; subtype = 'reasoning'; }
      else if (c.type === 'tool-call-delta' && typeof c.name === 'string') { text = c.name; kind = 'tool'; subtype = 'tool'; }
      else if (c.type === 'usage' && c.usage) {
        kind = 'usage'; item.usage = {
          input: c.usage.inputTokens, output: c.usage.outputTokens,
          cacheRead: c.usage.cacheReadTokens,
        };
      }
    }
  } else if (type === 'assistant/message' || type === 'user/message') {
    const content = type === 'assistant/message' ? (data.message && data.message.content) : data.content;
    if (Array.isArray(content)) {
      const t = content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
      if (t) { text = t; kind = 'text'; }
    }
  } else if (type === 'tool/call') {
    if (data.name) { text = String(data.name); kind = 'tool'; }
    if (data.callId) item.callId = String(data.callId);
    if (data.arguments) { item.arguments = String(data.arguments); item.argsSummary = summarizeArgs(data.arguments); }
  } else if (type === 'tool/result') {
    const msg = data.message;
    if (msg) {
      // 双层结构：message.content[].content[].text（tool-result 块）
      const texts = [];
      const collect = (arr) => {
        for (const c of arr || []) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
          else if (Array.isArray(c.content)) collect(c.content);
        }
      };
      collect(Array.isArray(msg.content) ? msg.content : []);
      const t = texts.join('');
      const callId = msg.callId || (msg.source && msg.source.callId);
      if (callId) item.callId = String(callId);
      if (msg.isError !== undefined) item.isError = !!msg.isError;
      if (t) { text = t; kind = 'tool-result'; item.result = t; }
    }
  } else if (type === 'turn/end') kind = 'done';
  else if (type === 'step/start') kind = 'step-start';
  else if (type === 'step/end') kind = 'step-end';

  if (subtype) item.subtype = subtype;
  if (text !== undefined) item.text = text;
  item.kind = kind;
  return item;
}

// ---- session.history events → 对话消息数组（过滤 DSH 注入的系统噪声）----
export function historyToMessages(events) {
  const items = [];
  const isNoise = (t) => /^\s*<(system-reminder|runtime-context|compacted-summary)>/.test(String(t || ''));
  for (const ev of events || []) {
    const e = ev && ev.event;
    if (!e) continue;
    const data = e.data || {};
    if (e.type === 'user/message' && Array.isArray(data.content)) {
      const text = data.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
      if (text && !isNoise(text)) items.push({ role: 'user', text, time: isoTime(e.time) });
    } else if (e.type === 'assistant/message') {
      const content = data.message && data.message.content;
      if (Array.isArray(content)) {
        const text = content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
        const entry = { role: 'assistant', text, time: isoTime(e.time) };
        if (data.message && data.message.id) entry.messageId = String(data.message.id);
        items.push(entry);
      }
    } else if (e.type === 'tool/call' && data.name) {
      const entry = { role: 'tool', text: String(data.name), time: isoTime(e.time) };
      if (data.callId) entry.callId = String(data.callId);
      if (data.arguments) { entry.arguments = String(data.arguments); entry.argsSummary = summarizeArgs(data.arguments); }
      items.push(entry);
    } else if (e.type === 'tool/result') {
      const msg = data.message || {};
      const callId = msg.callId || (msg.source && msg.source.callId);
      const texts = [];
      const collect = (arr) => {
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

// 归一化路径（Windows 反斜杠 → 正斜杠小写），供 cwd 前缀分组
export function normPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
export function baseName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : (s || '未命名');
}
