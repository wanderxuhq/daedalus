// src/server/http.ts
// 从 anther server/http.ts 移植：精确路径路由、静态 + SPA fallback、ws。
// SSE 分支按 daedalus 计划删除（daedalus 只用 ws）。导入后缀改为 .ts；
// 参数属性改为显式字段（erasableSyntaxOnly）。
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { HttpError } from './http-error.ts';

export type Handler = (
  req: IncomingMessage,
  body: unknown,
  query: URLSearchParams,
) => Promise<unknown> | unknown;

export type WsHandler = (
  ws: WebSocket,
  req: IncomingMessage,
  query: URLSearchParams,
) => void | Promise<void>;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export class HttpServer {
  private routes = new Map<string, Map<string, Handler>>();
  private wsRoutes = new Map<string, WsHandler>();
  private wss = new WebSocketServer({ noServer: true });
  private server = createServer((req, res) => void this.handle(req, res));
  private staticDir: string;

  constructor(opts: { staticDir: string }) {
    this.staticDir = opts.staticDir;
    // async 守卫：handler 是 void|Promise<void>，.catch 无法直接挂（void 无 .catch）；
    // 用 async 回调 + try/catch，出错时 console.error 并关闭连接。
    this.wss.on('connection', async (ws, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const h = this.wsRoutes.get(url.pathname);
      try {
        if (h) await h(ws, req, url.searchParams);
        else ws.close();
      } catch (e) {
        console.error(`ws handler ${url.pathname}:`, e);
        ws.close();
      }
    });
    this.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!this.wsRoutes.has(url.pathname)) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  get(pattern: string, h: Handler) { this.add('GET', pattern, h); }
  put(pattern: string, h: Handler) { this.add('PUT', pattern, h); }
  post(pattern: string, h: Handler) { this.add('POST', pattern, h); }

  ws(pattern: string, h: WsHandler) { this.wsRoutes.set(pattern, h); }

  private add(method: string, pattern: string, h: Handler) {
    if (!this.routes.has(method)) this.routes.set(method, new Map());
    this.routes.get(method)!.set(pattern, h);
  }

  async listen(port: number, host: string) {
    return new Promise<void>((resolve) => this.server.listen(port, host, resolve));
  }
  close() {
    for (const c of this.wss.clients) c.close();
    this.wss.close();
    return new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }
  address() { return this.server.address(); }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // HEAD 与 GET 同走静态服务（curl -I、链接预览工具会发 HEAD；无 body 响应）
      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        await this.serveStatic(url.pathname, res, req.method === 'HEAD');
        return;
      }
      const handler = this.routes.get(req.method ?? '')?.get(url.pathname);
      if (!handler) throw new HttpError(404, 'not found');
      const body = await readBody(req);
      const result = await handler(req, body, url.searchParams);
      res.json(result ?? { ok: true });
    } catch (e: unknown) {
      if (e instanceof HttpError) {
        res.json({ error: e.message }, e.status);
      } else {
        res.json({ error: 'internal error' }, 500);
      }
    }
  }

  /** 静态资源 + SPA fallback：存在则返回文件，否则返回 index.html；headOnly 时只发头不发 body */
  private async serveStatic(urlPath: string, res: ServerResponse, headOnly = false) {
    let rel: string;
    try {
      rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
    } catch {
      // %zz 等畸形编码 decodeURIComponent 抛 URIError → 400 而非 500
      throw new HttpError(400, 'bad path');
    }
    const abs = path.resolve(this.staticDir, rel);
    if (!abs.startsWith(path.resolve(this.staticDir) + path.sep) && rel !== 'index.html') {
      throw new HttpError(400, 'bad path');
    }
    // Content-Type 按实际读取到的文件决定：fallback 分支返回的是 index.html，
    // 若用请求路径的扩展名（如 .ts）会落到 application/octet-stream → 浏览器把
    // 应用页面当成文件下载
    let content: Buffer;
    let ext: string;
    try {
      content = await readFile(abs);
      ext = path.extname(abs);
    } catch {
      // SPA fallback：任意路径都回 index.html
      content = await readFile(path.join(this.staticDir, 'index.html'));
      ext = '.html';
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': content.length,
    });
    res.end(headOnly ? undefined : content);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}
