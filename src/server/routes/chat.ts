import type { HttpServer } from '../http.ts';
import { HttpError } from '../http-error.ts';
import type { DaedalusEngine } from '../../core/engine.ts';
import type { WebSocketHub } from '../ws.ts';

/** POST /api/chat — one engine.run per request; events pushed to browser via ws. Rejects (409) while running. */
export function registerChatRoutes(http: HttpServer, engine: DaedalusEngine, hub: WebSocketHub): void {
  // Deviation from brief: the brief code snippet lacks a concurrency guard, but the plan constraint requires
  // rejecting (409) while running, and the brief's own test (second case) asserts the second concurrent POST
  // gets a 409. Minimal fix: maintain an in-flight flag in the route closure. Rest of code is verbatim with brief.
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
  // Engine events → ws broadcast (wired in server.ts via engine.subscribe; chat route only handles run)
}
