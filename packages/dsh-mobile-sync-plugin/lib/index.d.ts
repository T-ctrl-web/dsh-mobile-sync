import { Context } from "@deepseek-ai/cordis";
//#region src/config.d.ts
interface MobileSyncConfig {
  /** 手机端 Enter 发送消息（默认 true；false 时 Enter 换行，仅发送按钮发送） */
  mobileEnterToSend?: boolean;
  /** 非环回 /api 请求是否需要配对（默认 true） */
  requirePairingForLan?: boolean;
  /** 公网基础 URL（如 https://foo.trycloudflare.com），用于 QR 链接 */
  publicBaseUrl?: string;
  /** 是否自动启动 Cloudflare 隧道 */
  autoTunnel?: boolean;
}
//#endregion
//#region src/index.d.ts
declare const name = "dsh-mobile-sync";
declare const inject: string[];
declare function apply(ctx: Context, config?: MobileSyncConfig): void;
//#endregion
export { type MobileSyncConfig, apply, inject, name };
//# sourceMappingURL=index.d.ts.map