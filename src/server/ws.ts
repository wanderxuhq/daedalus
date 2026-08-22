import type { HttpServer } from './http.ts';
import type { CoreEvent } from '../core/events.ts';
import type { EventHub, SubagentTracked } from './event-hub.ts';
import type { DaedalusEngine } from '../core/engine.ts';
import type { WebPermissionManager } from './permission.ts';

export interface SnapshotPayload {
  messages: unknown[];
  subagents: SubagentTracked[];
  running: boolean;
  log: CoreEvent[];
  pendingPermission: { id: string; action: string; target: string } | null;
}

/** 终止本轮的事件：收到后清空 in-flight 日志，并撤下全部挂起权限。 */
const TERMINALS: ReadonlySet<CoreEvent['type']> = new Set(['done', 'error']);

/** WebSocket 枢纽：连接即发快照；广播全部 CoreEvent；权限请求/响应转发。 */
export class WebSocketHub {
  private engine: Pick<DaedalusEngine, 'getSessionState' | 'listSubagents' | 'getSubagentMessages'>;
  private hub: EventHub;
  private permission: WebPermissionManager;
  private log: CoreEvent[] = [];
  private clients = new Set<import('ws').WebSocket>();

  constructor(opts: {
    engine: Pick<DaedalusEngine, 'getSessionState' | 'listSubagents' | 'getSubagentMessages'>;
    hub: EventHub;
    permission: WebPermissionManager;
  }) {
    this.engine = opts.engine;
    this.hub = opts.hub;
    this.permission = opts.permission;
  }

  attach(http: HttpServer): void {
    http.ws('/api/ws', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'snapshot', ...this.snapshot() }));
      for (const ev of this.log) this.sendEvent(ws, ev);
      ws.on('message', (raw) => {
        let msg: { type?: string; id?: string; allow?: boolean; always?: boolean };
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'permission' && typeof msg.id === 'string' && typeof msg.allow === 'boolean') {
          this.permission.settle(msg.id, msg.allow, msg.always === true);
        }
      });
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  private snapshot(): SnapshotPayload {
    const running = !TERMINALS.has(this.log[this.log.length - 1]?.type ?? 'done');
    return {
      messages: this.engine.getSessionState().messages,
      subagents: this.hub.list(),
      running,
      log: [...this.log],
      pendingPermission: this.permission.pending(),
    };
  }

  private sendEvent(ws: import('ws').WebSocket, ev: CoreEvent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'event', ev }));
  }

  /** 向所有客户端广播任意消息（权限请求等非 CoreEvent 消息）。 */
  broadcast(msg: unknown): void {
    const raw = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(raw);
  }

  broadcastEvent(ev: CoreEvent): void {
    this.hub.handle(ev);
    if (TERMINALS.has(ev.type)) {
      this.log = [];
      this.permission.clearAll();
    } else {
      this.log.push(ev);
    }
    for (const c of this.clients) this.sendEvent(c, ev);
  }
}
