import type { DaedalusEngine } from '../core/engine.ts';

export interface PendingPermission { id: string; action: string; target: string }

/** Web permission approval: auto short-circuits; normal mode suspends and waits for ws response. */
export class WebPermissionManager {
  private pendingMap = new Map<string, PendingPermission & { resolve: (allow: boolean) => void; timer?: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private broadcast: (msg: unknown) => void = () => {};
  private engine: Pick<DaedalusEngine, 'getAutoApprove' | 'setAutoApprove'>;
  /** Time in ms to wait for a permission response before auto-rejecting. Default: 5 minutes. */
  private timeoutMs: number;

  constructor(opts?: { engine?: Pick<DaedalusEngine, 'getAutoApprove' | 'setAutoApprove'>; timeoutMs?: number }) {
    this.engine = opts?.engine ?? { getAutoApprove: () => false, setAutoApprove: () => {} };
    this.timeoutMs = opts?.timeoutMs ?? 300_000; // 5 minutes
  }

  /** Set broadcast function from ws layer: push new pending permissions to the frontend. */
  setBroadcast(fn: (msg: unknown) => void): void { this.broadcast = fn; }

  /** Installed as the handler for engine.setAskPermission. */
  ask = (action: string, target: string): Promise<boolean> => {
    if (this.engine.getAutoApprove()) return Promise.resolve(true); // auto mode: fully automatic
    const id = `p${++this.seq}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Auto-reject after timeout to prevent indefinite engine hang
        this.pendingMap.delete(id);
        resolve(false);
      }, this.timeoutMs);
      this.pendingMap.set(id, { id, action, target, resolve, timer });
      this.broadcast({ type: 'permission', id, action, target });
    });
  };

  /** Handle approval result from frontend via ws: always → always allow for this turn; then resolve. */
  settle(id: string, allow: boolean, always: boolean): void {
    if (always) {
      this.engine.setAutoApprove(true);
      // Drain all other pending permissions: "always allow" means
      // they should all be resolved immediately, not wait for timeout.
      for (const [otherId, other] of this.pendingMap) {
        if (otherId !== id) {
          if (other.timer) clearTimeout(other.timer);
          other.resolve(true);
        }
      }
      this.pendingMap.clear();
    }
    const entry = this.pendingMap.get(id);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      this.pendingMap.delete(id);
      entry.resolve(allow);
    }
  }

  /** Current pending permission (for snapshots; only the first is needed since tool calls are approved serially). */
  pending(): PendingPermission | null {
    const first = this.pendingMap.values().next().value as (PendingPermission & { resolve: (allow: boolean) => void }) | undefined;
    return first ? { id: first.id, action: first.action, target: first.target } : null;
  }

  /** Dismiss all pending permissions (reject) at turn end/error to prevent ghost cards. */
  clearAll(): void {
    for (const entry of this.pendingMap.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pendingMap.clear();
  }
}
