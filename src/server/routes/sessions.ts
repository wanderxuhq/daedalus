import type { HttpServer } from '../http.ts';
import { HttpError } from '../http-error.ts';
import type { DaedalusEngine } from '../../core/engine.ts';
import type { SessionStore } from '../../core/session-store.ts';
import type { WebSocketHub } from '../ws.ts';

export function registerSessionRoutes(http: HttpServer, engine: DaedalusEngine, store: SessionStore, hub: WebSocketHub): void {
  http.get('/api/sessions', async () => ({ sessions: await store.list() }));

  http.post('/api/sessions', async (_req, body) => {
    const id = (body as { id?: unknown })?.id;
    if (id !== undefined && typeof id !== 'string') throw new HttpError(400, 'invalid id');
    if (typeof id === 'string') {
      const meta = await engine.resume(id);
      // 会话恢复后：重置 EventHub 并推送 snapshot，确保 UI 实时更新
      hub.resetHub();
      hub.broadcastSnapshot();
      return { resumed: meta.id };
    }
    const cleared = engine.clearConversation();
    // 新建会话后：重置 EventHub 并推送 snapshot，确保 UI 实时更新
    hub.resetHub();
    hub.broadcastSnapshot();
    return { cleared };
  });

  http.put('/api/sessions/rename', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const { id, title } = body as { id?: unknown; title?: unknown };
    if (typeof id !== 'string' || typeof title !== 'string') throw new HttpError(400, 'id and title required');
    await store.rename(id, title);
    return { ok: true };
  });

  http.post('/api/sessions/delete', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const id = (body as { id?: unknown }).id;
    if (typeof id !== 'string') throw new HttpError(400, 'id required');
    await store.remove(id);
    return { ok: true };
  });
}
