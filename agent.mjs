// agent.mjs —— DSH 手机远程中继入口
// 启动：1) 事件中继（连 DSH events.mux） 2) HTTP/SSE 服务端（供手机访问）
// 用法：node agent.mjs [--mode=lan] [--port=8788]
// 前置：电脑已运行 dsh web（默认监听 127.0.0.1:3080）
import { createServer } from './src/server.mjs';
import { createEventStore } from './src/event-store.mjs';
import { PORT, TOKEN, DSH_BASE, ALLOW_INTERNET, VERSION, parseArgs } from './src/config.mjs';
import { execSync } from 'node:child_process';
import os from 'node:os';

const args = parseArgs(process.argv.slice(2));

function localIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push({ name, address: n.address });
    }
  }
  return ips;
}

async function main() {
  console.log(`\n  DSH 手机远程中继 v${VERSION}`);
  console.log('  ───────────────────────────────────────');
  console.log(`  DSH 网关: ${DSH_BASE}`);
  if (!TOKEN) console.log('  ⚠  未设置 token，手机端无需鉴权（仅限受信网络）');
  else console.log(`  访问令牌: ${TOKEN}`);

  // 1) 启动事件中继（连 DSH events.mux）
  const eventStore = createEventStore();
  eventStore.start();
  console.log('  事件中继: 已连接 DSH events.mux（审批/提问/会话事件）');

  // 2) 启动 HTTP/SSE 服务端
  const { server, host, port } = createServer(eventStore);
  await new Promise((r) => server.listen(args.port || port, host, r));

  console.log('  ───────────────────────────────────────');
  if (ALLOW_INTERNET) {
    const ips = localIPs();
    for (const ip of ips) console.log(`  局域网访问: http://${ip.address}:${args.port || port}/  (${ip.name})`);
    if (!ips.length) console.log('  未发现局域网 IPv4，请检查网络');
  } else {
    console.log(`  本机访问: http://127.0.0.1:${args.port || port}/`);
  }
  console.log('\n  手机端：用手机浏览器打开上面的局域网地址，输入 token 即可远程操作 dsh');
  console.log('  外网远程：参考 README 的 Cloudflare 隧道 / Tailscale 方案\n');

  // 优雅退出
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.log('\n  正在关闭…'); eventStore.stop(); server.close(); process.exit(0); });
  }
}

main().catch((e) => { console.error('启动失败:', e); process.exit(1); });
