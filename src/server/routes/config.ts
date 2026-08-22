import type { HttpServer } from '../http.ts';
import { HttpError } from '../http-error.ts';
import type { DaedalusEngine } from '../../core/engine.ts';

export function registerConfigRoutes(http: HttpServer, engine: DaedalusEngine): void {
  http.get('/api/config', async () => ({
    model: engine.getModel() ?? null,
    autoApprove: engine.getAutoApprove(),
    planMode: engine.getPlanMode(),
  }));

  http.put('/api/config', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const b = body as { model?: unknown; autoApprove?: unknown; planMode?: unknown };
    if (b.model !== undefined) {
      if (typeof b.model !== 'string') throw new HttpError(400, 'model must be string');
      engine.setModel(b.model);
    }
    if (b.autoApprove !== undefined) {
      if (typeof b.autoApprove !== 'boolean') throw new HttpError(400, 'autoApprove must be boolean');
      engine.setAutoApprove(b.autoApprove);
    }
    if (b.planMode !== undefined) {
      if (typeof b.planMode !== 'boolean') throw new HttpError(400, 'planMode must be boolean');
      engine.setPlanMode(b.planMode);
    }
    return { ok: true };
  });

  http.get('/api/state', async () => ({
    messages: engine.getSessionState().messages,
    subagents: engine.listSubagents(),
    config: {
      model: engine.getModel() ?? null,
      autoApprove: engine.getAutoApprove(),
      planMode: engine.getPlanMode(),
    },
  }));
}
