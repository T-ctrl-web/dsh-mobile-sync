// src/client/FooterRemoteEntry.tsx —— 侧边栏底部手机图标 + 配对面板
// 小按钮（sidebar.footer.action slot），点击弹出 QR 码配对面板
// Props 来自 SidebarFooterActionOwnerProps: { wide: boolean }
// 双向同步的 PC 半边 UI：
//   - 图标右下角常驻设备在线状态点（绿=在线 / 黄=等待 / 灰=离线）
//   - 面板内"实时同步"区块：电脑当前会话、手机端会话 + 最近操作 + 一键在电脑打开
import { useState, useEffect, useCallback, type FC } from 'react';
import { openSessionFn } from './bridge.js';

interface PairingSnapshot {
  state: 'waiting' | 'connected' | 'disconnected';
  qrUrl?: string;
  qrDataUrl?: string;
  tokenExpiry?: number;
  devices: { cookie: string; label: string; pairedAt: string; lastHeartbeat: number; online: boolean }[];
}

interface SyncSideState {
  activeSessionId: string | null;
  activeSessionTitle: string | null;
  model: string | null;
  permission: string | null;
  lastAction: string | null;
  lastActionAt: number | null;
}

interface SyncSnapshot {
  pc: SyncSideState;
  mobile: SyncSideState;
  devices: { label: string; online: boolean }[];
  ts: number;
}

const fmtTime = (t: number | null): string => {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const FooterRemoteEntry: FC<{ wide?: boolean }> = ({ wide }) => {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<PairingSnapshot | null>(null);
  const [sync, setSync] = useState<SyncSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 常驻订阅同步状态流（不依赖面板开合，保证图标圆点实时）
  useEffect(() => {
    const es = new EventSource('/api/sync');
    es.addEventListener('state', (e: MessageEvent) => {
      try { setSync(JSON.parse(e.data)); } catch {}
    });
    es.onerror = () => { /* EventSource 自动重连 */ };
    return () => es.close();
  }, []);

  const issue = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/pair/issue', { method: 'POST' });
      const j = await r.json();
      if (j.error) setError(j.error);
      else setSnapshot(j);
    } catch (e: any) { setError(String(e)); }
    finally { setLoading(false); }
  }, []);

  const stop = useCallback(async () => {
    try { await fetch('/api/pair/stop', { method: 'POST' }); setSnapshot(null); }
    catch (e: any) { setError(String(e)); }
  }, []);

  const copyLink = useCallback(() => {
    if (!snapshot?.qrUrl) return;
    navigator.clipboard.writeText(snapshot.qrUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [snapshot]);

  // SSE 状态流
  useEffect(() => {
    if (!open) return;
    const es = new EventSource('/api/pair/status');
    es.addEventListener('state', (e: MessageEvent) => {
      try { setSnapshot(JSON.parse(e.data)); } catch {}
    });
    return () => es.close();
  }, [open]);

  // 进入面板时自动签发 QR
  useEffect(() => { if (open && !snapshot) issue(); }, [open, snapshot, issue]);

  const onlineCount = sync?.devices?.filter(d => d.online).length || 0;
  const totalDevices = sync?.devices?.length || 0;
  // 圆点颜色：有在线设备=绿，有配对设备但全离线=灰，无设备=黄
  const dotColor = onlineCount > 0 ? '#4caf50' : (totalDevices > 0 ? '#888' : '#f0a020');
  const dotTitle = onlineCount > 0 ? `${onlineCount} 台手机在线` : (totalDevices > 0 ? '手机已配对但离线' : '等待手机连接');

  const mobile = sync?.mobile;
  const pc = sync?.pc;
  const hasMobileSession = !!mobile?.activeSessionId;

  return (
    <div style={{ position: 'relative' }}>
      {/* 触发按钮（右下角带在线状态点） */}
      <button
        onClick={() => setOpen(!open)}
        title={dotTitle}
        style={{
          width: 36, height: 36, border: 'none', borderRadius: 8,
          background: open ? 'var(--accent, #4a90d9)' : 'transparent',
          color: open ? '#fff' : 'var(--text-secondary, #9a9a9a)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, transition: 'background 120ms', position: 'relative',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" />
        </svg>
        <span style={{
          position: 'absolute', right: 3, bottom: 3, width: 8, height: 8, borderRadius: '50%',
          background: dotColor, border: '1.5px solid var(--surface, #1a1a1f)',
        }} />
      </button>

      {/* 配对面板 */}
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 8,
          width: wide ? 380 : 320, background: 'var(--surface, #1a1a1f)',
          border: '1px solid var(--border, #333)', borderRadius: 12,
          padding: 16, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
          zIndex: 100, fontSize: 14, color: 'var(--text, #ececec)',
          maxHeight: '70vh', overflowY: 'auto',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>移动端远程控制</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted, #9a9a9a)', marginBottom: 12 }}>
            扫码或在手机上打开链接，即可远程控制当前工作区
          </div>

          {/* 实时同步状态 */}
          <div style={{ border: '1px solid var(--border, #333)', borderRadius: 10, padding: 10, marginBottom: 12, background: 'var(--bg-muted, #222)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor }} />
              双向实时同步
            </div>

            {/* 手机端当前会话 */}
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>手机端：</span>
              {hasMobileSession ? (
                <span style={{ color: 'var(--text)' }}>{mobile?.activeSessionTitle || (mobile?.activeSessionId || '').slice(0, 8)}</span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>{onlineCount ? '已连接，尚未打开会话' : '未连接'}</span>
              )}
            </div>

            {/* 手机最近操作 */}
            {mobile?.lastAction && onlineCount > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                <span style={{ color: 'var(--accent, #4a90d9)' }}>{mobile.lastAction}</span>
                {' · '}{fmtTime(mobile.lastActionAt)}
              </div>
            )}

            {/* 一键在电脑打开手机端会话 */}
            {hasMobileSession && (() => {
              const targetId = mobile?.activeSessionId || null;
              return (
                <button
                  onClick={() => { if (openSessionFn && targetId) openSessionFn(targetId); }}
                  style={{
                    width: '100%', padding: '6px 0', borderRadius: 8, fontSize: 12, fontWeight: 600,
                    background: 'var(--accent, #4a90d9)', color: '#fff', border: 'none', cursor: 'pointer',
                  }}
                >在电脑上打开该会话</button>
              );
            })()}

            {/* 电脑当前会话（确认反向同步生效） */}
            {pc?.activeSessionId && (
              <div style={{ fontSize: 12, marginTop: 8, color: 'var(--text-muted)' }}>
                电脑当前会话：<span style={{ color: 'var(--text)' }}>{pc.activeSessionTitle || pc.activeSessionId.slice(0, 8)}</span>
              </div>
            )}
          </div>

          {/* 状态徽章 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor }} />
            <span style={{ fontSize: 13 }}>
              {onlineCount > 0 ? `${onlineCount} 台在线` : (totalDevices > 0 ? `${totalDevices} 台已配对（离线）` : '等待手机连接')}
            </span>
            {totalDevices > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                共 {totalDevices} 台（{onlineCount} 在线 / {totalDevices - onlineCount} 离线）
              </span>
            )}
          </div>

          {/* 已配对设备列表 */}
          {sync?.devices?.length ? (
            <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sync.devices.map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: d.online ? '#4caf50' : '#888' }} />
                  <span>{d.label}</span>
                  <span style={{ fontSize: 10 }}>{d.online ? '在线' : '离线'}</span>
                </div>
              ))}
            </div>
          ) : null}

          {/* QR 码 */}
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>生成中…</div>
          ) : error ? (
            <div style={{ color: '#e0533d', fontSize: 12, padding: 8 }}>{error}</div>
          ) : snapshot?.qrDataUrl ? (
            <div style={{ textAlign: 'center', marginBottom: 12 }}>
              <img src={snapshot.qrDataUrl} alt="扫码连接" style={{ width: '100%', maxWidth: 240, borderRadius: 8 }} />
            </div>
          ) : null}

          {/* 链接 */}
          {snapshot?.qrUrl && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>无法扫码？可以在手机上打开链接：</div>
              <div style={{
                fontSize: 10, fontFamily: 'monospace', wordBreak: 'break-all',
                background: 'var(--bg-muted, #222)', padding: '4px 8px', borderRadius: 6, color: 'var(--text-muted)',
              }}>{snapshot.qrUrl}</div>
            </div>
          )}

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={stop} style={{
              flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: 'var(--danger, #e0533d)', color: '#fff', border: 'none', cursor: 'pointer',
            }}>停止</button>
            <button onClick={issue} style={{
              flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: 'var(--bg-muted, #2b2b2b)', color: 'var(--text)', border: '1px solid var(--border)', cursor: 'pointer',
            }}>刷新二维码</button>
            <button onClick={copyLink} style={{
              flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: 'var(--bg-muted, #2b2b2b)', color: copied ? '#4caf50' : 'var(--text)', border: '1px solid var(--border)', cursor: 'pointer',
            }}>{copied ? '已复制' : '复制链接'}</button>
          </div>

          {/* 提示 */}
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
            提示：需 <code style={{ fontSize: 10 }}>dsh web --host 0.0.0.0</code> 让手机可达；
            外网用 <code style={{ fontSize: 10 }}>Tailscale</code> 或 <code style={{ fontSize: 10 }}>cloudflared</code>
          </div>
        </div>
      )}
    </div>
  );
};
