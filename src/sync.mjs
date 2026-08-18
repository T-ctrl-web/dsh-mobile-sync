// src/sync.mjs —— 双向镜像同步桥（零依赖版，供独立中继使用）
// 与插件版 src/sync.ts 行为一致：维护 PC/手机两端 UI 状态并双向广播。
// 独立中继模式下 PC 端没有 client 半边注入（DSH 插件系统专属），
// 因此 PC 状态默认恒空，可通过 POST /api/sync/pc-state 手动上报（预留）。

// ---- SSE 工具（自包含，避免额外文件依赖）----
function openSSE(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const stream = { res, closed: false };
  res.on('close', () => { stream.closed = true; });
  return stream;
}
function pushSSE(stream, event, data) {
  if (stream.closed) return;
  try { stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
}

function emptyState() {
  return {
    activeSessionId: null, activeSessionTitle: null,
    model: null, permission: null, lastAction: null, lastActionAt: null,
  };
}

export function createSyncBridge() {
  const pc = emptyState();
  const mobile = emptyState();
  const pcStreams = new Set();
  const mobileStreams = new Set();
  let deviceSource = null;

  const devices = () => (deviceSource ? deviceSource() : []);
  const snapshot = () => ({ pc: { ...pc }, mobile: { ...mobile }, devices: devices(), ts: Date.now() });

  function broadcast() {
    const snap = snapshot();
    for (const s of pcStreams) if (!s.closed) pushSSE(s, 'state', snap);
    for (const s of mobileStreams) if (!s.closed) pushSSE(s, 'state', snap);
  }

  function setState(side, patch) {
    const target = side === 'pc' ? pc : mobile;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && target[k] !== v) { target[k] = v; changed = true; }
    }
    if (changed) broadcast();
  }

  function openStream(res, streams) {
    const stream = openSSE(res);
    streams.add(stream);
    pushSSE(stream, 'state', snapshot());
    res.on('close', () => streams.delete(stream));
    const ka = setInterval(() => {
      if (!stream.closed) { try { pushSSE(stream, 'state', snapshot()); } catch {} }
      else clearInterval(ka);
    }, 25000);
    return stream;
  }

  return {
    snapshot,
    setState,
    recordAction: (side, action) => setState(side, { lastAction: action, lastActionAt: Date.now() }),
    notifyDevices: () => broadcast(),
    setDeviceSource: (fn) => { deviceSource = fn; },
    openPcStream: (res) => openStream(res, pcStreams),
    openMobileStream: (res) => openStream(res, mobileStreams),
    stop: () => {
      for (const s of pcStreams) if (!s.closed) { try { s.res.end(); } catch {} }
      for (const s of mobileStreams) if (!s.closed) { try { s.res.end(); } catch {} }
      pcStreams.clear(); mobileStreams.clear();
    },
  };
}
