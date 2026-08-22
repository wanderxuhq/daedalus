import type { CoreEvent } from '../../src/core/events.ts';
import type { EventEnvelope, SnapshotPayload } from './types.ts';

export interface SubagentInfo {
  name: string;
  task: string;
  status: 'running' | 'done' | 'error' | 'queued';
  messageCount: number;
  loadedSkills: string[];
  /** 该 agent 的实时 CoreEvent 累积（detail 页 live 渲染用；snapshot 重置）。 */
  events: CoreEvent[];
}

export interface UiState {
  messages: unknown[];
  subagents: SubagentInfo[];
  running: boolean;
  log: CoreEvent[];
  pendingPermission: { id: string; action: string; target: string } | null;
  autoApprove: boolean;
}

const TERMINALS: ReadonlySet<CoreEvent['type']> = new Set(['done', 'error']);

export function initialUiState(): UiState {
  return { messages: [], subagents: [], running: false, log: [], pendingPermission: null, autoApprove: false };
}

export function applyEnvelope(state: UiState, env: EventEnvelope): UiState {
  if (env.type === 'snapshot') return mergeSnapshot(state, env);
  if (env.type === 'permission') return { ...state, pendingPermission: { id: env.id, action: env.action, target: env.target } };
  if (env.type === 'permission_cancel') return { ...state, pendingPermission: null };
  const ev = env.ev;
  if (ev.agent === undefined) {
    // main-session events: accumulate into the in-flight log
    const log = TERMINALS.has(ev.type) ? [] : [...state.log, ev];
    // 偏差（constraint > snippet）：plan 片段用 `log.length > 0`，但其测试要求
    // tool_result 落地后 running 为 false —— 故最新事件为已结算的 tool_result 时视为空闲。
    const running = log.length > 0 && ev.type !== 'tool_result';
    return { ...state, log, running };
  }
  // subagent events: update the subagent entry + accumulate its live events
  const idx = state.subagents.findIndex((a) => a.name === ev.agent);
  if (idx < 0 && ev.type !== 'delegate_start') return state;
  let subagents: SubagentInfo[];
  if (idx < 0) {
    subagents = [...state.subagents, { name: ev.agent!, task: (ev as { task?: string }).task ?? '', status: 'running', messageCount: 0, loadedSkills: [], events: [ev] }];
  } else {
    subagents = state.subagents.map((a) => {
      if (a.name !== ev.agent) return a;
      const events = [...a.events, ev];
      switch (ev.type) {
        case 'delegate_start': return { ...a, task: (ev as { task?: string }).task ?? a.task, status: 'running', events };
        case 'done': return { ...a, status: 'done', events };
        case 'error': return { ...a, status: 'error', events };
        default: return { ...a, events };
      }
    });
  }
  return { ...state, subagents };
}

export function mergeSnapshot(state: UiState, snap: SnapshotPayload): UiState {
  return {
    ...state,
    messages: snap.messages,
    subagents: snap.subagents.map((a) => ({
      name: a.name, task: a.task,
      status: (a.status === 'done' || a.status === 'error' ? a.status : 'running') as SubagentInfo['status'],
      messageCount: a.messageCount, loadedSkills: a.loadedSkills,
      events: [],
    })),
    running: snap.running,
    log: [...snap.log],
    pendingPermission: snap.pendingPermission,
  };
}
