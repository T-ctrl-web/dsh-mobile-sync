// src/client/RemoteEntry.tsx —— 配对面板（QR 码 + 设备状态 + 停止/刷新/复制）
// 桌面端面板：扫码配对后手机进入 /m 移动端页面
// 通过 SSE /api/pair/status 实时显示配对状态
import { useState, useEffect, useCallback, type FC } from 'react';

interface PairingSnapshot {
  state: 'waiting' | 'connected' | 'disconnected';
  qrUrl?: string;
  qrDataUrl?: string;
  tokenExpiry?: number;
  devices: { cookie: string; label: string; pairedAt: string; lastHeartbeat: number; online: boolean }[];
}

export const RemoteEntry: FC<{ wide?: boolean }> = ({ wide }) => {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<PairingSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const onlineDevices = snapshot?.devices?.filter(d => d.online) || [];
  const offlineDevices = snapshot?.devices?.filter(d => !d.online) || [];
  const stateLabel = onlineDevices.length ? `${onlineDevices.length} 台在线` : (offlineDevices.length ? `${offlineDevices.length} 台离线` : '等待手机连接');
  const stateColor = onlineDevices.length ? '#4caf50' : (offlineDevices.length ? '#888' : '#f0a020');

  return (
    <div style={{ position: 'relative' }}>
      {/* 触发按钮 */}
      <button
        onClick={() => setOpen(!open)}
        title="移动端远程控制"
        style={{
          width: 36, height: 36, border: 'none', borderRadius: 8,
          background: open ? 'var(--accent, #4a90d9)' : 'transparent',
          color: open ? '#fff' : 'var(--text-secondary, #9a9a9a)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, transition: 'background 120ms',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" />
        </svg>
      </button>

      {/* 配对面板 */}
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 8,
          width: wide ? 360 : 300, background: 'var(--surface, #1a1a1f)',
          border: '1px solid var(--border, #333)', borderRadius: 12,
          padding: 16, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
          zIndex: 100, fontSize: 14, color: 'var(--text, #ececec)',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>移动端远程控制</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted, #9a9a9a)', marginBottom: 12 }}>
            扫码或在手机上打开链接，即可远程控制当前工作区
          </div>

          {/* 状态徽章 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: stateColor }} />
            <span style={{ fontSize: 13 }}>{stateLabel}</span>
            {snapshot?.devices?.length ? (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                共 {snapshot.devices.length} 台（{onlineDevices.length} 在线 / {offlineDevices.length} 离线）
              </span>
            ) : null}
          </div>

          {/* 已配对设备列表 */}
          {snapshot?.devices?.length ? (
            <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {snapshot.devices.map(d => (
                <div key={d.cookie} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
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
