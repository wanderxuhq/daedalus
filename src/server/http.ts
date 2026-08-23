// src/server/http.ts
// Ported from anther server/http.ts: exact-path routing, static + SPA fallback, ws.
// SSE branch removed per daedalus plan (daedalus uses ws only). Import suffix changed to .ts;
// parameter properties changed to explicit fields (erasableSyntaxOnly).
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
    // Async guard: handler is void|Promise<void>, .catch can't be attached directly (void has no .catch);
    // use async callback + try/catch, console.error on failure and close the connection.
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
      // HEAD and GET both serve static files (curl -I, link preview tools send HEAD; response has no body)
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

  /** Static assets + SPA fallback: return file if it exists, otherwise index.html; headOnly sends headers only. */
  private async serveStatic(urlPath: string, res: ServerResponse, headOnly = false) {
    let rel: string;
    try {
      rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
    } catch {
      // Malformed encodings like %zz cause decodeURIComponent to throw URIError → 400 instead of 500
      throw new HttpError(400, 'bad path');
    }
    const abs = path.resolve(this.staticDir, rel);
    if (!abs.startsWith(path.resolve(this.staticDir) + path.sep) && rel !== 'index.html') {
      throw new HttpError(400, 'bad path');
    }
    // Content-Type is determined by the actual file read: fallback returns index.html,
    // using the request path's extension (e.g. .ts) would yield application/octet-stream → browser
    // downloads the app page as a file
    let content: Buffer;
    let ext: string;
    try {
      content = await readFile(abs);
      ext = path.extname(abs);
    } catch {
      // SPA fallback: return index.html for any path
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
