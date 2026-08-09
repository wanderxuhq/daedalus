import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, StreamEvent, AiClient, ChatParams, ToolDefinition } from '../../src/ai/types.ts';

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
  assert.equal(td.inputSchema.type, 'object');
  const client: AiClient = { streamChat: async function* () {} };
  assert.equal(typeof client.streamChat, 'function');
});
