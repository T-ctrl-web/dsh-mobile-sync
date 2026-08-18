// src/pairing.ts —— 配对服务（QR 码生成 + 一次性 token + 设备会话 + SSE 状态流）
// 安全模型：
//   - QR 链接含一次性 token（5 分钟有效；刷新使旧 token 失效；接受后不可重用）
//   - 配对成功的设备获得 deviceCookie（HttpOnly，7 天有效）
//   - 设备记录在服务端保留 7 天；心跳仅影响在线/离线状态，不影响配对有效性
//   - 7 天内重新打开浏览器 → Cookie 自动鉴权 → 无需重新扫码
//   - 停止 撤销所有已配对设备 + 当前 token
import QRCode from 'qrcode';
import { openSSE, pushSSE, type SSEStream } from './http-utils.js';

const TOKEN_TTL_MS = 5 * 60 * 1000;          // QR token 5 分钟有效
const PAIRING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 配对 7 天有效（与 Cookie Max-Age 一致）
const HEARTBEAT_TTL_MS = 90 * 1000;            // 90 秒无心跳判离线（仅影响在线状态）

export interface PairedDevice {
  cookie: string;
  label: string;
  pairedAt: string;
  lastHeartbeat: number;
  online: boolean;
}

export interface PairingSnapshot {
  state: 'waiting' | 'connected' | 'disconnected';
  qrUrl?: string;
  qrDataUrl?: string;
  tokenExpiry?: number;
  devices: PairedDevice[];
}

export class PairingService {
  private baseUrl: string;
  private publicBaseUrl: string | undefined;
  private currentToken: string | null = null;
  private tokenExpiry = 0;
  private devices = new Map<string, PairedDevice>();
  private statusStreams = new Set<SSEStream>();

  constructor(baseUrl: string, publicBaseUrl?: string) {
    this.baseUrl = baseUrl;
    this.publicBaseUrl = publicBaseUrl;
  }

  private origin(): string {
    if (this.publicBaseUrl) return this.publicBaseUrl.replace(/\/+$/, '');
    return this.baseUrl;
  }

  private genToken(): string {
    return 'pair-' + cryptoRandom() + '-' + Date.now().toString(36);
  }

  private genCookie(): string {
    return 'dsh-msc-' + cryptoRandom() + '-' + Date.now().toString(36);
  }

  /** 生成 QR 数据 URL（含一次性 token 的配对链接） */
  async issueToken(workspaceParam?: string): Promise<{ qrUrl: string; qrDataUrl: string; tokenExpiry: number }> {
    // 刷新使旧 token 失效
    this.currentToken = this.genToken();
    this.tokenExpiry = Date.now() + TOKEN_TTL_MS;

    const url = new URL(this.origin() + '/m/pair');
    url.searchParams.set('token', this.currentToken);
    if (workspaceParam) url.searchParams.set('workspace', workspaceParam);
    const qrUrl = url.toString();

    const qrDataUrl = await QRCode.toDataURL(qrUrl, {
      margin: 2, width: 320, color: { dark: '#1a1a1a', light: '#ffffff' },
    });
    return { qrUrl, qrDataUrl, tokenExpiry: this.tokenExpiry };
  }

  /** 手机端扫码后提交 token → 配对成功则获得 device cookie */
  accept(token: string, label?: string): { ok: boolean; cookie?: string; error?: string } {
    if (!this.currentToken || token !== this.currentToken) {
      return { ok: false, error: 'token 无效或已刷新' };
    }
    if (Date.now() > this.tokenExpiry) {
      this.currentToken = null;
      return { ok: false, error: 'token 已过期' };
    }
    // token 接受后不可重用
    this.currentToken = null;

    const cookie = this.genCookie();
    const now = Date.now();
    this.devices.set(cookie, {
      cookie, label: label || '手机设备',
      pairedAt: new Date().toISOString(),
      lastHeartbeat: now,
      online: true,
    });
    this.broadcast();
    return { ok: true, cookie };
  }

  /** 心跳：更新在线状态。配对未过期则自动恢复在线（无需重新扫码） */
  heartbeat(cookie: string): boolean {
    const dev = this.devices.get(cookie);
    if (!dev) return false;
    // 配对已过期（超过 7 天）
    if (Date.now() - new Date(dev.pairedAt).getTime() > PAIRING_TTL_MS) {
      this.devices.delete(cookie);
      this.broadcast();
      return false;
    }
    // 恢复在线
    dev.lastHeartbeat = Date.now();
    dev.online = true;
    this.broadcast();
    return true;
  }

  /** 验证设备 cookie 是否已配对（在 7 天配对有效期内） */
  isPaired(cookie: string | undefined): boolean {
    if (!cookie) return false;
    const dev = this.devices.get(cookie);
    if (!dev) return false;
    // 配对过期（超过 7 天）→ 清理并拒绝
    if (Date.now() - new Date(dev.pairedAt).getTime() > PAIRING_TTL_MS) {
      this.devices.delete(cookie);
      this.broadcast();
      return false;
    }
    return true;
  }

  /** 撤销所有设备 + 当前 token */
  stop(): void {
    this.currentToken = null;
    this.tokenExpiry = 0;
    this.devices.clear();
    this.broadcast();
  }

  /** 快照供面板显示（更新在线/离线状态，但不删除已配对设备） */
  snapshot(): PairingSnapshot {
    const now = Date.now();
    const activeDevices: PairedDevice[] = [];
    for (const [k, dev] of this.devices) {
      // 配对过期 → 清理
      if (now - new Date(dev.pairedAt).getTime() > PAIRING_TTL_MS) {
        this.devices.delete(k);
        continue;
      }
      // 更新在线状态（90 秒无心跳判离线，但不删除）
      dev.online = (now - dev.lastHeartbeat) <= HEARTBEAT_TTL_MS;
      activeDevices.push(dev);
    }
    const onlineCount = activeDevices.filter(d => d.online).length;
    return {
      state: onlineCount > 0 ? 'connected' : (activeDevices.length > 0 ? 'disconnected' : 'waiting'),
      devices: activeDevices,
    };
  }

  /** 桌面端状态 SSE */
  openStatusStream(res: any): void {
    const stream = openSSE(res);
    this.statusStreams.add(stream);
    // 立即推送一次快照
    pushSSE(stream, 'state', this.snapshot());
    stream.res.on('close', () => { this.statusStreams.delete(stream); });
    // 心跳
    const ka = setInterval(() => {
      if (!stream.closed) {
        try { stream.res.write(': keepalive\n\n'); } catch {}
      } else { clearInterval(ka); }
    }, 25000);
  }

  private broadcast(): void {
    const snap = this.snapshot();
    for (const s of this.statusStreams) {
      if (!s.closed) pushSSE(s, 'state', snap);
    }
  }

  /** 更新公网 URL（配置热加载） */
  updatePublicUrl(url?: string): void {
    this.publicBaseUrl = url;
  }
}

function cryptoRandom(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}
