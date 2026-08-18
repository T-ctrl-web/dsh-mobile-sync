// src/client/index.ts —— DSH Mobile Sync 插件 client 入口
// 浏览器半边：注入侧边栏手机图标 + 配对面板（QR 码 + 设备状态 + 停止/刷新/复制）
// 通过 ctx.slots 注册 React 组件到 sidebar.footer.action 席位
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { FooterRemoteEntry } from './FooterRemoteEntry.js';

export const NS = 'mobile-sync';
export const inject = ['slots', 'locale'];

export function apply(ctx: ClientContext): void {
  // sidebar.footer.action：侧边栏底部操作区（设置按钮旁）
  // kind: 'list'，可与其他 footer action 共存
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'mobile-sync', locale: 'sidebar' },
      FooterRemoteEntry,
    ),
  );
}
