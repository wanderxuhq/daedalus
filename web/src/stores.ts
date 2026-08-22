import { createSignal } from 'solid-js';
import { initialUiState, applyEnvelope, mergeSnapshot, type UiState } from './state-model.ts';
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
