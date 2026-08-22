import { HttpServer } from './http.ts';
import { EventHub } from './event-hub.ts';
import { WebSocketHub } from './ws.ts';
import { WebPermissionManager } from './permission.ts';
import { registerAll } from './routes/index.ts';
import { staticDirFor, lanIPv4 } from './static.ts';
import type { DaedalusEngine } from '../core/engine.ts';
import type { SessionStore } from '../core/session-store.ts';

export interface ServerDeps {
  engine: DaedalusEngine;
  store: SessionStore;
  staticDir?: string;
}

/** 装配 engine + ws + 路由；返回可 listen/close 的服务（测试友好）。 */
export function buildServer(deps: ServerDeps): {
  http: HttpServer;
  engine: DaedalusEngine;
  hub: WebSocketHub;
  permission: WebPermissionManager;
  listen(port: number, host: string): Promise<void>;
  address(): ReturnType<HttpServer['address']>;
  close(): Promise<void>;
} {
  const http = new HttpServer({ staticDir: deps.staticDir ?? staticDirFor(import.meta.url) });
  const hub = new EventHub();
  const permission = new WebPermissionManager(deps.engine);
  const wsHub = new WebSocketHub({ engine: deps.engine, hub, permission });
  wsHub.attach(http);
  registerAll(http, { engine: deps.engine, store: deps.store, hub: wsHub });

  // 引擎事件 → ws 广播；引擎权限 → web 审批。
  deps.engine.subscribe((ev) => wsHub.broadcastEvent(ev));
  deps.engine.setAskPermission(permission.ask);
  permission.setBroadcast((msg) => wsHub.broadcast(msg));

  return {
    http,
    engine: deps.engine,
    hub: wsHub,
    permission,
    listen: (port, host) => http.listen(port, host),
    address: () => http.address(),
    // 装配即测（未 listen）时 http.close() 会抛 ERR_SERVER_NOT_RUNNING —— 吞掉它，
    // 让只做装配断言的测试也能干净收尾。
    close: () => http.close().catch((e: NodeJS.ErrnoException) => {
      if (e?.code !== 'ERR_SERVER_NOT_RUNNING') throw e;
    }),
  };
}

export async function main(argv: string[]): Promise<void> {
  let port = Number(process.env.DAEDALUS_WEB_PORT ?? 3100);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      const raw = argv[++i];
      if (!raw || !/^\d+$/.test(raw)) throw new Error('invalid --port');
      port = Number(raw);
    }
  }
  // 复用 CLI 的 config 装配：provider/model/apiKey/baseURL → client
  const { loadConfig } = await import('../config/config.ts');
  const { createAiClient } = await import('../ai/index.ts');
  const base = loadConfig();
  const client = createAiClient({
    provider: base.provider as 'openai' | 'anthropic',
    apiKey: base.apiKey,
    baseURL: base.baseURL,
    model: base.model,
  });
  const { DaedalusEngine } = await import('../core/engine.ts');
  const { SessionStore } = await import('../core/session-store.ts');
  const store = new SessionStore();
  const engine = new DaedalusEngine({
    client,
    cwd: process.cwd(),
    sessionStore: store,
    model: base.model,
    thinking: base.thinking,
    thinkingBudgetTokens: base.thinkingBudgetTokens,
    ...(base.hooks ? { hooks: base.hooks } : {}),
  });
  const srv = buildServer({ engine, store });

  const shutdown = async () => {
    srv.http.close();
    await engine.dispose();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await srv.listen(port, '0.0.0.0');
  console.log(`daedalus web started: http://localhost:${port}`);
  const lan = lanIPv4();
  if (lan) console.log(`LAN access: http://${lan}:${port}`);
  console.log(`Sessions: ${store.dir}`);
}

// 直接运行时（node src/server/server.ts / dist/server/server.js）启动；被 import（测试）时不执行。
// 复制 anther cli.ts 的守卫。
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
