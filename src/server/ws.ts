import type { HttpServer } from './http.ts';
import type { CoreEvent } from '../core/events.ts';
import { TERMINALS } from '../core/events.ts';
import type { EventHub } from './event-hub.ts';
import type { SubagentInfo } from '../core/events.ts';
import type { DaedalusEngine } from '../core/engine.ts';
import type { WebPermissionManager } from './permission.ts';

export interface SnapshotPayload {
  messages: unknown[];
  subagents: SubagentInfo[];
  running: boolean;
  log: CoreEvent[];
  pendingPermission: { id: string; action: string; target: string } | null;
  error: string | null;
  cwd: string;
}

/** WebSocket hub: sends snapshot on connect; broadcasts all CoreEvents; forwards permission requests/responses. */
export class WebSocketHub {
  private engine: Pick<DaedalusEngine, 'getSessionState' | 'listSubagents' | 'getSubagentMessages' | 'getCwd'>;
  private hub: EventHub;
  private permission: WebPermissionManager;
  private log: CoreEvent[] = [];
  private clients = new Set<import('ws').WebSocket>();
  /** Last error message (for snapshot; cleared on new session_start). */
  private lastError: string | null = null;
  /** Interval in ms between heartbeat pings sent to each client. */
  private pingInterval: number;
  /** Time in ms to wait for a pong response before closing a dead connection. */
  private pingTimeout: number;

  constructor(opts: {
    engine: Pick<DaedalusEngine, 'getSessionState' | 'listSubagents' | 'getSubagentMessages' | 'getCwd'>;
    hub: EventHub;
    permission: WebPermissionManager;
    pingInterval?: number;
    pingTimeout?: number;
  }) {
    this.engine = opts.engine;
    this.hub = opts.hub;
    this.permission = opts.permission;
    this.pingInterval = opts.pingInterval ?? 30_000;
    this.pingTimeout = opts.pingTimeout ?? 10_000;
  }

  attach(http: HttpServer): void {
    http.ws('/api/ws', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'snapshot', ...this.snapshot() }));

      // Silently swallow errors; the close event handles cleanup.
      ws.on('error', () => {});

      // Heartbeat: periodic ping + pong timeout
      let alive = true;
      let pongTimer: ReturnType<typeof setTimeout> | undefined;
      const pingTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) { clearInterval(pingTimer); return; }
        alive = false;
        ws.ping();
        pongTimer = setTimeout(() => {
          if (!alive) ws.close();
        }, this.pingTimeout);
      }, this.pingInterval);
      ws.on('pong', () => { alive = true; if (pongTimer) { clearTimeout(pongTimer); pongTimer = undefined; } });
      ws.on('close', () => { clearInterval(pingTimer); if (pongTimer) clearTimeout(pongTimer); });

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
    // System prompts live in session messages (role:'system'), but snapshots are UI data — sending them would
    // cause the browser to render model instructions as chat bubbles. Filter them out here at the source.
    // Filter first, then deep-clone only the messages that will actually be sent.
    const state = this.engine.getSessionState();
    const messages = state.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: m.content.map((b) => structuredClone(b)),
        ...(m._id !== undefined ? { _id: m._id } : {}),
      }));
    return {
      messages,
      subagents: this.hub.list(),
      running,
      log: this.log.filter((ev) => ev.type !== 'turn_done'),
      pendingPermission: this.permission.pending(),
      error: this.lastError,
      cwd: this.engine.getCwd(),
    };
  }

  private sendEvent(ws: import('ws').WebSocket, raw: string): void {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }

  /** Broadcast any message to all clients (permission requests and other non-CoreEvent messages). */
  broadcast(msg: unknown): void {
    const raw = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(raw);
  }

  broadcastEvent(ev: CoreEvent): void {
    this.hub.handle(ev);
    // Subagent events don't enter the main session log or affect running state.
    // Only broadcast to clients — the EventHub tracks subagent state separately.
    if (ev.agent !== undefined) {
      const raw = JSON.stringify({ type: 'event', ev });
      for (const c of this.clients) this.sendEvent(c, raw);
      return;
    }
    if (TERMINALS.has(ev.type)) {
      this.log = [];
      this.permission.clearAll();
      // Track error state for snapshots of reconnecting clients
      if (ev.type === 'error') {
        this.lastError = ev.error.message;
      } else {
        this.lastError = null; // 'done' clears previous error
      }
    } else if (ev.type === 'session_start') {
      // New session clears previous error
      this.lastError = null;
      this.log.push(ev);
    } else {
      // turn_done is a non-terminal event: message lands in UI, but engine keeps running
      this.log.push(ev);
    }
    const raw = JSON.stringify({ type: 'event', ev });
    for (const c of this.clients) this.sendEvent(c, raw);
  }

  /**
   * 向所有已连接客户端推送最新 snapshot。
   * 用于服务端状态变更后（resume / clearConversation / closeSubagent）主动同步 UI。
   */
  broadcastSnapshot(): void {
    const raw = JSON.stringify({ type: 'snapshot', ...this.snapshot() });
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(raw);
  }

  /** 重置 EventHub（会话切换时清除残留的子代理条目）。 */
  resetHub(): void {
    this.hub.reset();
  }
}
