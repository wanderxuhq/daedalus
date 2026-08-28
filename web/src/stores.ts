import { createSignal } from 'solid-js';
import { initialUiState, applyEnvelope, mergeSnapshot, submitPrompt as submitPromptModel, submitSubagentPrompt as submitSubagentPromptModel, type UiState } from './state-model.ts';
import type { EventEnvelope } from './types.ts';
import type { Message } from './types/messages.ts';
import type { CoreEvent } from '../../src/core/events.ts';

export const [state, setState] = createSignal<UiState>(initialUiState());

/** ── rAF 批量合并：一个帧窗口内的多个事件合并成一次 setState ── */
let pendingEnvelopes: EventEnvelope[] = [];
let rafId: number | undefined;

function flushBatch(): void {
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId);
    rafId = undefined;
  }
  const batch = pendingEnvelopes;
  pendingEnvelopes = [];
  if (batch.length === 0) return;
  setState((s) => {
    let next = s;
    for (const env of batch) next = applyEnvelope(next, env);
    return next;
  });
}

function scheduleBatch(env: EventEnvelope): void {
  pendingEnvelopes.push(env);
  if (rafId !== undefined) return;
  rafId = requestAnimationFrame(() => {
    rafId = undefined;
    const batch = pendingEnvelopes;
    pendingEnvelopes = [];
    setState((s) => {
      let next = s;
      for (const env of batch) next = applyEnvelope(next, env);
      return next;
    });
  });
}

/** ws 事件进 store：snapshot 立即处理，其余事件 rAF 批量合并。 */
export function handleEnvelope(env: EventEnvelope): void {
  if (env.type === 'snapshot') {
    flushBatch();
    setState((s) => mergeSnapshot(s, env));
    return;
  }
  scheduleBatch(env);
}

/** 本地乐观更新 autoApprove（config 不经 ws 回传）。 */
export function setAutoApproveLocal(v: boolean): void {
  setState((s) => ({ ...s, autoApprove: v }));
}

/** 用户点发送：本地立即回显 user 消息（转发 state-model）。 */
export function submitPrompt(prompt: string): void {
  flushBatch();
  setState((s) => submitPromptModel(s, prompt));
}

/** 清除 UI 错误横幅（点击横幅时）。 */
export function clearError(): void {
  setState((s) => (s.error === null ? s : { ...s, error: null }));
}

/** 切换到子代理视图。 */
export function setViewingSubagent(name: string | null): void {
  setState((s) => ({ ...s, viewingSubagent: name, subagentMessages: name === null ? [] : s.subagentMessages }));
}

/** 设置子代理历史消息（从 API 加载后）。 */
export function setSubagentMessages(msgs: (Message | CoreEvent)[]): void {
  setState((s) => ({ ...s, subagentMessages: msgs }));
}

/** 给子代理发消息：本地回显 + API 注入。 */
export function submitSubagentPrompt(prompt: string): void {
  flushBatch();
  setState((s) => submitSubagentPromptModel(s, prompt));
}

/** 移除最后一个用户消息（POST 失败时回滚）。 */
export function removeLastUserMessage(): void {
  setState((s) => {
    const messages = [...s.messages];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        messages.splice(i, 1);
        return { ...s, messages };
      }
    }
    return s;
  });
}
