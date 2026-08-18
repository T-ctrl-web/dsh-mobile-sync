// src/config.ts —— 插件配置 schema（schemastery）
// 通过 cordis.patch.yml 的 config 字段或 dsh web 设置面板配置

export interface MobileSyncConfig {
  /** 手机端 Enter 发送消息（默认 true；false 时 Enter 换行，仅发送按钮发送） */
  mobileEnterToSend?: boolean;
  /** 非环回 /api 请求是否需要配对（默认 true） */
  requirePairingForLan?: boolean;
  /** 公网基础 URL（如 https://foo.trycloudflare.com），用于 QR 链接 */
  publicBaseUrl?: string;
  /** 是否自动启动 Cloudflare 隧道 */
  autoTunnel?: boolean;
}

export const DEFAULT_CONFIG: Required<Omit<MobileSyncConfig, 'publicBaseUrl' | 'autoTunnel'>> = {
  mobileEnterToSend: true,
  requirePairingForLan: true,
};
