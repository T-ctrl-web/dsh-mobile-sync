// src/event-store.mjs —— DSH 事件中继（events.mux WebSocket）+ 环形缓冲 + 待审批/提问表
// 常驻连接 ws://<dshBase>/api/events.mux，帧路由：
//   session/event      → 该会话环形缓冲（供 SSE/轮询增量）
//   session/subscribed → 各会话 lastSeq 水位（判断是否需回填 history）
//   approval/requested → 待审批表（手机端审批卡片）
//   question/requested → 待提问表（ask_user_question，与审批同表但 kind='question'）
//   */resolved         → 清除对应 pending
// 零第三方依赖：Node 22+ 全局 WebSocket；失败静默指数退避重连（1s→30s 封顶）。
import { fetchRpc, eventToStreamItem, isoTime } from './dsh-client.mjs';
import { DSH_BASE } from './config.mjs';

const MAX_EVENTS_PER_SESSION = 200; // 每会话保留最近 200 条
const MAX_SESSIONS = 200;            // 缓冲会话数上限（LRU 淘汰）
const HISTORY_COOLDOWN_MS = 5000;   // history 回填冷却

export function createEventStore() {
  const eventsBySession = new Map();   // sessionId -> [item]（seq 升序）
  const subscribedSeq = new Map();    // sessionId -> 连接时 lastSeq 水位
  const lastHistoryFetch = new Map(); // sessionId -> 上次回填时间
  const pending = new Map();          // key(approvalId|q:rpcId) -> record
  const sseClients = new Set();       // 活跃 SSE 连接（实时推送通知）
  const MAX_PENDING = 50;

  let state = 'stopped';
  let generation = 0;
  let retryMs = 1000;
  let retryTimer = null;
  let activeWs = null;

  // ---- 环形缓冲 ----
  function pushEvent(sessionId, item) {
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
      eventsBySession.set(sessionId, arr); // 移到尾部（LRU）
    }
    const last = arr.length ? arr[arr.length - 1].seq : -1;
    if (item.seq <= last) return; // 按 seq 去重
    arr.push(item);
    if (arr.length > MAX_EVENTS_PER_SESSION) arr.splice(0, arr.length - MAX_EVENTS_PER_SESSION);
    // 推送给所有 SSE 客户端
    for (const c of sseClients) {
      try { c.write(`event: ${sessionId}\ndata: ${JSON.stringify(item)}\n\n`); } catch { /* 连接已断 */ }
    }
  }

  // ---- 增量查询（缓冲缺失时懒回填 history）----
  async function getEvents(sessionId, afterSeq = 0) {
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
        const value = await fetchRpc('session.history', { sessionId: sid });
        const items = (value.events || [])
          .map((ev) => eventToStreamItem(ev && ev.event))
          .filter((i) => i && i.seq > after)
          .slice(-MAX_EVENTS_PER_SESSION);
        for (const it of items) pushEvent(sid, it);
        arr = eventsBySession.get(sid) || [];
      } catch { /* 会话不存在 / DSH 不可用 → 保持现状 */ }
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

  // ---- 帧路由 ----
  function ingest(frame) {
    if (!frame || typeof frame !== 'object') return;
    const p = frame.payload;
    if (frame.method === 'session/event' && p && p.sessionId && p.event) {
      const item = eventToStreamItem(p.event);
      if (item) pushEvent(String(p.sessionId), item);
      return;
    }
    if (frame.method === 'session/subscribed' && p && p.sessionId) {
      subscribedSeq.set(String(p.sessionId), Number(p.lastSeq) || 0);
      return;
    }
    if (frame.method === 'approval/resolved' || (p && p.type === 'approval/resolved')) {
      pending.delete(String((p && p.approvalId) || '')); return;
    }
    if (frame.method === 'question/resolved' || (p && p.type === 'question/resolved')) {
      pending.delete('q:' + String((p && p.questionRpcId) || '')); return;
    }
    // ask_user_question 提问（与审批分通道！只监听 approval 会导致提问时任务死锁）
    const isQuestion = frame.method === 'question/requested' || (p && p.type === 'question/requested');
    if (isQuestion) {
      const rpcId = String(frame.rpcId || p.rpcId || '');
      if (!rpcId) return;
      pending.set('q:' + rpcId, {
        kind: 'question', rpcId, key: 'q:' + rpcId,
        sessionId: String(p.sessionId || ''),
        questions: Array.isArray(p.questions) ? p.questions : [],
        receivedAt: new Date().toISOString(),
      });
      evictOldest(); notify({ kind: 'question' }); return;
    }
    const isApproval = frame.method === 'approval/requested' || (p && p.type === 'approval/requested');
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

  function notify(n) {
    for (const c of sseClients) {
      try { c.write(`event: __pending\ndata: ${JSON.stringify(n)}\n\n`); } catch { /* ignore */ }
    }
  }

  // ---- 待处理列表（最新在前）----
  function listPending() { return [...pending.values()].reverse(); }

  // ---- 应答（审批 outcome / 提问 answer）----
  async function respond({ approvalId, outcome, key, answer } = {}) {
    const rec = key ? pending.get(key) : (approvalId ? pending.get(approvalId) : undefined);
    if (!rec) return { ok: false, error: '未知请求（可能已处理或已过期）' };
    let value;
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
      await fetch(DSH_BASE + '/api/respond', {
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

  // ---- WebSocket 连接管理 ----
  function scheduleReconnect(gen) {
    if (state !== 'running' || gen !== generation || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(gen).catch(() => {}); }, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  }
  async function connect(gen) {
    if (state !== 'running' || gen !== generation) return;
    try {
      const wsUrl = DSH_BASE.replace(/^http/, 'ws') + '/api/events.mux';
      const ws = new WebSocket(wsUrl);
      const watchdog = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) { try { ws.close(); } catch {} }
      }, 10000);
      ws.onopen = () => { clearTimeout(watchdog); retryMs = 1000; };
      ws.onmessage = (e) => {
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
    for (const c of sseClients) { try { c.end(); } catch {} }
    sseClients.clear();
  }

  return {
    start, stop, getEvents, listPending, respond,
    addSseClient: (res) => { sseClients.add(res); res.on('close', () => sseClients.delete(res)); },
  };
}
