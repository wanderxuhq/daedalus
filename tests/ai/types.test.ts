import { test } from 'node:test';
import assert from 'node:assert/strict';
// Value import (with inline `type` specifiers) so the IR types module actually
// resolves at runtime under Node's type-stripping — `import type` is erased
// before module resolution and would never load the real types.
import {
  type Message,
  type StreamEvent,
  type ContentBlock,
  type ToolDefinition,
  type ChatParams,
  type AiClient,
} from '../../src/ai/types.ts';

test('IR types are structurally sound', () => {
  const msg: Message = {
    role: 'assistant',
    content: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }],
  };
  assert.equal(msg.content[0].type, 'tool_call');
  const ev: StreamEvent = { type: 'text_delta', text: 'hi' };
  assert.equal(ev.type, 'text_delta');
  const params: ChatParams = { model: 'm', messages: [msg], cache: { enabled: true } };
  assert.equal(params.cache?.enabled, true);
  const td: ToolDefinition = { name: 'bash', description: 'run', inputSchema: { type: 'object' } };
  const schema = td.inputSchema as { type: string };
  assert.equal(schema.type, 'object');
  const client: AiClient = { streamChat: async function* () {} };
  assert.equal(typeof client.streamChat, 'function');

  // Exercise the remaining IR type surface.
  const text: ContentBlock = { type: 'text', text: 'hi' };
  const thinking: ContentBlock = { type: 'thinking', thinking: 'hmm' };
  const result: ContentBlock = { type: 'tool_result', toolCallId: 't1', content: 'out', isError: false };
  assert.equal(text.type, 'text');
  assert.equal(thinking.type, 'thinking');
  assert.equal(result.type, 'tool_result');
});
