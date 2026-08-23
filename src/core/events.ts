import type { Message } from '../ai/types.ts';
import type { AiError } from '../ai/errors.ts';

export type CoreEvent =
  | { type: 'session_start'; agent?: string }
  | { type: 'session_end'; agent?: string }
  | { type: 'text_delta'; text: string; agent?: string }
  | { type: 'thinking_delta'; thinking: string; agent?: string }
  | { type: 'tool_call_start'; id: string; name: string; agent?: string }
  | { type: 'tool_call_delta'; id: string; inputDelta: string; agent?: string }
  | { type: 'tool_result'; id: string; name: string; input: unknown; content: string; isError?: boolean; diff?: string; agent?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; agent?: string }
  | { type: 'skill_load'; name: string; agent?: string }
  | { type: 'delegate_start'; agent?: string; task: string }
  | { type: 'context_trim'; dropped: number; kept: number; agent?: string }
  | { type: 'context_compact'; dropped: number; kept: number; agent?: string }
  | { type: 'turn_done'; message: Message; agent?: string }
  | { type: 'done'; message: Message; agent?: string }
  | { type: 'error'; error: AiError; agent?: string };

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
