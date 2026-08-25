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

/** Assemble engine + ws + routes; return a service that can listen/close (test-friendly). */
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
  const permission = new WebPermissionManager({ engine: deps.engine });
  const wsHub = new WebSocketHub({ engine: deps.engine, hub, permission });
  wsHub.attach(http);
  registerAll(http, { engine: deps.engine, store: deps.store, hub: wsHub });

  // Engine events → ws broadcast; engine permissions → web approval.
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
    // When testing assembly without listening, http.close() throws ERR_SERVER_NOT_RUNNING — swallow it,
    // so tests that only assert assembly can still exit cleanly.
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
  // Reuse CLI config assembly: provider/model/apiKey/baseURL → client
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
    await srv.http.close();
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

// When run directly (node src/server/server.ts / dist/server/server.js), start the server; when imported (tests), skip execution.
// Guard copied from anther cli.ts.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
