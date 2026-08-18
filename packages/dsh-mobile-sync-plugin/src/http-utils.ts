// src/http-utils.ts —— 原生 node:http 工具函数（Cordis handler 直接拿到 IncomingMessage/ServerResponse）
import type { IncomingMessage, ServerResponse } from 'node:http';

export function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method !== method) {
    writeJson(res, 405, { error: `仅支持 ${method}` });
    return false;
  }
  return true;
}

export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c: Buffer) => {
      buf += c.toString();
      if (buf.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

export function writeJson(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function writeStatic(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'content-type': type + '; charset=utf-8',
    'cache-control': 'no-cache',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

export interface SSEStream {
  res: ServerResponse;
  closed: boolean;
}

export function openSSE(res: ServerResponse): SSEStream {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const stream: SSEStream = { res, closed: false };
  res.on('close', () => { stream.closed = true; });
  return stream;
}

export function pushSSE(stream: SSEStream, event: string, data: unknown): void {
  if (stream.closed) return;
  try {
    stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* 连接已断 */ }
}
