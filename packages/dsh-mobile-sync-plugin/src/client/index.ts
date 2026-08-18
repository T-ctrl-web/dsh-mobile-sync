// src/client/index.ts —— DSH Mobile Sync 插件 client 入口
// 浏览器半边：注入侧边栏手机图标 + 配对面板（QR 码 + 设备状态 + 停止/刷新/复制）
// 通过 ctx.slots 注册 React 组件到 sidebar 席位
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import { RemoteEntry } from './RemoteEntry.js';
import { FooterRemoteEntry } from './FooterRemoteEntry.js';

export const NS = 'mobile-sync';
export const inject = ['slots', 'locale', 'connection', 'settingsScope'];

export function apply(ctx: ClientContext): void {
  // 主席位：sidebar.remote（侧边栏底部，设置按钮旁）
  ctx.slots.inject('sidebar.remote', () => {
    const disposeEntry = ctx.slots.register(
      { name: 'sidebar.remote', locale: 'sidebar' },
      RemoteEntry,
    );
    return () => { disposeEntry(); };
  });

  // 兜底席位：sidebar.footer.action（新版 shell 使用）
  ctx.slots.inject('sidebar.footer.action', () => {
    const disposeFooter = ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'mobile-sync', locale: 'sidebar' },
      FooterRemoteEntry,
    );
    return () => { disposeFooter(); };
  });
}

// SlotMap 声明合并：向 DSH 的插槽系统注册自定义席位
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.remote': { kind: 'single'; scope: 'root'; owner: { wide: boolean } };
  }
}
