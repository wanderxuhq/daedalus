import type { HttpServer } from '../http.ts';
import { HttpError } from '../http-error.ts';
import type { DaedalusEngine } from '../../core/engine.ts';
import type { WebSocketHub } from '../ws.ts';

/** POST /api/chat — 一次一轮 engine.run；事件经 ws 推给浏览器。运行中拒绝（409）。 */
export function registerChatRoutes(http: HttpServer, engine: DaedalusEngine, hub: WebSocketHub): void {
  // 与 brief 的偏差：brief 的代码片段没有并发守卫，但计划约束要求“运行中拒绝（409）”
  // 且 brief 自己的测试（第二条）断言第二个并发 POST 得到 409。最小修复：路由闭包内
  // 维护 in-flight 标志。其余代码与 brief 逐字一致。
  let inFlight = false;
  http.post('/api/chat', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const prompt = (body as { prompt?: unknown }).prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'missing prompt');
    if (inFlight) throw new HttpError(409, 'a run is already in progress');
    inFlight = true;
    try {
      const result = await engine.run(prompt);
      return { status: 'ok', result };
    } catch (e) {
      const err = e as { message: string; status?: number };
      throw new HttpError(err.status ?? 500, err.message);
    } finally {
      inFlight = false;
    }
  });
  // 引擎事件 → ws 广播（在 server.ts 装配 engine.subscribe 时接，chat 路由只管 run）
}
