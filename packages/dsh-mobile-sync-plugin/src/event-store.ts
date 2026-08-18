// src/event-store.ts —— DSH 事件中继 + 环形缓冲 + 待审批/提问表 + SSE 推送
// 从中继版本迁移，适配插件：事件流改用 ctx.webServer 的 WS 升级路由或直接 fetch events.mux
// 这里用 Node 22+ 全局 WebSocket 连 DSH events.mux（与中继版相同），零额外依赖
import { fetchRpc, eventToStreamItem, isoTime, sleep } from './dsh-client.js';
import type { StreamItem } from './dsh-client.js';
import { openSSE, pushSSE, type SSEStream } from './http-utils.js';

const MAX_EVENTS_PER_SESSION = 200;
const MAX_SESSIONS = 200;
const HISTORY_COOLDOWN_MS = 5000;
const MAX_PENDING = 50;

export interface PendingRecord {
  kind: 'approval' | 'question';
  rpcId: string;
  key: string;
  sessionId: string;
  approvalId?: string;
  toolName?: string;
  callId?: string;
  reason?: string;
  questions?: any[];
  receivedAt: string;
}

export interface EventStoreOptions {
  dshBaseUrl: string;
  apiProxy: any;
}

export function createEventStore(opts: EventStoreOptions) {
  const { dshBaseUrl, apiProxy } = opts;
  const eventsBySession = new Map<string, StreamItem[]>();
  const subscribedSeq = new Map<string, number>();
  const lastHistoryFetch = new Map<string, number>();
  const pending = new Map<string, PendingRecord>();
  const sseClients = new Set<{ stream: SSEStream; sessionId: string }>();

  let state = 'stopped';
  let generation = 0;
  let retryMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeWs: WebSocket | null = null;

  function notify(n: any) {
    for (const c of sseClients) {
      if (!c.stream.closed) pushSSE(c.stream, '__pending', n);
    }
  }

  function pushEvent(sessionId: string, item: StreamItem) {
    let arr = eventsBySession.get(sessionId);
    if (!arr) {
      if (eventsBySession.size >= MAX_SESSIONS) {
        const k = eventsBySession.keys().next().value;
        if (k !== undefined) eventsBySession.delete(k);
      }
      arr = [];
      eventsBySession.set(sessionId, arr);
    } else {
      eventsBySession.delete(sessionId);
      eventsBySession.set(sessionId, arr);
    }
    const last = arr.length ? arr[arr.length - 1].seq : -1;
    if (item.seq <= last) return;
    arr.push(item);
    if (arr.length > MAX_EVENTS_PER_SESSION) arr.splice(0, arr.length - MAX_EVENTS_PER_SESSION);
    for (const c of sseClients) {
      if (c.sessionId === sessionId && !c.stream.closed) pushSSE(c.stream, sessionId, item);
    }
  }

  async function getEvents(sessionId: string, afterSeq = 0): Promise<{ items: StreamItem[]; lastSeq: number }> {
    const sid = String(sessionId || '').trim();
    const after = Number(afterSeq) || 0;
    if (!sid) return { items: [], lastSeq: after };
    let arr = eventsBySession.get(sid) || [];
    const last = arr.length ? arr[arr.length - 1].seq : -1;
    const watermark = subscribedSeq.get(sid);
    const nothingNew = watermark !== undefined && after >= watermark;
    const needFetch = (arr.length === 0 || after > last) && !nothingNew
      && Date.now() - (lastHistoryFetch.get(sid) || 0) >= HISTORY_COOLDOWN_MS;
    if (needFetch) {
      lastHistoryFetch.set(sid, Date.now());
      try {
        const events = await fetchRpc(apiProxy, 'session.history', { sessionId: sid });
        const items = (events || [])
          .map((ev: any) => eventToStreamItem(ev?.event))
          .filter((i: StreamItem | null): i is StreamItem => !!i && i.seq > after)
          .slice(-MAX_EVENTS_PER_SESSION);
        for (const it of items) pushEvent(sid, it);
        arr = eventsBySession.get(sid) || [];
      } catch { /* 会话不存在 / DSH 不可用 */ }
    }
    return { items: arr.filter((i) => i.seq > after), lastSeq: arr.length ? arr[arr.length - 1].seq : after };
  }

  function evictOldest() {
    while (pending.size > MAX_PENDING) {
      const k = pending.keys().next().value;
      if (k === undefined) break;
      pending.delete(k);
    }
  }

  function ingest(frame: any) {
    if (!frame || typeof frame !== 'object') return;
    const p = frame.payload;
    if (frame.method === 'session/event' && p?.sessionId && p?.event) {
      const item = eventToStreamItem(p.event);
      if (item) pushEvent(String(p.sessionId), item);
      return;
    }
    if (frame.method === 'session/subscribed' && p?.sessionId) {
      subscribedSeq.set(String(p.sessionId), Number(p.lastSeq) || 0);
      return;
    }
    if (frame.method === 'approval/resolved' || p?.type === 'approval/resolved') {
      pending.delete(String(p?.approvalId || '')); return;
    }
    if (frame.method === 'question/resolved' || p?.type === 'question/resolved') {
      pending.delete('q:' + String(p?.questionRpcId || '')); return;
    }
    const isQuestion = frame.method === 'question/requested' || p?.type === 'question/requested';
    if (isQuestion) {
      const rpcId = String(frame.rpcId || p?.rpcId || '');
      if (!rpcId) return;
      pending.set('q:' + rpcId, {
        kind: 'question', rpcId, key: 'q:' + rpcId,
        sessionId: String(p?.sessionId || ''),
        questions: Array.isArray(p?.questions) ? p.questions : [],
        receivedAt: new Date().toISOString(),
      });
      evictOldest(); notify({ kind: 'question' }); return;
    }
    const isApproval = frame.method === 'approval/requested' || p?.type === 'approval/requested';
    if (!isApproval || !p) return;
    const approvalId = String(p.approvalId || frame.rpcId || '');
    if (!approvalId) return;
    pending.set(approvalId, {
      kind: 'approval', rpcId: frame.rpcId, key: approvalId,
      sessionId: String(p.sessionId || ''),
      approvalId, toolName: p.toolName, callId: p.callId, reason: p.reason,
      receivedAt: new Date().toISOString(),
    });
    evictOldest(); notify({ kind: 'approval' });
  }

  function listPending(): PendingRecord[] { return [...pending.values()].reverse(); }

  async function respond({ approvalId, outcome, key, answer }: { approvalId?: string; outcome?: string; key?: string; answer?: any }): Promise<{ ok: boolean; error?: string }> {
    const rec = key ? pending.get(key) : (approvalId ? pending.get(approvalId) : undefined);
    if (!rec) return { ok: false, error: '未知请求（可能已处理或已过期）' };
    let value: any;
    if (rec.kind === 'question') {
      if (!answer || !Array.isArray(answer.answers) || answer.answers.length === 0) {
        return { ok: false, error: 'answer 须为 {answers:[{id,selected,...}]}' };
      }
      value = { sessionId: rec.sessionId, answer };
    } else {
      if (outcome !== 'allowed-once' && outcome !== 'rejected') {
        return { ok: false, error: 'outcome 只允许 allowed-once / rejected' };
      }
      value = { sessionId: rec.sessionId, approvalId: rec.approvalId, outcome };
    }
    try {
      await fetch(dshBaseUrl + '/api/respond', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId: rec.rpcId, result: { ok: true, value } }),
      });
    } catch (e) {
      return { ok: false, error: 'respond 请求失败: ' + String(e) };
    }
    pending.delete(rec.key);
    notify({ kind: 'resolved', key: rec.key });
    return { ok: true };
  }

  function scheduleReconnect(gen: number) {
    if (state !== 'running' || gen !== generation || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(gen).catch(() => {}); }, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  }

  async function connect(gen: number) {
    if (state !== 'running' || gen !== generation) return;
    try {
      const wsUrl = dshBaseUrl.replace(/^http/, 'ws') + '/api/events.mux';
      const ws = new WebSocket(wsUrl);
      const watchdog = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) { try { ws.close(); } catch {} }
      }, 10000);
      ws.onopen = () => { clearTimeout(watchdog); retryMs = 1000; };
      ws.onmessage = (e: MessageEvent) => {
        if (state !== 'running' || gen !== generation) return;
        try { ingest(JSON.parse(String(e.data))); } catch {}
      };
      ws.onclose = () => { clearTimeout(watchdog); scheduleReconnect(gen); };
      ws.onerror = () => { clearTimeout(watchdog); try { ws.close(); } catch {} scheduleReconnect(gen); };
      activeWs = ws;
      ws.addEventListener('close', () => { if (activeWs === ws) activeWs = null; });
    } catch { scheduleReconnect(gen); }
  }

  function start() {
    if (state === 'running') return;
    state = 'running'; generation += 1; retryMs = 1000;
    connect(generation).catch(() => {});
  }
  function stop() {
    state = 'stopped'; generation += 1;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (activeWs) { const s = activeWs; activeWs = null; try { s.onopen = s.onmessage = s.onerror = s.onclose = null; s.close(); } catch {} }
    for (const c of sseClients) { if (!c.stream.closed) { try { c.stream.res.end(); } catch {} } }
    sseClients.clear();
  }

  function addSseClient(stream: SSEStream, sessionId: string) {
    const entry = { stream, sessionId };
    sseClients.add(entry);
    stream.res.on('close', () => sseClients.delete(entry));
  }

  return { start, stop, getEvents, listPending, respond, addSseClient };
}

export type EventStore = ReturnType<typeof createEventStore>;
