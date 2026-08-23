import { createSignal } from 'solid-js';
import { initialUiState, applyEnvelope, mergeSnapshot, submitPrompt as submitPromptModel, submitSubagentPrompt as submitSubagentPromptModel, type UiState } from './state-model.ts';
import type { EventEnvelope } from './types.ts';

export const [state, setState] = createSignal<UiState>(initialUiState());

/** ws 事件进 store：纯归并后写信号。 */
export function handleEnvelope(env: EventEnvelope): void {
  if (env.type === 'snapshot') {
    setState((s) => mergeSnapshot(s, env));
    return;
  }
  setState((s) => applyEnvelope(s, env));
}

/** 本地乐观更新 autoApprove（config 不经 ws 回传）。 */
export function setAutoApproveLocal(v: boolean): void {
  setState((s) => ({ ...s, autoApprove: v }));
}

/** 用户点发送：本地立即回显 user 消息（转发 state-model）。 */
export function submitPrompt(prompt: string): void {
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
export function setSubagentMessages(msgs: unknown[]): void {
  setState((s) => ({ ...s, subagentMessages: msgs }));
}

/** 给子代理发消息：本地回显 + API 注入。 */
export function submitSubagentPrompt(prompt: string): void {
  setState((s) => submitSubagentPromptModel(s, prompt));
}

/** 移除最后一个用户消息（POST 失败时回滚）。 */
export function removeLastUserMessage(): void {
  setState((s) => {
    const messages = [...s.messages];
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as any).role === 'user') {
        messages.splice(i, 1);
        return { ...s, messages };
      }
    }
    return s;
  });
}
