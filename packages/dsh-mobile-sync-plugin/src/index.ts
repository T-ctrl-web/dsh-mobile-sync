// src/index.ts —— DSH Mobile Sync 插件 host 入口
// 双面 Cordis 插件：host 半边注册路由 + 配对 + 事件中继
// client 半边（lib/client.js）注入侧边栏 UI（手机图标 + 配对面板）
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-host-apiproxy';
import { PairingService } from './pairing.js';
import { createEventStore, type EventStore } from './event-store.js';
import { makePairRoutes, makeMobileApiRoutes, makeMobileRoutes, makeSyncRoutes } from './routes.js';
import { createSyncBridge, type SyncBridge } from './sync.js';
import type { MobileSyncConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';
import os from 'node:os';

export const name = 'dsh-mobile-sync';
export const inject = ['webServer', 'apiProxy'];

export type { MobileSyncConfig } from './config.js';

/** 检测本机 LAN IP 地址（用于生成手机可访问的 QR 码） */
function detectLanIp(): string | null {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254')) {
        return iface.address;
      }
    }
  }
  return null;
}

export function apply(ctx: Context, config: MobileSyncConfig = {}): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 确定 DSH 网关基址（插件内进程，用 loopback）
  const port = (ctx.webServer as any).port || 3080;
  const dshBaseUrl = `http://127.0.0.1:${port}`;

  // 确定 QR 码用的外部可达地址
  // 优先级：publicBaseUrl > LAN IP > loopback（最后兜底）
  let qrOrigin: string;
  if (cfg.publicBaseUrl) {
    qrOrigin = cfg.publicBaseUrl.replace(/\/+$/, '');
  } else {
    const lanIp = detectLanIp();
    const webServerHost = (ctx.webServer as any).host;
    // 如果 DSH 绑定 0.0.0.0 则 LAN IP 可达；否则用 host
    const bindHost = webServerHost && webServerHost !== '0.0.0.0' ? webServerHost : (lanIp || '127.0.0.1');
    qrOrigin = `http://${bindHost}:${port}`;
  }

  // 1) 配对服务
  const pairing = new PairingService(qrOrigin, cfg.publicBaseUrl);

  // 1.5) 双向同步桥（PC ↔ 手机 UI 状态镜像）
  const sync: SyncBridge = createSyncBridge();
  sync.setDeviceSource(() => pairing.snapshot().devices.map((d) => ({ label: d.label, online: d.online })));

  // 2) 事件中继（连 DSH events.mux）
  const eventStore: EventStore = createEventStore({ dshBaseUrl, apiProxy: ctx.apiProxy });

  // 3) 注册所有路由
  const allRoutes = [
    ...makePairRoutes(pairing, undefined, sync),
    ...makeSyncRoutes(sync),
    ...makeMobileRoutes(),
    ...makeMobileApiRoutes(pairing, eventStore, ctx.apiProxy, process.cwd(), sync),
  ];

  const disposeRoutes = ctx.effect(() => {
    const disposers = allRoutes.map((route) => (ctx.webServer as any).register(route));
    return () => { for (const dispose of disposers) dispose(); };
  });
  void disposeRoutes;

  // 4) 启动事件中继
  ctx.effect(() => {
    eventStore.start();
    return () => { eventStore.stop(); };
  });

  // 4.5) 停用时关闭同步流
  ctx.effect(() => () => sync.stop());

  // 5) 配对网关：非环回 /api 请求需配对（可选）
  if (cfg.requirePairingForLan) {
    ctx.on('api/gate' as any, (evt: any) => {
      const req = evt?.request;
      if (!req) return;
      const addr = req.socket?.remoteAddress || '';
      const isLoop = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
      if (isLoop) return; // 本机不受限
      const cookie = (req.headers?.cookie || '').match(/dsh-msc-[^;]+/)?.[0]?.trim();
      if (!pairing.isPaired(cookie)) {
        evt.deny = true;
      }
    });
  }

  // 6) 配置热加载
  if (cfg.publicBaseUrl !== undefined) {
    pairing.updatePublicUrl(cfg.publicBaseUrl);
  }

  // 暴露服务供 client 半边使用（通过 ctx 命名服务）
  (ctx as any).provide('mobileSync', { pairing, eventStore, config: cfg });
}
