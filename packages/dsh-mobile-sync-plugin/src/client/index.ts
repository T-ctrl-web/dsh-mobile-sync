// src/client/index.ts —— DSH Mobile Sync 插件 client 入口
// 浏览器半边：注入侧边栏手机图标 + 配对面板（QR 码 + 设备状态 + 停止/刷新/复制）
// 通过 ctx.slots 注册 React 组件到 sidebar.footer.action 席位
// 额外职责（双向同步的 PC 半边）：
//   - 订阅 ctx.sessions.list，PC 端切换当前会话时上报 host 同步桥 → 手机实时感知
//   - 注入"在电脑上打开手机端会话"能力
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { FooterRemoteEntry } from './FooterRemoteEntry.js';
import { setOpenSession, reportPcState } from './bridge.js';

export const NS = 'mobile-sync';
export const inject = ['slots', 'locale', 'sessions'];

export function apply(ctx: ClientContext): void {
  // 注入"在电脑上打开会话"能力（配对面板点击手机端会话时跳转 PC 主界面）
  setOpenSession((sessionId) => {
    try { (ctx.sessions as any).open(sessionId); } catch { /* 会话已不存在 */ }
  });

  // PC → 手机 反向同步：监听 PC 端当前会话变化并上报 host
  // ctx.sessions.list 是 ObservableSnapshot<SessionListState>，current 即当前选中会话
  ctx.effect(() => {
    let lastReport = '';
    const report = () => {
      try {
        const st = (ctx.sessions as any).list.getSnapshot();
        const current: string | undefined = st?.current;
        const title = current ? st?.byId?.[current]?.displayTitle : null;
        const key = String(current || '') + '|' + String(title || '');
        if (key === lastReport) return; // 去重：仅状态变化时上报
        lastReport = key;
        reportPcState({ activeSessionId: current ?? null, activeSessionTitle: title ?? null });
      } catch { /* sessions 服务尚未就绪 */ }
    };
    const unsub = (ctx.sessions as any).list.subscribe(report);
    // 挂载后立即上报一次当前状态
    report();
    return unsub;
  });

  // sidebar.footer.action：侧边栏底部操作区（设置按钮旁）
  // kind: 'list'，可与其他 footer action 共存
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'mobile-sync', locale: 'sidebar' },
      FooterRemoteEntry,
    ),
  );
}
