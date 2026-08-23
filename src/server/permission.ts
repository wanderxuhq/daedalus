import type { DaedalusEngine } from '../core/engine.ts';

export interface PendingPermission { id: string; action: string; target: string }

/** Web permission approval: auto short-circuits; normal mode suspends and waits for ws response. */
export class WebPermissionManager {
  private pendingMap = new Map<string, PendingPermission & { resolve: (allow: boolean) => void }>();
  private seq = 0;
  private broadcast: (msg: unknown) => void = () => {};
  private engine: Pick<DaedalusEngine, 'getAutoApprove' | 'setAutoApprove'>;

  constructor(engine: Pick<DaedalusEngine, 'getAutoApprove' | 'setAutoApprove'> = { getAutoApprove: () => false, setAutoApprove: () => {} }) {
    this.engine = engine;
  }

  /** Set broadcast function from ws layer: push new pending permissions to the frontend. */
  setBroadcast(fn: (msg: unknown) => void): void { this.broadcast = fn; }

  /** Installed as the handler for engine.setAskPermission. */
  ask = (action: string, target: string): Promise<boolean> => {
    if (this.engine.getAutoApprove()) return Promise.resolve(true); // auto mode: fully automatic
    const id = `p${++this.seq}`;
    return new Promise<boolean>((resolve) => {
      this.pendingMap.set(id, { id, action, target, resolve });
      this.broadcast({ type: 'permission', id, action, target });
    });
  };

  /** Handle approval result from frontend via ws: always → always allow for this turn; then resolve. */
  settle(id: string, allow: boolean, always: boolean): void {
    if (always) this.engine.setAutoApprove(true);
    const entry = this.pendingMap.get(id);
    if (entry) { this.pendingMap.delete(id); entry.resolve(allow); }
  }

  /** Current pending permission (for snapshots; only the first is needed since tool calls are approved serially). */
  pending(): PendingPermission | null {
    const first = this.pendingMap.values().next().value as (PendingPermission & { resolve: (allow: boolean) => void }) | undefined;
    return first ? { id: first.id, action: first.action, target: first.target } : null;
  }

  /** Dismiss all pending permissions (reject) at turn end/error to prevent ghost cards. */
  clearAll(): void {
    for (const entry of this.pendingMap.values()) entry.resolve(false);
    this.pendingMap.clear();
  }
}
