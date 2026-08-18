// src/client/bridge.ts —— client 半边与 host 同步桥的通信层
// 职责：
//  1. 向 host 上报 PC 端状态（当前会话/标题/模型/权限）
//  2. 暴露"在电脑上打开某会话"的能力（配对面板跳转用）
// 之所以独立成模块：client/index.ts（apply 注册）与 FooterRemoteEntry（组件）
// 都需要访问同一份能力，避免循环导入。

/** 由 client/index.ts 在 apply() 时注入：打开指定会话（PC 端 DSH 主界面跳转） */
export let openSessionFn: ((sessionId: string) => void) | null = null;
export function setOpenSession(fn: (sessionId: string) => void): void {
  openSessionFn = fn;
}

export interface PcStatePatch {
  activeSessionId?: string | null;
  activeSessionTitle?: string | null;
  model?: string | null;
  permission?: string | null;
  action?: string;
}

/** 向 host 同步桥上报 PC 端状态（host 再广播给手机） */
export function reportPcState(patch: PcStatePatch): void {
  try {
    fetch('/api/sync/pc-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
      keepalive: true,
    }).catch(() => { /* host 暂时不可达则丢弃，下次变化再上报 */ });
  } catch { /* ignore */ }
}
