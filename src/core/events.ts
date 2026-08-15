import type { Message } from '../ai/types.ts';
import type { AiError } from '../ai/errors.ts';

export type CoreEvent =
  | { type: 'session_start' }
  | { type: 'session_end' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; inputDelta: string }
  | { type: 'skill_load'; name: string }
  | { type: 'context_trim'; dropped: number; kept: number }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: AiError };

type Handler = (ev: CoreEvent) => void;

export class EventBus {
  private handlers = new Set<Handler>();
  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  emit(ev: CoreEvent): void {
    for (const h of this.handlers) h(ev);
  }
  emitAll(events: Iterable<CoreEvent>): void {
    for (const ev of events) this.emit(ev);
  }
}
