import type { DaedalusEngine } from '../core/engine.ts';

export interface PendingPermission { id: string; action: string; target: string }

/** Web 权限审批：auto 短路；普通模式挂起等待 ws 响应。 */
export class WebPermissionManager {
  private pendingMap = new Map<string, PendingPermission & { resolve: (allow: boolean) => void }>();
  private seq = 0;
  private broadcast: (msg: unknown) => void = () => {};
  private engine: Pick<DaedalusEngine, 'getAutoApprove' | 'setAutoApprove'>;

  constructor(engine: Pick<DaedalusEngine, 'getAutoApprove' | 'setAutoApprove'> = { getAutoApprove: () => false, setAutoApprove: () => {} }) {
    this.engine = engine;
  }

  /** ws 层设置广播：把新挂起权限推给前端。 */
  setBroadcast(fn: (msg: unknown) => void): void { this.broadcast = fn; }

  /** 作为 engine.setAskPermission 的处理器安装。 */
  ask = (action: string, target: string): Promise<boolean> => {
    if (this.engine.getAutoApprove()) return Promise.resolve(true); // auto 模式全自动
    const id = `p${++this.seq}`;
    return new Promise<boolean>((resolve) => {
      this.pendingMap.set(id, { id, action, target, resolve });
      this.broadcast({ type: 'permission', id, action, target });
    });
  };

  /** ws 收到前端审批结果：always → 本轮始终允许；随后 resolve。 */
  settle(id: string, allow: boolean, always: boolean): void {
    if (always) this.engine.setAutoApprove(true);
    const entry = this.pendingMap.get(id);
    if (entry) { this.pendingMap.delete(id); entry.resolve(allow); }
  }

  /** 当前挂起权限（快照用；首项即可，工具调用串行审批）。 */
  pending(): PendingPermission | null {
    const first = this.pendingMap.values().next().value as (PendingPermission & { resolve: (allow: boolean) => void }) | undefined;
    return first ? { id: first.id, action: first.action, target: first.target } : null;
  }

  /** 本轮结束/错误时撤下全部挂起权限（拒绝），防止幽灵卡片。 */
  clearAll(): void {
    for (const entry of this.pendingMap.values()) entry.resolve(false);
    this.pendingMap.clear();
  }
}
