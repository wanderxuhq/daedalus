import type { CoreEvent } from '../core/events.ts';

export interface SubagentTracked {
  name: string;
  task: string;
  status: 'running' | 'done' | 'error';
  messageCount: number;
  loadedSkills: string[];
}

/** 跟踪 subagent 活动（名字/当前任务/运行状态），供 ws 快照与 /api/agents 消费。 */
export class EventHub {
  private byName = new Map<string, SubagentTracked>();
  private order: string[] = [];

  handle(ev: CoreEvent): void {
    if (ev.agent === undefined) return;
    let t = this.byName.get(ev.agent);
    if (!t) {
      t = { name: ev.agent, task: '', status: 'running', messageCount: 0, loadedSkills: [] };
      this.byName.set(ev.agent, t);
      this.order.push(ev.agent);
    }
    switch (ev.type) {
      case 'delegate_start':
        t.task = ev.task ?? '';
        t.status = 'running';
        break;
      case 'done':
        t.status = 'done';
        break;
      case 'error':
        t.status = 'error';
        break;
    }
  }

  /** 按首次出现顺序返回当前全部 agent（含 running/done/error 状态）。 */
  list(): SubagentTracked[] {
    return this.order.map((name) => this.byName.get(name)!);
  }

  reset(): void {
    this.byName.clear();
    this.order = [];
  }
}
