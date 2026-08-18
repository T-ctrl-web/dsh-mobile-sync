// src/config.mjs —— 配置解析（config.json + 环境变量）
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let raw = '{}';
try {
  const cfgPath = path.join(ROOT, 'config.json');
  if (existsSync(cfgPath)) raw = readFileSync(cfgPath, 'utf8');
} catch { /* 配置文件缺失/损坏 → 用默认值 */ }
const cfg = JSON.parse(raw || '{}');

// 环境变量优先级高于 config.json
export const PORT = Number(process.env.PORT || cfg.port || 8788);
export const TOKEN = String(process.env.DSH_RELAY_TOKEN || cfg.token || '');
export const DSH_BASE = String(process.env.DSH_WEB_API_BASE || cfg.dshBaseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
export const DEFAULT_CWD = String(cfg.workspace || process.cwd());
export const ALLOW_INTERNET = cfg.allowInternet !== false && process.env.DSH_RELAY_LAN !== '0';
export const VERSION = '1.0.0';

// 解析命令行 --mode / --port
export function parseArgs(argv) {
  const args = { mode: 'lan', port: PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode' && argv[i + 1]) args.mode = argv[++i];
    else if (a.startsWith('--mode=')) args.mode = a.slice(7);
    else if (a === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7));
  }
  return args;
}
