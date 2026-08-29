import { createSignal } from 'solid-js';
import { initialUiState, applyEnvelope, mergeSnapshot, submitPrompt as submitPromptModel, submitSubagentPrompt as submitSubagentPromptModel, type UiState } from './state-model.ts';
import type { EventEnvelope } from './types.ts';

export const [state, setState] = createSignal<UiState>(initialUiState());

// ── 混合调度：高频流式事件立即处理，低频事件 rAF 批量合并 ──
// text_delta / thinking_delta / tool_call_delta 每秒 50-100 个，立即处理保证流式体验。
// tool_call_start / tool_result / turn_done / done 等每轮只出现几次，批量合并减少 DOM 更新。

/** 高频流式事件：直接 setState，不经过 rAF 队列。 */
const STREAMING_TYPES = new Set(['text_delta', 'thinking_delta', 'tool_call_delta']);

let pendingLowFreq: EventEnvelope[] = [];
let rafId: number | undefined;

function flushLowFreq(): void {
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId);
    rafId = undefined;
  }
  const batch = pendingLowFreq;
  pendingLowFreq = [];
  if (batch.length === 0) return;
  setState((s) => {
    let next = s;
    for (const env of batch) next = applyEnvelope(next, env);
    return next;
  });
}

function scheduleLowFreq(env: EventEnvelope): void {
  pendingLowFreq.push(env);
  if (rafId !== undefined) return;
  rafId = requestAnimationFrame(() => {
    rafId = undefined;
    const batch = pendingLowFreq;
    pendingLowFreq = [];
    setState((s) => {
      let next = s;
      for (const env of batch) next = applyEnvelope(next, env);
      return next;
    });
  });
}

/** ws 事件进 store：snapshot / 高频流式事件立即处理，低频事件 rAF 批量合并。 */
export function handleEnvelope(env: EventEnvelope): void {
  if (env.type === 'snapshot') {
    flushLowFreq();
    setState((s) => mergeSnapshot(s, env));
    return;
  }
  if (env.type === 'event' && STREAMING_TYPES.has(env.ev.type)) {
    setState((s) => applyEnvelope(s, env));
    return;
  }
  scheduleLowFreq(env);
}

/** 本地乐观更新 autoApprove（config 不经 ws 回传）。 */
export function setAutoApproveLocal(v: boolean): void {
  setState((s) => ({ ...s, autoApprove: v }));
}

/** 用户点发送：先 flush 排队中的低频事件再写本地回显，保证事件顺序正确。 */
export function submitPrompt(prompt: string): void {
  flushLowFreq();
  setState((s) => submitPromptModel(s, prompt));
}

/** 清除 UI 错误横幅（点击横幅时）。 */
export function clearError(): void {
  setState((s) => (s.error === null ? s : { ...s, error: null }));
}

/** 给子代理发消息：先 flush 排队中的低频事件再本地回显。 */
export function submitSubagentPrompt(name: string, prompt: string): void {
  flushLowFreq();
  setState((s) => submitSubagentPromptModel(s, name, prompt));
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
