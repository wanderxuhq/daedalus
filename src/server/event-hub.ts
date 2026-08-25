import type { CoreEvent, SubagentInfo } from '../core/events.ts';

/** Tracks subagent activity (name / current task / run status) for ws snapshots and /api/agents. */
export class EventHub {
  private byName = new Map<string, SubagentInfo>();
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
      case 'tool_result':
        t.messageCount++;
        break;
      case 'skill_load':
        if (!t.loadedSkills.includes(ev.name)) t.loadedSkills.push(ev.name);
        break;
    }
  }

  /** Return all agents in first-seen order (including running/done/error status). */
  list(): SubagentInfo[] {
    return this.order.map((name) => this.byName.get(name)!);
  }

  reset(): void {
    this.byName.clear();
    this.order = [];
  }
}
