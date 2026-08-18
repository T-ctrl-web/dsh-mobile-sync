# dsh-mobile-sync (Cordis 插件)

DSH Cordis 插件：手机远程控制 DeepSeek Harness。集成进 dsh web，侧边栏出现手机图标，扫码配对后手机进入独立移动端页面 `/m`。

## 安装

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-mobile-sync

# 从本地目录安装（开发模式）
cd packages/dsh-mobile-sync-plugin
pnpm install && pnpm build
dsh plugin --profile web add link:$(pwd)

# 重启 profile
dsh web --host 0.0.0.0
```

## 使用

1. `dsh web --host 0.0.0.0`（让手机可达）
2. 点击侧边栏底部手机图标 → 面板显示 QR 码
3. 手机扫码 → 自动配对 → 落地 `/m` 移动端页面
4. 手机端：选会话 → 发消息 → 看流式回复 / 工具卡片 / 审批卡片

## 双面架构

| 半边 | 入口 | 职责 |
|---|---|---|
| Host | `lib/index.js` (`src/index.ts`) | 路由注册、配对服务、事件中继、移动端 API 代理 |
| Client | `lib/client.js` (`src/client/index.ts`) | 侧边栏手机图标、配对面板（QR + 状态 + 停止/刷新/复制） |

## 文件结构

```
src/
├── index.ts              # Host 入口：apply(ctx) 注册路由 + 启动事件中继
├── config.ts              # 配置 schema
├── pairing.ts             # 配对服务（QR + token + 设备会话 + SSE 状态）
├── routes.ts              # 配对路由 + 移动端 API 代理 + 静态页面路由
├── http-utils.ts          # 原生 http 工具（readJsonBody/writeJson/SSE）
├── dsh-client.ts          # DSH 网关 RPC + 事件归一化
├── event-store.ts         # events.mux WebSocket 中继 + 环形缓冲 + 待审批表
└── client/
    ├── index.ts           # Client 入口：侧边栏 UI 注入
    ├── FooterRemoteEntry.tsx  # 侧边栏手机图标
    └── RemoteEntry.tsx        # 配对面板（QR + 设备状态 + 操作按钮）
assets/
└── relay.html            # /m 移动端页面（配对 cookie 鉴权）
```

## 配置

通过 `cordis.patch.yml` 的 `config` 字段：

```yaml
- insert:
  - id: mobile-sync
    name: dsh-mobile-sync
    config:
      mobileEnterToSend: true
      requirePairingForLan: true
      publicBaseUrl: https://your-tunnel.example.com
      autoTunnel: false
```

## 安全

- QR 链接含一次性 token（5 分钟有效；刷新使旧 token 失效；接受后不可重用）
- 配对设备获得 HttpOnly cookie，/m/api 凭 cookie 访问
- 手机端 RPC 方法白名单（不暴露 settings/credentials/host-action）
- 停止 撤销所有设备 + 当前 token

## License

MIT
