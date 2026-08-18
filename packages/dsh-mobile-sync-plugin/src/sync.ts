// src/sync.ts —— 双向镜像同步桥（PC ↔ 手机 UI 状态同步）
// 解决的问题：会话事件流（events.mux）已天然双向，但"当前活跃会话/模型/权限/最近操作"
// 这类 UI 状态不产生会话事件，两端互相不可见。本桥维护两端状态并双向广播：
//
//   PC 端(client 半边)  --POST /api/sync/pc-state-->  SyncBridge  --SSE /m/api/sync-->  手机
//   手机(relay.html)    --POST /m/api/sync/mobile-state--> SyncBridge --SSE /api/sync--> PC 端
//
// 广播通道：
//   GET /api/sync        （loopback，PC client 订阅）推送 { mobile, devices, ts }
//   GET /m/api/sync      （手机订阅）              推送 { pc, devices, ts }
//   GET /m/api/sync/state（轮询兜底，手机用）      返回同构 JSON 快照
import { openSSE, pushSSE, type SSEStream } from './http-utils.js';

export interface SyncSideState {
  /** 该端当前打开的会话 id（null = 未打开任何会话） */
  activeSessionId: string | null;
  /** 该端当前会话的显示标题（供另一端展示，可点击跳转） */
  activeSessionTitle: string | null;
  /** 该端当前会话使用的模型 id */
  model: string | null;
  /** 该端当前权限模式（ask/auto/read-only/plan） */
  permission: string | null;
  /** 最近一次关键操作的人类可读描述（如 "发送了一条消息"） */
  lastAction: string | null;
  /** 最近一次操作的时间戳 */
  lastActionAt: number | null;
}

export interface SyncDeviceView {
  label: string;
  online: boolean;
}

export interface SyncSnapshot {
  pc: SyncSideState;
  mobile: SyncSideState;
  devices: SyncDeviceView[];
  ts: number;
}

export type Side = 'pc' | 'mobile';

const emptyState = (): SyncSideState => ({
  activeSessionId: null, activeSessionTitle: null,
  model: null, permission: null, lastAction: null, lastActionAt: null,
});

export interface SyncBridge {
  snapshot(): SyncSnapshot;
  /** 合并更新某一端的状态（仅写差异字段）并广播 */
  setState(side: Side, patch: Partial<SyncSideState>): void;
  /** 记录某一端的最近操作并广播 */
  recordAction(side: Side, action: string): void;
  /** 设备列表变化（配对/心跳/撤销）后通知所有订阅者 */
  notifyDevices(): void;
  /** 注入设备列表读取函数（取自 pairing.snapshot） */
  setDeviceSource(fn: () => SyncDeviceView[]): void;
  /** PC client 订阅（loopback SSE） */
  openPcStream(res: unknown): void;
  /** 手机订阅（SSE） */
  openMobileStream(res: unknown): void;
  stop(): void;
}

export function createSyncBridge(): SyncBridge {
  const pc = emptyState();
  const mobile = emptyState();
  const pcStreams = new Set<SSEStream>();
  const mobileStreams = new Set<SSEStream>();
  let deviceSource: (() => SyncDeviceView[]) | null = null;

  const devices = (): SyncDeviceView[] => (deviceSource ? deviceSource() : []);

  function snapshot(): SyncSnapshot {
    return { pc: { ...pc }, mobile: { ...mobile }, devices: devices(), ts: Date.now() };
  }

  function broadcast() {
    const snap = snapshot();
    for (const s of pcStreams) if (!s.closed) pushSSE(s, 'state', snap);
    for (const s of mobileStreams) if (!s.closed) pushSSE(s, 'state', snap);
  }

  function setState(side: Side, patch: Partial<SyncSideState>) {
    const target = side === 'pc' ? pc : mobile;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && (target as any)[k] !== v) { (target as any)[k] = v; changed = true; }
    }
    if (changed) broadcast();
  }

  function recordAction(side: Side, action: string) {
    setState(side, { lastAction: action, lastActionAt: Date.now() });
  }

  function openStream(res: unknown, streams: Set<SSEStream>): SSEStream {
    const stream = openSSE(res as any);
    streams.add(stream);
    pushSSE(stream, 'state', snapshot());
    (res as any).on('close', () => { streams.delete(stream); });
    // 每 25s 心跳：既保活，也顺带刷新设备在线/离线状态（90s 无心跳判离线能在此体现）
    const ka = setInterval(() => {
      if (!stream.closed) {
        try { pushSSE(stream, 'state', snapshot()); } catch {}
      } else clearInterval(ka);
    }, 25000);
    return stream;
  }

  return {
    snapshot,
    setState,
    recordAction,
    notifyDevices: () => broadcast(),
    setDeviceSource: (fn) => { deviceSource = fn; },
    openPcStream: (res) => { openStream(res, pcStreams); },
    openMobileStream: (res) => { openStream(res, mobileStreams); },
    stop: () => {
      for (const s of pcStreams) if (!s.closed) { try { s.res.end(); } catch {} }
      for (const s of mobileStreams) if (!s.closed) { try { s.res.end(); } catch {} }
      pcStreams.clear(); mobileStreams.clear();
    },
  };
}
