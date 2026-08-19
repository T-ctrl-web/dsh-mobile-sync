# DSH Mobile Sync — 手机远程控制 DeepSeek Harness

把 DSH 装进口袋——在手机上远程操作电脑上的 Agent：发消息、看流式回复、批准工具调用、回答 Agent 提问、切模型/权限、翻文件、跑终端命令。**PC 与手机双向实时同步**：一端切换会话/模型/操作，另一端实时可见、可互相跳转。

提供两种部署方式：**Cordis 插件**（推荐，原生集成进 DSH Web）和**独立中继**（零依赖，clone 即跑）。

> **兼容性**：适配 DSH `0.1.0-rc.7`（ApiProxy 结构化命名空间 API）。其他版本可能需微调 `src/dsh-client.ts` 的调用层。

---

## 架构

```
┌──────────────┐   扫码配对 / 局域网 / 隧道    ┌──────────────────────┐
│  手机浏览器   │ ────────────────────────────▶ │  DSH Web（0.0.0.0）   │
│  /m 移动端   │ ◀── SSE 流式 + Cookie 鉴权 ── │  Cordis 插件路由      │
│  relay.html  │                               │  事件中继 + ApiProxy  │
└──────────────┘                               └──────────────────────┘
```

插件是 DSH 的"内嵌翻译层"：对手机做 HTTP/SSE 服务端（`/m` 路径），对 DSH 内部通过 `ctx.apiProxy` 结构化 RPC + `events.mux` WebSocket 事件中继。

---

## 从 GitHub 部署到你的电脑（插件模式）

### 1. 前置条件

| 依赖 | 说明 |
|---|---|
| DeepSeek Harness | 已安装并跑通 `dsh web`（`npx @deepseek-ai/dsh web`） |
| Node.js | **22+** |
| pnpm | `npm i -g pnpm` |
| Git | 拉取代码 |

### 2. 拉取代码（建议放到独立目录）

```powershell
git clone https://github.com/T-ctrl-web/dsh-mobile-sync.git D:\DeepSeek-Harness\plugins\dsh-mobile-sync
```

### 3. 构建插件

```powershell
cd D:\DeepSeek-Harness\plugins\dsh-mobile-sync\packages\dsh-mobile-sync-plugin
pnpm install
pnpm build
```

构建产物在 `lib/`：
- `lib/index.js` — host 半边（路由 + 配对 + 事件中继 + ApiProxy 调用）
- `lib/client.js` — client 半边（侧边栏 UI + 双向同步上报）
- `lib/assets/relay.html` — 移动端页面

### 4. 安装到 DSH profile

```powershell
dsh plugin --profile web add file:D:\DeepSeek-Harness\plugins\dsh-mobile-sync\packages\dsh-mobile-sync-plugin
```

验证：`dsh plugin --profile web list` 应列出 `dsh-mobile-sync`。

### 5. 配置网络（让手机可达）

> ⚠️ **重要**：DSH 官方**禁止** `dsh web --host 0.0.0.0`（安全设计，会报错）。不要用 netsh portproxy 转发（会引入 IP Helper 抢占端口的问题）。正确做法是**通过 profile 配置让 webServer 监听所有网卡**：

编辑 `C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`，追加：

```yaml
# 让 dsh 监听所有网卡，手机/局域网可直接访问 3080
- id: webserver
  config:
    host: 0.0.0.0
    port: 3080
# mobile-sync 无需配置 publicBaseUrl：插件启动时自动检测当前局域网 IP 生成 QR 码
# （自动过滤 VMware/VirtualBox 等虚拟网卡，优先 WLAN/以太网；换网络无需手动改）
- id: mobile-sync
  config: {}
```

插件会自动检测当前局域网 IP 用于 QR 码，**换网络后重启 dsh web 即可，无需改配置**。（如需外网 URL——如隧道域名——再配置 `publicBaseUrl`，优先级高于自动检测。）

### 6. 重启 dsh web 并配对

1. 结束当前 dsh web 进程（`netstat -ano | findstr :3080` 查 PID → 任务管理器结束，或 `taskkill /F /PID <PID>`）
2. 重新启动：`node "C:\Users\<你>\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" web`
3. 电脑浏览器打开 `http://127.0.0.1:3080` → 侧边栏底部 **📱 图标** → 配对面板显示 QR 码
4. 手机连同一 WiFi → 扫码（或手动输 `http://<电脑IP>:3080/m/`）→ 自动配对 → 进入移动端

### 7. 防火墙

若手机连不上，放行 3080（管理员 PowerShell）：

```powershell
netsh advfirewall firewall add rule name="dsh-mobile" dir=in action=allow protocol=TCP localport=3080
```

---

## 功能清单

| 能力 | 说明 |
|---|---|
| 多轮对话 | 发消息、Markdown 渲染、流式打字机回复 |
| 双向实时同步 | PC ↔ 手机 UI 状态镜像：当前会话、模型、权限、最近操作两端实时可见、可互相跳转 |
| 离线补同步 | 手机断线重连后自动补齐错过的会话事件（环形缓冲回放 + 历史回填） |
| SSE 实时 | `events.mux` 事件流，打开会话即实时收事件（SSE 被阻断时自动降级 1.5s 轮询） |
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

## 外网远程（不同 WiFi）

> ⚠️ **以下所有外网方案均未经实测**（开发环境为同一局域网）。网络环境各不相同（运营商、防火墙、IPv6 支持等），**有条件请自行测试验证**后再用于生产环境。

> **国内（中国大陆）网络环境**：Tailscale 官网与 cloudflared 生成的 trycloudflare.com 域名通常无法访问。可用的替代方案：
> - **IPv6 直连**（零成本）：若宽带支持公网 IPv6，在管理员 PowerShell 执行 `netsh interface portproxy add v6tov4 listenport=3080 listenaddress=:: connectport=3080 connectaddress=127.0.0.1`，手机用 `http://[电脑IPv6地址]:3080/m/` 访问（需手机网络支持 IPv6，`ipconfig` 查 `2408:` 开头的地址）
> - **cpolar**（国内内网穿透）：官网下载 cpolar → `cpolar http 3080` → 得到 `.cpolar.top` 域名，手机任意网络访问（SSE 可能降级轮询）
> - **EasyTier**（国产组网，Tailscale 替代）：电脑与手机安装客户端并组网后直连

### Tailscale（海外/可访问环境推荐）

```powershell
# 电脑和手机各装 Tailscale，登录同一账号
tailscale serve 3080   # 电脑上执行：通过 tailnet 代理到本机 3080
# 手机访问：https://<电脑名>.<tailnet>.ts.net/m/
# 把 publicBaseUrl 配置为该 HTTPS 地址（配置后优先于自动检测的局域网 IP），QR 码自动使用
- id: mobile-sync
  config:
    publicBaseUrl: https://<电脑名>.<tailnet>.ts.net
```

### Cloudflare Tunnel

```powershell
cloudflared tunnel --url http://127.0.0.1:3080
# 打印: https://xxxx.trycloudflare.com
# 设置 publicBaseUrl 为该 URL
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

## 独立中继（零依赖，可选）

不依赖 DSH 插件系统，clone 即跑。适合快速测试或不支持插件的环境。

```powershell
cd dsh-mobile-sync
Copy-Item config.example.json config.json   # 修改 token
node agent.mjs                               # 启动中继（端口 8788）
```

手机访问 `http://<电脑IP>:8788/` → 输入 token → 连接。（此模式无 PC 端双向镜像，只有手机侧功能。）

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
| GET | `/m/` | 移动端页面（自动探测配对，无需手动登录） |
| GET | `/m/pair?token=` | 配对中转页 |
| GET | `/m/api/sync` | 手机端同步状态 SSE（推送 PC 状态 + 设备列表） |
| GET | `/m/api/sync/state` | 手机端同步状态快照（轮询兜底） |
| POST | `/m/api/sync/mobile-state` | 手机端上报当前会话/模型/权限/最近操作 |
| GET | `/m/api/workspaces` | 工作区列表 |
| GET/POST | `/m/api/sessions` | 会话列表 / 新建会话 |
| GET | `/m/api/sessions/:id/history` | 对话历史 |
| POST | `/m/api/sessions/:id/prompt` | 发消息 |
| POST | `/m/api/sessions/:id/cancel` | 取消当前轮 |
| GET/POST | `/m/api/sessions/:id/model` | 获取/切换模型 |
| POST | `/m/api/sessions/:id/permission` | 切权限模式 |
| GET | `/m/api/sessions/:id/events?afterSeq=` | 轮询事件增量 |
| GET | `/m/api/sessions/:id/events.stream?afterSeq=` | SSE 实时流（连接时回放离线事件） |
| GET | `/m/api/pending` | 待审批/提问列表 |
| POST | `/m/api/approvals/:id` | 审批响应 |
| POST | `/m/api/questions/:id` | 提问回答 |
| POST | `/m/api/terminal` | 远程终端 |
| GET | `/m/api/files?path=` | 目录浏览 |
| GET | `/m/api/file?path=` | 读文件 |
| POST | `/m/api/heartbeat` | 心跳保活 |

`/m/api/*` 路由需配对 Cookie 鉴权；`/api/pair/*` 与 `/api/sync*` 仅限 loopback。

## 插件配置

通过 `cordis.patch.yml` 的 `config` 段配置（profile 层）：

```yaml
- id: mobile-sync
  config:
    mobileEnterToSend: true      # 手机端 Enter 发送（false 则换行）
    requirePairingForLan: true   # 非环回请求需配对
    # publicBaseUrl 可选：默认自动检测当前局域网 IP 生成 QR；仅外网（隧道/反代）时配置
    # publicBaseUrl: https://xxx.trycloudflare.com
```

## 测试状态说明

> 以下为当前项目的**真实测试状态**，请据此评估使用风险。

**✅ 已验证（局域网环境，Windows + DSH 0.1.0-rc.7）**
- 插件构建、安装、加载（`dsh plugin add` / 侧边栏手机图标）
- 手机扫码配对 + Cookie 鉴权（未配对 403）
- 会话列表 / 工作区列表 / 对话历史 / 模型列表 / 事件增量回放
- 双向同步桥（PC 端当前会话实时上报手机端）
- 0.0.0.0 监听下局域网手机直连

**⚠️ 未经真机完整验证（有条件请自行测试）**
- 发消息 / 流式回复、审批卡片、提问卡片、工具卡片（API 层可用，未在真实手机上跑通完整交互）
- 模型切换（含 provider 解析）、权限模式切换、终端、文件浏览
- 离线补同步的真实断线重连场景
- 外网访问（Tailscale / Cloudflare / cpolar / IPv6 直连等全部方案）
- 非 Windows 平台（macOS / Linux）与 DSH 其他版本

如发现问题欢迎提 Issue 或 PR。

## 安全说明

- QR 码含一次性 token，5 分钟有效，接受后不可重用
- 配对成功后设备获 HttpOnly Cookie（7 天有效），90 秒无心跳判离线
- 手机端 API 白名单：仅暴露会话/工作区/模型操作，不含 settings/credentials
- 非环回请求需配对（可配置关闭）
- 公网建议经 Tailscale 私有网络或 HTTPS 反代

## 项目结构

```
dsh-mobile-sync/
├── packages/
│   └── dsh-mobile-sync-plugin/        # Cordis 插件
│       ├── src/
│       │   ├── index.ts               # host 入口（路由 + 配对 + 事件中继 + 同步桥装配）
│       │   ├── config.ts              # 配置 schema
│       │   ├── pairing.ts             # QR 配对服务
│       │   ├── sync.ts                # 双向同步桥（PC ↔ 手机 UI 状态镜像）
│       │   ├── dsh-client.ts          # DSH ApiProxy 结构化调用 + 事件/历史归一化
│       │   ├── event-store.ts          # events.mux 中继 + 环形缓冲 + 待审批表
│       │   ├── http-utils.ts          # HTTP/SSE 工具函数
│       │   ├── routes.ts               # 全部路由（配对 + 同步 + 移动端 API + 静态页）
│       │   └── client/                # 浏览器半边
│       │       ├── index.ts           # 侧边栏 UI 注入 + PC 会话监听上报
│       │       ├── bridge.ts          # client 半边与同步桥的通信层
│       │       └── FooterRemoteEntry.tsx # 侧边栏手机图标 + 配对/同步面板
│       ├── assets/relay.html          # 移动端单文件前端（含双向同步）
│       ├── cordis.patch.yml           # 插件注册（dsh.bundle 声明）
│       ├── package.json               # 含 dsh.bundle + dsh.client 声明
│       └── tsconfig.json / tsdown.config.ts
├── agent.mjs                          # 独立中继（零依赖）
├── src/                               # 独立中继源码（server/event-store/dsh-client/config/sync）
├── web/relay.html                     # 独立中继用的移动端页面（与插件版同步）
├── config.example.json
└── README.md
```

## 技术细节

### ApiProxy 适配（DSH 0.1.0-rc.7）

插件通过 `ctx.apiProxy` 结构化命名空间调用 DSH 业务 API（**不是** `callRpc`）：

```
'session.list'      → apiProxy.sessions.list({rpcId, payload})
'session.history'   → apiProxy.sessions.history({rpcId, payload})
'session.prompt'    → apiProxy.sessions.prompt({rpcId, payload})
'session.selectModel' → apiProxy.sessions.selectModel({rpcId, payload})  // 需 provider + model
'workspace.list'    → apiProxy.workspace.list({rpcId, payload})
```

- 内部统一 `session.*` 单数命名，`fetchRpc` 自动映射到复数 `sessions` 命名空间
- `selectModel` 自动从模型目录解析 model id 对应的 provider
- 路由规范：`WebRoute.path` **不允许尾部斜杠**（`/m/api/sessions` 而非 `/m/api/sessions/`）

### 双向同步桥（SyncBridge）

```
PC client 半边 ──POST /api/sync/pc-state──▶ SyncBridge ──SSE /m/api/sync──▶ 手机
手机 relay.html ──POST /m/api/sync/mobile-state──▶ SyncBridge ──SSE /api/sync──▶ PC
```

- PC 半边由 client 入口订阅 `ctx.sessions.list`（ObservableSnapshot），当前会话变化即上报
- 手机半边在切换会话 / 切模型 / 切权限 / 发消息时上报
- 两端都可通过 SSE 实时收到对方状态；同步流每 25s 推一次完整快照（兼做设备在线状态刷新）
- 手机端另有 `/m/api/sync/state` 轮询兜底，SSE 被阻断时 30s 拉一次

### 离线补同步

`events.stream` 接受 `afterSeq` 参数：连接建立时先回放缓冲中该水位之后的事件（环形缓冲每会话 200 条），缺口自动回填 `session.history`（5s 冷却防抖）。手机端重连时用最新 `lastSeq` 重建 EventSource（带退避），SSE 连续失败 3 次自动降级轮询，轮询本身即增量拉取，两种模式都不丢事件。

### 移动端双模式

`relay.html` 同时服务两种部署：
- **独立中继**：登录页填服务器地址 + token（Bearer/query 鉴权）
- **插件模式**：页面自动探测 `/m/api/workspaces`（同源 Cookie），配对后直接进入，无需登录；API 路径自动补 `/m` 前缀（`/api/x` → `/m/api/x`）

## 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| 侧边栏无手机图标 | 确认插件已加载：`dsh plugin --profile web list` |
| 启动报 `declares no dsh.bundle` | 插件 package.json 缺 `dsh.bundle.patch` 声明；重新 `dsh plugin add` 后重启 |
| 启动报 `EADDRINUSE` | 旧 dsh web 未杀干净：`netstat -ano \| findstr :3080` 查 PID → `taskkill /F /PID <PID>` → 等 2 秒再启动 |
| `--host 0.0.0.0` 报错被拒 | DSH 安全禁止 CLI 绑定；改用 profile 配置 `webserver.config.host: 0.0.0.0`（见上文） |
| 手机连不上 3080 | 防火墙放行：`netsh advfirewall firewall add rule name="dsh-mobile" dir=in action=allow protocol=TCP localport=3080` |
| QR 码地址是 127.0.0.1 | 插件未自动检测到局域网 IP（无物理网卡）或 dsh 未监听 0.0.0.0；确认 `webserver.config.host: 0.0.0.0` 已配置并重启 |
| 换网络后手机连不上 | IP 已变化属正常：重启 dsh web 后重新扫码（QR 码自动使用新 IP，无需改配置） |
| 手机显示「非 JSON 响应」 | 插件未重启 / 路由未匹配：确认 `/m/api/workspaces` 返回 JSON；检查是否走了独立中继路径 |
| 手机扫码后配对失败 | token 已过期（5 分钟）；刷新 QR 码 |
| 流式不实时 | Cloudflare QuickTunnel 不转发 SSE——换 Tailscale 或持久隧道 |
| Agent 提问无响应 | 确认手机打开了会话页（SSE 在线） |
| 工具结果为空 | DSH 版本字段差异；检查 `tool/result` 双层嵌套 |
| 手机看不到「电脑正在查看」提示条 | PC 端 DSH 主界面当前没有打开任何会话；或插件 client 半边未加载 |
| 手机离线期间的消息没补上 | 断线超过环形缓冲上限（200 条）后需回填 history；确认手机端网络恢复后 EventSource 已重连（顶栏圆点为绿色） |

## 开发

```powershell
cd packages/dsh-mobile-sync-plugin
pnpm dev        # tsc --watch 类型检查
pnpm build      # tsc 检查 + tsdown 打包 + client 包装
```

## License

MIT
