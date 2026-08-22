import type { HttpServer } from '../http.ts';
import type { DaedalusEngine } from '../../core/engine.ts';
import type { SessionStore } from '../../core/session-store.ts';
import type { WebSocketHub } from '../ws.ts';
import { registerChatRoutes } from './chat.ts';
import { registerSessionRoutes } from './sessions.ts';
import { registerAgentRoutes } from './agents.ts';
import { registerConfigRoutes } from './config.ts';

export interface RouteDeps {
  engine: DaedalusEngine;
  store: SessionStore;
  hub: WebSocketHub;
}

export function registerAll(http: HttpServer, deps: RouteDeps): void {
  registerChatRoutes(http, deps.engine, deps.hub);
  registerSessionRoutes(http, deps.engine, deps.store);
  registerAgentRoutes(http, deps.engine);
  registerConfigRoutes(http, deps.engine);
}
