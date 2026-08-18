# DSH Mobile Sync — 手机远程控制 DeepSeek Harness

把 DSH 装进口袋——在手机上远程操作电脑上的 Agent：发消息、看流式回复、批准工具调用、回答 Agent 提问、切模型/权限、翻文件、跑终端命令。

提供两种部署方式：**Cordis 插件**（推荐，原生集成）和**独立中继**（零依赖，clone 即跑）。

## 架构

```
┌──────────────┐   扫码配对 / Tailscale / 隧道   ┌──────────────────┐
│  手机浏览器   │ ──────────────────────────────▶ │  DSH Web 网关     │
│  /m 移动端   │ ◀── SSE 流式 + Cookie 鉴权 ──── │  Cordis 插件路由  │
│  relay.html  │                                 │  事件中继 + RPC   │
└──────────────┘                                 └──────────────────┘
```

插件是 DSH 的"内嵌翻译层"：对手机做 HTTP/SSE 服务端（`/m` 路径），对 DSH 内部做 `ApiProxy` RPC + `events.mux` WebSocket 中继。

## 方式一：Cordis 插件（推荐）

### 前置条件

- 已安装 **DeepSeek Harness**（`npx @deepseek-ai/dsh web`）
- **Node.js 22+**
- **pnpm**（用于构建插件）

### 安装

```bash
cd packages/dsh-mobile-sync-plugin
pnpm install          # 安装依赖
pnpm build            # 构建（tsc 类型检查 + tsdown 打包）
```

构建产物在 `lib/` 目录：
- `lib/index.js` — host 半边（路由 + 配对 + 事件中继）
- `lib/client.js` — client 半边（侧边栏 UI）
- `lib/assets/relay.html` — 移动端页面

### 加载插件

```bash
# 方式 A：link 模式（开发时热加载）
dsh plugin --profile web add link:$(pwd)/packages/dsh-mobile-sync-plugin

# 方式 B：打包后安装
dsh plugin --profile web add dsh-mobile-sync

# 启动 DSH Web（需 0.0.0.0 让手机可达）
dsh web --host 0.0.0.0
```

### 手机配对

1. 电脑端打开 DSH Web，侧边栏底部出现 **手机图标**
2. 点击图标 → 弹出配对面板 → 显示 QR 码
3. 手机扫码（或手动输入 URL）→ 自动配对 → 跳转到 `/m/` 移动端页面
4. 配对成功后，手机获得 HttpOnly Cookie，后续 `/m/api/*` 请求自动鉴权

### 插件配置

通过 DSH 设置面板或 `cordis.patch.yml` 配置：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `mobileEnterToSend` | `true` | 手机端 Enter 键发送消息（false 时换行） |
| `requirePairingForLan` | `true` | 非环回请求需配对 |
| `publicBaseUrl` | 自动检测 | 公网 URL（如 `https://foo.trycloudflare.com`），用于 QR 码 |

## 方式二：独立中继（零依赖）

不依赖 DSH 插件系统，clone 即跑。适合快速测试或不支持插件的环境。

```bash
cd dsh-mobile-sync
cp config.example.json config.json   # 设置 token
node agent.mjs                        # 启动中继（端口 8788）
```

手机访问 `http://<电脑IP>:8788/` → 输入 token → 连接。

## 外网远程（不同 WiFi）

手机和电脑不在同一 WiFi 时，需内网穿透把 DSH 端口暴露出去。

### Tailscale（最推荐）

```bash
# 电脑和手机各装 Tailscale，登录同一账号
# 电脑启动：dsh web --host 0.0.0.0
# 手机访问：http://<电脑Tailscale IP>:3080/m/
```

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://127.0.0.1:3080
# 打印: https://xxxx.trycloudflare.com
# 在插件配置中设置 publicBaseUrl 为该 URL，QR 码自动使用
```

> Cloudflare QuickTunnel 不转发 SSE，前端会自动降级为轮询模式（每 1.5s），功能不受影响。

### 自有反代（nginx/frp/caddy）

```nginx
location / {
  proxy_pass http://127.0.0.1:3080;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_read_timeout 3600s;
}
```

## 功能清单

| 能力 | 说明 |
|---|---|
| 多轮对话 | 发消息、Markdown 渲染、流式打字机回复 |
| 双向实时同步 | PC ↔ 手机 UI 状态镜像：当前会话、模型、权限、最近操作两端实时可见、可互相跳转 |
| 离线补同步 | 手机断线重连后自动补齐错过的会话事件（环形缓冲回放 + 历史回填） |
| SSE 实时 | `events.mux` 事件流，打开会话即实时收事件 |
| 审批卡片 | 危险操作弹卡，允许/拒绝 |
| 提问卡片 | `ask_user_question` 弹卡，选项/自定义回答 |
| 工具卡片 | 每步操作一张卡：名称+状态+参数+结果 |
| 模型切换 | 顶栏切换模型（多 Provider 分组） |
| 权限模式 | 逐次询问/自动/只读/仅规划 |
| 文件浏览 | 浏览电脑目录、查看文件内容 |
| 终端 | 手机远程执行电脑命令 |
| 会话管理 | 工作区/会话列表、新建会话 |

## 双向镜像同步

会话事件流（`events.mux`）天然双向：手机发消息/审批/回答提问，PC 端 DSH 主界面实时可见；PC 端操作同样实时推送到手机。在此基础上，插件额外同步**纯 UI 状态**（这些不产生会话事件，两端原本互相不可见）：

| 同步内容 | 方向 | 表现 |
|---|---|---|
| 当前打开的会话 | PC → 手机 | 手机端出现「💻 电脑正在查看：xxx」提示条，点击即切到该会话 |
| 当前打开的会话 | 手机 → PC | PC 端侧边栏手机图标显示手机端会话名，面板可一键「在电脑上打开该会话」 |
| 模型 / 权限切换 | 双向 | 手机端切换后上报，PC 面板显示最近操作 |
| 最近操作 | 手机 → PC | 「发消息 / 切换模型 xxx / 切换权限 xxx」+ 时间，显示在 PC 面板 |
| 设备在线状态 | 手机 → PC | 侧边栏图标右下角常驻状态点（绿=在线 / 灰=离线 / 黄=等待） |

**离线补同步**：手机断线期间错过的事件不会丢——重连时 `events.stream` 携带 `afterSeq` 参数，服务端先回放环形缓冲（每会话 200 条）中该水位之后的事件，缓冲缺口再自动回填 `session.history`；SSE 被阻断时自动降级为 1.5s 轮询增量拉取，机制相同。

## 连接模式自动切换

顶栏连接状态圆点：

| 圆点 | 模式 | 说明 |
|---|---|---|
| 绿色 | SSE 实时 | 局域网 / Tailscale / 正确配置的反代 |
| 黄色 | 轮询降级 | SSE 被阻断时，每 1.5s 轮询，功能完整 |
| 灰色 | 未连接 | 未进入会话或连接已断开 |

## 插件 API 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/pair/issue` | 签发 QR 码（仅 loopback） |
| POST | `/api/pair/accept` | 接受配对（设置 Cookie） |
| POST | `/api/pair/heartbeat` | 设备心跳 |
| POST | `/api/pair/stop` | 撤销所有设备（仅 loopback） |
| GET | `/api/pair/status` | 配对状态 SSE（仅 loopback） |
| GET | `/api/sync` | PC 端同步状态 SSE（仅 loopback） |
| POST | `/api/sync/pc-state` | PC 端上报当前会话/模型/权限（仅 loopback） |
| GET | `/m/` | 移动端页面 |
| GET | `/m/pair?token=` | 配对中转页 |
| GET | `/m/api/sync` | 手机端同步状态 SSE（推送 PC 状态 + 设备列表） |
| GET | `/m/api/sync/state` | 手机端同步状态快照（轮询兜底） |
| POST | `/m/api/sync/mobile-state` | 手机端上报当前会话/模型/权限/最近操作 |
| GET | `/m/api/workspaces` | 工作区列表 |
| GET | `/m/api/sessions` | 会话列表 |
| POST | `/m/api/sessions` | 新建会话 |
| GET | `/m/api/sessions/:id/history` | 对话历史 |
| POST | `/m/api/sessions/:id/prompt` | 发消息 |
| POST | `/m/api/sessions/:id/cancel` | 取消当前轮 |
| GET/POST | `/m/api/sessions/:id/model` | 获取/切换模型 |
| POST | `/m/api/sessions/:id/permission` | 切权限模式 |
| GET | `/m/api/sessions/:id/events?afterSeq=` | 轮询事件增量 |
| GET | `/m/api/sessions/:id/events.stream` | SSE 实时流 |
| GET | `/m/api/pending` | 待审批/提问列表 |
| POST | `/m/api/approvals/:id` | 审批响应 |
| POST | `/m/api/questions/:id` | 提问回答 |
| POST | `/m/api/terminal` | 远程终端 |
| GET | `/m/api/files?path=` | 目录浏览 |
| GET | `/m/api/file?path=` | 读文件 |
| POST | `/m/api/heartbeat` | 心跳保活 |

`/m/api/*` 路由需配对 Cookie 鉴权；`/api/pair/*` 仅限 loopback。

## 安全说明

- QR 码含一次性 token，5 分钟有效，接受后不可重用
- 配对成功后设备获 HttpOnly Cookie，90 秒无心跳判离线
- 手机端 API 白名单：仅暴露会话/工作区/模型操作，不含 settings/credentials
- 非环回请求需配对（可配置关闭）
- 公网建议经 Tailscale 私有网络或 HTTPS 反代

## 项目结构

```
dsh-mobile-sync/
├── packages/
│   └── dsh-mobile-sync-plugin/        # Cordis 插件
│       ├── src/
│       │   ├── index.ts               # host 入口（路由 + 配对 + 事件中继）
│       │   ├── config.ts              # 配置 schema
│       │   ├── pairing.ts             # QR 配对服务
│       │   ├── sync.ts                # 双向同步桥（PC ↔ 手机 UI 状态镜像）
│       │   ├── dsh-client.ts          # DSH RPC 客户端 + 事件归一化
│       │   ├── event-store.ts          # events.mux 中继 + 环形缓冲
│       │   ├── http-utils.ts          # HTTP/SSE 工具函数
│       │   ├── routes.ts               # 全部路由（配对 + 同步 + 移动端 API + 静态页）
│       │   └── client/                # 浏览器半边
│       │       ├── index.ts           # 侧边栏 UI 注入 + PC 会话监听上报
│       │       ├── bridge.ts          # client 半边与同步桥的通信层
│       │       └── FooterRemoteEntry.tsx # 侧边栏手机图标 + 配对/同步面板
│       ├── assets/
│       │   └── relay.html             # 移动端单文件前端（含双向同步）
│       ├── cordis.patch.yml           # 插件注册
│       ├── tsconfig.json
│       └── tsdown.config.ts
├── agent.mjs                          # 独立中继（零依赖）
├── src/
│   ├── sync.mjs                       # 双向同步桥（零依赖版）
│   └── ...                            # 其余同插件（server/event-store/dsh-client/config）
├── config.example.json
└── README.md
```

## 技术细节

### 双向同步桥（SyncBridge）

`src/sync.ts`（插件）/ `src/sync.mjs`（独立中继）维护两端 UI 状态并双向广播：

```
PC client 半边 ──POST /api/sync/pc-state──▶ SyncBridge ──SSE /m/api/sync──▶ 手机
手机 relay.html ──POST /m/api/sync/mobile-state──▶ SyncBridge ──SSE /api/sync──▶ PC
```

- PC 半边由 client 入口订阅 `ctx.sessions.list`（ObservableSnapshot），当前会话变化即上报
- 手机半边在切换会话 / 切模型 / 切权限 / 发消息时上报
- 两端都可通过 SSE 实时收到对方状态；同步流每 25s 推一次完整快照（兼做设备在线状态刷新）
- 手机端另有 `/m/api/sync/state` 轮询兜底，SSE 被阻断（如 QuickTunnel）时 30s 拉一次

### 离线补同步

`events.stream` 接受 `afterSeq` 参数：连接建立时先回放缓冲中该水位之后的事件（环形缓冲每会话 200 条），缺口自动回填 `session.history`（5s 冷却防抖）。手机端重连时用最新 `lastSeq` 重建 EventSource（带退避），SSE 连续失败 3 次自动降级轮询，轮询本身即增量拉取，两种模式都不丢事件。

### 事件中继

插件通过 WebSocket 连接 DSH 的 `events.mux`，接收所有会话事件，归一化为 `StreamItem` 后通过 SSE 推送给手机。支持：
- 实时流（SSE）：首选，低延迟
- 轮询降级：SSE 被阻断时自动切换
- 环形缓冲：每会话最多 200 条，自动淘汰
- 审批/提问表：`approval/requested` 和 `question/requested` 分通道处理

### RPC 代理

手机端通过 `/m/api/rpc` 或专用路由调用 DSH 的 `ApiProxy.callRpc()`，白名单限制可调方法：
- `workspace.list`、`session.list`、`session.create`
- `session.history`、`session.prompt`、`session.cancel`
- `session.models`、`session.selectModel`

## 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| 侧边栏无手机图标 | 确认插件已加载：`dsh plugin --profile web list` |
| QR 码地址是 127.0.0.1 | DSH 未绑定 0.0.0.0；用 `dsh web --host 0.0.0.0` 或设 `publicBaseUrl` |
| 手机扫码后配对失败 | token 已过期（5 分钟）；刷新 QR 码 |
| 流式不实时 | Cloudflare QuickTunnel 不转发 SSE——换 Tailscale 或持久隧道 |
| Agent 提问无响应 | 确认手机打开了会话页（SSE 在线） |
| 工具结果为空 | DSH 版本字段差异；检查 `tool/result` 双层嵌套 |
| 手机看不到「电脑正在查看」提示条 | PC 端 DSH 主界面当前没有打开任何会话；或插件 client 半边未加载（`dsh plugin --profile web list` 确认） |
| 手机离线期间的消息没补上 | 断线超过环形缓冲上限（200 条）后需回填 history；确认手机端网络恢复后 EventSource 已重连（顶栏圆点为绿色） |

## License

MIT
