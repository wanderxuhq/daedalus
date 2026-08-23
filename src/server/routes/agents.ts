import type { HttpServer } from '../http.ts';
import { HttpError } from '../http-error.ts';
import type { DaedalusEngine } from '../../core/engine.ts';
import type { WebSocketHub } from '../ws.ts';

export function registerAgentRoutes(http: HttpServer, engine: DaedalusEngine, hub: WebSocketHub): void {
  http.get('/api/agents', async () => ({ agents: engine.listSubagents() }));

  http.get('/api/agents/messages', async (_req, _body, query) => {
    const name = query.get('name');
    if (!name) throw new HttpError(400, 'name required');
    return { messages: engine.getSubagentMessages(name) };
  });

  http.post('/api/agents/close', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const name = (body as { name?: unknown }).name;
    if (typeof name !== 'string') throw new HttpError(400, 'name required');
    engine.closeSubagent(name);
    // 关闭子代理后：推送 snapshot，确保面板实时移除该条目
    hub.broadcastSnapshot();
    return { ok: true };
  });

  /** POST /api/agents/chat — inject a user message into a subagent's session. */
  http.post('/api/agents/chat', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const { name, prompt } = body as { name?: unknown; prompt?: unknown };
    if (typeof name !== 'string' || !name) throw new HttpError(400, 'name required');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'prompt required');
    engine.injectSubagentMessage(name, prompt);
    return { status: 'ok' };
  });

undefined
}
