/**
 * Type definitions for web frontend message handling.
 * Mirrors the server-side Message/ContentBlock types for type safety.
 */

/** Content block types that can appear in a message */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

/** Message with role and content blocks */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: ContentBlock[];
  _id?: number;
}

/** Tool information for rendering */
export interface ToolInfo {
  id: string;
  name: string;
  input: unknown;
  content?: string;
  isError?: boolean;
  diff?: string;
  status: 'running' | 'done' | 'error';
}

/** Message with tools attached */
export interface MessageWithTools extends Message {
  tools?: ToolInfo[];
}

/** Content block with type guard */
export function isTextBlock(block: ContentBlock): block is { type: 'text'; text: string } {
  return block.type === 'text';
}

export function isThinkingBlock(block: ContentBlock): block is { type: 'thinking'; thinking: string; signature?: string } {
  return block.type === 'thinking';
}

export function isToolCallBlock(block: ContentBlock): block is { type: 'tool_call'; id: string; name: string; input: unknown } {
  return block.type === 'tool_call';
}

export function isToolResultBlock(block: ContentBlock): block is { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean } {
  return block.type === 'tool_result';
}

/** Streaming message type for real-time updates */
export interface StreamingMessage {
  role: 'assistant';
  content: StreamingContentBlock[];
}

/** Content blocks that can appear in a streaming message */
export type StreamingContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call'; id: string; name: string; input: string; status: 'pending' | 'done' | 'error'; resultContent?: string; diff?: string };