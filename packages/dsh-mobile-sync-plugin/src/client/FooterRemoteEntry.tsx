// src/client/FooterRemoteEntry.tsx —— 侧边栏底部手机图标（触发配对面板）
// 小按钮，点击后展开 RemoteEntry 配对面板
import { useState, type FC } from 'react';

export const FooterRemoteEntry: FC<{ open?: boolean; onToggle?: (v: boolean) => void }> = ({ open: openProp, onToggle }) => {
  const [internal, setInternal] = useState(false);
  const open = openProp ?? internal;
  const toggle = () => {
    const next = !open;
    if (onToggle) onToggle(next); else setInternal(next);
  };

  return (
    <button
      onClick={toggle}
      title="手机远程控制"
      style={{
        width: 36, height: 36, border: 'none', borderRadius: 8,
        background: open ? 'var(--accent, #4a90d9)' : 'transparent',
        color: open ? '#fff' : 'var(--text-secondary, #9a9a9a)',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 18, transition: 'background 120ms',
      }}
    >
      {/* 手机图标 SVG */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <path d="M12 18h.01" />
      </svg>
    </button>
  );
};
