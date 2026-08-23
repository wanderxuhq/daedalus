export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ThinkingParams {
  enabled: boolean;
  /** Thinking budget in tokens; also drives OpenAI-compatible reasoning effort. */
  budgetTokens?: number;
}

export interface ChatParams {
  model?: string;           // optional: client-level default is applied when omitted
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  cache?: { enabled: boolean };
  /** Extended thinking request. Absent → the provider's default (no thinking). */
  thinking?: ThinkingParams;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; inputDelta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: AiError };

import type { AiError } from './errors.ts';

export interface AiClient {
  streamChat(params: ChatParams): AsyncIterable<StreamEvent>;
}
